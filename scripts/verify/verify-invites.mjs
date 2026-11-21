// 邀请制（B 方案）回归：邀请码 / 名额 / 兑换 / 审计 / 并发
//
// 覆盖（逐条 PASS/FAIL）：
//   §0 迁移与 bootstrap：4 张表存在、bootstrap 码只有 hash
//   §1 A 用 bootstrap 码注册：拿到默认 3 个名额、顺序 account_no、兑换记录（无明文邮箱/IP）
//   §2 A 创建码：格式、默认 30 天、明文只出现一次、再创建先吊销旧码、参数校验
//   §3 B/C/D 兑换同一张多用途码：每人各得 3 名额、A 看到 3 个 invitee、A 名额用尽
//   §4 兑换失败统一 403 invite_required：已用满 / 未知 / 过期 / 吊销 / 邀请人名额满
//   §5 站务码与站务接口：非站务 403、站务建码/列码/吊销、用户撤别人的码 → 404
//   §6 并发兑换 max_uses=1：恰好 1 个成功
//   §7 失败计数：同一 IP 连续 5 次 → 429（与登录同一套 login_attempts/isLockedOut）
//   §8 DB 完整性：库里查不到任何明文码、审计行存在且 append-only、mcp_writer 无权限
//   §9 env 兼容：REGISTER_CODE 老路径仍可用；EXPECT_ENV_IGNORED=1 时断言 env 码被忽略
//   §10 防刷：同一 IP 24h 第 4 次兑换 → 429 且不消耗码/名额；换 IP 立刻恢复
//   §11 邀请深度：站务码 depth=0；用户码 depth=邀请人 depth+1；超过 INVITE_MAX_DEPTH 被拒且不消耗
//   §12 邮箱枚举：无效码 + 已存在邮箱 → 403（不是 409）；有效码 + 已存在邮箱 → 409 且码/名额都不动
//
// 用法（本机）：
//   node scripts/verify/verify-invites.mjs
//   REGISTER_CODE=xxx node scripts/verify/verify-invites.mjs                  # 服务端也配了 REGISTER_CODE
//   INVITE_MODE=db EXPECT_ENV_IGNORED=1 REGISTER_CODE=xxx node scripts/verify/verify-invites.mjs
//     # 服务端以 INVITE_MODE=db 启动时跑这条，断言 env 码被忽略
//
// 前置：
//   - 服务已起（BASE，默认 http://127.0.0.1:8787）
//   - 能直连库（ADMIN_DATABASE_URL，默认本机 devstack 的 postgres@5434/aio）
//   - SESSION_SECRET / INVITE_PEPPER 必须与**服务端进程**一致：bootstrap 码要在脚本里
//     用同一把钥算 HMAC 才能被服务端兑换（默认 dev-only-secret，与 tmp/devstack.sh 一致）
//
// 为什么脚本自己有 DB 权限：第一张码必须从库里种进去（鸡生蛋），
// 另外 is_admin / 过期时间 / 只读审计这些断言只能直连查。
//
// IP 隔离（很重要）：§10 的闸门按「同一出口 IP 的 24h 成功兑换数」计数。本脚本每次注册
// 都带一个独立的 cf-connecting-ip（本机服务在 loopback 上信任这个头，见 routes.mjs#clientIp；
// 生产里由 Cloudflare 覆盖），否则整份脚本自己就会把 127.0.0.1 的 3 次额度用完。
// 脚本启动时先断言这个头确实生效（ip_hash 与预期一致），不生效就直接报错退出——
// 与其后面几十条断言被 429 连锁污染，不如在这里说清楚。

import crypto from 'node:crypto';
import pg from 'pg';

const BASE = (process.env.BASE || 'http://127.0.0.1:8787').replace(/\/$/, '');
const DB_URL = process.env.ADMIN_DATABASE_URL || process.env.DATABASE_URL || 'postgres://postgres@127.0.0.1:5434/aio';
// core/invites.mjs 需要同一套环境变量才能算出与服务端一致的 hash
process.env.SESSION_SECRET = process.env.SESSION_SECRET || 'dev-only-secret';
process.env.DATABASE_URL = process.env.DATABASE_URL || DB_URL;

const ENV_CODE = process.env.REGISTER_CODE || '';
const EXPECT_ENV_IGNORED = process.env.EXPECT_ENV_IGNORED === '1';
const MAX_PER_IP_DAY = Number(process.env.INVITE_MAX_PER_IP_DAY || 8);
const MAX_DEPTH = Number(process.env.INVITE_MAX_DEPTH || 8);

const { generateCodeBody, formatCode, hashCode, hashIp } = await import('../../src/core/invites.mjs');
const { pool } = await import('../../src/db.mjs');

const results = [];
let sectionName = '';
const rnd = () => crypto.randomBytes(5).toString('hex');
// 每次注册默认换一个「假出口 IP」，让 IP 闸用例与主流程互不干扰
const freshIp = () => `10.${crypto.randomInt(1, 250)}.${crypto.randomInt(1, 250)}.${crypto.randomInt(1, 250)}`;

function section(name) {
  sectionName = name;
  console.log(`\n== ${name} ==`);
}

function check(name, ok, detail = '') {
  results.push({ section: sectionName, name, ok });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? '  — ' + detail : ''}`);
}

async function api(path, { method = 'GET', body, cookie, headers: extraHeaders } = {}) {
  const headers = { ...(extraHeaders || {}) };
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

const PASSWORD = 'passw0rd!x';

async function register({ name, inviteCode, email, ip } = {}) {
  const mail = email || `t_${rnd()}@test.dev`;
  const srcIp = ip || freshIp();
  const body = { email: mail, password: PASSWORD, display_name: name || `邀请${rnd().slice(0, 4)}` };
  if (inviteCode !== undefined) body.invite_code = inviteCode;
  const r = await api('/api/auth/register', {
    method: 'POST', headers: { 'cf-connecting-ip': srcIp }, body,
  });
  return { ...r, email: mail, ip: srcIp };
}

const admin = new pg.Client({ connectionString: DB_URL });
await admin.connect();

async function q(text, params = []) {
  const r = await admin.query(text, params);
  return r.rows;
}

// 邀请码失败计数会把同一 IP 锁 15 分钟；负面用例跑完必须清掉，否则后面的正常注册全 429。
// 只清 invite:% 这个前缀，不碰登录失败计数（那是另一份账）。
async function clearInviteLockouts() {
  await q("DELETE FROM login_attempts WHERE key LIKE 'invite:%'");
}

async function insertBootstrapCode({ maxUses = 3, days = 1, note = 'verify-bootstrap' } = {}) {
  const body = generateCodeBody();
  const hash = hashCode(body);
  const rows = await q(
    `INSERT INTO invite_codes (owner_user_id, code_hash, code_prefix, max_uses, expires_at, note)
     VALUES (NULL,$1,$2,$3, now() + ($4 || ' days')::interval, $5)
     RETURNING id`,
    [hash, body.slice(0, 4), maxUses, String(days), note],
  );
  return { id: Number(rows[0].id), code: formatCode(body), body, hash };
}

async function main() {
  const health = await api('/healthz');
  if (health.status !== 200 || !health.json?.db) {
    throw new Error(`服务不可用：${BASE}/healthz → ${health.status}`);
  }

  // ---------------------------------------------------------------- §0 迁移
  section('§0 迁移与 bootstrap 码');
  const tables = await q(
    `SELECT tablename FROM pg_tables WHERE schemaname='public'
       AND tablename IN ('invite_codes','invite_redemptions','user_invite_quotas','invite_audit')`,
  );
  check('4 张邀请表都存在', tables.length === 4, tables.map((t) => t.tablename).sort().join(','));
  const mig = await q("SELECT name FROM schema_migrations WHERE name LIKE '024%'");
  check('迁移 024_invites.sql 已记录', mig.length === 1, mig.map((m) => m.name).join(','));
  const quotaBackfill = await q(
    `SELECT count(*)::int AS n FROM principals p
      WHERE p.type='user' AND NOT EXISTS (SELECT 1 FROM user_invite_quotas q WHERE q.principal_id=p.id)`,
  );
  check('所有 type=user 的账号都有额度行（迁移已回填）', quotaBackfill[0].n === 0, `缺 ${quotaBackfill[0].n} 行`);
  const mig25 = await q("SELECT name FROM schema_migrations WHERE name LIKE '025%'");
  const depthCols = await q(
    `SELECT table_name FROM information_schema.columns
      WHERE column_name='depth' AND table_name IN ('user_invite_quotas','invite_redemptions')`,
  );
  check('迁移 025 已记录 + 两张表的 depth 列都在',
    mig25.length === 1 && depthCols.length === 2,
    `${mig25.map((m) => m.name).join(',')} / depth:${depthCols.map((c) => c.table_name).join(',')}`);

  const boot = await insertBootstrapCode({ maxUses: 3, days: 1 });
  const bootRow = (await q('SELECT code_hash, code_prefix, max_uses FROM invite_codes WHERE id=$1', [boot.id]))[0];
  check('bootstrap 码入库且只有 hash', /^[0-9a-f]{64}$/.test(bootRow.code_hash) && !bootRow.code_hash.includes(boot.body),
    `hash=${bootRow.code_hash.slice(0, 8)}… max_uses=${bootRow.max_uses}`);

  // ---------------------------------------------------------------- §1 A 注册
  section('§1 A 用 bootstrap 码注册（DB 兑换 + 建号同一事务）');
  await clearInviteLockouts();
  const aEmail = `t_${rnd()}@test.dev`;
  const aReg = await register({ name: '邀请人A', inviteCode: boot.code, email: aEmail });
  check('A 用 DB 邀请码注册成功', aReg.status === 200 && aReg.json?.me?.id > 0, `status=${aReg.status}`);
  const A = aReg.json?.me || {};
  check('A 拿到顺序 account_no（>=10000001）', Number(A.accountNo) >= 10000001, `accountNo=${A.accountNo}`);
  check('注册响应里没有明文邀请码', !aReg.text.includes(boot.body), '');
  const aQuota = await q('SELECT quota, used FROM user_invite_quotas WHERE principal_id=$1', [A.id]);
  check('A 默认 3 个名额（used=0）', aQuota[0]?.quota === 3 && aQuota[0]?.used === 0,
    `quota=${aQuota[0]?.quota} used=${aQuota[0]?.used}`);
  const bootAfter = (await q('SELECT used_count FROM invite_codes WHERE id=$1', [boot.id]))[0];
  check('bootstrap 码 used_count +1', Number(bootAfter.used_count) === 1, `used_count=${bootAfter.used_count}`);
  const aRed = await q(
    `SELECT inviter_id, email_hash, ip_hash FROM invite_redemptions WHERE principal_id=$1`, [A.id],
  );
  check('A 有兑换记录：inviter 为空（站务码）、邮箱/IP 只存 hash',
    aRed.length === 1 && aRed[0].inviter_id === null
    && /^[0-9a-f]{64}$/.test(aRed[0].email_hash || '') && /^[0-9a-f]{64}$/.test(aRed[0].ip_hash || '')
    && !String(aRed[0].email_hash).includes(aEmail),
    `rows=${aRed.length}`);

  const mine0 = await api('/api/invites/mine', { cookie: aReg.cookie });
  check('GET /api/invites/mine → quota/used/remaining 3/0/3',
    mine0.status === 200 && mine0.json?.quota === 3 && mine0.json?.used === 0 && mine0.json?.remaining === 3,
    `status=${mine0.status} ${JSON.stringify({ quota: mine0.json?.quota, used: mine0.json?.used })}`);
  check('mine：还没有有效码，invitees 为空',
    mine0.json?.active === null && Array.isArray(mine0.json?.invitees) && mine0.json.invitees.length === 0, '');
  check('mine 未登录 → 401', (await api('/api/invites/mine')).status === 401, '');

  // IP 隔离自检：§10 的闸门按出口 IP 计数，脚本靠 cf-connecting-ip 给每次注册换身份。
  // 这个头不生效（BASE 不是 loopback、或前面有别的代理）的话，整份脚本会把同一个 IP 的
  // 3 次额度瞬间用完，后面的断言会被 429 连锁污染——所以这里直接停，而不是继续跑。
  const aRedIp = aRed[0]?.ip_hash;
  const ipHonored = aRedIp === hashIp(aReg.ip);
  check('cf-connecting-ip 生效（脚本的 IP 隔离前提）', ipHonored,
    ipHonored ? `ip=${aReg.ip}` : `stored=${String(aRedIp).slice(0, 8)}… expected=${hashIp(aReg.ip).slice(0, 8)}…`);
  if (!ipHonored) {
    console.error('\n中止：clientIp 没有采用 cf-connecting-ip（BASE 不在 loopback？临时调大 INVITE_MAX_PER_IP_DAY 再跑，'
      + '或只对本地实例跑这份脚本）。继续跑只会得到一堆 429。');
    process.exit(1);
  }
  // 站务码的深度：站务直接发的号不算任何人的下家，depth=0
  const aDepth = await q('SELECT depth FROM user_invite_quotas WHERE principal_id=$1', [A.id]);
  check('站务码兑换的账号 depth=0', Number(aDepth[0]?.depth) === 0, `depth=${aDepth[0]?.depth}`);

  // ---------------------------------------------------------------- §2 创建码
  section('§2 A 创建邀请码：格式 / 默认 30 天 / 明文只出现一次 / 先吊销旧码');
  const code1 = await api('/api/invites', { method: 'POST', cookie: aReg.cookie, body: { max_uses: 3, note: '第一批' } });
  const c1 = code1.json?.invite || {};
  check('创建成功并返回明文码', code1.status === 200 && /^AIO-[2-9A-HJ-NP-Z]{4}-[2-9A-HJ-NP-Z]{4}-[2-9A-HJ-NP-Z]{4}$/.test(String(c1.code || '')),
    // 只回显前缀：明文码不许进日志/终端回放（这条脚本的输出经常被贴进交接文档）
    `status=${code1.status} code=AIO-${c1.codePrefix || '?'}-****-****`);
  check('明文与 codePrefix 一致（前缀 4 位）', String(c1.code || '').split('-').slice(1, 2)[0] === c1.codePrefix,
    `prefix=${c1.codePrefix}`);
  const ttlDays = c1.expiresAt ? Math.round((new Date(c1.expiresAt).getTime() - Date.now()) / 86400000) : -1;
  check('默认 30 天过期', ttlDays >= 29 && ttlDays <= 30, `ttl≈${ttlDays} 天`);
  check('max_uses=3、used=0', c1.maxUses === 3 && c1.usedCount === 0, '');

  const mine1 = await api('/api/invites/mine', { cookie: aReg.cookie });
  check('刷新后只剩前缀，明文不再返回', mine1.status === 200
    && mine1.json?.active?.codePrefix === c1.codePrefix
    && !mine1.text.includes(String(c1.code).slice(4).replace(/-/g, '')), `active.codePrefix=${mine1.json?.active?.codePrefix}`);
  check('mine 不含 code 明文字段', mine1.json?.active && !('code' in mine1.json.active), '');

  const code2 = await api('/api/invites', { method: 'POST', cookie: aReg.cookie, body: { max_uses: 1 } });
  const old1 = (await q('SELECT revoked_at FROM invite_codes WHERE id=$1', [c1.id]))[0];
  check('再创建会先吊销旧的有效码', code2.status === 200
    && (code2.json?.revokedPrevious || []).includes(c1.id) && old1?.revoked_at !== null,
    `revokedPrevious=${JSON.stringify(code2.json?.revokedPrevious)}`);
  const mine2 = await api('/api/invites/mine', { cookie: aReg.cookie });
  check('mine 里只剩新的有效码（同时只有 1 张）', mine2.json?.active?.id === code2.json?.invite?.id, '');

  const tooMany = await api('/api/invites', { method: 'POST', cookie: aReg.cookie, body: { max_uses: 4 } });
  check('max_uses 超过剩余名额 → 409 max_uses_exceeds_quota',
    tooMany.status === 409 && tooMany.json?.error === 'max_uses_exceeds_quota', `status=${tooMany.status}`);
  const bad0 = await api('/api/invites', { method: 'POST', cookie: aReg.cookie, body: { max_uses: 0 } });
  const bad101 = await api('/api/invites', { method: 'POST', cookie: aReg.cookie, body: { max_uses: 101 } });
  check('max_uses 0/101 → 400 invalid_max_uses',
    bad0.status === 400 && bad101.status === 400 && bad0.json?.error === 'invalid_max_uses', `${bad0.status}/${bad101.status}`);

  // 重新拿一张 3 用途的码（code2 只有 1 次，会被吊销）
  const code3 = await api('/api/invites', { method: 'POST', cookie: aReg.cookie, body: { max_uses: 3 } });
  const c3 = code3.json?.invite || {};
  check('再创建一张 3 用途码（旧 1 用途码被吊销）',
    code3.status === 200 && (code3.json?.revokedPrevious || []).includes(code2.json?.invite?.id), '');

  // 并发创建：两个请求同时点「生成邀请码」，最终只能剩 1 张有效码
  // （靠 quota 行的 SELECT ... FOR UPDATE 串行化；没有这把锁会同时留下两张）
  await clearInviteLockouts();
  const gBoot = await insertBootstrapCode({ maxUses: 1, note: 'verify-bootstrap-g' });
  const gReg = await register({ name: '并发建码G', inviteCode: gBoot.code });
  const [g1, g2] = await Promise.all([
    api('/api/invites', { method: 'POST', cookie: gReg.cookie, body: { max_uses: 3 } }),
    api('/api/invites', { method: 'POST', cookie: gReg.cookie, body: { max_uses: 3 } }),
  ]);
  const gActive = await q(
    `SELECT count(*)::int AS n FROM invite_codes
      WHERE owner_user_id = $1 AND revoked_at IS NULL AND used_count < max_uses
        AND (expires_at IS NULL OR expires_at > now())`,
    [gReg.json?.me?.id],
  );
  const gRevoked = await q(
    'SELECT count(*)::int AS n FROM invite_codes WHERE owner_user_id = $1 AND revoked_at IS NOT NULL',
    [gReg.json?.me?.id],
  );
  check('并发创建两张码后只剩 1 张有效（另一张被自动吊销）',
    g1.status === 200 && g2.status === 200 && gActive[0].n === 1 && gRevoked[0].n === 1,
    `200=${[g1.status, g2.status].join('/')} active=${gActive[0].n} revoked=${gRevoked[0].n}`);

  // ---------------------------------------------------------------- §3 兑换
  section('§3 B/C/D 用同一张多用途码兑换');
  await clearInviteLockouts();
  const bReg = await register({ name: '被邀请B', inviteCode: c3.code });
  const cReg = await register({ name: '被邀请C', inviteCode: c3.code });
  const dReg = await register({ name: '被邀请D', inviteCode: c3.code });
  check('B/C/D 三次兑换都成功',
    [bReg, cReg, dReg].every((r) => r.status === 200 && r.json?.me?.id > 0),
    `status=${[bReg, cReg, dReg].map((r) => r.status).join('/')}`);
  const bQuota = await q('SELECT quota, used, depth FROM user_invite_quotas WHERE principal_id=$1', [bReg.json?.me?.id]);
  check('被邀请人自己也拿到 3 个名额（B 例）', bQuota[0]?.quota === 3 && bQuota[0]?.used === 0,
    `quota=${bQuota[0]?.quota}`);
  check('邀请深度按链增长：A(depth0) 邀请的 B 是 depth=1', Number(bQuota[0]?.depth) === 1, `depth=${bQuota[0]?.depth}`);
  const bRed = await q('SELECT depth FROM invite_redemptions WHERE principal_id=$1', [bReg.json?.me?.id]);
  check('兑换记录也带 depth', Number(bRed[0]?.depth) === 1, `depth=${bRed[0]?.depth}`);

  const c3Row = (await q('SELECT used_count, max_uses FROM invite_codes WHERE id=$1', [c3.id]))[0];
  check('码 used_count=3/3', Number(c3Row.used_count) === 3 && Number(c3Row.max_uses) === 3,
    `${c3Row.used_count}/${c3Row.max_uses}`);
  const aQuota2 = (await q('SELECT quota, used FROM user_invite_quotas WHERE principal_id=$1', [A.id]))[0];
  check('A 的名额 used=3/3（用尽）', Number(aQuota2.used) === 3 && Number(aQuota2.quota) === 3,
    `used=${aQuota2.used}/${aQuota2.quota}`);

  const mine3 = await api('/api/invites/mine', { cookie: aReg.cookie });
  const invitees = mine3.json?.invitees || [];
  check('A 能看到 3 个被邀请人', invitees.length === 3, `n=${invitees.length}`);
  check('invitee 字段 = displayName/accountNo/joinedAt，且不含 email',
    invitees.every((i) => i.displayName && Number(i.accountNo) >= 10000001 && i.joinedAt
      && !('email' in i) && !JSON.stringify(i).includes('@')),
    JSON.stringify(invitees[0] || null));
  check('A 的 remaining=0 / defaultMaxUses=0',
    mine3.json?.remaining === 0 && mine3.json?.defaultMaxUses === 0, '');

  const bMine = await api('/api/invites/mine', { cookie: bReg.cookie });
  check('B 的 mine 只看自己的（invitees 空、quota 3）',
    bMine.json?.invitees?.length === 0 && bMine.json?.quota === 3 && bMine.json?.used === 0, '');

  const noQuota = await api('/api/invites', { method: 'POST', cookie: aReg.cookie, body: { max_uses: 1 } });
  check('名额用尽再创建 → 409 no_remaining_quota',
    noQuota.status === 409 && noQuota.json?.error === 'no_remaining_quota' && noQuota.json?.remaining === 0,
    `status=${noQuota.status}`);

  // ---------------------------------------------------------------- §4 兑换失败
  section('§4 兑换失败：统一 403 invite_required，不泄露原因');
  // 站务码（owner NULL）用于过期/吊销/并发用例：不占任何人的名额
  const fReg = await register({ name: '站务F', inviteCode: boot.code });
  await q('UPDATE principals SET is_admin = true WHERE id = $1', [fReg.json?.me?.id]);
  const fCookie = fReg.cookie;
  const meF = await api('/api/me', { cookie: fCookie });
  check('站务账号 is_admin 生效', meF.json?.isAdmin === true, `isAdmin=${meF.json?.isAdmin}`);

  const adminBatch = await api('/api/admin/invites', { method: 'POST', cookie: fCookie, body: { count: 3, max_uses: 2, note: '验证用' } });
  const adminCodes = adminBatch.json?.invites || [];
  check('站务批量建码（count=3）并拿到明文', adminBatch.status === 200 && adminCodes.length === 3
    && adminCodes.every((i) => /^AIO-/.test(i.code)), `n=${adminCodes.length}`);

  await clearInviteLockouts();
  const exhausted = await register({ name: '超标E', inviteCode: c3.code });
  check('第 4 次用已用满的码 → 403 invite_required',
    exhausted.status === 403 && exhausted.json?.error === 'invite_required', `status=${exhausted.status}`);
  check('失败响应不透露 expired/used/revoked',
    !/expired|exhausted|revoked|used_up|invalid_code/i.test(exhausted.text), exhausted.text.slice(0, 80));

  const unknown = await register({ name: '错码X', inviteCode: 'AIO-2222-3333-4444' });
  check('不存在的码 → 403', unknown.status === 403 && unknown.json?.error === 'invite_required', `status=${unknown.status}`);

  // 过期：直接把站务码的 expires_at 拨到过去
  const expireCode = adminCodes[0];
  await q("UPDATE invite_codes SET expires_at = now() - interval '1 hour' WHERE id = $1", [expireCode.id]);
  const expired = await register({ name: '过期Y', inviteCode: expireCode.code });
  check('过期码 → 403（与无效码同一个响应）',
    expired.status === 403 && expired.json?.error === 'invite_required' && expired.text === exhausted.text,
    `status=${expired.status}`);

  // 吊销：站务接口吊销另一张
  const revokeAdmin = await api(`/api/admin/invites/${adminCodes[1].id}/revoke`, { method: 'POST', cookie: fCookie });
  const revokedReg = await register({ name: '吊销Z', inviteCode: adminCodes[1].code });
  check('已吊销码 → 403', revokeAdmin.status === 200 && revokedReg.status === 403
    && revokedReg.json?.error === 'invite_required', `status=${revokedReg.status}`);

  // 邀请人名额满：把过期用例那张码恢复成有效，再让 A 的额度已满也没关系——
  // 这里用「B 把自己的额度耗光后，别人再兑换 B 的码」来覆盖 quota 分支。
  await clearInviteLockouts();
  const bCode = await api('/api/invites', { method: 'POST', cookie: bReg.cookie, body: { max_uses: 3 } });
  const bCodeVal = bCode.json?.invite || {};
  const bInvitees = [];
  for (let i = 0; i < 3; i += 1) {
    bInvitees.push(await register({ name: `B客${i}`, inviteCode: bCodeVal.code }));
  }
  check('B 的 3 个名额可用（3 人兑换成功）', bInvitees.every((r) => r.status === 200),
    `status=${bInvitees.map((r) => r.status).join('/')}`);
  // B 额度已满，但 B 那张码本身也刚好用满；再造一张需要名额 → 409。真正的「码还有剩余但邀请人名额满」
  // 只能手工构造：把 B 的 quota 改成已用满且码还有剩余次数。
  const bCodeRow = await q('SELECT id FROM invite_codes WHERE owner_user_id=$1 ORDER BY id DESC LIMIT 1', [bReg.json.me.id]);
  await q("UPDATE invite_codes SET max_uses = 10 WHERE id = $1", [bCodeRow[0].id]);
  await q("UPDATE invite_codes SET used_count = 0 WHERE id = $1", [bCodeRow[0].id]);
  const quotaHit = await register({ name: '名额满Q', inviteCode: bCodeVal.code });
  check('邀请人名额已满时兑换 → 403（内部 reason=quota）',
    quotaHit.status === 403 && quotaHit.json?.error === 'invite_required', `status=${quotaHit.status}`);

  // ---------------------------------------------------------------- §5 站务接口
  section('§5 站务接口权限与站务码');
  const notAdmin = await api('/api/admin/invites', { method: 'POST', cookie: aReg.cookie, body: { count: 1, max_uses: 1 } });
  check('非站务创建站务码 → 403', notAdmin.status === 403 && notAdmin.json?.error === 'forbidden', `status=${notAdmin.status}`);
  const notAdminList = await api('/api/admin/invites', { cookie: aReg.cookie });
  check('非站务列站务码 → 403', notAdminList.status === 403, `status=${notAdminList.status}`);
  const noAuth = await api('/api/admin/invites');
  check('未登录访问站务邀请接口 → 401', noAuth.status === 401, `status=${noAuth.status}`);

  const adminListRes = await api('/api/admin/invites?limit=20', { cookie: fCookie });
  const listed = (adminListRes.json?.invites || []).find((i) => i.id === adminCodes[2].id);
  check('站务列表能看到刚建的码（只有前缀、无明文）',
    adminListRes.status === 200 && listed && listed.codePrefix === adminCodes[2].codePrefix
    && !adminListRes.text.includes(adminCodes[2].code.slice(4).replace(/-/g, '')), `status=${adminListRes.status}`);
  check('站务列表不带 owner（owner_user_id NULL）', listed?.owner === null, '');
  const listedUserCode = (adminListRes.json?.invites || []).find((i) => i.owner?.id === A.id);
  check('站务能看到用户码的归属人（displayName/accountNo）',
    Boolean(listedUserCode) && Number(listedUserCode.owner.accountNo) >= 10000001, '');

  const bRevokeA = await api(`/api/invites/${c3.id}/revoke`, { method: 'POST', cookie: bReg.cookie });
  check('B 吊销 A 的码 → 404（不泄露存在性）', bRevokeA.status === 404 && bRevokeA.json?.error === 'not_found', `status=${bRevokeA.status}`);
  const aRevokeOwn = await api(`/api/invites/${code3.json.invite.id}/revoke`, { method: 'POST', cookie: aReg.cookie });
  check('A 吊销自己的码 → 200', aRevokeOwn.status === 200 && aRevokeOwn.json?.ok === true, `status=${aRevokeOwn.status}`);
  const aRevokeAgain = await api(`/api/invites/${code3.json.invite.id}/revoke`, { method: 'POST', cookie: aReg.cookie });
  check('重复吊销 → 404', aRevokeAgain.status === 404, `status=${aRevokeAgain.status}`);
  const revokedAgainReg = await register({ name: '重放R', inviteCode: c3.code });
  check('吊销后的码不能再兑换 → 403', revokedAgainReg.status === 403, `status=${revokedAgainReg.status}`);

  // ---------------------------------------------------------------- §6 并发
  section('§6 并发兑换同一张 max_uses=1 的码');
  await clearInviteLockouts();
  const race = await api('/api/admin/invites', { method: 'POST', cookie: fCookie, body: { count: 1, max_uses: 1, note: '并发' } });
  const raceCode = race.json?.invites?.[0]?.code;
  const raceResults = await Promise.all(
    Array.from({ length: 4 }, (_, i) => register({ name: `并发${i}`, inviteCode: raceCode })),
  );
  const wins = raceResults.filter((r) => r.status === 200).length;
  const loses = raceResults.filter((r) => r.status === 403 && r.json?.error === 'invite_required').length;
  check('4 个并发兑换只有 1 个成功', wins === 1 && loses === 3,
    `200=${wins} 403=${loses} 其他=${raceResults.map((r) => r.status).filter((s) => s !== 200 && s !== 403).join(',') || '无'}`);
  const raceRow = (await q('SELECT used_count FROM invite_codes WHERE id=$1', [race.json.invites[0].id]))[0];
  check('并发后 used_count 恰好 =1（没有穿透）', Number(raceRow.used_count) === 1, `used_count=${raceRow.used_count}`);
  const raceRed = await q('SELECT count(*)::int AS n FROM invite_redemptions WHERE code_id=$1', [race.json.invites[0].id]);
  check('并发后兑换记录恰好 1 行', raceRed[0].n === 1, `n=${raceRed[0].n}`);
  const raceUsers = await q(
    `SELECT count(*)::int AS n FROM principals WHERE id = ANY($1::bigint[])`,
    [[...raceResults.filter((r) => r.status === 200).map((r) => r.json.me.id), A.id]],
  );
  check('并发里成功的那个人真的建好了账号', raceUsers[0].n >= 1, `n=${raceUsers[0].n}`);

  // 同邮箱并发注册：一张码成功、另一张必须整体回滚（不能「人没建成但名额被扣」）
  // 邮箱唯一索引 + 同事务内兑换是这条不变量的两个前提，缺一个就会白烧名额。
  await clearInviteLockouts();
  const dupA = await insertBootstrapCode({ maxUses: 1, note: 'dup-race-1' });
  const dupB = await insertBootstrapCode({ maxUses: 1, note: 'dup-race-2' });
  const sameEmail = `t_${rnd()}@test.dev`;
  const dupRes = await Promise.all([
    register({ name: '同邮箱1', inviteCode: dupA.code, email: sameEmail }),
    register({ name: '同邮箱2', inviteCode: dupB.code, email: sameEmail }),
  ]);
  const dupOk = dupRes.filter((r) => r.status === 200).length;
  const dupConflict = dupRes.filter((r) => r.status === 409).length;
  const dupUsed = await q(
    'SELECT coalesce(sum(used_count),0)::int AS n FROM invite_codes WHERE id = ANY($1::bigint[])',
    [[dupA.id, dupB.id]],
  );
  check('同邮箱并发注册：1 成功 + 1 冲突，落败方的码没有被白扣',
    dupOk === 1 && dupConflict === 1 && Number(dupUsed[0].n) === 1,
    `200=${dupOk} 409=${dupConflict} 两张码 used 合计=${dupUsed[0].n}`);

  // ---------------------------------------------------------------- §8 DB 完整性
  section('§8 DB 完整性：无明文码 / 审计 / 只读');
  const plaintexts = [boot.code, c1.code, code2.json?.invite?.code, c3.code, ...adminCodes.map((i) => i.code), raceCode]
    .filter(Boolean);
  let leaked = 0;
  for (const code of plaintexts) {
    const body = code.replace(/-/g, '').replace(/^AIO/, '');
    const rows = await q(
      `SELECT
         (SELECT count(*) FROM invite_codes
            WHERE code_hash = $1 OR code_hash LIKE '%'||$1||'%' OR code_prefix = $1) +
         (SELECT count(*) FROM invite_audit WHERE meta::text ILIKE '%'||$1||'%') +
         (SELECT count(*) FROM invite_redemptions
            WHERE coalesce(email_hash,'') LIKE '%'||$1||'%' OR coalesce(ip_hash,'') LIKE '%'||$1||'%') AS n`,
      [body],
    );
    leaked += Number(rows[0].n);
  }
  check('库里查不到任何明文码（codes/audit/redemptions）', leaked === 0, `命中 ${leaked} 处`);

  const auditActions = await q(
    `SELECT action, count(*)::int AS n FROM invite_audit GROUP BY action ORDER BY action`,
  );
  const actionMap = Object.fromEntries(auditActions.map((r) => [r.action, r.n]));
  check('审计行覆盖 create/redeem/revoke/admin_create/admin_revoke',
    ['create', 'redeem', 'revoke', 'admin_create', 'admin_revoke'].every((a) => (actionMap[a] || 0) > 0),
    JSON.stringify(actionMap));
  const auditPlain = await q(
    `SELECT count(*)::int AS n FROM invite_audit WHERE meta::text ~* '(AIO-[2-9A-HJ-NP-Z]{4}-)'`,
  );
  check('审计 meta 里没有明文码', auditPlain[0].n === 0, `n=${auditPlain[0].n}`);

  let appendOnlyOk = false;
  try {
    await admin.query('BEGIN');
    await admin.query("UPDATE invite_audit SET action = action WHERE id = (SELECT id FROM invite_audit ORDER BY id DESC LIMIT 1)");
    await admin.query('ROLLBACK');
  } catch (err) {
    appendOnlyOk = /append-only/.test(String(err.message));
    try { await admin.query('ROLLBACK'); } catch { /* ignore */ }
  }
  check('invite_audit 是 append-only（UPDATE 被触发器拒绝）', appendOnlyOk, '');

  const writerRole = await q("SELECT rolname FROM pg_roles WHERE rolname='mcp_writer'");
  if (writerRole.length) {
    const priv = await q(
      `SELECT has_table_privilege('mcp_writer','invite_codes','SELECT') AS s,
              has_table_privilege('mcp_writer','invite_codes','INSERT') AS i,
              has_table_privilege('mcp_writer','user_invite_quotas','SELECT') AS q`,
    );
    check('mcp_writer 对邀请表零权限', priv[0].s === false && priv[0].i === false && priv[0].q === false,
      JSON.stringify(priv[0]));
  } else {
    // 本机 devstack 没有这个角色（应用用 postgres 超级用户跑），权限收敛由迁移里的 REVOKE 保证
    check('mcp_writer 对邀请表零权限（本机无该角色，迁移内含 REVOKE）', true, 'SKIP：角色不存在');
  }

  // ---------------------------------------------------------------- §9 env 兼容
  section('§9 env REGISTER_CODE 兼容 / INVITE_MODE=db');
  if (ENV_CODE) {
    await clearInviteLockouts();
    const envReg = await register({ name: 'env老路径', inviteCode: ENV_CODE });
    const noCodeReg = await register({ name: 'env空码' });
    if (EXPECT_ENV_IGNORED) {
      check('INVITE_MODE=db：env REGISTER_CODE 被忽略 → 403',
        envReg.status === 403 && envReg.json?.error === 'invite_required', `status=${envReg.status}`);
      check('INVITE_MODE=db：不带任何码 → 403（不会退回开放注册）', noCodeReg.status === 403, `status=${noCodeReg.status}`);
      const dbReg = await register({ name: 'db模式码', inviteCode: (await insertBootstrapCode({ maxUses: 1 })).code });
      check('INVITE_MODE=db：DB 码照常可用', dbReg.status === 200, `status=${dbReg.status}`);
    } else {
      check('旧 REGISTER_CODE 路径仍可用（无 DB 码也能注册）', envReg.status === 200 && envReg.json?.me?.id > 0,
        `status=${envReg.status}`);
      check('env 模式下不带码 → 403', noCodeReg.status === 403 && noCodeReg.json?.error === 'invite_required',
        `status=${noCodeReg.status}`);
      const wrong = await register({ name: 'env错码', inviteCode: 'not-the-env-code' });
      check('env 模式下错码 → 403', wrong.status === 403, `status=${wrong.status}`);
      const dbWins = await register({ name: 'db优先', inviteCode: (await insertBootstrapCode({ maxUses: 1 })).code });
      check('env 模式下 DB 码优先生效', dbWins.status === 200, `status=${dbWins.status}`);
    }
  } else if (!EXPECT_ENV_IGNORED) {
    await clearInviteLockouts();
    const openReg = await register({ name: '开放注册' });
    check('未配 REGISTER_CODE + 未配 INVITE_MODE：开放注册仍可用', openReg.status === 200, `status=${openReg.status}`);
    const garbage = await register({ name: '乱码', inviteCode: 'AIO-2222-3333-4444' });
    check('开放注册下塞无效码不能被静默接受 → 403', garbage.status === 403, `status=${garbage.status}`);
  } else {
    check('INVITE_MODE=db：不带码 → 403', (await register({ name: 'db无码' })).status === 403, '');
  }

  // ---------------------------------------------------------------- §7 失败计数
  section('§7 邀请码失败计数（5 次锁 15 分钟）');
  await clearInviteLockouts();
  // 失败计数按 IP 记，所以这 6 次必须共用同一个（假）出口 IP，否则永远不会触发锁定
  const lockIp = `198.51.100.${crypto.randomInt(1, 250)}`;
  const codes = [];
  for (let i = 0; i < 5; i += 1) {
    const r = await register({ name: `锁${i}`, inviteCode: 'AIO-2222-3333-4444', ip: lockIp });
    codes.push(r.status);
  }
  const locked = await register({ name: '锁定后', inviteCode: 'AIO-2222-3333-4444', ip: lockIp });
  check('连续 5 次错码后第 6 次 → 429（与登录同一套 isLockedOut）',
    codes.filter((s) => s === 403).length === 5 && locked.status === 429,
    `前 5 次=${codes.join('/')} 第 6 次=${locked.status}`);
  await clearInviteLockouts();

  // ---------------------------------------------------------------- §10 IP 频率闸
  section('§10 同一出口 IP 24 小时成功兑换上限');
  await clearInviteLockouts();
  const sharedIp = `203.0.113.${crypto.randomInt(1, 250)}`;
  // 码的可用次数必须从 IP 闸上限推导：写死 6/4 这类常量时，
  // 一旦 INVITE_MAX_PER_IP_DAY 上调（2026-11-19: 3→8）就会先被「码用满」挡成 403，
  // 看起来像 IP 闸失效，其实是被测对象的另一个闸在起作用。
  const ipCode = await insertBootstrapCode({ maxUses: MAX_PER_IP_DAY + 2, note: 'ip-gate' });
  const ipRegs = [];
  for (let i = 0; i < MAX_PER_IP_DAY; i += 1) {
    ipRegs.push(await register({ name: `同IP${i}`, inviteCode: ipCode.code, ip: sharedIp }));
  }
  check(`同一 IP 前 ${MAX_PER_IP_DAY} 次兑换都成功`,
    ipRegs.every((r) => r.status === 200), `status=${ipRegs.map((r) => r.status).join('/')}`);
  const overIp = await register({ name: '同IP超限', inviteCode: ipCode.code, ip: sharedIp });
  check(`同一 IP 第 ${MAX_PER_IP_DAY + 1} 次兑换 → 429 too_many`,
    overIp.status === 429 && overIp.json?.error === 'too_many', `status=${overIp.status}`);
  const ipCodeRow = (await q('SELECT used_count FROM invite_codes WHERE id=$1', [ipCode.id]))[0];
  check('被 IP 闸拒掉的那次没有消耗码', Number(ipCodeRow.used_count) === MAX_PER_IP_DAY,
    `used_count=${ipCodeRow.used_count}`);
  const overIpRed = await q(
    'SELECT count(*)::int AS n FROM invite_redemptions WHERE ip_hash=$1', [hashIp(sharedIp)],
  );
  check('被 IP 闸拒掉的那次没有落兑换记录', overIpRed[0].n === MAX_PER_IP_DAY, `n=${overIpRed[0].n}`);
  const otherIp = await register({ name: '换IP', inviteCode: ipCode.code });
  check('换一个出口 IP 立刻可用（闸门按 IP 而不是按码）', otherIp.status === 200, `status=${otherIp.status}`);

  // 并发：额度只剩 1 个时，同一 IP 两个请求同时兑换，只能成一个（advisory lock 的意义）
  const raceIp = `203.0.113.${crypto.randomInt(1, 250)}`;
  const raceCode2 = await insertBootstrapCode({ maxUses: MAX_PER_IP_DAY + 1, note: 'ip-race' });
  const warm = [];
  for (let i = 0; i < MAX_PER_IP_DAY - 1; i += 1) {
    warm.push(await register({ name: `预热${i}`, inviteCode: raceCode2.code, ip: raceIp }));
  }
  const racePair = await Promise.all([
    register({ name: '闸并发1', inviteCode: raceCode2.code, ip: raceIp }),
    register({ name: '闸并发2', inviteCode: raceCode2.code, ip: raceIp }),
  ]);
  const raceWins = racePair.filter((r) => r.status === 200).length;
  const raceLoses = racePair.filter((r) => r.status === 429).length;
  const raceIpCount = await q('SELECT count(*)::int AS n FROM invite_redemptions WHERE ip_hash=$1', [hashIp(raceIp)]);
  check('并发兑换时 IP 闸不会被穿透（只剩 1 个额度 → 恰好 1 成功 1 被拒）',
    warm.every((r) => r.status === 200) && raceWins === 1 && raceLoses === 1
    && raceIpCount[0].n === MAX_PER_IP_DAY,
    `warm=${warm.map((r) => r.status).join('/')} race=${racePair.map((r) => r.status).join('/')} rows=${raceIpCount[0].n}`);

  // ---------------------------------------------------------------- §11 邀请深度闸
  section('§11 邀请深度上限（INVITE_MAX_DEPTH）');
  await clearInviteLockouts();
  // 直接造一个 depth 已经被推到上限前一层的账号：比真的链式邀请 9 个人便宜得多，
  // 而且能把「恰好等于上限」与「超过上限」两条边界都压到同一次会话里。
  const deepBoot = await insertBootstrapCode({ maxUses: 1, note: 'depth-base' });
  const deepReg = await register({ name: '深度基座', inviteCode: deepBoot.code });
  const deepId = deepReg.json?.me?.id;
  await q('UPDATE user_invite_quotas SET depth = $2 WHERE principal_id = $1', [deepId, MAX_DEPTH - 1]);
  const deepCode = await api('/api/invites', { method: 'POST', cookie: deepReg.cookie, body: { max_uses: 1 } });
  const okChild = await register({ name: '深度内', inviteCode: deepCode.json?.invite?.code });
  const okChildDepth = await q('SELECT depth FROM user_invite_quotas WHERE principal_id=$1', [okChild.json?.me?.id]);
  check(`邀请深度恰好到上限（${MAX_DEPTH}）允许，且新账号 depth=${MAX_DEPTH}`,
    okChild.status === 200 && Number(okChildDepth[0]?.depth) === MAX_DEPTH,
    `status=${okChild.status} depth=${okChildDepth[0]?.depth}`);

  const atMaxId = okChild.json?.me?.id;
  const atMaxCode = await api('/api/invites', { method: 'POST', cookie: okChild.cookie, body: { max_uses: 1 } });
  const beforeUsed = await q('SELECT used FROM user_invite_quotas WHERE principal_id=$1', [atMaxId]);
  const tooDeep = await register({ name: '深度外', inviteCode: atMaxCode.json?.invite?.code });
  check(`depth=${MAX_DEPTH} 的账号再往下邀请 → 403 invite_required`,
    tooDeep.status === 403 && tooDeep.json?.error === 'invite_required', `status=${tooDeep.status}`);
  const afterUsed = await q('SELECT used FROM user_invite_quotas WHERE principal_id=$1', [atMaxId]);
  const atMaxCodeRow = (await q('SELECT used_count FROM invite_codes WHERE id=$1', [atMaxCode.json?.invite?.id]))[0];
  check('深度闸拒绝时：不扣名额、不扣码',
    Number(afterUsed[0]?.used) === Number(beforeUsed[0]?.used) && Number(atMaxCodeRow.used_count) === 0,
    `used=${beforeUsed[0]?.used}→${afterUsed[0]?.used} code_used=${atMaxCodeRow.used_count}`);

  // ---------------------------------------------------------------- §12 邮箱枚举
  section('§12 注册邮箱枚举：验码之前不泄露邮箱是否存在');
  await clearInviteLockouts();
  // 无效码 + 已存在邮箱 → 必须是 403（旧实现在验码之前查邮箱，会回 409，等于无码也能枚举）
  const enumBad = await register({ name: '枚举无效码', inviteCode: 'AIO-2222-3333-4444', email: aEmail });
  check('无效码 + 已存在邮箱 → 403（不是 409）',
    enumBad.status === 403 && enumBad.json?.error === 'invite_required', `status=${enumBad.status}`);
  // 有效码 + 已存在邮箱 → 409，且码/邀请人名额都不被消耗（用**用户码**才能同时验证名额）
  const enumInvBoot = await insertBootstrapCode({ maxUses: 1, note: 'email-enum-inviter' });
  const enumInviter = await register({ name: '枚举邀请人', inviteCode: enumInvBoot.code });
  const enumInviterId = enumInviter.json?.me?.id;
  const enumInvCode = await api('/api/invites', { method: 'POST', cookie: enumInviter.cookie, body: { max_uses: 2 } });
  const enumCodeId = enumInvCode.json?.invite?.id;
  const enumUsedBefore = (await q('SELECT used_count FROM invite_codes WHERE id=$1', [enumCodeId]))[0].used_count;
  const inviterUsedBefore = (await q('SELECT used FROM user_invite_quotas WHERE principal_id=$1', [enumInviterId]))[0].used;
  const enumGood = await register({ name: '枚举有效码', inviteCode: enumInvCode.json?.invite?.code, email: aEmail });
  const enumUsedAfter = (await q('SELECT used_count FROM invite_codes WHERE id=$1', [enumCodeId]))[0].used_count;
  const inviterUsedAfter = (await q('SELECT used FROM user_invite_quotas WHERE principal_id=$1', [enumInviterId]))[0].used;
  check('有效码 + 已存在邮箱 → 409 email_taken',
    enumGood.status === 409 && enumGood.json?.error === 'email_taken', `status=${enumGood.status}`);
  check('409 之后码的 used_count 不变（整事务回滚）',
    Number(enumUsedAfter) === Number(enumUsedBefore), `${enumUsedBefore} → ${enumUsedAfter}`);
  check('409 之后邀请人的名额 used 不变（不白扣额度）',
    Number(inviterUsedAfter) === Number(inviterUsedBefore), `${inviterUsedBefore} → ${inviterUsedAfter}`);
  const enumRed = await q(
    'SELECT count(*)::int AS n FROM invite_redemptions WHERE code_id=$1', [enumCodeId],
  );
  check('409 之后没有落兑换记录', enumRed[0].n === 0, `n=${enumRed[0].n}`);
  // 同一张码换个新邮箱仍然可用（证明 409 只是回滚，不是把码废了/名额扣了）
  const enumFresh = await register({ name: '枚举新邮箱', inviteCode: enumInvCode.json?.invite?.code });
  const inviterUsedFinal = (await q('SELECT used FROM user_invite_quotas WHERE principal_id=$1', [enumInviterId]))[0].used;
  check('同一张码换新邮箱仍可注册（409 只是回滚）', enumFresh.status === 200, `status=${enumFresh.status}`);
  check('成功的那次才扣 1 个名额（used=1）', Number(inviterUsedFinal) === 1, `used=${inviterUsedFinal}`);

  // ---------------------------------------------------------------- 汇总
  const failed = results.filter((r) => !r.ok);
  console.log(`\n${failed.length === 0 ? '全部通过' : '有失败'}：${results.length - failed.length}/${results.length}`);
  if (failed.length) {
    console.log('失败项：');
    for (const f of failed) console.log(`  - [${f.section}] ${f.name}`);
    process.exitCode = 1;
  }
}

try {
  await main();
} catch (err) {
  console.error('验证异常：', err.message);
  process.exitCode = 1;
} finally {
  await admin.end().catch(() => {});
  await pool.end().catch(() => {});
}
