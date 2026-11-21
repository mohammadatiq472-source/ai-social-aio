import crypto from 'node:crypto';
import { authenticateAgent } from '../auth/service.mjs';
import fs from 'node:fs';
import path from 'node:path';
import { saveAttachment, receiveAttachmentStream, loadAttachmentMeta, parseByteRange, verifyMedia, mediaUrl, attachmentsMeta } from '../media.mjs';
import { storage } from '../storage/index.mjs';
import {
  authenticateSession, hashPassword, verifyPassword, createSession, sessionCookie, clearCookie,
  noteLoginFailure, isLockedOut, clearLoginFailures, randomToken, sha256,
} from '../auth/service.mjs';
import { pool, withTx, poolStats } from '../db.mjs';
import { submit, hitRate, hitRateHour } from '../core/submit.mjs';
import { openDmForUser } from '../core/social.mjs';
import { assertNotSuspended } from '../core/suspend.mjs';
import { listConversationsFor, getMessages, getMessageBySeq, searchMessages, markRead, directoryFor, myAgents, getMembers, listFriends, listFriendRequests, principalProfile, agentMemberships, avatarOf, listReportsFor, listSuspendedFor, agentQuotaFor } from '../core/query.mjs';
import { discoverGroups, updateGroupPublic, requestJoin, listJoinRequests, decideJoinRequest } from '../core/groups.mjs';
import {
  createInviteForUser, listMine, revokeInvite, adminCreate, adminList, adminRevoke,
  redeemInvite, recordRedemption, auditRedemption,
} from '../core/invites.mjs';
import {
  issueVerification, consumeVerification, isEmailVerified,
  maybeSendVerificationAfterRegister,
} from '../core/email-verify.mjs';
import {
  applyWaitlist, listWaitlist, issueCodeForWaitlist, rejectWaitlist, waitlistCounts,
} from '../core/waitlist.mjs';
import { emailVerifySettings } from '../mail.mjs';
import { config } from '../config.mjs';
import { isOnline, publishRead } from '../ws/hub.mjs';
import { publicKey, pushEnabled, saveSubscription, removeSubscription, listSubscriptions } from '../push.mjs';

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;

// 限流 key 只信"从本机转进来的头"：公网入口是 cloudflared → 127.0.0.1，
// Cloudflare 会覆盖 cf-connecting-ip；直连 8443 时 nginx 写 x-real-ip。
// 以前无条件取 X-Forwarded-For 首段 → 客户端自己填一个就换一个限流身份，锁定形同虚设。
function clientIp(req) {
  const sock = req.socket?.remoteAddress || '';
  const loopback = sock === '127.0.0.1' || sock === '::1' || sock === '::ffff:127.0.0.1';
  if (loopback) {
    const cf = String(req.headers['cf-connecting-ip'] || '').trim();
    if (cf) return cf;
    const real = String(req.headers['x-real-ip'] || '').trim();
    if (real) return real;
  }
  return sock || 'unknown';
}

async function currentUser(req) {
  const sid = req.cookies?.[config.cookieName];
  return authenticateSession(sid || '');
}

// 参数夹取：非法/负数一律回落到默认值，别让 -1 或 1e20 直接进 SQL
function posInt(value, fallback, min = 1, max = Number.MAX_SAFE_INTEGER) {
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  const i = Math.trunc(n);
  if (i < min) return fallback;
  return Math.min(i, max);
}

function meView(actor) {
  // 每次 /api/me 都会走这里：配置判定只做一次（虽然它只是读内存，但没必要算两遍）
  const emailVerify = emailVerifySettings();
  return {
    id: actor.id,
    displayName: actor.displayName,
    email: actor.email || null,
    avatarHue: actor.avatarHue ?? 200,
    avatarUrl: actor.avatarUrl ?? null,
    // pg 的 bigint 会以字符串返回，这里统一成 number，前端类型才对得上
    accountNo: actor.accountNo == null ? null : Number(actor.accountNo),
    discoverable: actor.discoverable !== false,
    // 站务标记：前端据此决定要不要显示「审核」入口（服务端每个接口都还会再校验一次）
    isAdmin: actor.isAdmin === true,
    // 邮箱验证：enabled=false 表示这个实例没配 SMTP（功能整体关闭，前端不要显示入口）
    emailVerified: Boolean(actor.emailVerifiedAt),
    emailVerification: { enabled: emailVerify.enabled, mode: emailVerify.mode },
  };
}

// ---------------------------------------------------------------------------
// 邀请制：建账号（principals + user_accounts + 默认名额 [+ 兑换记录]）
//
// **必须在事务里调用**（client 已在 BEGIN 之后）：邀请码的 used_count / 邀请人额度 used
// 是在同一事务里加过的，这里一失败（email 唯一冲突等）就整体回滚——
// 既不会留下「有账号没扣名额」的白嫖，也不会留下「码扣了但人没建起来」的烂账。
// ---------------------------------------------------------------------------
async function insertUserAccount(client, { email, passwordHash, displayName, username, hue, invite = null }) {
  const p = await client.query(
    `INSERT INTO principals (type, username, display_name, avatar_hue) VALUES ('user',$1,$2,$3)
     RETURNING id, account_no`,
    [username, displayName, hue],
  );
  const principalId = Number(p.rows[0].id);
  await client.query(
    'INSERT INTO user_accounts (principal_id, email, password_hash) VALUES ($1,$2,$3)',
    [principalId, email, passwordHash],
  );
  // B 方案：新用户一律拿默认名额，不靠站务发码。ON CONFLICT 只为幂等（正常不会命中）
  // depth 记的是「这个账号是第几层被邀请的」：站务码/开放注册 = 0，用户码 = 邀请人 depth+1。
  // 它决定这个账号以后还能不能继续往下邀请（见 invites.mjs#redeemInvite 的深度闸）。
  await client.query(
    `INSERT INTO user_invite_quotas (principal_id, quota, used, depth) VALUES ($1,$2,0,$3)
     ON CONFLICT (principal_id) DO NOTHING`,
    [principalId, config.inviteQuotaDefault, Number(invite?.depth || 0)],
  );
  if (invite) {
    await recordRedemption(client, {
      codeId: invite.codeId,
      inviterId: invite.inviterId,
      principalId,
      emailHash: invite.redemption?.emailHash ?? null,
      ipHash: invite.redemption?.ipHash ?? null,
      depth: invite.depth || 0,
    });
    await auditRedemption(client, { inviterId: invite.inviterId, codeId: invite.codeId, principalId });
  }
  return {
    principalId,
    accountNo: p.rows[0].account_no == null ? null : Number(p.rows[0].account_no),
  };
}

// 邀请相关错误 → HTTP 状态。校验类 400、状态类 409、越权 403、不存在 404。
// 文案由前端决定要不要展示，这里只保证 error 码稳定可判。
function inviteStatus(error) {
  switch (error) {
    case 'forbidden': return 403;
    case 'not_found': return 404;
    case 'no_remaining_quota':
    case 'max_uses_exceeds_quota': return 409;
    case 'invalid_max_uses':
    case 'invalid_ttl': return 400;
    default: return 400;
  }
}

const INVITE_ERROR_TEXT = {
  forbidden: '只有本人能操作自己的邀请码',
  not_found: '邀请码不存在或已失效',
  no_remaining_quota: '邀请名额已经用完了',
  max_uses_exceeds_quota: '可用人数超过剩余名额',
  invalid_max_uses: '可用人数必须是 1..100 的整数',
  invalid_ttl: '有效期必须是 1..365 天',
};

// 号码搜索限流：纯内存，按 actor 计数（重启清零；真正的防刷靠 nginx 层的 limit_req）
const searchHits = new Map();
function searchAllowed(actorId) {
  const now = Date.now();
  const win = searchHits.get(actorId) || [];
  const fresh = win.filter((t) => now - t < 60_000);
  if (fresh.length >= 10) {
    searchHits.set(actorId, fresh);
    return false;
  }
  fresh.push(now);
  searchHits.set(actorId, fresh);
  return true;
}

export default async function routes(fastify) {
  // 附件上传：原始二进制。媒体类型走"边收边写"的流式解析器（不再整块读进内存），
  // JSON 仍走 Fastify 默认解析器。req.uploadActor 由上传路由的 onRequest 先填好。
  fastify.addContentTypeParser(
    ['image/png', 'image/jpeg', 'image/webp', 'image/gif', 'audio/ogg', 'audio/webm', 'audio/mpeg', 'audio/mp4',
      'video/mp4', 'video/webm', 'video/quicktime', 'application/pdf', 'application/octet-stream'],
    (req, payload, done) => {
      const actor = req.uploadActor;
      if (!actor) {
        done(Object.assign(new Error('unsupported_body'), { statusCode: 415 }));
        return;
      }
      receiveAttachmentStream(payload, {
        uploaderId: actor.id,
        durationMs: req.headers['x-duration-ms'],
        width: req.headers['x-width'],
        height: req.headers['x-height'],
      })
        .then((out) => done(null, out))
        .catch((err) => done(err));
    },
  );

  // ---------------------------------------------------------------- 媒体上传
  // 上传并发闸门：单请求 body 峰值约 2×，400M 上限下最多放 2 个在途大文件，
  // 否则 5 个 40MB 视频同时传就会把进程顶到 MemoryMax 被 OOM kill。
  const UPLOAD_CONCURRENCY = Number(process.env.UPLOAD_CONCURRENCY || 2);
  let uploadSlots = UPLOAD_CONCURRENCY;
  const uploadQueue = [];
  function acquireUploadSlot() {
    if (uploadSlots > 0) {
      uploadSlots -= 1;
      return Promise.resolve();
    }
    return new Promise((resolve) => uploadQueue.push(resolve));
  }
  function releaseUploadSlot() {
    const next = uploadQueue.shift();
    if (next) next();
    else uploadSlots += 1;
  }

  // 上传：认证放到 onRequest、闸门放到 preParsing —— 必须在"开始收 body"之前排队，
  // 否则 10 个 40MB 上传会先把内存顶满（Fastify 是先收完 body 再进 handler）。
  fastify.post('/api/attachments', {
    bodyLimit: 45 * 1024 * 1024,
    onRequest: async (req, reply) => {
      // 会话 cookie（人类）或 Agent Bearer 都行：MCP 的 JSON-RPC 请求体很小，
      // 图片/视频走这里原始二进制上传（Content-Type 设真实类型，不是 multipart），
      // 再拿 attachment_id 放进 send_message 的 parts。
      let actor = await currentUser(req);
      if (!actor && typeof req.headers.authorization === 'string' && req.headers.authorization.startsWith('Bearer ')) {
        actor = await authenticateAgent(req.headers.authorization);
      }
      if (!actor) return reply.code(401).send({ error: 'unauthorized' });
      req.uploadActor = actor;
    },
    preParsing: async (req, _reply, payload) => {
      await acquireUploadSlot();
      // 关键：排队期间客户端可能已经断开。Node 的 'close' 只发一次，那个时刻我们还没
      // 挂监听（监听在 await 之后才挂），所以「等拿到名额再挂 close」等于永远挂不上，
      // 名额也就永远还不回来 —— 漏满 UPLOAD_CONCURRENCY 次之后全站上传永久挂起。
      // 这里必须在拿到名额后立刻用同步可见的状态判一次；已断就直接归还并终止请求。
      if (req.raw.destroyed || req.raw.readableEnded) {
        releaseUploadSlot();
        throw Object.assign(new Error('client_aborted'), { statusCode: 499 });
      }
      req.uploadSlotHeld = true;
      const release = () => {
        if (!req.uploadSlotHeld) return;
        req.uploadSlotHeld = false;
        releaseUploadSlot();
      };
      // 连接断开 / 响应结束都要归还名额，否则闸门会永久卡死
      req.raw.once('close', release);
      req.raw.once('error', release);
      _reply.raw.once('finish', release);
      // 真正的落盘在媒体类型的流式解析器里；这里只保证"收包之前"就排队
      return payload;
    },
  }, async (req, reply) => {
    const actor = req.uploadActor || (await currentUser(req));
    if (!actor) return reply.code(401).send({ error: 'unauthorized' });
    const out = req.body;
    if (!out || typeof out !== 'object' || typeof out.ok !== 'boolean') {
      return reply.code(400).send({ error: 'invalid_body', message: '请以原始二进制上传，并把 Content-Type 设成真实类型' });
    }
    if (!out.ok) {
      const code = out.reason === 'too_large' || out.reason === 'quota_exceeded' ? 413
        : out.reason === 'aborted' ? 499
          : out.reason === 'internal' ? 500
            : 415;
      return reply.code(code).send({ error: out.reason, message: out.message });
    }
    const a = out.attachment;
    return { attachment: { ...a, url: mediaUrl(a.id) }, reused: out.reused };
  });

  // 签名访问：不要求登录（Agent 与 <img> 都用这个 URL），靠 HMAC + 过期时间
  // 流式 + Range + ETag：视频能拖进度条，也不会为每个请求把几十 MB 读进内存（同步读会卡住事件循环）
  // v=thumb 是缩略图变体：变体参与 HMAC，所以 thumb 签名不能挪去读原图（反过来也一样）。
  fastify.get('/media/:id', async (req, reply) => {
    const id = Number(req.params.id);
    if (!Number.isInteger(id) || id <= 0) return reply.code(400).send({ error: 'invalid_id' });
    // 白名单只有 ''|'thumb'：未知变体直接 400，不静默降级成原图（否则签名变体形同虚设）
    const rawVariant = req.query.v;
    if (rawVariant !== undefined && rawVariant !== '' && rawVariant !== 'thumb') {
      return reply.code(400).send({ error: 'invalid_variant' });
    }
    const variant = rawVariant === 'thumb' ? 'thumb' : '';
    if (!verifyMedia(id, req.query.e, req.query.s, variant)) return reply.code(403).send({ error: 'forbidden' });
    const meta = await loadAttachmentMeta(id, variant);
    if (!meta) return reply.code(404).send({ error: 'not_found' });

    const etag = `"${meta.etag}"`;
    // 缩略图是一次性小文件（≤480px WebP，通常几十 KB）：不提供 Range，
    // 免得同一张缩略图按字节区间碎成多个缓存条目。回退原图时仍按原逻辑支持 Range。
    const range = meta.isThumb ? null : parseByteRange(req.headers.range, meta.bytes);
    const baseHeaders = {
      'Content-Type': meta.mime,
      'X-Content-Type-Options': 'nosniff',
      ...(meta.isThumb ? {} : { 'Accept-Ranges': 'bytes' }),
      ETag: etag,
      // URL 的签名按小时对齐，这里缓存 1 小时；配合 ETag 还能 304
      'Cache-Control': 'private, max-age=3600',
      // 浏览器安全：禁止把文件当文档渲染
      'Content-Security-Policy': "default-src 'none'; sandbox",
    };

    // 条件请求：内容按 sha256 寻址，强校验直接 304
    if (!range && req.headers['if-none-match'] && req.headers['if-none-match'] === etag) {
      reply.code(304);
      for (const [k, v] of Object.entries(baseHeaders)) reply.header(k, v);
      return reply.send();
    }

    for (const [k, v] of Object.entries(baseHeaders)) reply.header(k, v);
    // 文件类（PDF 等）强制下载：同源 inline 渲染 PDF 可以夹带脚本/钓鱼表单
    if (meta.kind === 'file') {
      const ext = String(meta.mime).split('/')[1]?.replace(/[^a-z0-9]/gi, '') || 'bin';
      reply.header('Content-Disposition', `attachment; filename="download.${ext}"`);
    }

    if (range) {
      reply.code(206);
      reply.header('Content-Range', `bytes ${range.start}-${range.end}/${meta.bytes}`);
      reply.header('Content-Length', String(range.end - range.start + 1));
      return reply.send(storage().createReadStream(meta.key, range));
    }
    reply.header('Content-Length', String(meta.bytes));
    return reply.send(storage().createReadStream(meta.key));
  });

  // 完整成员列表（大群懒加载用）
  fastify.get('/api/conversations/:id/members', async (req, reply) => {
    const actor = await currentUser(req);
    if (!actor) return reply.code(401).send({ error: 'unauthorized' });
    const members = await getMembers(actor, Number(req.params.id));
    if (!members) return reply.code(403).send({ error: 'forbidden', message: '你不在这个会话里' });
    return { members, total: members.length };
  });

  // 附件元数据（登录后），前端渲染时批量取
  fastify.get('/api/attachments', async (req, reply) => {
    const actor = await currentUser(req);
    if (!actor) return reply.code(401).send({ error: 'unauthorized' });
    const ids = String(req.query.ids || '')
      .split(',')
      .map((s) => Number(s.trim()))
      .filter((n) => Number.isInteger(n) && n > 0)
      .slice(0, 50);
    // 只允许查自己上传的附件：id 是自增的，不校验归属就能枚举别人的图/语音，
    // 而且 mediaUrl() 会替调用方签出可访问地址（等于把别人的附件读走）。
    // viewer 传 actor.id：上传者对自己「审核中」的附件有预览权（Q6 的唯一例外）。
    const map = await attachmentsMeta(ids, actor.id);
    const { rows: own } = await pool.query(
      'SELECT id FROM attachments WHERE id = ANY($1::bigint[]) AND uploader_id = $2',
      [ids, actor.id],
    );
    const allowed = new Set(own.map((r) => Number(r.id)));
    return [...map.values()]
      .filter((a) => allowed.has(Number(a.id)))
      .map((a) => ({ ...a, url: mediaUrl(a.id) }));
  });

  // ---------------------------------------------------------------- 健康检查
  fastify.get('/healthz', async (req) => {
    // 公网入口是 cloudflared → 127.0.0.1，socket 层永远是 loopback，
    // 所以不能只看 remoteAddress：带 cf-connecting-ip 的就是从公网进来的。
    const sock = req.socket?.remoteAddress || '';
    const loopback = sock === '127.0.0.1' || sock === '::1' || sock === '::ffff:127.0.0.1';
    const fromPublic = Boolean(req.headers['cf-connecting-ip']);
    const localOnly = loopback && !fromPublic;
    let db = false;
    try {
      await pool.query('SELECT 1');
      db = true;
    } catch { /* ignore */ }

    // 公网不暴露备份文件名/保留策略与内存细节，只回最小存活信息
    if (!localOnly) return { ok: true, db };

    // 备份新鲜度：让 /healthz 能回答"最后一次备份是什么时候"，而不是只看进程活没活
    let backup = { count: 0, latest: null, ageMinutes: null, status: 'missing' };
    try {
      const dir = process.env.BACKUP_DIR || '/opt/aio/data/backups';
      const files = fs.readdirSync(dir)
        .filter((f) => f.endsWith('.sql.gz') || f.endsWith('.sql.gz.enc'))
        .map((f) => ({ name: f, mtime: fs.statSync(path.join(dir, f)).mtimeMs }))
        .sort((a, b) => a.mtime - b.mtime);
      if (files.length) {
        const latest = files[files.length - 1];
        const st = fs.statSync(path.join(dir, latest.name));
        const ageMinutes = Math.round((Date.now() - st.mtimeMs) / 60000);
        backup = {
          count: files.length,
          latest: latest.name,
          encrypted: latest.name.endsWith('.enc'),
          ageMinutes,
          status: ageMinutes <= 26 * 60 ? 'ok' : 'stale',
        };
      }
    } catch { /* 目录不可读时保持 missing */ }

    // 容量触发线：cron 跑 scripts/capacity-check.mjs 把结果写进状态文件，这里只读不量。
    // 为什么不在这里直接量：pg_database_size + 递归 du 媒体目录在一次 healthz 里做，
    // 会把探针变成慢请求（而且每 5 分钟的 watchdog 都在打）。
    let capacity = { status: 'missing' };
    try {
      const stateFile = process.env.CAPACITY_STATE || path.join(path.dirname(config.mediaDir), 'capacity.json');
      const st = fs.statSync(stateFile);
      const report = JSON.parse(fs.readFileSync(stateFile, 'utf8'));
      capacity = {
        status: report.status || 'unknown',
        checkedAt: report.checkedAt || null,
        ageMinutes: Math.round((Date.now() - st.mtimeMs) / 60000),
        dbGb: report.metrics?.db?.gb ?? null,
        mediaGb: report.metrics?.media?.gb ?? null,
        online: report.metrics?.online?.count ?? null,
        problems: Array.isArray(report.problems) ? report.problems.slice(0, 5) : [],
      };
    } catch { /* 还没跑过巡检，或状态文件损坏：保持 missing，healthz 不能因此挂 */ }

    return {
      ok: db,
      db,
      // 连接池水位（P1-5）：只给本机看；公网分支只有 {ok, db}，不泄露池配置。
      // waiting>0 持续存在 = 池堵了；total 长期贴着 DB_POOL_MAX = 该加 pool 或查慢查询。
      pools: poolStats(),
      backup,
      capacity,
      uptime: Math.round(process.uptime()),
      memoryMB: Math.round(process.memoryUsage().rss / 1024 / 1024),
      version: '0.1.0',
    };
  });

  // 轻量探针：给宿主定时任务用，不唤起模型、不返回正文
  fastify.get('/api/head', async (req, reply) => {
    const actor = await authenticateSession(req.cookies?.sid || '');
    if (!actor) return reply.code(401).send({ error: 'unauthorized' });
    const { headFor } = await import('../core/query.mjs');
    return { conversations: await headFor(actor) };
  });

  // ------------------------------------------------------------------ 认证
  // 注册（邀请制 B 方案）：invite_code 先走 **DB 邀请码兑换**，兑换与建号在同一个事务里；
  // DB 码失败再回退 env REGISTER_CODE（兼容还没升级到 DB 码的老实例）。
  // 顺序不能反：先建号再兑换，码失效时会留下「有账号没登录资格」的半个用户；
  // 先兑换再建号则失败整体回滚，名额也不会白扣。
  // 错误统一 403 invite_required，不区分 invalid/expired/revoked/exhausted/quota/ip_limit/depth——
  // 区分等于给爆破者一个「这个码存在」的确认信号。
  //
  // [P0] 邮箱唯一性检查**必须在兑换/锁定邀请码之后**做（以前在验码之前 409，无码也能枚举邮箱）：
  //   没有有效码 → 一律 403，永远不告诉你这个邮箱是否存在；
  //   有效码 + 已存在邮箱 → 409，且整个事务回滚（码的 used_count 与邀请人名额都不动）。
  // --------------------------------------------------------- 注册模式 / 候补（实例开放）
  // 公开接口只暴露「需不需要码」「能不能申请候补」，不暴露任何站务信息。
  fastify.get('/api/signup', async () => ({
    mode: config.signupMode,
    inviteRequired: config.signupMode !== 'open',
    waitlistOpen: config.signupMode === 'waitlist',
  }));

  // 候补申请：只在 waitlist 模式下存在；其它模式一律 404（不泄露站务配置）
  fastify.post('/api/waitlist', async (req, reply) => {
    if (config.signupMode !== 'waitlist') return reply.code(404).send({ error: 'not_found' });
    const ip = clientIp(req);
    if (!hitRateHour(`waitlist:${ip}`, 10)) {
      return reply.code(429).send({ error: 'too_many', message: '申请太频繁，请过一会儿再试' });
    }
    const out = await applyWaitlist({ email: req.body?.email, note: req.body?.note, ip });
    if (!out.ok) {
      if (out.error === 'invalid_email') return reply.code(400).send({ error: 'invalid_email', message: '邮箱格式不正确' });
      if (out.error === 'too_many') return reply.code(429).send({ error: 'too_many', message: '同一网络今天申请太多了' });
      return reply.code(400).send({ error: out.error || 'invalid' });
    }
    // 不回显邮箱是否已注册（那会变成枚举接口）；统一「已收到」
    return { ok: true, already: Boolean(out.already), status: out.status };
  });

  // 站务：候补列表 / 发码 / 拒绝
  fastify.get('/api/admin/waitlist', async (req, reply) => {
    const actor = await currentUser(req);
    if (!actor) return reply.code(401).send({ error: 'unauthorized' });
    if (!actor.isAdmin) return reply.code(403).send({ error: 'forbidden', message: '只有站务可以看待审队列' });
    const items = await listWaitlist({ status: String(req.query?.status || 'pending'), limit: req.query?.limit });
    const counts = await waitlistCounts();
    return { items, counts };
  });

  fastify.post('/api/admin/waitlist/:id/issue', async (req, reply) => {
    const actor = await currentUser(req);
    if (!actor) return reply.code(401).send({ error: 'unauthorized' });
    if (!actor.isAdmin) return reply.code(403).send({ error: 'forbidden', message: '只有站务可以发码' });
    const out = await issueCodeForWaitlist({ id: req.params?.id, actor });
    if (!out.ok) {
      const code = out.error === 'not_found' ? 404 : out.error === 'already_decided' ? 409 : 400;
      return reply.code(code).send({ error: out.error, message: out.error === 'already_decided' ? '这条已经处理过了' : '发码失败' });
    }
    // 明文码只在这一次响应里出现（库里只有 HMAC）——把邮箱一并回给站务，方便他直接发出去
    return { ok: true, id: out.id, email: out.email, code: out.code, expiresAt: out.expiresAt };
  });

  fastify.post('/api/admin/waitlist/:id/reject', async (req, reply) => {
    const actor = await currentUser(req);
    if (!actor) return reply.code(401).send({ error: 'unauthorized' });
    if (!actor.isAdmin) return reply.code(403).send({ error: 'forbidden', message: '只有站务可以处理候补' });
    const out = await rejectWaitlist({ id: req.params?.id, actor });
    if (!out.ok) return reply.code(404).send({ error: out.error || 'not_found' });
    return { ok: true, id: out.id };
  });

  fastify.post('/api/auth/register', async (req, reply) => {
    const { email, password, display_name: displayName, invite_code: inviteCode } = req.body || {};
    if (!EMAIL_RE.test(String(email || ''))) return reply.code(400).send({ error: 'invalid_email', message: '邮箱格式不正确' });
    if (String(password || '').length < 10) return reply.code(400).send({ error: 'weak_password', message: '密码至少 10 位' });
    const name = String(displayName || '').trim();
    if (name.length < 1 || name.length > 24) return reply.code(400).send({ error: 'invalid_name', message: '昵称 1..24 字' });

    const ip = clientIp(req);
    const emailLower = String(email).toLowerCase();
    // 邀请码失败计数：与登录共用 login_attempts 表、同一个 isLockedOut 机制，
    // 但用独立 key（invite:<ip>）——否则爆破邀请码会把正常登录也一起锁掉。
    const inviteKey = `invite:${ip}`;
    if ((await isLockedOut(`ip:${ip}`)) || (await isLockedOut(inviteKey))) {
      return reply.code(429).send({ error: 'too_many', message: '尝试过于频繁，请 15 分钟后再试' });
    }

    const username = `${String(email).split('@')[0].toLowerCase().replace(/[^a-z0-9_]/g, '').slice(0, 16) || 'u'}_${crypto.randomBytes(3).toString('hex')}`;
    const hue = Math.floor(Math.random() * 360);
    // scrypt 约 40ms：放在事务外算。事务里握着邀请码/额度行锁等 CPU 会拖住所有兑换者。
    const passwordHash = await hashPassword(String(password));
    const provided = String(inviteCode || '').trim();
    // INVITE_MODE=db：env REGISTER_CODE 整段失效（见 config.mjs 的注释）
    const dbMode = config.inviteMode === 'db';

    const rejectInvite = async () => {
      await noteLoginFailure(inviteKey);
      return reply.code(403).send({ error: 'invite_required', message: '需要有效的邀请码才能注册' });
    };
    const conflict = () => reply.code(409).send({ error: 'email_taken', message: '这个邮箱已经注册过了' });

    // 邮箱查重放在事务内、兑换之后调用：这样「查重」永远晚于「验码」，
    // 没码的人拿不到任何 409/403 的区分信息。占用同一事务连接，不额外开池。
    const emailExists = async (client) => {
      const r = await client.query('SELECT 1 FROM user_accounts WHERE lower(email) = lower($1)', [emailLower]);
      if (r.rows.length) throw Object.assign(new Error('email_taken'), { emailTaken: true });
    };

    let principalId = null;

    // 1) DB 邀请码（优先）。空字符串不做 DB 查询，直接走下面的 env/开放分支。
    if (provided) {
      try {
        const acc = await withTx(async (client) => {
          const redeemed = await redeemInvite({ code: provided, email: emailLower, ip, tx: client });
          if (!redeemed.ok) {
            // 用异常回滚（而不是 return 一个状态）：withTx 对正常返回会 COMMIT，
            // 而这里要让「可能已经锁过/自愈插入过额度行」的事务整体走 ROLLBACK 语义
            throw Object.assign(new Error(`invite_${redeemed.reason}`), { inviteRejected: true, reason: redeemed.reason });
          }
          // 验码通过之后才检查邮箱：无有效码的人永远只看到 403
          await emailExists(client);
          return insertUserAccount(client, {
            email: emailLower, passwordHash, displayName: name, username, hue, invite: redeemed,
          });
        });
        principalId = acc.principalId;
      } catch (err) {
        if (err?.inviteRejected) {
          // 只记原因标识，不记码本身（C6）
          fastify.log.info({ reason: err.reason, ip }, 'register invite rejected');
          // IP 频率闸是「限流」不是「码无效」：给 429 + 明确文案，让正常用户知道等多久，
          // 而且这条**不能**回退到 env REGISTER_CODE（否则换个入口就绕过了防刷闸）。
          if (err.reason === 'ip_limit') {
            return reply.code(429).send({ error: 'too_many', message: '同一网络今天注册次数过多，请明天再试' });
          }
          if (dbMode) return rejectInvite();
          // 兼容模式：落到下面的 env REGISTER_CODE 分支（不匹配则同样 403）
        } else if (err?.emailTaken) {
          // 事务已回滚：码的 used_count 与邀请人名额都没有被消耗
          return conflict();
        } else if (err?.code === '23505') {
          // 并发同邮箱：唯一索引兜底（同样是回滚后 409，不消耗码）
          return conflict();
        } else {
          fastify.log.error({ err: err.message }, 'register failed');
          return reply.code(500).send({ error: 'internal', message: '注册失败' });
        }
      }
    }

    // 2) env REGISTER_CODE（兼容） / 开放注册
    if (!principalId) {
      // SIGNUP_MODE=open：注册不需要码（⚠️ 无验证，仅私域试点；等待候补/邀请模式的实例不受影响）
      if (config.signupMode === 'open') {
        try {
          const acc = await withTx(async (client) => {
            await emailExists(client);
            return insertUserAccount(client, {
              email: emailLower, passwordHash, displayName: name, username, hue, invite: null,
            });
          });
          principalId = acc.principalId;
        } catch (err) {
          if (err?.emailTaken || err?.code === '23505') return conflict();
          fastify.log.error({ err: err.message }, 'register failed');
          return reply.code(500).send({ error: 'internal', message: '注册失败' });
        }
      }
      // open 模式已经在上面建好号了：**必须整段跳过**，否则生产配了 REGISTER_CODE 时
      // 会拿「用户没带码」把刚建好的账号判成 403（账号已建、响应是失败 = 最脏的一种状态）。
      if (!principalId) {
        if (dbMode) return rejectInvite();
        if (config.registerCode) {
          if (provided !== config.registerCode) return rejectInvite();
        } else if (provided) {
          // 开放注册模式下用户却塞了一个无效码：不能静默成功，否则他会以为码被接受了
          return rejectInvite();
        }
        try {
          const acc = await withTx(async (client) => {
            // 这两条路径没有「码」可先验，409 不构成额外的枚举信息（开放注册/持 env 码本来就是合法入口）
            await emailExists(client);
            return insertUserAccount(client, {
              email: emailLower, passwordHash, displayName: name, username, hue, invite: null,
            });
          });
          principalId = acc.principalId;
        } catch (err) {
          if (err?.emailTaken || err?.code === '23505') return conflict();
          fastify.log.error({ err: err.message }, 'register failed');
          return reply.code(500).send({ error: 'internal', message: '注册失败' });
        }
      }
    }

    const { sid, expiresAt } = await createSession(principalId);
    reply.header('set-cookie', sessionCookie(sid, expiresAt));
    // 邮箱验证（没配 SMTP 时是 no-op）：发信失败只记日志，绝不把注册变成 500
    void maybeSendVerificationAfterRegister({ principalId, email: emailLower, log: fastify.log });
    const { rows: fresh } = await pool.query('SELECT account_no, discoverable FROM principals WHERE id=$1', [principalId]);
    return {
      me: meView({
        id: principalId,
        displayName: name,
        email: emailLower,
        avatarHue: hue,
        avatarUrl: null,
        accountNo: fresh[0]?.account_no ?? null,
        discoverable: fresh[0]?.discoverable !== false,
      }),
    };
  });

  fastify.post('/api/auth/login', async (req, reply) => {
    const { email, password } = req.body || {};
    const ip = clientIp(req);
    const userKey = `user:${String(email || '').toLowerCase()}`;
    if ((await isLockedOut(`ip:${ip}`)) || (await isLockedOut(userKey))) {
      return reply.code(429).send({ error: 'too_many', message: '尝试过于频繁，请 15 分钟后再试' });
    }
    const { rows } = await pool.query(
      `SELECT ua.principal_id, ua.password_hash, p.display_name, p.avatar_hue, p.avatar_url, p.avatar_attachment_id,
              p.account_no, p.discoverable, p.is_admin, p.suspended_until
         FROM user_accounts ua JOIN principals p ON p.id = ua.principal_id
        WHERE lower(ua.email) = lower($1)`,
      [email || ''],
    );
    const row = rows[0];
    if (!row || !(await verifyPassword(String(password || ''), row.password_hash))) {
      await noteLoginFailure(`ip:${ip}`);
      await noteLoginFailure(userKey);
      return reply.code(401).send({ error: 'bad_credentials', message: '邮箱或密码不正确' });
    }
    // 站务封禁：密码正确也不发会话（否则封了等于没封）。文案不透露"被举报/被处理"的细节。
    if (row.suspended_until && new Date(row.suspended_until).getTime() > Date.now()) {
      return reply.code(403).send({ error: 'suspended', message: '这个账号已被暂停使用，如有疑问请联系站务' });
    }
    // EMAIL_VERIFY_MODE=required 时的硬门禁：密码对了也要先验证邮箱。
    // 只在 required 下生效；默认 optional 不拦任何人（配错 SMTP 不会把全站锁死）。
    if (emailVerifySettings().mode === 'required' && !(await isEmailVerified(row.principal_id))) {
      return reply.code(403).send({
        error: 'email_unverified',
        message: '请先完成邮箱验证（点验证邮件里的链接），再登录',
      });
    }
    await clearLoginFailures(userKey);
    // 参数升级：旧 algo_version 登录成功后后台重算（目前只有 scrypt-1，留好钩子）
    if (!String(row.password_hash).startsWith('scrypt-1$')) {
      const fresh = await hashPassword(String(password));
      pool.query('UPDATE user_accounts SET password_hash=$2, algo_version=1, updated_at=now() WHERE principal_id=$1', [row.principal_id, fresh]).catch(() => {});
    }
    const { sid, expiresAt } = await createSession(Number(row.principal_id));
    reply.header('set-cookie', sessionCookie(sid, expiresAt));
    return {
      me: meView({
        id: Number(row.principal_id),
        displayName: row.display_name,
        email: String(email).toLowerCase(),
        avatarHue: row.avatar_hue,
        avatarUrl: avatarOf(row),
        accountNo: row.account_no == null ? null : Number(row.account_no),
        discoverable: row.discoverable !== false,
        isAdmin: row.is_admin === true,
      }),
    };
  });

  // --------------------------------------------------------- 邮箱验证（未配 SMTP 即关闭）
  // 口径：没配 SMTP → 503 email_verification_disabled；前端据此隐藏入口，
  // 而不是显示一个点了必失败的按钮。令牌只走邮件，接口从不回显明文。
  fastify.post('/api/auth/verify-email/send', async (req, reply) => {
    const actor = await currentUser(req);
    if (!actor) return reply.code(401).send({ error: 'unauthorized' });
    if (!actor.email) return reply.code(400).send({ error: 'no_email', message: '这个账号没有邮箱' });
    // 每个账号 60 秒 1 次（DB 侧还有每日上限），这里再加一层进程内闸挡住连点
    if (!hitRate(`verify-email:${actor.id}`, 3)) {
      return reply.code(429).send({ error: 'too_many', message: '验证邮件发得太频繁，请稍后再试' });
    }
    const out = await issueVerification({ principalId: actor.id, email: actor.email });
    if (out.ok) return { ok: true, sentTo: out.sentTo, expiresAt: out.expiresAt };
    if (out.reason === 'disabled') {
      return reply.code(503).send({ error: 'email_verification_disabled', message: '本站没有配置发信服务，邮箱验证不可用' });
    }
    if (out.reason === 'cooldown') {
      return reply.code(429).send({ error: 'too_many', message: '刚发过一封，请 1 分钟后再试' });
    }
    if (out.reason === 'daily') {
      return reply.code(429).send({ error: 'too_many', message: '今天发得太多了，请明天再试' });
    }
    return reply.code(502).send({ error: 'mail_failed', message: '验证邮件没发出去，请稍后重试' });
  });

  // 邮件里点开的链接走 GET：给人看的 HTML 结果页（不回显令牌、不带任何用户输入）
  fastify.get('/api/auth/verify-email/confirm', async (req, reply) => {
    const out = await consumeVerification(req.query?.token);
    reply.type('text/html; charset=utf-8').code(out.ok ? 200 : 400);
    const title = out.ok ? '邮箱验证成功' : '验证链接无效';
    const body = out.ok
      ? '这个邮箱已经验证完成，可以回到 AIO 继续使用。'
      : (out.reason === 'expired' ? '这个链接已经过期了，请回到 AIO 重新发送验证邮件。'
        : out.reason === 'used' ? '这个链接已经被使用过了。'
        : '这个链接不对，可能复制不完整。');
    return `<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${title}</title>
<div style="font:16px/1.6 system-ui,-apple-system,'Segoe UI',sans-serif;max-width:32rem;margin:18vh auto;padding:0 1.25rem">
<h1 style="font-size:1.25rem">${title}</h1><p style="color:#555">${body}</p></div>`;
  });

  // 程序化核销（客户端/脚本用；与 GET 同一套语义，只是回 JSON）
  fastify.post('/api/auth/verify-email/confirm', async (req, reply) => {
    const out = await consumeVerification(req.body?.token);
    if (out.ok) return { ok: true, emailVerified: true };
    const code = out.reason === 'invalid' ? 400 : out.reason === 'used' ? 409 : 410;
    const message = out.reason === 'expired' ? '验证链接已过期，请重新发送'
      : out.reason === 'used' ? '验证链接已被使用'
      : '验证链接无效';
    return reply.code(code).send({ error: `email_verify_${out.reason}`, message });
  });

  fastify.post('/api/auth/logout', async (req, reply) => {
    const sid = req.cookies?.sid;
    if (sid) await pool.query('DELETE FROM sessions WHERE token_hash = $1', [sha256(sid)]);
    reply.header('set-cookie', clearCookie());
    return { ok: true };
  });

  fastify.get('/api/me', async (req, reply) => {
    const actor = await currentUser(req);
    if (!actor) return reply.code(401).send({ error: 'unauthorized' });
    return meView(actor);
  });

  // --------------------------------------------------------- 邀请（B 方案，用户侧）
  // 这三个接口只操作**自己的**邀请码：owner_user_id 就是 actor.id，不做「传别人的 id」的入口。
  // 所有写操作都会在 core/invites.mjs 里写 invite_audit（不记明文码）。
  fastify.get('/api/invites/mine', async (req, reply) => {
    const actor = await currentUser(req);
    if (!actor) return reply.code(401).send({ error: 'unauthorized' });
    const out = await listMine(actor);
    if (!out.ok) return reply.code(inviteStatus(out.error)).send({ error: out.error, message: INVITE_ERROR_TEXT[out.error] });
    const { ok, ...view } = out;
    return view;
  });

  fastify.post('/api/invites', async (req, reply) => {
    const actor = await currentUser(req);
    if (!actor) return reply.code(401).send({ error: 'unauthorized' });
    // 发码限流：每次创建都会吊销旧码，被刷等于反复作废自己刚发出去的码
    if (!hitRate(`invite-create:${actor.id}`, 10)) {
      return reply.code(429).send({ error: 'rate_limited', message: '创建邀请码太频繁，请稍后再试' });
    }
    const out = await createInviteForUser(actor, {
      // max_uses 省略时按 1 处理：边界宽一点（前端漏传不至于 400），域内仍然严格校验 1..100
      maxUses: req.body?.max_uses ?? req.body?.maxUses ?? 1,
      expiresInDays: req.body?.expires_in_days ?? req.body?.expiresInDays,
      note: req.body?.note,
    });
    if (!out.ok) {
      return reply.code(inviteStatus(out.error)).send({
        error: out.error,
        message: INVITE_ERROR_TEXT[out.error] || '创建邀请码失败',
        quota: out.quota,
        used: out.used,
        remaining: out.remaining,
      });
    }
    // 明文码只在这里出现一次：库里只有 HMAC，之后任何接口都拿不回来（丢了就重新生成）
    return {
      invite: out.invite,
      revokedPrevious: out.revokedCodeIds,
      quota: out.quota,
      used: out.used,
      remaining: out.remaining,
    };
  });

  fastify.post('/api/invites/:id/revoke', async (req, reply) => {
    const actor = await currentUser(req);
    if (!actor) return reply.code(401).send({ error: 'unauthorized' });
    // posInt 的 min=0：非法 id 交给 core 回 not_found，而不是拿 0 去查
    const out = await revokeInvite(actor, posInt(req.params.id, 0, 0));
    if (!out.ok) return reply.code(inviteStatus(out.error)).send({ error: out.error, message: INVITE_ERROR_TEXT[out.error] });
    return { ok: true, id: out.id };
  });

  // ------------------------------------------------------------- 会话与消息
  fastify.get('/api/conversations', async (req, reply) => {
    const actor = await currentUser(req);
    if (!actor) return reply.code(401).send({ error: 'unauthorized' });
    const offset = Math.max(Number(req.query.offset) || 0, 0);
    const limit = Math.min(Math.max(Number(req.query.limit) || 50, 1), 100);
    const list = await listConversationsFor(actor, { offset, limit });
    return list.map((c) => ({
      ...c,
      members: c.members.map((m) => ({ ...m, online: m.type === 'user' ? isOnline(m.id) : undefined })),
    }));
  });

  fastify.post('/api/conversations', async (req, reply) => {
    const actor = await currentUser(req);
    if (!actor) return reply.code(401).send({ error: 'unauthorized' });
    const out = await submit({ type: 'create_group', title: req.body?.title, member_ids: req.body?.member_ids }, actor);
    if (!out.accepted) return reply.code(400).send({ error: out.reason, message: out.message });
    const offset = Math.max(Number(req.query.offset) || 0, 0);
    const limit = Math.min(Math.max(Number(req.query.limit) || 50, 1), 100);
    const list = await listConversationsFor(actor, { offset, limit });
    return { conversation: list.find((c) => c.id === out.conversation_id) || { id: out.conversation_id } };
  });

  fastify.get('/api/conversations/:id/messages', async (req, reply) => {
    const actor = await currentUser(req);
    if (!actor) return reply.code(401).send({ error: 'unauthorized' });
    const conversationId = posInt(req.params.id, 0);
    if (!conversationId) return reply.code(400).send({ error: 'invalid_id' });
    const data = await getMessages(actor, conversationId, {
      sinceSeq: posInt(req.query.since_seq, 0, 0),
      // before_seq：向上翻历史（取紧挨着游标的前一页）；与 since_seq 互斥，优先 before_seq
      beforeSeq: posInt(req.query.before_seq, 0, 0),
      limit: posInt(req.query.limit, 50, 1, 200),
    });
    if (!data) return reply.code(403).send({ error: 'forbidden', message: '你不在这个会话里' });
    return data;
  });

  // 单条消息：compact 帧回补用（只要正文，不要一整页）
  fastify.get('/api/conversations/:id/messages/:seq', async (req, reply) => {
    const actor = await currentUser(req);
    if (!actor) return reply.code(401).send({ error: 'unauthorized' });
    const conversationId = posInt(req.params.id, 0);
    const seq = posInt(req.params.seq, 0);
    if (!conversationId || !seq) return reply.code(400).send({ error: 'invalid_id' });
    const data = await getMessageBySeq(actor, conversationId, seq);
    if (!data) return reply.code(404).send({ error: 'not_found', message: '消息不存在或已不可见' });
    return data;
  });

  // 消息搜索：只搜「我可见的会话」。限流 30 次/分钟/人。
  // 游标用 before_event_id 而不是 before_seq —— seq 是每个会话各自的序号，跨会话无法比较。
  fastify.get('/api/search/messages', async (req, reply) => {
    const actor = await currentUser(req);
    if (!actor) return reply.code(401).send({ error: 'unauthorized' });
    const q = String(req.query.q ?? '').trim();
    if (!q) return { query: '', results: [], hasMore: false, nextBeforeEventId: null };
    if (!hitRate(`search:${actor.id}`, 30)) {
      return reply.code(429).send({ error: 'rate_limited', message: '搜索太频繁，请稍后再试' });
    }
    return searchMessages(actor, {
      q,
      conversationId: posInt(req.query.conversation_id, 0, 0),
      beforeEventId: posInt(req.query.before_event_id, 0, 0),
      limit: posInt(req.query.limit, 20, 1, 30),
    });
  });

  fastify.post('/api/conversations/:id/messages', async (req, reply) => {
    const actor = await currentUser(req);
    if (!actor) return reply.code(401).send({ error: 'unauthorized' });
    const out = await submit({
      type: 'send_message',
      conversation_id: Number(req.params.id),
      body: req.body?.body,
      parts: req.body?.parts,
      client_msg_id: req.body?.client_msg_id,
      reply_to_seq: req.body?.reply_to_seq,
      mentions: req.body?.mentions,
    }, actor);
    if (!out.accepted) {
      // sticker_not_visible 是授权失败（引用了别人的私有包），不是参数写错：403 而不是 400
      const code = out.reason === 'forbidden' || out.reason === 'sticker_not_visible' ? 403
        : out.reason === 'rate_limited' ? 429 : 400;
      return reply.code(code).send({ error: out.reason, message: out.message });
    }
    return out;
  });

  // 撤回：只允许撤回自己发的、且在 2 分钟内（规则在 submit 里统一判定）
  fastify.delete('/api/conversations/:id/messages/:seq', async (req, reply) => {
    const actor = await currentUser(req);
    if (!actor) return reply.code(401).send({ error: 'unauthorized' });
    const out = await submit({
      type: 'recall_message',
      conversation_id: Number(req.params.id),
      seq: Number(req.params.seq),
    }, actor);
    if (!out.accepted) {
      const code = out.reason === 'forbidden' ? 403
        : out.reason === 'gone' ? 410
          : out.reason === 'not_found' ? 404
            : 400;
      return reply.code(code).send({ error: out.reason, message: out.message });
    }
    return { ok: true, seq: Number(req.params.seq) };
  });

  fastify.post('/api/conversations/:id/read', async (req, reply) => {
    const actor = await currentUser(req);
    if (!actor) return reply.code(401).send({ error: 'unauthorized' });
    const conversationId = Number(req.params.id);
    if (!Number.isInteger(conversationId) || conversationId <= 0) return reply.code(400).send({ error: 'invalid_id' });
    const requested = Number(req.body?.seq || 0);
    const seq = Number.isFinite(requested) ? Math.max(0, Math.trunc(requested)) : 0;
    const out = await markRead(actor, conversationId, seq);
    // 不是成员就不要广播：否则能给真实成员的会话塞一条假已读回执
    if (!out) return reply.code(403).send({ error: 'forbidden', message: '你不在这个会话里' });
    if (out.lastSeq != null) publishRead({ conversationId, principalId: actor.id, seq: Math.min(seq, out.lastSeq) });
    return { ok: true };
  });

  fastify.post('/api/conversations/:id/members', async (req, reply) => {
    const actor = await currentUser(req);
    if (!actor) return reply.code(401).send({ error: 'unauthorized' });
    const out = await submit({ type: 'add_member', conversation_id: Number(req.params.id), principal_id: Number(req.body?.principal_id) }, actor);
    if (!out.accepted) {
      const code = out.reason === 'forbidden' ? 403 : out.reason === 'not_found' ? 404 : 400;
      return reply.code(code).send({ error: out.reason, message: out.message });
    }
    return { ok: true };
  });

  fastify.delete('/api/conversations/:id/members/:principalId', async (req, reply) => {
    const actor = await currentUser(req);
    if (!actor) return reply.code(401).send({ error: 'unauthorized' });
    const out = await submit({ type: 'remove_member', conversation_id: Number(req.params.id), principal_id: Number(req.params.principalId) }, actor);
    if (!out.accepted) {
      const code = out.reason === 'forbidden' ? 403 : out.reason === 'not_found' ? 404 : 400;
      return reply.code(code).send({ error: out.reason, message: out.message });
    }
    return { ok: true };
  });

  // 转让群主（只有群主；只能转给人类成员）与解散群（群主可直接解散）
  fastify.post('/api/conversations/:id/owner', async (req, reply) => {
    const actor = await currentUser(req);
    if (!actor) return reply.code(401).send({ error: 'unauthorized' });
    const out = await submit({
      type: 'transfer_owner',
      conversation_id: Number(req.params.id),
      principal_id: Number(req.body?.principal_id),
    }, actor);
    if (!out.accepted) {
      const code = out.reason === 'forbidden' ? 403 : out.reason === 'not_found' ? 404 : 400;
      return reply.code(code).send({ error: out.reason, message: out.message });
    }
    return { ok: true, ownerId: out.owner_id };
  });

  // 人类退群（与「群主解散群」是两件事：这个只影响自己）
  fastify.post('/api/conversations/:id/leave', async (req, reply) => {
    const actor = await currentUser(req);
    if (!actor) return reply.code(401).send({ error: 'unauthorized' });
    const out = await submit({ type: 'leave_conversation', conversation_id: Number(req.params.id) }, actor);
    if (!out.accepted) {
      const code = out.reason === 'forbidden' ? 403 : out.reason === 'not_found' ? 404 : 400;
      return reply.code(code).send({ error: out.reason, message: out.message });
    }
    return { ok: true, left: true };
  });

  fastify.delete('/api/conversations/:id', async (req, reply) => {
    const actor = await currentUser(req);
    if (!actor) return reply.code(401).send({ error: 'unauthorized' });
    const out = await submit({ type: 'dissolve_conversation', conversation_id: Number(req.params.id) }, actor);
    if (!out.accepted) {
      const code = out.reason === 'forbidden' ? 403 : out.reason === 'not_found' ? 404 : out.reason === 'gone' ? 410 : 400;
      return reply.code(code).send({ error: out.reason, message: out.message });
    }
    return { ok: true, dissolved: true };
  });

  // 群主设置管理员 / 取消管理员（管理员不能操作，防互相拉票）
  fastify.post('/api/conversations/:id/members/:principalId/role', async (req, reply) => {
    const actor = await currentUser(req);
    if (!actor) return reply.code(401).send({ error: 'unauthorized' });
    const out = await submit({
      type: 'set_member_role',
      conversation_id: Number(req.params.id),
      principal_id: Number(req.params.principalId),
      role: req.body?.role,
    }, actor);
    if (!out.accepted) {
      const code = out.reason === 'forbidden' || out.reason === 'not_owner' ? 403 : out.reason === 'not_found' ? 404 : 400;
      return reply.code(code).send({ error: out.reason, message: out.message });
    }
    return { ok: true, role: out.role };
  });

  fastify.post('/api/conversations/:id/reply-mode', async (req, reply) => {
    const actor = await currentUser(req);
    if (!actor) return reply.code(401).send({ error: 'unauthorized' });
    const out = await submit({
      type: 'set_reply_mode',
      conversation_id: Number(req.params.id),
      principal_id: Number(req.body?.principal_id),
      reply_mode: req.body?.reply_mode,
      allow_ai_relay: req.body?.allow_ai_relay,
    }, actor);
    if (!out.accepted) return reply.code(400).send({ error: out.reason, message: out.message });
    return { ok: true, activity: out.activity, allow_ai_relay: out.allow_ai_relay };
  });

  // ------------------------------------------------- 推荐群聊（发现 / 入群审批）
  // 拒绝码映射只做 HTTP 语义，业务判断都在 src/core/groups.mjs：
  // forbidden→403、not_found→404、invalid_schema→400、already_member 是 200 幂等（在 core 里当成功返回）
  const joinFailCode = (reason) => (reason === 'forbidden' ? 403
    : reason === 'not_found' ? 404
      : reason === 'rate_limited' ? 429
        : reason === 'internal' ? 500
          : 400);

  // 公开推荐群目录：登录即可，不需要是成员
  fastify.get('/api/groups/discover', async (req, reply) => {
    const actor = await currentUser(req);
    if (!actor) return reply.code(401).send({ error: 'unauthorized' });
    return discoverGroups(actor, {
      q: req.query.q,
      beforeId: posInt(req.query.before_id, 0, 0),
      limit: posInt(req.query.limit, 20, 1, 20),
    });
  });

  // 群主/管理员改公开推荐设置（PATCH 语义：只改传了值的字段）
  fastify.patch('/api/conversations/:id/public', async (req, reply) => {
    const actor = await currentUser(req);
    if (!actor) return reply.code(401).send({ error: 'unauthorized' });
    const conversationId = posInt(req.params.id, 0);
    if (!conversationId) return reply.code(400).send({ error: 'invalid_id' });
    const out = await updateGroupPublic(actor, {
      conversationId,
      discoverable: req.body?.discoverable,
      joinMode: req.body?.join_mode,
      description: req.body?.description,
    });
    if (!out.ok) return reply.code(joinFailCode(out.reason)).send({ error: out.reason, message: out.message });
    return out;
  });

  // 群公告（群规）：只有群主/管理员；纯文本 ≤2000 字；走 submit（[C2]）留 GroupAnnouncementChanged 事件。
  // 返回的字段给前端与 AI 共用：announcement / announcementUpdatedAt / changed。
  fastify.patch('/api/conversations/:id/announcement', async (req, reply) => {
    const actor = await currentUser(req);
    if (!actor) return reply.code(401).send({ error: 'unauthorized' });
    const conversationId = posInt(req.params.id, 0);
    if (!conversationId) return reply.code(400).send({ error: 'invalid_id' });
    const out = await submit({
      type: 'set_group_announcement',
      conversation_id: conversationId,
      announcement: req.body?.announcement,
    }, actor);
    if (!out.accepted) return reply.code(joinFailCode(out.reason)).send({ error: out.reason, message: out.message });
    return {
      conversationId,
      announcement: out.announcement,
      announcementUpdatedAt: out.announcement_updated_at || null,
      changed: out.changed === true,
    };
  });

  // 申请入群：open 直接进，approval 落 pending（已是成员 200 幂等）
  fastify.post('/api/conversations/:id/join', async (req, reply) => {
    const actor = await currentUser(req);
    if (!actor) return reply.code(401).send({ error: 'unauthorized' });
    const conversationId = posInt(req.params.id, 0);
    if (!conversationId) return reply.code(400).send({ error: 'invalid_id' });
    const out = await requestJoin(actor, conversationId);
    if (!out.ok) return reply.code(joinFailCode(out.reason)).send({ error: out.reason, message: out.message });
    return out;
  });

  // 待审批列表（群主/管理员）；core 用 null 表示没权限，和 getMembers 的约定一致
  fastify.get('/api/conversations/:id/join-requests', async (req, reply) => {
    const actor = await currentUser(req);
    if (!actor) return reply.code(401).send({ error: 'unauthorized' });
    const conversationId = posInt(req.params.id, 0);
    if (!conversationId) return reply.code(400).send({ error: 'invalid_id' });
    const requests = await listJoinRequests(actor, conversationId);
    if (!requests) return reply.code(403).send({ error: 'forbidden', message: '只有群主或管理员可以查看入群申请' });
    return { requests };
  });

  // 审批：body { accept: boolean }
  fastify.post('/api/conversations/:id/join-requests/:principalId', async (req, reply) => {
    const actor = await currentUser(req);
    if (!actor) return reply.code(401).send({ error: 'unauthorized' });
    const conversationId = posInt(req.params.id, 0);
    const principalId = posInt(req.params.principalId, 0);
    if (!conversationId || !principalId) return reply.code(400).send({ error: 'invalid_id' });
    const out = await decideJoinRequest(actor, {
      conversationId,
      principalId,
      accept: req.body?.accept,
    });
    if (!out.ok) return reply.code(joinFailCode(out.reason)).send({ error: out.reason, message: out.message });
    return out;
  });

  // ------------------------------------------------------------------ 个人空间
  fastify.get('/api/feeds', async (req, reply) => {
    const actor = await currentUser(req);
    if (!actor) return reply.code(401).send({ error: 'unauthorized' });
    const { listFeeds } = await import('../core/feed.mjs');
    return listFeeds(actor, { beforeId: Number(req.query.before_id || 0), limit: Number(req.query.limit || 20) });
  });

  fastify.post('/api/feeds', async (req, reply) => {
    const actor = await currentUser(req);
    if (!actor) return reply.code(401).send({ error: 'unauthorized' });
    const out = await submit({
      type: 'publish_feed',
      body: req.body?.body,
      visibility: req.body?.visibility,
      client_msg_id: req.body?.client_msg_id,
    }, actor);
    if (!out.accepted) return reply.code(400).send({ error: out.reason, message: out.message });
    return out;
  });

  fastify.get('/api/feeds/:id/comments', async (req, reply) => {
    const actor = await currentUser(req);
    if (!actor) return reply.code(401).send({ error: 'unauthorized' });
    const { listComments } = await import('../core/feed.mjs');
    const out = await listComments(actor, Number(req.params.id));
    if (!out) return reply.code(404).send({ error: 'not_found', message: '说说不存在或无权查看' });
    return out;
  });

  fastify.post('/api/feeds/:id/comments', async (req, reply) => {
    const actor = await currentUser(req);
    if (!actor) return reply.code(401).send({ error: 'unauthorized' });
    const out = await submit({
      type: 'add_comment',
      feed_id: Number(req.params.id),
      body: req.body?.body,
      client_msg_id: req.body?.client_msg_id,
    }, actor);
    if (!out.accepted) return reply.code(400).send({ error: out.reason, message: out.message });
    return out;
  });

  fastify.post('/api/feeds/:id/like', async (req, reply) => {
    const actor = await currentUser(req);
    if (!actor) return reply.code(401).send({ error: 'unauthorized' });
    const out = await submit({ type: 'add_like', feed_id: Number(req.params.id) }, actor);
    if (!out.accepted) return reply.code(400).send({ error: out.reason, message: out.message });
    return out;
  });

  fastify.delete('/api/feeds/:id/like', async (req, reply) => {
    const actor = await currentUser(req);
    if (!actor) return reply.code(401).send({ error: 'unauthorized' });
    const out = await submit({ type: 'remove_like', feed_id: Number(req.params.id) }, actor);
    if (!out.accepted) return reply.code(400).send({ error: out.reason, message: out.message });
    return out;
  });

  // ------------------------------------------------------------- 目录与 Agent
  fastify.get('/api/directory', async (req, reply) => {
    const actor = await currentUser(req);
    if (!actor) return reply.code(401).send({ error: 'unauthorized' });
    const q = String(req.query.q || '').trim();
    // 按号码查人最容易被人遍历：每分钟 10 次；按昵称搜不受此限
    if (/^\d{4,12}$/.test(q) && !searchAllowed(actor.id)) {
      return reply.code(429).send({ error: 'too_many_searches', message: '搜索太频繁，请一分钟后再试' });
    }
    return directoryFor(actor, q);
  });

  // 关掉「别人能通过号码找到我」
  fastify.post('/api/me/discoverable', async (req, reply) => {
    const actor = await currentUser(req);
    if (!actor) return reply.code(401).send({ error: 'unauthorized' });
    const on = req.body?.discoverable !== false;
    await pool.query('UPDATE principals SET discoverable = $2 WHERE id = $1', [actor.id, on]);
    return { ok: true, discoverable: on };
  });

  // ---------------------------------------------------------------- 图片头像
  // 规格（docs/头像与表情包与可信度.md §1）：成品 512×512、原图 ≤4MB、只收 JPG/PNG/WebP。
  // 人类走「先传附件再绑」；Agent 没有上传通道，只能给 https 外链（二进制不进本站）。
  const AVATAR_MIMES = new Set(['image/jpeg', 'image/png', 'image/webp']);
  const AVATAR_MAX_BYTES = 4 * 1024 * 1024;
  const AVATAR_SIDE = 512;

  function httpsUrlProblem(raw) {
    if (typeof raw !== 'string') return 'url 必须是字符串';
    const url = raw.trim();
    if (!url) return 'url 不能为空';
    if (url.length > 2048) return 'url 最长 2048 字符';
    if (!/^https:\/\//i.test(url)) return 'url 必须以 https:// 开头';
    if (/\s/.test(url)) return 'url 不能包含空格或换行';
    try {
      const parsed = new URL(url);
      if (parsed.protocol !== 'https:') return 'url 只能是 https:// 外链';
      if (parsed.username || parsed.password) return 'url 不允许内嵌账号密码';
    } catch {
      return 'url 不是合法的地址';
    }
    return null;
  }

  fastify.post('/api/me/avatar', async (req, reply) => {
    const actor = await currentUser(req);
    if (!actor) return reply.code(401).send({ error: 'unauthorized' });
    const attachmentId = Number(req.body?.attachment_id);
    if (!Number.isInteger(attachmentId) || attachmentId <= 0) {
      return reply.code(400).send({ error: 'invalid_schema', message: '需要 attachment_id（先上传图片）' });
    }
    const { rows } = await pool.query(
      "SELECT id, kind, mime, bytes, scan_state FROM attachments WHERE id=$1 AND uploader_id=$2 AND deleted_at IS NULL",
      [attachmentId, actor.id],
    );
    const att = rows[0];
    if (!att) return reply.code(400).send({ error: 'invalid_attachment', message: '只能选你自己刚上传的图片' });
    if (att.kind !== 'image' || !AVATAR_MIMES.has(String(att.mime).toLowerCase())) {
      return reply.code(400).send({ error: 'invalid_type', message: '头像只支持 JPG / PNG / WebP' });
    }
    if (Number(att.bytes) > AVATAR_MAX_BYTES) {
      return reply.code(400).send({ error: 'too_large', message: '头像原图最大 4MB' });
    }
    if (att.scan_state === 'blocked') {
      return reply.code(400).send({ error: 'blocked', message: '这张图片未通过内容审核' });
    }
    // 客户端负责裁成 512×512；带了尺寸就顺手校验一下，防止绕过
    const w = Number(req.body?.width);
    const h = Number(req.body?.height);
    if (Number.isFinite(w) && Number.isFinite(h) && w > 0 && h > 0) {
      const ratio = w / h;
      if (ratio < 0.98 || ratio > 1.02) {
        return reply.code(400).send({ error: 'not_square', message: `头像必须是正方形（成品建议 ${AVATAR_SIDE}×${AVATAR_SIDE}）` });
      }
    }
    await pool.query('UPDATE principals SET avatar_attachment_id=$2, avatar_url=NULL WHERE id=$1', [actor.id, attachmentId]);
    const fresh = await currentUser(req);
    return { ok: true, me: meView(fresh || actor) };
  });

  fastify.delete('/api/me/avatar', async (req, reply) => {
    const actor = await currentUser(req);
    if (!actor) return reply.code(401).send({ error: 'unauthorized' });
    await pool.query('UPDATE principals SET avatar_attachment_id=NULL, avatar_url=NULL WHERE id=$1', [actor.id]);
    const fresh = await currentUser(req);
    return { ok: true, me: meView(fresh || actor) };
  });

  // 主人可以给自己 AI 设/清外链头像（等价于 AI 自己调 MCP set_avatar）
  fastify.post('/api/agents/:id/avatar', async (req, reply) => {
    const actor = await currentUser(req);
    if (!actor) return reply.code(401).send({ error: 'unauthorized' });
    const agentId = Number(req.params.id);
    const { rows } = await pool.query('SELECT principal_id FROM agents WHERE principal_id=$1 AND owner_user_id=$2', [agentId, actor.id]);
    if (!rows[0]) return reply.code(404).send({ error: 'not_found', message: '这不是你的 AI' });
    const problem = httpsUrlProblem(req.body?.url);
    if (problem) return reply.code(400).send({ error: 'invalid_url', message: problem });
    const url = String(req.body.url).trim();
    await pool.query('UPDATE principals SET avatar_url=$2, avatar_attachment_id=NULL WHERE id=$1', [agentId, url]);
    return { ok: true, agent: { id: agentId, avatarUrl: url } };
  });

  fastify.delete('/api/agents/:id/avatar', async (req, reply) => {
    const actor = await currentUser(req);
    if (!actor) return reply.code(401).send({ error: 'unauthorized' });
    const agentId = Number(req.params.id);
    const { rows } = await pool.query('SELECT principal_id FROM agents WHERE principal_id=$1 AND owner_user_id=$2', [agentId, actor.id]);
    if (!rows[0]) return reply.code(404).send({ error: 'not_found', message: '这不是你的 AI' });
    await pool.query('UPDATE principals SET avatar_url=NULL, avatar_attachment_id=NULL WHERE id=$1', [agentId]);
    return { ok: true, agent: { id: agentId, avatarUrl: null } };
  });

  // Agent 用「号码 + 密码」换 token（给只能填账号密码的 MCP 客户端用）
  fastify.post('/api/agents/login', async (req, reply) => {
    const accountNo = Number(req.body?.account_no);
    const password = String(req.body?.password || '');
    if (!Number.isInteger(accountNo) || password.length < 6) {
      return reply.code(400).send({ error: 'invalid_schema', message: '需要 account_no 与 password' });
    }
    const { rows } = await pool.query(
      `SELECT a.principal_id, a.status, a.password_hash, a.login_enabled, p.display_name
         FROM agents a JOIN principals p ON p.id = a.principal_id
        WHERE p.account_no = $1`,
      [accountNo],
    );
    // 和人类登录同一套锁定：否则可以无限撞 agent 密码
    if (await isLockedOut(`agent:${accountNo}`)) {
      return reply.code(429).send({ error: 'too_many', message: '尝试过于频繁，请 15 分钟后再试' });
    }
    const row = rows[0];
    // 统一错误文案与状态码：paused / 吊销 / 不存在都回 401，避免探测「这个号码是不是 Agent」
    if (!row || !row.login_enabled || !row.password_hash || row.status !== 'active') {
      return reply.code(401).send({ error: 'bad_credentials', message: '号码或密码不正确' });
    }
    if (!(await verifyPassword(password, row.password_hash))) {
      await noteLoginFailure(`agent:${accountNo}`);
      return reply.code(401).send({ error: 'bad_credentials', message: '号码或密码不正确' });
    }
    await clearLoginFailures(`agent:${accountNo}`);
    const token = `qqa_${crypto.randomBytes(24).toString('hex')}`;
    const hash = crypto.createHash('sha256').update(token).digest('hex');
    await pool.query('INSERT INTO agent_tokens (agent_id, token_hash, label) VALUES ($1,$2,$3)', [row.principal_id, hash, 'account-login']);
    return { token, agent: { id: Number(row.principal_id), displayName: row.display_name, accountNo } };
  });

  // ============================================================ 好友
  fastify.get('/api/friends', async (req, reply) => {
    const actor = await currentUser(req);
    if (!actor) return reply.code(401).send({ error: 'unauthorized' });
    const offset = Math.max(Number(req.query.offset) || 0, 0);
    const limit = Math.min(Math.max(Number(req.query.limit) || 200, 1), 500);
    const friends = await listFriends(actor, { limit, offset });
    return {
      friends,
      requests: await listFriendRequests(actor),
      has_more: friends.length >= limit,
      ...(limit > 0 && friends.length >= limit ? { hint: '好友很多：用号码/名字搜索，或加载更多' } : {}),
    };
  });

  // 加好友：按号码，建立 pending；对方接受后才算好友
  // 屏蔽 / 拉黑（外部审查 Q12）：单向写、双向生效。走 submit 留 BlockCreated/BlockRemoved 事件。
  fastify.get('/api/blocks', async (req, reply) => {
    const actor = await currentUser(req);
    if (!actor) return reply.code(401).send({ error: 'unauthorized' });
    const { rows } = await pool.query(
      `SELECT b.blocked_id, b.created_at, p.display_name, p.type
         FROM principal_blocks b JOIN principals p ON p.id = b.blocked_id
        WHERE b.blocker_id = $1 AND p.hidden = false
        ORDER BY b.created_at DESC`,
      [actor.id],
    );
    return {
      blocks: rows.map((r) => ({
        principal_id: Number(r.blocked_id),
        display_name: r.display_name,
        type: r.type,
        created_at: r.created_at,
      })),
    };
  });

  fastify.post('/api/blocks/:principalId', async (req, reply) => {
    const actor = await currentUser(req);
    if (!actor) return reply.code(401).send({ error: 'unauthorized' });
    const out = await submit({ type: 'block_principal', principal_id: Number(req.params.principalId) }, actor);
    if (!out.accepted) {
      const code = out.reason === 'not_found' ? 404 : out.reason === 'rate_limited' ? 429 : 400;
      return reply.code(code).send({ error: out.reason, message: out.message });
    }
    return out;
  });

  fastify.delete('/api/blocks/:principalId', async (req, reply) => {
    const actor = await currentUser(req);
    if (!actor) return reply.code(401).send({ error: 'unauthorized' });
    const out = await submit({ type: 'unblock_principal', principal_id: Number(req.params.principalId) }, actor);
    if (!out.accepted) {
      const code = out.reason === 'not_found' ? 404 : out.reason === 'rate_limited' ? 429 : 400;
      return reply.code(code).send({ error: out.reason, message: out.message });
    }
    return out;
  });

  fastify.post('/api/friends/request', async (req, reply) => {
    const actor = await currentUser(req);
    if (!actor) return reply.code(401).send({ error: 'unauthorized' });
    // [M2] 封禁闭环：被封禁的人不能加好友（以前只有发消息挡封禁）
    const banned = assertNotSuspended(actor, '加好友');
    if (banned) return reply.code(403).send({ error: banned.reason, message: banned.message });
    // [M4] 按号码加人是唯一「知道号码就能无限试」的入口：10 次/小时/发起人。
    // 放在查库之前——顺便把「这个号码存在吗」的枚举也限进去（否则仍可无限探测）。
    if (!hitRateHour(`friend-req-user:${actor.id}`, 10)) {
      return reply.code(429).send({ error: 'rate_limited', message: '好友请求太频繁（每小时最多 10 次）' });
    }
    const accountNo = Number(req.body?.account_no);
    if (!Number.isInteger(accountNo) || accountNo <= 0) {
      return reply.code(400).send({ error: 'invalid_schema', message: '需要对方号码' });
    }
    const { rows } = await pool.query(
      'SELECT id, type, display_name, discoverable FROM principals WHERE account_no = $1 AND hidden = false',
      [accountNo],
    );
    const target = rows[0];
    if (!target) return reply.code(404).send({ error: 'not_found', message: '没有这个号码' });
    if (Number(target.id) === actor.id) return reply.code(400).send({ error: 'self', message: '不能加自己' });
    // 屏蔽（Q12）：任一方拉黑过对方就拒绝——否则「按号码加好友」是绕过屏蔽的骚扰入口
    const { rows: blockedPair } = await pool.query(
      `SELECT 1 FROM principal_blocks
        WHERE (blocker_id = $1 AND blocked_id = $2) OR (blocker_id = $2 AND blocked_id = $1) LIMIT 1`,
      [actor.id, Number(target.id)],
    );
    if (blockedPair[0]) return reply.code(403).send({ error: 'blocked', message: '你们之间存在屏蔽关系，无法加好友' });
    if (target.discoverable === false) {
      return reply.code(403).send({ error: 'not_discoverable', message: '对方关闭了被搜索' });
    }
    // 已经关系就直说，别重复插
    const { rows: exist } = await pool.query(
      `SELECT status FROM friendships WHERE (user_id=$1 AND friend_id=$2) OR (user_id=$2 AND friend_id=$1)
        ORDER BY (status='accepted') DESC LIMIT 1`,
      [actor.id, Number(target.id)],
    );
    if (exist[0]?.status === 'accepted') return { ok: true, status: 'accepted', already: true };
    if (exist[0]?.status === 'pending') return { ok: true, status: 'pending', already: true };
    await pool.query(
      `INSERT INTO friendships (user_id, friend_id, status) VALUES ($1,$2,'pending')
       ON CONFLICT (user_id, friend_id) DO UPDATE SET status='pending'`,
      [actor.id, Number(target.id)],
    );
    return { ok: true, status: 'pending', target: { id: Number(target.id), displayName: target.display_name } };
  });

  fastify.post('/api/friends/accept', async (req, reply) => {
    const actor = await currentUser(req);
    if (!actor) return reply.code(401).send({ error: 'unauthorized' });
    const fromId = Number(req.body?.principal_id);
    if (!Number.isInteger(fromId) || fromId <= 0) return reply.code(400).send({ error: 'invalid_schema' });
    const { rowCount } = await pool.query(
      "UPDATE friendships SET status='accepted' WHERE user_id=$1 AND friend_id=$2 AND status='pending'",
      [fromId, actor.id],
    );
    if (!rowCount) return reply.code(404).send({ error: 'not_found', message: '没有这条请求' });
    // 双向都记一条 accepted，方便两边查询
    await pool.query(
      `INSERT INTO friendships (user_id, friend_id, status) VALUES ($1,$2,'accepted')
       ON CONFLICT (user_id, friend_id) DO UPDATE SET status='accepted'`,
      [actor.id, fromId],
    );
    return { ok: true };
  });

  fastify.post('/api/friends/remove', async (req, reply) => {
    const actor = await currentUser(req);
    if (!actor) return reply.code(401).send({ error: 'unauthorized' });
    const otherId = Number(req.body?.principal_id);
    if (!Number.isInteger(otherId) || otherId <= 0) return reply.code(400).send({ error: 'invalid_schema' });
    await pool.query(
      'DELETE FROM friendships WHERE (user_id=$1 AND friend_id=$2) OR (user_id=$2 AND friend_id=$1)',
      [actor.id, otherId],
    );
    return { ok: true };
  });

  // 成员主页（人和 AI 一样）：共同群 + 最近发言
  fastify.get('/api/principals/:id/profile', async (req, reply) => {
    const actor = await currentUser(req);
    if (!actor) return reply.code(401).send({ error: 'unauthorized' });
    const principalId = posInt(req.params.id, 0);
    if (!principalId) return reply.code(400).send({ error: 'invalid_id' });
    const profile = await principalProfile(actor, principalId);
    if (!profile) return reply.code(404).send({ error: 'not_found' });
    return profile;
  });

  fastify.get('/api/agents', async (req, reply) => {
    const actor = await currentUser(req);
    if (!actor) return reply.code(401).send({ error: 'unauthorized' });
    return myAgents(actor);
  });

  fastify.post('/api/agents', async (req, reply) => {
    const actor = await currentUser(req);
    if (!actor) return reply.code(401).send({ error: 'unauthorized' });
    const name = String(req.body?.display_name || '').trim();
    if (name.length < 1 || name.length > 20) return reply.code(400).send({ error: 'invalid_name', message: 'AI 名字 1..20 字' });
    const username = `ai_${crypto.randomBytes(4).toString('hex')}`;
    const hue = 265; // AI 统一紫色系，UI 上更好辨认
    const token = `qqa_${randomToken(24)}`;

    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const p = await client.query(
        `INSERT INTO principals (type, username, display_name, avatar_hue) VALUES ('agent',$1,$2,$3) RETURNING id, account_no`,
        [username, name, hue],
      );
      const agentId = Number(p.rows[0].id);
      const accountNo = p.rows[0].account_no == null ? null : Number(p.rows[0].account_no);
      // Agent 也能「号码 + 密码」登录：密码只用于换 token，不直接调 MCP
      const loginPassword = `qpa-${crypto.randomBytes(6).toString('hex')}`;
      await client.query(
        // 人设/性格由使用者在自己 Agent 客户端里调；AIO 不提供「在这里改性格」的入口。
        'INSERT INTO agents (principal_id, owner_user_id, password_hash, login_enabled) VALUES ($1,$2,$3,true)',
        [agentId, actor.id, await hashPassword(loginPassword)],
      );
      // 审计：创建 AI 属于权限变更，必须进事件日志（不能只写读模型表）
      await client.query(
        `INSERT INTO events (aggregate_type, aggregate_id, type, actor_id, actor_type, payload)
         VALUES ('principal', $1, 'AgentCreated', $2, 'user', $3::jsonb)`,
        [agentId, actor.id, JSON.stringify({ agent_id: agentId, display_name: name })],
      );
      await client.query(
        'INSERT INTO agent_tokens (agent_id, token_hash, label) VALUES ($1,$2,$3)',
        [agentId, sha256(token), 'default'],
      );
      await client.query('COMMIT');
      return {
        agent: { id: agentId, displayName: name, accountNo },
        token,
        // 只在这里返回一次；丢了就只能重新生成
        login: { accountNo, password: loginPassword },
      };
    } catch (err) {
      try { await client.query('ROLLBACK'); } catch { /* ignore */ }
      fastify.log.error({ err: err.message }, 'create agent failed');
      return reply.code(500).send({ error: 'internal', message: '创建 AI 失败' });
    } finally {
      client.release();
    }
  });

  /**
   * AI 自助注册：Agent 自己拿邀请码注册一个 AI 身份，返回 token（只此一次）。
   * 默认关闭（config.agentSignup 都为空 → 404），只有显式配置 invite + ownerAccount 才开。
   * 用途：使用者开新窗口时，让新 Agent 自己完成「注册 + 拿 token」，不用人手抄。
   */
  fastify.post('/api/agents/signup', async (req, reply) => {
    const invite = String(req.body?.invite_code || '');
    const configured = config.agentSignup?.invite;
    if (!configured || !config.agentSignup?.ownerAccount) {
      return reply.code(404).send({ error: 'not_enabled', message: '自助注册未开启' });
    }
    if (!hitRate(`agent-signup:${req.ip}`, 5)) {
      return reply.code(429).send({ error: 'rate_limited', message: '注册太频繁，稍后再试' });
    }
    if (invite !== configured) return reply.code(403).send({ error: 'invalid_invite', message: '邀请码不对' });
    const name = String(req.body?.display_name || '').trim();
    if (name.length < 1 || name.length > 40) {
      return reply.code(400).send({ error: 'invalid_schema', message: 'display_name 必须是 1..40 字符' });
    }
    if (name.includes('�')) {
      return reply.code(400).send({
        error: 'invalid_encoding',
        message: 'display_name 含非法 UTF-8 字符（命令行 argv 编码损坏）；请用 UTF-8 文件发送 JSON',
      });
    }
    const { rows: owners } = await pool.query(
      "SELECT p.id FROM principals p JOIN user_accounts u ON u.principal_id = p.id WHERE p.account_no = $1 AND p.type = 'user' AND p.hidden = false",
      [config.agentSignup.ownerAccount],
    );
    const owner = owners[0];
    if (!owner) return reply.code(503).send({ error: 'owner_missing', message: '宿主账号不存在，联系管理员' });

    const password = String(req.body?.password || '') || crypto.randomBytes(9).toString('base64url');
    if (password.length < 8) return reply.code(400).send({ error: 'invalid_schema', message: 'password 至少 8 位' });
    let accountNo = Math.floor(10_000_000 + Math.random() * 90_000_000);
    const token = `qqa_${crypto.randomBytes(24).toString('hex')}`;
    const tokenHash = crypto.createHash('sha256').update(token).digest('hex');

    try {
      const created = await withTx(async (client) => {
        const username = `agent_${crypto.randomBytes(6).toString('hex')}`;
        const p1 = await client.query(
          `INSERT INTO principals (type, username, display_name, account_no, avatar_hue, discoverable)
           VALUES ('agent', $1, $2, $3, $4, true) RETURNING id, account_no`,
          [username, name, accountNo, 200 + Math.floor(Math.random() * 60)],
        );
        const agentId = Number(p1.rows[0].id);
        // 库里可能用默认值/触发器生成号码：以最终落库的为准（否则返回的号码搜不到人）
        accountNo = Number(p1.rows[0].account_no);
        // 自助注册 = 宿主自己发的邀请码，视为已授权：默认允许主动私聊
        await client.query(
          `INSERT INTO agents (principal_id, owner_user_id, password_hash, login_enabled, can_initiate_dm)
           VALUES ($1,$2,$3,true,true)`,
          [agentId, Number(owner.id), await hashPassword(password)],
        );
        await client.query('INSERT INTO agent_tokens (agent_id, token_hash, label) VALUES ($1,$2,$3)', [
          agentId, tokenHash, 'self-signup',
        ]);
        await client.query(
          `INSERT INTO events (aggregate_type, aggregate_id, type, actor_id, actor_type, payload)
           VALUES ('principal',$1,'AgentCreated',$2,'agent',$3::jsonb)`,
          [agentId, agentId, JSON.stringify({ display_name: name, self_signup: true })],
        );
        return agentId;
      });
      return {
        agent: { id: created, displayName: name, accountNo },
        token,
        login: { accountNo, password },
        hint: 'token 只返回这一次；换窗口可以复用，或 POST /api/agents/login 用号码+密码换新 token',
      };
    } catch (err) {
      console.error('[routes] agent signup failed', err.message);
      return reply.code(500).send({ error: 'internal', message: '注册失败' });
    }
  });

  /** 群主/管理员：读取当前公开设置（给群设置弹窗回填） */
  fastify.get('/api/conversations/:id/public', async (req, reply) => {
    const actor = await currentUser(req);
    if (!actor) return reply.code(401).send({ error: 'unauthorized' });
    const conversationId = posInt(req.params.id, 0);
    const { rows: mine } = await pool.query(
      'SELECT role FROM conversation_members WHERE conversation_id = $1 AND principal_id = $2',
      [conversationId, actor.id],
    );
    if (!mine[0]) return reply.code(403).send({ error: 'forbidden', message: '你不在这个会话里' });
    if (!['owner', 'admin'].includes(mine[0].role)) {
      return reply.code(403).send({ error: 'forbidden', message: '只有群主/管理员可以查看' });
    }
    const { rows } = await pool.query(
      'SELECT discoverable, join_mode, description FROM conversations WHERE id = $1 AND dissolved_at IS NULL',
      [conversationId],
    );
    if (!rows[0]) return reply.code(404).send({ error: 'not_found' });
    return {
      discoverable: Boolean(rows[0].discoverable),
      joinMode: rows[0].join_mode,
      description: rows[0].description || '',
    };
  });

  /** 人类发起 1:1 私聊（好友 / 同群 / 公开可发现的 AI）。已有会话则复用。 */
  fastify.post('/api/conversations/dm', async (req, reply) => {
    const actor = await currentUser(req);
    if (!actor) return reply.code(401).send({ error: 'unauthorized' });
    const out = await openDmForUser(actor, { principalId: Number(req.body?.principal_id) });
    if (out?.reason) {
      const code = out.reason === 'forbidden' ? 403 : out.reason === 'not_found' ? 404 : out.reason === 'rate_limited' ? 429 : 400;
      return reply.code(code).send({ error: out.reason, message: out.message });
    }
    return out;
  });

  // ---------------------------------------------------------------- 接入钥匙（token 管理）
  // 一个窗口一把钥匙是正常用法：列出每把的最后使用时间，丢了只废那一把，不影响其它窗口。
  fastify.get('/api/agents/:id/tokens', async (req, reply) => {
    const actor = await currentUser(req);
    if (!actor) return reply.code(401).send({ error: 'unauthorized' });
    const agentId = posInt(req.params.id, 0);
    const { rows: owned } = await pool.query(
      'SELECT 1 FROM agents WHERE principal_id = $1 AND owner_user_id = $2',
      [agentId, actor.id],
    );
    if (!owned[0]) return reply.code(404).send({ error: 'not_found' });
    const { rows } = await pool.query(
      `SELECT id, label, created_at, last_used_at, revoked_at
         FROM agent_tokens WHERE agent_id = $1 ORDER BY (revoked_at IS NULL) DESC, id DESC LIMIT 50`,
      [agentId],
    );
    return {
      tokens: rows.map((r) => ({
        id: Number(r.id),
        label: r.label,
        createdAt: r.created_at,
        lastUsedAt: r.last_used_at,
        revokedAt: r.revoked_at,
        active: r.revoked_at == null,
      })),
    };
  });

  fastify.delete('/api/agents/:id/tokens/:tokenId', async (req, reply) => {
    const actor = await currentUser(req);
    if (!actor) return reply.code(401).send({ error: 'unauthorized' });
    const agentId = posInt(req.params.id, 0);
    const tokenId = posInt(req.params.tokenId, 0);
    const { rows: owned } = await pool.query(
      'SELECT 1 FROM agents WHERE principal_id = $1 AND owner_user_id = $2',
      [agentId, actor.id],
    );
    if (!owned[0]) return reply.code(404).send({ error: 'not_found' });
    const { rowCount } = await pool.query(
      'UPDATE agent_tokens SET revoked_at = now() WHERE id = $1 AND agent_id = $2 AND revoked_at IS NULL',
      [tokenId, agentId],
    );
    if (!rowCount) return reply.code(404).send({ error: 'not_found', message: '没有这把钥匙（可能已吊销）' });
    return { ok: true, revokedTokenId: tokenId };
  });

  /** 主人开关：允不允许这只 AI 主动私聊好友（私聊主人永远允许） */
  fastify.patch('/api/agents/:id/dm', async (req, reply) => {
    const actor = await currentUser(req);
    if (!actor) return reply.code(401).send({ error: 'unauthorized' });
    const allow = req.body?.allow === true;
    const { rowCount } = await pool.query(
      'UPDATE agents SET can_initiate_dm = $3 WHERE principal_id = $1 AND owner_user_id = $2',
      [Number(req.params.id), actor.id, allow],
    );
    if (!rowCount) return reply.code(404).send({ error: 'not_found' });
    return { ok: true, canInitiateDm: allow };
  });

  /** 主人开关：允不允许这只 AI 自己退群（默认关，P2 的产品决定；与 can_initiate_dm 同一套 API 范式） */
  fastify.patch('/api/agents/:id/leave', async (req, reply) => {
    const actor = await currentUser(req);
    if (!actor) return reply.code(401).send({ error: 'unauthorized' });
    const allow = req.body?.allow === true;
    const { rowCount } = await pool.query(
      'UPDATE agents SET can_leave_group = $3 WHERE principal_id = $1 AND owner_user_id = $2',
      [Number(req.params.id), actor.id, allow],
    );
    if (!rowCount) return reply.code(404).send({ error: 'not_found' });
    return { ok: true, canLeaveGroup: allow };
  });

  /** 主人开关：允不允许这只 AI 进入 3D 世界（world_* MCP 工具面的唯一启用开关；迁移 031，默认关。
   *  契约见 CONTRACT.md §11；列不存在（迁移未跑）时返回 503，前端可提示「先执行迁移」） */
  fastify.patch('/api/agents/:id/world', async (req, reply) => {
    const actor = await currentUser(req);
    if (!actor) return reply.code(401).send({ error: 'unauthorized' });
    const allow = req.body?.allow === true;
    try {
      const { rowCount } = await pool.query(
        'UPDATE agents SET can_enter_world = $3 WHERE principal_id = $1 AND owner_user_id = $2',
        [Number(req.params.id), actor.id, allow],
      );
      if (!rowCount) return reply.code(404).send({ error: 'not_found' });
      return { ok: true, canEnterWorld: allow };
    } catch (err) {
      if (err?.code === '42703') {
        return reply.code(503).send({ error: 'migration_required', message: '迁移 031_world_agent_flag.sql 未执行' });
      }
      throw err;
    }
  });

  // ---------------------------------------------------------------- 3D 空间（世界模块 · 人类入口）
  // 世界是独立进程（GPL fork），AIO 只负责：① 告诉前端「本实例开没开世界」；② 给人类签发一次性入场票据。
  // 为什么用票据而不是让 world 自己登录：AIO 已有账号体系，world 侧默认是匿名入场（无 authToken 就建 Anonymous）；
  // 票据 = HMAC(payload) 的短 TTL 串，world 侧 /api/aio-login 校验后建/找用户并回自己的 JWT，两边不共享会话。
  const worldConfig = () => ({
    publicUrl: String(process.env.WORLD_PUBLIC_URL || '').replace(/\/+$/, ''),
    secret: String(process.env.WORLD_TICKET_SECRET || process.env.SESSION_SECRET || ''),
  });

  fastify.get('/api/world/status', async (req, reply) => {
    const actor = await currentUser(req);
    if (!actor) return reply.code(401).send({ error: 'unauthorized' });
    const { publicUrl, secret } = worldConfig();
    return {
      // 只有「公网入口 + 票据密钥」都配了才算开启：否则前端不该显示「进入空间」按钮
      enabled: Boolean(publicUrl && secret),
      url: publicUrl || null,
    };
  });

  fastify.post('/api/world/ticket', async (req, reply) => {
    const actor = await currentUser(req);
    if (!actor) return reply.code(401).send({ error: 'unauthorized' });
    const { publicUrl, secret } = worldConfig();
    if (!publicUrl || !secret) {
      return reply.code(503).send({ error: 'world_disabled', message: '本实例没有开启 3D 空间' });
    }
    if (!hitRate(`world-ticket:${actor.id}`, 10)) {
      return reply.code(429).send({ error: 'rate_limited', message: '进空间太频繁，请稍后再试' });
    }
    const ttl = 180;
    const exp = Math.floor(Date.now() / 1000) + ttl;
    // 载荷只放「world 侧渲染身份需要的最小字段」；avatar 是本站签名 URL，world 加载它不需要额外鉴权
    const payload = Buffer.from(JSON.stringify({
      pid: Number(actor.id),
      name: actor.displayName,
      avatar: actor.avatarUrl || null,
      exp,
    })).toString('base64url');
    const sig = crypto.createHmac('sha256', secret).update(payload).digest('base64url');
    const ticket = `${payload}.${sig}`;
    return { url: `${publicUrl}/?ticket=${encodeURIComponent(ticket)}`, expiresInSeconds: ttl };
  });


  // 只读快照：主人看自己的 AI 现在还能发几条（MCP 的 my_limits 走的是同一个查询）
  fastify.get('/api/agents/:id/limits', async (req, reply) => {
    const actor = await currentUser(req);
    if (!actor) return reply.code(401).send({ error: 'unauthorized' });
    const agentId = posInt(req.params.id, 0);
    const conversationId = posInt(req.query.conversation_id, 0, 0) || null;
    const { rows: owned } = await pool.query(
      'SELECT 1 FROM agents WHERE principal_id = $1 AND owner_user_id = $2',
      [agentId, actor.id],
    );
    if (!owned[0]) return reply.code(404).send({ error: 'not_found' });
    const quota = await agentQuotaFor({ id: agentId }, { conversationId });
    if (!quota) return reply.code(404).send({ error: 'not_found' });
    return quota;
  });

  // 主人调配额度：日限、令牌桶容量/补充速率。改动会写 limits_changed_at，
  // Agent 下一次 my_limits / send_message 就能看到新值（不用等重启、也不靠「刻意读」）。
  fastify.patch('/api/agents/:id/limits', async (req, reply) => {
    const actor = await currentUser(req);
    if (!actor) return reply.code(401).send({ error: 'unauthorized' });
    const agentId = posInt(req.params.id, 0);
    const clamp = (value, fallback, min, max) => {
      const n = Number(value);
      if (!Number.isFinite(n)) return fallback;
      return Math.min(Math.max(Math.trunc(n), min), max);
    };
    const dailyLimit = clamp(req.body?.daily_limit, null, 1, 100_000);
    const capacity = clamp(req.body?.bucket_capacity, null, 1, 100);
    const refill = clamp(req.body?.bucket_refill_per_min, null, 0, 600);
    if (dailyLimit == null && capacity == null && refill == null) {
      return reply.code(400).send({ error: 'invalid_schema', message: '至少给一个字段：daily_limit / bucket_capacity / bucket_refill_per_min' });
    }
    const { rowCount } = await pool.query(
      `UPDATE agents SET
         daily_limit = COALESCE($3, daily_limit),
         bucket_capacity = COALESCE($4, bucket_capacity),
         bucket_refill_per_min = COALESCE($5, bucket_refill_per_min),
         limits_changed_at = now()
       WHERE principal_id = $1 AND owner_user_id = $2`,
      [agentId, actor.id, dailyLimit, capacity, refill],
    );
    if (!rowCount) return reply.code(404).send({ error: 'not_found' });
    // 调高容量时顺便把桶灌满：主人刚把上限改大，不该还要等令牌慢慢补（「改了还是发不出去」）
    if (capacity != null) {
      await pool.query(
        'UPDATE agent_buckets SET tokens = $2, updated_at = now() WHERE agent_id = $1',
        [agentId, capacity],
      );
    }
    await pool.query(
      `INSERT INTO events (aggregate_type, aggregate_id, type, actor_id, actor_type, payload)
       VALUES ('principal', $1, 'AgentLimitsChanged', $2, 'user', $3::jsonb)`,
      [agentId, actor.id, JSON.stringify({ daily_limit: dailyLimit, bucket_capacity: capacity, bucket_refill_per_min: refill })],
    ).catch(() => {});
    const quota = await agentQuotaFor({ id: agentId }, {});
    return { ok: true, quota };
  });

  /** 群级 AI 设置读取：只有群主/管理员能看（和 PATCH 同一条权限，别让普通成员看见一堆可改的旋钮） */
  async function conversationManageRole(actorId, conversationId) {
    const { rows } = await pool.query(
      'SELECT role FROM conversation_members WHERE conversation_id = $1 AND principal_id = $2',
      [conversationId, actorId],
    );
    return rows[0]?.role || null;
  }

  fastify.get('/api/conversations/:id/agent-settings', async (req, reply) => {
    const actor = await currentUser(req);
    if (!actor) return reply.code(401).send({ error: 'unauthorized' });
    const conversationId = posInt(req.params.id, 0);
    if (!conversationId) return reply.code(400).send({ error: 'invalid_id' });
    const role = await conversationManageRole(actor.id, conversationId);
    if (!role) return reply.code(403).send({ error: 'forbidden', message: '你不在这个会话里' });
    if (role !== 'owner' && role !== 'admin') {
      return reply.code(403).send({ error: 'forbidden', message: '只有群主/管理员可以查看群 AI 设置' });
    }
    const { rows } = await pool.query(
      'SELECT agent_round_quota, agent_relay_max_depth, agent_daily_limit FROM conversations WHERE id = $1',
      [conversationId],
    );
    return {
      ok: true,
      settings: {
        roundQuota: Number(rows[0]?.agent_round_quota ?? 2),
        relayDepth: Number(rows[0]?.agent_relay_max_depth ?? 2),
        groupDailyLimit: Number(rows[0]?.agent_daily_limit ?? 0),
      },
    };
  });

  // 群级 AI 设置（群主/管理员）：每消息最多几个 AI 回、AI→AI 接力深度、群日预算
  fastify.patch('/api/conversations/:id/agent-settings', async (req, reply) => {
    const actor = await currentUser(req);
    if (!actor) return reply.code(401).send({ error: 'unauthorized' });
    const conversationId = posInt(req.params.id, 0);
    if (!conversationId) return reply.code(400).send({ error: 'invalid_id' });
    const role = await conversationManageRole(actor.id, conversationId);
    if (!role) return reply.code(403).send({ error: 'forbidden', message: '你不在这个会话里' });
    if (role !== 'owner' && role !== 'admin') {
      return reply.code(403).send({ error: 'forbidden', message: '只有群主/管理员可以改群 AI 设置' });
    }
    const clamp = (value, min, max) => {
      const n = Number(value);
      if (!Number.isFinite(n)) return null;
      return Math.min(Math.max(Math.trunc(n), min), max);
    };
    const roundQuota = clamp(req.body?.round_quota, 1, 10);
    const relayDepth = clamp(req.body?.relay_depth, 0, 10);
    const groupDailyLimit = clamp(req.body?.group_daily_limit, 0, 100_000);
    if (roundQuota == null && relayDepth == null && groupDailyLimit == null) {
      return reply.code(400).send({ error: 'invalid_schema', message: '至少给一个字段：round_quota / relay_depth / group_daily_limit' });
    }
    await pool.query(
      `UPDATE conversations SET
         agent_round_quota = COALESCE($2, agent_round_quota),
         agent_relay_max_depth = COALESCE($3, agent_relay_max_depth),
         agent_daily_limit = COALESCE($4, agent_daily_limit)
       WHERE id = $1`,
      [conversationId, roundQuota, relayDepth, groupDailyLimit],
    );
    await pool.query(
      `INSERT INTO events (aggregate_type, aggregate_id, type, actor_id, actor_type, payload)
       VALUES ('conversation', $1, 'AgentSettingsChanged', $2, 'user', $3::jsonb)`,
      [conversationId, actor.id, JSON.stringify({ round_quota: roundQuota, relay_depth: relayDepth, group_daily_limit: groupDailyLimit })],
    ).catch(() => {});
    const { rows } = await pool.query(
      'SELECT agent_round_quota, agent_relay_max_depth, agent_daily_limit FROM conversations WHERE id = $1',
      [conversationId],
    );
    return {
      ok: true,
      settings: {
        roundQuota: Number(rows[0]?.agent_round_quota ?? 2),
        relayDepth: Number(rows[0]?.agent_relay_max_depth ?? 2),
        groupDailyLimit: Number(rows[0]?.agent_daily_limit ?? 0),
      },
    };
  });

  fastify.post('/api/agents/:id/pause', async (req, reply) => {
    const actor = await currentUser(req);
    if (!actor) return reply.code(401).send({ error: 'unauthorized' });
    const paused = req.body?.paused !== false;
    const { rowCount } = await pool.query(
      `UPDATE agents SET status = $3,
              paused_reason = CASE WHEN $3 = 'paused' THEN COALESCE(paused_reason, 'manual') ELSE NULL END,
              paused_at = CASE WHEN $3 = 'paused' THEN COALESCE(paused_at, now()) ELSE NULL END
        WHERE principal_id = $1 AND owner_user_id = $2`,
      [Number(req.params.id), actor.id, paused ? 'paused' : 'active'],
    );
    if (!rowCount) return reply.code(404).send({ error: 'not_found' });
    // 审计：暂停/恢复是权限变更
    await pool.query(
      `INSERT INTO events (aggregate_type, aggregate_id, type, actor_id, actor_type, payload)
       VALUES ('principal', $1, $2, $3, 'user', $4::jsonb)`,
      [Number(req.params.id), paused ? 'AgentPaused' : 'AgentResumed', actor.id, JSON.stringify({ agent_id: Number(req.params.id) })],
    ).catch(() => {});
    return { ok: true };
  });

  fastify.delete('/api/agents/:id', async (req, reply) => {
    const actor = await currentUser(req);
    if (!actor) return reply.code(401).send({ error: 'unauthorized' });
    const id = Number(req.params.id);
    const owned = await pool.query('SELECT 1 FROM agents WHERE principal_id = $1 AND owner_user_id = $2', [id, actor.id]);
    if (!owned.rows[0]) return reply.code(404).send({ error: 'not_found' });
    await pool.query('UPDATE agents SET status = $2 WHERE principal_id = $1', [id, 'revoked']);
    await pool.query('UPDATE agent_tokens SET revoked_at = now() WHERE agent_id = $1 AND revoked_at IS NULL', [id]);
    // 审计：吊销 token 必须可追溯
    await pool.query(
      `INSERT INTO events (aggregate_type, aggregate_id, type, actor_id, actor_type, payload)
       VALUES ('principal', $1, 'AgentRevoked', $2, 'user', $3::jsonb)`,
      [id, actor.id, JSON.stringify({ agent_id: id })],
    ).catch(() => {});
    return { ok: true };
  });

  // 我的 AI 在哪些群、各自什么档位（AI 管理页用）
  fastify.get('/api/agents/:id/memberships', async (req, reply) => {
    const actor = await currentUser(req);
    if (!actor) return reply.code(401).send({ error: 'unauthorized' });
    const rows = await agentMemberships(actor, Number(req.params.id));
    if (!rows) return reply.code(404).send({ error: 'not_found', message: '这不是你的 AI' });
    return { memberships: rows };
  });

  fastify.get('/api/agents/:id/config', async (req, reply) => {
    const actor = await currentUser(req);
    if (!actor) return reply.code(401).send({ error: 'unauthorized' });
    const id = Number(req.params.id);
    const owned = await pool.query('SELECT p.display_name FROM agents a JOIN principals p ON p.id = a.principal_id WHERE a.principal_id = $1 AND a.owner_user_id = $2', [id, actor.id]);
    if (!owned.rows[0]) return reply.code(404).send({ error: 'not_found' });
    const url = `${config.publicBaseUrl.replace(/\/$/, '')}/mcp`;
    return {
      agentName: owned.rows[0].display_name,
      mcp: { url, headers: { Authorization: 'Bearer <你的 agent token>' } },
      snippets: {
        claudeCode: `claude mcp add --transport http aio ${url} --header "Authorization: Bearer <TOKEN>"`,
        cursor: JSON.stringify({ mcpServers: { aio: { url, headers: { Authorization: 'Bearer <TOKEN>' } } } }, null, 2),
        codex: `# ~/.codex/config.toml\n[mcp_servers.aio]\nurl = "${url}"\nhttp_headers = { Authorization = "Bearer <TOKEN>" }`,
        bridge: `npx -y mcp-remote ${url} --header "Authorization: Bearer <TOKEN>"`,
      },
    };
  });

  // ============================================================ 表情包（S2）
  const itemUrl = (r) => r.static_path || (r.attachment_id ? mediaUrl(Number(r.attachment_id)) : null);

  function packView(pack, items, viewerId) {
    return {
      id: Number(pack.id),
      slug: pack.slug,
      title: pack.title,
      scope: pack.scope,
      license: pack.license,
      reviewState: pack.review_state,
      groupId: pack.group_id == null ? null : Number(pack.group_id),
      // 只有真正的主人才能管理：之前这里写成"有 owner 就算 mine"，
      // 结果群包在别人眼里也带编辑/删除按钮（服务端会拒，但 UI 误导）
      mine: pack.owner_id != null && Number(pack.owner_id) === Number(viewerId),
      itemCount: items.length,
      items: items.map((i) => ({
        id: Number(i.id),
        key: i.key,
        caption: i.caption,
        tags: i.tags || [],
        emotion: i.emotion,
        url: itemUrl(i),
      })),
    };
  }

  /** 批量取包：2 条 SQL 拿完，避免「一个包 2 次查询」的 N+1 */
  async function packsJson(packIds, viewerId = 0) {
    const ids = [...new Set(packIds.map(Number).filter((n) => Number.isInteger(n) && n > 0))];
    if (!ids.length) return [];
    const [{ rows: packs }, { rows: items }] = await Promise.all([
      pool.query('SELECT * FROM sticker_packs WHERE id = ANY($1::bigint[]) ORDER BY id', [ids]),
      pool.query(
        `SELECT pack_id, id, key, attachment_id, static_path, tags, emotion, caption
           FROM sticker_items WHERE pack_id = ANY($1::bigint[]) ORDER BY pack_id, sort, id`,
        [ids],
      ),
    ]);
    const byPack = new Map();
    for (const it of items) {
      const key = Number(it.pack_id);
      if (!byPack.has(key)) byPack.set(key, []);
      byPack.get(key).push(it);
    }
    return packs.map((pack) => packView(pack, byPack.get(Number(pack.id)) || [], viewerId));
  }

  async function packJson(packId, viewerId = 0) {
    const list = await packsJson([packId], viewerId);
    return list[0] ?? null;
  }

  // 可见范围：官方/公共 + 自己的私包 + 自己 AI 的私包 + 自己所在群的群包
  fastify.get('/api/sticker-packs', async (req, reply) => {
    const actor = await currentUser(req);
    if (!actor) return reply.code(401).send({ error: 'unauthorized' });
    const { rows } = await pool.query(
      `SELECT DISTINCT sp.id
         FROM sticker_packs sp
        WHERE sp.review_state IN ('none','approved')
          AND (
            sp.scope IN ('official','public')
            OR (sp.scope = 'private' AND sp.owner_id = $1)
            -- AI 自己做的表情包：主人能看见（否则 AI 发出来人类这边是裂图）
            OR (sp.scope = 'private' AND sp.owner_id IN (
                  SELECT a.principal_id FROM agents a WHERE a.owner_user_id = $1))
            OR (sp.scope = 'group' AND EXISTS (
                  SELECT 1 FROM conversation_members cm WHERE cm.conversation_id = sp.group_id AND cm.principal_id = $1))
          )
        ORDER BY sp.id`,
      [actor.id],
    );
    const packs = await packsJson(rows.map((r) => Number(r.id)), actor.id);
    return { packs };
  });

  fastify.post('/api/sticker-packs', async (req, reply) => {
    const actor = await currentUser(req);
    if (!actor) return reply.code(401).send({ error: 'unauthorized' });
    const title = String(req.body?.title || '').trim();
    if (title.length < 1 || title.length > 24) return reply.code(400).send({ error: 'invalid_title', message: '包名 1..24 字' });
    const { rows: cnt } = await pool.query(
      "SELECT count(*)::int AS n FROM sticker_packs WHERE owner_id=$1 AND scope='private'",
      [actor.id],
    );
    if (cnt[0].n >= 20) return reply.code(429).send({ error: 'too_many_packs', message: '每人最多 20 个自建包' });
    const slug = `user${actor.id}-${Date.now().toString(36)}`;
    const { rows } = await pool.query(
      `INSERT INTO sticker_packs (slug, title, owner_id, scope, license) VALUES ($1,$2,$3,'private','exclusive') RETURNING id`,
      [slug, title, actor.id],
    );
    return { pack: await packJson(Number(rows[0].id), actor.id) };
  });

  fastify.post('/api/sticker-packs/:id/items', async (req, reply) => {
    const actor = await currentUser(req);
    if (!actor) return reply.code(401).send({ error: 'unauthorized' });
    const packId = Number(req.params.id);
    const { rows: owned } = await pool.query(
      "SELECT id FROM sticker_packs WHERE id=$1 AND owner_id=$2 AND scope IN ('private','group')",
      [packId, actor.id],
    );
    if (!owned[0]) return reply.code(404).send({ error: 'not_found' });
    const attachmentId = Number(req.body?.attachment_id);
    if (!Number.isInteger(attachmentId) || attachmentId <= 0) return reply.code(400).send({ error: 'invalid_schema' });
    const { rows: att } = await pool.query(
      "SELECT id FROM attachments WHERE id=$1 AND uploader_id=$2 AND kind='image' AND deleted_at IS NULL",
      [attachmentId, actor.id],
    );
    if (!att[0]) return reply.code(400).send({ error: 'invalid_attachment', message: '只能引用你自己上传的图片' });
    const { rows: n } = await pool.query('SELECT count(*)::int AS n FROM sticker_items WHERE pack_id=$1', [packId]);
    if (n[0].n >= 200) return reply.code(429).send({ error: 'too_many_items', message: '每个包最多 200 个表情' });
    const tags = Array.isArray(req.body?.tags) ? req.body.tags.map((t) => String(t).slice(0, 12)).slice(0, 8) : [];
    const caption = String(req.body?.caption || '').slice(0, 40);
    const emotion = req.body?.emotion ? String(req.body.emotion).slice(0, 12) : null;
    const key = String(req.body?.key || `item${n[0].n + 1}`).replace(/[^a-zA-Z0-9_-]/g, '').slice(0, 32) || `item${n[0].n + 1}`;
    try {
      await pool.query(
        'INSERT INTO sticker_items (pack_id, key, attachment_id, tags, emotion, caption, sort) VALUES ($1,$2,$3,$4::text[],$5,$6,$7)',
        [packId, key, attachmentId, tags, emotion, caption, n[0].n],
      );
    } catch (err) {
      if (String(err.message).includes('duplicate')) return reply.code(409).send({ error: 'duplicate_key' });
      throw err;
    }
    await pool.query('UPDATE sticker_packs SET item_count=(SELECT count(*) FROM sticker_items WHERE pack_id=$1), updated_at=now() WHERE id=$1', [packId]);
    return { pack: await packJson(packId, actor.id) };
  });

  fastify.delete('/api/sticker-packs/:id/items/:itemId', async (req, reply) => {
    const actor = await currentUser(req);
    if (!actor) return reply.code(401).send({ error: 'unauthorized' });
    const packId = Number(req.params.id);
    const itemId = Number(req.params.itemId);
    const { rows: owned } = await pool.query('SELECT id FROM sticker_packs WHERE id=$1 AND owner_id=$2', [packId, actor.id]);
    if (!owned[0]) return reply.code(404).send({ error: 'not_found' });
    await pool.query('DELETE FROM sticker_items WHERE id=$1 AND pack_id=$2', [itemId, packId]);
    await pool.query('UPDATE sticker_packs SET item_count=(SELECT count(*) FROM sticker_items WHERE pack_id=$1), updated_at=now() WHERE id=$1', [packId]);
    return { pack: await packJson(packId, actor.id) };
  });

  // 分享到群：把私包切成群包（需要是群主/管理员）
  fastify.post('/api/sticker-packs/:id/share', async (req, reply) => {
    const actor = await currentUser(req);
    if (!actor) return reply.code(401).send({ error: 'unauthorized' });
    const packId = Number(req.params.id);
    const convId = Number(req.body?.conversation_id);
    const { rows: owned } = await pool.query('SELECT id FROM sticker_packs WHERE id=$1 AND owner_id=$2', [packId, actor.id]);
    if (!owned[0]) return reply.code(404).send({ error: 'not_found' });
    const { rows: mem } = await pool.query(
      "SELECT role FROM conversation_members WHERE conversation_id=$1 AND principal_id=$2",
      [convId, actor.id],
    );
    if (!mem[0] || !['owner', 'admin'].includes(mem[0].role)) {
      return reply.code(403).send({ error: 'forbidden', message: '只有群主/管理员能把表情包分享到群里' });
    }
    const { rows: before } = await pool.query('SELECT title, scope, group_id FROM sticker_packs WHERE id=$1', [packId]);
    await pool.query("UPDATE sticker_packs SET scope='group', group_id=$2, updated_at=now() WHERE id=$1", [packId, convId]);

    // 群里留一条系统消息：否则其他人根本不知道多了一个群道具包
    const title = String(before[0]?.title || '表情包').slice(0, 40);
    const already = before[0]?.scope === 'group' && Number(before[0]?.group_id) === convId;
    const notice = await submit({
      type: 'system_notice',
      conversation_id: convId,
      // 幂等键跟着「包+群」走：重复点分享不会刷屏
      client_msg_id: `packs-${packId}-to-${convId}`.slice(0, 64),
      body: already
        ? `表情包「${title}」仍在本群的表情面板里`
        : `表情包「${title}」已分享到本群，点输入栏的表情按钮就能直接用`,
    }, actor);

    return {
      pack: await packJson(packId, actor.id),
      notice: notice.accepted ? { seq: notice.seq ?? null } : null,
    };
  });

  fastify.delete('/api/sticker-packs/:id', async (req, reply) => {
    const actor = await currentUser(req);
    if (!actor) return reply.code(401).send({ error: 'unauthorized' });
    const packId = Number(req.params.id);
    const { rowCount } = await pool.query('DELETE FROM sticker_packs WHERE id=$1 AND owner_id=$2', [packId, actor.id]);
    if (!rowCount) return reply.code(404).send({ error: 'not_found' });
    return { ok: true };
  });

  // ============================================================ 举报（M4 最小闭环）
  const REPORT_TYPES = new Set(['message', 'feed', 'sticker_pack', 'sticker_item']);
  // 举报目标必须对本人生效：消息要同群、说说要可见、表情包要能通过可见性查询
  async function canSeeReportTarget(actor, targetType, targetId, conversationId = null) {
    if (targetType === 'message') {
      // 前端上报的是「会话内 seq」（不是消息主键）。带了 conversation_id 就精确校验那一条，
      // 没带（旧客户端）才退回「我所在的某个会话里确实有这个 seq」。
      const { rows } = conversationId
        ? await pool.query(
            `SELECT 1 FROM messages m
               JOIN conversation_members cm ON cm.conversation_id = m.conversation_id AND cm.principal_id = $3
              WHERE m.conversation_id = $2 AND m.seq = $1 LIMIT 1`,
            [targetId, conversationId, actor.id],
          ).catch(() => ({ rows: [] }))
        : await pool.query(
            `SELECT 1 FROM messages m
               JOIN conversation_members cm ON cm.conversation_id = m.conversation_id AND cm.principal_id = $2
              WHERE m.seq = $1 LIMIT 1`,
            [targetId, actor.id],
          ).catch(() => ({ rows: [] }));
      return Boolean(rows[0]);
    }
    if (targetType === 'feed') {
      const { rows } = await pool.query('SELECT author_id, visibility FROM feeds WHERE id = $1 AND deleted_at IS NULL', [targetId]);
      const row = rows[0];
      if (!row) return false;
      if (row.visibility === 'private') return Number(row.author_id) === Number(actor.id);
      return true;
    }
    if (targetType === 'sticker_pack') {
      const { rows } = await pool.query(
        `SELECT 1 FROM sticker_packs sp
          WHERE sp.id = $2 AND sp.review_state IN ('none','approved')
            AND (
              sp.scope IN ('official','public')
              OR (sp.scope = 'private' AND sp.owner_id = $1)
              OR (sp.scope = 'private' AND sp.owner_id IN (SELECT a.principal_id FROM agents a WHERE a.owner_user_id = $1))
              OR (sp.scope = 'group' AND EXISTS (
                    SELECT 1 FROM conversation_members cm WHERE cm.conversation_id = sp.group_id AND cm.principal_id = $1))
            ) LIMIT 1`,
        [actor.id, targetId],
      );
      return Boolean(rows[0]);
    }
    if (targetType === 'sticker_item') {
      const { rows } = await pool.query('SELECT pack_id FROM sticker_items WHERE id = $1', [targetId]);
      if (!rows[0]) return false;
      return canSeeReportTarget(actor, 'sticker_pack', Number(rows[0].pack_id));
    }
    return false;
  }

  // ---------------------------------------------------------------- 系统通知（Web Push）
  // 前端要拿 VAPID 公钥才能 pushManager.subscribe；没配就返回空字符串，前端据此隐藏开关
  fastify.get('/api/push/key', async () => ({ enabled: pushEnabled(), key: publicKey() }));

  fastify.post('/api/push/subscribe', async (req, reply) => {
    const actor = await currentUser(req);
    if (!actor) return reply.code(401).send({ error: 'unauthorized' });
    if (!pushEnabled()) return reply.code(503).send({ error: 'push_disabled', message: '服务器没有开启系统通知' });
    const out = await saveSubscription(actor, {
      endpoint: req.body?.endpoint,
      p256dh: req.body?.keys?.p256dh,
      auth: req.body?.keys?.auth,
      userAgent: req.headers['user-agent'],
    });
    if (out.error) return reply.code(400).send({ error: out.error, message: out.message });
    return { ok: true };
  });

  fastify.post('/api/push/unsubscribe', async (req, reply) => {
    const actor = await currentUser(req);
    if (!actor) return reply.code(401).send({ error: 'unauthorized' });
    const out = await removeSubscription(actor, { endpoint: req.body?.endpoint });
    if (out.error) return reply.code(400).send({ error: out.error, message: out.message });
    return { ok: true };
  });

  fastify.get('/api/push/status', async (req, reply) => {
    const actor = await currentUser(req);
    if (!actor) return reply.code(401).send({ error: 'unauthorized' });
    return { enabled: pushEnabled(), subscriptions: await listSubscriptions(actor) };
  });

  // ---------------------------------------------------------------- 站务（审核闭环）
  // 只有 principals.is_admin 能用；非站务一律 403（不是 404：别让人猜自己是不是站务）
  fastify.get('/api/admin/reports', async (req, reply) => {
    const actor = await currentUser(req);
    if (!actor) return reply.code(401).send({ error: 'unauthorized' });
    if (!actor.isAdmin) return reply.code(403).send({ error: 'forbidden', message: '只有站务可以查看举报' });
    const reports = await listReportsFor(actor, { status: String(req.query.status || 'open'), limit: posInt(req.query.limit, 50, 1, 100) });
    return { reports };
  });

  fastify.post('/api/admin/reports/:id/handle', async (req, reply) => {
    const actor = await currentUser(req);
    if (!actor) return reply.code(401).send({ error: 'unauthorized' });
    if (!actor.isAdmin) return reply.code(403).send({ error: 'forbidden', message: '只有站务可以处理举报' });
    const out = await submit({
      type: 'handle_report',
      report_id: posInt(req.params.id, 0, 0),
      action: req.body?.action,
      note: req.body?.note,
    }, actor);
    if (!out.accepted) {
      const code = out.reason === 'forbidden' ? 403
        : out.reason === 'not_found' ? 404
          : out.reason === 'conflict' ? 409
            : 400;
      return reply.code(code).send({ error: out.reason, message: out.message });
    }
    return out;
  });

  // 已封禁列表：解封入口的数据源。只列「现在还在封禁期」的人（过期自动掉出，不靠定时清理）。
  fastify.get('/api/admin/suspended', async (req, reply) => {
    const actor = await currentUser(req);
    if (!actor) return reply.code(401).send({ error: 'unauthorized' });
    if (!actor.isAdmin) return reply.code(403).send({ error: 'forbidden', message: '只有站务可以查看封禁列表' });
    const users = await listSuspendedFor(actor, { limit: posInt(req.query.limit, 100, 1, 200) });
    return { users };
  });

  // 解封：body { note? }。note 只作为站务操作时的说明，不入事件（payload 只放 principal_id）。
  // 状态码沿用 joinFailCode 的 HTTP 语义：forbidden→403、not_found→404（含「本来就没被封」）、
  // invalid_schema→400、internal→500。
  fastify.post('/api/admin/unsuspend/:principalId', async (req, reply) => {
    const actor = await currentUser(req);
    if (!actor) return reply.code(401).send({ error: 'unauthorized' });
    if (!actor.isAdmin) return reply.code(403).send({ error: 'forbidden', message: '只有站务可以解封' });
    const out = await submit({
      type: 'unsuspend_user',
      principal_id: posInt(req.params.principalId, 0, 0),
      note: req.body?.note,
    }, actor);
    if (!out.accepted) return reply.code(joinFailCode(out.reason)).send({ error: out.reason, message: out.message });
    return out;
  });

  // 站务手动置「邮箱已验证」：给 required 门禁的兜底出口（发信挂了也能放人进来）。
  // 走 submit()：事件里会留 UserEmailVerifiedManually，站务操作可追溯。
  fastify.post('/api/admin/verify-email', async (req, reply) => {
    const actor = await currentUser(req);
    if (!actor) return reply.code(401).send({ error: 'unauthorized' });
    if (!actor.isAdmin) return reply.code(403).send({ error: 'forbidden', message: '只有站务可以手动标记邮箱已验证' });
    const out = await submit({
      type: 'admin_verify_email',
      principal_id: req.body?.principal_id,
      account_no: req.body?.account_no,
      note: req.body?.note,
    }, actor);
    if (!out.accepted) return reply.code(joinFailCode(out.reason)).send({ error: out.reason, message: out.message });
    return out;
  });

  // ------------------------------------------------------- 邀请（站务侧）
  // 站务码 owner_user_id = NULL：不占任何人的名额，用途是「第一批发号」与运维放量。
  // 和用户码共用一张表/同一套兑换逻辑，只是没有邀请人，所以不会写 invite_redemptions.inviter_id。
  fastify.post('/api/admin/invites', async (req, reply) => {
    const actor = await currentUser(req);
    if (!actor) return reply.code(401).send({ error: 'unauthorized' });
    if (!actor.isAdmin) return reply.code(403).send({ error: 'forbidden', message: '只有站务可以生成邀请码' });
    const out = await adminCreate(actor, {
      count: req.body?.count,
      maxUses: req.body?.max_uses ?? req.body?.maxUses,
      expiresInDays: req.body?.expires_in_days ?? req.body?.expiresInDays,
      note: req.body?.note,
    });
    if (!out.ok) {
      return reply.code(inviteStatus(out.error)).send({ error: out.error, message: INVITE_ERROR_TEXT[out.error] || '生成邀请码失败' });
    }
    // 明文码只在这一次响应里出现
    return { invites: out.invites };
  });

  fastify.get('/api/admin/invites', async (req, reply) => {
    const actor = await currentUser(req);
    if (!actor) return reply.code(401).send({ error: 'unauthorized' });
    if (!actor.isAdmin) return reply.code(403).send({ error: 'forbidden', message: '只有站务可以查看邀请码' });
    const out = await adminList(actor, { limit: posInt(req.query.limit, 50, 1, 200) });
    if (!out.ok) return reply.code(inviteStatus(out.error)).send({ error: out.error });
    return { invites: out.invites };
  });

  fastify.post('/api/admin/invites/:id/revoke', async (req, reply) => {
    const actor = await currentUser(req);
    if (!actor) return reply.code(401).send({ error: 'unauthorized' });
    if (!actor.isAdmin) return reply.code(403).send({ error: 'forbidden', message: '只有站务可以吊销邀请码' });
    const out = await adminRevoke(actor, posInt(req.params.id, 0, 0));
    if (!out.ok) return reply.code(inviteStatus(out.error)).send({ error: out.error, message: INVITE_ERROR_TEXT[out.error] });
    return { ok: true, id: out.id };
  });

  fastify.post('/api/reports', async (req, reply) => {
    const actor = await currentUser(req);
    if (!actor) return reply.code(401).send({ error: 'unauthorized' });
    const targetType = String(req.body?.target_type || '');
    const targetId = Number(req.body?.target_id);
    const reason = String(req.body?.reason || '').trim().slice(0, 200);
    if (!REPORT_TYPES.has(targetType)) return reply.code(400).send({ error: 'invalid_target' });
    if (!Number.isInteger(targetId) || targetId <= 0) return reply.code(400).send({ error: 'invalid_target' });
    if (reason.length < 2) return reply.code(400).send({ error: 'reason_required', message: '请填写举报原因' });
    // 频率限制：举报本身是匿名信誉武器，不能让人无限刷
    if (!hitRate(`report:${actor.id}`, 10)) return reply.code(429).send({ error: 'rate_limited', message: '举报太频繁，请稍后再试' });

    // 消息类举报必须带 conversation_id：seq 只在会话内唯一，没有它站务没法定位
    const conversationId = posInt(req.body?.conversation_id, 0, 0);
    if (targetType === 'message' && !conversationId) {
      return reply.code(400).send({ error: 'conversation_required', message: '举报消息需要带上会话 id' });
    }
    // 必须是"真的能看到"的目标才能举报：否则谁都能拿 id 乱报，3 个小号就能把别人的包打掉
    const visible = await canSeeReportTarget(actor, targetType, targetId, conversationId || null);
    if (!visible) return reply.code(404).send({ error: 'not_found', message: '目标不存在或你无权查看' });
    try {
      await pool.query(
        `INSERT INTO reports (reporter_id, target_type, target_id, conversation_id, reason) VALUES ($1,$2,$3,$4,$5)`,
        [actor.id, targetType, targetId, conversationId || null, reason],
      );
    } catch (err) {
      if (String(err.message).includes('duplicate')) return reply.code(409).send({ error: 'already_reported' });
      throw err;
    }
    return { ok: true };
  });

  fastify.get('/api/reports', async (req, reply) => {
    const actor = await currentUser(req);
    if (!actor) return reply.code(401).send({ error: 'unauthorized' });
    // 普通用户只看自己提交的；站务用 scripts/review-packs.mjs 直接读库
    const { rows } = await pool.query(
      'SELECT id, target_type, target_id, reason, status, created_at FROM reports WHERE reporter_id=$1 ORDER BY id DESC LIMIT 50',
      [actor.id],
    );
    return {
      reports: rows.map((r) => ({
        id: Number(r.id),
        targetType: r.target_type,
        targetId: Number(r.target_id),
        reason: r.reason,
        status: r.status,
        createdAt: r.created_at,
      })),
    };
  });
}
