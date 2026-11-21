#!/usr/bin/env node
// 3D 空间「人类入口」验证（2026-11-20）：
//   · 默认实例（没配 WORLD_PUBLIC_URL）→ /api/world/status enabled=false，前端由此隐藏「进入空间」按钮；
//   · 配了世界入口 + 票据密钥的实例 → status enabled=true；POST /api/world/ticket 返回可打开的 URL；
//   · 票据格式 = base64url(payload).hmac(base64url)：验证签名、过期时间、pid/昵称与当前用户一致；
//   · 篡改签名必须验不过（world 侧就是按这条校验的，签名错了会 401）；
//   · 「我的 AI」的世界开关：PATCH /api/agents/:id/world 双向切换，/api/agents 里 canEnterWorld 跟着变；
//   · 未登录访问 status/ticket → 401（不能匿名换票）。
//
// 为什么拆「默认实例 + 临时实例」：状态是启动时读环境变量的，不能在一个进程里同时测开/关两种形态。
// 用法：node scripts/verify/verify-world-entry.mjs
//   （需要 8787 已在跑 + DATABASE_URL；脚本自己再起一个 8797 的实例，用同一个库）

import { spawn } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

const ROOT = path.resolve('.');
const DB = process.env.DATABASE_URL || 'postgres://postgres@127.0.0.1:5434/aio';
const DEV = 'http://127.0.0.1:8787';
const TEST_PORT = 8797;
const TEST = `http://127.0.0.1:${TEST_PORT}`;
const WORLD_PUBLIC = 'https://world.aio.test';
const TICKET_SECRET = 'verify-world-ticket-secret';
const LOG = path.join(ROOT, 'tmp', 'verify-world-entry.log');

const results = [];
function check(name, ok, detail = '') {
  results.push({ name, ok: Boolean(ok) });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? '  — ' + detail : ''}`);
}
const rnd = () => Math.random().toString(36).slice(2, 8);

async function api(base, p, { method = 'GET', body, cookie } = {}) {
  const headers = {};
  if (cookie) headers.cookie = cookie;
  if (body !== undefined) headers['content-type'] = 'application/json';
  const res = await fetch(`${base}${p}`, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
  const text = await res.text();
  let json = null;
  try { json = text ? JSON.parse(text) : null; } catch { /* 非 JSON */ }
  const setCookie = res.headers.getSetCookie?.() || [];
  const sid = setCookie.map((c) => String(c).split(';')[0]).find((c) => c.startsWith('sid='));
  return { status: res.status, json, text, cookie: sid || cookie };
}

async function register(base, name) {
  const email = `t_${rnd()}${rnd()}@test.dev`;
  const r = await api(base, '/api/auth/register', {
    method: 'POST',
    body: { email, password: 'World!2026', display_name: name, invite_code: process.env.REGISTER_CODE || '' },
  });
  if (r.status !== 200) throw new Error(`注册失败 ${r.status} ${r.text.slice(0, 120)}`);
  return { cookie: r.cookie, id: Number(r.json?.me?.id), name: r.json?.me?.displayName || name };
}

function verifyTicket(ticket, secret) {
  const dot = ticket.lastIndexOf('.');
  if (dot <= 0) return { ok: false };
  const payload = ticket.slice(0, dot);
  const sig = ticket.slice(dot + 1);
  const expect = crypto.createHmac('sha256', secret).update(payload).digest('base64url');
  const sigOk = sig.length === expect.length && crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(expect));
  let data = null;
  try { data = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8')); } catch { /* ignore */ }
  return { ok: sigOk, data, payload, sig, expect };
}

async function main() {
  // ---------------------------------------------------------------- 1) 默认实例：世界关闭
  const dev = await api(DEV, '/api/world/status').catch(() => null);
  if (dev && dev.status === 401) {
    check('默认实例未登录访问 status → 401', true);
  } else {
    check('默认实例 8787 可达', Boolean(dev), '连不上：先起本地服务');
  }
  // 已登录再看一次：默认实例（没配 WORLD_PUBLIC_URL）必须 enabled=false —— 前端据此隐藏入口
  try {
    const devUser = await register(DEV, '默认实例的人');
    const devStatus = await api(DEV, '/api/world/status', { cookie: devUser.cookie });
    check('默认实例（没配 WORLD_PUBLIC_URL）enabled=false',
      devStatus.status === 200 && devStatus.json?.enabled === false, JSON.stringify(devStatus.json));
  } catch (err) {
    check('默认实例已登录 status 读取', false, err.message);
  }

  // ---------------------------------------------------------------- 2) 临时实例：世界开启
  fs.mkdirSync(path.join(ROOT, 'tmp'), { recursive: true });
  const fd = fs.openSync(LOG, 'w');
  const child = spawn(process.execPath, ['src/index.mjs'], {
    cwd: ROOT,
    env: {
      ...process.env,
      PORT: String(TEST_PORT),
      DATABASE_URL: DB,
      WRITER_DATABASE_URL: DB,
      ADMIN_DATABASE_URL: DB,
      SESSION_SECRET: 'verify-world-entry-session',
      SECURE_COOKIE: 'false',
      SIGNUP_MODE: 'open',
      WORLD_PUBLIC_URL: WORLD_PUBLIC,
      WORLD_TICKET_SECRET: TICKET_SECRET,
    },
    stdio: ['ignore', fd, fd],
  });
  const stop = () => { try { child.kill(); } catch { /* ignore */ } };
  try {
    let up = false;
    for (let i = 0; i < 60; i += 1) {
      try {
        const r = await fetch(`${TEST}/healthz`);
        if (r.ok) { up = true; break; }
      } catch { /* retry */ }
      await new Promise((r) => setTimeout(r, 250));
    }
    check('临时实例（配了世界入口）起来了', up, up ? '' : `见 ${LOG}`);
    if (!up) throw new Error('临时实例未启动');

    const user = await register(TEST, '进空间的人');
    const anonStatus = await api(TEST, '/api/world/status');
    check('未登录访问 status → 401（不能匿名看/换票）', anonStatus.status === 401, `status=${anonStatus.status}`);
    const anonTicket = await api(TEST, '/api/world/ticket', { method: 'POST' });
    check('未登录换票 → 401', anonTicket.status === 401, `status=${anonTicket.status}`);

    const st = await api(TEST, '/api/world/status', { cookie: user.cookie });
    check('配置世界后 status.enabled=true 且带入口 URL',
      st.status === 200 && st.json?.enabled === true && st.json?.url === WORLD_PUBLIC, JSON.stringify(st.json));

    const tk = await api(TEST, '/api/world/ticket', { method: 'POST', cookie: user.cookie });
    const body = tk.json || {};
    check('换票成功并返回可打开的 URL',
      tk.status === 200 && typeof body.url === 'string' && body.url.startsWith(`${WORLD_PUBLIC}/?ticket=`),
      String(body.url).slice(0, 60));
    check('票据 TTL 是 180 秒', body.expiresInSeconds === 180, String(body.expiresInSeconds));

    const raw = new URL(body.url).searchParams.get('ticket') || '';
    const v = verifyTicket(raw, TICKET_SECRET);
    check('票据签名可被同一密钥验证', v.ok === true);
    check('票据载荷含当前用户 pid', Number(v.data?.pid) === user.id, `pid=${v.data?.pid} user=${user.id}`);
    check('票据载荷含昵称', typeof v.data?.name === 'string' && v.data.name.length > 0, v.data?.name);
    const now = Math.floor(Date.now() / 1000);
    check('票据 exp 在 (now, now+200]', Number(v.data?.exp) > now && Number(v.data?.exp) <= now + 200, String(v.data?.exp));

    const tampered = `${v.payload}.${v.sig.slice(0, -2)}${v.sig.endsWith('aa') ? 'bb' : 'aa'}`;
    check('篡改签名后验签失败（world 侧会 401）', verifyTicket(tampered, TICKET_SECRET).ok === false);
    check('换一把密钥验签失败', verifyTicket(raw, 'wrong-secret').ok === false);

    // ---------------------------------------------------------------- 3) 世界开关
    const created = await api(TEST, '/api/agents', {
      method: 'POST', cookie: user.cookie, body: { display_name: `空间AI${rnd()}` },
    });
    const agentId = Number(created.json?.agent?.id);
    check('创建 AI 成功', created.status === 200 && agentId > 0, `status=${created.status}`);
    const before = await api(TEST, '/api/agents', { cookie: user.cookie });
    const a0 = (before.json || []).find((a) => Number(a.id) === agentId);
    check('新 AI 默认 canEnterWorld=false', a0?.canEnterWorld === false, JSON.stringify(a0?.canEnterWorld));
    const on = await api(TEST, `/api/agents/${agentId}/world`, { method: 'PATCH', cookie: user.cookie, body: { allow: true } });
    check('打开世界开关 → canEnterWorld=true', on.status === 200 && on.json?.canEnterWorld === true, JSON.stringify(on.json));
    const after = await api(TEST, '/api/agents', { cookie: user.cookie });
    check('/api/agents 读回 canEnterWorld=true',
      (after.json || []).find((a) => Number(a.id) === agentId)?.canEnterWorld === true);
    const off = await api(TEST, `/api/agents/${agentId}/world`, { method: 'PATCH', cookie: user.cookie, body: { allow: false } });
    check('关闭世界开关 → canEnterWorld=false', off.status === 200 && off.json?.canEnterWorld === false);
  } catch (err) {
    check('执行', false, err.message);
  } finally {
    stop();
  }

  const failed = results.filter((r) => !r.ok);
  console.log(`\n${failed.length === 0 ? '全部通过' : '有失败'}：${results.length - failed.length}/${results.length}`);
  if (failed.length) process.exitCode = 1;
}

main().catch((e) => {
  console.error('验证异常：', e.message);
  process.exitCode = 1;
});
