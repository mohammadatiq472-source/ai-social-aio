#!/usr/bin/env node
// 媒体「先审后发」门（外部审查 Q6）端到端验证。
//
// 复现的缺陷：上传时配了扫描器就先把 `attachments.scan_state` 置成 `pending`，
// 但读路径只过滤 `blocked`——`pending` 照常签出 `/media/:id?e=&s=`。
// 结果是「扫描器 = 事后下架」：上传者可以在判定出来之前把未审图片发到群里，
// 其他成员已经能加载。而 `docs/媒体与富内容模型.md` 写的是「未扫描完的附件对其他成员不可见」。
//
// 本脚本自包含：spawn 一个 `SCAN_PROVIDER=rule` 的独立实例（PORT=8792），
// 因为它必须让新上传的附件**真的**落在 pending，不能靠改数据库造状态。
// 覆盖（同一张图，四种视角/三个扫描态）：
//   1) 上传后 DB 里就是 pending（证明这个实例确实开着扫描器）；
//   2) 上传者本人拿到 url 且能直接 GET（"审核中"预览权）；
//   3) 上传者读消息：有 url、没有 pending 标记；
//   4) 同群另一个 principal（上传者的 AI）经 MCP `whats_new` 读：pending=true、**没有** url / thumbUrl；
//   5) WS 广播帧（全群共用一份字符串）：同样不带 url——不能因为上传者是发送者就把签名广播出去；
//   6) 扫描改 clean 后，另一成员换一个 client_label 重读：拿到 url，且该 url 能 GET 200；
//   7) 扫描改 blocked 后：另一成员看到 blocked 占位、没有 url；之前那个 clean 的 url 变 404；
//   8) 上传者自己也拿不到 blocked 的 url（封禁对所有人一致）。
//
// 用法：node scripts/verify/verify-media-scan-gate.mjs
// 前置：本机 PG 127.0.0.1:5434 库 aio；8792 端口空闲；注册不要求邀请码（或用 REGISTER_CODE 传）。
// 会建 1 个用户 + 1 只 AI + 1 个群，结束尽力清理（软解散群 / 删 AI）。
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import pg from 'pg';
import WebSocket from 'ws';

const PORT = Number(process.env.TEST_PORT || 8792);
const BASE = `http://127.0.0.1:${PORT}`;
const WS_URL = `ws://127.0.0.1:${PORT}/ws`;
const DB_URL = process.env.LOCAL_DATABASE_URL || process.env.DATABASE_URL || 'postgres://postgres@127.0.0.1:5434/aio';
const ROOT = path.resolve('.');
const MEDIA_DIR = path.resolve('tmp/scanmedia');
const results = [];
const rnd = () => crypto.randomBytes(4).toString('hex');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function check(name, ok, detail = '') {
  results.push({ name, ok: Boolean(ok) });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? '  — ' + detail : ''}`);
}
function skip(name, detail = '') {
  results.push({ name, ok: true, skipped: true });
  console.log(`SKIP  ${name}${detail ? '  — ' + detail : ''}`);
}

async function api(p, { method = 'GET', body, cookie } = {}) {
  const headers = {};
  if (cookie) headers.cookie = cookie;
  if (body !== undefined) headers['content-type'] = 'application/json';
  const res = await fetch(`${BASE}${p}`, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
  const text = await res.text();
  let json = null;
  try { json = text ? JSON.parse(text) : null; } catch { json = null; }
  const setCookie = res.headers.getSetCookie?.() || [];
  const sid = setCookie.map((c) => String(c).split(';')[0]).find((c) => c.startsWith('sid='));
  return { status: res.status, json, text, cookie: sid || cookie };
}

async function mcp(token, method, params) {
  const res = await fetch(`${BASE}/mcp`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
  });
  const text = await res.text();
  try { return JSON.parse(text); } catch { return { raw: text }; }
}

async function callTool(token, name, args) {
  const out = await mcp(token, 'tools/call', { name, arguments: args });
  const text = out?.result?.content?.[0]?.text || '';
  let json = null;
  try { json = text ? JSON.parse(text) : null; } catch { json = null; }
  return { isError: Boolean(out?.result?.isError), json, text };
}

/** 1x1 PNG：能通过上传的类型嗅探，体积也远小于任何上限 */
const PNG = Buffer.from(
  '89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c489'
  + '0000000d4944415478da63fcffff3f030005fe02fea72d5c1e0000000049454e44ae426082',
  'hex',
);

async function startServer() {
  // 子进程日志走**文件**而不是管道：某些受限沙箱（Windows 上的 DSH 文件沙箱）禁止子进程
  // 通过命名管道被父进程捕获，`stdio: 'pipe'` 会直接 EPERM。写文件两边都能跑。
  const logPath = path.join(ROOT, 'tmp', 'verify-media-scan-gate.server.log');
  const fd = fs.openSync(logPath, 'w');
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
      // 这一行才是本脚本的重点：没它上传会直接 clean，整条断言就变成空转
      SCAN_PROVIDER: 'rule',
    },
    stdio: ['ignore', fd, fd],
  });
  const readLog = () => {
    try { return String(fs.readFileSync(logPath, 'utf8')).slice(-8000); } catch { return ''; }
  };

  const stop = () => {
    try { child.kill(); } catch { /* ignore */ }
    try { fs.closeSync(fd); } catch { /* ignore */ }
  };
  for (let i = 0; i < 120; i++) {
    if (child.exitCode !== null) throw new Error(`服务提前退出（code=${child.exitCode}）\n--- 服务日志 ---\n${readLog()}`);
    try {
      const r = await fetch(`${BASE}/healthz`);
      if (r.ok) return { stop };
    } catch { /* 还没起来 */ }
    await sleep(250);
  }
  stop();
  throw new Error(`服务 30s 内没有就绪\n--- 服务日志 ---\n${readLog()}`);
}

/** 等 WS 上出现指定会话的 event 帧；返回所有收到的帧（用来断言"广播里没有 url"） */
async function collectWsFrame(cookie, conversationId, action) {
  const ws = new WebSocket(WS_URL, { headers: { cookie } });
  const frames = [];
  ws.on('message', (raw) => { try { frames.push(JSON.parse(raw.toString())); } catch { /* ignore */ } });
  await new Promise((resolve, reject) => {
    ws.once('open', resolve);
    ws.once('error', reject);
  });
  await sleep(150); // 让 hello 先到，避免把 hello 当 event
  const before = frames.length;
  await action();
  const deadline = Date.now() + 4000;
  const found = () => frames.slice(before).find((f) => f.t === 'event' && Number(f.conversationId) === Number(conversationId));
  while (Date.now() < deadline && !found()) await sleep(50);
  const frame = found() || null;
  try { ws.close(); } catch { /* ignore */ }
  return frame;
}

const main = async () => {
  const db = new pg.Client({ connectionString: DB_URL });
  await db.connect();
  let server = null;
  let cookie = null;
  let agentId = null;
  let gid = null;
  const cleanup = async () => {
    if (gid && cookie) { try { await api(`/api/conversations/${gid}`, { method: 'DELETE', cookie }); } catch { /* ignore */ } }
    if (agentId && cookie) { try { await api(`/api/agents/${agentId}`, { method: 'DELETE', cookie }); } catch { /* ignore */ } }
    await db.end().catch(() => {});
    if (server) server.stop();
  };

  try {
    server = await startServer();
    check('准备：SCAN_PROVIDER=rule 实例已起（8792）', true);

    // ---------------------------------------------------------------- 准备：人 + AI + 群 + 上传
    const email = `t_${rnd()}${rnd()}@test.dev`;
    const reg = await api('/api/auth/register', {
      method: 'POST',
      body: { email, password: 'ScanGate!2026', display_name: `扫描门${rnd()}`, invite_code: process.env.REGISTER_CODE || '' },
    });
    if (reg.status !== 200) throw new Error(`注册失败 ${reg.status}（若本地开了邀请制，用 REGISTER_CODE 传一枚码）`);
    cookie = reg.cookie;

    const ag = await api('/api/agents', { method: 'POST', cookie, body: { display_name: `扫描门AI${rnd()}` } });
    const token = ag.json?.token;
    agentId = ag.json?.agent?.id ?? ag.json?.principal_id ?? ag.json?.id ?? null;
    check('准备：建上传者的 AI（第二个 principal，非上传者）', Boolean(token && agentId), `agent=${agentId}`);

    const conv = await api('/api/conversations', { method: 'POST', cookie, body: { title: `扫描门验证-${rnd()}`, member_ids: [agentId] } });
    gid = conv.json?.conversation?.id ?? null;
    check('准备：建群并把 AI 拉进来', Boolean(gid), `conversation=${gid}`);

    await mcp(token, 'initialize', {
      protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'scan-gate-verify', version: '1' },
    });

    const up = await fetch(`${BASE}/api/attachments`, {
      method: 'POST',
      headers: { 'content-type': 'image/png', cookie, 'content-length': String(PNG.length) },
      body: PNG,
    });
    const upJson = await up.json().catch(() => null);
    const attId = Number(upJson?.attachment?.id);
    if (!attId) throw new Error(`上传失败 ${up.status} ${JSON.stringify(upJson)}`);

    // ---------------------------------------------------------------- 1) 上传即 pending
    const { rows: att } = await db.query('SELECT scan_state, uploader_id FROM attachments WHERE id=$1', [attId]);
    check('1) 上传后 DB 里是 pending（证明确实开着扫描器）', att[0]?.scan_state === 'pending',
      `scan_state=${att[0]?.scan_state}`);

    // ---------------------------------------------------------------- 2) 上传者预览权
    const upUrl = String(upJson?.attachment?.url || '');
    const upPreview = upUrl ? await fetch(new URL(upUrl, BASE)) : { status: 0 };
    check('2) 上传接口给自己 url，且能直接 GET（审核中预览）', Boolean(upUrl) && upPreview.status === 200,
      `status=${upPreview.status}`);

    // ---------------------------------------------------------------- 3) 发进群
    const sent = await api(`/api/conversations/${gid}/messages`, {
      method: 'POST', cookie,
      body: { body: '', parts: [{ type: 'image', attachment_id: attId }], client_msg_id: `scan-${rnd()}` },
    });
    check('3) 图片消息照常入库（扫描未完成不阻塞发送）', sent.status === 200 && Number(sent.json?.seq) > 0,
      `status=${sent.status} seq=${sent.json?.seq}`);

    // ---------------------------------------------------------------- 4) 上传者读消息：有 url
    const list = await api(`/api/conversations/${gid}/messages?since_seq=0&limit=50`, { cookie });
    const mine = (list.json?.messages || []).flatMap((m) => m.parts || []).find((p) => Number(p?.attachment_id) === attId);
    check('4) 上传者视角：有 url、无 pending（自己看得到自己的审核中图）',
      Boolean(mine?.url) && !mine?.pending, `url=${Boolean(mine?.url)} pending=${mine?.pending}`);

    // ---------------------------------------------------------------- 5) 另一成员（AI）：只有占位
    const asAgent = await callTool(token, 'whats_new', {
      detail: true, limit: 50, conversation_ids: [gid], since_seq: 0,
    });
    const agentPart = (asAgent.json?.events || []).flatMap((e) => e.parts || [])
      .find((p) => Number(p?.attachment_id) === attId);
    check('5) 非上传者（AI）读到 pending=true 且没有 url/thumbUrl',
      Boolean(agentPart) && agentPart.pending === true && !agentPart.url && !agentPart.thumbUrl,
      `pending=${agentPart?.pending} url=${agentPart?.url ? '有' : '无'} thumb=${agentPart?.thumbUrl ? '有' : '无'}`);

    // ---------------------------------------------------------------- 6) WS 广播帧：不带签名
    const frame = await collectWsFrame(cookie, gid, async () => {
      await api(`/api/conversations/${gid}/messages`, {
        method: 'POST', cookie,
        body: { body: '第二个同图', parts: [{ type: 'image', attachment_id: attId }], client_msg_id: `scan-ws-${rnd()}` },
      });
    });
    const framePart = (frame?.parts || []).find((p) => Number(p?.attachment_id) === attId);
    check('6) WS 广播帧：pending 附件不带 url（帧是全群共用的一份字符串）',
      Boolean(frame) && Boolean(framePart) && !framePart.url && !framePart.thumbUrl && framePart.pending === true,
      `frame=${Boolean(frame)} url=${framePart?.url ? '有' : '无'} pending=${framePart?.pending}`);

    // ---------------------------------------------------------------- 7) 扫描改 clean：非上传者拿到 url
    await db.query("UPDATE attachments SET scan_state='clean' WHERE id=$1", [attId]);
    const afterClean = await callTool(token, 'whats_new', {
      detail: true, limit: 50, conversation_ids: [gid], since_seq: 0,
    });
    const cleanPart = (afterClean.json?.events || []).flatMap((e) => e.parts || [])
      .find((p) => Number(p?.attachment_id) === attId);
    const cleanGet = cleanPart?.url ? await fetch(new URL(cleanPart.url, BASE)) : { status: 0 };
    check('7) 扫描通过后：非上传者拿到 url 且可取（200）',
      Boolean(cleanPart?.url) && !cleanPart?.pending && cleanGet.status === 200,
      `url=${cleanPart?.url ? '有' : '无'} get=${cleanGet.status}`);

    // ---------------------------------------------------------------- 8) 判定违规：所有人 404
    await db.query("UPDATE attachments SET scan_state='blocked' WHERE id=$1", [attId]);
    const afterBlocked = await callTool(token, 'whats_new', {
      detail: true, limit: 50, conversation_ids: [gid], since_seq: 0,
    });
    const blockedPart = (afterBlocked.json?.events || []).flatMap((e) => e.parts || [])
      .find((p) => Number(p?.attachment_id) === attId);
    const staleGet = cleanPart?.url ? await fetch(new URL(cleanPart.url, BASE)) : { status: 0 };
    const blockedEvents = afterBlocked.json?.events || [];
    check('8) 判定违规后：非上传者看到 blocked 占位、无 url',
      blockedPart?.blocked === true && !blockedPart?.url,
      `events=${blockedEvents.length} isErr=${afterBlocked.isError} raw=${String(afterBlocked.text || '').slice(0, 220)}`);
    check('9) 判定违规后：之前签出的 clean url 变 404（不靠"新请求才拦"）', staleGet.status === 404,
      `status=${staleGet.status}`);

    // ---------------------------------------------------------------- 10) 上传者本人也不破例
    const listBlocked = await api(`/api/conversations/${gid}/messages?since_seq=0&limit=50`, { cookie });
    const mineBlocked = (listBlocked.json?.messages || []).flatMap((m) => m.parts || [])
      .find((p) => Number(p?.attachment_id) === attId);
    check('10) 上传者视角同样拿到 blocked 占位（封禁不因"是我传的"而例外）',
      mineBlocked?.blocked === true && !mineBlocked?.url,
      `blocked=${mineBlocked?.blocked} url=${mineBlocked?.url ? '有' : '无'}`);
  } catch (err) {
    check('脚本执行', false, err.message);
  } finally {
    await cleanup();
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
