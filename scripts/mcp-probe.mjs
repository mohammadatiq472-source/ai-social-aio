#!/usr/bin/env node
// ============================================================================
// scripts/mcp-probe.mjs —— 真实 MCP 客户端冒烟脚本（纯 Node 内置模块，零依赖）
//
// 用法：
//   AGENT_TOKEN=qqa_xxx QQMINI_BASE=http://127.0.0.1:8787 node scripts/mcp-probe.mjs
//
// 可选环境变量：
//   QQMINI_BASE              服务地址（默认 http://127.0.0.1:8787）
//   QQMINI_CONVERSATION_ID   指定发送目标会话（缺省自动挑一个 reply_mode 非 off 的会话）
//   QQMINI_AGENT_ID          该 Agent 的 principal id（缺省从会话成员里的 agent 成员推断）
//   QQMINI_PROBE_STRICT=1    严格模式：门控拦截也算失败（默认只告警不失败）
//   QQMINI_PROBE_TIMEOUT_MS  单请求超时（默认 10000）
//   QQMINI_PROBE_BODY_PREFIX 测试消息前缀（默认「[mcp-probe] 自动化冒烟」）
//
// 流程：initialize → GET 405 检查 → notifications/initialized → tools/list
//      → whats_new → list_conversations → send_message（随机 UUID）
//      → 同一 client_msg_id 重试（验证幂等 deduplicated）
//
// 关于 [C10] 门控（重要）：submit() 目前的顺序是「成员资格 → 限流 → AI 发言门控 → 幂等写」。
//   * 默认 reply_mode=mention 的群里，Agent 发消息要求 mentions 里包含自己，否则 gating_mention_required；
//     本探针会把目标会话里的 agent 成员 id 填进 mentions 以模拟 smoke 场景。
//   * 30 秒内的同 client_msg_id 重试会先撞上 gating_too_fast，看不到 deduplicated:true；
//     这种情况按「接线已知问题」告警（QQMINI_PROBE_STRICT=1 时算失败），不算协议失败。
//
// 退出码：全部通过 0；任一失败 1（可直接用于 CI）。
// ============================================================================

import { randomUUID } from 'node:crypto';

const BASE = (process.env.QQMINI_BASE || 'http://127.0.0.1:8787').replace(/\/+$/, '');
const MCP_URL = `${BASE}/mcp`;
const TOKEN = (process.env.AGENT_TOKEN || process.env.QQMINI_AGENT_TOKEN || '').trim();
const TIMEOUT_MS = Number(process.env.QQMINI_PROBE_TIMEOUT_MS || 10000);
const CONVERSATION_OVERRIDE = process.env.QQMINI_CONVERSATION_ID
  ? Number(process.env.QQMINI_CONVERSATION_ID)
  : null;
const BODY_PREFIX = process.env.QQMINI_PROBE_BODY_PREFIX || '[mcp-probe] 自动化冒烟';
const STRICT = /^(1|true|yes)$/i.test(process.env.QQMINI_PROBE_STRICT || '');
const AGENT_ID_ENV = Number(process.env.QQMINI_AGENT_ID) > 0 ? Number(process.env.QQMINI_AGENT_ID) : null;
// [C10]/限流类拒绝：协议层正常，只是业务门控；严格模式才判失败
const GATING_RE = /^(gating_|rate_limited)/;
const PROTOCOL_VERSION = '2025-06-18';
const CLIENT_INFO = { name: 'qqmini-mcp-probe', version: '0.1.0' };

let stepNo = 0;
let rpcId = 0;
const failures = [];

// ---------------------------------------------------------------------------
// 输出
// ---------------------------------------------------------------------------
function logStep(title) {
  stepNo += 1;
  console.log(`\n[${stepNo}] ${title}`);
}

function ok(message) {
  console.log(`    [ok]   ${message}`);
}

function info(message) {
  console.log(`    [info] ${message}`);
}

function warn(message) {
  console.log(`    [warn] ${message}`);
}

function bad(message) {
  failures.push(message);
  console.error(`    [FAIL] ${message}`);
}

function fail(message, detail) {
  bad(message);
  if (detail !== undefined) console.error(`           ${typeof detail === 'string' ? detail : JSON.stringify(detail)}`);
}

function fatal(message, detail) {
  fail(message, detail);
  summary();
  process.exit(1);
}

function summary() {
  console.log(`\n${'-'.repeat(64)}`);
  if (failures.length) {
    console.error(`PROBE FAILED：${failures.length} 项未通过`);
    for (const f of failures) console.error(`  - ${f}`);
  } else {
    console.log(`PROBE PASSED：${stepNo} 步全部通过（${MCP_URL}）`);
  }
}

function preview(text, max = 80) {
  const s = String(text ?? '').replace(/\s+/g, ' ');
  return s.length > max ? `${s.slice(0, max)}…` : s;
}

// fetch 的网络错误被包了多层（TypeError → cause: AggregateError → errors[]），这里把 errno 挖出来
function describeNetError(err) {
  const codes = new Set();
  const messages = [];
  const walk = (e, depth) => {
    if (!e || typeof e !== 'object' || depth > 4) return;
    if (typeof e.code === 'string') codes.add(e.code);
    if (typeof e.message === 'string' && e.message) messages.push(e.message);
    if (Array.isArray(e.errors)) for (const sub of e.errors) walk(sub, depth + 1);
    if (e.cause) walk(e.cause, depth + 1);
  };
  walk(err, 0);
  if (codes.size) return [...codes].join('/');
  // 没有 errno（如 undici 的 "bad port"）时退到最深一层 message，比 "fetch failed" 有信息量
  const deepest = messages.length ? messages[messages.length - 1] : null;
  return deepest || err?.name || 'network error';
}

// ---------------------------------------------------------------------------
// JSON-RPC over Streamable HTTP（stateless：无 session id、无 SSE）
// ---------------------------------------------------------------------------
async function postJsonRpc(payload) {
  const res = await fetch(MCP_URL, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Accept: 'application/json, text/event-stream',
      Authorization: `Bearer ${TOKEN}`,
    },
    body: JSON.stringify(payload),
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });
  const text = await res.text();
  let json = null;
  if (text.trim()) {
    try {
      json = JSON.parse(text);
    } catch {
      json = { __unparsed: text.slice(0, 500) };
    }
  }
  return { status: res.status, headers: res.headers, json, text };
}

async function rpc(method, params, { notification = false } = {}) {
  const payload = notification
    ? { jsonrpc: '2.0', method, ...(params === undefined ? {} : { params }) }
    : { jsonrpc: '2.0', id: (rpcId += 1), method, ...(params === undefined ? {} : { params }) };
  let res;
  try {
    res = await postJsonRpc(payload);
  } catch (err) {
    const codes = describeNetError(err);
    fatal(
      `${method} 请求失败：${codes}`,
      /ECONNREFUSED|ENOTFOUND|EHOSTUNREACH|ETIMEDOUT/.test(codes)
        ? `连不上 ${MCP_URL} —— 服务没起？先检查 node src/index.mjs 与端口。`
        : (err?.message || String(err)),
    );
  }
  if (res.status === 401) {
    fatal(
      `${method} 鉴权失败（HTTP 401）`,
      `检查 AGENT_TOKEN 是否有效；服务端返回 WWW-Authenticate=${res.headers.get('www-authenticate') || '(无)'}`
        + `；body=${preview(res.text, 200)}`,
    );
  }
  if (notification) return res;
  if (res.status !== 200) {
    fatal(`${method} 期望 HTTP 200，实际 ${res.status}`, preview(res.text, 300));
  }
  if (!res.json || res.json.__unparsed) {
    fatal(`${method} 响应不是 JSON`, preview(res.text, 300));
  }
  if (res.json.error) {
    fatal(
      `${method} 返回 JSON-RPC error ${res.json.error.code}`,
      `${res.json.error.message || ''}${res.json.error.data ? ` data=${JSON.stringify(res.json.error.data)}` : ''}`,
    );
  }
  return res.json;
}

async function callTool(name, args) {
  const res = await rpc('tools/call', { name, arguments: args });
  const result = res.result;
  if (!result || !Array.isArray(result.content) || result.content[0]?.type !== 'text') {
    fatal(`tools/call(${name}) 结果形状不对`, preview(JSON.stringify(result), 300));
  }
  let payload = null;
  try {
    payload = JSON.parse(result.content[0].text);
  } catch {
    fatal(`tools/call(${name}) 的 content[0].text 不是 JSON`, preview(result.content[0].text, 300));
  }
  return { result, payload };
}

// ---------------------------------------------------------------------------
// 0. 环境检查
// ---------------------------------------------------------------------------
console.log('QQ-mini MCP 冒烟探针');
info(`base=${BASE}`);
info(`token=${TOKEN ? `${TOKEN.slice(0, 8)}…（已隐藏，长度 ${TOKEN.length}）` : '(缺失)'}`);

if (!TOKEN) {
  fatal('缺少 AGENT_TOKEN', '用法：AGENT_TOKEN=qqa_... QQMINI_BASE=http://127.0.0.1:8787 node scripts/mcp-probe.mjs');
}
if (!TOKEN.startsWith('qqa_')) {
  info('提示：Agent token 通常以 qqa_ 开头，继续尝试…');
}

const startedAt = Date.now();

// ---------------------------------------------------------------------------
// 1. initialize（版本协商）
// ---------------------------------------------------------------------------
logStep('initialize（版本协商）');
{
  const res = await rpc('initialize', {
    protocolVersion: PROTOCOL_VERSION,
    capabilities: {},
    clientInfo: CLIENT_INFO,
  });
  const r = res.result || {};
  if (r.protocolVersion !== PROTOCOL_VERSION) {
    bad(`protocolVersion 未回显：期望 ${PROTOCOL_VERSION}，实际 ${r.protocolVersion}`);
  } else {
    ok(`protocolVersion=${r.protocolVersion}`);
  }
  if (r.serverInfo?.name !== 'aio' || r.serverInfo?.version !== '0.1.0') {
    bad(`serverInfo 不符：${JSON.stringify(r.serverInfo)}（期望 aio/0.1.0）`);
  } else {
    ok(`serverInfo=${r.serverInfo.name}/${r.serverInfo.version}`);
  }
  if (!r.capabilities || typeof r.capabilities.tools !== 'object') {
    bad(`capabilities.tools 缺失：${JSON.stringify(r.capabilities)}`);
  } else {
    ok('capabilities.tools 已声明');
  }
  if (r.instructions) info(`instructions=${preview(r.instructions, 60)}`);
}

// ---------------------------------------------------------------------------
// 2. GET /mcp 必须 405 + Allow: POST（无 SSE）
// ---------------------------------------------------------------------------
logStep('GET /mcp（无 SSE，期望 405 + Allow: POST）');
{
  let res;
  try {
    res = await fetch(MCP_URL, {
      method: 'GET',
      headers: { Accept: 'text/event-stream', Authorization: `Bearer ${TOKEN}` },
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
  } catch (err) {
    fatal('GET /mcp 请求失败', `${describeNetError(err)}（${MCP_URL}）`);
  }
  if (res.status !== 405) {
    bad(`GET /mcp 期望 405，实际 ${res.status}（是否误开了 SSE？）`);
  } else {
    ok('HTTP 405');
  }
  const allow = res.headers.get('allow') || '';
  if (!/post/i.test(allow)) bad(`Allow 头不符：${allow || '(无)'}（期望 POST）`);
  else ok(`Allow: ${allow}`);
}

// ---------------------------------------------------------------------------
// 3. notifications/initialized（无响应，202/204）
// ---------------------------------------------------------------------------
logStep('notifications/initialized（通知，无 id）');
{
  const res = await rpc('notifications/initialized', undefined, { notification: true });
  if (![200, 202, 204].includes(res.status)) {
    bad(`notifications/initialized 期望 202/204，实际 ${res.status}`);
  } else {
    ok(`HTTP ${res.status}（无正文：${res.text.trim() === '' ? '是' : `否 → ${preview(res.text, 80)}`}）`);
  }
}

// ---------------------------------------------------------------------------
// 4. tools/list
// ---------------------------------------------------------------------------
logStep('tools/list');
{
  const res = await rpc('tools/list', {});
  const tools = res.result?.tools || [];
  const names = tools.map((t) => t.name);
  const expect = ['whats_new', 'send_message', 'list_conversations'];
  info(`tools=${names.join(', ')}`);
  for (const name of expect) {
    if (!names.includes(name)) bad(`缺少工具：${name}`);
  }
  if (!failures.length) ok('3 个工具齐备');
  if (names.length !== 3) info(`提示：工具数为 ${names.length}（本版契约是 3 个）`);
}

// ---------------------------------------------------------------------------
// 5. tools/call whats_new
// ---------------------------------------------------------------------------
logStep('tools/call whats_new（since_seq=0, limit=20）');
let cursor = 0;
{
  const { result, payload } = await callTool('whats_new', { since_seq: 0, limit: 20 });
  if (result.isError) {
    bad(`whats_new 返回 isError:true → ${JSON.stringify(payload)}`);
  } else {
    const events = Array.isArray(payload.events) ? payload.events : [];
    cursor = Number(payload.next_seq || 0);
    ok(`events=${events.length}, next_seq=${cursor}, has_more=${payload.has_more === true}`);
    for (const ev of events.slice(0, 3)) {
      info(
        `#${ev.seq} [${ev.sender_type}] ${ev.sender_name}: ${preview(ev.body, 40)}`
        + ` (conv=${ev.conversation_id}, may_reply=${ev.may_reply})`,
      );
    }
    if (events.length > 3) info(`…另有 ${events.length - 3} 条`);
  }
}

// ---------------------------------------------------------------------------
// 6. tools/call list_conversations（取发送目标）
// ---------------------------------------------------------------------------
logStep('tools/call list_conversations');
let targetConversationId = CONVERSATION_OVERRIDE;
let targetReplyMode = null;
let targetMentions = [];
{
  const { result, payload } = await callTool('list_conversations', {});
  const list = Array.isArray(payload?.conversations) ? payload.conversations : [];
  if (result.isError) {
    bad(`list_conversations 返回 isError:true → ${JSON.stringify(payload)}`);
    if (!Number.isInteger(targetConversationId) || targetConversationId < 1) {
      fatal('无法确定目标会话', '会话列表读取失败且未设置 QQMINI_CONVERSATION_ID');
    }
  } else {
    ok(`conversations=${list.length}`);
    for (const c of list.slice(0, 5)) {
      info(`conv=${c.id} "${preview(c.title, 20)}" last_seq=${c.last_seq} unread=${c.unread} role=${c.role} reply_mode=${c.reply_mode}`);
    }
  }

  let target = null;
  if (Number.isInteger(targetConversationId) && targetConversationId > 0) {
    target = list.find((c) => Number(c.id) === targetConversationId) || null;
    if (!target && list.length) {
      fatal(
        `QQMINI_CONVERSATION_ID=${targetConversationId} 不在该 Agent 的会话列表里`,
        `可选：${list.map((c) => c.id).join(', ') || '(空)'}`,
      );
    }
    if (!target) {
      // 列表读失败但显式指定了会话：继续尝试，让 send_message 自己回 forbidden/not_found
      target = { id: targetConversationId, reply_mode: null, members: [] };
    }
  } else {
    // 优先 reply_mode=free（不要求 @），其次任意非 off 的会话
    const usable = list.filter((c) => c?.reply_mode !== 'off');
    target = usable.find((c) => c.reply_mode === 'free') || usable[0] || list[0] || null;
    if (!target) {
      fatal('没有可用会话，无法测 send_message', '请先把该 Agent 拉进一个群，或设置 QQMINI_CONVERSATION_ID。');
    }
    targetConversationId = Number(target.id);
    info(`自动选择会话 id=${targetConversationId}（reply_mode=${target.reply_mode ?? '?'}；可用 QQMINI_CONVERSATION_ID 覆盖）`);
  }

  targetReplyMode = target.reply_mode ?? null;
  const agentMemberIds = (Array.isArray(target.members) ? target.members : [])
    .filter((m) => m?.type === 'agent')
    .map((m) => Number(m.id))
    .filter((n) => Number.isInteger(n) && n > 0);
  if (AGENT_ID_ENV) agentMemberIds.unshift(AGENT_ID_ENV);
  targetMentions = [...new Set(agentMemberIds)].slice(0, 50);
  if (targetMentions.length) {
    info(`[C10] reply_mode=${targetReplyMode ?? '?'}：submit 现状要求 AI 自身出现在 mentions，将带 mentions=[${targetMentions.join(',')}]`);
  }
}
if (!Number.isInteger(targetConversationId) || targetConversationId < 1) {
  fatal('无法确定目标会话 id', `QQMINI_CONVERSATION_ID=${process.env.QQMINI_CONVERSATION_ID ?? '(未设置)'}`);
}

// ---------------------------------------------------------------------------
// 7. tools/call send_message（随机 UUID 幂等键）
// ---------------------------------------------------------------------------
logStep(`tools/call send_message（conversation_id=${targetConversationId}）`);
const clientMsgId = randomUUID();
const body = `${BODY_PREFIX} ${new Date().toISOString()} id=${clientMsgId.slice(0, 8)}`;
const sendArgs = { conversation_id: targetConversationId, body, client_msg_id: clientMsgId };
if (targetMentions.length) sendArgs.mentions = targetMentions;
let firstSend = null;
let sendSkipped = null;
{
  const { result, payload } = await callTool('send_message', sendArgs);
  if (result.isError) {
    const reason = String(payload?.reason || '');
    if (GATING_RE.test(reason)) {
      sendSkipped = reason;
      warn(`send_message 被 [C10]/限流拦截：reason=${reason}${payload.message ? `（${payload.message}）` : ''}`);
      warn(`协议层链路正常，写路径断言跳过${STRICT ? '' : '（QQMINI_PROBE_STRICT=1 时此项算失败）'}`);
      if (STRICT) bad(`send_message 被门控拦截（reason=${reason}），strict 模式判失败`);
    } else {
      bad(`send_message 返回 isError:true → ${JSON.stringify(payload)}`
        + `（forbidden=不在会话 / invalid_schema=参数 / internal=服务端错误；这是工具级错误，不是协议错误）`);
    }
  } else {
    firstSend = payload;
    ok(`accepted=${payload.accepted}, event_id=${payload.event_id}, seq=${payload.seq}, deduplicated=${payload.deduplicated === true}`);
    if (payload.accepted !== true) bad(`send_message 未 accepted：${JSON.stringify(payload)}`);
    if (!(Number(payload.seq) >= 1)) bad(`send_message 缺少有效 seq：${JSON.stringify(payload)}`);
    if (!(Number(payload.event_id) >= 1)) bad(`send_message 缺少有效 event_id：${JSON.stringify(payload)}`);
  }
}

// ---------------------------------------------------------------------------
// 8. 幂等重试：同一 client_msg_id 必须返回既有 event_id/seq，且 deduplicated:true
//    注意：submit() 目前先做 [C10] 门控再做幂等写，30s 内的重试会先被 gating_too_fast 拦住；
//    这属于接线问题，默认只告警（STRICT=1 时判失败），避免 CI 把业务门控当成协议故障。
// ---------------------------------------------------------------------------
if (firstSend?.accepted === true) {
  logStep('send_message 幂等重试（同一 client_msg_id）');
  const { result, payload } = await callTool('send_message', sendArgs);
  if (result.isError) {
    const reason = String(payload?.reason || '');
    if (GATING_RE.test(reason)) {
      warn(`幂等重试被门控拦住：reason=${reason}`);
      warn('submit() 顺序为 成员资格 → 限流 → [C10] 门控 → 幂等写，30s 内看不到 deduplicated:true');
      warn('建议 Lead 把幂等查询提到门控之前，或对已存在的 (actor_id, client_msg_id) 放行门控');
      if (STRICT) bad('幂等重试被门控拦截（strict 模式）');
    } else {
      bad(`幂等重试返回 isError:true → ${JSON.stringify(payload)}（应返回 deduplicated:true）`);
    }
  } else {
    ok(`event_id=${payload.event_id}, seq=${payload.seq}, deduplicated=${payload.deduplicated === true}`);
    if (payload.deduplicated !== true) {
      bad('幂等重试未返回 deduplicated:true（契约：重复 client_msg_id 返回既有 event_id/seq 且不消耗新 seq）');
    }
    if (Number(payload.event_id) !== Number(firstSend.event_id) || Number(payload.seq) !== Number(firstSend.seq)) {
      bad(`幂等重试的 event_id/seq 与首次不一致：${payload.event_id}/${payload.seq} vs ${firstSend.event_id}/${firstSend.seq}`);
    }
  }
} else if (sendSkipped) {
  info(`首次发送被门控拦截（reason=${sendSkipped}），跳过幂等重试验证。`);
}

// ---------------------------------------------------------------------------
// 9. 结果
// ---------------------------------------------------------------------------
info(`总耗时 ${Date.now() - startedAt}ms；本次游标 next_seq=${cursor}`);
summary();
process.exit(failures.length ? 1 : 0);
