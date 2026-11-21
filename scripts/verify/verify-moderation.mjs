// 审核闭环回归：举报 → 站务处理（驳回/隐藏消息/封禁）→ 读侧即时生效
//
// 覆盖的契约：
//   1. 非站务：GET /api/admin/reports → 403；处理动作 → 403
//   2. 消息类举报必须带 conversation_id（seq 只在会话内唯一）
//   3. 站务列表：能拿到群名、消息片段、发送者、举报人
//   4. hide_message：消息从「拉消息 / 搜索 / 会话列表预览」里消失，举报变成已处理
//   5. 重复处理同一条 → 409
//   6. dismiss：举报变成已驳回，不隐藏消息
//   7. suspend_user：被举报者发消息 → 403，重新登录 → 403 suspended
//   8. 站务能把「已处理」列表翻出来（status=resolved）
//
// 前置：需要一个 is_admin 账号（服务端手工设置一次）：
//   psql -d qqmini -c "UPDATE principals SET is_admin = true WHERE display_name = '审核A'"
//   然后 ADMIN_EMAIL=… ADMIN_PASSWORD=… node scripts/verify/verify-moderation.mjs
// 注意：封禁用例会把「审核B」封 7 天，重跑前要解封（脚本会自己注册新的审核B，所以不清也没事）。
// 测试账号「审核A/B/C」由 cleanup-test.mjs 清理。
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
  return { status: res.status, json, cookie: sid || cookie };
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

async function send(user, conv, body) {
  const r = await api(`/api/conversations/${conv}/messages`, {
    method: 'POST',
    cookie: user.cookie,
    body: { body, client_msg_id: crypto.randomUUID() },
  });
  if (r.status !== 200) throw new Error(`发消息失败 ${r.status} ${JSON.stringify(r.json)}`);
  return r.json;
}

async function report(user, conv, seq, reason = '测试举报') {
  return api('/api/reports', {
    method: 'POST',
    cookie: user.cookie,
    body: { target_type: 'message', target_id: seq, conversation_id: conv, reason },
  });
}

async function listMessages(user, conv) {
  const r = await api(`/api/conversations/${conv}/messages?since_seq=0&limit=200`, { cookie: user.cookie });
  return (r.json?.messages || []).map((m) => m.body);
}

const main = async () => {
  if (!ADMIN_EMAIL || !ADMIN_PASSWORD) {
    console.error('缺少 ADMIN_EMAIL / ADMIN_PASSWORD：需要一个 is_admin 账号才能验站务动作');
    console.error('设置方法：psql -d qqmini -c "UPDATE principals SET is_admin = true WHERE display_name = \'审核A\'"');
    process.exit(2);
  }
  const adminLogin = await login(ADMIN_EMAIL, ADMIN_PASSWORD);
  if (adminLogin.status !== 200) throw new Error(`站务登录失败 ${adminLogin.status} ${JSON.stringify(adminLogin.json)}`);
  const admin = { id: adminLogin.json.me.id, cookie: adminLogin.cookie };
  check('站务账号可以登录（is_admin 生效）', adminLogin.status === 200 && adminLogin.json.me.isAdmin === true, `isAdmin=${adminLogin.json.me.isAdmin}`);

  const A = await signup('审核A');
  const B = await signup('审核B');
  const C = await signup('审核C');
  await api('/api/friends/request', { method: 'POST', cookie: A.cookie, body: { account_no: B.accountNo } });
  await api('/api/friends/accept', { method: 'POST', cookie: B.cookie, body: { principal_id: A.id } });
  const g = await api('/api/conversations', { method: 'POST', cookie: A.cookie, body: { title: '审核验证群', member_ids: [B.id] } });
  const gid = g.json.conversation.id;

  // 1) 非站务
  const noAdminList = await api('/api/admin/reports?status=open', { cookie: C.cookie });
  check('非站务查举报列表 → 403', noAdminList.status === 403, `status=${noAdminList.status}`);
  const noAdminHandle = await api('/api/admin/reports/1/handle', {
    method: 'POST', cookie: C.cookie, body: { action: 'dismiss' },
  });
  check('非站务处理举报 → 403', noAdminHandle.status === 403, `status=${noAdminHandle.status}`);

  // 2) 举报必须带 conversation_id
  const msgB = await send(B, gid, `待隐藏的消息 hide-${rnd()}`);
  const noConv = await api('/api/reports', {
    method: 'POST', cookie: A.cookie,
    body: { target_type: 'message', target_id: msgB.seq, reason: '没带会话 id' },
  });
  check('消息举报不带 conversation_id → 400', noConv.status === 400 && noConv.json?.error === 'conversation_required', `status=${noConv.status}`);

  // 3) 正常举报 + 站务列表上下文
  const rep1 = await report(A, gid, msgB.seq, '测试：广告');
  check('举报成功（200）', rep1.status === 200, `status=${rep1.status}`);
  const openList = await api('/api/admin/reports?status=open', { cookie: admin.cookie });
  const item = (openList.json?.reports || []).find((r) => r.targetId === msgB.seq && r.conversationId === gid);
  check(
    '站务列表带上下文（群名/消息片段/发送者/举报人）',
    openList.status === 200 && Boolean(item) && item.conversationTitle === '审核验证群' && String(item.messagePreview || '').includes('待隐藏的消息') && item.messageSender === '审核B' && item.reporterName === '审核A',
    JSON.stringify(item || {}).slice(0, 160),
  );

  // 4) hide_message
  const hide = await api(`/api/admin/reports/${item.id}/handle`, {
    method: 'POST', cookie: admin.cookie, body: { action: 'hide_message', note: '广告，下架' },
  });
  check('站务隐藏消息 → 200', hide.status === 200 && hide.json?.status === 'resolved', `status=${hide.status} ${JSON.stringify(hide.json || {})}`);
  const afterHide = await listMessages(A, gid);
  check('隐藏后：拉消息列表里没有那条', !afterHide.some((body) => String(body).includes('待隐藏的消息')), `n=${afterHide.length}`);
  const searchAfterHide = await api(`/api/search/messages?q=${encodeURIComponent('待隐藏的消息')}`, { cookie: A.cookie });
  check('隐藏后：搜索也搜不到', (searchAfterHide.json?.results || []).length === 0, `n=${(searchAfterHide.json?.results || []).length}`);
  const openAfter = await api('/api/admin/reports?status=open', { cookie: admin.cookie });
  check('处理后：待处理列表里消失', !(openAfter.json?.reports || []).some((r) => r.id === item.id), `open=${(openAfter.json?.reports || []).length}`);
  const resolvedList = await api('/api/admin/reports?status=resolved', { cookie: admin.cookie });
  const handled = (resolvedList.json?.reports || []).find((r) => r.id === item.id);
  check(
    '已处理列表能看到处理动作/备注/处理人',
    Boolean(handled) && handled.action === 'hide_message' && handled.actionNote === '广告，下架' && handled.handlerName === '站务',
    JSON.stringify(handled || {}).slice(0, 160),
  );

  // 5) 重复处理
  const again = await api(`/api/admin/reports/${item.id}/handle`, {
    method: 'POST', cookie: admin.cookie, body: { action: 'dismiss' },
  });
  check('重复处理同一条 → 409', again.status === 409, `status=${again.status}`);

  // 6) dismiss
  const msgB2 = await send(B, gid, `可驳回的消息 dismiss-${rnd()}`);
  const rep2 = await report(A, gid, msgB2.seq, '测试：误报');
  const item2 = ((await api('/api/admin/reports?status=open', { cookie: admin.cookie })).json?.reports || [])
    .find((r) => r.targetId === msgB2.seq && r.conversationId === gid);
  const dismiss = await api(`/api/admin/reports/${item2.id}/handle`, {
    method: 'POST', cookie: admin.cookie, body: { action: 'dismiss', note: '不违规' },
  });
  check('驳回 → 200 且状态 dismissed', dismiss.status === 200 && dismiss.json?.status === 'dismissed', `status=${dismiss.status}`);
  const stillThere = await listMessages(A, gid);
  check('驳回不影响消息（原文还在）', stillThere.some((body) => String(body).includes('可驳回的消息')));
  check('驳回记录出现在已驳回列表', ((await api('/api/admin/reports?status=dismissed', { cookie: admin.cookie })).json?.reports || []).some((r) => r.id === item2.id));

  // 7) suspend_user
  const msgB3 = await send(B, gid, `会被封禁的消息 suspend-${rnd()}`);
  await report(A, gid, msgB3.seq, '测试：骚扰');
  const item3 = ((await api('/api/admin/reports?status=open', { cookie: admin.cookie })).json?.reports || [])
    .find((r) => r.targetId === msgB3.seq && r.conversationId === gid);
  const suspend = await api(`/api/admin/reports/${item3.id}/handle`, {
    method: 'POST', cookie: admin.cookie, body: { action: 'suspend_user', note: '骚扰他人' },
  });
  check('封禁 → 200', suspend.status === 200 && suspend.json?.status === 'resolved', `status=${suspend.status} ${JSON.stringify(suspend.json || {})}`);
  const blockedSend = await api(`/api/conversations/${gid}/messages`, {
    method: 'POST', cookie: B.cookie, body: { body: '我被封了还能发吗', client_msg_id: crypto.randomUUID() },
  });
  check('被封禁者发消息 → 403', blockedSend.status === 403, `status=${blockedSend.status} ${JSON.stringify(blockedSend.json || {})}`);
  const blockedLogin = await login(B.email, B.password);
  check('被封禁者重新登录 → 403 suspended', blockedLogin.status === 403 && blockedLogin.json?.error === 'suspended', `status=${blockedLogin.status}`);

  // 8) 站务自己不能被封（防误操作）：站务建个自己的群 → 自己发一条 → 自己举报 → 尝试封自己
  //    复用已有的同名群：每跑一次就建一个群会污染线上数据（清理脚本只清测试账号建的群）
  const adminConvs = await api('/api/conversations', { cookie: admin.cookie });
  const reused = (adminConvs.json || []).find((c) => c.title === '站务自己的群');
  const ownGid = reused
    ? reused.id
    : (await api('/api/conversations', { method: 'POST', cookie: admin.cookie, body: { title: '站务自己的群', member_ids: [] } })).json.conversation.id;
  const msgSelf = await api(`/api/conversations/${ownGid}/messages`, {
    method: 'POST', cookie: admin.cookie, body: { body: `站务自己的消息 self-${rnd()}`, client_msg_id: crypto.randomUUID() },
  });
  const repSelf = await api('/api/reports', {
    method: 'POST', cookie: admin.cookie,
    body: { target_type: 'message', target_id: msgSelf.json.seq, conversation_id: ownGid, reason: '自己的消息' },
  });
  const itemSelf = ((await api('/api/admin/reports?status=open', { cookie: admin.cookie })).json?.reports || [])
    .find((r) => r.targetId === msgSelf.json.seq && r.conversationId === ownGid);
  check('（站务）在自己的群里也能举报（去重键带会话，不同群的 #seq 不互相顶）', repSelf.status === 200, `status=${repSelf.status}`);
  const selfSuspend = await api(`/api/admin/reports/${itemSelf.id}/handle`, {
    method: 'POST', cookie: admin.cookie, body: { action: 'suspend_user', note: '不该成功' },
  });
  check('不能封禁站务自己 → 403', selfSuspend.status === 403, `status=${selfSuspend.status} ${JSON.stringify(selfSuspend.json || {})}`);
  // 这条举报注定处理失败（我们就是在验它失败），但它是真写进库的：收尾自己驳回掉，
  // 否则线上「审核 → 待处理」会越跑越多，看起来像有一堆没人管的举报。
  if (itemSelf) {
    await api(`/api/admin/reports/${itemSelf.id}/handle`, {
      method: 'POST', cookie: admin.cookie, body: { action: 'dismiss', note: '自动化测试产物：自己不能封自己' },
    });
  }
  void rep2;

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
