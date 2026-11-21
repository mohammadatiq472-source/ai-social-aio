// MCP 现代化回归（P2-8/9）：tool annotations、my_limits structuredContent、
// resources/prompts。
//
// 覆盖的契约：
//   1. initialize.capabilities 同时含 tools / resources / prompts；
//   2. tools/list 的工具（20+）都有 title + annotations 四字段（布尔），抽样语义：
//      whats_new 只读、send_message 幂等非破坏、leave_group 破坏性、
//      create_sticker_pack 非幂等、所有工具 openWorldHint=false；
//   3. my_limits 同时返回 content[0].text 与 structuredContent，字段一致；
//      其它工具（list_conversations）不带 structuredContent（避免上下文翻倍）；
//   4. resources/templates/list 有 aio://conversations/{id}/announcement；
//      resources/read 成员可读、非成员 -32003（data.status=403）、坏 URI -32602；
//      resources/list 仍为空（不枚举会话）；
//   5. prompts/list 有 group_rules；prompts/get 返回含群名+公告的 user message；
//      空公告给「本群没有公告」；非成员 -32003。
//
// 用法：node scripts/verify/verify-mcp-modern.mjs
// 前置：8787 已起、本机 5434/aio、demo 与 buddy 账号（demo-qqmini-2026）。
// 会创建两个临时群 + 一只临时 AI，结束后尽力清理（软解散/删除 AI）。
import crypto from 'node:crypto';

const BASE = (process.env.BASE || 'http://127.0.0.1:8787').replace(/\/$/, '');
const results = [];
const rnd = () => crypto.randomBytes(4).toString('hex');
const tag = rnd();

function check(name, ok, detail = '') {
  results.push({ name, ok });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? '  — ' + detail : ''}`);
}
function skip(name, detail = '') {
  results.push({ name, ok: true, skipped: true });
  console.log(`SKIP  ${name}${detail ? '  — ' + detail : ''}`);
}

async function api(path, { method = 'GET', body, cookie } = {}) {
  const headers = {};
  if (body !== undefined) headers['content-type'] = 'application/json';
  if (cookie) headers.cookie = cookie;
  const res = await fetch(`${BASE}${path}`, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  let json = null;
  try { json = text ? JSON.parse(text) : null; } catch { /* 非 JSON */ }
  const setCookie = res.headers.getSetCookie?.() || [];
  const sid = setCookie.map((c) => String(c).split(';')[0]).find((c) => c.startsWith('sid='));
  return { status: res.status, json, text, cookie: sid || cookie };
}

async function login(email) {
  const r = await api('/api/auth/login', {
    method: 'POST',
    body: { email, password: 'demo-qqmini-2026' },
  });
  return r.status === 200 && r.cookie ? r.cookie : null;
}

async function rpc(token, body) {
  const r = await fetch(`${BASE}/mcp`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
    body: JSON.stringify(body),
  });
  const text = await r.text();
  let json = null;
  try { json = text ? JSON.parse(text) : null; } catch { /* 非 JSON */ }
  return { status: r.status, json, text };
}

const cookie = await login('demo@qqmini.dev');
const buddyCookie = await login('buddy@qqmini.dev');
if (!cookie || !buddyCookie) {
  console.log(`SKIP：demo/buddy 登录失败（cookie=${Boolean(cookie)}/${Boolean(buddyCookie)}），无法验证`);
  process.exitCode = 0;
} else {
  let token = '';
  let agentId = null;
  const groups = [];
  try {
    // 准备：AI + 两个群（有公告 / 空公告）+ buddy 的私有群（非成员）
    const mk = await api('/api/agents', {
      method: 'POST', cookie, body: { display_name: `现代AI${tag}` },
    });
    token = mk.json?.token;
    agentId = mk.json?.agent?.id ?? null;
    check('准备：建临时 AI 拿 token', mk.status === 200 && Boolean(token));

    const gA = await api('/api/conversations', {
      method: 'POST', cookie, body: { title: `MCP现代-公告-${tag}`, member_ids: agentId ? [agentId] : [] },
    });
    const gidA = gA.json?.conversation?.id;
    groups.push(gidA);
    check('准备：建带公告的群（AI 是成员）', Boolean(gidA), `id=${gidA}`);

    const ann = `本群规则-${tag}：只聊测试；禁止刷屏。`;
    const setAnn = await api(`/api/conversations/${gidA}/announcement`, {
      method: 'PATCH', cookie, body: { announcement: ann },
    });
    check('准备：写入群公告', setAnn.status === 200 && setAnn.json?.announcement === ann,
      `status=${setAnn.status}`);

    const gB = await api('/api/conversations', {
      method: 'POST', cookie, body: { title: `MCP现代-空公告-${tag}`, member_ids: agentId ? [agentId] : [] },
    });
    const gidB = gB.json?.conversation?.id;
    groups.push(gidB);
    check('准备：建空公告群（AI 是成员）', Boolean(gidB), `id=${gidB}`);

    const gC = await api('/api/conversations', {
      method: 'POST', cookie: buddyCookie, body: { title: `MCP现代-非成员-${tag}`, member_ids: [] },
    });
    const gidC = gC.json?.conversation?.id;
    groups.push(gidC);
    check('准备：buddy 建私有群（AI 不是成员）', Boolean(gidC), `id=${gidC}`);

    // 1) initialize capabilities
    const init = await rpc(token, {
      jsonrpc: '2.0', id: 1, method: 'initialize',
      params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'modern-test', version: '1.0.0' } },
    });
    const caps = init.json?.result?.capabilities || {};
    check('initialize 同时声明 tools/resources/prompts',
      Boolean(caps.tools) && Boolean(caps.resources) && Boolean(caps.prompts),
      JSON.stringify(caps));

    // 2) tools/list annotations
    const list = await rpc(token, { jsonrpc: '2.0', id: 2, method: 'tools/list' });
    const tools = list.json?.result?.tools || [];
    // 这里只守下限：精确工具面（少一个/多一个/字段变了）由 verify-mcp-tools-snapshot 的快照比对照守，
    // 否则每加一个工具都要改这个数字（第 21 个 get_context 时就撞了一次）。
    check('tools/list 至少 20 个工具（精确面由 tools-snapshot 守）', tools.length >= 20, `n=${tools.length}`);
    const noTitle = tools.filter((t) => typeof t.title !== 'string' || !t.title.trim());
    check('每个工具都有非空 title', noTitle.length === 0, noTitle.map((t) => t.name).join(', ') || `${tools.length}/${tools.length}`);
    const badAnn = tools.filter((t) => {
      const a = t.annotations;
      return !a || typeof a !== 'object'
        || typeof a.readOnlyHint !== 'boolean' || typeof a.destructiveHint !== 'boolean'
        || typeof a.idempotentHint !== 'boolean' || typeof a.openWorldHint !== 'boolean';
    });
    check('每个工具都有 annotations 四个布尔字段', badAnn.length === 0,
      badAnn.map((t) => t.name).join(', ') || '20/20');
    const byName = new Map(tools.map((t) => [t.name, t]));
    const annOf = (n) => byName.get(n)?.annotations || {};
    check('只读抽样：whats_new/my_limits/list_conversations readOnlyHint=true',
      annOf('whats_new').readOnlyHint === true
      && annOf('my_limits').readOnlyHint === true
      && annOf('list_conversations').readOnlyHint === true);
    check('send_message：非只读、不破坏、幂等（client_msg_id）',
      annOf('send_message').readOnlyHint === false
      && annOf('send_message').destructiveHint === false
      && annOf('send_message').idempotentHint === true);
    check('leave_group：destructiveHint=true',
      annOf('leave_group').destructiveHint === true && annOf('leave_group').readOnlyHint === false);
    check('create_sticker_pack：idempotentHint=false（每次新建）',
      annOf('create_sticker_pack').idempotentHint === false);
    check('所有工具 openWorldHint=false（只操作 AIO 站内）',
      tools.every((t) => t.annotations?.openWorldHint === false));

    // 3) structuredContent 试点
    const lim = await rpc(token, {
      jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'my_limits', arguments: {} },
    });
    const limRes = lim.json?.result;
    const limText = limRes?.content?.[0]?.text || '';
    let limJson = null;
    try { limJson = JSON.parse(limText); } catch { limJson = null; }
    check('my_limits 同时返回 content 文本与 structuredContent',
      Boolean(limJson) && Boolean(limRes?.structuredContent) && limRes.isError === false,
      `keys=${Object.keys(limRes?.structuredContent || {}).slice(0, 6).join(',')}`);
    check('my_limits text 与 structuredContent 字段一致（agent_id/daily_limit/hint）',
      limJson?.agent_id === limRes?.structuredContent?.agent_id
      && limJson?.daily_limit === limRes?.structuredContent?.daily_limit
      && limJson?.hint === limRes?.structuredContent?.hint);
    const other = await rpc(token, {
      jsonrpc: '2.0', id: 4, method: 'tools/call', params: { name: 'list_conversations', arguments: {} },
    });
    check('其它工具不带 structuredContent（避免上下文翻倍）',
      !Object.prototype.hasOwnProperty.call(other.json?.result || {}, 'structuredContent'));

    // 4) resources
    const tpl = await rpc(token, { jsonrpc: '2.0', id: 5, method: 'resources/templates/list' });
    const templates = tpl.json?.result?.resourceTemplates || [];
    const t0 = templates[0];
    check('resources/templates/list 有公告模板',
      templates.length === 1 && t0?.uriTemplate === 'aio://conversations/{conversation_id}/announcement'
      && t0?.name === 'conversation_announcement' && t0?.mimeType === 'text/plain'
      && typeof t0?.title === 'string' && typeof t0?.description === 'string',
      JSON.stringify(t0));

    const uriA = `aio://conversations/${gidA}/announcement`;
    const readA = await rpc(token, {
      jsonrpc: '2.0', id: 6, method: 'resources/read', params: { uri: uriA },
    });
    check('resources/read：成员读到公告原文',
      readA.json?.result?.contents?.[0]?.text === ann
      && readA.json?.result?.contents?.[0]?.mimeType === 'text/plain'
      && readA.json?.result?.contents?.[0]?.uri === uriA,
      JSON.stringify(readA.json?.result)?.slice(0, 160));

    const readC = await rpc(token, {
      jsonrpc: '2.0', id: 7, method: 'resources/read',
      params: { uri: `aio://conversations/${gidC}/announcement` },
    });
    check('resources/read：非成员 → -32003 且 data.status=403',
      readC.json?.error?.code === -32003 && readC.json?.error?.data?.status === 403,
      JSON.stringify(readC.json?.error)?.slice(0, 160));

    const readBad = await rpc(token, {
      jsonrpc: '2.0', id: 8, method: 'resources/read', params: { uri: 'aio://nope' },
    });
    check('resources/read：坏 URI → -32602', readBad.json?.error?.code === -32602,
      JSON.stringify(readBad.json?.error)?.slice(0, 140));

    const rlist = await rpc(token, { jsonrpc: '2.0', id: 9, method: 'resources/list' });
    check('resources/list 仍为空（不枚举会话）', Array.isArray(rlist.json?.result?.resources)
      && rlist.json.result.resources.length === 0);

    // 5) prompts
    const plist = await rpc(token, { jsonrpc: '2.0', id: 10, method: 'prompts/list' });
    const prompts = plist.json?.result?.prompts || [];
    const p0 = prompts[0];
    check('prompts/list 有 group_rules 且 conversation_id 必填',
      prompts.length === 1 && p0?.name === 'group_rules'
      && p0?.arguments?.[0]?.name === 'conversation_id' && p0?.arguments?.[0]?.required === true,
      JSON.stringify(p0));

    const pget = await rpc(token, {
      jsonrpc: '2.0', id: 11, method: 'prompts/get',
      params: { name: 'group_rules', arguments: { conversation_id: gidA } },
    });
    const msg = pget.json?.result?.messages?.[0];
    check('prompts/get：返回一条 user message（含群名 + 公告）',
      msg?.role === 'user' && msg?.content?.type === 'text'
      && msg.content.text.includes(`MCP现代-公告-${tag}`) && msg.content.text.includes(ann),
      msg?.content?.text?.slice(0, 120));

    const pEmpty = await rpc(token, {
      jsonrpc: '2.0', id: 12, method: 'prompts/get',
      params: { name: 'group_rules', arguments: { conversation_id: gidB } },
    });
    check('prompts/get：空公告给「本群没有公告」',
      (pEmpty.json?.result?.messages?.[0]?.content?.text || '').includes('本群没有公告'),
      pEmpty.json?.result?.messages?.[0]?.content?.text?.slice(0, 100));

    const pDenied = await rpc(token, {
      jsonrpc: '2.0', id: 13, method: 'prompts/get',
      params: { name: 'group_rules', arguments: { conversation_id: gidC } },
    });
    check('prompts/get：非成员 → -32003', pDenied.json?.error?.code === -32003,
      JSON.stringify(pDenied.json?.error)?.slice(0, 140));

    const pMissing = await rpc(token, {
      jsonrpc: '2.0', id: 14, method: 'prompts/get', params: { name: 'group_rules', arguments: {} },
    });
    check('prompts/get：缺 conversation_id → -32602', pMissing.json?.error?.code === -32602,
      JSON.stringify(pMissing.json?.error)?.slice(0, 140));
  } catch (err) {
    check('脚本执行', false, err.message);
  } finally {
    // 尽力清理：软解散群（owner 才能删）+ 删除临时 AI；失败不影响测试结论
    for (const gid of groups.filter(Boolean)) {
      try { await api(`/api/conversations/${gid}`, { method: 'DELETE', cookie }); } catch { /* ignore */ }
      try { await api(`/api/conversations/${gid}`, { method: 'DELETE', cookie: buddyCookie }); } catch { /* ignore */ }
    }
    if (agentId) { try { await api(`/api/agents/${agentId}`, { method: 'DELETE', cookie }); } catch { /* ignore */ } }
  }

  const failed = results.filter((r) => !r.ok);
  console.log(`\n${failed.length === 0 ? '全部通过' : '有失败'}：${results.length - failed.length}/${results.length}`);
  if (failed.length) {
    console.log('失败项：' + failed.map((f) => f.name).join('; '));
    process.exitCode = 1;
  }
}
