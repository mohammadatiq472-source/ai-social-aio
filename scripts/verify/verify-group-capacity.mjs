#!/usr/bin/env node
// 群容量原子约束（外部审查 Q10）—— 并发抢「最后一个名额」必须恰好 1 个成功。
//
// 复现的缺陷：`SELECT count(*)` 与 `INSERT conversation_members` 之间没有任何互斥。
// 两个并发入群请求都读到「还差 1 个」→ 都插入 → 最终 501 人（上限 500）。
// 三个入口都有这条路径：公开群 open 入群（groups#requestJoin）、群主拉人（submit#addMember）、
// 审批通过（groups#decideJoinRequest）。
//
// 修法：事务里先 `SELECT id FROM conversations WHERE id=$1 FOR UPDATE` 锁住会话行，再数人数、
// 再插入（见 submit.mjs#lockGroupAndCount 的注释：为什么选行锁而不是 member_count 冗余列）。
//
// 本脚本自建实例（端口 8795，`MAX_GROUP_MEMBERS=3` 把上限压小；**默认值不动**），
// 用真 HTTP 并发（Promise.all，不靠 sleep 凑时序）分别打三条入口：
//   A. MCP `join_group`：20 个 AI 抢 1 个名额 → 恰好 1 个 joined，19 个 group_full；
//   B. REST `POST /api/conversations/:id/join`：20 个人类账号抢 1 个名额 → 同上；
//   C. REST `POST /api/conversations/:id/members`（群主拉人）：5 个并发抢 1 个名额 → 恰好 1 个。
// 每条都断言：群成员数恰好等于上限、没有重复成员、失败原因一律是 group_full（不是 500）。
//
// 用法：node scripts/verify/verify-group-capacity.mjs
// 前置：本机 PG（DATABASE_URL，默认 5434/aio）；8795 端口空闲。
// 子进程日志写文件（沙箱对管道 stdio 有限制），失败时打印尾部。
import { spawn } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

// config.mjs 在 import 时读 env：这里先给默认值，才能断言「默认上限没被改」
process.env.DATABASE_URL ||= 'postgres://postgres@127.0.0.1:5434/aio';
process.env.WRITER_DATABASE_URL ||= process.env.DATABASE_URL;
process.env.SESSION_SECRET ||= 'dev-only-secret';
const { config } = await import('../../src/config.mjs');

const PORT = Number(process.env.TEST_PORT || 8795);
const BASE = `http://127.0.0.1:${PORT}`;
const ROOT = path.resolve('.');
const LOG_FILE = path.resolve('tmp/group-capacity-server.log');
const MEDIA_DIR = path.resolve('tmp/group-capacity-media');
/** 把上限压到 3：一个群只留 1 个名额，20 个并发请求里只能进 1 个 */
const MAX_MEMBERS = 3;
/** 每轮并发数：真 HTTP 并发，不依赖时钟 */
const CONCURRENCY = 20;

const results = [];
const rnd = () => crypto.randomBytes(4).toString('hex');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function check(name, ok, detail = '') {
  results.push({ name, ok });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? '  — ' + detail : ''}`);
}

async function within(promise, ms) {
  let timer;
  const timeout = new Promise((resolve) => { timer = setTimeout(() => resolve({ __timedOut: true }), ms); });
  const value = await Promise.race([promise, timeout]);
  clearTimeout(timer);
  return value;
}

function serverLog() {
  try { return fs.readFileSync(LOG_FILE, 'utf8'); } catch { return ''; }
}

function startServer() {
  fs.mkdirSync(path.dirname(LOG_FILE), { recursive: true });
  fs.mkdirSync(MEDIA_DIR, { recursive: true });
  const out = fs.openSync(LOG_FILE, 'w');
  return spawn(process.execPath, ['src/index.mjs'], {
    cwd: ROOT,
    env: {
      ...process.env,
      PORT: String(PORT),
      HOST: '127.0.0.1',
      LOG_LEVEL: 'warn',
      SESSION_SECRET: 'dev-only-secret',
      SECURE_COOKIE: 'false',
      PUBLIC_BASE_URL: BASE,
      DATABASE_URL: process.env.DATABASE_URL,
      WRITER_DATABASE_URL: process.env.WRITER_DATABASE_URL,
      MEDIA_DIR,
      // 唯一的测试注入：把单群上限压到 3。生产默认仍是 500（下面有一条断言守着）
      MAX_GROUP_MEMBERS: String(MAX_MEMBERS),
    },
    stdio: ['ignore', out, out],
  });
}

async function waitReady(child) {
  const deadline = Date.now() + 20_000;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) throw new Error(`服务提前退出（code=${child.exitCode}）\n${serverLog().slice(-2000)}`);
    try {
      const r = await fetch(`${BASE}/healthz`);
      if (r.ok) return;
    } catch { /* 还没起来 */ }
    await sleep(200);
  }
  throw new Error(`服务 20s 内未就绪\n${serverLog().slice(-2000)}`);
}

async function stopServer(child) {
  if (!child || child.exitCode !== null) return;
  const exited = new Promise((r) => child.once('exit', r));
  try { child.kill('SIGTERM'); } catch { /* ignore */ }
  const ok = await within(exited.then(() => true), 5000);
  if (ok !== true) {
    try { child.kill('SIGKILL'); } catch { /* ignore */ }
    await within(exited, 2000);
  }
}

async function api(pathname, { method = 'GET', body, cookie, token } = {}) {
  const headers = {};
  if (body !== undefined) headers['content-type'] = 'application/json';
  if (cookie) headers.cookie = cookie;
  if (token) headers.authorization = `Bearer ${token}`;
  const res = await fetch(`${BASE}${pathname}`, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  let json = null;
  try { json = text ? JSON.parse(text) : null; } catch { json = null; }
  const sid = (res.headers.getSetCookie?.() || []).map((c) => String(c).split(';')[0]).find((c) => c.startsWith('sid='));
  return { status: res.status, json, text, cookie: sid || cookie };
}

async function register(name) {
  const r = await api('/api/auth/register', {
    method: 'POST',
    body: {
      email: `t_${rnd()}@test.dev`,
      password: 'passw0rd!x',
      display_name: name,
      invite_code: process.env.REGISTER_CODE || '',
    },
  });
  if (r.status !== 200) throw new Error(`注册失败 ${r.status} ${r.text?.slice(0, 160)}`);
  return { id: Number(r.json.me.id), accountNo: r.json.me.accountNo, cookie: r.cookie };
}

async function befriend(a, b) {
  await api('/api/friends/request', { method: 'POST', cookie: a.cookie, body: { account_no: b.accountNo } });
  await api('/api/friends/accept', { method: 'POST', cookie: b.cookie, body: { principal_id: a.id } });
}

async function createAgent(cookie, name) {
  const r = await api('/api/agents', { method: 'POST', cookie, body: { display_name: name } });
  if (r.status !== 200 || !r.json?.token) throw new Error(`建 AI 失败 ${r.status} ${r.text?.slice(0, 160)}`);
  return { id: Number(r.json.agent.id), token: r.json.token };
}

async function createOpenGroup(cookie, title, memberIds) {
  const g = await api('/api/conversations', { method: 'POST', cookie, body: { title, member_ids: memberIds } });
  const id = Number(g.json?.conversation?.id);
  if (!id) throw new Error(`建群失败 ${g.status} ${g.text?.slice(0, 160)}`);
  const pub = await api(`/api/conversations/${id}/public`, {
    method: 'PATCH', cookie, body: { discoverable: true, join_mode: 'open', description: '容量并发验证' },
  });
  if (pub.status !== 200) throw new Error(`设为公开失败 ${pub.status} ${pub.text?.slice(0, 160)}`);
  return id;
}

/**
 * MCP 初始化单独一轮、join 单独一轮。
 * 为什么要拆：initialize 是一次额外的往返，混在同一个 Promise.all 里会把 20 个 join 错开
 * 一两毫秒——竞态窗口就那么宽，错开之后「无锁」也测不出来（反向验证时 MCP 那一轮曾经假绿）。
 * 先并行 initialize 完，再并行 join，20 个请求才是真正同时到达。
 */
async function mcpInit(token) {
  return api('/mcp', {
    method: 'POST', token,
    body: {
      jsonrpc: '2.0', id: 1, method: 'initialize',
      params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'capacity-verify', version: '1.0.0' } },
    },
  });
}

/** MCP join_group：AI 走 Bearer token */
async function mcpJoin(token, conversationId) {
  const r = await api('/mcp', {
    method: 'POST', token,
    body: { jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'join_group', arguments: { conversation_id: conversationId } } },
  });
  const text = r.json?.result?.content?.[0]?.text;
  let payload = null;
  try { payload = text ? JSON.parse(text) : null; } catch { payload = null; }
  return { status: r.status, isError: r.json?.result?.isError === true, json: payload };
}

async function membersOf(cookie, conversationId) {
  const r = await api(`/api/conversations/${conversationId}/members`, { cookie });
  const members = r.json?.members || [];
  const ids = members.map((m) => Number(m.id ?? m.principalId ?? m.principal_id)).filter((n) => n > 0);
  return { status: r.status, total: Number(r.json?.total ?? members.length), ids, distinct: new Set(ids).size };
}

/** 汇总一组并发结果：成功数 / group_full 数 / 其它失败 / 5xx */
function summarize(rows, classify) {
  const out = { ok: 0, full: 0, other: [], serverError: 0 };
  for (const row of rows) {
    const kind = classify(row);
    if (kind === 'ok') out.ok += 1;
    else if (kind === 'group_full') out.full += 1;
    else out.other.push(kind);
    if (Number(row.status) >= 500) out.serverError += 1;
  }
  return out;
}

const main = async () => {
  let child = null;
  let owner = null;
  const created = { agents: [], groups: [] };
  try {
    child = startServer();
    await waitReady(child);
    check('准备：自建实例就绪（MAX_GROUP_MEMBERS=3）', true, BASE);
    check('默认上限没有被改动（环境里没有 MAX_GROUP_MEMBERS 时仍是 500）',
      config.limits.maxGroupMembers === 500, `config.limits.maxGroupMembers=${config.limits.maxGroupMembers}`);

    // 群主 + 一个好友：群基线 2 人（上限 3 → 只剩 1 个名额）
    owner = await register('容量群主');
    const friend = await register('容量好友');
    await befriend(owner, friend);

    const groupA = await createOpenGroup(owner.cookie, `容量MCP-${rnd()}`, [friend.id]);
    const groupB = await createOpenGroup(owner.cookie, `容量REST-${rnd()}`, [friend.id]);
    const groupC = await createOpenGroup(owner.cookie, `容量拉人-${rnd()}`, [friend.id]);
    created.groups.push(groupA, groupB, groupC);
    const baseA = await membersOf(owner.cookie, groupA);
    const baseB = await membersOf(owner.cookie, groupB);
    const baseC = await membersOf(owner.cookie, groupC);
    check('准备：三个群都是 2 人（上限 3 → 各剩 1 个名额）',
      baseA.total === 2 && baseB.total === 2 && baseC.total === 2,
      `A=${baseA.total} B=${baseB.total} C=${baseC.total}`);

    // ---------------- A. MCP join_group：20 个 AI 抢 1 个名额 ----------------
    const agents = [];
    for (let i = 0; i < CONCURRENCY; i += 1) {
      agents.push(await createAgent(owner.cookie, `容量AI${i}${rnd().slice(0, 4)}`));
    }
    created.agents.push(...agents.map((a) => a.id));
    await Promise.all(agents.map((a) => mcpInit(a.token)));
    const mcpRows = await Promise.all(agents.map((a) => mcpJoin(a.token, groupA)));
    const mcpSum = summarize(mcpRows, (row) => {
      if (row.isError === false && row.json?.joined === true) return 'ok';
      if (row.json?.reason_code === 'group_full') return 'group_full';
      return `其它:${row.json?.reason_code || row.json?.reason || row.status}`;
    });
    const afterA = await membersOf(owner.cookie, groupA);
    check('MCP join_group 并发 20 抢 1：恰好 1 个成功（原子占位）',
      mcpSum.ok === 1, `成功 ${mcpSum.ok} / 满员 ${mcpSum.full} / 其它 ${JSON.stringify(mcpSum.other)}`);
    check('MCP join_group 并发：其余 19 个都是 group_full，不是 500',
      mcpSum.full === CONCURRENCY - 1 && mcpSum.serverError === 0 && mcpSum.other.length === 0,
      `group_full=${mcpSum.full} 5xx=${mcpSum.serverError} 其它=${JSON.stringify(mcpSum.other)}`);
    check('MCP join_group 并发：群成员数恰好 = 上限 3，且没有重复成员',
      afterA.total === MAX_MEMBERS && afterA.distinct === afterA.total,
      `total=${afterA.total} distinct=${afterA.distinct}`);

    // ---------------- B. REST join：20 个人类账号抢 1 个名额 ----------------
    const joiners = [];
    for (let i = 0; i < CONCURRENCY; i += 1) joiners.push(await register(`容量路人${i}`));
    const restRows = await Promise.all(joiners.map((u) => api(`/api/conversations/${groupB}/join`, { method: 'POST', cookie: u.cookie })));
    const restSum = summarize(restRows, (row) => {
      if (row.status === 200 && row.json?.joined === true) return 'ok';
      if (row.json?.error === 'group_full') return 'group_full';
      return `其它:${row.json?.error || row.status}`;
    });
    const afterB = await membersOf(owner.cookie, groupB);
    check('REST join 并发 20 抢 1：恰好 1 个成功',
      restSum.ok === 1, `成功 ${restSum.ok} / 满员 ${restSum.full} / 其它 ${JSON.stringify(restSum.other)}`);
    check('REST join 并发：其余 19 个都是 400 + group_full，不是 500',
      restSum.full === CONCURRENCY - 1 && restSum.serverError === 0 && restSum.other.length === 0,
      `group_full=${restSum.full} 5xx=${restSum.serverError} 其它=${JSON.stringify(restSum.other)}`);
    check('REST join 并发：群成员数恰好 = 上限 3，且没有重复成员',
      afterB.total === MAX_MEMBERS && afterB.distinct === afterB.total,
      `total=${afterB.total} distinct=${afterB.distinct}`);

    // ---------------- C. 群主拉人（add_member）：5 个并发抢 1 个名额 ----------------
    const pullers = agents.slice(0, 5);
    const pullRows = await Promise.all(pullers.map((a) => api(`/api/conversations/${groupC}/members`, {
      method: 'POST', cookie: owner.cookie, body: { principal_id: a.id },
    })));
    const pullSum = summarize(pullRows, (row) => {
      if (row.status === 200 && row.json?.ok === true) return 'ok';
      if (row.json?.error === 'group_full') return 'group_full';
      return `其它:${row.json?.error || row.status}`;
    });
    const afterC = await membersOf(owner.cookie, groupC);
    check('add_member 并发 5 抢 1：恰好 1 个成功（群主同时拉人也受同一把锁）',
      pullSum.ok === 1, `成功 ${pullSum.ok} / 满员 ${pullSum.full} / 其它 ${JSON.stringify(pullSum.other)}`);
    check('add_member 并发：群成员数恰好 = 上限 3，其余都是 group_full、没有 5xx',
      afterC.total === MAX_MEMBERS && afterC.distinct === afterC.total
      && pullSum.full === pullers.length - 1 && pullSum.serverError === 0,
      `total=${afterC.total} distinct=${afterC.distinct} group_full=${pullSum.full} 5xx=${pullSum.serverError}`);

    // ---------------- D. 满了以后再进：单条请求也必须优雅失败（不是 500） ----------------
    const late = await api(`/api/conversations/${groupA}/join`, { method: 'POST', cookie: joiners[0].cookie });
    check('群满后再加入：单条请求返回 400 + group_full（幂等语义，不是 500）',
      late.status === 400 && late.json?.error === 'group_full', `status=${late.status} error=${late.json?.error}`);
  } catch (err) {
    check('脚本执行', false, err.message);
  } finally {
    // 清理：群主解散测试群 + 删除测试 AI（临时账号留给 scripts/cleanup-test.mjs，events 还引用它们）
    if (owner) {
      for (const gid of created.groups) {
        try { await api(`/api/conversations/${gid}`, { method: 'DELETE', cookie: owner.cookie }); } catch { /* ignore */ }
      }
      for (const aid of created.agents) {
        try { await api(`/api/agents/${aid}`, { method: 'DELETE', cookie: owner.cookie }); } catch { /* ignore */ }
      }
    }
    await stopServer(child);
    const failed = results.filter((r) => !r.ok);
    console.log(`\n${failed.length === 0 ? '全部通过' : '有失败'}：${results.length - failed.length}/${results.length}`);
    if (failed.length) {
      console.log('失败项：' + failed.map((f) => f.name).join('; '));
      console.log('--- 服务端日志尾部 ---\n' + serverLog().slice(-1500));
      process.exitCode = 1;
    }
  }
};

main().catch((err) => {
  console.error('验证异常：', err.message);
  process.exitCode = 1;
});
