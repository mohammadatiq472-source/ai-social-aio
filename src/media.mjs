// 媒体：本地存储驱动 + 类型嗅探 + 签名 URL
// 设计见 docs/媒体与富内容模型.md：二进制不进 events，只进 attachments。
import crypto from 'node:crypto';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import { Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import sharp from 'sharp';
import { createLimiter } from './core/limit.mjs';
import { pool } from './db.mjs';
import { config } from './config.mjs';
import { storage } from './storage/index.mjs';

const TTL_SEC = Number(config.mediaUrlTtl || 600);

// 允许的类型：mime → 扩展名 + 归到哪种 kind + 单文件上限
export const MIME_RULES = {
  'image/jpeg': { ext: 'jpg', kind: 'image', maxBytes: 8 * 1024 * 1024 },
  'image/png': { ext: 'png', kind: 'image', maxBytes: 8 * 1024 * 1024 },
  'image/webp': { ext: 'webp', kind: 'image', maxBytes: 8 * 1024 * 1024 },
  'image/gif': { ext: 'gif', kind: 'image', maxBytes: 8 * 1024 * 1024 },
  'audio/ogg': { ext: 'ogg', kind: 'voice', maxBytes: 8 * 1024 * 1024 },
  'audio/webm': { ext: 'weba', kind: 'voice', maxBytes: 8 * 1024 * 1024 },
  'audio/mpeg': { ext: 'mp3', kind: 'voice', maxBytes: 8 * 1024 * 1024 },
  'audio/mp4': { ext: 'm4a', kind: 'voice', maxBytes: 8 * 1024 * 1024 },
  'video/mp4': { ext: 'mp4', kind: 'video', maxBytes: 40 * 1024 * 1024 },
  // 浏览器录屏/摄像头常见 webm；.mov（QuickTime）也常被直接拖进来。
  // 以前只允许 mp4，而输入框 accept="video/*"——用户选 webm/mov 必 415（外部评审 §4-4 的连带问题）。
  'video/webm': { ext: 'webm', kind: 'video', maxBytes: 40 * 1024 * 1024 },
  'video/quicktime': { ext: 'mov', kind: 'video', maxBytes: 40 * 1024 * 1024 },
  'application/pdf': { ext: 'pdf', kind: 'file', maxBytes: 20 * 1024 * 1024 },
};

// 只信文件头，不信 Content-Type
export function sniffMime(buf) {
  if (!buf || buf.length < 12) return null;
  const b = buf;
  if (b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return 'image/jpeg';
  if (b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47) return 'image/png';
  if (b.slice(0, 3).toString('ascii') === 'GIF') return 'image/gif';
  if (b.slice(0, 4).toString('ascii') === 'RIFF' && b.slice(8, 12).toString('ascii') === 'WEBP') return 'image/webp';
  // EBML 容器：webm 既可能是语音（Chrome MediaRecorder 录音）也可能是视频（录屏/摄像头）。
  // 只看魔数会把**视频 webm 误判成音频**（上传后当 voice 存，前端按 video 段引用就对不上，
  // 实测 415/发不出去）。这里扫一下 TrackType 元素（0x83）：1=video、2=audio，
  // 有视频轨就判 video/webm，否则才是 audio/webm。
  if (b[0] === 0x1a && b[1] === 0x45 && b[2] === 0xdf && b[3] === 0xa3) {
    const head = b.subarray(0, Math.min(b.length, 64 * 1024));
    const hasVideoTrack = head.indexOf(Buffer.from([0x83, 0x81, 0x01])) >= 0;
    return hasVideoTrack ? 'video/webm' : 'audio/webm';
  }
  if (b.slice(0, 4).toString('ascii') === 'OggS') return 'audio/ogg';
  if (b.slice(0, 3).toString('ascii') === 'ID3') return 'audio/mpeg';
  if (b[0] === 0xff && (b[1] & 0xe0) === 0xe0) return 'audio/mpeg';
  if (b.slice(4, 8).toString('ascii') === 'ftyp') {
    const brand = b.slice(8, 12).toString('ascii');
    if (brand.startsWith('M4A')) return 'audio/mp4';
    if (brand === 'qt  ') return 'video/quicktime';
    return 'video/mp4';
  }
  if (b.slice(0, 5).toString('ascii') === '%PDF-') return 'application/pdf';
  // SVG：文本，前 512 字节里找 <svg
  const head = b.slice(0, 512).toString('utf8').trim().toLowerCase();
  if (head.startsWith('<svg') || head.startsWith('<?xml') && head.includes('<svg')) return 'image/svg+xml';
  return null;
}

export async function saveAttachment(buffer, { uploaderId, declaredMime, filename, durationMs, width, height }) {
  const mime = sniffMime(buffer);
  if (!mime) return { ok: false, reason: 'unsupported_type', message: '无法识别的文件类型（只接受图片/语音/视频/PDF）' };
  const rule = MIME_RULES[mime];
  if (!rule) return { ok: false, reason: 'unsupported_type', message: `不支持的类型：${mime}` };
  if (buffer.length > rule.maxBytes) {
    return { ok: false, reason: 'too_large', message: `文件过大，上限 ${Math.round(rule.maxBytes / 1024 / 1024)}MB` };
  }
  if (buffer.length < 64) return { ok: false, reason: 'too_small', message: '文件太小，可能不是有效内容' };

  const sha = crypto.createHash('sha256').update(buffer).digest('hex');
  // 同一个人上传同一份内容 → 复用（去重）
  const existing = await pool.query(
    'SELECT id, kind, mime, bytes, width, height, duration_ms FROM attachments WHERE sha256=$1 AND uploader_id=$2 AND deleted_at IS NULL',
    [sha, uploaderId],
  );
  if (existing.rows[0]) {
    const a = existing.rows[0];
    return { ok: true, reused: true, attachment: await attachThumb(mapAttachment(a)) };
  }

  // 每人媒体配额（用户 2026-11-13 定的口径：2GB；头像/表情包也算，都是 attachments）
  const quota = config.limits?.mediaQuotaBytes || 2 * 1024 ** 3;
  const { rows: usedRows } = await pool.query(
    'SELECT COALESCE(sum(bytes), 0)::bigint AS n FROM attachments WHERE uploader_id = $1 AND deleted_at IS NULL',
    [uploaderId],
  );
  const used = Number(usedRows[0]?.n || 0);
  if (used + buffer.length > quota) {
    return {
      ok: false,
      reason: 'quota_exceeded',
      message: `媒体空间已满（每人 ${quota >= 1024 ** 3 ? Math.round(quota / 1024 ** 3) + 'GB' : Math.round(quota / 1024 / 1024) + 'MB'}），删掉旧内容或等过期清理`,
    };
  }

  const key = `${sha.slice(0, 2)}/${sha.slice(2, 4)}/${sha}.${rule.ext}`;
  // 落盘走存储驱动（本地盘 = 异步写；以后换对象存储只改驱动）
  await storage().put(key, buffer);

  // 客户端可给时长/宽高提示（服务端不解析媒体，只做区间校验）
  const clampInt = (v, min, max) => {
    const n = Number(v);
    return Number.isFinite(n) && n >= min && n <= max ? Math.round(n) : null;
  };
  // 配了扫描器就先挂 pending，由 scripts/scan-media.mjs 判定；没配则直接 clean（不误拦）
  const initialScan = config.scanProvider && config.scanProvider !== 'none' ? 'pending' : 'clean';
  const { rows } = await pool.query(
    `INSERT INTO attachments (uploader_id, kind, mime, bytes, sha256, storage_key, duration_ms, width, height, scan_state)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)
     ON CONFLICT (sha256, uploader_id) DO NOTHING
     RETURNING id, kind, mime, bytes, width, height, duration_ms`,
    [uploaderId, rule.kind, mime, buffer.length, sha, key,
      (rule.kind === 'voice' || rule.kind === 'video') ? clampInt(durationMs, 100, 300_000) : null,
      clampInt(width, 1, 20000), clampInt(height, 1, 20000), initialScan],
  );
  if (!rows[0]) {
    // 并发上传同一份内容：上面的去重查询和 INSERT 之间有竞态，这里兜住
    const { rows: existingRows } = await pool.query(
      'SELECT id, kind, mime, bytes, width, height, duration_ms FROM attachments WHERE sha256=$1 AND uploader_id=$2 AND deleted_at IS NULL',
      [sha, uploaderId],
    );
    if (existingRows[0]) return { ok: true, reused: true, attachment: await attachThumb(mapAttachment(existingRows[0])) };
    return { ok: false, reason: 'conflict', message: '附件写入冲突，请重试' };
  }
  return { ok: true, reused: false, attachment: await attachThumb(mapAttachment(rows[0])) };
}

function mapAttachment(r) {
  const out = {
    id: Number(r.id),
    kind: r.kind,
    mime: r.mime,
    bytes: Number(r.bytes),
    width: r.width == null ? null : Number(r.width),
    height: r.height == null ? null : Number(r.height),
    durationMs: r.duration_ms == null ? null : Number(r.duration_ms),
  };
  // 只有已经派生出缩略图的图片才给 thumbUrl：前端拿不到就回退 url（不猜、不 404）
  if (r.thumb_key) out.thumbUrl = mediaUrl(out.id, undefined, 'thumb');
  return out;
}

// ============================================================================
// 缩略图（P1-6）：480px 内 WebP，派生文件按原图 sha256 内容寻址
// ============================================================================
const THUMB_MAX_EDGE = 480;
const THUMB_MIME = 'image/webp';
const THUMB_QUALITY = 78;
// GIF 取一帧会丢动画；SVG 本来就是矢量（且可能带脚本）——两者都不做缩略图
const THUMB_SKIP_MIME = new Set(['image/gif', 'image/svg+xml']);
// 8MB 的图也可能解出上亿像素（解压炸弹）：croak 掉而不是把进程内存打爆
const THUMB_LIMIT_INPUT_PIXELS = 40_000_000;

// 并发闸（[C1] 400MB 进程上限）：40MP 解码约 160MB，两三个并发就 OOM。
// 队列满时不排队、直接放弃本次派生（调用方回退原图），避免请求挂死把内存拖爆。
const thumbLimiter = createLimiter({
  concurrency: config.thumbConcurrency,
  maxQueue: 32,
  name: 'thumb',
});

/** 缩略图闸门水位（运维/验证脚本可读；不含任何内容信息） */
export function thumbGateStats() {
  return thumbLimiter.stats();
}

function thumbable(kind, mime) {
  return kind === 'image' && !THUMB_SKIP_MIME.has(String(mime || '').toLowerCase());
}

function thumbKeyOf(sha256) {
  return `thumb/${sha256}.webp`;
}

/** 存储对象整块读入内存：原图上限 8MB，缩略图 <200KB，比逐块拼流简单且可控 */
async function readStorageBuffer(key) {
  const chunks = [];
  for await (const chunk of storage().createReadStream(key)) chunks.push(chunk);
  return Buffer.concat(chunks);
}

/**
 * 确保附件有缩略图：有且文件在 → 直接返回；缺失 → 用原图派生 480px WebP 并回填四列。
 * 只对常见位图生效；坏图/GIF/SVG/已删除返回 null（调用方回退原图，不 404）。
 * 幂等且可并发：同一 sha256 的目标 key 相同，storage.put 是原子 rename。
 */
export async function ensureThumb(attachmentId) {
  const id = Number(attachmentId);
  if (!Number.isInteger(id) || id <= 0) return null;
  const { rows } = await pool.query(
    `SELECT id, kind, mime, storage_key, sha256, deleted_at,
            thumb_key, thumb_bytes, thumb_width, thumb_height
       FROM attachments WHERE id=$1`,
    [id],
  );
  const row = rows[0];
  if (!row || row.deleted_at) return null;
  if (!thumbable(row.kind, row.mime)) return null;
  // 老数据缺 sha256 就没法内容寻址（存储 key 不是可推导的），宁可不生成
  if (!row.sha256) return null;

  // 数据库里记了但文件被清理掉（backup/cleanup 只删文件）→ 重建
  if (row.thumb_key) {
    const st = await storage().stat(row.thumb_key);
    if (st) {
      return {
        key: row.thumb_key,
        bytes: Number(row.thumb_bytes) || st.bytes,
        width: row.thumb_width == null ? null : Number(row.thumb_width),
        height: row.thumb_height == null ? null : Number(row.thumb_height),
        mime: THUMB_MIME,
      };
    }
  }

  let original;
  try {
    original = await readStorageBuffer(row.storage_key);
  } catch {
    return null;
  }

  // 解码前拿名额：拿不到说明队列已满，本次回退原图（不 404、不影响上传结果）
  const gotSlot = await thumbLimiter.acquire();
  if (!gotSlot) {
    console.warn(`[media] 缩略图并发队列已满，本次回退原图 attachment=${id}`);
    return null;
  }

  let out;
  try {
    out = await sharp(original, { limitInputPixels: THUMB_LIMIT_INPUT_PIXELS })
      .rotate()
      .resize({ width: THUMB_MAX_EDGE, height: THUMB_MAX_EDGE, fit: 'inside', withoutEnlargement: true })
      .webp({ quality: THUMB_QUALITY })
      .toBuffer({ resolveWithObject: true });
    original = null; // 峰值已经过去，尽早放掉 8MB 原图缓冲
  } catch (err) {
    // 伪装成图片的坏文件：只记 id 与错误类型，不记内容；不阻断上传，也不缓存失败
    console.warn(`[media] 缩略图生成失败 attachment=${id}: ${err.message}`);
    return null;
  } finally {
    // 必须归还：名额泄漏一次，整条缩略图通道就永久少一格
    thumbLimiter.release();
  }

  const key = thumbKeyOf(row.sha256);
  await storage().put(key, out.data);
  await pool.query(
    `UPDATE attachments SET thumb_key=$2, thumb_bytes=$3, thumb_width=$4, thumb_height=$5
      WHERE id=$1`,
    [id, key, out.data.length, out.info.width, out.info.height],
  );
  return { key, bytes: out.data.length, width: out.info.width, height: out.info.height, mime: THUMB_MIME };
}

/** 上传成功后补齐 thumbUrl；失败只 warn（不能让一张坏图把整个上传变成 500） */
async function attachThumb(attachment) {
  if (!attachment || attachment.kind !== 'image') return attachment;
  try {
    const thumb = await ensureThumb(attachment.id);
    if (!thumb) return attachment;
    return { ...attachment, thumbUrl: mediaUrl(attachment.id, undefined, 'thumb') };
  } catch (err) {
    console.warn(`[media] 缩略图回填失败 attachment=${attachment.id}: ${err.message}`);
    return attachment;
  }
}

// 签名 URL：/media/:id?e=<exp>&s=<hmac>（缩略图多一个 v=thumb）
function hmacHex(input) {
  // [外部评审 P0-1] 不回退到 DATABASE_URL（内含 DB 口令）或公开常量 'qqmini'：
  // 否则攻击者能离线算出任意 id.exp 的 HMAC，伪造 /media 链接读取全站附件。
  // assertConfig() 已保证启动时 SESSION_SECRET 存在；这里是纵深防御。
  const secret = config.sessionSecret;
  if (!secret) throw new Error('SESSION_SECRET 未配置：媒体签名 URL 需要显式密钥');
  return crypto.createHmac('sha256', secret).update(input).digest('hex').slice(0, 32);
}

// 变体必须进 HMAC 输入：否则把 thumb URL 的 s 挪到原图 URL（或反过来）仍然有效，
// 「签名变体」就只是换了个查询串。
function sign(id, exp, variant = '') {
  return hmacHex(`${id}.${exp}.${variant}`);
}

// 上线前签出的 URL：HMAC 输入只有 `${id}.${exp}`。保留这一段是为了已发出去的链接不 403。
function legacySign(id, exp) {
  return hmacHex(`${id}.${exp}`);
}

function timingSafeEqualStr(a, b) {
  const ba = Buffer.from(String(a));
  const bb = Buffer.from(String(b));
  return ba.length === bb.length && crypto.timingSafeEqual(ba, bb);
}

const URL_WINDOW_SEC = 3600; // 签名有效期的对齐窗口：同一小时内 URL 不变，浏览器才缓存得住

export function mediaUrl(id, ttlSec = TTL_SEC, variant = '') {
  // 对齐到整点：URL 在一小时内稳定（以前每次请求都换 exp → 缓存 key 每次都变）
  const exp = Math.ceil((Date.now() / 1000 + ttlSec) / URL_WINDOW_SEC) * URL_WINDOW_SEC;
  // 目前只有缩略图一个变体；白名单外一律按原图签，避免出现「签了但没人认」的 URL
  const v = variant === 'thumb' ? 'thumb' : '';
  const sig = sign(id, exp, v);
  return v
    ? `/media/${id}?v=${v}&e=${exp}&s=${sig}`
    : `/media/${id}?e=${exp}&s=${sig}`;
}

export function verifyMedia(id, exp, sig, variant = '') {
  if (!Number.isInteger(Number(exp)) || Number(exp) * 1000 < Date.now()) return false;
  const v = variant === 'thumb' ? 'thumb' : '';
  if (timingSafeEqualStr(sig, sign(id, exp, v))) return true;
  // 旧 URL（无 v）兼容：当年 HMAC 不含变体段
  return v === '' && timingSafeEqualStr(sig, legacySign(id, exp));
}

/**
 * 媒体元数据（不读文件本体）：/media/:id 用它做 ETag / Range，避免把 40MB 视频
 * 整个 readFileSync 进内存再整块喷出去（同步读 + 无 Range = 拖动进度条重下全片）。
 * variant='thumb' 时：老图按需生成；生成失败回退原图（读路径不能 404 破图）。
 */
export async function loadAttachmentMeta(id, variant = '') {
  const { rows } = await pool.query(
    `SELECT storage_key, mime, bytes, kind, sha256, deleted_at, scan_state,
            thumb_key, thumb_bytes, thumb_width, thumb_height
       FROM attachments WHERE id=$1`,
    [id],
  );
  const row = rows[0];
  if (!row || row.deleted_at) return null;
  if (row.scan_state === 'blocked') return null;   // 违规内容直接不下发

  if (variant === 'thumb') {
    let thumb = null;
    if (row.thumb_key) {
      const st = await storage().stat(row.thumb_key);
      if (st) {
        thumb = {
          key: row.thumb_key,
          bytes: Number(row.thumb_bytes) || st.bytes,
          width: row.thumb_width == null ? null : Number(row.thumb_width),
          height: row.thumb_height == null ? null : Number(row.thumb_height),
        };
      }
    }
    // 老图没有缩略图 / 文件被清理：按需生成（单次请求内完成，之后命中上面的分支）
    if (!thumb) thumb = await ensureThumb(id).catch(() => null);
    if (thumb) {
      const bytes = Number(thumb.bytes) || 0;
      return {
        key: thumb.key,
        bytes,
        mime: THUMB_MIME,
        kind: 'image',
        isThumb: true,
        width: thumb.width,
        height: thumb.height,
        // 变体 ETag 必须和原图不同（原图是 storage_key 的 sha）；带上 bytes 让尺寸/质量变化也能失效
        etag: crypto.createHash('sha256').update(`${thumb.key}.${bytes}`).digest('hex').slice(0, 32),
      };
    }
    // 生成不出来（GIF/SVG/坏图）→ 继续走原图分支
  }

  const stat = await storage().stat(row.storage_key);
  if (!stat) return null;
  return {
    key: row.storage_key,
    // attachments.bytes 是上传时记账的权威值；行存在但值为空/0 时用磁盘实际大小兜底
    bytes: Number(row.bytes) || stat.bytes,
    mime: row.mime,
    kind: row.kind,
    isThumb: false,
    // 内容寻址：storage_key 里就是 sha256，天然适合当强 ETag
    etag: String(row.storage_key).replace(/[^a-f0-9]/gi, '').slice(0, 32),
  };
}

/** 解析单段 Range（只支持一个区间；非法/多段返回 null → 回退 200 全量） */
export function parseByteRange(header, size) {
  if (!header || !Number.isFinite(size) || size <= 0) return null;
  const m = /^bytes=(\d*)-(\d*)$/.exec(String(header).trim());
  if (!m) return null;
  const [, rawStart, rawEnd] = m;
  if (rawStart === '' && rawEnd === '') return null;
  let start;
  let end;
  if (rawStart === '') {
    // bytes=-N：最后 N 字节
    const n = Number(rawEnd);
    if (!Number.isFinite(n) || n <= 0) return null;
    start = Math.max(0, size - n);
    end = size - 1;
  } else {
    start = Number(rawStart);
    end = rawEnd === '' ? size - 1 : Number(rawEnd);
  }
  if (!Number.isFinite(start) || !Number.isFinite(end) || start < 0 || end < start || start >= size) return null;
  return { start, end: Math.min(end, size - 1) };
}

/**
 * 批量附件元数据。`viewerId` 决定「扫描未完成」的附件看不看得见（外部审查 Q6）：
 *   - clean：所有人可见；
 *   - blocked：所有人不可见（只给 blocked 占位）；
 *   - pending/其它非 clean：**只有上传者本人**看得见（用来预览"审核中"），其他人拿到占位、没有 URL。
 *
 * 为什么必须在「签发 URL 的地方」拦，而不是在 /media/:id 拦：
 * `/media/:id?e=&s=` 里 `s` 是 HMAC 能力凭证，绕开本服务直接 GET 也成立；
 * 换句话说 URL 一旦下发就等于内容已授权。所以判定只能发生在 hydrate/attachmentsMeta 这一层。
 */
export async function attachmentsMeta(ids, viewerId = null) {
  if (!ids.length) return new Map();
  const { rows } = await pool.query(
    `SELECT id, uploader_id, kind, mime, bytes, width, height, duration_ms, scan_state, thumb_key
       FROM attachments WHERE id = ANY($1::bigint[]) AND deleted_at IS NULL`,
    [ids],
  );
  const map = new Map();
  const viewer = Number(viewerId) || 0;
  for (const r of rows) {
    const id = Number(r.id);
    const base = mapAttachment(r);
    if (r.scan_state === 'blocked') {
      map.set(id, { ...base, blocked: true });
      continue;
    }
    // 非 clean（pending）= 还没审完：非上传者只拿到占位元信息，连缩略图 URL 都不给
    if (r.scan_state !== 'clean' && (!viewer || Number(r.uploader_id) !== viewer)) {
      const { thumbUrl: _thumbUrl, ...rest } = base;
      map.set(id, { ...rest, pending: true });
      continue;
    }
    map.set(id, base);
  }
  return map;
}

// 给 parts 补上 url 与元数据（渲染/下发都用这一份，避免两处实现漂移）
//
// `viewerId` 必须传「这条内容要发给谁」的 principal id；不传 = 非上传者视角（fail-closed）。
// 典型的「视角」有三种：
//   1. 人类/其它成员读消息 → 自己的 id（pending 只有上传者可见）；
//   2. MCP whats_new → Agent 自己的 id；
//   3. WS 广播帧 → **传 null**：整条帧只 stringify 一次、全群共用同一份字符串，
//      按上传者视角生成就会把「审核中」的签名 URL 广播给所有人。
export async function hydrateParts(parts, viewerId = null) {
  if (!Array.isArray(parts) || !parts.length) return [];
  const ids = parts
    .flatMap((p) => (p ? [p.attachment_id, p.poster_attachment_id] : []))
    .filter((v) => v != null)
    .map(Number);
  if (!ids.length) return parts;
  const meta = await attachmentsMeta([...new Set(ids)], viewerId);
  const one = (id) => {
    const m = meta.get(Number(id));
    if (!m) return { missing: true };
    // 一个 map 值只有三种形态：clean（可签 URL）、pending（仅上传者可见，无 URL）、blocked（无 URL）。
    // 可见性在 attachmentsMeta 里已经按 viewer 分流，这里只判断「这个值本身带不带 URL」。
    if (m.blocked || m.pending) return { ...m };
    return { ...m, url: mediaUrl(m.id) };
  };
  return parts.map((p) => {
    if (!p || !p.attachment_id) return p;
    const base = one(p.attachment_id);
    if (base.missing) return { ...p, missing: true };
    if (base.blocked) return { ...p, blocked: true };
    // 未审完：只保留占位元信息，不带 url / thumbUrl（前端渲染「审核中」）
    if (base.pending) {
      return {
        ...p,
        pending: true,
        mime: base.mime,
        bytes: base.bytes,
        width: base.width,
        height: base.height,
        durationMs: base.durationMs,
      };
    }
    const out = {
      ...p,
      mime: base.mime,
      bytes: base.bytes,
      width: base.width,
      height: base.height,
      durationMs: base.durationMs,
      url: base.url,
    };
    // 缩略图只在已派生时下发；前端拿不到就回退原图（老附件不会因此破图）
    if (base.thumbUrl) out.thumbUrl = base.thumbUrl;
    if (p.poster_attachment_id) {
      const poster = one(p.poster_attachment_id);
      // 封面同样受扫描态约束：以前只判 missing，blocked/pending 的封面 URL 会漏出去
      if (!poster.missing && !poster.blocked && !poster.pending) {
        out.posterUrl = poster.url;
        if (poster.thumbUrl) out.posterThumbUrl = poster.thumbUrl;
      }
    }
    return out;
  });
}

// ============================================================================
// 流式上传：边收边写临时文件 + 边算 sha256，峰值内存只跟 chunk 有关（不再 2×body）
// 收完再做 mime/大小/配额校验，通过后 rename 到内容寻址路径（原子替换）。
// ============================================================================
const MAX_UPLOAD_BYTES = 45 * 1024 * 1024;
// 类型嗅探只保留头部这么多字节（内存上限 = 并发数 × 64KB）
const HEAD_SNIFF_BYTES = 64 * 1024;

function clampMetaInt(v, min, max) {
  const n = Number(v);
  return Number.isFinite(n) && n >= min && n <= max ? Math.round(n) : null;
}

/** 临时文件 → 正式附件：校验类型/大小/配额、去重、原子改名、写 attachments 行 */
async function finalizeFromTemp({ tmpPath, bytes, sha, head, uploaderId, durationMs, width, height }) {
  const cleanup = async () => { await fsp.unlink(tmpPath).catch(() => {}); };
  const mime = sniffMime(head);
  if (!mime) { await cleanup(); return { ok: false, reason: 'unsupported_type', message: '无法识别的文件类型（只接受图片/语音/视频/PDF）' }; }
  const rule = MIME_RULES[mime];
  if (!rule) { await cleanup(); return { ok: false, reason: 'unsupported_type', message: `不支持的类型：${mime}` }; }
  if (bytes > rule.maxBytes) {
    await cleanup();
    return { ok: false, reason: 'too_large', message: `文件过大，上限 ${Math.round(rule.maxBytes / 1024 / 1024)}MB` };
  }
  if (bytes < 64) { await cleanup(); return { ok: false, reason: 'too_small', message: '文件太小，可能不是有效内容' }; }

  // 同一个人上传同一份内容 → 复用（去重）
  const existing = await pool.query(
    'SELECT id, kind, mime, bytes, width, height, duration_ms FROM attachments WHERE sha256=$1 AND uploader_id=$2 AND deleted_at IS NULL',
    [sha, uploaderId],
  );
  if (existing.rows[0]) {
    await cleanup();
    return { ok: true, reused: true, attachment: await attachThumb(mapAttachment(existing.rows[0])) };
  }

  // 每人媒体配额
  const quota = config.limits?.mediaQuotaBytes || 2 * 1024 ** 3;
  const { rows: usedRows } = await pool.query(
    'SELECT COALESCE(sum(bytes), 0)::bigint AS n FROM attachments WHERE uploader_id = $1 AND deleted_at IS NULL',
    [uploaderId],
  );
  const used = Number(usedRows[0]?.n || 0);
  if (used + bytes > quota) {
    await cleanup();
    return {
      ok: false,
      reason: 'quota_exceeded',
      message: `媒体空间已满（每人 ${quota >= 1024 ** 3 ? Math.round(quota / 1024 ** 3) + 'GB' : Math.round(quota / 1024 / 1024) + 'MB'}），删掉旧内容或等过期清理`,
    };
  }

  const key = `${sha.slice(0, 2)}/${sha.slice(2, 4)}/${sha}.${rule.ext}`;
  // 大文件从临时文件原子移动（目标已存在时驱动内部会删临时文件）
  await storage().putFromFile(tmpPath, key);

  const initialScan = config.scanProvider && config.scanProvider !== 'none' ? 'pending' : 'clean';
  const { rows } = await pool.query(
    `INSERT INTO attachments (uploader_id, kind, mime, bytes, sha256, storage_key, duration_ms, width, height, scan_state)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)
     ON CONFLICT (sha256, uploader_id) DO NOTHING
     RETURNING id, kind, mime, bytes, width, height, duration_ms`,
    [uploaderId, rule.kind, mime, bytes, sha, key,
      (rule.kind === 'voice' || rule.kind === 'video') ? clampMetaInt(durationMs, 100, 300_000) : null,
      clampMetaInt(width, 1, 20000), clampMetaInt(height, 1, 20000), initialScan],
  );
  if (!rows[0]) {
    const { rows: again } = await pool.query(
      'SELECT id, kind, mime, bytes, width, height, duration_ms FROM attachments WHERE sha256=$1 AND uploader_id=$2 AND deleted_at IS NULL',
      [sha, uploaderId],
    );
    if (again[0]) return { ok: true, reused: true, attachment: await attachThumb(mapAttachment(again[0])) };
    return { ok: false, reason: 'conflict', message: '附件写入冲突，请重试' };
  }
  return { ok: true, reused: false, attachment: await attachThumb(mapAttachment(rows[0])) };
}

/** 从请求流直接落盘；返回 {ok, attachment} 或 {ok:false, reason, message} */
export async function receiveAttachmentStream(payload, { uploaderId, durationMs, width, height }) {
  const tmpPath = await storage().tmpFile('upload');
  const hash = crypto.createHash('sha256');
  let bytes = 0;
  let head = Buffer.alloc(0);
  const meter = new Transform({
    transform(chunk, _enc, cb) {
      bytes += chunk.length;
      if (bytes > MAX_UPLOAD_BYTES) {
        cb(Object.assign(new Error('too_large'), { reason: 'too_large' }));
        return;
      }
      hash.update(chunk);
      // 头部要留够：webm 的音/视频轨信息（TrackType）可能在几百字节之后才出现，
      // 只留 64 字节会把视频 webm 误判成 audio/webm。64KB 上限对内存没有实际影响（并发 2）。
      if (head.length < HEAD_SNIFF_BYTES) {
        head = Buffer.concat([head, chunk.subarray(0, HEAD_SNIFF_BYTES - head.length)]);
      }
      cb(null, chunk);
    },
  });
  try {
    await pipeline(payload, meter, fs.createWriteStream(tmpPath, { mode: 0o600 }));
  } catch (err) {
    await fsp.unlink(tmpPath).catch(() => {});
    if (err?.reason === 'too_large') return { ok: false, reason: 'too_large', message: '文件过大（上限 45MB）' };
    return { ok: false, reason: 'aborted', message: '上传中断，请重试' };
  }
  return finalizeFromTemp({
    tmpPath,
    bytes,
    sha: hash.digest('hex'),
    head,
    uploaderId,
    durationMs,
    width,
    height,
  });
}
