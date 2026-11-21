// 站务解封回归：审核页「已封禁」列表 + 解封入口（《架构与约束》§5 的已知债：以前只能改库解封）。
//
// 覆盖的契约：
//   1. 非站务：GET /api/admin/suspended → 403；POST /api/admin/unsuspend/:id → 403
//   2. 封禁 → 目标登出后重新登录 403 `suspended`（和 verify-moderation 的封禁口径一致）
//   3. 站务列表：只列「suspended_until > now()」的人，字段带 principal_id / display_name /
//      account_no / suspended_until / 最近一次封禁事件时间，按解封时间升序
//   4. 解封：suspended_until 清空（目标重新登录 200）、列表消失、返回的 event_id 非空
//   5. UserUnsuspended 已落：不读 events 表，用「event_id 非空 + 列表消失 + 登录恢复」闭环断言
//   6. 重复解封 → 404；目标本来没被封 → 404；principal_id 非法 → 400
//
// 前置：需要一个 is_admin 账号（只在本地 5434 库手工设一次，别动生产）：
//   UPDATE principals SET is_admin = true WHERE display_name = '解封站务'
// 用法：
//   BASE=http://127.0.0.1:8787 ADMIN_EMAIL=… ADMIN_PASSWORD=… node scripts/verify/verify-admin-unsuspend.mjs
// 缺 ADMIN_EMAIL / ADMIN_PASSWORD 时打印 SKIP 并退出 0：这是「明确跳过」，不是通过。
// 测试账号「解封站务/解封目标/解封举报人」由 cleanup-test.mjs 清理机制处理（随时可删）。
import crypto from 'node:crypto';

const BASE = (process.env.BASE || 'http://127.0.0.1:8787').replace(/\/$/, '');
const ADMIN_EMAIL = process.env.ADMIN_EMAIL || '';
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || '';
const results = [];
const rnd = () => crypto.randomBytes(4).toString('hex');

function check(name, ok, detail = '') {
  results.push({ name, ok });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? '  — ' + detail : ''}`);
}

async function api(path, { method = 'GET', body, cookie } = {}) {
  const headers = {};
  if (body !== undefined) headers['content-type'] = 'application/json';
  if (cookie) headers.cookie = cookie;
  const res = await fetch(`${BASE}${path}`, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
  const text = await res.text();
  let json = null;
  try {
    json = text ? JSON.parse(text) : null;
  } catch {
    /* 非 JSON */
  }
  const setCookie = res.headers.getSetCookie?.() || [];
  const sid = setCookie.map((c) => String(c).split(';')[0]).find((c) => c.startsWith('sid='));
  return { status: res.status, json, text, cookie: sid || cookie };
}

async function signup(name) {
  const email = `t_${rnd()}@test.dev`;
  const password = 'passw0rd!x';
  const r = await api('/api/auth/register', {
    method: 'POST',
    body: { email, password, display_name: name, invite_code: process.env.REGISTER_CODE || '' },
  });
  if (r.status !== 200) throw new Error(`注册失败 ${r.status} ${JSON.stringify(r.json)}`);
  return { id: r.json.me.id, accountNo: r.json.me.accountNo, cookie: r.cookie, email, password };
}

async function login(email, password) {
  return api('/api/auth/login', { method: 'POST', body: { email, password } });
}

async function befriend(a, b) {
  await api('/api/friends/request', { method: 'POST', cookie: a.cookie, body: { account_no: b.accountNo } });
  await api('/api/friends/accept', { method: 'POST', cookie: b.cookie, body: { principal_id: a.id } });
}

async function send(user, conv, body) {
  const r = await api(`/api/conversations/${conv}/messages`, {
    method: 'POST',
    cookie: user.cookie,
    body: { body, client_msg_id: crypto.randomUUID() },
  });
  if (r.status !== 200) throw new Error(`发消息失败 ${r.status} ${JSON.stringify(r.json)}`);
  return r.json;
}

const main = async () => {
  if (!ADMIN_EMAIL || !ADMIN_PASSWORD) {
    console.log('SKIP  缺少 ADMIN_EMAIL / ADMIN_PASSWORD：站务解封回归没有执行（不是通过）');
    console.log("      设置方法：psql -h 127.0.0.1 -p 5434 -U postgres -d aio -c \"UPDATE principals SET is_admin=true WHERE display_name='解封站务'\"");
    return;
  }

  const adminLogin = await login(ADMIN_EMAIL, ADMIN_PASSWORD);
  if (adminLogin.status !== 200) throw new Error(`站务登录失败 ${adminLogin.status} ${JSON.stringify(adminLogin.json)}`);
  const admin = { id: adminLogin.json.me.id, cookie: adminLogin.cookie };
  check('站务账号登录（isAdmin 生效）', adminLogin.json.me.isAdmin === true, `isAdmin=${adminLogin.json.me.isAdmin}`);

  // ---------------------------------------------------------------- 准备：一条可封禁的消息 + 一条举报
  const victim = await signup('解封目标');
  const reporter = await signup('解封举报人');
  await befriend(reporter, victim);
  const g = await api('/api/conversations', {
    method: 'POST', cookie: victim.cookie,
    body: { title: '解封验证群', member_ids: [reporter.id] },
  });
  if (g.status !== 200) throw new Error(`建群失败 ${g.status} ${JSON.stringify(g.json)}`);
  const gid = g.json.conversation.id;

  const msg = await send(victim, gid, `会被封禁再解封的消息 unban-${rnd()}`);
  const rep = await api('/api/reports', {
    method: 'POST', cookie: reporter.cookie,
    body: { target_type: 'message', target_id: msg.seq, conversation_id: gid, reason: '解封回归：测试封禁' },
  });
  check('准备：举报成功（200）', rep.status === 200, `status=${rep.status}`);

  const openList = await api('/api/admin/reports?status=open', { cookie: admin.cookie });
  const item = (openList.json?.reports || []).find((r) => r.targetId === msg.seq && r.conversationId === gid);
  check('准备：站务待处理列表能定位到这条举报', Boolean(item), JSON.stringify(item || {}).slice(0, 160));
  if (!item) throw new Error('找不到刚提交的举报，无法继续');

  const suspend = await api(`/api/admin/reports/${item.id}/handle`, {
    method: 'POST', cookie: admin.cookie, body: { action: 'suspend_user', note: '解封回归：先封 7 天' },
  });
  check('封禁 → 200 resolved', suspend.status === 200 && suspend.json?.status === 'resolved', `status=${suspend.status}`);

  const blockedLogin = await login(victim.email, victim.password);
  check('封禁后目标登录 → 403 suspended', blockedLogin.status === 403 && blockedLogin.json?.error === 'suspended',
    `status=${blockedLogin.status} error=${blockedLogin.json?.error}`);

  // ---------------------------------------------------------------- 1) 非站务
  const noAdminList = await api('/api/admin/suspended', { cookie: reporter.cookie });
  check('非站务看封禁列表 → 403', noAdminList.status === 403, `status=${noAdminList.status}`);
  const noAdminUnban = await api(`/api/admin/unsuspend/${victim.id}`, {
    method: 'POST', cookie: reporter.cookie, body: {},
  });
  check('非站务解封 → 403', noAdminUnban.status === 403, `status=${noAdminUnban.status}`);

  // ---------------------------------------------------------------- 2) 站务封禁列表
  const list = await api('/api/admin/suspended', { cookie: admin.cookie });
  const users = list.json?.users || [];
  const row = users.find((u) => u.principalId === victim.id);
  check('站务看封禁列表 → 200 且包含目标', list.status === 200 && Boolean(row), `status=${list.status} n=${users.length}`);
  check(
    '列表字段齐全（昵称/号码/解封时间/最近封禁时间）',
    Boolean(row)
      && row.displayName === '解封目标'
      && typeof row.accountNo === 'number'
      && new Date(row.suspendedUntil).getTime() > Date.now()
      && Boolean(row.lastSuspendedAt),
    JSON.stringify(row || {}).slice(0, 200),
  );
  const ascending = users.every((u, i) => i === 0
    || new Date(users[i - 1].suspendedUntil).getTime() <= new Date(u.suspendedUntil).getTime());
  check('列表按解封时间升序', ascending, `n=${users.length}`);

  // ---------------------------------------------------------------- 3) 参数与状态校验
  const badId = await api('/api/admin/unsuspend/0', { method: 'POST', cookie: admin.cookie, body: {} });
  check('principal_id=0 → 400 invalid_schema', badId.status === 400 && badId.json?.error === 'invalid_schema',
    `status=${badId.status} error=${badId.json?.error}`);
  const ghost = await api('/api/admin/unsuspend/9223372036854775', { method: 'POST', cookie: admin.cookie, body: {} });
  check('不存在的账号 → 404', ghost.status === 404 && ghost.json?.error === 'not_found', `status=${ghost.status}`);
  const notSuspended = await api(`/api/admin/unsuspend/${reporter.id}`, {
    method: 'POST', cookie: admin.cookie, body: {},
  });
  check('目标本来没被封 → 404（不是幂等 200）', notSuspended.status === 404 && notSuspended.json?.error === 'not_found',
    `status=${notSuspended.status}`);

  // ---------------------------------------------------------------- 4) 解封
  const unban = await api(`/api/admin/unsuspend/${victim.id}`, {
    method: 'POST', cookie: admin.cookie, body: { note: '解封回归：误封，恢复' },
  });
  check('解封 → 200 且带事件 id', unban.status === 200 && unban.json?.accepted === true && Number(unban.json?.event_id) > 0,
    `status=${unban.status} event_id=${unban.json?.event_id}`);
  const relogin = await login(victim.email, victim.password);
  check('解封后目标登录 → 200', relogin.status === 200, `status=${relogin.status}`);
  const listAfter = await api('/api/admin/suspended', { cookie: admin.cookie });
  const stillListed = (listAfter.json?.users || []).some((u) => u.principalId === victim.id);
  check('解封后目标从封禁列表消失', listAfter.status === 200 && !stillListed, `n=${(listAfter.json?.users || []).length}`);

  // UserUnsuspended 落库证据（不直接读 events 表）：写入事件返回的 id + 「列表消失 + 登录恢复」的行为闭环
  check('UserUnsuspended 已落（event_id 非空 + 列表消失 + 登录恢复）',
    Number(unban.json?.event_id) > 0 && !stillListed && relogin.status === 200,
    `event_id=${unban.json?.event_id} listed=${stillListed} login=${relogin.status}`);

  const again = await api(`/api/admin/unsuspend/${victim.id}`, { method: 'POST', cookie: admin.cookie, body: {} });
  check('重复解封 → 404', again.status === 404 && again.json?.error === 'not_found', `status=${again.status}`);

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
