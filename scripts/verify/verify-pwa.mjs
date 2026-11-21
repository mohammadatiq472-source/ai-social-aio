// PWA 资源回归：manifest 里的图标真的存在、尺寸对、线上也拿得到。
//
// 为什么需要这条：manifest 的 icons 曾经是空数组 —— 装到桌面/主屏是浏览器默认图标，
// iOS 首屏直接是网页截图，而且**不会报错**，只能人工发现。图标是位图，verify:tokens
// 管不到；所以这里补一条能被下一个 agent 直接跑的门。
//
// 两层：
//   1) 静态（无需构建/服务）：解析 web/public/manifest.webmanifest，逐个读 PNG 头验尺寸，
//      再断言 index.html 的 color-scheme 含 dark、apple-touch-icon 链接在。
//   2) 在线（可选）：BASE 可达时校验 8787 真能取到 manifest / icon-192 / apple-touch-icon，
//      且 content-type 正确。注意本仓库的服务端对「不存在的静态文件」会返回 SPA 兜底
//      （200 + text/html），所以 200 不算过，必须同时验 content-type 与 PNG 魔数。
//
// 用法：
//   node scripts/verify/verify-pwa.mjs                    # 静态 + 在线（8787 不在则跳过在线）
//   BASE=http://127.0.0.1:8787 node scripts/verify/verify-pwa.mjs
import fs from 'node:fs';
import path from 'node:path';

const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1')), '..', '..');
// 生产机只部署 web/dist（不带 web/public 与 web/index.html 源码），
// 所以静态检查要优先用仓库源码，源码不存在时退回构建产物，别在服务器上直接 ENOENT。
const pickExisting = (...cands) => cands.find((p) => fs.existsSync(p)) || cands[0];
const PUBLIC = pickExisting(path.join(ROOT, 'web', 'public'), path.join(ROOT, 'web', 'dist'));
const MANIFEST_PATH = path.join(PUBLIC, 'manifest.webmanifest');
const INDEX_PATH = pickExisting(path.join(ROOT, 'web', 'index.html'), path.join(ROOT, 'web', 'dist', 'index.html'));
const BASE = (process.env.BASE || 'http://127.0.0.1:8787').replace(/\/$/, '');

const results = [];

function check(name, ok, detail = '') {
  results.push({ name, ok });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? '  — ' + detail : ''}`);
}

function skip(name, detail = '') {
  results.push({ name, ok: true, skipped: true });
  console.log(`SKIP  ${name}${detail ? '  — ' + detail : ''}`);
}

/** 读 PNG 头（IHDR）算宽高：8 字节魔数 + 长度/类型 + 13 字节 IHDR，不引依赖。 */
function pngSize(file) {
  const buf = fs.readFileSync(file);
  const magic = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  if (buf.length < 24 || !buf.subarray(0, 8).equals(magic)) return null;
  if (buf.subarray(12, 16).toString('latin1') !== 'IHDR') return null;
  return { width: buf.readUInt32BE(16), height: buf.readUInt32BE(20), bytes: buf.length };
}

const isPng = (buf) => buf.length > 8 && buf.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]));

async function fetchWithTimeout(url, ms = 4000) {
  return fetch(url, { signal: AbortSignal.timeout(ms), redirect: 'manual' });
}

const main = async () => {
  // ---------- 1) manifest 本身 ----------
  let manifest = null;
  try {
    manifest = JSON.parse(fs.readFileSync(MANIFEST_PATH, 'utf8'));
  } catch (e) {
    check('manifest.webmanifest 可解析（JSON）', false, e.message);
  }
  if (manifest) {
    check('manifest.webmanifest 可解析（JSON）', true, path.relative(ROOT, MANIFEST_PATH));
    check('name / short_name / start_url / display 齐全（装了能不能独立开）',
      Boolean(manifest.name) && Boolean(manifest.short_name) && manifest.start_url === '/'
        && manifest.display === 'standalone',
      `${manifest.short_name} ${manifest.start_url} ${manifest.display}`);
    check('theme_color / background_color 是合法 #rrggbb',
      /^#[0-9a-fA-F]{6}$/.test(manifest.theme_color || '') && /^#[0-9a-fA-F]{6}$/.test(manifest.background_color || ''),
      `${manifest.theme_color} / ${manifest.background_color}`);
  }

  // ---------- 2) icons：数量、文件、PNG 尺寸、purpose ----------
  const icons = Array.isArray(manifest?.icons) ? manifest.icons : [];
  check('icons 数组 ≥ 3 项（192 / 512 / maskable）', icons.length >= 3, `${icons.length} 项`);

  let anySizes = new Set();
  let maskableCount = 0;
  for (const icon of icons) {
    const src = String(icon.src || '');
    check(`icon 有 src / sizes / type：${src || '(空)'}`,
      Boolean(src) && /^\d+x\d+$/.test(icon.sizes || '') && icon.type === 'image/png',
      `${icon.sizes} ${icon.type} purpose=${icon.purpose || '(缺省=any)'}`);
    check(`icon 用根路径绝对 URL：${src}`, src.startsWith('/'));

    const size = (icon.sizes || '').split('x').map(Number);
    const file = path.join(PUBLIC, src.replace(/^\//, ''));
    const exists = fs.existsSync(file);
    const info = exists ? pngSize(file) : null;
    check(`icon 文件存在且是 PNG：${src}`, Boolean(info),
      exists ? (info ? `${info.width}x${info.height} ${info.bytes} B` : 'PNG 头/IHDR 不合法') : '文件不存在');
    if (info) {
      check(`icon PNG 实际尺寸与 sizes 一致：${src}`,
        info.width === size[0] && info.height === size[1],
        `声明 ${icon.sizes}，实际 ${info.width}x${info.height}`);
      const purposes = String(icon.purpose || 'any').split(/\s+/);
      if (purposes.includes('maskable')) maskableCount += 1;
      else anySizes.add(icon.sizes);
    }
  }

  check('至少一个 192×192 的 any 图标（Android 列表/通知用）', anySizes.has('192x192'), [...anySizes].join(','));
  check('至少一个 512×512 的 any 图标（安装提示/启动器用）', anySizes.has('512x512'), [...anySizes].join(','));
  check('至少一个 purpose=maskable 的 512 图标（Android 自适应图标）', maskableCount >= 1, `${maskableCount} 个`);

  // ---------- 3) apple-touch-icon（iOS 不读 manifest.icons） ----------
  const appleFile = path.join(PUBLIC, 'apple-touch-icon.png');
  const appleInfo = fs.existsSync(appleFile) ? pngSize(appleFile) : null;
  check('apple-touch-icon.png 存在且 180×180',
    Boolean(appleInfo) && appleInfo.width === 180 && appleInfo.height === 180,
    appleInfo ? `${appleInfo.width}x${appleInfo.height} ${appleInfo.bytes} B` : '文件不存在');

  // ---------- 4) index.html：color-scheme 与图标链接 ----------
  const html = fs.readFileSync(INDEX_PATH, 'utf8');
  const scheme = (html.match(/<meta\s+name="color-scheme"\s+content="([^"]*)"/i) || [])[1] || '';
  check('index.html 的 color-scheme 含 dark（原生控件才会跟随深色）',
    /\bdark\b/.test(scheme), `content="${scheme}"`);
  check('index.html 引 apple-touch-icon', /<link[^>]+rel="apple-touch-icon"[^>]*apple-touch-icon\.png/i.test(html));
  check('index.html 仍保留 manifest / theme-color / apple-mobile-web-app-capable',
    /rel="manifest"/.test(html) && /name="theme-color"/.test(html) && /apple-mobile-web-app-capable/.test(html));

  // ---------- 5) 在线（需要构建后的 dist + 8787 服务） ----------
  let online = false;
  try {
    const ping = await fetchWithTimeout(`${BASE}/manifest.webmanifest`, 2500);
    online = ping.ok;
  } catch { /* 服务没起 */ }

  if (!online) {
    skip(`在线校验 ${BASE}`, '服务不可达，已跳过（静态部分不需要构建）');
  } else {
    // 服务端对缺失静态文件会回 SPA 兜底（200 + text/html），所以必须验 content-type
    try {
      const res = await fetchWithTimeout(`${BASE}/manifest.webmanifest`);
      const type = String(res.headers.get('content-type') || '');
      const body = await res.text();
      let served = null;
      try { served = JSON.parse(body); } catch { /* 不是 JSON 就不是 manifest */ }
      check('/manifest.webmanifest 返回 200 且 content-type 是 manifest/json',
        res.status === 200 && /manifest\+json|application\/json/.test(type),
        `HTTP ${res.status} ${type}`);
      check('/manifest.webmanifest 线上内容已含 icons（dist 需要重新构建）',
        Array.isArray(served?.icons) && served.icons.length >= 3,
        `${Array.isArray(served?.icons) ? served.icons.length : 0} 项`);
    } catch (e) {
      check('/manifest.webmanifest 可获取', false, e.message);
    }

    for (const [label, url] of [
      ['/icons/icon-192.png', `${BASE}/icons/icon-192.png`],
      ['/apple-touch-icon.png', `${BASE}/apple-touch-icon.png`],
    ]) {
      try {
        const res = await fetchWithTimeout(url);
        const type = String(res.headers.get('content-type') || '');
        const buf = Buffer.from(await res.arrayBuffer());
        check(`${label} 返回 200 且 content-type=image/png（含 PNG 魔数）`,
          res.status === 200 && /^image\/png/.test(type) && isPng(buf),
          `HTTP ${res.status} ${type} ${buf.length} B`);
      } catch (e) {
        check(`${label} 可获取`, false, e.message);
      }
    }
  }

  const failed = results.filter((r) => !r.ok);
  const skipped = results.filter((r) => r.skipped);
  console.log(`\n${failed.length === 0 ? '全部通过' : '有失败'}：${results.length - failed.length - skipped.length}/${results.length - skipped.length}`
    + (skipped.length ? `（跳过 ${skipped.length} 项在线校验）` : ''));
  if (failed.length) {
    console.log('失败项：' + failed.map((f) => f.name).join('; '));
    process.exitCode = 1;
  }
};

main().catch((e) => {
  console.error('验证异常：', e.message);
  process.exitCode = 1;
});
