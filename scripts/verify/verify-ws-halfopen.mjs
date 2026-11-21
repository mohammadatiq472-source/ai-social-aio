// WebSocket 半开连接回收回归（P0）
//
// 复现的缺陷（ws/hub.mjs 心跳）：以前只 setInterval(() => socket.ping())，
// 没有等 pong、也没有把「上一轮没回」记下来。NAT 超时/手机断网/进程假死时，
// 对端已经不存在，但服务端 socket 仍是 OPEN：ping 永远写不出去、close 永不到来，
// sockets Map 与 wsOnline 只增不减，消息广播一直往死连接上写。
//
// 本脚本自包含：spawn 一个 PORT=8791 / WS_HEARTBEAT_MS=800 的服务（心跳周期可配正是为了测试），
//   1) 用 ws 客户端 { autoPong:false } 连上并忽略 ping → 必须在 ~4s 内被服务端 terminate；
//      断开后 /healthz/full 的 wsOnline 必须回到 0。
//   2) 再用正常客户端（autoPong 默认 true）→ 4s 后仍在 OPEN，wsOnline 为 1。
//
// 用法：node scripts/verify/verify-ws-halfopen.mjs
// 前置：本机 PG 127.0.0.1:5434 库 aio、demo 账号；8791 端口空闲。
import { spawn } from 'node:child_process';
import path from 'node:path';
import WebSocket from 'ws';

const PORT = Number(process.env.TEST_PORT || 8791);
const BASE = `http://127.0.0.1:${PORT}`;
const WS_URL = `ws://127.0.0.1:${PORT}/ws`;
const DB_URL = process.env.LOCAL_DATABASE_URL || 'postgres://postgres@127.0.0.1:5434/aio';
const ROOT = path.resolve('.');

const results = [];
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function check(name, ok, detail = '') {
  results.push({ name, ok });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? '  — ' + detail : ''}`);
}

async function within(promise, ms) {
  let timer;
  const timeout = new Promise((resolve) => {
    timer = setTimeout(() => resolve({ __timedOut: true }), ms);
  });
  const value = await Promise.race([promise, timeout]);
  clearTimeout(timer);
  return value;
}

async function startServer() {
  const child = spawn(process.execPath, ['src/index.mjs'], {
    cwd: ROOT,
    env: {
      ...process.env,
      PORT: String(PORT),
      HOST: '127.0.0.1',
      LOG_LEVEL: 'warn',
      SESSION_SECRET: 'dev-only-secret',
      SECURE_COOKIE: 'false',
      PUBLIC_BASE_URL: BASE,
      DATABASE_URL: DB_URL,
      WRITER_DATABASE_URL: DB_URL,
      MEDIA_DIR: path.resolve('tmp/wsmedia'),
      // 生产 30s（默认）；验证用 800ms —— 半开检测延迟 = 2×周期，4s 内能观察完
      WS_HEARTBEAT_MS: '800',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let log = '';
  const capture = (d) => { log = (log + d.toString()).slice(-8000); };
  child.stdout.on('data', capture);
  child.stderr.on('data', capture);

  let settled = false;
  let resolveReady;
  let rejectReady;
  const ready = new Promise((resolve, rejected) => { resolveReady = resolve; rejectReady = rejected; });
  const fail = (err) => {
    if (settled) return;
    settled = true;
    try { child.kill(); } catch { /* ignore */ }
    rejectReady(err);
  };
  child.once('exit', (code, signal) => {
    fail(new Error(`服务提前退出（code=${code} signal=${signal}）\n--- 服务日志 ---\n${log}`));
  });
  (async () => {
    const deadline = Date.now() + 20_000;
    while (Date.now() < deadline) {
      if (settled || child.exitCode !== null) return;
      try {
        const r = await fetch(`${BASE}/healthz`);
        if (r.ok) {
          settled = true;
          child.removeAllListeners('exit');
          resolveReady({ child, log: () => log });
          return;
        }
      } catch { /* 还没起来 */ }
      await sleep(200);
    }
    fail(new Error(`服务 20s 内未就绪\n--- 服务日志 ---\n${log}`));
  })();
  return ready;
}

async function stopServer(server) {
  if (!server) return;
  const { child } = server;
  if (child.exitCode !== null) return;
  const exited = new Promise((r) => child.once('exit', r));
  try { child.kill('SIGTERM'); } catch { /* ignore */ }
  const ok = await within(exited.then(() => true), 5000);
  if (ok !== true) {
    try { child.kill('SIGKILL'); } catch { /* ignore */ }
    await within(exited, 2000);
  }
}

async function login() {
  const r = await fetch(`${BASE}/api/auth/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ email: 'demo@qqmini.dev', password: 'demo-qqmini-2026' }),
  });
  const text = await r.text();
  if (!r.ok) throw new Error(`demo 登录失败 ${r.status} ${text.slice(0, 160)}`);
  const cookies = r.headers.getSetCookie?.() || [];
  const sid = cookies.map((c) => String(c).split(';')[0]).find((c) => c.startsWith('sid='));
  if (!sid) throw new Error('demo 登录成功但没拿到 sid');
  return sid;
}

async function wsOnline() {
  const r = await fetch(`${BASE}/healthz/full`);
  const json = await r.json().catch(() => null);
  return json?.wsOnline;
}

function openWs(cookie, options = {}) {
  const ws = new WebSocket(WS_URL, {
    headers: { cookie },
    handshakeTimeout: 5000,
    ...options,
  });
  const opened = new Promise((resolve, reject) => {
    ws.once('open', resolve);
    ws.once('error', reject);
  });
  return { ws, opened };
}

let server = null;
let bad = null;
let good = null;
try {
  server = await startServer();
  console.log(`服务已起：${BASE}（WS_HEARTBEAT_MS=800）`);
  const cookie = await login();
  check('准备：demo 登录拿到会话', Boolean(cookie));

  // 1) 半开客户端：autoPong=false，收到 ping 不回 pong
  let pings = 0;
  const a = openWs(cookie, { autoPong: false });
  bad = a.ws;
  bad.on('ping', () => { pings += 1; });
  await within(a.opened, 5000);
  const t0 = Date.now();
  const closed = await within(
    new Promise((resolve) => bad.once('close', (code) => resolve({ code, ms: Date.now() - t0 }))),
    4500,
  );
  const gotClose = closed && !closed.__timedOut;
  check('半开客户端在 ~4s 内被服务端断开（连续 2 个心跳周期无 pong → terminate）',
    gotClose, gotClose ? `close code=${closed.code}，用时 ${closed.ms}ms` : '4.5s 仍是 OPEN —— 死连接没被回收');
  check('服务端确实发过 ping（不是客户端自己超时）', pings >= 1, `收到 ping ${pings} 次`);
  if (!gotClose) bad.terminate();

  await sleep(400);
  const n0 = await wsOnline();
  check('断开后 /healthz/full 的 wsOnline 回到 0', n0 === 0, `wsOnline=${n0}`);

  // 2) 正常客户端：自动回 pong，必须一直在线
  const b = openWs(cookie);
  good = b.ws;
  await within(b.opened, 5000);
  await sleep(4000);
  check('正常客户端 4s 后仍在 OPEN（自动 pong 不被误杀）',
    good.readyState === WebSocket.OPEN, `readyState=${good.readyState}`);
  const n1 = await wsOnline();
  check('正常客户端在线数 = 1', n1 === 1, `wsOnline=${n1}`);
} catch (err) {
  check('脚本执行', false, err.message);
} finally {
  try { bad?.terminate(); } catch { /* ignore */ }
  try { good?.close(); } catch { /* ignore */ }
  await sleep(200);
  await stopServer(server);
  const failed = results.filter((r) => !r.ok);
  console.log(`\n${failed.length === 0 ? '全部通过' : '有失败'}：${results.length - failed.length}/${results.length}`);
  if (failed.length) {
    console.log('失败项：' + failed.map((f) => f.name).join('; '));
    process.exitCode = 1;
  }
}
