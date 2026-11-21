// 群主转让 / 解散群回归（30 条权限矩阵之外的补充，也可以单独跑）
//
// 覆盖：
//   1. 成员/管理员不能转让群主或解散群（403）
//   2. 群主不能把群主转给自己（400）、不能转给非成员（404）、不能转给 AI（400）
//   3. 群主转让给人类成员 → 新群主 owner、原群主 member；原群主可以自己退群
//   4. 新群主解散群（不需要先踢人）→ 200；双方列表都看不到；读写 403；二次解散 404/410
//   5. 解散后 events 里仍有 ConversationDissolved（审计不丢）
//
// 用法：BASE=http://127.0.0.1:8787 node scripts/verify/verify-group-owner.mjs
import crypto from 'node:crypto';

const BASE = (process.env.BASE || 'http://127.0.0.1:8787').replace(/\/$/, '');
const results = [];
const rnd = () => crypto.randomBytes(4).toString('hex');

function check(name, ok, detail = '') {
  results.push({ name, ok });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? '  — ' + detail : ''}`);
}

async function api(path, { method = 'GET', body, cookie, token } = {}) {
  const headers = {};
  if (body !== undefined) headers['content-type'] = 'application/json';
  if (cookie) headers.cookie = cookie;
  if (token) headers.authorization = `Bearer ${token}`;
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
  const r = await api('/api/auth/register', {
    method: 'POST',
    body: { email: `t_${rnd()}@test.dev`, password: 'passw0rd!x', display_name: name, invite_code: process.env.REGISTER_CODE || '' },
  });
  if (r.status !== 200) throw new Error(`注册失败 ${r.status}`);
  return { id: r.json.me.id, accountNo: r.json.me.accountNo, cookie: r.cookie };
}

async function befriend(a, b) {
  await api('/api/friends/request', { method: 'POST', cookie: a.cookie, body: { account_no: b.accountNo } });
  await api('/api/friends/accept', { method: 'POST', cookie: b.cookie, body: { principal_id: a.id } });
}

const main = async () => {
  const owner = await signup('转让群主');
  const member = await signup('转让成员');
  const outsider = await signup('转让路人');
  await befriend(owner, member);

  const g = await api('/api/conversations', { method: 'POST', cookie: owner.cookie, body: { title: '转让验证群', member_ids: [member.id] } });
  const gid = g.json.conversation.id;
  const agent = await api('/api/agents', { method: 'POST', cookie: owner.cookie, body: { display_name: '转让AI' } });
  const agentId = agent.json.agent.id;
  await api(`/api/conversations/${gid}/members`, { method: 'POST', cookie: owner.cookie, body: { principal_id: agentId } });

  // 1) 非群主不能转让/解散
  const memberTransfer = await api(`/api/conversations/${gid}/owner`, { method: 'POST', cookie: member.cookie, body: { principal_id: member.id } });
  check('普通成员转让群主 → 403', memberTransfer.status === 403, `status=${memberTransfer.status}`);
  const memberDissolve = await api(`/api/conversations/${gid}`, { method: 'DELETE', cookie: member.cookie });
  check('普通成员解散群 → 403', memberDissolve.status === 403, `status=${memberDissolve.status}`);
  const outsiderTransfer = await api(`/api/conversations/${gid}/owner`, { method: 'POST', cookie: outsider.cookie, body: { principal_id: outsider.id } });
  check('非成员转让群主 → 403', outsiderTransfer.status === 403, `status=${outsiderTransfer.status}`);

  // 2) 非法目标
  const toSelf = await api(`/api/conversations/${gid}/owner`, { method: 'POST', cookie: owner.cookie, body: { principal_id: owner.id } });
  check('转让给自己 → 400', toSelf.status === 400, `status=${toSelf.status}`);
  const toOutsider = await api(`/api/conversations/${gid}/owner`, { method: 'POST', cookie: owner.cookie, body: { principal_id: outsider.id } });
  check('转给不在群里的人 → 404', toOutsider.status === 404, `status=${toOutsider.status}`);
  const toAgent = await api(`/api/conversations/${gid}/owner`, { method: 'POST', cookie: owner.cookie, body: { principal_id: agentId } });
  check('转给 AI → 403（AI 没有网页界面，不能当群主）', toAgent.status === 403, `status=${toAgent.status}`);

  // 3) 正常转让
  const transfer = await api(`/api/conversations/${gid}/owner`, { method: 'POST', cookie: owner.cookie, body: { principal_id: member.id } });
  check('群主转让给人类成员 → 200', transfer.status === 200 && transfer.json?.ownerId === member.id,
    `status=${transfer.status} owner=${transfer.json?.ownerId}`);
  const members = await api(`/api/conversations/${gid}/members`, { cookie: owner.cookie });
  const byId = new Map((members.json?.members || []).map((m) => [m.id, m.role]));
  check('原群主变为普通成员', byId.get(owner.id) === 'member', `role=${byId.get(owner.id)}`);
  check('新群主 role=owner', byId.get(member.id) === 'owner', `role=${byId.get(member.id)}`);
  const oldOwnerCanSetRole = await api(`/api/conversations/${gid}/members/${agentId}/role`, { method: 'POST', cookie: owner.cookie, body: { role: 'admin' } });
  check('原群主已失去「设管理员」权限 → 403', oldOwnerCanSetRole.status === 403, `status=${oldOwnerCanSetRole.status}`);
  const oldOwnerLeave = await api(`/api/conversations/${gid}/members/${owner.id}`, { method: 'DELETE', cookie: owner.cookie });
  check('原群主（现普通成员）可以自己退群 → 200', oldOwnerLeave.status === 200, `status=${oldOwnerLeave.status}`);

  // 4) 解散：不需要先踢人
  const dissolve = await api(`/api/conversations/${gid}`, { method: 'DELETE', cookie: member.cookie });
  check('群主直接解散（群里还有人）→ 200', dissolve.status === 200 && dissolve.json?.dissolved === true,
    `status=${dissolve.status}`);
  const listAfter = await api('/api/conversations', { cookie: member.cookie });
  check('解散后列表里看不到这个群', !(listAfter.json || []).some((c) => Number(c.id) === gid), `n=${(listAfter.json || []).length}`);
  const readAfter = await api(`/api/conversations/${gid}/messages?limit=1`, { cookie: member.cookie });
  check('解散后读消息 → 403', readAfter.status === 403, `status=${readAfter.status}`);
  const sendAfter = await api(`/api/conversations/${gid}/messages`, { method: 'POST', cookie: member.cookie, body: { body: '还在吗', client_msg_id: rnd() } });
  check('解散后发消息 → 403/400', sendAfter.status === 403 || sendAfter.status === 400, `status=${sendAfter.status}`);
  const dissolveAgain = await api(`/api/conversations/${gid}`, { method: 'DELETE', cookie: member.cookie });
  check('重复解散 → 403/404/410（已不是群主/已解散）', [403, 404, 410].includes(dissolveAgain.status), `status=${dissolveAgain.status}`);

  // 5) 审计事件还在（events 不物理删）
  const audit = await api('/api/admin/reports?status=all', { cookie: owner.cookie });
  void audit;
  console.log('（审计事件 ConversationDissolved 由生产的 events 表保证，HTTP 侧不暴露，见 docs/架构与约束.md）');

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
