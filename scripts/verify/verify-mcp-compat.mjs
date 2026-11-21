// MCP 客户端兼容性回归（多客户端长尾行为）。
//
// 为什么单独一条：协议细节（版本协商、尾斜杠、Content-Type、通知 202、id 回传、
// resources/prompts 探测、CORS）任何一条走偏，都会让某一类客户端「连不上 / 工具列表为空」，
// 而常规 smoke 只走一条 happy path，抓不到。
//
// 依据：MCP 2024-11-05 / 2025-03-26 / 2025-06-18 生命周期与 transport 章节，
// 以及官方 Python/TS SDK 的实际握手行为（2025-11-25 已是 SDK 首选握手版本）。
//
// 用法：BASE=http://127.0.0.1:8787 node scripts/verify/verify-mcp-compat.mjs
import crypto from 'node:crypto';

const BASE = (process.env.BASE || 'http://127.0.0.1:8787').replace(/\/$/, '');
const results = [];
const rnd = () => crypto.randomBytes(4).toString('hex');

function check(name, ok, detail = '') {
  results.push({ name, ok });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? '  — ' + detail : ''}`);
}

async function api(path, { method = 'GET', body, cookie, token, raw, headers = {} } = {}) {
  const h = { ...headers };
  if (body !== undefined) h['content-type'] = 'application/json';
  if (cookie) h.cookie = cookie;
  if (token) h.authorization = `Bearer ${token}`;
  const res = await fetch(`${BASE}${path}`, {
    method,
    headers: h,
    body: raw !== undefined ? raw : (body === undefined ? undefined : JSON.stringify(body)),
  });
  const text = await res.text();
  let json = null;
  try { json = text ? JSON.parse(text) : null; } catch { /* 非 JSON */ }
  const setCookie = res.headers.getSetCookie?.() || [];
  const sid = setCookie.map((c) => String(c).split(';')[0]).find((c) => c.startsWith('sid='));
  return { status: res.status, json, text, ct: res.headers.get('content-type') || '', headers: res.headers, cookie: sid || cookie };
}

async function signup(name) {
  const r = await api('/api/auth/register', {
    method: 'POST',
    body: { email: `t_${rnd()}@test.dev`, password: 'passw0rd!x', display_name: name, invite_code: process.env.REGISTER_CODE || '' },
  });
  if (r.status !== 200) throw new Error(`注册失败 ${r.status} ${r.text.slice(0, 120)}`);
  return { id: r.json.me.id, cookie: r.cookie };
}

// 发一条 JSON-RPC，返回 {status, ct, json, text}
async function rpc(token, body, { path = '/mcp', headers = {}, method = 'POST' } = {}) {
  return api(path, { method, token, raw: method === 'GET' ? undefined : JSON.stringify(body), headers });
}

const initReq = (protocolVersion, id = 1) => ({
  jsonrpc: '2.0', id, method: 'initialize',
  params: { protocolVersion, capabilities: {}, clientInfo: { name: 'compat-test', version: '1.0.0' } },
});

const main = async () => {
  const owner = await signup('兼容性主人');
  const agent = await api('/api/agents', { method: 'POST', cookie: owner.cookie, body: { display_name: `兼容AI${rnd()}` } });
  const token = agent.json?.token;
  if (!token) throw new Error('建 AI 失败');

  // ---------------------------------------------------------------- 版本协商
  const v0618 = await rpc(token, initReq('2025-06-18'));
  check('版本协商：2025-06-18 → 原样回', v0618.json?.result?.protocolVersion === '2025-06-18',
    JSON.stringify(v0618.json?.result?.protocolVersion));
  const v0326 = await rpc(token, initReq('2025-03-26', 2));
  check('版本协商：2025-03-26 → 原样回', v0326.json?.result?.protocolVersion === '2025-03-26');
  const v1105 = await rpc(token, initReq('2024-11-05', 3));
  check('版本协商：2024-11-05 → 原样回', v1105.json?.result?.protocolVersion === '2024-11-05');
  const v1125 = await rpc(token, initReq('2025-11-25', 4));
  check('版本协商：2025-11-25（SDK 首选）→ 原样回，不再 -32602',
    v1125.status === 200 && v1125.json?.result?.protocolVersion === '2025-11-25',
    JSON.stringify(v1125.json).slice(0, 160));
  const v2026 = await rpc(token, initReq('2026-07-28', 5));
  check('版本协商：2026-07-28（未来版本）→ 200 + 回自己支持的最新版',
    v2026.status === 200 && v2026.json?.result?.protocolVersion === '2025-11-25',
    JSON.stringify(v2026.json?.result?.protocolVersion));
  const vJunk = await rpc(token, initReq('1.0.0', 6));
  check('版本协商：非 MCP 版本字符串 → 200 + 最新版（宽容，不打死客户端）',
    vJunk.status === 200 && vJunk.json?.result?.protocolVersion === '2025-11-25');
  check('initialize 必填三项齐全（protocolVersion/capabilities/serverInfo）',
    Boolean(v0618.json?.result?.protocolVersion) && typeof v0618.json?.result?.capabilities === 'object'
      && Boolean(v0618.json?.result?.serverInfo?.name));
  check('capabilities 只声明 tools（不虚假声明 resources/prompts/logging）',
    JSON.stringify(Object.keys(v0618.json?.result?.capabilities || {})) === '["tools"]',
    JSON.stringify(v0618.json?.result?.capabilities));

  // ---------------------------------------------------------------- 通知 / 通知 202
  const initialized = await api('/mcp', { method: 'POST', token, raw: JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }) });
  check('notifications/initialized → 202 + 空正文', initialized.status === 202 && initialized.text === '',
    `status=${initialized.status} len=${initialized.text.length}`);
  const cancelled = await api('/mcp', { method: 'POST', token, raw: JSON.stringify({ jsonrpc: '2.0', method: 'notifications/cancelled', params: { requestId: 1 } }) });
  check('notifications/cancelled → 202（未实现也必须回 202，不是 -32601）',
    cancelled.status === 202 && cancelled.text === '', `status=${cancelled.status}`);
  const unknownNotif = await api('/mcp', { method: 'POST', token, raw: JSON.stringify({ jsonrpc: '2.0', method: 'notifications/roots/list_changed' }) });
  check('未知通知 → 202 空正文（通知永远不能有响应体）',
    unknownNotif.status === 202 && unknownNotif.text === '');

  // ---------------------------------------------------------------- tools/list
  const list1 = await rpc(token, { jsonrpc: '2.0', id: 10, method: 'tools/list' });
  check('tools/list → 200 + application/json',
    list1.status === 200 && list1.ct.startsWith('application/json'), `ct=${list1.ct}`);
  check('tools/list 元素都有 name + object inputSchema',
    (list1.json?.result?.tools || []).every((t) => typeof t.name === 'string' && t.inputSchema?.type === 'object'));
  check('tools/list 不返回 nextCursor（无分页就别给 null）',
    !Object.prototype.hasOwnProperty.call(list1.json?.result || {}, 'nextCursor'),
    JSON.stringify(Object.keys(list1.json?.result || {})));
  const list2 = await rpc(token, { jsonrpc: '2.0', id: 11, method: 'tools/list' });
  check('tools/list 两次顺序一致（客户端能缓存工具索引）',
    JSON.stringify((list2.json?.result?.tools || []).map((t) => t.name))
      === JSON.stringify((list1.json?.result?.tools || []).map((t) => t.name)));

  // ---------------------------------------------------------------- tools/call
  const ok = await rpc(token, { jsonrpc: '2.0', id: 12, method: 'tools/call', params: { name: 'my_limits', arguments: {} } });
  const payload = ok.json?.result?.content?.[0];
  check('tools/call → content[0].type=text 且 text 是 JSON',
    payload?.type === 'text' && (() => { try { JSON.parse(payload.text); return true; } catch { return false; } })(),
    JSON.stringify(payload).slice(0, 120));
  check('tools/call 成功 isError 显式为 false', ok.json?.result?.isError === false);

  const nullArgs = await rpc(token, { jsonrpc: '2.0', id: 13, method: 'tools/call', params: { name: 'list_conversations', arguments: null } });
  check('arguments:null 按 {} 处理，不 500 / 不 -32602',
    nullArgs.status === 200 && nullArgs.json?.result?.isError === false,
    JSON.stringify(nullArgs.json).slice(0, 160));

  const unknownTool = await rpc(token, { jsonrpc: '2.0', id: 14, method: 'tools/call', params: { name: 'no_such_tool', arguments: {} } });
  check('未知工具 → JSON-RPC -32602（不是工具级 isError）',
    unknownTool.json?.error?.code === -32602, JSON.stringify(unknownTool.json).slice(0, 140));

  // ---------------------------------------------------------------- id 原样回传
  const strId = await rpc(token, { jsonrpc: '2.0', id: 'abc-123', method: 'ping' });
  check('字符串 id 原样回传', strId.json?.id === 'abc-123', JSON.stringify(strId.json?.id));
  const zeroId = await rpc(token, { jsonrpc: '2.0', id: 0, method: 'ping' });
  check('id:0 原样回传（不能用 if(!id) 判空）', zeroId.json?.id === 0, JSON.stringify(zeroId.json?.id));

  // ---------------------------------------------------------------- 能力探测
  const resources = await rpc(token, { jsonrpc: '2.0', id: 20, method: 'resources/list' });
  check('resources/list → 200 + []（不是 -32601）',
    resources.json?.error === undefined && JSON.stringify(resources.json?.result?.resources) === '[]',
    JSON.stringify(resources.json).slice(0, 140));
  const prompts = await rpc(token, { jsonrpc: '2.0', id: 21, method: 'prompts/list' });
  check('prompts/list → 200 + []', JSON.stringify(prompts.json?.result?.prompts) === '[]');

  // ---------------------------------------------------------------- HTTP 语义
  const get = await api('/mcp', { method: 'GET', token, headers: { accept: 'text/event-stream' } });
  check('GET /mcp → 405（规范允许；stateless 无 SSE）', get.status === 405, `status=${get.status}`);
  const del = await api('/mcp', { method: 'DELETE', token });
  check('DELETE /mcp → 405', del.status === 405, `status=${del.status}`);

  const onlyJsonAccept = await api('/mcp', {
    method: 'POST', token,
    raw: JSON.stringify({ jsonrpc: '2.0', id: 30, method: 'ping' }),
    headers: { accept: 'application/json' },
  });
  check('Accept 只带 application/json 也照常 200（规范不要求 406）', onlyJsonAccept.status === 200);

  const slashInit = await api('/mcp/', { method: 'POST', token, raw: JSON.stringify(initReq('2025-06-18', 31)) });
  check('POST /mcp/ 尾斜杠直接可用（不 301/302，POST 不会降级成 GET）',
    slashInit.status === 200 && slashInit.json?.result?.protocolVersion === '2025-06-18',
    `status=${slashInit.status}`);

  const preflight = await api('/mcp', {
    method: 'OPTIONS',
    headers: {
      origin: 'https://ide.example.com',
      'access-control-request-method': 'POST',
      'access-control-request-headers': 'authorization,content-type',
    },
  });
  check('OPTIONS /mcp → 204 + CORS 回显 Origin + 放行 authorization',
    preflight.status === 204
      && preflight.headers.get('access-control-allow-origin') === 'https://ide.example.com'
      && String(preflight.headers.get('access-control-allow-headers') || '').includes('authorization'),
    `status=${preflight.status} acao=${preflight.headers.get('access-control-allow-origin')}`);

  // ---------------------------------------------------------------- batch
  const batch = await api('/mcp', {
    method: 'POST', token,
    raw: JSON.stringify([
      { jsonrpc: '2.0', id: 40, method: 'ping' },
      { jsonrpc: '2.0', method: 'notifications/initialized' },
      { jsonrpc: '2.0', id: 41, method: 'tools/list' },
    ]),
  });
  check('batch → 数组且通知不出现在响应里（2 条）',
    batch.status === 200 && Array.isArray(batch.json) && batch.json.length === 2,
    `status=${batch.status} n=${Array.isArray(batch.json) ? batch.json.length : 'non-array'}`);

  // ---------------------------------------------------------------- 鉴权语义
  const noAuth = await api('/mcp', { method: 'POST', raw: JSON.stringify({ jsonrpc: '2.0', id: 50, method: 'ping' }) });
  check('无 token → 401 + WWW-Authenticate: Bearer（不 403/302）',
    noAuth.status === 401 && String(noAuth.headers.get('www-authenticate') || '').startsWith('Bearer'),
    `status=${noAuth.status} www=${noAuth.headers.get('www-authenticate')}`);
  const badAuth = await api('/mcp', { method: 'POST', token: 'qqa_bad', raw: JSON.stringify({ jsonrpc: '2.0', id: 51, method: 'ping' }) });
  check('错误 token → 401（错误 token 不能被当成 403 或 500）', badAuth.status === 401, `status=${badAuth.status}`);

  // ---------------------------------------------------------------- UTF-8
  const cn = await rpc(token, { jsonrpc: '2.0', id: 60, method: 'tools/call', params: { name: 'find_groups', arguments: { query: '中文关键词' } } });
  check('中文参数（UTF-8）能被正确解析', cn.json?.error === undefined && cn.json?.result?.isError === false,
    JSON.stringify(cn.json).slice(0, 140));

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
