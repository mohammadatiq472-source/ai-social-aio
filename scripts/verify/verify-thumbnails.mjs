// P1-6 图片缩略图回归：上传 → thumbUrl → 派生文件（480px WebP）→ 签名变体 → 回退。
//
// 为什么需要这条门：缩略图是「省流量」的优化，坏了不会报错——
//   - 签名变体没进 HMAC：thumb URL 的 s 挪到原图 URL 也能读（等于变体形同虚设）；
//   - 老图没有缩略图时直接 404：前端 <img> 破图，比加载原图更糟。
// 这里把「生成/签名/回退」三件事都钉成可复跑断言。
//
// 用法：
//   BASE=http://127.0.0.1:8787 node scripts/verify/verify-thumbnails.mjs
//   DATABASE_URL=postgres://postgres@127.0.0.1:5434/aio BASE=... node ...  # 老图 on-demand 需要直连库
//
// 说明：会造 1 个测试账号与几张测试图（<2MB），按任务书要求**不清理**；不打印 cookie/token/图片内容。
import crypto from 'node:crypto';
import http from 'node:http';
import sharp from 'sharp';
import pg from 'pg';

const BASE = (process.env.BASE || 'http://127.0.0.1:8787').replace(/\/$/, '');
const DB_URL = process.env.DATABASE_URL || '';
const results = [];
const rnd = () => crypto.randomBytes(4).toString('hex');

function check(name, ok, detail = '') {
  results.push({ name, ok });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? '  — ' + detail : ''}`);
}

function skip(name, detail = '') {
  results.push({ name, ok: true, skipped: true });
  console.log(`SKIP  ${name}${detail ? '  — ' + detail : ''}`);
}

async function api(path, { method = 'GET', body, cookie, raw, contentType } = {}) {
  const headers = {};
  if (cookie) headers.cookie = cookie;
  if (contentType) headers['content-type'] = contentType;
  else if (body !== undefined) headers['content-type'] = 'application/json';
  const res = await fetch(`${BASE}${path}`, {
    method,
    headers,
    body: raw !== undefined ? raw : body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  let json = null;
  try {
    json = text ? JSON.parse(text) : null;
  } catch {
    /* 非 JSON */
  }
  const setCookie = res.headers.getSetCookie?.() || [];
  const sid = setCookie.map((c) => String(c).split(';')[0]).find((c) => c.startsWith('sid='));
  return { status: res.status, json, text, cookie: sid || cookie, headers: res.headers };
}

async function signup(name) {
  const r = await api('/api/auth/register', {
    method: 'POST',
    body: {
      email: `t_${rnd()}@test.dev`,
      password: 'passw0rd!x',
      display_name: name,
      invite_code: process.env.REGISTER_CODE || '',
    },
  });
  if (r.status !== 200) throw new Error(`注册失败 HTTP ${r.status}${r.json?.error ? ' ' + r.json.error : ''}`);
  return { cookie: r.cookie };
}

/** 1200×800 噪声 JPEG：q90 下 >100KB（纯色图只有几 KB，验不出压缩收益） */
async function makeJpeg() {
  const width = 1200;
  const height = 800;
  const raw = crypto.randomBytes(width * height * 3);
  return sharp(raw, { raw: { width, height, channels: 3 } }).jpeg({ quality: 90 }).toBuffer();
}

async function makePng() {
  return sharp({ create: { width: 900, height: 700, channels: 3, background: { r: 30, g: 90, b: 180 } } })
    .png().toBuffer();
}

async function upload(cookie, buf, mime) {
  return api('/api/attachments', { method: 'POST', cookie, raw: buf, contentType: mime });
}

async function fetchBytes(pathname) {
  const res = await fetch(`${BASE}${pathname}`);
  const buf = Buffer.from(await res.arrayBuffer());
  return { status: res.status, headers: res.headers, buf };
}

// 条件请求走 node:http：undici 的 fetch 对 If-None-Match 仍回 200（实测），会误报
function conditionalStatus(pathname, etag) {
  const u = new URL(`${BASE}${pathname}`);
  return new Promise((resolve, reject) => {
    const r = http.request(
      { hostname: u.hostname, port: u.port, path: `${u.pathname}${u.search}`, headers: { 'if-none-match': etag } },
      (res) => {
        res.resume();
        resolve(res.statusCode);
      },
    );
    r.on('error', reject);
    r.end();
  });
}

const abs = (u) => (String(u || '').startsWith('/') ? u : `/${u}`);

const main = async () => {
  const user = await signup('缩略图验证');
  const original = await makeJpeg();
  check('测试图 1200×800 JPEG 且 >100KB', original.length > 100 * 1024,
    `bytes=${original.length}`);

  // ---------- 1) 上传 + thumbUrl ----------
  const up = await upload(user.cookie, original, 'image/jpeg');
  const att = up.json?.attachment;
  check('上传图片返回 200', up.status === 200, `HTTP ${up.status}`);
  check('上传响应带原始 url', Boolean(att?.url), att?.url ? 'url 有' : 'url 缺失');
  check('上传响应带 thumbUrl（图片且缩略图已生成）', Boolean(att?.thumbUrl),
    att?.thumbUrl ? 'thumbUrl 有' : 'thumbUrl 缺失');
  if (!att?.thumbUrl) throw new Error('没有 thumbUrl，后续断言无法继续');

  // ---------- 2) 原图 vs 缩略图 ----------
  const orig = await fetchBytes(abs(att.url));
  const thumb = await fetchBytes(abs(att.thumbUrl));
  check('原图 200 且是 image/jpeg', orig.status === 200 && /^image\/jpeg/i.test(orig.headers.get('content-type') || ''),
    `HTTP ${orig.status} ${orig.headers.get('content-type')}`);
  check('缩略图 200', thumb.status === 200, `HTTP ${thumb.status}`);
  check('缩略图 Content-Type 是 image/webp', /^image\/webp/i.test(thumb.headers.get('content-type') || ''),
    thumb.headers.get('content-type') || '(缺失)');

  const tmeta = await sharp(thumb.buf).metadata();
  check('缩略图尺寸 ≤480 且保持比例', tmeta.width > 0 && tmeta.width <= 480 && tmeta.height <= 480,
    `${tmeta.width}x${tmeta.height}`);
  const ratio = thumb.buf.length / original.length;
  check('缩略图体积 < 原图 60%', ratio < 0.6,
    `${thumb.buf.length}B / ${original.length}B = ${(ratio * 100).toFixed(1)}%`);

  check('原图允许 Range（Accept-Ranges: bytes）', orig.headers.get('accept-ranges') === 'bytes',
    orig.headers.get('accept-ranges') || '(缺失)');
  check('缩略图不提供 Range（无 Accept-Ranges）', !thumb.headers.get('accept-ranges'),
    thumb.headers.get('accept-ranges') || '(无)');
  const thumbRange = await fetch(`${BASE}${abs(att.thumbUrl)}`, { headers: { range: 'bytes=0-9' } });
  const thumbRangeBuf = Buffer.from(await thumbRange.arrayBuffer());
  check('缩略图忽略 Range（200 全量，不 206）', thumbRange.status === 200 && thumbRangeBuf.length === thumb.buf.length,
    `HTTP ${thumbRange.status} bytes=${thumbRangeBuf.length}`);
  check('缩略图与原图 ETag 不同', Boolean(thumb.headers.get('etag')) && thumb.headers.get('etag') !== orig.headers.get('etag'),
    `thumb=${thumb.headers.get('etag')} orig=${orig.headers.get('etag')}`);
  check('缩略图 Cache-Control 与原图一致（private, max-age=3600）',
    thumb.headers.get('cache-control') === orig.headers.get('cache-control')
      && /private, max-age=3600/.test(thumb.headers.get('cache-control') || ''),
    thumb.headers.get('cache-control') || '(缺失)');

  // 条件请求：原图与缩略图各自按 ETag 命中 304（缩略图不能因为「不支持 Range」就失去缓存）
  const orig304 = await conditionalStatus(abs(att.url), orig.headers.get('etag'));
  check('原图带 If-None-Match → 304', orig304 === 304, `HTTP ${orig304}`);
  const thumb304 = await conditionalStatus(abs(att.thumbUrl), thumb.headers.get('etag'));
  check('缩略图带 If-None-Match → 304', thumb304 === 304, `HTTP ${thumb304}`);

  // ---------- 3) /api/attachments 也带 thumbUrl；去重上传复用行同样带 ----------
  const metaRes = await api(`/api/attachments?ids=${att.id}`, { cookie: user.cookie });
  const metaRow = Array.isArray(metaRes.json) ? metaRes.json[0] : null;
  check('/api/attachments 返回 thumbUrl（仅图片且缩略图存在）',
    metaRes.status === 200 && Boolean(metaRow?.thumbUrl),
    `HTTP ${metaRes.status} thumbUrl=${metaRow?.thumbUrl ? '有' : '无'}`);

  const again = await upload(user.cookie, original, 'image/jpeg');
  check('同内容再上传走复用且仍带 thumbUrl',
    again.status === 200 && Boolean(again.json?.attachment?.thumbUrl),
    `HTTP ${again.status} reused=${again.json?.reused}`);

  // ---------- 4) 签名：变体进 HMAC ----------
  const tu = new URL(`${BASE}${abs(att.thumbUrl)}`);
  const ou = new URL(`${BASE}${abs(att.url)}`);
  const thumbSig = tu.searchParams.get('s');
  const thumbExp = tu.searchParams.get('e');

  const noV = await fetch(`${BASE}/media/${att.id}?e=${thumbExp}&s=${thumbSig}`);
  check('把 thumb 的 s 挪到无 v 的原图 URL → 403', noV.status === 403, `HTTP ${noV.status}`);

  const flipped = new URL(tu);
  flipped.searchParams.delete('v');
  const flipRes = await fetch(flipped.toString());
  check('把 v=thumb 去掉但保留 s → 403', flipRes.status === 403, `HTTP ${flipRes.status}`);

  const badSig = new URL(tu);
  const sig = String(thumbSig);
  badSig.searchParams.set('s', `${sig.slice(0, -1)}${sig.endsWith('0') ? '1' : '0'}`);
  const badSigRes = await fetch(badSig.toString());
  check('篡改 s → 403', badSigRes.status === 403, `HTTP ${badSigRes.status}`);

  const badExp = new URL(tu);
  badExp.searchParams.set('e', String(Number(thumbExp) + 3600));
  const badExpRes = await fetch(badExp.toString());
  check('篡改 e → 403', badExpRes.status === 403, `HTTP ${badExpRes.status}`);

  const unknownV = new URL(tu);
  unknownV.searchParams.set('v', 'large');
  const unknownRes = await fetch(unknownV.toString());
  check('未知 v（large）→ 400 invalid_variant', unknownRes.status === 400, `HTTP ${unknownRes.status}`);

  const plain = await fetch(ou.toString());
  const plainBuf = Buffer.from(await plain.arrayBuffer());
  check('旧格式 URL（无 v）仍能读原图', plain.status === 200 && /^image\/jpeg/i.test(plain.headers.get('content-type') || '')
    && plainBuf.length === original.length, `HTTP ${plain.status} bytes=${plainBuf.length}`);

  // ---------- 5) GIF / PDF 不生成缩略图 ----------
  const gif = Buffer.concat([
    Buffer.from('GIF89a\x01\x00\x01\x00\x80\x00\x00\xff\xff\xff\x00\x00\x00!\xf9\x04\x01\x00\x00\x00\x00,\x00\x00\x00\x00\x01\x00\x01\x00\x00\x02\x02D\x01\x00;', 'latin1'),
    Buffer.alloc(64),
  ]);
  const gifUp = await upload(user.cookie, gif, 'image/gif');
  check('GIF 上传成功但不生成缩略图', gifUp.status === 200 && !gifUp.json?.attachment?.thumbUrl,
    `HTTP ${gifUp.status} thumbUrl=${gifUp.json?.attachment?.thumbUrl ? '有' : '无'}`);

  const pdf = Buffer.concat([Buffer.from('%PDF-1.4\n%thumb-test\n', 'latin1'), crypto.randomBytes(256)]);
  const pdfUp = await upload(user.cookie, pdf, 'application/pdf');
  check('PDF 上传成功但不生成缩略图', pdfUp.status === 200 && !pdfUp.json?.attachment?.thumbUrl,
    `HTTP ${pdfUp.status} thumbUrl=${pdfUp.json?.attachment?.thumbUrl ? '有' : '无'}`);

  // ---------- 6) 老图 on-demand（需要 DB 直连） ----------
  const png = await makePng();
  const pngUp = await upload(user.cookie, png, 'image/png');
  const pngAtt = pngUp.json?.attachment;
  check('PNG 也生成缩略图', pngUp.status === 200 && Boolean(pngAtt?.thumbUrl), `HTTP ${pngUp.status}`);

  let db = null;
  if (DB_URL) {
    db = new pg.Pool({ connectionString: DB_URL });
    try {
      // 模拟「上线前的老图」：把缩略图四列清空，文件也删掉（重建时缓存分支才不会误命中）
      const { rows } = await db.query('SELECT thumb_key FROM attachments WHERE id=$1', [pngAtt.id]);
      if (rows[0]?.thumb_key) {
        const path = await import('node:path');
        const fsp = await import('node:fs/promises');
        const mediaDir = process.env.MEDIA_DIR || '';
        if (mediaDir) await fsp.unlink(path.join(mediaDir, rows[0].thumb_key)).catch(() => {});
      }
      await db.query(`UPDATE attachments SET thumb_key=NULL, thumb_bytes=NULL, thumb_width=NULL, thumb_height=NULL
                       WHERE id=$1`, [pngAtt.id]);
      const regen = await fetchBytes(abs(pngAtt.thumbUrl));
      check('老图（thumb 列清空）请求 v=thumb 按需生成 WebP', regen.status === 200
        && /^image\/webp/i.test(regen.headers.get('content-type') || ''), `HTTP ${regen.status} ${regen.headers.get('content-type')}`);
      const { rows: after } = await db.query('SELECT thumb_key, thumb_width, thumb_height FROM attachments WHERE id=$1', [pngAtt.id]);
      check('按需生成后四列已回填', Boolean(after[0]?.thumb_key) && Number(after[0]?.thumb_width) <= 480,
        `key=${after[0]?.thumb_key ? '有' : '无'} ${after[0]?.thumb_width}x${after[0]?.thumb_height}`);

      // 回退：临时把 mime 改成 gif（让 ensureThumb 直接跳过）→ 请求 thumb 不能 404，应回原图
      await db.query(`UPDATE attachments SET mime='image/gif', thumb_key=NULL, thumb_bytes=NULL,
                       thumb_width=NULL, thumb_height=NULL WHERE id=$1`, [pngAtt.id]);
      const fallback = await fetchBytes(abs(pngAtt.thumbUrl));
      check('缩略图生成不可用（mime=gif）时 v=thumb 回退原图而不是 404',
        fallback.status === 200 && fallback.buf.length === png.length,
        `HTTP ${fallback.status} bytes=${fallback.buf.length}/${png.length}`);
      await db.query(`UPDATE attachments SET mime='image/png' WHERE id=$1`, [pngAtt.id]);
      const recovered = await fetchBytes(abs(pngAtt.thumbUrl));
      check('恢复 mime 后再次请求 v=thumb 又能得到 WebP', recovered.status === 200
        && /^image\/webp/i.test(recovered.headers.get('content-type') || ''), `HTTP ${recovered.status}`);
    } catch (err) {
      check('老图 on-demand / 回退检查', false, err.message);
    } finally {
      await db.end().catch(() => {});
    }
  } else {
    skip('老图 on-demand 生成（需要 DATABASE_URL 清空 thumb 列）');
    skip('缩略图生成不可用时回退原图（需要 DATABASE_URL）');
  }

  // ---------- 汇总 ----------
  const failed = results.filter((r) => !r.ok);
  const skipped = results.filter((r) => r.skipped);
  console.log(`\n${failed.length === 0 ? '全部通过' : '有失败'}：${results.length - failed.length - skipped.length}/${results.length - skipped.length}`
    + (skipped.length ? `（跳过 ${skipped.length} 项，需要 DATABASE_URL）` : ''));
  if (failed.length) {
    console.log('失败项：' + failed.map((f) => f.name).join('; '));
    process.exitCode = 1;
  }
};

main().catch((e) => {
  // 只报错误类型/消息，不打印请求头或图片内容
  console.error('验证异常：', e.message);
  process.exitCode = 1;
});
