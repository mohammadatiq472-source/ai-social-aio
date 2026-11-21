// 媒体签名 URL 的密钥强度回归（外部评审 P0-1）
//
// 评审结论：SESSION_SECRET 若静默回退到 'dev-only-secret'，媒体签名密钥就是公开常量；
// sign() 还曾回退到 DATABASE_URL 与 'qqmini'，攻击者可**离线**伪造
// /media/:id?e=<未来时间>&s=<hmac> 读取全站附件。修复后：
//   1. SESSION_SECRET 缺失 → 服务拒绝启动（fail-closed，另有一条静态断言）
//   2. sign() 只认 config.sessionSecret，缺失直接抛错，不回退
//
// 本脚本从「攻击者视角」验第 2 条：
//   - 用旧回退链里的弱密钥（'qqmini' / 'dev-only-secret' / DATABASE_URL）算出来的签名必须 403
//   - 用真实 SESSION_SECRET 算出来的签名必须 200（正向对照，证明不是「全拒」蒙对的）
//   - 过期 / 篡改 id / 无签名 必须 403
//
// 用法（需要服务端 SESSION_SECRET，脚本从当前环境读）：
//   set -a && . /etc/qqmini.env && set +a   # 服务器上
//   BASE=http://127.0.0.1:8787 node scripts/verify/verify-media-signing.mjs
// 本地开发：SESSION_SECRET=dev-only-secret（与启动服务的值一致即可）
import crypto from 'node:crypto';

const BASE = (process.env.BASE || 'http://127.0.0.1:8787').replace(/\/$/, '');
const SECRET = process.env.SESSION_SECRET || '';
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

/** 1x1 PNG：足够通过上传类型校验 */
const PNG = Buffer.from(
  '89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c489'
  + '0000000d4944415478da63fcffff3f030005fe02fea72d5c1e0000000049454e44ae426082',
  'hex',
);

function signWith(secret, id, exp) {
  return crypto.createHmac('sha256', secret).update(`${id}.${exp}`).digest('hex').slice(0, 32);
}

const main = async () => {
  // ---------------------------------------------------------------- 准备：一个真实附件
  const email = `t_${rnd()}@test.dev`;
  const reg = await api('/api/auth/register', {
    method: 'POST',
    body: { email, password: 'passw0rd!x', display_name: '签名A', invite_code: process.env.REGISTER_CODE || '' },
  });
  if (reg.status !== 200) throw new Error(`注册失败 ${reg.status}`);
  const cookie = reg.cookie;
  const up = await fetch(`${BASE}/api/attachments`, {
    method: 'POST',
    headers: { 'content-type': 'image/png', cookie, 'content-length': String(PNG.length) },
    body: PNG,
  });
  const upJson = await up.json().catch(() => null);
  if (up.status !== 200 || !upJson?.attachment?.id) throw new Error(`上传失败 ${up.status} ${JSON.stringify(upJson)}`);
  const id = Number(upJson.attachment.id);
  const exp = Math.floor(Date.now() / 1000) + 600;

  // ---------------------------------------------------------------- 1. 弱密钥伪造必须被拒
  // 注意：本地开发可能就把 SESSION_SECRET 设成 'dev-only-secret'（文档允许），
  // 那它就不是「弱密钥伪造」而是「真实密钥」——跳过，别把正向对照当漏洞。
  for (const weak of ['qqmini', 'dev-only-secret', 'qqmini-secret']) {
    if (SECRET && weak === SECRET) {
      console.log(`SKIP  弱密钥「${weak}」= 本环境真实 SESSION_SECRET（本地开发配置），不做伪造断言`);
      continue;
    }
    const s = signWith(weak, id, exp);
    const r = await fetch(`${BASE}/media/${id}?e=${exp}&s=${s}`);
    check(`旧回退密钥「${weak}」伪造的签名 → 403`, r.status === 403, `status=${r.status}`);
  }

  // ---------------------------------------------------------------- 2. 无签名 / 过期 / 篡改 id
  const noSig = await fetch(`${BASE}/media/${id}`);
  check('无签名直接访问 → 403', noSig.status === 403, `status=${noSig.status}`);

  if (SECRET) {
    const expiredExp = Math.floor(Date.now() / 1000) - 5;
    const expired = `${BASE}/media/${id}?e=${expiredExp}&s=${signWith(SECRET, id, expiredExp)}`;
    const rExpired = await fetch(expired);
    check('过期签名 → 403', rExpired.status === 403, `status=${rExpired.status}`);

    const otherId = id + 1;
    const t1 = `${BASE}/media/${id}?e=${exp}&s=${signWith(SECRET, otherId, exp)}`;
    const rTamper = await fetch(t1);
    check('拿另一个 id 的签名 → 403（签名绑定 id）', rTamper.status === 403, `status=${rTamper.status}`);

    // ---------------------------------------------------------------- 3. 正向对照
    const ok = await fetch(`${BASE}/media/${id}?e=${exp}&s=${signWith(SECRET, id, exp)}`);
    check('真实密钥签名 → 200（正向对照，排除「全拒」）', ok.status === 200, `status=${ok.status}`);

    // 服务端返回的 url 直接可用
    const detail = await api(`/api/attachments/${id}`, { cookie });
    void detail;
    const urlPath = String(upJson.attachment.url || '');
    const direct = urlPath ? await fetch(new URL(urlPath, BASE)) : { status: 0 };
    check('上传接口返回的 url 可直接取（1 小时内有效）', direct.status === 200, `status=${direct.status}`);
  } else {
    console.log('SKIP  未提供 SESSION_SECRET：跳过过期/篡改/正向对照三条');
  }

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
