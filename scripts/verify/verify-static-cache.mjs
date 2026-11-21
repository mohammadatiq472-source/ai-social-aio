// 静态资源缓存策略回归（纯 Node，无依赖）。
//
// 为什么需要这条：缓存头是「改动后肉眼看不出来」的东西——
//   - index.html / sw.js 被长缓存 → 用户永远拿到旧入口和旧 Service Worker，新版本发不出去；
//   - /assets/ 下的 hash 产物没有长缓存 → 每次打开都重新下载几百 KB。
// 所以把分档固定成可复跑的门：入口/SW/manifest 必须 no-cache，assets 必须 immutable 一年。
//
// 用法：
//   node scripts/verify/verify-static-cache.mjs
//   BASE=http://127.0.0.1:8787 node scripts/verify/verify-static-cache.mjs
import http from 'node:http';

const BASE = (process.env.BASE || 'http://127.0.0.1:8787').replace(/\/$/, '');

const results = [];

function check(name, ok, detail = '') {
  results.push({ name, ok });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? '  — ' + detail : ''}`);
}

async function req(pathname, ms = 5000) {
  return fetch(`${BASE}${pathname}`, { signal: AbortSignal.timeout(ms), redirect: 'manual' });
}

// 条件请求必须走 node:http，不能用全局 fetch（undici）：
// undici 的 fetch 在无缓存模式下对带 If-None-Match 的请求仍回 200（实测），
// 会把「no-cache 靠 304 省流量」误报成 FAIL。curl / node:http 都能拿到正规的 304。
function conditionalGet(pathname, etag) {
  const u = new URL(`${BASE}${pathname}`);
  return new Promise((resolve, reject) => {
    const r = http.request(
      { hostname: u.hostname, port: u.port, path: u.pathname, headers: { 'if-none-match': etag } },
      (res) => {
        res.resume();
        resolve({ status: res.statusCode, headers: res.headers });
      },
    );
    r.on('error', reject);
    r.end();
  });
}

const cacheControlOf = (res) => String(res.headers.get('cache-control') || '');
const contentTypeOf = (res) => String(res.headers.get('content-type') || '');
// no-cache 与 max-age=0 在语义上都是「每次回源校验」；两者都算过。
const isNoCache = (cc) => /\bno-cache\b/i.test(cc) || /(^|,)\s*(public,\s*)?max-age=0\b/i.test(cc);

const main = async () => {
  // 0) 服务必须可达：否则后面每一条都会给出误导性的 FAIL 原因
  let rootHtml = '';
  try {
    const res = await req('/');
    rootHtml = await res.text();
    check('/', res.status === 200, `HTTP ${res.status} ${contentTypeOf(res)}`);
    const cc = cacheControlOf(res);
    check('/ 的 Cache-Control 是 no-cache（入口 HTML 必须每次回源校验）', isNoCache(cc), `cache-control: ${cc || '(缺失)'}`);
    check('/ 返回 text/html', /text\/html/i.test(contentTypeOf(res)), contentTypeOf(res));
  } catch (e) {
    check(`服务可达：${BASE}`, false, `${e.message}（先 bash tmp/devstack.sh server-start）`);
    console.log('\n有失败：0/1（服务不可达，后续检查跳过）');
    process.exitCode = 1;
    return;
  }

  // 1) /assets/ 下带 hash 的构建产物 → 一年 immutable
  // Vite 的 base 可能是 '/' 也可能是 './'（本仓库 dist 里是 ./assets/…），两种都认。
  const assetMatch = rootHtml.match(/["'](?:\.\/|\/)(assets\/[A-Za-z0-9._@-]+\.js)["']/);
  const assetPath = assetMatch ? `/${assetMatch[1]}` : null;
  if (!assetPath) {
    check('从 index.html 能解析出一个 /assets/…js', false, 'index.html 里没有 /assets/*.js 引用（dist 未构建？）');
  } else {
    check('从 index.html 能解析出一个 /assets/…js', true, assetPath);
    const res = await req(assetPath);
    const cc = cacheControlOf(res);
    check(`${assetPath} 的 Cache-Control 含 immutable`, /immutable/i.test(cc), `cache-control: ${cc || '(缺失)'}`);
    check(`${assetPath} 的 max-age=31536000`, /max-age=31536000/i.test(cc), `cache-control: ${cc || '(缺失)'}`);
    check(`${assetPath} 返回 200 且是 JS`, res.status === 200 && /javascript/i.test(contentTypeOf(res)),
      `HTTP ${res.status} ${contentTypeOf(res)}`);
  }

  // 2) Service Worker 不能被长缓存：旧 SW 活着 = 旧缓存策略一直生效
  {
    const res = await req('/sw.js');
    const cc = cacheControlOf(res);
    check('/sw.js 返回 200', res.status === 200, `HTTP ${res.status} ${contentTypeOf(res)}`);
    check('/sw.js 的 Cache-Control 是 no-cache', isNoCache(cc), `cache-control: ${cc || '(缺失)'}`);
    // no-cache 每次回源校验，但必须靠 ETag 走 304 才不浪费流量
    const etag = res.headers.get('etag');
    const body = await res.text();
    if (!etag) {
      check('/sw.js 带 ETag（no-cache 靠 revalidate 省流量）', false, `响应没有 ETag，body=${body.length}B`);
    } else {
      const cond = await conditionalGet('/sw.js', etag);
      check('/sw.js 带 If-None-Match 返回 304（no-cache 不等于每次全量重下）', cond.status === 304, `HTTP ${cond.status}`);
    }
  }

  // 3) manifest 与 index.html 同档（no-cache）
  {
    const res = await req('/manifest.webmanifest');
    const cc = cacheControlOf(res);
    check('/manifest.webmanifest 返回 200', res.status === 200, `HTTP ${res.status} ${contentTypeOf(res)}`);
    check('/manifest.webmanifest 的 Cache-Control 是 no-cache', isNoCache(cc), `cache-control: ${cc || '(缺失)'}`);
  }

  // 4) 不存在的 assets 必须 404，且不能回 SPA 的 index.html（否则浏览器把它当 JS 解析）
  {
    const res = await req('/assets/__nope__.js');
    const type = contentTypeOf(res);
    check('/assets/__nope__.js 返回 404', res.status === 404, `HTTP ${res.status}`);
    check('/assets/__nope__.js 的 content-type 不是 text/html', !/text\/html/i.test(type), type || '(缺失)');
  }

  // 5) SPA 回退：非 /api /mcp /ws 的自由路径回入口 HTML，同样必须 no-cache
  {
    const res = await req('/chat');
    const cc = cacheControlOf(res);
    const type = contentTypeOf(res);
    check('/chat 返回 200 且是 text/html', res.status === 200 && /text\/html/i.test(type), `HTTP ${res.status} ${type}`);
    check('/chat（SPA 回退）的 Cache-Control 是 no-cache', isNoCache(cc), `cache-control: ${cc || '(缺失)'}`);
    const body = await res.text();
    check('/chat（SPA 回退）的响应体是入口 HTML', /<div id="root"/i.test(body) || /<!doctype html>/i.test(body),
      body.slice(0, 40).replace(/\s+/g, ' '));
  }

  // 6) 非内容寻址的其它静态 → 一天缓存（列两个代表：图标 / 音频）
  for (const p of ['/icons/icon-192.png', '/apple-touch-icon.png', '/sounds/send.mp3']) {
    const res = await req(p);
    const cc = cacheControlOf(res);
    check(`${p} 返回 200`, res.status === 200, `HTTP ${res.status} ${contentTypeOf(res)}`);
    check(`${p} 的 Cache-Control 是 public, max-age=86400`, /public/i.test(cc) && /max-age=86400/i.test(cc),
      `cache-control: ${cc || '(缺失)'}`);
  }

  const failed = results.filter((r) => !r.ok);
  console.log(`\n${failed.length === 0 ? '全部通过' : '有失败'}：${results.length - failed.length}/${results.length}`);
  if (failed.length) {
    console.log('失败项：' + failed.map((f) => f.name).join('; '));
    process.exitCode = 1;
  }
};

main().catch((e) => {
  console.error('验证异常：', e.message);
  process.exitCode = 1;
});
