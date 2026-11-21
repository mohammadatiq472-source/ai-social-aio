// 群公告（群规）回归：只有群主/管理员能改，纯文本 ≤2000 字，AI 能读到，变更留事件。
//
// 覆盖：
//   1. 群主设公告 → 200；刷新后会话列表里 announcement / announcementUpdatedAt 都在
//   2. 普通成员 / 非成员 / 未登录 → 403 / 403 / 401
//   3. 群主把成员设为管理员后，管理员也能改
//   4. 长度闸：2001 字 → 400 invalid_schema 且库里没被写坏；正好 2000 字 → 200
//   5. 纯文本：HTML 原样保存（不转义、不解析）、CRLF 归一、首尾空白 trim
//   6. 清空（空字符串）→ 200 changed=true；重复提交同内容 → changed=false 且不写事件
//   7. 审计：events 里 GroupAnnouncementChanged 只记 length，不含正文
//   8. DB 兜底：直连库写 2001 字会被 CHECK 拒绝（应用层之外还有一道）
//   9. AI 读：initialize.instructions 写明「发言前先读 announcement」；
//      list_conversations 输出 announcement + announcement_updated_at（snake_case）
//  10. AI 不能改（REST 只有 cookie 会话；Bearer 调用 → 401）
//  11. 解散的群不能再改 → 404
//
// 用法：
//   BASE=http://127.0.0.1:8787 node scripts/verify/verify-group-announcement.mjs
//   （DATABASE_URL 可直连库时，会额外做「事件内容 / DB CHECK」两条断言；连不上自动跳过并注明）
//
// 前置：服务已起；注册可用（开放注册 / 配好 REGISTER_CODE / 或本机可直连库造 bootstrap 码）。

import crypto from 'node:crypto';
import pg from 'pg';
import { WebSocket } from 'ws';

const BASE = (process.env.BASE || 'http://127.0.0.1:8787').replace(/\/$/, '');
const DB_URL = process.env.ADMIN_DATABASE_URL || process.env.DATABASE_URL || '';
const results = [];
const rnd = () => crypto.randomBytes(5).toString('hex');

function check(name, ok, detail = '') {
  results.push({ name, ok });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? '  — ' + detail : ''}`);
}

async function api(path, { method = 'GET', body, cookie, token, headers: extraHeaders } = {}) {
  const headers = { ...(extraHeaders || {}) };
  if (body !== undefined) headers['content-type'] = 'application/json';
  if (cookie) headers.cookie = cookie;
  if (token) headers.authorization = `Bearer ${token}`;
  const res = await fetch(`${BASE}${path}`, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
  const text = await res.text();
  let json = null;
  try { json = text ? JSON.parse(text) : null; } catch { /* 非 JSON */ }
  const setCookie = res.headers.getSetCookie?.() || [];
  const sid = setCookie.map((c) => String(c).split(';')[0]).find((c) => c.startsWith('sid='));
  return { status: res.status, json, text, cookie: sid || cookie };
}

// ---------------------------------------------------------------- 可选直连库
let admin = null;
async function db() {
  if (admin) return admin;
  if (!DB_URL) return null;
  const c = new pg.Client({ connectionString: DB_URL, connectionTimeoutMillis: 3000 });
  await c.connect();
  admin = c;
  return admin;
}
async function q(text, params = []) {
  const c = await db();
  if (!c) return null;
  const r = await c.query(text, params);
  return r.rows;
}

// 注册：先试不带码（开放注册 / env 兼容）；被 403 拒绝且本机能直连库时，用 bootstrap 码再来一次。
// bootstrap 码直接写库（库里只有 HMAC），所以需要与服务端一致的 SESSION_SECRET。
//
// 每次注册带一个独立的 cf-connecting-ip：本机服务在 loopback 上信任这个头（routes.mjs#clientIp，
// 生产里由 Cloudflare 覆盖）。这样 bootstrap 兜底也不会撞上「同一 IP 24h 最多 3 次兑换」的闸门。
async function register(name) {
  const email = `t_${rnd()}@test.dev`;
  const ip = `10.${crypto.randomInt(1, 250)}.${crypto.randomInt(1, 250)}.${crypto.randomInt(1, 250)}`;
  const doReg = (inviteCode) => api('/api/auth/register', {
    method: 'POST',
    headers: { 'cf-connecting-ip': ip },
    body: { email, password: 'passw0rd!x', display_name: name, invite_code: inviteCode },
  });
  let r = await doReg(process.env.REGISTER_CODE || '');
  if (r.status === 403) {
    const code = await bootstrapCode();
    if (code) r = await doReg(code);
  }
  if (r.status !== 200) throw new Error(`注册失败 ${r.status} ${String(r.text || '').slice(0, 140)}`);
  return { id: r.json.me.id, accountNo: r.json.me.accountNo, cookie: r.cookie };
}

async function bootstrapCode() {
  try {
    process.env.SESSION_SECRET = process.env.SESSION_SECRET || 'dev-only-secret';
    const { generateCodeBody, formatCode, hashCode } = await import('../../src/core/invites.mjs');
    const body = generateCodeBody();
    const rows = await q(
      `INSERT INTO invite_codes (owner_user_id, code_hash, code_prefix, max_uses, expires_at, note)
       VALUES (NULL,$1,$2,1, now() + interval '1 day', 'verify-announcement bootstrap') RETURNING id`,
      [hashCode(body), body.slice(0, 4)],
    );
    return rows ? formatCode(body) : null;
  } catch {
    return null;
  }
}

async function befriend(a, b) {
  await api('/api/friends/request', { method: 'POST', cookie: a.cookie, body: { account_no: b.accountNo } });
  await api('/api/friends/accept', { method: 'POST', cookie: b.cookie, body: { principal_id: a.id } });
}

async function mcp(token, method, params, id = 1) {
  return api('/mcp', {
    method: 'POST', token,
    body: { jsonrpc: '2.0', id, method, params },
  });
}

// 实时帧用例要真的连一条 WS：不连就只能验「写库成功」，验不出「别人页面会不会变」
function openWs(cookie) {
  return new Promise((resolve) => {
    const frames = [];
    const sock = new WebSocket(`${BASE.replace(/^http/, 'ws')}/ws`, { headers: { Cookie: cookie } });
    const done = (extra = {}) => resolve({ sock, frames, ...extra });
    const timer = setTimeout(() => done({ helloTimeout: true }), 2000);
    sock.on('message', (raw) => {
      let f = null;
      try { f = JSON.parse(String(raw)); } catch { return; }
      frames.push(f);
      if (f.t === 'hello') { clearTimeout(timer); done(); }
    });
    sock.on('error', (err) => { clearTimeout(timer); done({ error: err.message }); });
  });
}

async function waitFrame(frames, pred, ms = 3000) {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) {
    const hit = frames.find(pred);
    if (hit) return hit;
    await new Promise((r) => setTimeout(r, 50));
  }
  return null;
}

const ANNOUNCEMENT_MAX = 2000;

const main = async () => {
  const owner = await register('公告群主');
  const member = await register('公告成员');
  const outsider = await register('公告路人');
  await befriend(owner, member);

  // 群主自己的 AI（用来验证 AI 读公告）
  const agentRes = await api('/api/agents', { method: 'POST', cookie: owner.cookie, body: { display_name: `公告AI${rnd()}` } });
  const agentId = agentRes.json?.agent?.id;
  const agentToken = agentRes.json?.token;
  if (!agentToken) throw new Error(`建 AI 失败 ${agentRes.status} ${String(agentRes.text || '').slice(0, 120)}`);

  const g = await api('/api/conversations', {
    method: 'POST', cookie: owner.cookie, body: { title: `公告群${rnd()}`, member_ids: [member.id] },
  });
  const gid = Number(g.json?.conversation?.id);
  if (!gid) throw new Error(`建群失败 ${g.status} ${String(g.text || '').slice(0, 120)}`);
  await api(`/api/conversations/${gid}/members`, { method: 'POST', cookie: owner.cookie, body: { principal_id: agentId } });

  // ---------------------------------------------------------------- 1) 群主设公告
  const text1 = '群规：1) 不许刷屏 2) 引用要带来源 3) AI 发言前先读公告';
  const set1 = await api(`/api/conversations/${gid}/announcement`, { method: 'PATCH', cookie: owner.cookie, body: { announcement: text1 } });
  check('群主设置公告 → 200 且 changed=true',
    set1.status === 200 && set1.json?.changed === true && set1.json?.announcement === text1, `status=${set1.status}`);
  check('响应带 announcementUpdatedAt',
    typeof set1.json?.announcementUpdatedAt === 'string' && set1.json.announcementUpdatedAt.length > 10, String(set1.json?.announcementUpdatedAt));

  const listOwner = await api('/api/conversations', { cookie: owner.cookie });
  const convOwner = (listOwner.json || []).find((c) => Number(c.id) === gid);
  check('会话列表返回 announcement + announcementUpdatedAt',
    convOwner?.announcement === text1 && Boolean(convOwner?.announcementUpdatedAt), '');
  const listMember = await api('/api/conversations', { cookie: member.cookie });
  const convMember = (listMember.json || []).find((c) => Number(c.id) === gid);
  check('普通成员也能读到公告（列表同一份）', convMember?.announcement === text1, '');

  // ---------------------------------------------------------------- 2) 权限
  const byMember = await api(`/api/conversations/${gid}/announcement`, { method: 'PATCH', cookie: member.cookie, body: { announcement: '我要改群规' } });
  check('普通成员改公告 → 403', byMember.status === 403 && byMember.json?.error === 'forbidden', `status=${byMember.status}`);
  const byOutsider = await api(`/api/conversations/${gid}/announcement`, { method: 'PATCH', cookie: outsider.cookie, body: { announcement: '路人甲' } });
  check('非成员改公告 → 403', byOutsider.status === 403, `status=${byOutsider.status}`);
  const anon = await api(`/api/conversations/${gid}/announcement`, { method: 'PATCH', body: { announcement: '匿名' } });
  check('未登录改公告 → 401', anon.status === 401, `status=${anon.status}`);
  const afterDenied = await api('/api/conversations', { cookie: owner.cookie });
  check('被拒的请求没有改到公告',
    (afterDenied.json || []).find((c) => Number(c.id) === gid)?.announcement === text1, '');

  // ---------------------------------------------------------------- 3) 管理员也能改
  const promote = await api(`/api/conversations/${gid}/members/${member.id}/role`, {
    method: 'POST', cookie: owner.cookie, body: { role: 'admin' },
  });
  const text2 = '群规 v2：AI 必须先读公告再发言；违规三次移出。';
  const byAdmin = await api(`/api/conversations/${gid}/announcement`, { method: 'PATCH', cookie: member.cookie, body: { announcement: text2 } });
  check('管理员（非群主）也能改公告',
    promote.status === 200 && byAdmin.status === 200 && byAdmin.json?.announcement === text2,
    `promote=${promote.status} patch=${byAdmin.status}`);

  // ---------------------------------------------------------------- 4) 长度闸
  const text2001 = '长'.repeat(ANNOUNCEMENT_MAX + 1);
  const tooLong = await api(`/api/conversations/${gid}/announcement`, { method: 'PATCH', cookie: owner.cookie, body: { announcement: text2001 } });
  check('2001 字 → 400 invalid_schema', tooLong.status === 400 && tooLong.json?.error === 'invalid_schema', `status=${tooLong.status}`);
  const afterTooLong = await api('/api/conversations', { cookie: owner.cookie });
  check('超长被拒后公告仍是上一次的内容',
    (afterTooLong.json || []).find((c) => Number(c.id) === gid)?.announcement === text2, '');
  const text2000 = '满'.repeat(ANNOUNCEMENT_MAX);
  const exact = await api(`/api/conversations/${gid}/announcement`, { method: 'PATCH', cookie: owner.cookie, body: { announcement: text2000 } });
  check('正好 2000 字 → 200', exact.status === 200 && exact.json?.announcement === text2000, `status=${exact.status}`);
  // emoji 按码点算：1001 个 emoji = 1001 个字（.length 会算成 2002，旧实现会误拒）
  const emoji = '🦊'.repeat(1001);
  const emojiRes = await api(`/api/conversations/${gid}/announcement`, { method: 'PATCH', cookie: owner.cookie, body: { announcement: emoji } });
  check('emoji 按码点计数（1001 个 emoji 不算超长）', emojiRes.status === 200 && emojiRes.json?.announcement === emoji, `status=${emojiRes.status}`);

  // ---------------------------------------------------------------- 5) 纯文本
  const raw = '  <script>alert(1)</script>\r\n第二行\tTab  \r\n';
  const plain = await api(`/api/conversations/${gid}/announcement`, { method: 'PATCH', cookie: owner.cookie, body: { announcement: raw } });
  const expected = '<script>alert(1)</script>\n第二行\tTab';
  check('HTML 原样保存（不转义）、CRLF→LF、首尾空白 trim',
    plain.status === 200 && plain.json?.announcement === expected,
    `got=${JSON.stringify(String(plain.json?.announcement).slice(0, 40))}`);
  const nonString = await api(`/api/conversations/${gid}/announcement`, { method: 'PATCH', cookie: owner.cookie, body: { announcement: 123 } });
  const missing = await api(`/api/conversations/${gid}/announcement`, { method: 'PATCH', cookie: owner.cookie, body: {} });
  check('非字符串 / 缺字段 → 400 invalid_schema',
    nonString.status === 400 && missing.status === 400, `${nonString.status}/${missing.status}`);

  // ---------------------------------------------------------------- 6) 幂等与清空
  const snapshot = (await q('SELECT announcement_updated_at FROM conversations WHERE id=$1', [gid]))?.[0];
  const same = await api(`/api/conversations/${gid}/announcement`, { method: 'PATCH', cookie: owner.cookie, body: { announcement: expected } });
  check('重复提交相同内容 → changed=false（不写事件）', same.status === 200 && same.json?.changed === false, `changed=${same.json?.changed}`);
  if (snapshot) {
    const after = (await q('SELECT announcement_updated_at FROM conversations WHERE id=$1', [gid]))[0];
    check('重复提交不刷新 announcement_updated_at',
      new Date(after.announcement_updated_at).getTime() === new Date(snapshot.announcement_updated_at).getTime(), '');
  } else {
    check('重复提交不刷新 announcement_updated_at（跳过：直连库不可用）', true, 'SKIP');
  }
  const cleared = await api(`/api/conversations/${gid}/announcement`, { method: 'PATCH', cookie: owner.cookie, body: { announcement: '' } });
  check('空字符串清空公告 → changed=true', cleared.status === 200 && cleared.json?.changed === true && cleared.json?.announcement === '', '');
  const listCleared = await api('/api/conversations', { cookie: member.cookie });
  check('清空后列表里是空字符串（不是 null/undefined）',
    (listCleared.json || []).find((c) => Number(c.id) === gid)?.announcement === '', '');

  // ---------------------------------------------------------------- 7) 审计 + DB 兜底
  const evRows = await q(
    `SELECT payload FROM events WHERE type='GroupAnnouncementChanged' AND aggregate_id=$1 ORDER BY id`,
    [gid],
  );
  if (evRows) {
    const payloads = evRows.map((r) => r.payload || {});
    check('每次真实变更都写了 GroupAnnouncementChanged 事件',
      payloads.length >= 5, `n=${payloads.length}`);
    check('事件 payload 只有 length、不含公告正文',
      payloads.every((p) => Number.isInteger(Number(p.length)) && Object.keys(p).length === 1
        && !JSON.stringify(p).includes('群规') && !JSON.stringify(p).includes('script')),
      JSON.stringify(payloads[payloads.length - 1]));
    const dbReject = await q(
      `UPDATE conversations SET announcement = $2 WHERE id = $1`,
      [gid, '溢'.repeat(ANNOUNCEMENT_MAX + 1)],
    ).then(() => null).catch((e) => e);
    check('DB CHECK 兜底：直连库写 2001 字被拒绝', Boolean(dbReject) && String(dbReject.code) === '23514',
      dbReject ? `code=${dbReject.code}` : '没有被拒绝');
  } else {
    check('审计事件断言（跳过：直连库不可用）', true, 'SKIP');
    check('DB CHECK 兜底（跳过：直连库不可用）', true, 'SKIP');
  }

  // ---------------------------------------------------------------- 7.5) 实时帧
  // 为什么要单独验：没有 WS 帧时「改公告」只对保存者即时生效，别人得刷新才看到——
  // 那正是 R10 记的取舍。改成实时之后必须钉住，否则最容易在后续重构里被悄悄优化掉。
  const wsMember = await openWs(member.cookie);
  const wsOutsider = await openWs(outsider.cookie);
  const liveText = '实时公告：保存后别人的页面应立刻更新，不需要刷新。';
  const liveSet = await api(`/api/conversations/${gid}/announcement`, {
    method: 'PATCH', cookie: owner.cookie, body: { announcement: liveText },
  });
  const liveFrame = await waitFrame(
    wsMember.frames,
    (f) => f.t === 'announcement' && Number(f.conversationId) === gid,
  );
  check(
    '在线成员收到 announcement 实时帧',
    liveSet.status === 200 && Boolean(liveFrame),
    liveFrame ? 'ok' : `frames=${JSON.stringify(wsMember.frames.map((f) => f.t))}${wsMember.error ? ` err=${wsMember.error}` : ''}`,
  );
  check('实时帧带完整正文（客户端不用再回查）', liveFrame?.announcement === liveText, '');
  check(
    '实时帧带 updatedAt（用来判断公告是否换过）',
    typeof liveFrame?.updatedAt === 'string' && liveFrame.updatedAt.length > 10,
    String(liveFrame?.updatedAt),
  );

  // 重复保存（changed=false）不该再广播：否则用户每点一次保存，公告条就闪一次
  const countAnnounce = (frames) => frames.filter((f) => f.t === 'announcement' && Number(f.conversationId) === gid).length;
  const beforeDup = countAnnounce(wsMember.frames);
  await api(`/api/conversations/${gid}/announcement`, {
    method: 'PATCH', cookie: owner.cookie, body: { announcement: liveText },
  });
  await new Promise((r) => setTimeout(r, 400));
  const afterDup = countAnnounce(wsMember.frames);
  check('重复保存同一份公告 → 不重复广播', afterDup === beforeDup, `${beforeDup}→${afterDup}`);

  // 非成员连 WS 也不该知道这个群存在
  check(
    '非成员收不到该群公告帧',
    countAnnounce(wsOutsider.frames) === 0,
    `frames=${JSON.stringify(wsOutsider.frames.map((f) => f.t))}`,
  );

  try { wsMember.sock.close(); } catch { /* 已断 */ }
  try { wsOutsider.sock.close(); } catch { /* 已断 */ }

  // ---------------------------------------------------------------- 8) AI 读
  const init = await mcp(agentToken, 'initialize', {
    protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'verify-announcement', version: '1.0.0' },
  });
  const instructions = init.json?.result?.instructions || '';
  check('initialize.instructions 写明发言前先读 announcement',
    instructions.includes('announcement') && instructions.includes('群规'), `len=${instructions.length}`);

  const restore = await api(`/api/conversations/${gid}/announcement`, {
    method: 'PATCH', cookie: owner.cookie, body: { announcement: 'AI 读公告用例：不许在群里发广告。' },
  });
  const listed = await mcp(agentToken, 'tools/call', { name: 'list_conversations', arguments: {} });
  const text = listed.json?.result?.content?.[0]?.text;
  let convs = null;
  try { convs = text ? JSON.parse(text) : null; } catch { convs = null; }
  const aiConv = (convs?.conversations || []).find((c) => Number(c.id) === gid);
  check('MCP list_conversations 输出 announcement（snake_case 与 camel 兼容）',
    restore.status === 200 && aiConv?.announcement === 'AI 读公告用例：不许在群里发广告。',
    JSON.stringify(aiConv?.announcement ?? null));
  check('MCP list_conversations 输出 announcement_updated_at',
    aiConv && 'announcement_updated_at' in aiConv && Boolean(aiConv.announcement_updated_at), '');
  const toolsRes = await mcp(agentToken, 'tools/list', {});
  const lcTool = (toolsRes.json?.result?.tools || []).find((t) => t.name === 'list_conversations');
  check('tools/list 的 list_conversations 描述提到 announcement（可发现性）',
    String(lcTool?.description || '').includes('announcement'), '');

  // ---------------------------------------------------------------- 9) AI 不能改 / 解散后
  const aiPatch = await api(`/api/conversations/${gid}/announcement`, {
    method: 'PATCH', token: agentToken, body: { announcement: 'AI 自己改群规' },
  });
  check('AI（Bearer）改公告 → 401（REST 只认人类会话）', aiPatch.status === 401, `status=${aiPatch.status}`);

  const dissolve = await api(`/api/conversations/${gid}`, { method: 'DELETE', cookie: owner.cookie });
  // 解散会清空 conversation_members，所以原群主此时已经「不在这个群里」——
  // 权限判定先于「群是否已解散」返回 403（和 send_message / 群设置等既有接口一致）。
  // 这里同时接受 403/404，重点是「改不动」，不是状态码本身。
  const afterDissolve = await api(`/api/conversations/${gid}/announcement`, { method: 'PATCH', cookie: owner.cookie, body: { announcement: '解散后' } });
  check('解散的群改公告 → 403/404（已不是成员/群已解散）',
    dissolve.status === 200 && [403, 404].includes(afterDissolve.status), `dissolve=${dissolve.status} patch=${afterDissolve.status}`);
  const afterRow = await q('SELECT announcement FROM conversations WHERE id=$1', [gid]);
  if (afterRow) {
    check('解散后公告没有被改掉（库里仍是解散前的内容）',
      afterRow[0].announcement === 'AI 读公告用例：不许在群里发广告。', JSON.stringify(afterRow[0].announcement));
  } else {
    check('解散后公告没有被改掉（跳过：直连库不可用）', true, 'SKIP');
  }

  const failed = results.filter((r) => !r.ok);
  console.log(`\n${failed.length === 0 ? '全部通过' : '有失败'}：${results.length - failed.length}/${results.length}`);
  if (failed.length) {
    console.log('失败项：' + failed.map((f) => f.name).join('; '));
    process.exitCode = 1;
  }
};

try {
  await main();
} catch (err) {
  console.error('验证异常：', err.message);
  process.exitCode = 1;
} finally {
  if (admin) await admin.end().catch(() => {});
}
