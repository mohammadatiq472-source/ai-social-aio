import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import Fastify from 'fastify';
import cookie from '@fastify/cookie';
import websocket from '@fastify/websocket';
import fastifyStatic from '@fastify/static';

import { config, assertConfig } from './config.mjs';
import { closeDb } from './db.mjs';
import routes from './http/routes.mjs';
import { attachWebSocket, onlineCount } from './ws/hub.mjs';
import { initPush, pushEnabled } from './push.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const distDir = path.join(__dirname, '..', 'web', 'dist');

// 静态资源缓存分档。为什么不用 @fastify/static 的 maxAge/immutable：
// 那两个是全局单一档位，而入口 HTML / Service Worker 必须每次回源校验，
// 只有带 hash 的构建产物才敢长缓存。
const NO_CACHE_FILES = new Set(['index.html', 'sw.js', 'manifest.webmanifest']);

function cacheControlFor(filePath) {
  // setHeaders 拿到的是绝对路径；转成相对 distDir 的 posix 路径再判档
  const rel = path.relative(distDir, filePath).split(path.sep).join('/');
  if (rel.startsWith('assets/')) {
    // Vite 产物是内容寻址（文件名带 hash）：内容变 → 文件名变，所以可以一年 immutable
    return 'public, max-age=31536000, immutable';
  }
  if (NO_CACHE_FILES.has(rel)) {
    // index.html 是「引用哪些 hash 产物」的唯一入口；sw.js 被缓存住会让旧 SW 一直活着。
    // no-cache 不是不缓存，而是每次 revalidate（配合 ETag/Last-Modified 走 304）。
    return 'no-cache';
  }
  // 其它静态（icons / packs / sounds / apple-touch-icon 等）不是内容寻址：
  // 一天缓存，换图当天能被看到，又不用每次都打后端。
  return 'public, max-age=86400';
}

const app = Fastify({
  logger: {
    level: config.logLevel,
    // [C8] 日志绝不包含消息正文
    redact: ['req.headers.authorization', 'req.headers.cookie'],
    transport: process.env.NODE_ENV === 'production' ? undefined : undefined,
  },
  trustProxy: true,
  bodyLimit: 64 * 1024,
});

assertConfig();
// 系统通知：没配 VAPID 就整体关闭（不影响聊天）；配了才初始化推送库
app.log.info({ push: pushEnabled() }, pushEnabled() ? 'Web Push 已启用' : 'Web Push 未配置（无系统通知）');
initPush();

// 安全响应头（单机、无第三方脚本，CSP 可以收得比较紧）
app.addHook('onRequest', async (req, reply) => {
  reply.header('X-Content-Type-Options', 'nosniff');
  reply.header('X-Frame-Options', 'DENY');
  reply.header('Referrer-Policy', 'no-referrer');
  // 录音要用麦克风：microphone=(self)；摄像头/定位继续禁用
  reply.header('Permissions-Policy', 'camera=(), microphone=(self), geolocation=()');
  reply.header(
    'Content-Security-Policy',
    [
      "default-src 'self'",
      "script-src 'self'",
      "style-src 'self' 'unsafe-inline'",
      // 外链富内容：AI 发来的图片/音视频直接去对方服务器取（我们不托管二进制）
      "img-src 'self' data: blob: https:",
      // 语音/视频本地预览走 blob:，外链音视频走 https:
      "media-src 'self' blob: https:",
      // HTML 段在 sandbox iframe 里预览（iframe 内部脚本由沙箱自己管，不受这份 CSP 影响）
      "frame-src 'self' https:",
      "connect-src 'self' ws: wss: blob:",
      "font-src 'self' data:",
      "frame-ancestors 'none'",
      "base-uri 'self'",
      "form-action 'self'",
    ].join('; '),
  );
  // 只在被 HTTPS 反代时下发 HSTS，避免本地 http 开发被浏览器记住
  if (req.headers['x-forwarded-proto'] === 'https') {
    reply.header('Strict-Transport-Security', 'max-age=15552000; includeSubDomains');
  }
});

// ---------------------------------------------------------------------------
// 慢请求观测（P1-5）
// 为什么用全局 hook 而不是每个 handler 自己计时：404/鉴权失败/静态文件也走这里，
// 慢在哪一视同仁；handler 内计时会漏掉中间件与鉴权。
// 隐私：只记 method + 路径（**去掉 query**）+ 路由模板，不记 body/header。
//   query 里可能有搜索词、邀请码；URL 里的 :id 不算敏感，但没必要记原始 URL。
// 排除静态/媒体/健康检查/WS：它们的高频慢记录会把真正的慢 API 淹掉。
// ---------------------------------------------------------------------------
const SLOW_HTTP_EXCLUDE = ['/assets/', '/media/', '/icons/', '/packs/', '/sounds/', '/healthz', '/ws'];
app.addHook('onRequest', async (req) => {
  req._obsStart = performance.now();
});
app.addHook('onResponse', async (req, reply) => {
  const start = req._obsStart;
  if (typeof start !== 'number') return;
  const ms = Math.round(performance.now() - start);
  if (ms < config.httpSlowMs) return;
  const raw = String(req.raw?.url || req.url || '');
  const pathOnly = raw.split('?')[0];
  if (SLOW_HTTP_EXCLUDE.some((p) => pathOnly === p || pathOnly.startsWith(p))) return;
  app.log.warn(
    {
      method: req.method,
      url: pathOnly,
      route: req.routeOptions?.url || null,
      statusCode: reply.statusCode,
      ms,
    },
    'http.slow',
  );
});

// 错误处理：4xx 保留业务文案；5xx 只回通用错误，绝不把 PostgreSQL 的 code/message 透出去
app.setErrorHandler((err, req, reply) => {
  const statusRaw = Number(err.statusCode);
  const status = Number.isInteger(statusRaw) && statusRaw >= 400 && statusRaw < 500 ? statusRaw : 500;
  if (status >= 500) {
    req.log.error({ err: err.message, code: err.code, url: req.raw?.url }, 'request failed');
    return reply.code(500).send({ error: 'internal', message: '服务器开小差了，请稍后重试' });
  }
  return reply.code(status).send({ error: err.code || 'bad_request', message: err.message || '请求不合法' });
});

await app.register(cookie);
await app.register(websocket, { options: { maxPayload: 64 * 1024 } });

await app.register(routes);
await attachWebSocket(app);

// MCP：由 src/mcp/server.mjs 提供；缺失时不阻塞主服务（便于分批开发）
try {
  const mcp = await import('./mcp/server.mjs');
  const register = mcp.default || mcp.mcpRoutes;
  if (typeof register === 'function') {
    await app.register(register);
    app.log.info('MCP routes mounted at /mcp');
  }
} catch (err) {
  app.log.warn({ err: err.message }, 'MCP 模块未就绪，/mcp 暂不可用');
}

// 前端静态资源（构建产物）；未构建时给一个占位页
if (fs.existsSync(distDir)) {
  await app.register(fastifyStatic, {
    root: distDir,
    prefix: '/',
    wildcard: false,
    // 关掉插件全局的 Cache-Control，改成逐文件分档（cacheControlFor）。
    // 坑：@fastify/static 先调 setHeaders，随后才应用 send 生成的 Cache-Control，
    // 开着默认值会把 setHeaders 里设的值盖掉——SPA 回退尤其明显。
    cacheControl: false,
    setHeaders(res, filePath) {
      res.setHeader('Cache-Control', cacheControlFor(filePath));
    },
  });
} else {
  app.get('/', async (_req, reply) => {
    reply.type('text/html; charset=utf-8');
    return `<!doctype html><meta charset="utf-8"><title>AIO</title>
<body style="font-family:system-ui;display:grid;place-items:center;height:100vh;margin:0">
<div style="text-align:center"><h1>AIO</h1><p>后端已启动，前端尚未构建。</p>
<p>开发模式请访问 Vite 的 5173 端口。</p></div></body>`;
  });
}

// SPA 回退：非 /api /mcp /ws 的 GET 交给前端路由。
// 但 /assets、/packs、/sounds、/media、/icons 是真实文件路径——找不到就老老实实 404，
// 绝不能回 index.html：浏览器会把它当 JS/CSS/图片解析，报 MIME 错误或整站白屏。
// （/icons 与 apple-touch-icon 是 PWA 资源：缺了要让人看见 404，而不是静默回 200 HTML）
const ASSET_PREFIXES = ['/assets/', '/packs/', '/sounds/', '/media/', '/icons/'];
const ASSET_EXACT = new Set(['/apple-touch-icon.png', '/manifest.webmanifest', '/favicon.ico']);
app.setNotFoundHandler((req, reply) => {
  const url = req.raw.url || '/';
  if (url.startsWith('/api') || url.startsWith('/mcp') || url.startsWith('/ws')) {
    return reply.code(404).send({ error: 'not_found' });
  }
  if (ASSET_PREFIXES.some((p) => url.startsWith(p)) || ASSET_EXACT.has(url.split('?')[0])) {
    return reply.code(404).send({ error: 'not_found' });
  }
  if (fs.existsSync(path.join(distDir, 'index.html'))) {
    // SPA 回退也是入口 HTML，必须 no-cache。setHeaders 已按 index.html 判档，
    // 这里再显式写一次：将来换静态实现/中间件时不容易被默认缓存头绕过。
    reply.header('Cache-Control', 'no-cache');
    return reply.sendFile('index.html');
  }
  return reply.code(404).send({ error: 'not_found' });
});

app.get('/healthz/full', async (req) => {
  // 只给本机（watchdog/隧道外）看细节；公网入口带 cf-connecting-ip，一律最小信息
  const sock = req.socket?.remoteAddress || '';
  const loopback = sock === '127.0.0.1' || sock === '::1' || sock === '::ffff:127.0.0.1';
  const fromPublic = Boolean(req.headers['cf-connecting-ip']);
  if (!loopback || fromPublic) return { ok: true };
  return {
    ok: true,
    wsOnline: onlineCount(),
    memoryMB: Math.round(process.memoryUsage().rss / 1024 / 1024),
    uptime: Math.round(process.uptime()),
  };
});

const shutdown = async (signal) => {
  app.log.info({ signal }, 'shutting down');
  try {
    await app.close();
  } finally {
    await closeDb();
    process.exit(0);
  }
};
process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));

try {
  await app.listen({ port: config.port, host: config.host });
  app.log.info(`AIO listening on http://${config.host}:${config.port}`);
} catch (err) {
  app.log.error(err);
  process.exit(1);
}
