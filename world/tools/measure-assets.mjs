#!/usr/bin/env node
/**
 * M2 资产管线验收（浏览器内指标）。
 *
 * 为什么需要这个脚本：
 * spec §6 M2 的两条验收 —— "加载耗时" 与 "3 个染色变体同屏时 geometries 不线性增长" ——
 * 只能在真浏览器里量（需要 WebGL 上下文与 renderer.info）。
 *
 * render-agent 的会话沙箱起不了浏览器（mojo 命名管道被拒），所以这些数字**未实测**。
 * 这个脚本就是把它做成可复跑的，由 lead 在能起浏览器的会话里跑一次，把输出回填交接文档。
 *
 * 用法：
 *   node tools/measure-assets.mjs [url] [--exe=<chromium 路径>] [--json]
 *
 * 输出（JSON）：
 *   {
 *     ok, bytes, loadMs,       // 加载耗时
 *     geometries1/2/3,         // 1/2/3 个变体同屏时的 geometry 计数
 *     geometriesLinear,        // 是否随变体线性增长（期望 false）
 *     drawCalls, triangles,
 *     heightM,                 // 归一化后的高度（期望 ≈1.62）
 *     feetOnGround,            // 脚底是否贴地（期望 true）
 *     animations             // 识别到的动画名
 *   }
 */

import { spawn } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync, openSync, closeSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const URL_ARG = process.argv[2]?.startsWith('--') ? 'http://127.0.0.1:5180/' : (process.argv[2] ?? 'http://127.0.0.1:5180/');
const exeArg = process.argv.find((a) => a.startsWith('--exe='));
const asJson = process.argv.includes('--json');
const PORT = 9460 + Math.floor(Math.random() * 30);
const LOCAL = process.env.LOCALAPPDATA ?? '';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const CANDIDATES = [
  exeArg ? exeArg.slice(6) : null,
  'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
  join(LOCAL, 'ms-playwright', 'chromium-1217', 'chrome-win64', 'chrome.exe'),
  join(LOCAL, 'ms-playwright', 'chromium_headless_shell-1243', 'chrome-headless-shell-win64', 'chrome-headless-shell.exe'),
].filter(Boolean);

function killTree(pid) {
  if (!pid) return;
  try {
    if (process.platform === 'win32') spawn('taskkill', ['/PID', String(pid), '/T', '/F'], { stdio: 'ignore' });
    else process.kill(pid, 'SIGKILL');
  } catch {}
}

async function launch() {
  const profileDir = mkdtempSync(join(tmpdir(), 'aio-assets-'));
  const outFd = openSync(join(profileDir, 'o.log'), 'w');
  const errFd = openSync(join(profileDir, 'e.log'), 'w');

  for (const exe of CANDIDATES) {
    if (!exe || !existsSync(exe)) continue;
    const proc = spawn(
      exe,
      [
        '--headless',
        '--single-process',
        '--no-zygote',
        '--disable-dev-shm-usage',
        `--remote-debugging-port=${PORT}`,
        `--user-data-dir=${profileDir}/profile`,
        '--window-size=1920,1080',
        '--no-first-run',
        '--no-default-browser-check',
        '--no-sandbox',
        '--disable-gpu-sandbox',
        '--use-gl=swiftshader',
        '--enable-unsafe-swiftshader',
        '--hide-scrollbars',
        '--mute-audio',
        '--disable-crash-reporter',
        '--noerrdialogs',
        'about:blank',
      ],
      { stdio: ['ignore', outFd, errFd], detached: true, windowsHide: true },
    );
    proc.unref();

    const deadline = Date.now() + 25_000;
    while (Date.now() < deadline) {
      await sleep(400);
      try {
        const ver = await (await fetch(`http://127.0.0.1:${PORT}/json/version`)).json();
        return { proc, profileDir, outFd, errFd, exe, version: ver };
      } catch {}
    }
    killTree(proc.pid);
    const stderr = (() => {
      try {
        return readFileSync(join(profileDir, 'e.log'), 'utf8');
      } catch {
        return '';
      }
    })();
    console.error(`[assets] ${exe} 起不来：${stderr.split('\n').filter(Boolean).slice(0, 2).join(' | ')}`);
  }

  closeSync(outFd);
  closeSync(errFd);
  rmSync(profileDir, { recursive: true, force: true });
  return null;
}

let ws = null;
let msgId = 0;
const pending = new Map();
const logs = [];

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
    }, 120_000);
  });
}

async function evaluate(expression, awaitPromise = false) {
  const r = await send('Runtime.evaluate', { expression, awaitPromise, returnByValue: true });
  if (r.exceptionDetails) {
    const d = r.exceptionDetails;
    throw new Error(`页面内求值失败: ${d.text ?? ''} ${d.exception?.description ?? ''}`);
  }
  return r.result.value;
}

async function main() {
  const inst = await launch();
  if (!inst) throw new Error('所有候选浏览器都起不来（本机沙箱可能禁止 mojo 命名管道）');
  console.error(`[assets] 使用 ${inst.exe}`);

  try {
    const targets = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json();
    const page = targets.find((t) => t.type === 'page');
    if (!page) throw new Error('没有 page target');

    ws = new WebSocket(page.webSocketDebuggerUrl);
    await new Promise((res, rej) => {
      ws.onopen = res;
      ws.onerror = rej;
      setTimeout(() => rej(new Error('WS 超时')), 20_000);
    });
    ws.onmessage = (ev) => {
      const m = JSON.parse(ev.data);
      if (m.id && pending.has(m.id)) {
        const { resolve, reject } = pending.get(m.id);
        pending.delete(m.id);
        m.error ? reject(new Error(m.error.message)) : resolve(m.result);
        return;
      }
      if (m.method === 'Runtime.consoleAPICalled') {
        logs.push({ type: m.params.type, text: (m.params.args ?? []).map((a) => a.value ?? a.description ?? '').join(' ') });
      }
      if (m.method === 'Runtime.exceptionThrown') {
        logs.push({ type: 'exception', text: m.params.exceptionDetails?.exception?.description ?? '' });
      }
    };

    await send('Page.enable');
    await send('Runtime.enable');
    await send('Emulation.setDeviceMetricsOverride', { width: 1920, height: 1080, deviceScaleFactor: 1, mobile: false });
    await send('Page.navigate', { url: URL_ARG });

    // 等页面里的资产探针就绪（需要应用暴露 __worldAssets）
    const deadline = Date.now() + 60_000;
    let ready = false;
    while (Date.now() < deadline) {
      await sleep(700);
      try {
        ready = await evaluate('typeof window.__worldAssets !== "undefined"');
        if (ready) break;
      } catch {}
    }
    if (!ready) {
      throw new Error(
        'window.__worldAssets 未出现。\n' +
          '需要 dev 构建里挂上资产探针（main.ts 的 installDebug 已预留位置）。\n' +
          `页面异常：${JSON.stringify(logs.filter((l) => l.type === 'exception').slice(0, 2))}`,
      );
    }

    const report = await evaluate('window.__worldAssets.measure()', true);

    if (asJson) {
      console.log(JSON.stringify(report, null, 2));
    } else {
      console.log('M2 资产管线验收（浏览器内实测）');
      console.log('');
      console.log(`  资产字节        ${report.bytes} bytes (${(report.bytes / 1024 / 1024).toFixed(2)} MB)`);
      console.log(`  加载耗时        ${report.loadMs} ms`);
      console.log(`  归一化高度      ${report.heightM} m（目标 1.62）`);
      console.log(`  脚底贴地        ${report.feetOnGround ? '✓' : '✗'}`);
      console.log(`  识别动画        ${report.animations?.length ?? 0} 个`);
      console.log('');
      console.log(`  geometries（1 变体）  ${report.geometries1}`);
      console.log(`  geometries（2 变体）  ${report.geometries2}`);
      console.log(`  geometries（3 变体）  ${report.geometries3}`);
      console.log(`  随变体线性增长        ${report.geometriesLinear ? '✗ 是（染色没共享几何）' : '✓ 否（共享成功）'}`);
      console.log('');
      console.log(`  drawCalls       ${report.drawCalls}`);
      console.log(`  triangles       ${report.triangles}`);
    }

    const ok = report.feetOnGround === true && report.geometriesLinear === false;
    if (!ok) process.exitCode = 1;
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

main().catch((err) => {
  console.error('测量失败:', err.message);
  process.exit(1);
});
