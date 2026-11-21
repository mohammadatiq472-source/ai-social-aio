// 上传并发闸门「名额泄漏」回归（P0）
//
// 复现的缺陷（routes.mjs 的 preParsing）：
//   await acquireUploadSlot() 之后才挂 req.raw 的 close/error 监听。
//   如果客户端在**排队期间**就断开，close 事件早已发完，监听永远挂不上；
//   等到前面的上传结束、队列把名额交给这个已断的请求时，它再也还不了名额。
//   闸门槽位是常数（UPLOAD_CONCURRENCY），漏一个就少一个：漏满后所有上传永久挂起。
//
// 本脚本自包含：自己 spawn 一个 PORT=8790 / UPLOAD_CONCURRENCY=1 的服务，只做三件事：
//   A 慢速上传（分块写、每块 sleep）占住唯一名额；
//   B 在队列里等待时 abort（客户端断开）；
//   A 完成后，C 必须能成功 —— 若名额泄漏，C 会一直挂在 preParsing（20s 超时判 FAIL）。
// 最后检查 MEDIA_DIR 没有 .part/.tmp 残留、成功上传的文件数正确，并杀掉自己 spawn 的服务。
//
// 用法：node scripts/verify/verify-upload-slot-leak.mjs
// 前置：本机 PG 127.0.0.1:5434 库 aio（postgres 无密码）、demo 账号；
//       8790 端口空闲。脚本会自己清理 tmp/leakmedia 与本次上传的 attachments 行。
import { spawn } from 'node:child_process';
import crypto from 'node:crypto';
import fsp from 'node:fs/promises';
import http from 'node:http';
import path from 'node:path';
import pg from 'pg';

const PORT = Number(process.env.TEST_PORT || 8790);
const BASE = `http://127.0.0.1:${PORT}`;
// 自建服务必须指向本机库；不继承外部环境里可能指向别处的 DATABASE_URL
const DB_URL = process.env.LOCAL_DATABASE_URL || 'postgres://postgres@127.0.0.1:5434/aio';
const MEDIA_DIR = path.resolve(process.env.TEST_MEDIA_DIR || 'tmp/leakmedia');
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
      MEDIA_DIR,
      UPLOAD_CONCURRENCY: '1',
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
      if (settled) return;
      if (child.exitCode !== null) return;
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

/** 内容各不相同的「PNG」：嗅探只看文件头，>=64 字节才会被 saveAttachment 接收 */
function pngBytes(tag) {
  const body = Buffer.alloc(64 * 1024, 0);
  Buffer.from(tag).copy(body, 0);
  crypto.randomFillSync(body, 16);
  return Buffer.concat([Buffer.from('89504e470d0a1a0a', 'hex'), body]);
}

/**
 * 一个可控的上传请求：先 flushHeaders（让服务端立刻进入 preParsing/排队），
 * 再按需写 body；done 在拿到响应或出错时 resolve，永不 reject。
 */
function makeUpload(cookie, body, { gapMs = 50 } = {}) {
  let offset = 0;
  let settled = false;
  let resolveDone;
  const done = new Promise((r) => { resolveDone = r; });
  const req = http.request({
    host: '127.0.0.1',
    port: PORT,
    method: 'POST',
    path: '/api/attachments',
    agent: false, // 关键：每个请求独立连接，避免 keep-alive 复用 A 的 socket 让 B 根本没发出去
    headers: {
      cookie,
      'content-type': 'image/png',
      'content-length': String(body.length),
      'user-agent': 'aio-verify-upload-slot-leak',
    },
  });
  req.on('response', (res) => {
    const chunks = [];
    res.on('data', (c) => chunks.push(c));
    res.on('end', () => {
      const text = Buffer.concat(chunks).toString('utf8');
      let json = null;
      try { json = JSON.parse(text); } catch { /* 非 JSON */ }
      if (!settled) {
        settled = true;
        resolveDone({ status: res.statusCode, json, text });
      }
    });
  });
  req.on('error', (err) => {
    if (!settled) {
      settled = true;
      resolveDone({ status: 0, json: null, text: '', error: err.code || err.message });
    }
  });
  req.flushHeaders();
  return {
    done,
    get offset() { return offset; },
    async push(nBytes, gap = gapMs) {
      if (offset >= body.length) return;
      const end = Math.min(body.length, offset + nBytes);
      req.write(body.subarray(offset, end));
      offset = end;
      await sleep(gap);
    },
    async pushRest() {
      while (offset < body.length) await this.push(2048);
    },
    finish() { try { req.end(); } catch { /* ignore */ } },
    endWithBody() { try { req.end(body.subarray(offset)); } catch { /* ignore */ } offset = body.length; },
    abort() { try { req.destroy(); } catch { /* ignore */ } },
  };
}

async function listFiles(dir) {
  const out = [];
  async function walk(d) {
    let entries;
    try { entries = await fsp.readdir(d, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      const p = path.join(d, e.name);
      if (e.isDirectory()) await walk(p);
      else out.push(path.relative(dir, p).split(path.sep).join('/'));
    }
  }
  await walk(dir);
  return out;
}

async function deleteAttachmentRows(ids) {
  if (!ids.length) return;
  const client = new pg.Client({ connectionString: DB_URL });
  try {
    await client.connect();
    await client.query('DELETE FROM attachments WHERE id = ANY($1::bigint[])', [ids]);
  } catch (err) {
    console.log(`（清理 attachments 行失败，不影响结论：${err.message}）`);
  } finally {
    await client.end().catch(() => {});
  }
}

let server = null;
const attachmentIds = [];
try {
  await fsp.rm(MEDIA_DIR, { recursive: true, force: true });
  server = await startServer();
  console.log(`服务已起：${BASE}（UPLOAD_CONCURRENCY=1，MEDIA_DIR=${path.relative(ROOT, MEDIA_DIR)}）`);

  const cookie = await login();
  check('准备：demo 登录拿到会话', Boolean(cookie));

  // A：慢速上传，占住唯一名额（首块 + 多段 sleep）
  const bodyA = pngBytes('SLOT-A');
  const A = makeUpload(cookie, bodyA);
  await A.push(4096);
  await sleep(500); // 等服务端真正进入 preParsing 并持有名额

  // B：排在队列里，然后客户端 abort
  const bodyB = pngBytes('SLOT-B');
  const B = makeUpload(cookie, bodyB);
  await B.push(1024);
  await sleep(500);
  B.abort();
  console.log('B 已在排队期间由客户端 abort');
  await sleep(300);

  // 让 A 完成 → 队列把名额交给已断开的 B（缺陷触发点）
  await A.pushRest();
  A.finish();
  const aRes = await within(A.done, 15_000);
  check('A 慢速上传成功（占位期间没有被别人抢/or 泄漏）',
    aRes.status === 200 && aRes.json?.attachment?.id > 0,
    aRes.__timedOut ? '15s 超时' : `status=${aRes.status} id=${aRes.json?.attachment?.id ?? '-'}`);
  if (aRes.json?.attachment?.id) attachmentIds.push(aRes.json.attachment.id);

  // C：必须能拿到名额。泄漏时它会一直挂在 preParsing。
  const bodyC = pngBytes('SLOT-C');
  const C = makeUpload(cookie, bodyC);
  C.endWithBody();
  const cRes = await within(C.done, 20_000);
  const cOk = !cRes.__timedOut && cRes.status === 200 && cRes.json?.attachment?.id > 0;
  check('C 在 A 完成后成功上传（名额已归还）', cOk,
    cRes.__timedOut ? '20s 无响应 —— 闸门名额泄漏（排队中断的 B 没有归还）' : `status=${cRes.status} id=${cRes.json?.attachment?.id ?? '-'}`);
  if (cRes.json?.attachment?.id) attachmentIds.push(cRes.json.attachment.id);
  if (cRes.__timedOut) C.abort();

  await sleep(500);
  const files = await listFiles(MEDIA_DIR);
  const partFiles = files.filter((f) => f.includes('/tmp/') || /\.(part|tmp-[0-9a-f]+)$/.test(f));
  const finalFiles = files.filter((f) => !f.includes('/tmp/') && !partFiles.includes(f));
  check('MEDIA_DIR 没有 .part / tmp 残留（中断的上传被清掉）', partFiles.length === 0,
    partFiles.length ? `残留=${partFiles.slice(0, 5).join(', ')}` : `0 个（文件 ${files.length} 个）`);
  check('成功上传各留一份最终文件（A、C 共 2 个）', finalFiles.length === 2,
    `最终文件=${finalFiles.length}：${finalFiles.join(', ') || '无'}`);
} catch (err) {
  check('脚本执行', false, err.message);
} finally {
  await stopServer(server);
  await deleteAttachmentRows(attachmentIds);
  await fsp.rm(MEDIA_DIR, { recursive: true, force: true }).catch(() => {});
  const failed = results.filter((r) => !r.ok);
  console.log(`\n${failed.length === 0 ? '全部通过' : '有失败'}：${results.length - failed.length}/${results.length}`);
  if (failed.length) {
    console.log('失败项：' + failed.map((f) => f.name).join('; '));
    process.exitCode = 1;
  }
}
