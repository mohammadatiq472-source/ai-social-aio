// 推荐群聊（群发现 / 入群审批）回归。
//
// 覆盖：
//   1. 私有群不出现在目录；群主设为公开后出现（字段/顺序游标契约）
//   2. open 模式：直接加入成功、加入后能读消息、重复加入 200 幂等、目录里 joined 变 true
//   3. approval 模式：申请 → 群主列表看到 → accept 成为成员；reject 之后仍可再申请
//   4. 非群主/非管理员：改公开设置 / 看申请列表 / 审批 全部 403
//   5. 已解散的群不出现在目录；无法对私有群申请入群（404）
//   6. 参数校验：join_mode 非法、群介绍 >120 字 → 400；未登录 → 401
//
// 用法：BASE=http://127.0.0.1:8787 node scripts/verify/verify-groups-discovery.mjs
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

const findGroup = (res, id) => (res.json?.groups || []).find((g) => Number(g.id) === id) || null;

const main = async () => {
  const owner = await signup('发现群主');
  const member = await signup('发现成员');
  const outsider = await signup('发现路人');
  const outsider2 = await signup('发现路人二');
  await befriend(owner, member);

  // ---------------------------------------------------------------- 1) 公开开关
  const titleA = `开群验证${rnd()}`;
  const gA = await api('/api/conversations', { method: 'POST', cookie: owner.cookie, body: { title: titleA, member_ids: [member.id] } });
  const gidA = Number(gA.json.conversation.id);
  const sendA = await api(`/api/conversations/${gidA}/messages`, {
    method: 'POST', cookie: owner.cookie,
    body: { body: '欢迎加入公开群', client_msg_id: rnd() },
  });
  check('群主在公开群里发了欢迎消息 → 200', sendA.status === 200, `status=${sendA.status}`);

  const beforePublic = await api(`/api/groups/discover?q=${encodeURIComponent(titleA)}`, { cookie: outsider.cookie });
  check('私有群不出现在发现目录', beforePublic.status === 200 && !findGroup(beforePublic, gidA),
    `status=${beforePublic.status} n=${(beforePublic.json?.groups || []).length}`);

  const patchA = await api(`/api/conversations/${gidA}/public`, {
    method: 'PATCH', cookie: owner.cookie,
    body: { discoverable: true, join_mode: 'open', description: '开放加入的验证群' },
  });
  check('群主设为公开（open）→ 200', patchA.status === 200 && patchA.json?.discoverable === true && patchA.json?.joinMode === 'open',
    `status=${patchA.status} mode=${patchA.json?.joinMode}`);

  const afterPublic = await api(`/api/groups/discover?q=${encodeURIComponent(titleA)}`, { cookie: outsider.cookie });
  const cardA = findGroup(afterPublic, gidA);
  check('公开后出现在发现目录', afterPublic.status === 200 && Boolean(cardA), `status=${afterPublic.status}`);
  check('目录字段完整（id/title/description/member_count/joined/join_mode/last_message_at）',
    Boolean(cardA) && cardA.title === titleA && cardA.description === '开放加入的验证群'
      && cardA.member_count === 2 && cardA.joined === false && cardA.join_mode === 'open'
      && Boolean(cardA.last_message_at),
    JSON.stringify(cardA || {}).slice(0, 180));
  // web/src/api.ts#discoverGroups 现在按 camelCase 取；后端同时给两套键，等前端统一后再删。
  check('目录同时给 camelCase 别名（memberCount/joinMode/lastMessageAt/hasMore/nextBeforeId）',
    Boolean(cardA) && cardA.memberCount === cardA.member_count && cardA.joinMode === cardA.join_mode
      && cardA.lastMessageAt === cardA.last_message_at
      && typeof afterPublic.json?.hasMore === 'boolean' && 'nextBeforeId' in afterPublic.json);
  const anon = await api(`/api/groups/discover?q=${encodeURIComponent(titleA)}`);
  check('未登录访问发现目录 → 401', anon.status === 401, `status=${anon.status}`);

  // ---------------------------------------------------------------- 2) open 直接加入
  const joinOpen = await api(`/api/conversations/${gidA}/join`, { method: 'POST', cookie: outsider.cookie, body: {} });
  check('open 模式直接加入 → 200 joined=true', joinOpen.status === 200 && joinOpen.json?.joined === true && joinOpen.json?.pending === false,
    `status=${joinOpen.status} joined=${joinOpen.json?.joined}`);
  const readAfterJoin = await api(`/api/conversations/${gidA}/messages?limit=10`, { cookie: outsider.cookie });
  check('加入后能读群消息（看到欢迎语）',
    readAfterJoin.status === 200 && (readAfterJoin.json?.messages || []).some((m) => m.body === '欢迎加入公开群'),
    `status=${readAfterJoin.status}`);
  const listAfterJoin = await api('/api/conversations', { cookie: outsider.cookie });
  check('加入后会话列表里能看到这个群',
    listAfterJoin.status === 200 && (listAfterJoin.json || []).some((c) => Number(c.id) === gidA),
    `status=${listAfterJoin.status}`);
  const joinAgain = await api(`/api/conversations/${gidA}/join`, { method: 'POST', cookie: outsider.cookie, body: {} });
  check('已是成员再调 join → 200 already_member 幂等',
    joinAgain.status === 200 && joinAgain.json?.already_member === true, `status=${joinAgain.status}`);
  const afterJoinCard = await api(`/api/groups/discover?q=${encodeURIComponent(titleA)}`, { cookie: outsider.cookie });
  check('目录里该群 joined=true', findGroup(afterJoinCard, gidA)?.joined === true);

  // ---------------------------------------------------------------- 3) approval 审批流
  const titleB = `审群验证${rnd()}`;
  const gB = await api('/api/conversations', { method: 'POST', cookie: owner.cookie, body: { title: titleB, member_ids: [member.id] } });
  const gidB = Number(gB.json.conversation.id);
  const patchB = await api(`/api/conversations/${gidB}/public`, {
    method: 'PATCH', cookie: owner.cookie,
    body: { discoverable: true, join_mode: 'approval', description: '需要审批的验证群' },
  });
  check('群主设为公开（approval）→ 200', patchB.status === 200 && patchB.json?.joinMode === 'approval',
    `status=${patchB.status}`);

  const req1 = await api(`/api/conversations/${gidB}/join`, { method: 'POST', cookie: outsider2.cookie, body: {} });
  check('approval 模式申请 → 200 pending=true 且未入群',
    req1.status === 200 && req1.json?.pending === true && req1.json?.joined === false,
    `status=${req1.status} pending=${req1.json?.pending}`);
  const req2 = await api(`/api/conversations/${gidB}/join`, { method: 'POST', cookie: outsider2.cookie, body: {} });
  check('重复申请 → 200 pending 幂等（duplicated）',
    req2.status === 200 && req2.json?.pending === true && req2.json?.duplicated === true,
    `status=${req2.status} dup=${req2.json?.duplicated}`);

  // 权限：普通成员 / 非成员都不能看申请、不能审批、不能改公开设置
  const memberList = await api(`/api/conversations/${gidB}/join-requests`, { cookie: member.cookie });
  check('普通成员看入群申请 → 403', memberList.status === 403, `status=${memberList.status}`);
  const outsiderList = await api(`/api/conversations/${gidB}/join-requests`, { cookie: outsider.cookie });
  check('非成员看入群申请 → 403', outsiderList.status === 403, `status=${outsiderList.status}`);
  const memberPatch = await api(`/api/conversations/${gidB}/public`, {
    method: 'PATCH', cookie: member.cookie, body: { discoverable: false, join_mode: 'open' },
  });
  check('普通成员改公开设置 → 403', memberPatch.status === 403, `status=${memberPatch.status}`);
  const memberDecide = await api(`/api/conversations/${gidB}/join-requests/${outsider2.id}`, {
    method: 'POST', cookie: member.cookie, body: { accept: true },
  });
  check('普通成员审批申请 → 403', memberDecide.status === 403, `status=${memberDecide.status}`);

  const ownerList = await api(`/api/conversations/${gidB}/join-requests`, { cookie: owner.cookie });
  const pendingEntry = (ownerList.json?.requests || []).find((r) => Number(r.principal_id) === outsider2.id);
  check('群主能在申请列表里看到申请人（含昵称/号码/时间/message）',
    ownerList.status === 200 && Boolean(pendingEntry)
      && pendingEntry.display_name === '发现路人二'
      && Number(pendingEntry.account_no) === Number(outsider2.accountNo)
      && typeof pendingEntry.message === 'string'
      && Boolean(pendingEntry.created_at),
    `status=${ownerList.status} n=${(ownerList.json?.requests || []).length}`);

  const accept = await api(`/api/conversations/${gidB}/join-requests/${outsider2.id}`, {
    method: 'POST', cookie: owner.cookie, body: { accept: true },
  });
  check('群主 accept → 200 status=accepted', accept.status === 200 && accept.json?.status === 'accepted',
    `status=${accept.status} s=${accept.json?.status}`);
  const listAfterAccept = await api('/api/conversations', { cookie: outsider2.cookie });
  check('被批准的人会话列表里出现该群',
    listAfterAccept.status === 200 && (listAfterAccept.json || []).some((c) => Number(c.id) === gidB),
    `status=${listAfterAccept.status}`);
  const listNoPending = await api(`/api/conversations/${gidB}/join-requests`, { cookie: owner.cookie });
  check('已审批的申请从 pending 列表消失',
    !(listNoPending.json?.requests || []).some((r) => Number(r.principal_id) === outsider2.id));
  const decideAgain = await api(`/api/conversations/${gidB}/join-requests/${outsider2.id}`, {
    method: 'POST', cookie: owner.cookie, body: { accept: true },
  });
  check('重复审批同一条 → 404（已不是 pending）', decideAgain.status === 404, `status=${decideAgain.status}`);

  // reject 之后仍可再申请
  const reqOutsider = await api(`/api/conversations/${gidB}/join`, { method: 'POST', cookie: outsider.cookie, body: {} });
  check('另一个用户申请 approval 群 → pending', reqOutsider.status === 200 && reqOutsider.json?.pending === true,
    `status=${reqOutsider.status}`);
  const reject = await api(`/api/conversations/${gidB}/join-requests/${outsider.id}`, {
    method: 'POST', cookie: owner.cookie, body: { accept: false },
  });
  check('群主 reject → 200 status=rejected', reject.status === 200 && reject.json?.status === 'rejected',
    `status=${reject.status} s=${reject.json?.status}`);
  const outsiderNotMember = await api('/api/conversations', { cookie: outsider.cookie });
  check('被拒后不是成员（会话列表里没有该群）',
    !(outsiderNotMember.json || []).some((c) => Number(c.id) === gidB));
  const reRequest = await api(`/api/conversations/${gidB}/join`, { method: 'POST', cookie: outsider.cookie, body: {} });
  check('被拒之后可以再次申请 → pending', reRequest.status === 200 && reRequest.json?.pending === true,
    `status=${reRequest.status}`);
  const acceptSecond = await api(`/api/conversations/${gidB}/join-requests/${outsider.id}`, {
    method: 'POST', cookie: owner.cookie, body: { accept: true },
  });
  check('二次申请可以正常 accept → accepted', acceptSecond.status === 200 && acceptSecond.json?.status === 'accepted',
    `status=${acceptSecond.status}`);
  const outsiderMessages = await api(`/api/conversations/${gidB}/messages?limit=1`, { cookie: outsider.cookie });
  check('二次审批通过后能读消息 → 200', outsiderMessages.status === 200, `status=${outsiderMessages.status}`);

  // ---------------------------------------------------------------- 4) 校验与边界
  const badMode = await api(`/api/conversations/${gidA}/public`, {
    method: 'PATCH', cookie: owner.cookie, body: { join_mode: 'bogus' },
  });
  check('join_mode 非 open/approval → 400', badMode.status === 400, `status=${badMode.status}`);
  const longDesc = await api(`/api/conversations/${gidA}/public`, {
    method: 'PATCH', cookie: owner.cookie, body: { description: '长'.repeat(121) },
  });
  check('群介绍 121 字 → 400', longDesc.status === 400, `status=${longDesc.status}`);
  const tooMany = await api(`/api/groups/discover?limit=9999`, { cookie: outsider.cookie });
  check('limit 超上限被夹到 20（返回 200）', tooMany.status === 200 && (tooMany.json?.groups || []).length <= 20,
    `status=${tooMany.status} n=${(tooMany.json?.groups || []).length}`);

  // 私有群不能被申请入群（不泄露存在性）
  const titleD = `私群验证${rnd()}`;
  const gD = await api('/api/conversations', { method: 'POST', cookie: owner.cookie, body: { title: titleD, member_ids: [member.id] } });
  const gidD = Number(gD.json.conversation.id);
  const joinPrivate = await api(`/api/conversations/${gidD}/join`, { method: 'POST', cookie: outsider2.cookie, body: {} });
  check('对未公开推荐的群申请入群 → 404', joinPrivate.status === 404, `status=${joinPrivate.status}`);

  // ---------------------------------------------------------------- 5) 解散后从目录消失
  const titleC = `散群验证${rnd()}`;
  const gC = await api('/api/conversations', { method: 'POST', cookie: owner.cookie, body: { title: titleC, member_ids: [member.id] } });
  const gidC = Number(gC.json.conversation.id);
  await api(`/api/conversations/${gidC}/public`, {
    method: 'PATCH', cookie: owner.cookie, body: { discoverable: true, join_mode: 'open', description: '马上解散' },
  });
  const beforeDissolve = await api(`/api/groups/discover?q=${encodeURIComponent(titleC)}`, { cookie: outsider2.cookie });
  check('解散前在目录里（对照组）', Boolean(findGroup(beforeDissolve, gidC)));
  const dissolve = await api(`/api/conversations/${gidC}`, { method: 'DELETE', cookie: owner.cookie });
  check('群主解散群 → 200', dissolve.status === 200 && dissolve.json?.dissolved === true, `status=${dissolve.status}`);
  const afterDissolve = await api(`/api/groups/discover?q=${encodeURIComponent(titleC)}`, { cookie: outsider2.cookie });
  check('已解散的群不出现在发现目录', afterDissolve.status === 200 && !findGroup(afterDissolve, gidC),
    `status=${afterDissolve.status}`);

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
