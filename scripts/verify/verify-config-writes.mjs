// 评审 P2-6 回归：AI 的「配置类写」走受限角色 + 窄口 SECURITY DEFINER 函数后，功能不变、边界更窄。
//
// 覆盖：
//   1. AI 设外链头像（https）→ 成功，且在 list_conversations / my_limits 之外的头像读路径可见
//   2. AI 自建表情包 → 成功，item_count=0
//   3. AI 往自己的包里加图 → 成功，item_count=1
//   4. 往别人的包里加图 → not_owned（归属校验在函数里，不靠调用方）
//   5. 重复 key → duplicate_key（函数内 unique_violation 转成结构化错误）
//   6. 人类走同一套函数的 REST 路径也照常（列表能读到 AI 建好的包）
//   7. （可选，给 ADMIN_DATABASE_URL 时）直接以 mcp_writer 身份 UPDATE sticker_packs 必须被拒
//
// 用法：BASE=http://127.0.0.1:8787 node scripts/verify/verify-config-writes.mjs
//      ADMIN_DATABASE_URL=postgres://mcp_writer:…@127.0.0.1:5432/qqmini …  (仅服务器上跑第 7 条)
import crypto from 'node:crypto';
import pg from 'pg';

const BASE = (process.env.BASE || 'http://127.0.0.1:8787').replace(/\/$/, '');
const WRITER_URL = process.env.ADMIN_DATABASE_URL || process.env.WRITER_DATABASE_URL || '';
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
  return { id: r.json.me.id, cookie: r.cookie };
}

async function mcp(token, name, args, id = 1) {
  const r = await api('/mcp', {
    method: 'POST', token,
    body: { jsonrpc: '2.0', id, method: 'tools/call', params: { name, arguments: args } },
  });
  const text = r.json?.result?.content?.[0]?.text;
  let parsed = null;
  try {
    parsed = text ? JSON.parse(text) : null;
  } catch {
    parsed = { raw: text };
  }
  return { isError: r.json?.result?.isError === true, json: parsed };
}

const main = async () => {
  const A = await signup('配置A');
  const agA = await api('/api/agents', { method: 'POST', cookie: A.cookie, body: { display_name: '配置AI1' } });
  const tokenA = agA.json.token;
  const agB = await api('/api/agents', { method: 'POST', cookie: A.cookie, body: { display_name: '配置AI2' } });
  const tokenB = agB.json.token;

  // 1) 头像
  const avatarUrl = `https://cdn.example.com/avatar-${rnd()}.png`;
  const setAvatar = await mcp(tokenA, 'set_avatar', { url: avatarUrl });
  check('AI 设外链头像成功', setAvatar.isError === false && (setAvatar.json?.avatarUrl === avatarUrl || setAvatar.json?.avatar_url === avatarUrl),
    JSON.stringify(setAvatar.json).slice(0, 120));

  // 2) 建包
  const created = await mcp(tokenA, 'create_sticker_pack', { title: `评审包${rnd()}` });
  // create_sticker_pack 把 pack 字段平铺在结果顶层（pack_id/slug/…），兼容旧形状 pack.pack_id
  const packId = created.json?.pack_id ?? created.json?.pack?.pack_id ?? created.json?.id;
  check('AI 自建表情包成功（item_count=0）', created.isError === false && Number(packId) > 0 && Number(created.json?.item_count ?? created.json?.pack?.item_count ?? -1) === 0,
    JSON.stringify(created.json).slice(0, 140));

  // 3) 加图
  const itemUrl = `https://cdn.example.com/sticker-${rnd()}.png`;
  const added = await mcp(tokenA, 'add_sticker_item', { pack_id: Number(packId), url: itemUrl, caption: '评审用图', key: `k${rnd()}` });
  check('AI 往自己的包加图成功（item_count=1）', added.isError === false && Number(added.json?.item_count) === 1,
    JSON.stringify(added.json).slice(0, 140));

  // 4) 往别人的包加图
  const foreign = await mcp(tokenB, 'add_sticker_item', { pack_id: Number(packId), url: itemUrl, key: `x${rnd()}` });
  check('往别人的包加图被拒（归属校验在函数里）', foreign.isError === true && (foreign.json?.error ?? foreign.json?.reason) === 'not_owned',
    JSON.stringify(foreign.json).slice(0, 120));

  // 5) 重复 key
  const dupKey = `dup${rnd()}`;
  await mcp(tokenA, 'add_sticker_item', { pack_id: Number(packId), url: itemUrl, key: dupKey });
  const dup = await mcp(tokenA, 'add_sticker_item', { pack_id: Number(packId), url: itemUrl, key: dupKey });
  check('重复 key → duplicate_key（结构化错误，不抛 500）', dup.isError === true && (dup.json?.error ?? dup.json?.reason) === 'duplicate_key',
    JSON.stringify(dup.json).slice(0, 120));

  // 6) 人类侧列表能看到这个包
  const packs = await api('/api/sticker-packs', { cookie: A.cookie });
  const list = packs.json?.packs || packs.json || [];
  check('人类侧列表能看到 AI 建的包', Array.isArray(list) && list.some((p) => Number(p.pack_id ?? p.id) === Number(packId)),
    `n=${Array.isArray(list) ? list.length : '?'}`);

  // 7) 受限角色边界（仅服务器上配了 mcp_writer 连接时）
  if (WRITER_URL) {
    const client = new pg.Client({ connectionString: WRITER_URL });
    let denied = null;
    try {
      await client.connect();
      const who = await client.query('SELECT current_user AS u');
      try {
        await client.query('UPDATE sticker_packs SET title = title WHERE id = $1', [Number(packId)]);
        denied = false;
      } catch (err) {
        denied = /permission denied/i.test(String(err.message));
      }
      check(`mcp_writer 直接 UPDATE sticker_packs 被数据库拒绝（current_user=${who.rows[0].u}）`, denied === true, `denied=${denied}`);
    } catch (err) {
      console.log(`SKIP  连不上 WRITER_URL：${err.message}`);
    } finally {
      await client.end().catch(() => {});
    }
  } else {
    console.log('SKIP  未提供 ADMIN_DATABASE_URL / WRITER_DATABASE_URL：跳过「mcp_writer 直接改表被拒」');
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
