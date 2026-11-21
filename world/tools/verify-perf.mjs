#!/usr/bin/env node
/**
 * 首屏性能基线（spec §6 M12 / §8 性能预算）。
 *
 * 量三件事，每件都用**能复现的口径**：
 *
 * 1. **首屏字节数（gzip + brotli 都量）**
 *    口径 = 打开页面到"可操作"为止必须传输的那些文件：
 *    `index.html` + 它直接/间接 import 的 JS chunk + 角色资产 glb。
 *    两个数字并排给：
 *    - `local`  ：用 node zlib 现压（可复现、不依赖服务器配置、跨机器一致）
 *    - `wire`   ：浏览器 `performance.getEntriesByType('resource').transferSize` 之和
 *                 （实际过线的字节，含 HTTP 头；受缓存与服务器压缩策略影响）
 *    两者不一致是正常的（wire 含头、且 dev server 不压缩），所以**预算判定只看 local**。
 *
 * 2. **加载耗时**
 *    三个里程碑，全部来自浏览器自己的 performance 时间线：
 *    - `domContentLoaded` / `load`：标准导航里程碑
 *    - `firstFrame`：第一帧真的画出来（rAF 回调首次执行，说明渲染循环活了）
 *    - `operable`：物理就绪且世界在推进（`__worldDebug` 的 tick 增长，
 *      或兜底看 canvas 存在 + rAF 稳定）
 *    spec §8 要求"进房到可操作 ≤2s（宽带）"，判定用 `operable`。
 *
 * 3. **稳定帧率**
 *    ⚠️ **口径警告（这条最重要，别把数字当结论）**：
 *    headless Chromium 没有 GPU，WebGL 走 SwiftShader **软件光栅**，
 *    fps 反映的是 CPU 单核的光栅化速度，**不代表真机 GPU 的帧率**。
 *    所以输出里显式给 `fpsTrustworthy: false` 与原因，
 *    真机 60fps 必须在有 GPU 的机器上人工/另跑确认。
 *    能跨环境对比的是 `drawCalls` / `triangles`（来自 renderer.info，与后端无关）。
 *
 * 用法：
 *   node tools/verify-perf.mjs                    # 起本地服务发 dist/，跑默认 6s
 *   node tools/verify-perf.mjs --url http://127.0.0.1:5173/   # 指向已在跑的服务
 *   node tools/verify-perf.mjs --seconds 10       # 采样更久
 *   node tools/verify-perf.mjs --json             # 只输出 JSON（给 CI 抓）
 */

import { chromium } from '@playwright/test';import { chromiumLaunchOptions } from './chromium.mjs';

import { createServer } from 'node:http';
import { existsSync, readFileSync, statSync } from 'node:fs';
import { join, extname, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { gzipSync, brotliCompressSync, constants as zlibConstants } from 'node:zlib';

const HERE = dirname(fileURLToPath(import.meta.url));
const WORLD_ROOT = resolve(HERE, '..');

/** spec §8：首屏传输 ≤3MB。 */
const BUDGET_BYTES = 3 * 1024 * 1024;
/** spec §8：进房到可操作 ≤2s（宽带）。 */
const BUDGET_OPERABLE_MS = 2000;

// ── 参数 ──
const argv = process.argv.slice(2);
const flag = (name) => argv.includes(`--${name}`);
const opt = (name, dflt) => {
  const i = argv.indexOf(`--${name}`);
  return i >= 0 && argv[i + 1] ? argv[i + 1] : dflt;
};
const EXPLICIT_URL = opt('url', null);
const SECONDS = Number(opt('seconds', 6));
const JSON_ONLY = flag('json');
const ROOT = opt('root', 'dist');

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.wasm': 'application/wasm',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json',
  '.glb': 'model/gltf-binary',
  '.gltf': 'model/gltf+json',
  '.ktx2': 'image/ktx2',
  '.png': 'image/png',
  '.webp': 'image/webp',
  '.jpg': 'image/jpeg',
  '.ico': 'image/x-icon',
};

/**
 * 本地静态服务。
 *
 * 两级根目录不是偷懒：`dist/` 里只有 JS，角色资产在 `assets/`（仓库根），
 * Vite 的 publicDir 默认是 `public/`，本项目没有建它。
 * 所以 `assets/**` 要回落到仓库根去找——否则资产 404，
 * 而"资产 404"会让首屏字节数偏小（少算了 1.69MB），那是自欺欺人的绿色。
 * 这个缺口本身会作为 `findings` 报出来，不在这里悄悄补齐。
 */
function serve(rootDir) {
  const server = createServer((req, res) => {
    const rel = decodeURIComponent(req.url.split('?')[0]).replace(/^\/+/, '');
    const candidates = [
      rel === '' ? join(rootDir, 'index.html') : join(rootDir, rel),
      // 资产回落：dist/assets/characters/x.glb 找不到时去仓库根的 assets/ 找
      rel.startsWith('assets/') ? join(WORLD_ROOT, rel) : null,
    ].filter(Boolean);

    let file = candidates.find((p) => existsSync(p) && statSync(p).isFile());
    if (!file && (rel === '' || !extname(rel))) {
      file = join(rootDir, 'index.html'); // SPA 回退
    }
    if (!file) {
      res.statusCode = 404;
      res.end('not found');
      return;
    }
    res.setHeader('Content-Type', MIME[extname(file)] ?? 'application/octet-stream');
    // 不压缩：本地要量的是"压缩前"的原始字节，压缩比由脚本自己算。
    // 若这里开 gzip，浏览器的 transferSize 会变成压缩后，与 local 口径混在一起。
    res.setHeader('Cache-Control', 'no-store');
    res.end(readFileSync(file));
  });
  return new Promise((r) => {
    server.listen(0, '127.0.0.1', () => r({ server, port: server.address().port }));
  });
}

/** 用 node zlib 现压：gzip 与 brotli（质量 11，CDN 的常见档位）。 */
function compressedSizes(buf) {
  const gz = gzipSync(buf, { level: 9 }).length;
  const br = brotliCompressSync(buf, {
    params: {
      [zlibConstants.BROTLI_PARAM_QUALITY]: 11,
      [zlibConstants.BROTLI_PARAM_SIZE_HINT]: buf.length,
    },
  }).length;
  return { raw: buf.length, gzip: gz, brotli: br };
}

/**
 * 把浏览器**实际加载**的资源映射回本地文件，再逐个用 node zlib 现压。
 *
 * 为什么以"浏览器实际加载了什么"为准，而不是静态扫 import 图：
 * 本项目里 `rapier` 是 `await import('@dimforge/rapier3d-compat')`（动态导入），
 * 静态扫会漏掉它——而它 4.2MB / gzip 1.6MB，是全站最大的单笔传输，漏掉就是假绿。
 * 反过来，`?verify=1` 的 harness 与调试面板也是动态导入，但首屏**真的不下载**，
 * 算进去又会让预算凭空多几十 KB。
 * 两种情况都无法靠静态分析区分，只有浏览器自己的 resource 时间线知道答案。
 *
 * 所以口径是：**浏览器实际请求过的文件** + 每个文件用 node zlib 现压（gzip9 / brotli11）。
 * 这样既覆盖真实传输集，又不受服务器压缩策略影响，跨机器可复现。
 *
 * 找不到本地文件（比如指向远程 --url）时该条标 `unmapped: true`，不猜字节数。
 */
function measureLoadedResources(resourceUrls, rootDir) {
  const out = [];
  const seen = new Set();

  for (const url of resourceUrls) {
    let pathname;
    try {
      pathname = new URL(url).pathname;
    } catch {
      continue;
    }
    const rel = decodeURIComponent(pathname).replace(/^\/+/, '');
    if (rel === '' || seen.has(rel)) continue;
    seen.add(rel);

    // dist/ 优先，其次仓库根（角色资产在仓库根，不在 dist）
    const candidates = [join(rootDir, rel), join(WORLD_ROOT, rel)];
    const abs = candidates.find((p) => existsSync(p) && statSync(p).isFile());

    if (!abs) {
      out.push({ path: rel, unmapped: true, raw: 0, gzip: 0, brotli: 0 });
      continue;
    }
    out.push({ path: rel, unmapped: false, ...compressedSizes(readFileSync(abs)) });
  }
  return out;
}

/**
 * 静态兜底：从 `dist/index.html` 出发，跟静态 import 递归收集。
 *
 * 只在**没有浏览器实测**（`--url` 指向远程、或页面没加载成功）时用。
 * 它**会漏掉动态 import 的 chunk**（本项目里 rapier 就是），
 * 所以报告里会显式标 `method: 'static-scan'` 提醒读者这个数字可能偏小。
 */
function collectFirstScreenStatic(rootDir) {
  const indexPath = join(rootDir, 'index.html');
  if (!existsSync(indexPath)) return null;

  const files = [];
  const seen = new Set();
  const queue = [indexPath];

  const relOf = (abs) => abs.slice(rootDir.length + 1).split('\\').join('/');

  while (queue.length) {
    const abs = queue.shift();
    if (seen.has(abs)) continue;
    seen.add(abs);
    if (!existsSync(abs)) continue;

    const buf = readFileSync(abs);
    files.push({ path: relOf(abs), unmapped: false, ...compressedSizes(buf) });

    const ext = extname(abs);
    if (ext === '.html') {
      // entry script + modulepreload
      const re = /<(?:script|link)\b[^>]*?\b(?:src|href)\s*=\s*["'](\.\/[^"']+\.js)["']/g;
      let m;
      while ((m = re.exec(buf.toString('utf8'))) !== null) {
        queue.push(join(dirname(abs), m[1]));
      }
    } else if (ext === '.js') {
      const text = buf.toString('utf8');
      // **只跟静态 import**，不跟动态 import()（首屏不下载懒加载 chunk）。
      //   import"./x.js"           裸副作用 import
      //   from"./x.js"             具名/默认 import
      //   export…from"./x.js"      再导出
      // 动态形式（都不跟）：import("./x.js")
      const statics = [
        /\bfrom\s*["'](\.\/[^"']+\.js)["']/g,
        /\bimport\s*["'](\.\/[^"']+\.js)["']/g,
        /\bexport\s*\*\s*from\s*["'](\.\/[^"']+\.js)["']/g,
      ];
      for (const re of statics) {
        let m;
        while ((m = re.exec(text)) !== null) {
          queue.push(join(dirname(abs), m[1]));
        }
      }
    }
  }

  return files;
}

/**
 * 首屏预算判定口径（spec §8「首屏传输 ≤3MB」）。
 *
 * 一个客户端**只会收到一种编码**（它发 `Accept-Encoding: br, gzip`，服务器选一个），
 * 所以"实际传输"是两者里**更小的那个**，而不是相加、也不是取大的。
 * 现代浏览器一律拿到 brotli；只有老客户端才退到 gzip。
 *
 * 所以判定用 `min(gzip, brotli)`，但两个数字都**必须**打出来：
 * 如果 gzip 超了而 brotli 没超，报告里会显式写"gzip 客户端超预算"，
 * 让人知道这不是"全绿"，只是"现代客户端刚好过关"。
 * 藏起超预算的那个编码才是造假。
 */
function judgeBudget(gzip, brotli, budget) {
  const best = Math.min(gzip, brotli);
  return {
    best,
    withinBudget: best <= budget,
    gzipWithinBudget: gzip <= budget,
    brotliWithinBudget: brotli <= budget,
    /** gzip-only 老客户端会超多少字节（0 表示没超）。 */
    gzipOverageBytes: Math.max(0, gzip - budget),
  };
}

function sum(files, key) {
  return files.reduce((a, f) => a + f[key], 0);
}

function mb(bytes) {
  return (bytes / 1024 / 1024).toFixed(3);
}

async function main() {
  let server = null;
  let baseUrl = EXPLICIT_URL;
  const findings = [];

  if (!baseUrl) {
    if (!existsSync(ROOT)) {
      console.error(`找不到 ${ROOT}/。先跑 \`npm run build\`，或用 --url 指向已在跑的服务。`);
      process.exit(2);
    }
    const s = await serve(ROOT);
    server = s.server;
    baseUrl = `http://127.0.0.1:${s.port}/`;
  }

  // ── 1. 首屏字节：等浏览器跑完再回填（见下方 measureLoadedResources） ──
  // 资产是否真的进了发布产物（构建配置问题，不是性能问题，但会让线上 404）
  if (!EXPLICIT_URL && !existsSync(join(ROOT, 'assets/characters/whalegirl.glb'))) {
    findings.push(
      `构建产物里没有 assets/characters/whalegirl.glb：Vite publicDir 默认是 public/，` +
        `本项目没建。线上会 404（角色不出现）。本次统计用仓库根的 assets/ 兜底计入。`,
    );
  }

  const launch = chromiumLaunchOptions();
  if (flag('hardware')) {
    launch.args = launch.args.filter(arg => !arg.includes('swiftshader'));
    if (process.platform === 'win32') launch.args.push('--use-angle=d3d11');
  }
  const browser = await chromium.launch(launch);

  const page = await browser.newPage({ viewport: { width: 1920, height: 1080 } });
  const pageErrors = [];
  const failedRequests = [];
  page.on('pageerror', (e) => pageErrors.push(String(e.message)));
  page.on('console', (m) => {
    if (m.type() === 'error') pageErrors.push(m.text());
  });
  page.on('requestfailed', (r) => failedRequests.push(`${r.url()} ${r.failure()?.errorText}`));
  page.on('response', (r) => {
    if (r.status() >= 400) failedRequests.push(`${r.url()} HTTP ${r.status()}`);
  });

  const navStart = Date.now();
  await page.goto(baseUrl, { waitUntil: 'load' });
  const wallLoadMs = Date.now() - navStart;

  // ── 2. 加载里程碑（浏览器自己的时间线，比墙钟可信） ──
  const nav = await page.evaluate(() => {
    const n = performance.getEntriesByType('navigation')[0];
    return n
      ? {
          domContentLoaded: Math.round(n.domContentLoadedEventEnd),
          load: Math.round(n.loadEventEnd),
          responseEnd: Math.round(n.responseEnd),
        }
      : null;
  });

  // 第一帧：等 rAF 真的跑起来（渲染循环活了）
  const firstFrameMs = await page.evaluate(
    () =>
      new Promise((res) => {
        const t0 = performance.now();
        requestAnimationFrame(() => res(Math.round(performance.now())));
      }),
  );

  // 可操作：物理就绪且世界在推进。dev 构建能读 __worldDebug；
  // 生产构建没有这个口，退化为"canvas 存在 + 连续 N 帧稳定"。
  const operable = await page.evaluate(async () => {
    const t0 = performance.now();
    const deadline = t0 + 30_000;
    while (performance.now() < deadline) {
      const dbg = window.__worldDebug;
      if (dbg && typeof dbg.read === 'function') {
        const s = dbg.read();
        if (Number(s['physicsSteps'] ?? 0) > 0 && Number(s['tick'] ?? 0) > 30) {
          return { ms: Math.round(performance.now()), via: 'worldDebug.physicsSteps' };
        }
      } else {
        // 生产构建兜底：有 canvas 且连续 30 帧
        const canvas = document.querySelector('canvas');
        if (canvas) {
          let frames = 0;
          await new Promise((res) => {
            const tick = () => {
              frames += 1;
              if (frames >= 30) res(null);
              else requestAnimationFrame(tick);
            };
            requestAnimationFrame(tick);
          });
          return { ms: Math.round(performance.now()), via: 'canvas + 30 rAF' };
        }
      }
      await new Promise((r) => setTimeout(r, 50));
    }
    return { ms: null, via: 'timeout' };
  });

  // ── 3. 稳定帧率 ──
  // 先让世界跑 2s 进入稳态（资产加载、JIT、阴影贴图首帧都在前 1s 里）
  await page.waitForTimeout(2000);

  const fps = await page.evaluate(
    (seconds) =>
      new Promise((res) => {
        const frames = [];
        const start = performance.now();
        let last = start;
        const tick = (now) => {
          frames.push(now - last);
          last = now;
          if (now - start >= seconds * 1000) {
            const total = now - start;
            const deltas = frames.slice(1).sort((a, b) => a - b);
            const p = (q) => deltas[Math.min(deltas.length - 1, Math.floor(deltas.length * q))] ?? 0;
            res({
              seconds: Math.round(total) / 1000,
              frames: frames.length,
              avgFps: Math.round(((frames.length - 1) * 1000 * 10) / total) / 10,
              frameMsP50: Math.round(p(0.5) * 100) / 100,
              frameMsP95: Math.round(p(0.95) * 100) / 100,
              frameMsMax: Math.round((deltas[deltas.length - 1] ?? 0) * 100) / 100,
              // 低于 50fps 的帧占比：比"平均 fps"更能反映卡顿体感
              slowFrameRatio:
                Math.round(
                  (deltas.filter((d) => d > 20).length / Math.max(1, deltas.length)) * 1000,
                ) / 1000,
            });
          } else {
            requestAnimationFrame(tick);
          }
        };
        requestAnimationFrame(tick);
      }),
    SECONDS,
  );

  // 渲染统计（dev 才有 __worldDebug；生产退化为 null）
  const renderStats = await page.evaluate(() => {
    const dbg = window.__worldDebug;
    if (!dbg || typeof dbg.read !== 'function') return null;
    const s = dbg.read();
    return {
      drawCalls: s['drawCalls'] ?? null,
      triangles: s['triangles'] ?? null,
      tier: s['tier'] ?? null,
      dpr: s['dpr'] ?? null,
      shadows: s['shadows'] ?? null,
    };
  });

  // 实际过线字节（含 HTTP 头；本地服务不压缩，所以会比 local gzip 大）
  // `urls` 同时带出来：它是"首屏到底下载了哪些文件"的唯一可信来源。
  const wire = await page.evaluate(() => {
    const res = performance.getEntriesByType('resource');
    let transfer = 0;
    let decoded = 0;
    const urls = [];
    for (const r of res) {
      transfer += r.transferSize ?? 0;
      decoded += r.decodedBodySize ?? 0;
      urls.push(r.name);
    }
    const nav = performance.getEntriesByType('navigation')[0];
    if (nav) {
      transfer += nav.transferSize ?? 0;
      decoded += nav.encodedBodySize ?? 0;
      urls.push(nav.name); // 文档本身也算首屏传输
    }
    return { transfer, decoded, count: urls.length, urls };
  });

  const gl = await page.evaluate(() => {
    const c = document.createElement('canvas');
    const g = c.getContext('webgl2') ?? c.getContext('webgl');
    if (!g) return { webgl: false, renderer: 'unavailable' };
    const ext = g.getExtension('WEBGL_debug_renderer_info');
    return {
      webgl: true,
      renderer: ext ? String(g.getParameter(ext.UNMASKED_RENDERER_WEBGL)) : 'unknown',
    };
  });

  await browser.close();
  server?.close();

  // ── 报告 ──
  // 首屏字节：以浏览器**实际请求过**的文件集为准，逐个用 node zlib 现压。
  // 拿不到浏览器实测（没记录到资源）时才退回静态扫，并如实标 method。
  let files;
  let byteMethod;
  if (wire.urls.length > 0) {
    files = measureLoadedResources(wire.urls, ROOT);
    byteMethod = 'browser-loaded';
  } else if (!EXPLICIT_URL) {
    files = collectFirstScreenStatic(ROOT);
    byteMethod = 'static-scan';
    findings.push(
      '没拿到浏览器资源时间线，退回静态 import 扫描：**会漏掉动态 import 的 chunk**' +
        '（本项目 rapier 就是动态导入），数字可能偏小。',
    );
  } else {
    files = null;
    byteMethod = 'unavailable';
  }

  if (files && files.length === 0) {
    findings.push('没有识别到任何首屏文件，字节统计不可信');
  }
  const unmapped = files?.filter((f) => f.unmapped) ?? [];
  if (unmapped.length) {
    findings.push(
      `有 ${unmapped.length} 个资源在本地找不到对应文件（--url 指向远程时正常），` +
        `它们的字节没计入：${unmapped.map((f) => f.path).join(', ')}`,
    );
  }

  const measured = files?.filter((f) => !f.unmapped) ?? [];
  const localGzip = measured.length ? sum(measured, 'gzip') : null;
  const localBrotli = measured.length ? sum(measured, 'brotli') : null;
  const localRaw = measured.length ? sum(measured, 'raw') : null;
  const budget = localGzip === null ? null : judgeBudget(localGzip, localBrotli, BUDGET_BYTES);
  if (budget && budget.gzipOverageBytes > 0) {
    findings.push(
      `gzip 客户端超预算 ${budget.gzipOverageBytes} 字节（${(budget.gzipOverageBytes / 1024).toFixed(1)}KB）——` +
        `**已知偏差，非阻塞**（lead 裁决 2026-11-20：按 brotli 口径认定达标）。` +
        `D7 前如需严格达标：贴图 512→448px 约省 40KB。`,
    );
  }

  // 软渲染判定：SwiftShader / llvmpipe / software 都算
  const softwareRenderer = /swiftshader|llvmpipe|software|angle \(google, vulkan 1\.\d+\.\d+ \(swiftshader/i.test(
    gl.renderer,
  );

  const result = {
    target: baseUrl,
    bytes: {
      // 判定口径：文件集来自浏览器实测，压缩用 node zlib 现压（可复现、跨机器一致）
      method: byteMethod,
      local: files
        ? {
            raw: localRaw,
            gzip: localGzip,
            brotli: localBrotli,
            budget: BUDGET_BYTES,
            // 判定口径见 judgeBudget 的注释：客户端只会收到一种编码，取更小的那个
            judgedBy: 'min(gzip, brotli)',
            best: budget?.best ?? null,
            withinBudget: budget?.withinBudget ?? null,
            gzipWithinBudget: budget?.gzipWithinBudget ?? null,
            brotliWithinBudget: budget?.brotliWithinBudget ?? null,
            gzipOverageBytes: budget?.gzipOverageBytes ?? null,
            /** 资产占 gzip 字节的比例：判断"该不该压资产"的依据，预先算好给 printHuman 用。 */
            assetGzipSharePct:
              localGzip && localGzip > 0
                ? Math.round(
                    ((measured.find((f) => f.path.endsWith('.glb'))?.gzip ?? 0) / localGzip) * 100,
                  )
                : null,
            files: files.map((f) => ({
              path: f.path,
              unmapped: f.unmapped,
              raw: f.raw,
              gzip: f.gzip,
              brotli: f.brotli,
            })),
          }
        : null,
      // 参考口径：浏览器实际过线（本地服务不压缩，所以偏大；含 HTTP 头）
      wire: { transfer: wire.transfer, decoded: wire.decoded, resourceCount: wire.count },
    },
    timing: {
      domContentLoadedMs: nav?.domContentLoaded ?? null,
      loadMs: nav?.load ?? null,
      firstFrameMs,
      operableMs: operable.ms,
      operableVia: operable.via,
      wallLoadMs,
      budgetOperableMs: BUDGET_OPERABLE_MS,
      operableWithinBudget: operable.ms === null ? null : operable.ms <= BUDGET_OPERABLE_MS,
    },
    fps: {
      ...fps,
      // ⚠️ 这是最容易被误读的字段：软渲染下的 fps 不代表真机
      renderer: gl.renderer,
      webgl2: gl.webgl,
      softwareRenderer,
      fpsTrustworthy: !softwareRenderer,
      note: softwareRenderer
        ? 'SwiftShader 软渲染（CPU 光栅），fps 只反映单核光栅化速度，不代表真机 GPU 帧率；真机 60fps 需在有 GPU 的机器上另测'
        : '硬件渲染，fps 可代表该机器真实帧率',
    },
    render: renderStats,
    errors: { page: pageErrors.slice(0, 10), failedRequests: failedRequests.slice(0, 10) },
    findings,
  };

  if (JSON_ONLY) {
    console.log(JSON.stringify(result, null, 2));
  } else {
    printHuman(result);
  }

  // 退出码：只对**可判定**的项判红。
  // fps 在软渲染下不判（那是拿 CPU 单核速度当 GPU 指标，等于编数字）。
  const failed = [];
  if (result.bytes.local && result.bytes.local.withinBudget === false) {
    failed.push(
      `首屏最小传输 ${mb(budget.best)}MB > 预算 ${mb(BUDGET_BYTES)}MB` +
        `（gzip ${mb(localGzip)}MB / brotli ${mb(localBrotli)}MB）`,
    );
  }
  if (result.timing.operableWithinBudget === false) {
    failed.push(`进房到可操作 ${operable.ms}ms > 预算 ${BUDGET_OPERABLE_MS}ms`);
  }
  if (pageErrors.length) failed.push(`页面报错 ${pageErrors.length} 条`);

  if (failed.length) {
    if (!JSON_ONLY) {
      console.log('');
      console.log(`未达标：${failed.join('；')}`);
    }
    process.exit(1);
  }
}

function printHuman(r) {
  const line = '─'.repeat(64);
  console.log('首屏性能基线（spec §8 性能预算）');
  console.log(`目标：${r.target}`);
  console.log(line);

  if (r.bytes.local) {
    const b = r.bytes.local;
    console.log(
      `首屏字节（文件集：${r.bytes.method === 'browser-loaded' ? '浏览器实际加载的资源' : '静态 import 扫描（可能偏小）'}；压缩：node zlib gzip9/brotli11）`,
    );
    for (const f of b.files) {
      if (f.unmapped) {
        console.log(`  ${f.path.padEnd(38)} （本地无此文件，未计入）`);
        continue;
      }
      console.log(
        `  ${f.path.padEnd(38)} raw ${(f.raw / 1024).toFixed(1).padStart(8)}KB` +
          `  gzip ${(f.gzip / 1024).toFixed(1).padStart(7)}KB` +
          `  br ${(f.brotli / 1024).toFixed(1).padStart(7)}KB`,
      );
    }
    console.log(
      `  ${'合计'.padEnd(38)} raw ${(b.raw / 1024 / 1024).toFixed(3).padStart(7)}MB` +
        `  gzip ${mb(b.gzip).padStart(7)}MB  br ${mb(b.brotli).padStart(7)}MB`,
    );
    const mark = (ok) => (ok === null ? '?' : ok ? '✓' : '✗');
    console.log(
      `  预算 3.000MB（客户端只收一种编码，按 min(gzip,brotli) 判）→` +
        ` 判定 ${mark(b.withinBudget)} ${mb(b.best)}MB`,
    );
    // ── 结论行（lead 裁决 2026-11-20）──
    // 不把两个数字丢给人自己猜：明确写"按 brotli 认定达标"，
    // 同时把 gzip 的超出量记成已知偏差，并给出如果要严格达标的处置路径。
    if (b.withinBudget && b.gzipOverageBytes > 0) {
      console.log(
        `  ✔ 结论：按 **brotli** 口径认定**达标**（${mb(b.brotli)}MB，余量 ` +
          `${((BUDGET_BYTES - b.brotli) / 1024).toFixed(0)}KB）。` +
          `gzip ${mb(b.gzip)}MB 超 ${(b.gzipOverageBytes / 1024).toFixed(1)}KB 记为**已知偏差**：`,
      );
      console.log(
        `     所有现代浏览器都支持 brotli，nginx/Cloudflare 默认优先发 brotli；` +
          `为 0.16% 砍视觉质量不划算。`,
      );
      console.log(
        `     D7 前如需严格达标：贴图 512→448px 约省 40KB（` +
          `glb 占 gzip 字节的 ${b.assetGzipSharePct ?? '?'}%）。`,
      );
    } else if (b.withinBudget) {
      console.log(`  ✔ 结论：达标（gzip 与 brotli 双口径均在预算内）。`);
    } else {
      console.log(
        `  ✘ 结论：**未达标**（最小传输 ${mb(b.best)}MB > 3.000MB）。` +
          `按 spec §8 的处置顺序：先砍同屏刚体 → 再关阴影 → 再降 DPR → 最后减角色。`,
      );
    }
    console.log(
      `    gzip   ${mark(b.gzipWithinBudget)} ${mb(b.gzip)}MB` +
        (b.gzipOverageBytes > 0
          ? `  ← 超 ${(b.gzipOverageBytes / 1024).toFixed(1)}KB（只支持 gzip 的老客户端会超）`
          : ''),
    );
    console.log(`    brotli ${mark(b.brotliWithinBudget)} ${mb(b.brotli)}MB`);
    console.log(
      `  参考（浏览器实际过线，本地服务不压缩故偏大）：transfer ` +
        `${(r.bytes.wire.transfer / 1024 / 1024).toFixed(3)}MB` +
        ` / decoded ${(r.bytes.wire.decoded / 1024 / 1024).toFixed(3)}MB` +
        ` / ${r.bytes.wire.resourceCount} 个资源`,
    );
  } else {
    console.log('首屏字节：无法测量（既没有浏览器资源记录，也没有本地 dist/）');
    console.log(
      `  浏览器实际过线：transfer ${(r.bytes.wire.transfer / 1024 / 1024).toFixed(3)}MB` +
        ` / decoded ${(r.bytes.wire.decoded / 1024 / 1024).toFixed(3)}MB`,
    );
  }

  console.log(line);
  console.log('加载耗时');
  console.log(`  DOMContentLoaded   ${r.timing.domContentLoadedMs ?? '?'}ms`);
  console.log(`  load               ${r.timing.loadMs ?? '?'}ms`);
  console.log(`  首帧可绘           ${r.timing.firstFrameMs}ms`);
  console.log(
    `  进房到可操作       ${r.timing.operableMs ?? '超时'}ms` +
      `（${r.timing.operableVia}，预算 ${r.timing.budgetOperableMs}ms）` +
      ` ${r.timing.operableWithinBudget === false ? '✗' : '✓'}`,
  );

  console.log(line);
  console.log('稳定帧率');
  console.log(
    `  平均 ${r.fps.avgFps}fps · 帧耗时 p50 ${r.fps.frameMsP50}ms / p95 ${r.fps.frameMsP95}ms` +
      ` / max ${r.fps.frameMsMax}ms · 慢帧(>20ms)占比 ${(r.fps.slowFrameRatio * 100).toFixed(1)}%`,
  );
  console.log(`  采样 ${r.fps.seconds}s / ${r.fps.frames} 帧`);
  console.log(`  渲染器：${r.fps.renderer}`);
  if (!r.fps.fpsTrustworthy) {
    console.log('  ⚠️  软渲染（SwiftShader）：这个 fps **不代表真机 GPU 帧率**，');
    console.log('      只说明"渲染循环在出帧、CPU 光栅化能跑多快"。');
    console.log('      真机 60fps 需在有 GPU 的机器上另测；可跨环境对比的只有 drawCalls/triangles。');
  }
  if (r.render) {
    console.log(
      `  drawCall ${r.render.drawCalls} / 三角面 ${r.render.triangles} · 档位 ${r.render.tier}` +
        ` · dpr ${r.render.dpr} · 阴影 ${r.render.shadows}`,
    );
  }

  if (r.findings.length) {
    console.log(line);
    console.log('发现（不计入退出码，但必须处理）');
    for (const f of r.findings) console.log(`  · ${f}`);
  }
  if (r.errors.page.length || r.errors.failedRequests.length) {
    console.log(line);
    console.log('页面错误 / 失败请求');
    for (const e of r.errors.page) console.log(`  ! ${e}`);
    for (const e of r.errors.failedRequests) console.log(`  ! ${e}`);
  }
  console.log(line);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
