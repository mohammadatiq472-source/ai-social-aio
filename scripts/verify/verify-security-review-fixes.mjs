// 新增模块安全评审（2026-11-15）修复回归：M1 / M2 / M3 / M4 / M5 / L6 / L8 / L9。
//
// 为什么这么写：
//   - M1 有两条断言不碰服务端：直接 import submit.mjs 的 hitRateHour，用可注入的 nowMs
//     断言「61 秒仍拦、3601 秒放行」——真等一小时没法放进回归。
//   - M2 的「被封禁」必须真写库：站务封禁只有 举报 → suspend_user 一条路，且要 is_admin。
//     脚本用 DATABASE_URL 直接 UPDATE principals.suspended_until（只改测试账号，收尾会解封），
//     不碰 events（C3 只追加，测试也不该伪造事件）。
//   - M3 三条路径各一条：人类 REST、MCP send_message（预检先失败）、MCP dm（只走 submit）。
//     第三条才是「下沉进 submit」的关键证据——dm 以前完全绕过了预检。
//   - L9 要真跑审批：封禁期间申请人还能被批进群 = M2 的同根问题。
//
// 用法（另起端口，别打扰 8787）：
//   BASE=http://127.0.0.1:8788 DATABASE_URL=postgres://postgres@127.0.0.1:5434/aio \
//     node scripts/verify/verify-security-review-fixes.mjs
// 缺 DATABASE_URL 时默认本地 5434/aio（与 scripts/verify/verify-capacity.mjs 一致）。
// 测试账号（安全评审H/S/X/Y/R + 安全AI-*）可随时删：cleanup-test.mjs 的清理口径按名字前缀。
import crypto from 'node:crypto';
import pg from 'pg';

const BASE = (process.env.BASE || 'http://127.0.0.1:8787').replace(/\/$/, '');
const DB_URL = process.env.ADMIN_DATABASE_URL || process.env.DATABASE_URL || 'postgres://postgres@127.0.0.1:5434/aio';
// submit.mjs → db.mjs 在模块加载时读 DATABASE_URL 建池；没给会得到空连接串（池是懒连接，但别留坑）
process.env.DATABASE_URL = process.env.DATABASE_URL || DB_URL;
process.env.WRITER_DATABASE_URL = process.env.WRITER_DATABASE_URL || DB_URL;
const { hitRateHour } = await import('../../src/core/submit.mjs');
const { isBlockedEndpointHost } = await import('../../src/push.mjs');

const results = [];
const skips = [];
const rnd = () => crypto.randomBytes(4).toString('hex');

function check(name, ok, detail = '') {
  results.push({ name, ok });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? '  — ' + detail : ''}`);
}

function skip(name, why) {
  skips.push({ name, why });
  console.log(`SKIP  ${name}${why ? '  — ' + why : ''}`);
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
    /* 非 JSON（401/204 之类） */
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
  if (r.status !== 200) throw new Error(`注册失败 ${r.status} ${JSON.stringify(r.json)}`);
  return { id: r.json.me.id, accountNo: r.json.me.accountNo, cookie: r.cookie };
}

async function createAgent(ownerCookie, name) {
  const r = await api('/api/agents', { method: 'POST', cookie: ownerCookie, body: { display_name: name } });
  if (r.status !== 200 || !r.json?.token) throw new Error(`建 AI 失败 ${r.status} ${JSON.stringify(r.json)}`);
  return { id: r.json.agent.id, token: r.json.token };
}

async function mcp(token, name, args, id = 1) {
  const r = await api('/mcp', {
    method: 'POST',
    token,
    body: { jsonrpc: '2.0', id, method: 'tools/call', params: { name, arguments: args } },
  });
  const text = r.json?.result?.content?.[0]?.text;
  let parsed = null;
  try {
    parsed = text ? JSON.parse(text) : null;
  } catch {
    parsed = { raw: text };
  }
  return { status: r.status, isError: r.json?.result?.isError === true, json: parsed, rpcError: r.json?.error ?? null };
}

const main = async () => {
  const db = new pg.Client({ connectionString: DB_URL });
  await db.connect();
  // 收尾必须解封：脚本每跑一次留一批永久封禁的测试账号，下一轮就会互相干扰
  const toUnsuspend = new Set();
  const suspend = async (principalId) => {
    toUnsuspend.add(principalId);
    await db.query("UPDATE principals SET suspended_until = now() + interval '2 hours' WHERE id = $1", [principalId]);
  };
  const unsuspend = async (principalId) => {
    toUnsuspend.delete(principalId);
    await db.query('UPDATE principals SET suspended_until = NULL WHERE id = $1', [principalId]);
  };

  try {
    // ======================================================== 0) M1 小时窗（纯函数，不碰服务端）
    {
      const key = `verify-hour:${process.pid}:${rnd()}`;
      const t0 = 1_700_000_000_000;
      let allowed = 0;
      for (let i = 0; i < 10; i += 1) if (hitRateHour(key, 10, t0 + i * 1000)) allowed += 1;
      const eleventh = hitRateHour(key, 10, t0 + 20_000);
      const at61s = hitRateHour(key, 10, t0 + 61_000);
      const at3601s = hitRateHour(key, 10, t0 + 3_601_000);
      check('M1 hitRateHour：10 次放行、第 11 次拦', allowed === 10 && eleventh === false, `allowed=${allowed} 11th=${eleventh}`);
      check('M1 hitRateHour：61 秒后仍拦（是 3600s 窗，不是 60s 窗）', at61s === false, `at61s=${at61s}`);
      check('M1 hitRateHour：3601 秒后放行（旧时间戳已滑出窗口）', at3601s === true, `at3601s=${at3601s}`);
    }

    // ======================================================== 账号与群
    const owner = await signup('安全评审H');
    const stranger = await signup('安全评审S');
    const humanX = await signup('安全评审X');
    const humanY = await signup('安全评审Y');
    const humanR = await signup('安全评审R');
    const A = await createAgent(owner.cookie, '安全AI-A');
    const B = await createAgent(owner.cookie, '安全AI-B');
    const C = await createAgent(owner.cookie, '安全AI-C');
    const D = await createAgent(owner.cookie, '安全AI-D');
    const E = await createAgent(owner.cookie, '安全AI-E');
    const g = await api('/api/conversations', {
      method: 'POST', cookie: owner.cookie, body: { title: `安全评审群${rnd()}`, member_ids: [A.id, B.id] },
    });
    const gid = g.json?.conversation?.id;
    if (!gid) throw new Error(`建群失败 ${JSON.stringify(g.json)}`);

    // ======================================================== 1) M1：AI 好友请求真小时窗（第 11 次 rate_limited）
    let aiFriendOk = 0;
    for (let i = 0; i < 10; i += 1) {
      const r = await mcp(C.token, 'add_friend', { principal_id: stranger.id });
      if (!r.isError) aiFriendOk += 1;
    }
    const eleventhFriend = await mcp(C.token, 'add_friend', { principal_id: stranger.id });
    check('M1 AI 好友请求：前 10 次成功、第 11 次 rate_limited',
      aiFriendOk === 10 && eleventhFriend.isError === true && eleventhFriend.json?.reason === 'rate_limited',
      `ok=${aiFriendOk} 11th=${eleventhFriend.json?.reason}`);

    // ======================================================== 2) M4：人类按号码加好友也限流 10/小时
    let humanFriendOk = 0;
    let lastHumanFriend = null;
    for (let i = 0; i < 11; i += 1) {
      lastHumanFriend = await api('/api/friends/request', {
        method: 'POST', cookie: humanR.cookie, body: { account_no: owner.accountNo },
      });
      if (lastHumanFriend.status === 200) humanFriendOk += 1;
    }
    check('M4 人类好友请求：10 次/小时后第 11 次 429 rate_limited',
      humanFriendOk === 10 && lastHumanFriend?.status === 429 && lastHumanFriend?.json?.error === 'rate_limited',
      `ok=${humanFriendOk} 11th=${lastHumanFriend?.status}/${lastHumanFriend?.json?.error}`);

    // ======================================================== 3) M2：人类被封禁后三条新写路径都 forbidden
    const gx = await api('/api/conversations', {
      method: 'POST', cookie: humanX.cookie, body: { title: `安全评审X群${rnd()}`, member_ids: [] },
    });
    const gxId = gx.json?.conversation?.id;
    await suspend(humanX.id);
    const bannedJoin = await api(`/api/conversations/${gid}/join`, { method: 'POST', cookie: humanX.cookie });
    check('M2 被封禁的人申请入群 → 403 forbidden',
      bannedJoin.status === 403 && bannedJoin.json?.error === 'forbidden', `status=${bannedJoin.status} ${bannedJoin.json?.error}`);
    const bannedPublic = await api(`/api/conversations/${gxId}/public`, {
      method: 'PATCH', cookie: humanX.cookie, body: { discoverable: true },
    });
    check('M2 被封禁的群主改群公开设置 → 403 forbidden',
      bannedPublic.status === 403 && bannedPublic.json?.error === 'forbidden', `status=${bannedPublic.status} ${bannedPublic.json?.error}`);
    const bannedFriend = await api('/api/friends/request', {
      method: 'POST', cookie: humanX.cookie, body: { account_no: owner.accountNo },
    });
    check('M2 被封禁的人加好友 → 403 forbidden',
      bannedFriend.status === 403 && bannedFriend.json?.error === 'forbidden', `status=${bannedFriend.status} ${bannedFriend.json?.error}`);
    await unsuspend(humanX.id);
    const revivedPublic = await api(`/api/conversations/${gxId}/public`, {
      method: 'PATCH', cookie: humanX.cookie, body: { discoverable: true },
    });
    check('M2 解封后同一入口恢复 200（封禁不是把账号永久卡死）', revivedPublic.status === 200, `status=${revivedPublic.status}`);

    // ======================================================== 4) M2：AI 被封禁 → MCP 401（suspend_user 不再假封禁）
    await suspend(A.id);
    const bannedMcp = await api('/mcp', {
      method: 'POST', token: A.token, body: { jsonrpc: '2.0', id: 1, method: 'tools/list' },
    });
    check('M2 被封禁 AI 的 Bearer → 401（authenticateAgent 取到 suspended_until）',
      bannedMcp.status === 401, `status=${bannedMcp.status}`);
    await unsuspend(A.id);
    const revivedMcp = await mcp(A.token, 'list_friends', {});
    check('M2 解封后 AI 立刻恢复（401 → 200）', revivedMcp.status === 200 && revivedMcp.isError === false, `status=${revivedMcp.status}`);

    // ======================================================== 5) L8：目标 AI 已 paused → 不能开私聊
    await api(`/api/agents/${D.id}/pause`, { method: 'POST', cookie: owner.cookie, body: { paused: true } });
    const dmPaused = await mcp(E.token, 'dm', { principal_id: D.id, body: 'hi', client_msg_id: rnd() + rnd() });
    check('L8 dm 到已 paused 的 AI → forbidden',
      dmPaused.isError === true && dmPaused.json?.reason === 'forbidden', `reason=${dmPaused.json?.reason}`);
    await api(`/api/agents/${D.id}/pause`, { method: 'POST', cookie: owner.cookie, body: { paused: false } });

    // ======================================================== 6) M3：表情可见性下沉到 submit
    const packA = await mcp(A.token, 'create_sticker_pack', { title: '安全评审私包' });
    const slugA = packA.json?.slug;
    await mcp(A.token, 'add_sticker_item', { pack_id: packA.json?.pack_id, url: 'https://example.com/sec.png', key: 'k1' });
    const restSticker = await api(`/api/conversations/${gid}/messages`, {
      method: 'POST', cookie: owner.cookie,
      body: { body: '', parts: [{ type: 'sticker', pack: slugA, key: 'k1' }], client_msg_id: rnd() + rnd() },
    });
    check('M3 人类 REST 引用他人（AI）私有包 → 403 sticker_not_visible',
      restSticker.status === 403 && restSticker.json?.error === 'sticker_not_visible',
      `status=${restSticker.status} ${restSticker.json?.error}`);

    const mcpSticker = await mcp(B.token, 'send_message', {
      conversation_id: gid, body: '', parts: [{ type: 'sticker', pack: slugA, key: 'k1' }], client_msg_id: rnd() + rnd(),
    });
    check('M3 MCP send_message 引用他人私有包 → sticker_not_visible',
      mcpSticker.isError === true && mcpSticker.json?.reason === 'sticker_not_visible', `reason=${mcpSticker.json?.reason}`);

    // dm 工具不经过 callSendMessage 的预检：这条才证明「下沉进 submit」真的生效
    const dmSticker = await mcp(B.token, 'dm', {
      principal_id: owner.id, body: '', parts: [{ type: 'sticker', pack: slugA, key: 'k1' }], client_msg_id: rnd() + rnd(),
    });
    check('M3 MCP dm（只走 submit，无预检）引用他人私有包 → sticker_not_visible',
      dmSticker.isError === true && dmSticker.json?.reason === 'sticker_not_visible', `reason=${dmSticker.json?.reason}`);

    const shareOwn = await mcp(A.token, 'share_sticker_pack', { pack_id: packA.json?.pack_id, conversation_id: gid });
    check('M3 自己的包分享到本群仍允许（不是一刀切拒绝）',
      shareOwn.isError === false && shareOwn.json?.accepted === true, `reason=${shareOwn.json?.reason}`);
    const afterShare = await mcp(B.token, 'send_message', {
      conversation_id: gid, body: '', parts: [{ type: 'sticker', pack: slugA, key: 'k1' }], client_msg_id: rnd() + rnd(),
    });
    check('M3 分享到本群后同群 AI 能发这个包', afterShare.json?.accepted === true, `reason=${afterShare.json?.reason_code}`);

    // ======================================================== 7) M5：AI 不能分享主人的私有包
    const ownerPack = await api('/api/sticker-packs', { method: 'POST', cookie: owner.cookie, body: { title: '主人私包' } });
    const ownerPackId = ownerPack.json?.pack?.id;
    const aiShareOwnerPack = await mcp(A.token, 'share_sticker_pack', { pack_id: ownerPackId, conversation_id: gid });
    check('M5 AI 分享主人的私有包 → forbidden',
      aiShareOwnerPack.isError === true && aiShareOwnerPack.json?.reason === 'forbidden', `reason=${aiShareOwnerPack.json?.reason}`);
    const humanShare = await api(`/api/sticker-packs/${ownerPackId}/share`, {
      method: 'POST', cookie: owner.cookie, body: { conversation_id: gid },
    });
    check('M5 主人自己在网页端分享同一个包仍可用（人类侧行为不变）', humanShare.status === 200, `status=${humanShare.status}`);

    // ======================================================== 8) L6：Push endpoint 不许指向内网
    // 纯函数先断言（不依赖 VAPID 是否配了）：包含 URL 规范化后的 IPv4-mapped 形式
    {
      const blockedHosts = [
        '127.0.0.1', '10.1.2.3', '172.20.1.1', '192.168.0.5', '169.254.169.254',
        'localhost', 'nas', '::1', 'fd00::1', 'fe80::1', '::ffff:127.0.0.1', '::ffff:7f00:1',
      ];
      const allowedHosts = ['fcm.googleapis.com', 'push.mozilla.com', 'example.com'];
      const missed = blockedHosts.filter((h) => !isBlockedEndpointHost(h));
      const over = allowedHosts.filter((h) => isBlockedEndpointHost(h));
      check('L6 isBlockedEndpointHost：内网/保留/短名全拒', missed.length === 0, missed.join(',') || `${blockedHosts.length} 条全拒`);
      check('L6 isBlockedEndpointHost：公网域名不被误杀', over.length === 0, over.join(','));
    }
    const pushKey = await api('/api/push/key');
    if (pushKey.json?.enabled !== true) {
      skip('L6 push 私有地址 → invalid_endpoint', '服务器没配 VAPID（/api/push/key enabled=false）');
    } else {
      const badEndpoints = [
        'https://127.0.0.1/x',
        'https://10.1.2.3/x',
        'https://172.16.5.5/x',
        'https://192.168.1.10/x',
        'https://169.254.169.254/latest/meta-data',
        'https://localhost/x',
        'https://[::1]/x',
        'https://[fd00::1]/x',
        'https://nas/x',
      ];
      const keys = { p256dh: 'B'.repeat(80), auth: 'a'.repeat(24) };
      const accepted = [];
      for (const endpoint of badEndpoints) {
        const r = await api('/api/push/subscribe', { method: 'POST', cookie: owner.cookie, body: { endpoint, keys } });
        if (!(r.status === 400 && r.json?.error === 'invalid_endpoint')) accepted.push(`${endpoint} → ${r.status}/${r.json?.error}`);
      }
      check('L6 push 订阅私有/保留/内网短名地址 → 400 invalid_endpoint', accepted.length === 0,
        accepted.length ? accepted.join('; ') : `${badEndpoints.length} 条全拒`);
      const goodEndpoint = `https://fcm.googleapis.com/fcm/send/verify-${rnd()}`;
      const good = await api('/api/push/subscribe', { method: 'POST', cookie: owner.cookie, body: { endpoint: goodEndpoint, keys } });
      check('L6 正常公网 endpoint 仍可订阅（黑名单没误杀推送服务）', good.status === 200, `status=${good.status}`);
      await api('/api/push/unsubscribe', { method: 'POST', cookie: owner.cookie, body: { endpoint: goodEndpoint } });
    }

    // ======================================================== 9) L9：审批时复核申请人是否已被封禁
    await api(`/api/conversations/${gid}/public`, {
      method: 'PATCH', cookie: owner.cookie, body: { discoverable: true, join_mode: 'approval' },
    });
    const applied = await api(`/api/conversations/${gid}/join`, { method: 'POST', cookie: humanY.cookie });
    check('L9 申请人提交入群申请（pending）', applied.status === 200 && applied.json?.pending === true, JSON.stringify(applied.json));
    await suspend(humanY.id);
    const acceptBanned = await api(`/api/conversations/${gid}/join-requests/${humanY.id}`, {
      method: 'POST', cookie: owner.cookie, body: { accept: true },
    });
    check('L9 封禁期间审批通过 → 403 forbidden（不会被放进群）',
      acceptBanned.status === 403 && acceptBanned.json?.error === 'forbidden', `status=${acceptBanned.status} ${acceptBanned.json?.error}`);
    await unsuspend(humanY.id);
    const acceptRevived = await api(`/api/conversations/${gid}/join-requests/${humanY.id}`, {
      method: 'POST', cookie: owner.cookie, body: { accept: true },
    });
    check('L9 解封后同一条申请可以正常通过（复核不误伤）', acceptRevived.status === 200 && acceptRevived.json?.status === 'accepted',
      `status=${acceptRevived.status} ${acceptRevived.json?.status}`);
  } finally {
    for (const id of toUnsuspend) {
      await db.query('UPDATE principals SET suspended_until = NULL WHERE id = $1', [id]).catch(() => {});
    }
    await db.end().catch(() => {});
  }

  const failed = results.filter((r) => !r.ok);
  console.log(`\n${failed.length === 0 ? '全部通过' : '有失败'}：${results.length - failed.length}/${results.length}${skips.length ? `（另有 ${skips.length} 项 SKIP）` : ''}`);
  if (failed.length) {
    console.log('失败项：' + failed.map((f) => f.name).join('; '));
    process.exitCode = 1;
  }
};

main().catch((e) => {
  console.error('验证异常：', e.message);
  process.exitCode = 1;
});
