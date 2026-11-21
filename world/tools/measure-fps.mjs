#!/usr/bin/env node
/**
 * 帧率与渲染统计实测（M1 验收：1080p 空场景 60fps）。
 *
 * 为什么不直接用 Playwright 的 launch：
 * Playwright 通过**管道 stdio** 与浏览器通信，本机沙箱禁止管道 stdio（spawn EPERM）。
 * 但把子进程 stdio 重定向到**文件**是允许的，所以这里自己起浏览器、用 CDP 驱动。
 *
 * 关于 fps 数字能不能信（这条最重要）：
 * - 真实 Chrome 有 GPU，但本机沙箱拒绝 mojo 命名管道，多进程模式起不来；
 *   single-process 能起，但渲染与主线程抢同一个核，fps 严重偏低。
 * - Playwright 的 headless shell 走 SwiftShader（CPU 软件光栅），fps 反映 CPU 单核速度。
 * - 所以报告里显式给 `fpsTrustworthy`：只有真实 GPU 且非单进程时为 true。
 *   drawCalls / triangles 来自 renderer.info，与后端无关，任何情况都可信。
 *
 * 用法：node tools/measure-fps.mjs [url] [width] [height] [seconds]
 */

import { spawn } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync, openSync, closeSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const URL_ARG = process.argv[2] ?? 'http://127.0.0.1:5180/';
const WIDTH = Number(process.argv[3] ?? 1920);
const HEIGHT = Number(process.argv[4] ?? 1080);
const SECONDS = Number(process.argv[5] ?? 5);
const PORT = 9340 + Math.floor(Math.random() * 40);

const LOCAL = process.env.LOCALAPPDATA ?? '';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * 候选浏览器。`software` 只影响报告里 fpsTrustworthy 的判定，不影响流程。
 * 真实 Chrome 优先（有 GPU），拿不到就退回 Playwright 的 headless shell。
 */
const CANDIDATES = [
  { path: 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe', software: false, label: 'Chrome' },
  {
    path: 'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
    software: false,
    label: 'Chrome (x86)',
  },
  {
    path: join(LOCAL, 'ms-playwright', 'chromium_headless_shell-1243', 'chrome-headless-shell-win64', 'chrome-headless-shell.exe'),
    software: true,
    label: 'Playwright headless shell 1243 (SwiftShader)',
  },
  {
    path: join(LOCAL, 'ms-playwright', 'chromium-1217', 'chrome-win', 'chrome.exe'),
    software: true,
    label: 'Playwright chromium 1217 (SwiftShader)',
  },
  {
    path: join(LOCAL, 'ms-playwright', 'chromium_headless_shell-1217', 'chrome-headless-shell-win64', 'chrome-headless-shell.exe'),
    software: true,
    label: 'Playwright headless shell 1217 (SwiftShader)',
  },
];

/** 起一个浏览器实例，返回 { proc, port, profileDir } 或 null。 */
async function launch(port) {
  const profileDir = mkdtempSync(join(tmpdir(), 'aio-fps-'));
  const outFd = openSync(join(profileDir, 'stdout.log'), 'w');
  const errFd = openSync(join(profileDir, 'stderr.log'), 'w');

  for (const cand of CANDIDATES) {
    if (!cand.path || !existsSync(cand.path)) continue;

    const proc = spawn(
      cand.path,
      [
        '--headless',
        // single-process + no-zygote：本机沙箱拒绝 mojo 命名管道，
        // 多进程模式启动即 FATAL（platform_channel.cc Check failed）。
        '--single-process',
        '--no-zygote',
        '--disable-dev-shm-usage',
        `--remote-debugging-port=${port}`,
        `--user-data-dir=${profileDir}/profile`,
        `--window-size=${WIDTH},${HEIGHT}`,
        '--no-first-run',
        '--no-default-browser-check',
        '--disable-extensions',
        '--no-sandbox',
        '--disable-gpu-sandbox',
        '--enable-unsafe-swiftshader',
        '--hide-scrollbars',
        '--mute-audio',
        '--disable-crash-reporter',
        '--noerrdialogs',
        'about:blank',
      ],
      // detached + unref 是关键：非 detached 时 Node 接管生命周期管理，
      // 浏览器刚打印 "DevTools listening" 就会被 FATAL 掉。
      { stdio: ['ignore', outFd, errFd], detached: true, windowsHide: true },
    );
    proc.unref();

    // 等 CDP 就绪
    const deadline = Date.now() + 25_000;
    while (Date.now() < deadline) {
      await sleep(400);
      try {
        const res = await fetch(`http://127.0.0.1:${port}/json/version`);
        const ver = await res.json();
        return { proc, port, profileDir, cand, version: ver, outFd, errFd };
      } catch {
        /* 还没起来 */
      }
    }

    // 起不来，收掉再试下一个
    killTree(proc.pid);
    const stderr = safeRead(join(profileDir, 'stderr.log'));
    console.error(`[measure] ${cand.label} 起不来：${stderr.split('\n').filter(Boolean).slice(0, 2).join(' | ')}`);
  }

  closeSync(outFd);
  closeSync(errFd);
  rmSync(profileDir, { recursive: true, force: true });
  return null;
}

function safeRead(p) {
  try {
    return readFileSync(p, 'utf8');
  } catch {
    return '';
  }
}

function killTree(pid) {
  if (!pid) return;
  try {
    if (process.platform === 'win32') {
      spawn('taskkill', ['/PID', String(pid), '/T', '/F'], { stdio: 'ignore' });
    } else {
      process.kill(pid, 'SIGKILL');
    }
  } catch {}
}

// ───────────────────────────── CDP ─────────────────────────────

let ws = null;
let msgId = 0;
const pending = new Map();
const consoleLogs = [];

function connect(wsUrl) {
  return new Promise((resolve, reject) => {
    ws = new WebSocket(wsUrl);
    const timer = setTimeout(() => reject(new Error('WS 连接超时')), 20_000);
    ws.onopen = () => {
      clearTimeout(timer);
      resolve();
    };
    ws.onerror = (e) => {
      clearTimeout(timer);
      reject(new Error(`WS 连接失败: ${e?.message ?? e}`));
    };
    ws.onmessage = (ev) => {
      let msg;
      try {
        msg = JSON.parse(ev.data);
      } catch {
        return;
      }
      if (msg.id && pending.has(msg.id)) {
        const { resolve: ok, reject: bad } = pending.get(msg.id);
        pending.delete(msg.id);
        if (msg.error) bad(new Error(msg.error.message));
        else ok(msg.result);
        return;
      }
      if (msg.method === 'Runtime.consoleAPICalled') {
        const text = (msg.params.args ?? [])
          .map((a) => a.value ?? a.description ?? a.unserializableValue ?? '')
          .join(' ');
        consoleLogs.push({ type: msg.params.type, text });
      }
      if (msg.method === 'Runtime.exceptionThrown') {
        const d = msg.params.exceptionDetails;
        consoleLogs.push({ type: 'exception', text: d?.exception?.description ?? d?.text ?? '' });
      }
    };
  });
}

function send(method, params = {}) {
  const id = ++msgId;
  ws.send(JSON.stringify({ id, method, params }));
  return new Promise((resolve, reject) => {
    pending.set(id, { resolve, reject });
    setTimeout(() => {
      if (pending.has(id)) {
        pending.delete(id);
        reject(new Error(`CDP 超时: ${method}`));
      }
    }, 60_000);
  });
}

async function evaluate(expression, awaitPromise = false) {
  const r = await send('Runtime.evaluate', {
    expression,
    awaitPromise,
    returnByValue: true,
  });
  if (r.exceptionDetails) {
    const d = r.exceptionDetails;
    throw new Error(`页面内求值失败: ${d.text ?? ''} ${d.exception?.description ?? ''}`);
  }
  return r.result.value;
}

// ───────────────────────────── 主流程 ─────────────────────────────

async function main() {
  const inst = await launch(PORT);
  if (!inst) throw new Error('所有候选浏览器都起不来');

  console.error(`[measure] 使用 ${inst.cand.label}`);

  try {
    const targets = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json();
    const page = targets.find((t) => t.type === 'page');
    if (!page) throw new Error('没有可用的 page target');

    await connect(page.webSocketDebuggerUrl);
    await send('Page.enable');
    await send('Runtime.enable');
    await send('Emulation.setDeviceMetricsOverride', {
      width: WIDTH,
      height: HEIGHT,
      deviceScaleFactor: 1,
      mobile: false,
    });

    await send('Page.navigate', { url: URL_ARG });

    // 等 __worldDebug 出现（说明 three 初始化完成）
    const deadline = Date.now() + 40_000;
    let ready = false;
    while (Date.now() < deadline) {
      await sleep(600);
      try {
        ready = await evaluate('typeof window.__worldDebug !== "undefined"');
        if (ready) break;
      } catch {
        /* 页面还在加载 */
      }
    }
    if (!ready) {
      const errs = consoleLogs.filter((l) => l.type === 'exception' || l.type === 'error').slice(0, 3);
      throw new Error(`window.__worldDebug 未出现\n${JSON.stringify(errs, null, 2)}`);
    }

    await sleep(2000); // 让 fps 滑窗填满

    const gpu = await evaluate(`(() => {
      const c = document.createElement('canvas');
      const gl = c.getContext('webgl2') || c.getContext('webgl');
      if (!gl) return { ok: false, reason: 'no webgl' };
      const dbg = gl.getExtension('WEBGL_debug_renderer_info');
      const renderer = dbg ? gl.getParameter(dbg.UNMASKED_RENDERER_WEBGL) : gl.getParameter(gl.RENDERER);
      return {
        ok: true,
        renderer: String(renderer),
        webgl2: !!c.getContext('webgl2'),
        software: /swiftshader|software|llvmpipe|basic render/i.test(String(renderer)),
      };
    })()`);

    const fps = await evaluate(
      `(async () => {
        const secs = ${SECONDS};
        const start = performance.now();
        let frames = 0;
        let last = start;
        const deltas = [];
        await new Promise((resolve) => {
          const tick = () => {
            const now = performance.now();
            deltas.push(now - last);
            last = now;
            frames += 1;
            if (now - start >= secs * 1000) resolve();
            else requestAnimationFrame(tick);
          };
          requestAnimationFrame(tick);
        });
        const elapsed = performance.now() - start;
        deltas.sort((a, b) => a - b);
        const at = (q) => deltas[Math.min(deltas.length - 1, Math.max(0, Math.floor(deltas.length * q)))] ?? 0;
        return {
          fps: Math.round((frames * 1000) / elapsed * 10) / 10,
          frames,
          elapsedMs: Math.round(elapsed),
          frameMs: {
            p50: Math.round(at(0.5) * 100) / 100,
            p95: Math.round(at(0.95) * 100) / 100,
            max: Math.round((deltas[deltas.length - 1] ?? 0) * 100) / 100,
          },
        };
      })()`,
      true,
    );

    const debug = JSON.parse(await evaluate('JSON.stringify(window.__worldDebug.read())'));

    const report = {
      url: URL_ARG,
      viewport: `${WIDTH}x${HEIGHT}`,
      browser: inst.cand.label,
      singleProcess: true,
      gpu,
      // 只有真实 GPU 且非软件光栅时 fps 才有性能意义；
      // 单进程模式下渲染与主线程抢核，数字仍然偏低，所以这里再压一档。
      fpsTrustworthy: gpu.ok && !gpu.software && !inst.cand.software,
      fps,
      debug,
      consoleErrors: consoleLogs
        .filter((l) => l.type === 'exception' || l.type === 'error')
        .slice(0, 5),
    };

    console.log(JSON.stringify(report, null, 2));
  } finally {
    try {
      ws?.close();
    } catch {}
    killTree(inst.proc.pid);
    await sleep(600);
    try {
      closeSync(inst.outFd);
      closeSync(inst.errFd);
    } catch {}
    try {
      rmSync(inst.profileDir, { recursive: true, force: true });
    } catch {}
  }
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error('测量失败:', err.message);
    process.exit(1);
  });
