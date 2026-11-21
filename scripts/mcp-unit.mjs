#!/usr/bin/env node
// ============================================================================
// scripts/mcp-unit.mjs —— MCP 协议层桩测试（纯 Node，零依赖，不需要 Fastify / PostgreSQL）
//
// 用法：node scripts/mcp-unit.mjs
// 覆盖：initialize（版本协商）→ tools/list → tools/call(whats_new)
//      → tools/call(send_message 缺参 → isError) → tools/call(send_message 合法)
//      → 工具级错误（gating/forbidden/rate_limited 不 5xx）→ 未知方法
//      → 无 token（401 + WWW-Authenticate）→ 批量/通知 → GET /mcp 405 → 日志不泄露正文
// 退出码：全绿 0，任一失败 1。
// ============================================================================

import { createMcp, SUPPORTED_PROTOCOL_VERSIONS, LATEST_PROTOCOL_VERSION } from '../src/mcp/server.mjs';
import mcpRoutes from '../src/mcp/server.mjs';

// ---------------------------------------------------------------------------
// 迷你断言框架
// ---------------------------------------------------------------------------
let passed = 0;
const failures = [];

function check(name, cond, detail) {
  if (cond) {
    passed += 1;
    console.log(`  \u2713 ${name}`);
  } else {
    failures.push(name);
    console.error(`  \u2717 ${name}${detail === undefined ? '' : ` \u2014 ${detail}`}`);
  }
}

async function group(title, fn) {
  console.log(`\n[${title}]`);
  try {
    await fn();
  } catch (err) {
    check(`${title} \u672a\u629b\u5f02\u5e38`, false, err && err.stack ? err.stack.split('\n')[0] : String(err));
  }
}

function eq(actual, expected) {
  return JSON.stringify(actual) === JSON.stringify(expected);
}

// ---------------------------------------------------------------------------
// 桩：Agent 身份 / 写入口 submit / 读接口 query / 日志捕获
// ---------------------------------------------------------------------------
const TOKEN = `qqa_${'a'.repeat(48)}`;
const ACTOR = {
  id: 7,
  type: 'agent',
  displayName: '小助手',
  ownerUserId: 1,
  tokenId: 3,
  clientLabel: 'unit',
  agentStatus: 'active',
};

const calls = { auth: [], submit: [], whatsNew: [], digest: [], listConversations: [], cursorGet: [], cursorSet: [], discoverGroups: [], requestJoin: [] };

// 服务端代存游标（agent_cursors）的假实现
let cursorValue = 0;

// 队列式 submit 行为，便于按用例切换返回值
let submitImpl = async (command) => ({
  accepted: true,
  event_id: 900,
  seq: 7,
  conversation_id: command.conversation_id,
  deduplicated: false,
});
let whatsNewImpl = async () => ({
  events: [{
    eventId: 901,
    conversationId: 42,
    seq: 11,
    senderId: 5,
    senderName: '小白',
    senderType: 'user',
    body: '在吗',
    mentions: [7],
    replyToSeq: null,
    createdAt: '2026-11-12T00:00:00.000Z',
    mayReply: true,
  }],
  nextSeq: 901,
  hasMore: false,
});
let digestImpl = async () => ({
  sinceEventId: 5,
  nextSeq: 901,
  total: 3,
  hasMore: false,
  conversations: [{
    conversationId: 42,
    title: '测试群',
    count: 3,
    lastSeq: 11,
    firstAt: '2026-11-12T00:00:00.000Z',
    lastAt: '2026-11-12T00:01:00.000Z',
    senders: { 小白: 3 },
    senderCount: 1,
    sendersTruncated: false,
    mentionsMe: [11],
  }],
});
let conversationsImpl = async () => ([{
  id: 42,
  type: 'group',
  title: '测试群',
  lastSeq: 10,
  lastReadSeq: 7,
  unread: 3,
  role: 'member',
  replyMode: 'mention',
  lastMessagePreview: '在吗',
  lastMessageAt: '2026-11-12T00:00:00.000Z',
  members: [
    { id: 5, type: 'user', displayName: '小白', avatarHue: 200, role: 'owner', replyMode: 'free', lastReadSeq: 10 },
    { id: 7, type: 'agent', displayName: '小助手', avatarHue: 280, role: 'member', replyMode: 'mention', lastReadSeq: 7 },
  ],
}]);

// 群广场桩：core/groups.mjs#discoverGroups 的真实返回同时带 camelCase 别名（给 web 用），
// 这里故意保留别名，用来断言 MCP 出参只留协议 snake_case 字段。
let discoverGroupsImpl = async () => ({
  groups: [{
    id: 42,
    title: '公开群',
    description: '欢迎加入',
    member_count: 3,
    joined: false,
    join_mode: 'open',
    last_message_at: '2026-11-12T00:00:00.000Z',
    memberCount: 3,
    joinMode: 'open',
    lastMessageAt: '2026-11-12T00:00:00.000Z',
  }],
  has_more: true,
  next_before_id: 42,
  hasMore: true,
  nextBeforeId: 42,
});
let requestJoinImpl = async () => ({
  ok: true, already_member: false, joined: false, pending: true, duplicated: false, request_id: 9,
});

const logs = [];
const logger = {
  info: (fields) => logs.push({ level: 'info', ...fields }),
  warn: (fields) => logs.push({ level: 'warn', ...fields }),
  error: (fields) => logs.push({ level: 'error', ...fields }),
};

const auth = {
  async authenticateAgent(header) {
    calls.auth.push(header);
    if (header !== `Bearer ${TOKEN}`) return null;
    return { actor: ACTOR }; // 契约形状；server 同时兼容直接返回 actor
  },
};

const submit = async (command, actor) => {
  calls.submit.push({ command, actor });
  return submitImpl(command, actor);
};

const query = {
  async whatsNewFor(actor, options) {
    calls.whatsNew.push({ actor, options });
    return whatsNewImpl(actor, options);
  },
  async whatsNewDigestFor(actor, options) {
    calls.digest.push({ actor, options });
    return digestImpl(actor, options);
  },
  async listConversationsFor(actor) {
    calls.listConversations.push({ actor });
    return conversationsImpl(actor);
  },
  async getAgentCursor(agentId, label) {
    calls.cursorGet.push({ agentId, label });
    return cursorValue;
  },
  async setAgentCursor(agentId, label, cursor) {
    calls.cursorSet.push({ agentId, label, cursor });
    cursorValue = cursor;
  },
  async discoverGroups(actor, options) {
    calls.discoverGroups.push({ actor, options });
    return discoverGroupsImpl(actor, options);
  },
  async requestJoin(actor, conversationId) {
    calls.requestJoin.push({ actor, conversationId });
    return requestJoinImpl(actor, conversationId);
  },
};

const mcp = createMcp({ auth, submit, query, logger });

// 便捷：发一个 JSON-RPC 请求
async function call(body, bearer = `Bearer ${TOKEN}`) {
  return mcp.handle(body, bearer);
}

// 便捷：读工具结果里的 JSON 文本
function payloadOf(res) {
  const result = res.body?.result;
  const text = result?.content?.[0]?.text;
  if (typeof text !== 'string') return null;
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// 1. 初始化 / 基础协议
// ---------------------------------------------------------------------------
await group('initialize 与基础协议', async () => {
  const res = await call({
    jsonrpc: '2.0',
    id: 1,
    method: 'initialize',
    params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'unit', version: '1.0.0' } },
  });
  check('initialize 返回 HTTP 200', res.status === 200, `status=${res.status}`);
  check('initialize 回显 protocolVersion', res.body?.result?.protocolVersion === '2025-06-18', JSON.stringify(res.body?.result?.protocolVersion));
  check('initialize serverInfo = aio/0.1.0', eq(res.body?.result?.serverInfo, { name: 'aio', version: '0.1.0' }), JSON.stringify(res.body?.result?.serverInfo));
  check('initialize capabilities 含 tools', eq(res.body?.result?.capabilities, { tools: {} }), JSON.stringify(res.body?.result?.capabilities));
  check('initialize 不返回 session 信息', !JSON.stringify(res.body).includes('sessionId'));

  const bad = await call({ jsonrpc: '2.0', id: 2, method: 'initialize', params: { protocolVersion: '1999-01-01' } });
  // 规范生命周期：不支持就用「自己支持的最新版」协商，不是报错。
  // 以前这里回 -32602，SDK 客户端（首选 2025-11-25）直接连不上。
  check('不认识但像版本的字符串 → 200 + 回最新支持版（协商，不报错）',
    bad.status === 200 && bad.body?.result?.protocolVersion === LATEST_PROTOCOL_VERSION, JSON.stringify(bad.body).slice(0, 160));
  check('协商结果在 supportedVersions 里', SUPPORTED_PROTOCOL_VERSIONS.includes(bad.body?.result?.protocolVersion),
    JSON.stringify(SUPPORTED_PROTOCOL_VERSIONS));
  check('支持 2025-11-25（当前官方 SDK 的首选握手版本）', SUPPORTED_PROTOCOL_VERSIONS.includes('2025-11-25'),
    JSON.stringify(SUPPORTED_PROTOCOL_VERSIONS));

  const newest = await call({
    jsonrpc: '2.0', id: 21, method: 'initialize',
    params: { protocolVersion: '2025-11-25', capabilities: {}, clientInfo: { name: 'sdk', version: '1' } },
  });
  check('客户端要 2025-11-25 → 原样回 2025-11-25', newest.body?.result?.protocolVersion === '2025-11-25' && LATEST_PROTOCOL_VERSION === '2025-11-25',
    JSON.stringify(newest.body?.result?.protocolVersion));

  const missingVersion = await call({ jsonrpc: '2.0', id: 3, method: 'initialize', params: {} });
  check('缺 protocolVersion → 仍 200 并回最新版（宽容，不打死客户端）',
    missingVersion.status === 200 && missingVersion.body?.result?.protocolVersion === LATEST_PROTOCOL_VERSION,
    JSON.stringify(missingVersion.body).slice(0, 160));

  const notif = await call({ jsonrpc: '2.0', method: 'notifications/initialized' });
  check('notifications/initialized → 202 无正文', notif.status === 202 && notif.body === null, `status=${notif.status} body=${JSON.stringify(notif.body)}`);

  const ping = await call({ jsonrpc: '2.0', id: 4, method: 'ping' });
  check('ping → 200 result {}', ping.status === 200 && eq(ping.body?.result, {}), JSON.stringify(ping.body));

  // 用真正未知的方法；resources/list 现在按「空列表」容错（见 3.5），不能当未知方法用
  const unknown = await call({ jsonrpc: '2.0', id: 5, method: 'sampling/createMessage' });
  check('未知方法 → -32601', unknown.body?.error?.code === -32601, JSON.stringify(unknown.body));
  check('未知方法 HTTP 仍是 200', unknown.status === 200, `status=${unknown.status}`);

  const unknownNotif = await call({ jsonrpc: '2.0', method: 'notifications/whatever' });
  check('未知通知静默丢弃（202）', unknownNotif.status === 202 && unknownNotif.body === null);

  const badEnvelope = await call({ jsonrpc: '1.0', id: 6, method: 'ping' });
  check('jsonrpc 非 2.0 → -32600', badEnvelope.body?.error?.code === -32600, JSON.stringify(badEnvelope.body));
  check('jsonrpc 非 2.0 → HTTP 400', badEnvelope.status === 400, `status=${badEnvelope.status}`);

  const notObject = await call([1, 2, 3][0]);
  check('非对象请求 → -32600', notObject.body?.error?.code === -32600, JSON.stringify(notObject.body));

  const parseErr = await call('{"jsonrpc": "2.0", "id": 1, ');
  check('非法 JSON 字符串 → -32700', parseErr.body?.error?.code === -32700, JSON.stringify(parseErr.body));

  const fromString = await call('{"jsonrpc":"2.0","id":9,"method":"ping"}');
  check('合法 JSON 字符串可直接处理', fromString.body?.result !== undefined && fromString.body.id === 9, JSON.stringify(fromString.body));

  const emptyBatch = await call([]);
  check('空批量 → -32600', emptyBatch.status === 400 && emptyBatch.body?.error?.code === -32600, JSON.stringify(emptyBatch.body));

  const batch = await call([
    { jsonrpc: '2.0', id: 10, method: 'ping' },
    { jsonrpc: '2.0', method: 'notifications/initialized' },
    { jsonrpc: '2.0', id: 11, method: 'tools/list' },
  ]);
  check('批量请求返回 2 条响应（通知被丢弃）', batch.status === 200 && Array.isArray(batch.body) && batch.body.length === 2, JSON.stringify(batch.body));
  check('批量响应 id 顺序正确', batch.body?.[0]?.id === 10 && batch.body?.[1]?.id === 11);

  const batchAllNotif = await call([{ jsonrpc: '2.0', method: 'notifications/initialized' }, { jsonrpc: '2.0', method: 'ping' }]);
  check('全通知批量 → 202', batchAllNotif.status === 202 && batchAllNotif.body === null, `status=${batchAllNotif.status}`);
});

// ---------------------------------------------------------------------------
// 2. 鉴权
// ---------------------------------------------------------------------------
await group('鉴权（401）', async () => {
  const noToken = await call({ jsonrpc: '2.0', id: 20, method: 'ping' }, null);
  check('无 token → 401', noToken.status === 401, `status=${noToken.status}`);
  check('无 token → JSON-RPC -32001', noToken.body?.error?.code === -32001, JSON.stringify(noToken.body));
  check('无 token → WWW-Authenticate', noToken.headers?.['WWW-Authenticate'] === 'Bearer realm="aio"', JSON.stringify(noToken.headers));
  check('401 只出现一次 Bearer 提示', JSON.stringify(noToken.body).split('Bearer').length === 2);

  const badToken = await call({ jsonrpc: '2.0', id: 21, method: 'ping' }, 'Bearer qqa_bad');
  check('错误 token → 401', badToken.status === 401 && badToken.body?.error?.code === -32001);
  check('401 不回显 token', !JSON.stringify(badToken.body).includes('qqa_bad'), JSON.stringify(badToken.body));

  const batchNoToken = await call([{ jsonrpc: '2.0', id: 22, method: 'ping' }], null);
  check('批量请求无 token 也 401', batchNoToken.status === 401 && batchNoToken.body?.error?.code === -32001);

  // 依赖缺失：路由已注册但内核模块没接上 → 503 -32002
  const bare = createMcp({ logger: { info() {}, warn() {}, error() {} } });
  const unavailable = await bare.handle({ jsonrpc: '2.0', id: 23, method: 'ping' }, `Bearer ${TOKEN}`);
  check('依赖缺失 → 503', unavailable.status === 503, `status=${unavailable.status}`);
  check('依赖缺失 → -32002 并列出缺失项', unavailable.body?.error?.code === -32002
    && Array.isArray(unavailable.body?.error?.data?.missing)
    && unavailable.body.error.data.missing.includes('submit'), JSON.stringify(unavailable.body));
});

// ---------------------------------------------------------------------------
// 3. tools/list
// ---------------------------------------------------------------------------
await group('tools/list（当前 21 个工具）', async () => {
  const res = await call({ jsonrpc: '2.0', id: 30, method: 'tools/list' });
  const tools = res.body?.result?.tools || [];
  check('tools/list 返回全部 21 个工具', tools.length === 21, `count=${tools.length}`);
  check('工具名与实现一致', eq(tools.map((t) => t.name), [
    'whats_new', 'get_context', 'search_messages', 'find_agents', 'find_groups', 'join_group', 'leave_group', 'list_friends', 'add_friend', 'accept_friend', 'dm', 'share_sticker_pack', 'my_limits',
    'send_message', 'list_conversations', 'search_stickers',
    'set_avatar', 'create_sticker_pack', 'add_sticker_item', 'list_my_sticker_packs',
    'publish_feed',
  ]), JSON.stringify(tools.map((t) => t.name)));
  check('每个工具都有 object inputSchema', tools.every((t) => t.inputSchema?.type === 'object'));
  // 部分客户端会缓存工具索引；顺序抖动会让缓存失效，所以顺序必须稳定
  const again = await call({ jsonrpc: '2.0', id: 36, method: 'tools/list' });
  check('tools/list 顺序稳定（两次调用完全一致）',
    eq((again.body?.result?.tools || []).map((t) => t.name), tools.map((t) => t.name)));
  check('inputSchema 均 additionalProperties:false', tools.every((t) => t.inputSchema?.additionalProperties === false));
  const send = tools.find((t) => t.name === 'send_message');
  // [外链富内容] body 改成可选：只发 parts（图片/语音/视频/文件/网页）时不需要 body
  check('send_message required = conversation_id/client_msg_id（body 可选）', eq(send?.inputSchema?.required, ['conversation_id', 'client_msg_id']), JSON.stringify(send?.inputSchema?.required));
  check('send_message body 上限 4000', send?.inputSchema?.properties?.body?.maxLength === 4000);
  check('send_message 显式声明 parts（≤5 段）', send?.inputSchema?.properties?.parts?.maxItems === 5);
  check('send_message parts.items 用 oneOf 覆盖 7 种段', (send?.inputSchema?.properties?.parts?.items?.oneOf || []).length === 7);
  const wn = tools.find((t) => t.name === 'whats_new');
  // ack_seq 是 Q2 的显式确认参数：放进来是为了让「拉取不推进位点」成为可选语义
  check('whats_new 有 since_seq/ack_seq/conversation_ids/limit/detail/from_seq',
    eq(Object.keys(wn?.inputSchema?.properties || {}), ['since_seq', 'ack_seq', 'conversation_ids', 'limit', 'detail', 'from_seq']),
    JSON.stringify(Object.keys(wn?.inputSchema?.properties || {})));
  check('whats_new.ack_seq 是非负整数', wn?.inputSchema?.properties?.ack_seq?.type === 'integer'
    && wn?.inputSchema?.properties?.ack_seq?.minimum === 0);
  const pf = tools.find((t) => t.name === 'publish_feed');
  check('publish_feed required = body/client_msg_id', eq(pf?.inputSchema?.required, ['body', 'client_msg_id']),
    JSON.stringify(pf?.inputSchema?.required));
  check('publish_feed visibility 只允许 friends/private（不做全站公开）',
    eq(pf?.inputSchema?.properties?.visibility?.enum, ['friends', 'private'])
    && pf?.inputSchema?.properties?.visibility?.default === 'friends');
  check('publish_feed body 上限与人类 feed 一致（4000）', pf?.inputSchema?.properties?.body?.maxLength === 4000);
});

// ---------------------------------------------------------------------------
// 3.5 能力探测容错（resources / prompts / completion / logging / 通知）
// ---------------------------------------------------------------------------
await group('能力探测容错（resources / prompts / completion / logging）', async () => {
  const res = await call({ jsonrpc: '2.0', id: 31, method: 'resources/list' });
  check('resources/list → 200 + 空数组（不报 -32601）',
    eq(res.body?.result?.resources, []), JSON.stringify(res.body).slice(0, 140));
  const tpl = await call({ jsonrpc: '2.0', id: 32, method: 'resources/templates/list' });
  check('resources/templates/list → resourceTemplates []', eq(tpl.body?.result?.resourceTemplates, []));
  const prompts = await call({ jsonrpc: '2.0', id: 33, method: 'prompts/list' });
  check('prompts/list → prompts []', eq(prompts.body?.result?.prompts, []));
  const comp = await call({ jsonrpc: '2.0', id: 34, method: 'completion/complete', params: {} });
  check('completion/complete → 空 completions', eq(comp.body?.result?.completion?.values, []),
    JSON.stringify(comp.body).slice(0, 140));
  const logging = await call({ jsonrpc: '2.0', id: 35, method: 'logging/setLevel', params: { level: 'info' } });
  check('logging/setLevel → 200 {}（宽容，不吓客户端）', eq(logging.body?.result, {}));
  const cancel = await call({ jsonrpc: '2.0', method: 'notifications/cancelled', params: { requestId: 1 } });
  check('notifications/cancelled → 202 空正文（不能回 -32601）',
    cancel.status === 202 && cancel.body === null, `status=${cancel.status}`);
});

// ---------------------------------------------------------------------------
// 4. whats_new
// ---------------------------------------------------------------------------
await group('tools/call whats_new（摘要 + 明细）', async () => {
  // 默认 = 摘要模式：只调 whatsNewDigestFor，不拉正文
  calls.digest.length = 0;
  calls.whatsNew.length = 0;
  calls.cursorGet.length = 0;
  const res = await call({
    jsonrpc: '2.0',
    id: 40,
    method: 'tools/call',
    params: { name: 'whats_new', arguments: { since_seq: 5, conversation_ids: [42, 42], limit: 10 } },
  });
  check('whats_new（默认）→ isError:false', res.body?.result?.isError === false, JSON.stringify(res.body?.result));
  check('whats_new content 是 text 类型', res.body?.result?.content?.[0]?.type === 'text');
  const data = payloadOf(res);
  check('默认走摘要（whatsNewDigestFor）', calls.digest.length === 1 && calls.whatsNew.length === 0,
    JSON.stringify({ digest: calls.digest.length, detail: calls.whatsNew.length }));
  check('摘要参数：sinceSeq/conversationIds 去重', calls.digest[0]?.options.sinceSeq === 5
    && eq(calls.digest[0].options.conversationIds, [42]), JSON.stringify(calls.digest[0]?.options));
  check('摘要字段：nextSeq/total/conversations[].conversationId',
    data?.nextSeq === 901 && data?.total === 3 && data?.conversations?.[0]?.conversationId === 42,
    JSON.stringify(data));
  check('显式 since_seq（客户端优先）→ 不读服务端游标', calls.cursorGet.length === 0, JSON.stringify(calls.cursorGet));
  check('cursor_source=client', data?.cursor_source === 'client', JSON.stringify(data?.cursor_source));

  // detail=true 才拉正文，事件转 snake_case 并带 may_reply
  calls.digest.length = 0;
  calls.whatsNew.length = 0;
  const detailRes = await call({
    jsonrpc: '2.0',
    id: 40,
    method: 'tools/call',
    params: { name: 'whats_new', arguments: { detail: true, since_seq: 5, conversation_ids: [42], limit: 10 } },
  });
  check('detail 模式 → isError:false', detailRes.body?.result?.isError === false);
  const detail = payloadOf(detailRes);
  check('detail 模式走 whatsNewFor', calls.whatsNew.length === 1 && calls.digest.length === 0,
    JSON.stringify({ digest: calls.digest.length, detail: calls.whatsNew.length }));
  check('detail events 使用 snake_case',
    detail?.events?.[0]?.event_id === 901 && detail?.events[0]?.conversation_id === 42 && detail?.events[0]?.sender_type === 'user',
    JSON.stringify(detail?.events?.[0]));
  check('detail 透传 may_reply（[C10]）', detail?.events?.[0]?.may_reply === true);
  check('detail next_seq/has_more 正确', detail?.next_seq === 901 && detail?.has_more === false, JSON.stringify(detail));

  calls.whatsNew.length = 0;
  calls.digest.length = 0;
  const bad = await call({ jsonrpc: '2.0', id: 41, method: 'tools/call', params: { name: 'whats_new', arguments: { since_seq: -1 } } });
  check('since_seq 非法 → isError:true', bad.body?.result?.isError === true);
  check('since_seq 非法 → reason=invalid_schema', payloadOf(bad)?.reason === 'invalid_schema', JSON.stringify(payloadOf(bad)));
  check('参数非法不打 query', calls.whatsNew.length === 0 && calls.digest.length === 0);

  const okDigest = digestImpl;
  digestImpl = async () => { throw Object.assign(new Error('db down'), { code: 'ECONNRESET' }); };
  const dbErr = await call({ jsonrpc: '2.0', id: 42, method: 'tools/call', params: { name: 'whats_new', arguments: {} } });
  check('query 抛错 → isError:true 而非 500', dbErr.status === 200 && dbErr.body?.result?.isError === true, `status=${dbErr.status}`);
  check('query 抛错 → reason=internal', payloadOf(dbErr)?.reason === 'internal', JSON.stringify(payloadOf(dbErr)));
  digestImpl = okDigest;
});

// ---------------------------------------------------------------------------
// 4.5 服务端代存游标（agent_cursors，SPEC v6 变更 5）
// ---------------------------------------------------------------------------
await group('服务端代存游标（agent_cursors）', async () => {
  cursorValue = 0;
  calls.cursorGet.length = 0;
  calls.cursorSet.length = 0;
  calls.digest.length = 0;
  await call({ jsonrpc: '2.0', id: 43, method: 'tools/call', params: { name: 'whats_new', arguments: { limit: 5 } } });
  check('缺省 since_seq → 读服务端游标（agent + client_label）',
    calls.cursorGet.length === 1 && calls.cursorGet[0].agentId === 7 && calls.cursorGet[0].label === 'unit',
    JSON.stringify(calls.cursorGet));
  check('缺省 since_seq → 摘要用服务端位点',
    calls.digest[0]?.options.sinceSeq === 0, JSON.stringify(calls.digest[0]?.options));
  check('摘要 nextSeq 前移 → 回写游标',
    calls.cursorSet.length === 1 && calls.cursorSet[0].cursor === 901 && calls.cursorSet[0].label === 'unit',
    JSON.stringify(calls.cursorSet));

  cursorValue = 800;
  calls.cursorGet.length = 0;
  calls.cursorSet.length = 0;
  calls.digest.length = 0;
  await call({ jsonrpc: '2.0', id: 44, method: 'tools/call', params: { name: 'whats_new', arguments: {} } });
  check('服务端位点 800 → 从 800 开始拉', calls.digest[0]?.options.sinceSeq === 800, JSON.stringify(calls.digest[0]?.options));
  check('800 → 901 回写', calls.cursorSet[0]?.cursor === 901, JSON.stringify(calls.cursorSet));

  // 位点比返回的 nextSeq 还新（同一 Agent 另一 client_label 已推进）→ 绝不回退
  cursorValue = 950;
  calls.cursorGet.length = 0;
  calls.cursorSet.length = 0;
  calls.digest.length = 0;
  await call({ jsonrpc: '2.0', id: 45, method: 'tools/call', params: { name: 'whats_new', arguments: {} } });
  check('nextSeq 小于已有位点 → 不回退游标', calls.cursorSet.length === 0, JSON.stringify(calls.cursorSet));
  cursorValue = 0;
});

// ---------------------------------------------------------------------------
// 5. send_message
// ---------------------------------------------------------------------------
const SECRET_BODY = '这是绝对不能出现在日志里的正文-7f3a';
const UUID = '123e4567-e89b-42d3-a456-426614174000';

await group('tools/call send_message', async () => {
  // 5.1 缺参数：本地拦截，不打库
  calls.submit.length = 0;
  const missingBody = await call({
    jsonrpc: '2.0',
    id: 50,
    method: 'tools/call',
    params: { name: 'send_message', arguments: { conversation_id: 42, client_msg_id: UUID } },
  });
  check('缺 body → isError:true', missingBody.body?.result?.isError === true);
  check('缺 body → reason=invalid_schema', payloadOf(missingBody)?.reason === 'invalid_schema', JSON.stringify(payloadOf(missingBody)));
  check('缺 body → 不打 submit', calls.submit.length === 0);

  const missingCid = await call({ jsonrpc: '2.0', id: 51, method: 'tools/call', params: { name: 'send_message', arguments: { conversation_id: 42, body: 'hi' } } });
  check('缺 client_msg_id → invalid_schema', payloadOf(missingCid)?.reason === 'invalid_schema' && calls.submit.length === 0);

  const badConv = await call({ jsonrpc: '2.0', id: 52, method: 'tools/call', params: { name: 'send_message', arguments: { conversation_id: 'x', body: 'hi', client_msg_id: UUID } } });
  check('conversation_id 非整数 → invalid_schema', payloadOf(badConv)?.reason === 'invalid_schema');

  const badSeq = await call({ jsonrpc: '2.0', id: 53, method: 'tools/call', params: { name: 'send_message', arguments: { conversation_id: 42, body: 'hi', client_msg_id: 'short' } } });
  check('client_msg_id 太短 → invalid_schema', payloadOf(badSeq)?.reason === 'invalid_schema' && calls.submit.length === 0);

  // 5.2 合法发送：client_msg_id 必须原样透传
  const sent = await call({
    jsonrpc: '2.0',
    id: 54,
    method: 'tools/call',
    params: {
      name: 'send_message',
      arguments: { conversation_id: 42, body: SECRET_BODY, client_msg_id: UUID, reply_to_seq: 9, mentions: [5, 7, 7] },
    },
  });
  check('合法发送 → isError:false', sent.body?.result?.isError === false, JSON.stringify(sent.body?.result));
  const sentPayload = payloadOf(sent);
  check('合法发送 → accepted:true / event_id / seq', sentPayload?.accepted === true && sentPayload?.event_id === 900 && sentPayload?.seq === 7, JSON.stringify(sentPayload));
  check('submit 只被调用一次', calls.submit.length === 1);
  const cmd = calls.submit[0]?.command;
  check('submit 收到 type=send_message', cmd?.type === 'send_message', JSON.stringify(cmd));
  check('client_msg_id 原样透传', cmd?.client_msg_id === UUID, String(cmd?.client_msg_id));
  check('body 原样透传（不 trim 不转义）', cmd?.body === SECRET_BODY);
  check('mentions 去重后透传', eq(cmd?.mentions, [5, 7]), JSON.stringify(cmd?.mentions));
  check('reply_to_seq 透传', cmd?.reply_to_seq === 9);
  check('actor 原样传给 submit', calls.submit[0]?.actor?.id === 7 && calls.submit[0]?.actor?.type === 'agent');

  // 5.3 幂等返回
  submitImpl = async (command) => ({ accepted: true, event_id: 900, seq: 7, conversation_id: command.conversation_id, deduplicated: true });
  const dedup = await call({ jsonrpc: '2.0', id: 55, method: 'tools/call', params: { name: 'send_message', arguments: { conversation_id: 42, body: 'retry', client_msg_id: UUID } } });
  check('幂等命中 → deduplicated:true', payloadOf(dedup)?.deduplicated === true, JSON.stringify(payloadOf(dedup)));

  // 5.4 门控/限流失败：isError:true，HTTP 200，不 5xx
  submitImpl = async () => ({ accepted: false, reason: 'forbidden', message: '你不在这个会话里' });
  const forbidden = await call({ jsonrpc: '2.0', id: 56, method: 'tools/call', params: { name: 'send_message', arguments: { conversation_id: 42, body: 'x', client_msg_id: UUID } } });
  check('forbidden → HTTP 200', forbidden.status === 200, `status=${forbidden.status}`);
  check('forbidden → isError:true', forbidden.body?.result?.isError === true);
  check('forbidden → text 是 accepted:false/reason', payloadOf(forbidden)?.accepted === false && payloadOf(forbidden)?.reason === 'forbidden', JSON.stringify(payloadOf(forbidden)));

  submitImpl = async () => ({ accepted: false, reason: 'rate_limited', message: '发送太频繁' });
  const limited = await call({ jsonrpc: '2.0', id: 57, method: 'tools/call', params: { name: 'send_message', arguments: { conversation_id: 42, body: 'x', client_msg_id: UUID } } });
  check('rate_limited → isError:true 且 200', limited.status === 200 && limited.body?.result?.isError === true && payloadOf(limited)?.reason === 'rate_limited', JSON.stringify(payloadOf(limited)));

  submitImpl = async () => ({ accepted: false, reason: 'gating_gap', message: '发言间隔未到' });
  const gated = await call({ jsonrpc: '2.0', id: 58, method: 'tools/call', params: { name: 'send_message', arguments: { conversation_id: 42, body: 'x', client_msg_id: UUID } } });
  check('[C10] gating_gap → isError:true 且 200', gated.status === 200 && gated.body?.result?.isError === true && payloadOf(gated)?.reason === 'gating_gap');

  // 5.5 submit 抛异常也不能 500
  submitImpl = async () => { throw Object.assign(new Error('boom'), { code: 'ETIMEDOUT' }); };
  const threw = await call({ jsonrpc: '2.0', id: 59, method: 'tools/call', params: { name: 'send_message', arguments: { conversation_id: 42, body: 'x', client_msg_id: UUID } } });
  check('submit 抛错 → 200 + isError:true', threw.status === 200 && threw.body?.result?.isError === true, `status=${threw.status}`);
  check('submit 抛错 → reason=internal', payloadOf(threw)?.reason === 'internal', JSON.stringify(payloadOf(threw)));

  submitImpl = async (command) => ({ accepted: true, event_id: 900, seq: 7, conversation_id: command.conversation_id, deduplicated: false });
});

// ---------------------------------------------------------------------------
// 5b. [外链富内容] send_message parts 校验（docs/富内容外链.md §2.1）
//     协议层先拦：非法外链不进 submit，也不消耗限流/门控额度
// ---------------------------------------------------------------------------
await group('send_message parts 外链校验', async () => {
  submitImpl = async (command) => ({ accepted: true, event_id: 901, seq: 8, conversation_id: command.conversation_id, deduplicated: false });
  const sendArgs = (parts) => ({ conversation_id: 42, client_msg_id: UUID, parts });
  const probe = async (id, parts) => call({
    jsonrpc: '2.0', id, method: 'tools/call',
    params: { name: 'send_message', arguments: sendArgs(parts) },
  });

  // 合法：5 段全是 https 外链，且不需要 body
  const rich = [
    { type: 'image', url: 'https://cdn.example.com/a.png', width: 640, height: 480, alt: '图' },
    { type: 'voice', url: 'https://cdn.example.com/a.m4a', duration_ms: 3200, mime: 'audio/mp4' },
    { type: 'video', url: 'https://cdn.example.com/a.mp4', poster_url: 'https://cdn.example.com/a.jpg', duration_ms: 12000 },
    { type: 'file', url: 'https://cdn.example.com/pack.zip', name: '素材包.zip', bytes: 102400, files: [{ name: 'a.png', bytes: 12 }, { name: 'b.m4a' }] },
    { type: 'html', url: 'https://cdn.example.com/report.html', title: '周报', height: 480 },
  ];
  calls.submit.length = 0;
  const okRes = await probe(70, rich);
  check('5 段 https 外链（无 body）→ isError:false', okRes.body?.result?.isError === false, JSON.stringify(payloadOf(okRes)));
  check('parts 原样透传给 submit', eq(calls.submit[0]?.command?.parts, rich));

  // srcdoc 变体（≤24576）合法
  calls.submit.length = 0;
  const srcRes = await probe(71, [{ type: 'html', srcdoc: '<h1>hi</h1>', title: '内嵌', height: 320 }]);
  check('html srcdoc 变体 → isError:false', srcRes.body?.result?.isError === false, JSON.stringify(payloadOf(srcRes)));

  // 拒绝项：reason 必须是 invalid_schema 且不打 submit
  const rejects = [
    ['javascript:', [{ type: 'image', url: 'javascript:alert(1)' }]],
    ['http://', [{ type: 'image', url: 'http://example.com/a.png' }]],
    ['data:', [{ type: 'html', url: 'data:text/html,<b>x</b>' }]],
    ['file:', [{ type: 'file', url: 'file:///etc/passwd', name: 'passwd' }]],
    ['user:pass@', [{ type: 'image', url: 'https://u:p@example.com/a.png' }]],
    ['超长 url', [{ type: 'image', url: `https://example.com/${'a'.repeat(2100)}` }]],
    ['srcdoc 超 24KB', [{ type: 'html', srcdoc: 'x'.repeat(24577) }]],
    ['files 51 条', [{ type: 'file', url: 'https://example.com/p.zip', name: 'p.zip', files: Array.from({ length: 51 }, (_, i) => ({ name: `f${i}.txt` })) }]],
    ['段内 url/attachment_id 都缺', [{ type: 'video' }]],
    ['parts 非数组', 'not-an-array'],
  ];
  let idBase = 72;
  for (const [label, parts] of rejects) {
    calls.submit.length = 0;
    const res = await probe(idBase, parts);
    idBase += 1;
    check(`拒绝 ${label} → isError:true + invalid_schema`, res.body?.result?.isError === true && payloadOf(res)?.reason === 'invalid_schema', JSON.stringify(payloadOf(res)));
    check(`拒绝 ${label} → 不打 submit`, calls.submit.length === 0);
  }
  submitImpl = async (command) => ({ accepted: true, event_id: 900, seq: 7, conversation_id: command.conversation_id, deduplicated: false });
});

// ---------------------------------------------------------------------------
// 5c. [外链富内容] whats_new 出参：srcdoc 不回给 Agent（单段最大 24KB，白烧 token），
//     其余外链字段（url/name/files/poster_url/title/alt）保留。
//     注意：REST /api/conversations/:id/messages 仍返回 srcdoc，网页端渲染要用。
// ---------------------------------------------------------------------------
await group('whats_new 出参省略 srcdoc', async () => {
  whatsNewImpl = async () => ({
    events: [{
      eventId: 902,
      conversationId: 42,
      seq: 12,
      senderId: 5,
      senderName: '小白',
      senderType: 'user',
      body: '[网页]',
      mentions: [],
      replyToSeq: null,
      createdAt: '2026-11-12T00:00:00.000Z',
      parts: [
        { type: 'html', srcdoc: '<b>大段 HTML</b>', title: '内嵌页', height: 320 },
        { type: 'html', url: 'https://cdn.example.com/r.html', title: '外链页' },
        { type: 'file', url: 'https://cdn.example.com/p.zip', name: 'p.zip', bytes: 10, files: [{ name: 'a.png', bytes: 1 }] },
        { type: 'video', url: 'https://cdn.example.com/a.mp4', poster_url: 'https://cdn.example.com/a.jpg' },
      ],
    }],
    nextSeq: 902,
    hasMore: false,
  });
  const res = await call({
    jsonrpc: '2.0', id: 90, method: 'tools/call',
    params: { name: 'whats_new', arguments: { detail: true, since_seq: 0 } },
  });
  const parts = payloadOf(res)?.events?.[0]?.parts || [];
  check('MCP 出参不返回 srcdoc', parts[0] && !Object.prototype.hasOwnProperty.call(parts[0], 'srcdoc'), JSON.stringify(parts[0]));
  check('html 的 title/height 仍保留', parts[0]?.title === '内嵌页' && parts[0]?.height === 320, JSON.stringify(parts[0]));
  check('html url 变体不受影响', parts[1]?.url === 'https://cdn.example.com/r.html' && parts[1]?.title === '外链页', JSON.stringify(parts[1]));
  check('file 的 name/files 仍保留', parts[2]?.name === 'p.zip' && Array.isArray(parts[2]?.files) && parts[2].files[0]?.name === 'a.png', JSON.stringify(parts[2]));
  check('video 的 poster_url 仍保留', parts[3]?.poster_url === 'https://cdn.example.com/a.jpg', JSON.stringify(parts[3]));
  whatsNewImpl = async () => ({
    events: [{ eventId: 901, conversationId: 42, seq: 11, senderId: 5, senderName: '小白', senderType: 'user', body: '在吗', mentions: [7], replyToSeq: null, createdAt: '2026-11-12T00:00:00.000Z', mayReply: true }],
    nextSeq: 901,
    hasMore: false,
  });
});

// ---------------------------------------------------------------------------
// 6. list_conversations
// ---------------------------------------------------------------------------
await group('tools/call list_conversations', async () => {
  const res = await call({ jsonrpc: '2.0', id: 60, method: 'tools/call', params: { name: 'list_conversations', arguments: {} } });
  const data = payloadOf(res);
  check('list_conversations → isError:false', res.body?.result?.isError === false);
  check('会话字段 snake_case（last_seq/unread/reply_mode）', data?.conversations?.[0]?.last_seq === 10 && data?.conversations?.[0]?.unread === 3 && data?.conversations?.[0]?.reply_mode === 'mention', JSON.stringify(data?.conversations?.[0]));
  check('成员 display_name 正确', data?.conversations?.[0]?.members?.[0]?.display_name === '小白', JSON.stringify(data?.conversations?.[0]?.members?.[0]));

  const withArgs = await call({ jsonrpc: '2.0', id: 61, method: 'tools/call', params: { name: 'list_conversations', arguments: { foo: 1 } } });
  check('list_conversations 带业务参数 → invalid_schema', payloadOf(withArgs)?.reason === 'invalid_schema');
});

// ---------------------------------------------------------------------------
// 6.5 find_groups / join_group（群广场的 AI 入口）
// ---------------------------------------------------------------------------
await group('tools/call find_groups / join_group', async () => {
  calls.discoverGroups.length = 0;
  const res = await call({
    jsonrpc: '2.0', id: 62, method: 'tools/call',
    params: { name: 'find_groups', arguments: { query: '公开', limit: 5, before_id: 0 } },
  });
  const data = payloadOf(res);
  check('find_groups → isError:false', res.body?.result?.isError === false);
  check('find_groups 透传 query/limit/before_id',
    calls.discoverGroups[0]?.options?.q === '公开'
      && calls.discoverGroups[0]?.options?.limit === 5
      && calls.discoverGroups[0]?.options?.beforeId === 0,
    JSON.stringify(calls.discoverGroups[0]?.options));
  // core 为了 web 同时给 camelCase 别名；MCP 出参必须只有 protocol snake_case
  check('群字段只出 snake_case（不带 memberCount/joinMode 别名）',
    data?.groups?.[0]?.member_count === 3
      && !Object.prototype.hasOwnProperty.call(data?.groups?.[0] || {}, 'memberCount')
      && !Object.prototype.hasOwnProperty.call(data?.groups?.[0] || {}, 'joinMode'),
    JSON.stringify(data?.groups?.[0]));
  check('翻页字段 has_more / next_before_id', data?.has_more === true && data?.next_before_id === 42,
    JSON.stringify({ has_more: data?.has_more, next_before_id: data?.next_before_id }));

  const badLimit = await call({ jsonrpc: '2.0', id: 63, method: 'tools/call', params: { name: 'find_groups', arguments: { limit: 21 } } });
  check('find_groups limit 21 → invalid_schema', payloadOf(badLimit)?.reason_code === 'invalid_schema', JSON.stringify(payloadOf(badLimit)));
  const badExtra = await call({ jsonrpc: '2.0', id: 64, method: 'tools/call', params: { name: 'find_groups', arguments: { conversation_id: 1 } } });
  check('find_groups 未知参数 → invalid_schema', payloadOf(badExtra)?.reason === 'invalid_schema', JSON.stringify(payloadOf(badExtra)));

  // approval 群：pending=true 必须是 isError:false——标成失败会让 AI 反复重试，刷满 20 次/小时
  requestJoinImpl = async () => ({ ok: true, already_member: false, joined: false, pending: true, duplicated: false, request_id: 9 });
  const pending = await call({ jsonrpc: '2.0', id: 65, method: 'tools/call', params: { name: 'join_group', arguments: { conversation_id: 42 } } });
  const pendingData = payloadOf(pending);
  check('join_group 申请待审批 → isError:false + pending:true', pending.body?.result?.isError === false && pendingData?.pending === true, JSON.stringify(pendingData));
  check('join_group 不透出 core 的 ok 字段', pendingData && !Object.prototype.hasOwnProperty.call(pendingData, 'ok'), JSON.stringify(pendingData));

  requestJoinImpl = async () => ({ ok: true, already_member: false, joined: true, pending: false, join_mode: 'open' });
  const joined = await call({ jsonrpc: '2.0', id: 66, method: 'tools/call', params: { name: 'join_group', arguments: { conversation_id: 42 } } });
  check('join_group open → joined:true', joined.body?.result?.isError === false && payloadOf(joined)?.joined === true, JSON.stringify(payloadOf(joined)));

  requestJoinImpl = async () => ({ ok: false, reason: 'not_found', message: '找不到这个公开群' });
  const missing = await call({ jsonrpc: '2.0', id: 67, method: 'tools/call', params: { name: 'join_group', arguments: { conversation_id: 999 } } });
  const missingData = payloadOf(missing);
  check('join_group 私有/不存在 → isError:true + reason_code=not_found', missing.body?.result?.isError === true && missingData?.reason_code === 'not_found', JSON.stringify(missingData));
  check('join_group 错误带可读 message', missingData?.message === '找不到这个公开群', JSON.stringify(missingData));

  const badId = await call({ jsonrpc: '2.0', id: 68, method: 'tools/call', params: { name: 'join_group', arguments: { conversation_id: 0 } } });
  check('join_group conversation_id=0 → invalid_schema', payloadOf(badId)?.reason_code === 'invalid_schema', JSON.stringify(payloadOf(badId)));

  // 退群：门禁拒绝要带 reason_code + 可执行的「找主人」提示；成功要回 left:true
  submitImpl = async () => ({ accepted: false, reason: 'leave_not_allowed', message: '主人还没允许这只 AI 自己退群' });
  const leaveDenied = await call({ jsonrpc: '2.0', id: 69, method: 'tools/call', params: { name: 'leave_group', arguments: { conversation_id: 42 } } });
  const leaveDeniedData = payloadOf(leaveDenied);
  check('leave_group 未获主人授权 → isError:true + leave_not_allowed',
    leaveDenied.body?.result?.isError === true && leaveDeniedData?.reason_code === 'leave_not_allowed', JSON.stringify(leaveDeniedData));
  check('leave_group 未授权时带「找主人」提示（不是让 AI 重试）',
    typeof leaveDeniedData?.hint === 'string' && leaveDeniedData.hint.includes('允许退群'), JSON.stringify(leaveDeniedData?.hint));

  submitImpl = async () => ({ accepted: true, event_id: 901, left: true });
  const leaveOk = await call({ jsonrpc: '2.0', id: 70, method: 'tools/call', params: { name: 'leave_group', arguments: { conversation_id: 42 } } });
  const leaveOkData = payloadOf(leaveOk);
  check('leave_group 成功 → isError:false + left:true + event_id',
    leaveOk.body?.result?.isError === false && leaveOkData?.left === true && leaveOkData?.event_id === 901, JSON.stringify(leaveOkData));

  const leaveBad = await call({ jsonrpc: '2.0', id: 71, method: 'tools/call', params: { name: 'leave_group', arguments: {} } });
  check('leave_group 缺 conversation_id → invalid_schema', payloadOf(leaveBad)?.reason_code === 'invalid_schema', JSON.stringify(payloadOf(leaveBad)));

  // 还原 submit 桩，别影响后面的日志/接线用例
  submitImpl = async (command) => ({
    accepted: true, event_id: 900, seq: 7, conversation_id: command.conversation_id, deduplicated: false,
  });
});

// ---------------------------------------------------------------------------
// 7. 未知工具 / 日志纪律
// ---------------------------------------------------------------------------
await group('未知工具与日志纪律', async () => {
  const unknownTool = await call({ jsonrpc: '2.0', id: 70, method: 'tools/call', params: { name: 'drop_database', arguments: {} } });
  check('未知工具 → -32602', unknownTool.body?.error?.code === -32602, JSON.stringify(unknownTool.body));
  check('未知工具 data.tool 回显', unknownTool.body?.error?.data?.tool === 'drop_database');

  const noName = await call({ jsonrpc: '2.0', id: 71, method: 'tools/call', params: {} });
  check('tools/call 缺 name → -32602', noName.body?.error?.code === -32602);

  const arrayArgs = await call({ jsonrpc: '2.0', id: 72, method: 'tools/call', params: { name: 'whats_new', arguments: [1, 2] } });
  check('arguments 非对象 → tool isError(invalid_schema)', arrayArgs.body?.result?.isError === true && payloadOf(arrayArgs)?.reason === 'invalid_schema', JSON.stringify(arrayArgs.body?.result));

  const logText = JSON.stringify(logs);
  check('日志不含消息正文', !logText.includes(SECRET_BODY) && !logText.includes('这是绝对不能出现'), '日志泄露正文');
  check('日志不含 token 明文', !logText.includes(TOKEN) && !logText.includes('qqa_'), '日志泄露 token');
  check('日志不含 client_msg_id 字段', !logText.includes('client_msg_id'), '日志出现 client_msg_id');
  const sendLog = logs.find((l) => l.event === 'mcp.send_message');
  check('发送成功日志含 event_id/seq/actor_id', sendLog?.event_id === 900 && sendLog?.seq === 7 && sendLog?.actor_id === 7, JSON.stringify(sendLog));
});

// ---------------------------------------------------------------------------
// 8. Fastify 接线（fake fastify，验证 POST/GET 注册与 HTTP 语义）
// ---------------------------------------------------------------------------
function makeFakeFastify() {
  const routes = { post: {}, get: {}, options: {}, delete: {} };
  return {
    routes,
    post(path, optsOrHandler, maybeHandler) {
      routes.post[path] = typeof optsOrHandler === 'function' ? optsOrHandler : maybeHandler;
      return this;
    },
    get(path, handler) {
      routes.get[path] = handler;
      return this;
    },
    options(path, handler) {
      routes.options[path] = handler;
      return this;
    },
    delete(path, handler) {
      routes.delete[path] = handler;
      return this;
    },
    log: { info() {}, warn() {}, error() {} },
  };
}

function makeFakeReply() {
  return {
    statusCode: 200,
    headers: {},
    body: undefined,
    code(code) { this.statusCode = code; return this; },
    header(key, value) { this.headers[String(key).toLowerCase()] = value; return this; },
    type() { return this; },
    send(body) { this.body = body; return this; },
  };
}

await group('Fastify 路由接线（fake instance）', async () => {
  const app = makeFakeFastify();
  const silent = { info() {}, warn() {}, error() {} };
  await mcpRoutes(app, { deps: { auth, submit, query }, logger: silent });

  check('注册了 POST /mcp', typeof app.routes.post['/mcp'] === 'function');
  check('注册了 GET /mcp', typeof app.routes.get['/mcp'] === 'function');
  // 尾斜杠：Antigravity 官方示例就是 /mcp/，且不能 301/302（POST 会被降级成 GET）
  check('同时注册 /mcp/ 尾斜杠（POST/GET/OPTIONS/DELETE）',
    ['post', 'get', 'options', 'delete'].every((m) => typeof app.routes[m]['/mcp/'] === 'function'),
    JSON.stringify(Object.keys(app.routes.post)));

  const slashPost = makeFakeReply();
  await app.routes.post['/mcp/']({
    body: { jsonrpc: '2.0', id: 83, method: 'ping' },
    headers: { authorization: `Bearer ${TOKEN}` },
  }, slashPost);
  check('POST /mcp/ 直接可用（无重定向）', slashPost.statusCode === 200 && eq(slashPost.body?.result, {}), `status=${slashPost.statusCode}`);

  const preflight = makeFakeReply();
  await app.routes.options['/mcp']({ headers: { origin: 'https://ide.example.com' } }, preflight);
  check('OPTIONS /mcp → 204 + CORS 关键头',
    preflight.statusCode === 204
      && preflight.headers['access-control-allow-origin'] === 'https://ide.example.com'
      && String(preflight.headers['access-control-allow-headers'] || '').includes('authorization')
      && String(preflight.headers['access-control-allow-methods'] || '').includes('POST'),
    JSON.stringify(preflight.headers));

  const del = makeFakeReply();
  await app.routes.delete['/mcp']({}, del);
  check('DELETE /mcp → 405（stateless 没有 session 可关）', del.statusCode === 405 && del.headers.allow === 'POST',
    `status=${del.statusCode}`);

  const getReply = makeFakeReply();
  await app.routes.get['/mcp']({}, getReply);
  check('GET /mcp → 405', getReply.statusCode === 405, `status=${getReply.statusCode}`);
  check('GET /mcp → Allow: POST', getReply.headers.allow === 'POST', JSON.stringify(getReply.headers));
  check('GET /mcp 正文是 JSON-RPC error', getReply.body?.error?.code === -32000, JSON.stringify(getReply.body));

  const unauthorized = makeFakeReply();
  await app.routes.post['/mcp']({ body: { jsonrpc: '2.0', id: 80, method: 'ping' }, headers: {} }, unauthorized);
  check('POST /mcp 无 token → 401', unauthorized.statusCode === 401);
  check('POST /mcp 401 带 WWW-Authenticate', unauthorized.headers['www-authenticate'] === 'Bearer realm="aio"', JSON.stringify(unauthorized.headers));

  const ping = makeFakeReply();
  await app.routes.post['/mcp']({
    body: { jsonrpc: '2.0', id: 81, method: 'ping' },
    headers: { authorization: `Bearer ${TOKEN}` },
  }, ping);
  check('POST /mcp ping → 200 result {}', ping.statusCode === 200 && eq(ping.body?.result, {}), JSON.stringify(ping.body));

  const notification = makeFakeReply();
  await app.routes.post['/mcp']({
    body: { jsonrpc: '2.0', method: 'notifications/initialized' },
    headers: { authorization: `Bearer ${TOKEN}` },
  }, notification);
  check('POST /mcp 通知 → 202 空正文', notification.statusCode === 202 && notification.body === undefined, `status=${notification.statusCode} body=${JSON.stringify(notification.body)}`);

  // 默认（真实）依赖路径：模块可能还没被 Lead 写完 → 必须容错不抛，返回 401 或 503
  const app2 = makeFakeFastify();
  await mcpRoutes(app2, { logger: silent });
  const realReply = makeFakeReply();
  await app2.routes.post['/mcp']({ body: { jsonrpc: '2.0', id: 82, method: 'ping' }, headers: {} }, realReply);
  check('真实依赖路径容错（401 或 503，不抛异常）', [401, 503].includes(realReply.statusCode), `status=${realReply.statusCode}`);
});

// ---------------------------------------------------------------------------
// 汇总
// ---------------------------------------------------------------------------
console.log(`\n${'-'.repeat(60)}`);
if (failures.length) {
  console.error(`结果：${passed} 通过 / ${failures.length} 失败`);
  console.error(`失败用例：${failures.join('；')}`);
  process.exit(1);
} else {
  console.log(`全部通过：${passed}/${passed} \u2713  (MCP 协议层桩测试，零依赖)`);
  process.exit(0);
}
