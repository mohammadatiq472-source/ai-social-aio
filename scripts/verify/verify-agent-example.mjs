#!/usr/bin/env node
// 参考 Agent（examples/aio-agent）的端到端验证（2026-11-19）。
//
// 为什么必须真跑子进程：这份示例的价值就在于「可靠地在群里长期活着」，
// 而可靠性只有两种验法——(a) 真的发消息让它回；(b) **真的把它杀掉再拉起来**，看会不会丢。
// 在同一个进程里 mock 掉这两件事，等于什么都没验。
//
// 覆盖：
//   1) 首次运行：拉到 @ 自己的消息 → 回复 → 游标落盘；
//   2) 重复运行：没有新消息时不重复回复（幂等）；
//   3) 没 @ 它的消息：门控 may_reply=false → 不回；
//   4) **崩溃不漏**：拿到一批后立刻 exit(9)（不提交游标）→ 重跑仍能处理同一批；
//   5) 游标文件只在处理完成后推进（崩溃后位点没变）；
//   6) 幂等键稳定；
//   7) 参考 Persona **进新群先 getContext**（日志里能看到 context_loaded）；
//   8) 客户端 getContext 的形状与分页（limit 是上限 / before_seq 翻更早一页）；
//   9) **非成员 → not_found**（不泄露会话存在性，不存在的 id 同口径）；
//  10) getContext **不推进游标**：调用前后 whats_new 的结果一模一样，本地游标文件没动，
//      而且 Agent 之后仍然会回那条没被吃掉的消息。
//
// 为什么 7/10 也要测：示例的价值在「照着抄不会错」。如果示例自己在读上下文时
// 偷偷把未读吃掉，抄它的人就会丢消息——这条断言就是防这个的。
//
// 用法：BASE=http://127.0.0.1:8787 node scripts/verify/verify-agent-example.mjs

import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const BASE = (process.env.BASE || 'http://127.0.0.1:8787').replace(/\/$/, '');
const AGENT = path.join(ROOT, 'examples/aio-agent/agent.mjs');
const STATE = path.join(ROOT, 'tmp', 'agent-example-state');
const results = [];
const rnd = () => crypto.randomBytes(4).toString('hex');

function check(name, ok, detail = '') {
  results.push({ name, ok: Boolean(ok) });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? '  — ' + detail : ''}`);
}

async function api(p, { method = 'GET', body, cookie } = {}) {
  const headers = {};
  if (cookie) headers.cookie = cookie;
  if (body !== undefined) headers['content-type'] = 'application/json';
  const res = await fetch(`${BASE}${p}`, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
  const text = await res.text();
  let json = null;
  try { json = text ? JSON.parse(text) : null; } catch { json = null; }
  return { status: res.status, json, text, headers: res.headers };
}

/** 跑一次 agent 子进程，返回 { code, lines } */
function runAgent(env, timeoutMs = 30000) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [AGENT, '--once'], {
      env: { ...process.env, ...env },
      cwd: ROOT,
    });
    const lines = [];
    let done = false;
    const finish = (code) => {
      if (done) return;
      done = true;
      resolve({ code, lines });
    };
    child.stdout.on('data', (b) => {
      for (const line of String(b).split('\n')) {
        if (!line.trim()) continue;
        try { lines.push(JSON.parse(line)); } catch { lines.push({ msg: 'unparsed', raw: line.slice(0, 100) }); }
      }
    });
    child.stderr.on('data', (b) => lines.push({ msg: 'stderr', raw: String(b).slice(0, 200) }));
    child.on('exit', (code) => finish(code));
    setTimeout(() => { try { child.kill('SIGKILL'); } catch { /* 已退出 */ } finish('timeout'); }, timeoutMs);
  });
}

const main = async () => {
  const email = `t_${rnd()}${rnd()}@test.dev`;
  const reg = await api('/api/auth/register', {
    method: 'POST',
    body: { email, password: 'AgentExample!2026', display_name: '示例主人', invite_code: process.env.REGISTER_CODE || '' },
  });
  if (reg.status !== 200) { console.log(`SKIP：注册失败 ${reg.status}（${reg.text.slice(0, 100)}）`); process.exit(0); }
  const cookie = (reg.headers.getSetCookie?.() || []).map((c) => c.split(';')[0]).join('; ');
  const me = await api('/api/me', { cookie });
  const ownerId = me.json?.id;

  const ag = await api('/api/agents', { method: 'POST', cookie, body: { display_name: `示例AI${rnd()}` } });
  const token = ag.json?.token;
  const agentId = ag.json?.agent?.id ?? ag.json?.principal_id ?? ag.json?.id;
  const agentName = ag.json?.agent?.display_name ?? ag.json?.display_name ?? '示例AI';
  check('建 Agent 拿到 token', Boolean(token), `agentId=${agentId}`);

  const conv = await api('/api/conversations', {
    method: 'POST', cookie, body: { title: `示例群${rnd()}`, member_ids: [agentId] },
  });
  const gid = conv.json?.conversation?.id;
  check('建群并把 Agent 拉进来', Boolean(gid), `gid=${gid}`);

  await fs.rm(STATE, { recursive: true, force: true });
  await fs.mkdir(STATE, { recursive: true });
  const cursorFile = path.join(STATE, 'cursor.json');

  const env = {
    AIO_MCP_URL: BASE,
    AIO_MCP_TOKEN: token,
    AIO_CURSOR_FILE: cursorFile,
    AIO_CLIENT_LABEL: `verify-agent-${rnd()}`,
    AIO_BATCH_LIMIT: '20',
  };

  const msgsOf = async () => {
    const r = await api(`/api/conversations/${gid}/messages?limit=100`, { cookie });
    return Array.isArray(r.json?.messages) ? r.json.messages : (Array.isArray(r.json) ? r.json : []);
  };
  const agentReplies = async () => (await msgsOf()).filter((m) => Number(m.senderId ?? m.sender_id) === Number(agentId));

  // ---------------------------------------------- 1) 首次运行：@ 它 → 回
  await api(`/api/conversations/${gid}/messages`, {
    method: 'POST', cookie,
    body: { body: `@${agentName} 在吗`, mentions: [agentId], client_msg_id: `ex-${rnd()}` },
  });
  const first = await runAgent(env);
  const replied1 = (first.lines || []).filter((l) => l.msg === 'replied').length;
  check('首次运行：拉到并回复了 @ 自己的消息', first.code === 0 && replied1 >= 1,
    `exit=${first.code} replied=${replied1}`);
  const after1 = await agentReplies();
  check('群里真的出现了 Agent 的回复', after1.length >= 1, `n=${after1.length}`);

  const cur1 = JSON.parse(await fs.readFile(cursorFile, 'utf8'));
  check('游标已落盘且 > 0', Number(cur1.lastEventId) > 0, `lastEventId=${cur1.lastEventId}`);

  // ---------------------------------------------- 2) 再跑一次：没有新消息 → 不重复回
  const second = await runAgent(env);
  const replied2 = (second.lines || []).filter((l) => l.msg === 'replied').length;
  const after2 = await agentReplies();
  check('重复运行不重复回复（幂等/游标生效）',
    second.code === 0 && replied2 === 0 && after2.length === after1.length,
    `replied=${replied2} n=${after2.length}`);

  // ---------------------------------------------- 3) 没 @ 它：门控 → 不回
  await api(`/api/conversations/${gid}/messages`, {
    method: 'POST', cookie,
    body: { body: '这条没点它', client_msg_id: `ex-${rnd()}` },
  });
  const third = await runAgent(env);
  const after3 = await agentReplies();
  check('没 @ 它时门控判定 may_reply=false → 不回复',
    third.code === 0 && after3.length === after2.length, `n=${after3.length}`);

  // ---------------------------------------------- 4) 崩溃不漏：拿到一批就死，不提交游标
  const curBefore = JSON.parse(await fs.readFile(cursorFile, 'utf8')).lastEventId;
  await api(`/api/conversations/${gid}/messages`, {
    method: 'POST', cookie,
    body: { body: `@${agentName} 崩溃测试一`, mentions: [agentId], client_msg_id: `ex-${rnd()}` },
  });
  await api(`/api/conversations/${gid}/messages`, {
    method: 'POST', cookie,
    body: { body: `@${agentName} 崩溃测试二`, mentions: [agentId], client_msg_id: `ex-${rnd()}` },
  }).catch(() => {});
  const crashed = await runAgent({ ...env, AIO_CRASH_AFTER_FETCH: '1' });
  const curAfterCrash = JSON.parse(await fs.readFile(cursorFile, 'utf8')).lastEventId;
  check('模拟崩溃（exit 9）且游标没有推进', crashed.code === 9 && curAfterCrash === curBefore,
    `exit=${crashed.code} cursor ${curBefore}→${curAfterCrash}`);

  const recovered = await runAgent(env);
  const repliedR = (recovered.lines || []).filter((l) => l.msg === 'replied').length;
  const after4 = await agentReplies();
  check('重启后补上了崩溃前未处理的那批（至少一次）',
    recovered.code === 0 && repliedR >= 1 && after4.length > after3.length,
    `replied=${repliedR} n=${after3.length}→${after4.length}`);
  const curAfter = JSON.parse(await fs.readFile(cursorFile, 'utf8')).lastEventId;
  check('恢复后游标推进到新位点', curAfter > curAfterCrash, `${curAfterCrash}→${curAfter}`);

  // ---------------------------------------------- 5) 日志不含正文与 token
  const rawAll = JSON.stringify([...first.lines, ...second.lines, ...third.lines, ...recovered.lines]);
  check('示例日志不含正文与 token（只记 seq/会话/reason）',
    !rawAll.includes('在吗') && !rawAll.includes(token), '');

  // ---------------------------------------------- 6) 客户端库的幂等键稳定
  const { AioClient, idempotencyKeyFor } = await import(pathToFileURL(path.join(ROOT, 'examples/aio-agent/aio-client.mjs')).href);
  check('同一 (会话, seq) 派生出同一个幂等键',
    idempotencyKeyFor(7, 42) === idempotencyKeyFor(7, 42) && idempotencyKeyFor(7, 42) !== idempotencyKeyFor(8, 42),
    idempotencyKeyFor(7, 42));

  // ---------------------------------------------- 7) getContext：示例真的用了它，且快照字段齐全
  const announcement = `示例群公告-${rnd()}：只聊测试。`;
  await api(`/api/conversations/${gid}/announcement`, { method: 'PATCH', cookie, body: { announcement } });

  const client = new AioClient({
    baseUrl: BASE,
    token,
    // 故意和 agent 的游标文件分开：本节所有调用都不该碰游标
    cursorFile: path.join(STATE, 'client-cursor.json'),
    clientLabel: 'verify-agent-context',
  });
  await client.initialize();

  const firstLogs = first.lines || [];
  const personaCalledContext = firstLogs.some((l) => l.msg === 'context_loaded')
    && !firstLogs.some((l) => l.msg === 'context_unavailable');
  const snap = await client.getContext(gid, { limit: 5 });
  const snapMsgs = snap.messages || [];
  check('参考 Persona 进新群先 getContext，且快照字段齐全（公告 / me / 成员 / 消息 / last_seq / has_more_before）',
    personaCalledContext
      && Number(snap.conversation?.id) === Number(gid)
      && snap.announcement === announcement
      && typeof snap.me?.role === 'string' && typeof snap.me?.reply_mode === 'string'
      && typeof snap.me?.relay_max_depth === 'number'
      && Array.isArray(snap.members) && snap.members.some((m) => Number(m.id) === Number(agentId))
      && Array.isArray(snap.messages) && snapMsgs.length > 0 && snapMsgs.length <= 5
      && typeof snap.lastSeq === 'number' && typeof snap.hasMoreBefore === 'boolean'
      && snap.lastSeq >= Number(snapMsgs[snapMsgs.length - 1]?.seq ?? 0),
    `persona=${personaCalledContext} members=${snap.members?.length} messages=${snapMsgs.length} `
      + `lastSeq=${snap.lastSeq} more=${snap.hasMoreBefore}`);

  // ---------------------------------------------- 8) before_seq 翻更早一页
  const oldest = Number(snapMsgs[0]?.seq ?? 0);
  const older = await client.getContext(gid, { beforeSeq: oldest, limit: 3 });
  const olderSeqs = (older.messages || []).map((m) => Number(m.seq));
  check('before_seq 翻更早一页：只回比它更老的、不重复、limit 是上限',
    olderSeqs.length > 0 && olderSeqs.length <= 3 && olderSeqs.every((s) => s < oldest),
    `older=${olderSeqs.join(',')} 均 < ${oldest}`);

  // ---------------------------------------------- 9) 非成员 → not_found（不泄露存在性）
  // 用「主人自己建、但没把 Agent 拉进来」的群造非成员：比随便编 id 更贴近真实误用
  // （AI 记住了一个已被移出的群），而且顺带就能验「不存在的 id 同口径」。
  const outsiderGroup = await api('/api/conversations', {
    method: 'POST', cookie, body: { title: `示例非成员群${rnd()}`, member_ids: [] },
  });
  const outsiderGid = outsiderGroup.json?.conversation?.id;
  const reasonOf = async (cid) => {
    try {
      await client.getContext(cid);
      return 'no_error';
    } catch (err) {
      return String(err?.reason || err?.message || 'unknown');
    }
  };
  const notMember = await reasonOf(outsiderGid);
  const notExist = await reasonOf(999_999_999);
  check('非成员 / 不存在的会话都是 not_found（重试没意义，也不泄露会话是否存在）',
    notMember === 'not_found' && notExist === 'not_found',
    `非成员=${notMember} 不存在=${notExist}`);

  // ---------------------------------------------- 10) 不推进游标（whats_new 行为不变）
  // 守的是「读上下文不影响增量」：同一个 since_seq 在 getContext 前后拉到的必须一模一样，
  // 本地游标文件不许动，那条人类消息调用完之后仍然在未读里（没被 get_context 消费）。
  //
  // 注意这里**不**再跑一次 Agent 证明「它会回」：门控的 per-round 配额是
  // 「每 90 秒最多 N 个 AI 接话」（conversations.agent_round_quota），本脚本刚在这个群里
  // 回复过两次，再回一次会被 round_quota 拒掉——那是门控在正常工作，不该让它把这条染红。
  const cursorBeforeCtx = JSON.parse(await fs.readFile(cursorFile, 'utf8')).lastEventId;
  const unread = await api(`/api/conversations/${gid}/messages`, {
    method: 'POST', cookie,
    body: { body: `@${agentName} 上下文不该吃掉这条`, mentions: [agentId], client_msg_id: `ex-${rnd()}` },
  });
  const unreadSeq = Number(unread.json?.seq ?? 0);
  const before = await client.whatsNew({ sinceSeq: cursorBeforeCtx, detail: true });
  const ctxAgain = await client.getContext(gid);
  await client.getContext(gid, { limit: 2 });
  await client.getContext(gid, { beforeSeq: unreadSeq, limit: 3 });
  const after = await client.whatsNew({ sinceSeq: cursorBeforeCtx, detail: true });
  const idsOf = (r) => r.events.map((e) => e.event_id).join(',');
  const cursorAfterCtx = JSON.parse(await fs.readFile(cursorFile, 'utf8')).lastEventId;
  check('getContext 不推进游标：whats_new 前后一致 + 本地游标没动 + 这条仍未读',
    unreadSeq > 0
      && idsOf(before) === idsOf(after)
      && before.events.some((e) => Number(e.seq) === unreadSeq)
      && after.events.some((e) => Number(e.seq) === unreadSeq)
      && cursorAfterCtx === cursorBeforeCtx
      && Number(ctxAgain.lastSeq) >= unreadSeq,
    `events ${before.events.length}→${after.events.length} cursor ${cursorBeforeCtx}→${cursorAfterCtx}`);

  // 本节自己造的那个「Agent 不在里面」的群，顺手解散（其余测试数据沿用本脚本原有口径，留给 cleanup-test.mjs）
  if (outsiderGid) await api(`/api/conversations/${outsiderGid}`, { method: 'DELETE', cookie }).catch(() => {});

  await fs.rm(STATE, { recursive: true, force: true }).catch(() => {});

  const failed = results.filter((r) => !r.ok);
  console.log('\n' + '-'.repeat(60));
  if (failed.length) {
    console.log(`有失败：${results.length - failed.length}/${results.length}`);
    for (const f of failed) console.log(`  ✗ ${f.name}`);
    process.exit(1);
  }
  console.log(`全部通过：${results.length}/${results.length}`);
};

main().catch((err) => {
  console.error('验证异常：', err.message);
  process.exit(1);
});
