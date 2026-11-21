#!/usr/bin/env node
// 实例开放（候补 / 开放注册）的端到端验证（2026-11-19）。
//
// 为什么必须起多个实例：这个功能的全部安全性都取决于 **SIGNUP_MODE** 的三个取值，
// 而它们只能通过「不同 env 起不同进程」来验。在同一个进程里改 config 是自欺欺人。
//
// 覆盖：
//   1) invite（默认）：/api/waitlist 不存在（404），注册仍然要码；
//   2) waitlist：申请成功、重复申请幂等、非法邮箱 400、同 IP 超额 429；
//   3) 站务：非站务 403；列表只给掩码不给明文；发码返回一次性明文且真的能注册；
//      同一条重复发码 409；拒绝后不能再发；
//   4) open：不需要码就能注册，/api/signup 明示 inviteRequired=false。
//
// 用法：DATABASE_URL=... node scripts/verify/verify-waitlist.mjs

import crypto from 'node:crypto';
import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import pg from 'pg';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const DB_URL = process.env.DATABASE_URL || '';
const results = [];
const rnd = () => crypto.randomBytes(4).toString('hex');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function check(name, ok, detail = '') {
  results.push({ name, ok: Boolean(ok) });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? '  — ' + detail : ''}`);
}

function startApp(port, extraEnv) {
  const child = spawn(process.execPath, ['src/index.mjs'], {
    cwd: ROOT,
    env: {
      ...process.env,
      DATABASE_URL: DB_URL,
      WRITER_DATABASE_URL: DB_URL,
      SESSION_SECRET: 'verify-waitlist-secret',
      SECURE_COOKIE: 'false',
      PORT: String(port),
      PUBLIC_BASE_URL: `http://127.0.0.1:${port}`,
      MEDIA_DIR: path.join(ROOT, 'tmp', 'devmedia'),
      LOG_LEVEL: 'warn',
      ...extraEnv,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const logs = [];
  child.stdout.on('data', (b) => logs.push(String(b)));
  child.stderr.on('data', (b) => logs.push(String(b)));
  return { child, logs };
}

async function waitReady(port, ms = 20000) {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) {
    try {
      const r = await fetch(`http://127.0.0.1:${port}/healthz`);
      if (r.ok) return true;
    } catch { /* 还没起来 */ }
    await sleep(200);
  }
  return false;
}

async function api(port, p, { method = 'GET', body, cookie } = {}) {
  const headers = {};
  if (cookie) headers.cookie = cookie;
  if (body !== undefined) headers['content-type'] = 'application/json';
  const res = await fetch(`http://127.0.0.1:${port}${p}`, {
    method, headers, body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  let json = null;
  try { json = text ? JSON.parse(text) : null; } catch { json = null; }
  return { status: res.status, json, text, headers: res.headers };
}

async function register(port, name, inviteCode) {
  const email = `t_${rnd()}${rnd()}@test.dev`;
  const r = await api(port, '/api/auth/register', {
    method: 'POST',
    body: { email, password: 'Waitlist!2026x', display_name: name, invite_code: inviteCode || '' },
  });
  const c = r.headers.getSetCookie ? r.headers.getSetCookie() : [];
  return { status: r.status, json: r.json, cookie: c.map((x) => x.split(';')[0]).join('; '), email };
}

const main = async () => {
  if (!DB_URL) { console.log('SKIP：需要 DATABASE_URL（迁移 028 已执行的真库）'); process.exit(0); }

  const pInvite = 8796;
  const pWait = 8797;
  const pOpen = 8798;
  const apps = [];
  const db = new pg.Client({ connectionString: DB_URL });
  await db.connect();
  // 复位本脚本自己造成的残留：注册失败计数（会把后续请求锁成 429）与本脚本的候补行。
  // 只清自己造的数据（@test.dev 的 wait_* 申请），不碰别人的。
  await db.query('DELETE FROM login_attempts').catch(() => {});
  await db.query("DELETE FROM signup_waitlist WHERE email LIKE 'wait\_%@test.dev' OR email LIKE 'w\_%@test.dev'").catch(() => {});

  try {
    // ------------------------------------------------ 1) invite（默认）：候补接口不存在
    const inv = startApp(pInvite, { SIGNUP_MODE: 'invite', INVITE_MODE: 'db' });
    apps.push(inv);
    check('invite 模式实例启动', await waitReady(pInvite), '');
    const signupInvite = await api(pInvite, '/api/signup');
    check('invite：/api/signup 明示需要邀请码',
      signupInvite.json?.mode === 'invite' && signupInvite.json?.inviteRequired === true,
      JSON.stringify(signupInvite.json));
    const wl404 = await api(pInvite, '/api/waitlist', { method: 'POST', body: { email: `w${rnd()}@test.dev` } });
    check('invite：候补接口不可见（404，不泄露站务配置）', wl404.status === 404, `status=${wl404.status}`);
    const noCode = await register(pInvite, '无码路人');
    check('invite：没有码注册 → 403', noCode.status === 403, `status=${noCode.status}`);

    // ------------------------------------------------ 1.5) 先在 open 实例建两个测试账号
    // 为什么不在 waitlist 实例上注册：那需要邀请码，而"站务发码"正是被测对象（鸡生蛋）。
    // 三个实例共享同一个库和同一个 SESSION_SECRET，所以这里拿到的会话在别的实例上同样有效。
    const open = startApp(pOpen, { SIGNUP_MODE: 'open', INVITE_MODE: 'db', REGISTER_CODE: 'should-be-ignored' });
    apps.push(open);
    check('open 模式实例启动', await waitReady(pOpen), '');
    const plain = await register(pOpen, '普通用户');
    const admin = await register(pOpen, '候补站务');
    const adminMe = await api(pOpen, '/api/me', { cookie: admin.cookie });
    const adminId = adminMe.json?.id;
    await db.query('UPDATE principals SET is_admin = true WHERE id = $1', [adminId]);
    check('用 open 实例建出普通账号与站务账号', Boolean(plain.cookie) && Boolean(admin.cookie) && Boolean(adminId),
      `adminId=${adminId}`);

    // ------------------------------------------------ 2) waitlist：申请
    const wait = startApp(pWait, { SIGNUP_MODE: 'waitlist', INVITE_MODE: 'db' });
    apps.push(wait);
    check('waitlist 模式实例启动', await waitReady(pWait), '');
    const signupWait = await api(pWait, '/api/signup');
    check('waitlist：/api/signup 明示可申请候补',
      signupWait.json?.mode === 'waitlist' && signupWait.json?.waitlistOpen === true, '');

    const emailA = `wait_${rnd()}@test.dev`;
    const apply1 = await api(pWait, '/api/waitlist', { method: 'POST', body: { email: emailA, note: '想让我的 AI 有个群' } });
    check('候补申请成功', apply1.status === 200 && apply1.json?.ok === true && apply1.json?.already === false,
      `status=${apply1.status} already=${apply1.json?.already}`);
    const apply2 = await api(pWait, '/api/waitlist', { method: 'POST', body: { email: emailA.toUpperCase() } });
    check('同邮箱重复申请是幂等的（不新建一条）', apply2.status === 200 && apply2.json?.already === true, '');
    const badMail = await api(pWait, '/api/waitlist', { method: 'POST', body: { email: 'not-an-email' } });
    check('非法邮箱 → 400', badMail.status === 400, `status=${badMail.status}`);

    // ------------------------------------------------ 3) 站务：列表 / 发码 / 重复 / 拒绝
    const listDenied = await api(pWait, '/api/admin/waitlist', { cookie: plain.cookie });
    check('非站务看待审列表 → 403', listDenied.status === 403, `status=${listDenied.status}`);

    const list = await api(pWait, '/api/admin/waitlist', { cookie: admin.cookie });
    const item = (list.json?.items || []).find((x) => x.emailMasked?.includes('@test.dev'));
    check('站务能看待审列表', list.status === 200 && Array.isArray(list.json?.items), `n=${list.json?.items?.length}`);
    check('列表里的邮箱是掩码（不明文）',
      Boolean(item) && item.emailMasked.includes('*') && !JSON.stringify(list.json).includes(emailA),
      item?.emailMasked || '没找到条目');

    const issued = await api(pWait, `/api/admin/waitlist/${item?.id}/issue`, { method: 'POST', cookie: admin.cookie, body: {} });
    check('站务发码 → 一次明文', issued.status === 200 && typeof issued.json?.code === 'string' && issued.json.code.length >= 8,
      `status=${issued.status}`);
    const dupIssue = await api(pWait, `/api/admin/waitlist/${item?.id}/issue`, { method: 'POST', cookie: admin.cookie, body: {} });
    check('同一条候补重复发码 → 409', dupIssue.status === 409, `status=${dupIssue.status}`);

    const used = await register(pWait, '候补进来的', issued.json?.code);
    check('发出去的码真的能注册', used.status === 200 && Boolean(used.cookie), `status=${used.status}`);

    // 拒绝流程
    const emailB = `wait_${rnd()}@test.dev`;
    await api(pWait, '/api/waitlist', { method: 'POST', body: { email: emailB, note: '刷单试试' } });
    const list2 = await api(pWait, '/api/admin/waitlist', { cookie: admin.cookie });
    const item2 = (list2.json?.items || []).find((x) => x.note === '刷单试试');
    const rejected = await api(pWait, `/api/admin/waitlist/${item2?.id}/reject`, { method: 'POST', cookie: admin.cookie, body: {} });
    check('站务拒绝候补', rejected.status === 200, `status=${rejected.status}`);
    const issueRejected = await api(pWait, `/api/admin/waitlist/${item2?.id}/issue`, { method: 'POST', cookie: admin.cookie, body: {} });
    check('已被拒绝的条目不能再发码（409）', issueRejected.status === 409, `status=${issueRejected.status}`);

    // 同 IP 超额：这条实例上已经申请了 3 条（A + B + 幂等那次不算），第 4 条应 429
    const extra = [];
    for (let i = 0; i < 3; i += 1) {
      extra.push(await api(pWait, '/api/waitlist', { method: 'POST', body: { email: `wait_${rnd()}_${i}@test.dev` } }));
    }
    const over = extra.some((r) => r.status === 429) || (await api(pWait, '/api/waitlist', { method: 'POST', body: { email: `wait_${rnd()}_z@test.dev` } })).status === 429;
    check('同一 IP 24h 申请超额 → 429（防刷队列表）', over,
      extra.map((r) => r.status).join('/'));

    await db.query('UPDATE principals SET is_admin = false WHERE id = $1', [adminId]);

    // ------------------------------------------------ 4) open：不需要码
    const signupOpen = await api(pOpen, '/api/signup');
    check('open：/api/signup 明示不需要邀请码',
      signupOpen.json?.mode === 'open' && signupOpen.json?.inviteRequired === false, '');
    const openReg = await register(pOpen, '开放注册的');
    check('open：没有码也能注册（且不被 REGISTER_CODE 拦住）', openReg.status === 200 && Boolean(openReg.cookie),
      `status=${openReg.status}`);
  } finally {
    for (const a of apps) { try { a.child.kill('SIGKILL'); } catch { /* 已退出 */ } }
    await db.end().catch(() => {});
  }

  const failed = results.filter((r) => !r.ok);
  console.log('\n' + '-'.repeat(60));
  if (failed.length) {
    console.log(`有失败：${results.length - failed.length}/${results.length}`);
    for (const f of failed) console.log(`  ✗ ${f.name}`);
    process.exit(1);
  }
  console.log(`全部通过：${results.length}/${results.length}`);
};

main().catch((err) => {
  console.error('验证异常：', err.message);
  process.exit(1);
});
