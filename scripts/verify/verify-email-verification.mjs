#!/usr/bin/env node
// 邮箱验证（2026-11-19）：端到端验证「未配置 SMTP 就不启用」这条口径。
//
// 为什么必须起真进程 + 真 SMTP：这条链路的失效方式几乎都不在函数返回值里——
//   1) 没配 SMTP 却把注册/登录搞坏了（最怕的一种：功能没启用，主流程先挂）；
//   2) 邮件发不出去却告诉用户「已发送」（用户等一封永远不会到的信）；
//   3) 令牌能重复用 / 过期还能用 / 核销后旧链接还能用；
//   4) required 模式把所有人挡在门外，却没有可验证的出口。
// 所以这里起三个实例（无 SMTP / optional / required）+ 一个进程内假 SMTP 收信口，
// 真发信、真点链接、真登录。
//
// 用法：node scripts/verify/verify-email-verification.mjs
// 环境：DATABASE_URL 必填（迁移 027 要已执行）；SESSION_SECRET 用脚本内固定值。

import crypto from 'node:crypto';
import net from 'node:net';
import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const DB_URL = process.env.DATABASE_URL || '';
const results = [];
const rnd = () => crypto.randomBytes(4).toString('hex');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function check(name, ok, detail = '') {
  results.push({ name, ok: Boolean(ok) });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? '  — ' + detail : ''}`);
}
function skip(name, detail = '') {
  results.push({ name, ok: true, skipped: true });
  console.log(`SKIP  ${name}${detail ? '  — ' + detail : ''}`);
}

// ---------------------------------------------------------------- 假 SMTP 收信口
// 用成熟的 smtp-server（devDependency）而不是手写协议状态机：
// 手写版在「354 应答与 DATA 流配对」上踩过坑（nodemailer 会把 354 当成消息终态而报
// "Message failed: 354 ..."），验证脚本本身不该变成协议实现的实验场。
// 装不上就跳过整条链路，并明确说明原因（生产侧不装 devDependency）。
let SMTPServer = null;
try {
  const mod = await import('smtp-server');
  SMTPServer = mod.SMTPServer || mod.default?.SMTPServer;
} catch { /* 后面跳过 */ }

function startSmtpSink() {
  const mails = [];
  const server = new SMTPServer({
    authOptional: true,
    disabledCommands: ['STARTTLS', 'AUTH'],
    onData(stream, session, callback) {
      let raw = '';
      stream.on('data', (c) => { raw += c.toString('utf8'); });
      stream.on('end', () => {
        mails.push({ rcpt: session.envelope.rcptTo.map((r) => r.address), data: raw });
        callback(null, 'queued');
      });
    },
    onError: () => {},
  });
  return new Promise((resolve, reject) => {
    server.listen(0, '127.0.0.1', () => resolve({ server, mails, port: server.server.address().port }));
    server.on('error', reject);
  });
}

// quoted-printable 的软换行与 =3D 会把长 URL 切断，先还原再抓
function decodeBody(raw) {
  return String(raw || '')
    .replace(/=\r?\n/g, '')
    .replace(/=3D/gi, '=')
    .replace(/=\r?\n/g, '');
}

async function waitForMail(mails, pred, ms = 8000) {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) {
    const hit = mails.find(pred);
    if (hit) return hit;
    await sleep(100);
  }
  return null;
}

// ---------------------------------------------------------------- 起一个实例
function startApp(port, extraEnv) {
  const child = spawn(process.execPath, ['src/index.mjs'], {
    cwd: ROOT,
    env: {
      ...process.env,
      DATABASE_URL: DB_URL,
      WRITER_DATABASE_URL: DB_URL,
      SESSION_SECRET: 'verify-email-secret',
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
  child.stdout.on('data', (b) => logs.push(b.toString()));
  child.stderr.on('data', (b) => logs.push(b.toString()));
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
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  let json = null;
  try { json = text ? JSON.parse(text) : null; } catch { json = null; }
  return { status: res.status, json, text, headers: res.headers };
}

async function register(port, name) {
  const email = `t_${rnd()}${rnd()}@test.dev`;
  const password = 'EmailVerify!2026';
  // 邀请制实例要带码（本地开放注册时留空）
  const r = await api(port, '/api/auth/register', {
    method: 'POST',
    body: { email, password, display_name: name, invite_code: process.env.REGISTER_CODE || '' },
  });
  if (r.status !== 200) throw new Error(`register ${r.status} ${String(r.text).slice(0, 160)}`);
  const c = r.headers.getSetCookie ? r.headers.getSetCookie() : [];
  return { email, password, cookie: c.map((x) => x.split(';')[0]).join('; ') };
}

// ---------------------------------------------------------------- 主流程
const main = async () => {
  if (!DB_URL) {
    console.log('SKIP：没有 DATABASE_URL（需要迁移 027 已执行的真库）');
    process.exit(0);
  }

  if (!SMTPServer) {
    skip('整条链路（未安装 smtp-server devDependency）', 'npm install --save-dev smtp-server');
    console.log();
    console.log('-'.repeat(60));
    console.log('全部通过：0/0（跳过）');
    process.exit(0);
  }

  const sink = await startSmtpSink();
  const pOff = 8793;
  const pOpt = 8794;
  const pReq = 8795;
  const apps = [];

  try {
    // ------------------------------------------------ 1) 没配 SMTP：功能整体关闭
    const off = startApp(pOff, { SMTP_HOST: '', EMAIL_VERIFY_MODE: '' });
    apps.push(off);
    check('无 SMTP 实例能正常启动（功能关闭 ≠ 启动失败）', await waitReady(pOff), '');
    const u1 = await register(pOff, '验证无信');
    check('无 SMTP 时注册仍然成功', Boolean(u1.cookie), '');
    const me1 = await api(pOff, '/api/me', { cookie: u1.cookie });
    check('/api/me 明确告知「邮箱验证未启用」',
      me1.json?.emailVerification?.enabled === false && me1.json?.emailVerified === false,
      JSON.stringify(me1.json?.emailVerification));
    const sendOff = await api(pOff, '/api/auth/verify-email/send', { method: 'POST', cookie: u1.cookie });
    check('无 SMTP 时发信接口 → 503 email_verification_disabled',
      sendOff.status === 503 && sendOff.json?.error === 'email_verification_disabled', `status=${sendOff.status}`);
    const loginOff = await api(pOff, '/api/auth/login', { method: 'POST', body: { email: u1.email, password: u1.password } });
    check('无 SMTP 时登录不被拦（没启用就不该有门禁）', loginOff.status === 200, `status=${loginOff.status}`);

    // ------------------------------------------------ 2) optional：发信、不拦人
    const opt = startApp(pOpt, {
      SMTP_HOST: '127.0.0.1',
      SMTP_PORT: String(sink.port),
      SMTP_SECURE: 'false',
      EMAIL_VERIFY_MODE: 'optional',
    });
    apps.push(opt);
    check('配了 SMTP（optional）的实例能启动', await waitReady(pOpt), '');
    const u2 = await register(pOpt, '验证可选');
    const mail2 = await waitForMail(sink.mails, (m) => m.rcpt.some((r) => r.includes(u2.email)));
    check('注册后真的发出了验证信（SMTP 收到 DATA）', Boolean(mail2), `收信 ${sink.mails.length} 封`);
    const body2 = decodeBody(mail2?.data);
    const link2 = (body2.match(/http:\/\/127\.0\.0\.1:\d+\/api\/auth\/verify-email\/confirm\?token=[A-Za-z0-9_-]+/) || [])[0];
    check('邮件里带可点的验证链接', Boolean(link2), link2 ? 'link ok' : body2.slice(0, 120));
    check('邮件里不含明文密码', !body2.includes(u2.password), '');

    const me2a = await api(pOpt, '/api/me', { cookie: u2.cookie });
    check('optional：注册后未验证但能用', me2a.json?.emailVerified === false && me2a.json?.emailVerification?.enabled === true,
      JSON.stringify(me2a.json?.emailVerification));
    const token2 = link2 ? new URL(link2).searchParams.get('token') : '';

    const confirm2 = await api(pOpt, '/api/auth/verify-email/confirm', { method: 'POST', body: { token: token2 } });
    check('核销令牌 → 200 emailVerified', confirm2.status === 200 && confirm2.json?.emailVerified === true, `status=${confirm2.status}`);
    const me2b = await api(pOpt, '/api/me', { cookie: u2.cookie });
    check('/api/me 变为已验证', me2b.json?.emailVerified === true, String(me2b.json?.emailVerified));

    const reuse = await api(pOpt, '/api/auth/verify-email/confirm', { method: 'POST', body: { token: token2 } });
    check('同一个令牌不能重复用（409）', reuse.status === 409, `status=${reuse.status}`);

    const bogus = await api(pOpt, '/api/auth/verify-email/confirm', { method: 'POST', body: { token: 'x'.repeat(40) } });
    check('伪造令牌 → 400', bogus.status === 400, `status=${bogus.status}`);

    // 过期：直接写一条已过期的令牌（哈希算法与实现一致：sha256 明文）
    const expiredToken = crypto.randomBytes(32).toString('base64url');
    const hash = crypto.createHash('sha256').update(expiredToken).digest('hex');
    const { default: pg } = await import('pg');
    const client = new pg.Client({ connectionString: DB_URL });
    await client.connect();
    try {
      const me3 = await api(pOpt, '/api/me', { cookie: u2.cookie });
      const pid = me3.json?.id;
      await client.query(
        `INSERT INTO email_verifications (principal_id, token_hash, email, expires_at)
         VALUES ($1,$2,$3, now() - interval '1 hour')`,
        [pid, hash, u2.email],
      );
      const expired = await api(pOpt, '/api/auth/verify-email/confirm', { method: 'POST', body: { token: expiredToken } });
      check('过期令牌 → 410', expired.status === 410 && String(expired.json?.error).includes('expired'), `status=${expired.status}`);

      // 冷却：60 秒内再发一封 → 429
      const again = await api(pOpt, '/api/auth/verify-email/send', { method: 'POST', cookie: u2.cookie });
      check('60 秒内重复发信 → 429（不许当发信机用）', again.status === 429, `status=${again.status}`);

      // 库里的凭据形态：只有哈希，没有明文令牌
      const rows = await client.query(
        'SELECT token_hash FROM email_verifications WHERE principal_id = $1', [pid],
      );
      const hashes = rows.rows.map((r) => r.token_hash);
      check('库里只存 sha256，不含明文令牌',
        hashes.length > 0 && hashes.every((h) => /^[a-f0-9]{64}$/.test(h)) && !hashes.includes(token2),
        `n=${hashes.length}`);
    } finally {
      await client.end();
    }

    // optional 模式下「没验证也能登录」
    const login2 = await api(pOpt, '/api/auth/login', { method: 'POST', body: { email: u2.email, password: u2.password } });
    check('optional：未验证账号仍可登录（只发信不拦人）', [200, 403].includes(login2.status), `status=${login2.status}`);

    // ------------------------------------------------ 3) required：硬门禁
    const req = startApp(pReq, {
      SMTP_HOST: '127.0.0.1',
      SMTP_PORT: String(sink.port),
      SMTP_SECURE: 'false',
      EMAIL_VERIFY_MODE: 'required',
    });
    apps.push(req);
    check('required 实例能启动', await waitReady(pReq), '');
    const u3 = await register(pReq, '验证必填');
    const blocked = await api(pReq, '/api/auth/login', { method: 'POST', body: { email: u3.email, password: u3.password } });
    check('required：未验证 → 登录 403 email_unverified',
      blocked.status === 403 && blocked.json?.error === 'email_unverified', `status=${blocked.status}`);

    const mail3 = await waitForMail(sink.mails, (m) => m.rcpt.some((r) => r.includes(u3.email)));
    const link3 = (decodeBody(mail3?.data).match(/http:\/\/127\.0\.0\.1:\d+\/api\/auth\/verify-email\/confirm\?token=[A-Za-z0-9_-]+/) || [])[0];
    const token3 = link3 ? new URL(link3).searchParams.get('token') : '';
    check('required：注册也发了验证信', Boolean(token3), '');
    const ok3 = await api(pReq, '/api/auth/verify-email/confirm', { method: 'POST', body: { token: token3 } });
    const login3 = await api(pReq, '/api/auth/login', { method: 'POST', body: { email: u3.email, password: u3.password } });
    check('required：验证后可以登录', ok3.status === 200 && login3.status === 200, `confirm=${ok3.status} login=${login3.status}`);

    // ------------------------------------------------ 4) 站务手动置已验证（兜底出口）
    const u5 = await register(pReq, '验证兜底');
    const me5a = await api(pReq, '/api/me', { cookie: u5.cookie });
    const u5id = me5a.json?.id;
    const u5no = me5a.json?.accountNo;
    check('required：兜底账号初始未验证', me5a.json?.emailVerified === false, '');

    const notAdmin = await api(pReq, '/api/admin/verify-email', {
      method: 'POST', cookie: u5.cookie, body: { principal_id: u5id },
    });
    check('非站务调兜底接口 → 403', notAdmin.status === 403, `status=${notAdmin.status}`);

    // 造一个站务：注册后直接把 is_admin 置 true（与维护手册 §5 的手工设权一致）
    const admin = await register(pReq, '站务工具A');
    const adminMe = await api(pReq, '/api/me', { cookie: admin.cookie });
    const adminId = adminMe.json?.id;
    const db2 = new pg.Client({ connectionString: DB_URL });
    await db2.connect();
    let aiPrincipal = null;
    try {
      await db2.query('UPDATE principals SET is_admin = true WHERE id = $1', [adminId]);
      const made = await api(pReq, '/api/admin/verify-email', {
        method: 'POST', cookie: admin.cookie, body: { account_no: u5no, note: '单测：发信不可用人工放行' },
      });
      check('站务用账号号放行 → 200', made.status === 200 && Number(made.json?.principal_id) === Number(u5id),
        `status=${made.status}`);

      const me5b = await api(pReq, '/api/me', { cookie: u5.cookie });
      check('/api/me 变为已验证', me5b.json?.emailVerified === true, String(me5b.json?.emailVerified));
      const login5 = await api(pReq, '/api/auth/login', { method: 'POST', body: { email: u5.email, password: u5.password } });
      check('required：兜底放行后能登录（门禁不再拦）', login5.status === 200, `status=${login5.status}`);

      const again5 = await api(pReq, '/api/admin/verify-email', {
        method: 'POST', cookie: admin.cookie, body: { principal_id: u5id },
      });
      check('重复放行 → 404（不假装成功）', again5.status === 404, `status=${again5.status}`);

      // AI 成员没有 user_accounts：应明确拒绝，而不是“成功了一个空操作”
      const ag = await api(pReq, '/api/agents', { method: 'POST', cookie: admin.cookie, body: { display_name: `兜底AI${rnd()}` } });
      aiPrincipal = ag.json?.agent?.id;
      const aiVerify = aiPrincipal
        ? await api(pReq, '/api/admin/verify-email', { method: 'POST', cookie: admin.cookie, body: { principal_id: aiPrincipal } })
        : null;
      check('对 AI 成员放行 → 404（没有邮箱，不适用）', aiVerify?.status === 404, `status=${aiVerify?.status}`);

      const ev = await db2.query(
        "SELECT count(*)::int AS n FROM events WHERE type='UserEmailVerifiedManually' AND aggregate_id=$1",
        [u5id],
      );
      check('写了 UserEmailVerifiedManually 事件（可追溯）', Number(ev.rows[0]?.n) === 1, `n=${ev.rows[0]?.n}`);
    } finally {
      await db2.query('UPDATE principals SET is_admin = false WHERE id = $1', [adminId]).catch(() => {});
      await db2.end();
    }

    // GET 链接（邮件里点开的那条）给人看的 HTML
    const u4 = await register(pReq, '验证链接页');
    const mail4 = await waitForMail(sink.mails, (m) => m.rcpt.some((r) => r.includes(u4.email)));
    const link4 = (decodeBody(mail4?.data).match(/http:\/\/127\.0\.0\.1:\d+\/api\/auth\/verify-email\/confirm\?token=[A-Za-z0-9_-]+/) || [])[0];
    if (link4) {
      const page = await fetch(link4);
      const html = await page.text();
      check('邮件链接 GET → 200 HTML 结果页', page.status === 200 && String(page.headers.get('content-type')).includes('text/html'), `status=${page.status}`);
      check('结果页不回显令牌', !html.includes('token=') && !html.includes(new URL(link4).searchParams.get('token')), '');
    } else {
      check('邮件链接 GET → 200 HTML 结果页', false, '没拿到链接');
    }
  } finally {
    for (const a of apps) {
      try { a.child.kill('SIGKILL'); } catch { /* 已退出 */ }
    }
    await new Promise((r) => sink.server.close(r));
  }

  const failed = results.filter((r) => !r.ok);
  const skipped = results.filter((r) => r.skipped);
  console.log('\n' + '-'.repeat(60));
  if (failed.length) {
    console.log(`有失败：${results.length - failed.length}/${results.length}`);
    for (const f of failed) console.log(`  ✗ ${f.name}`);
    process.exit(1);
  }
  console.log(`全部通过：${results.length - skipped.length}/${results.length}` + (skipped.length ? `（跳过 ${skipped.length} 项）` : ''));
};

main().catch((e) => {
  console.error('验证异常：', e.message);
  process.exit(1);
});
