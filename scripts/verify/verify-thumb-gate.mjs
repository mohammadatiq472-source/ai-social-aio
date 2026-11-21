#!/usr/bin/env node
// 缩略图并发闸（2026-11-19，对应 C1 的 400MB 进程上限）。
//
// 为什么需要这条验证：sharp 一张 40MP 图解出来约 160MB，两三个并发就 OOM。
// 闸门的两个失效方式都不会报错、只会在压力下才炸：
//   1) 名额泄漏（忘了 release）→ 通道永久少一格，最后退化成「全都不派生」；
//   2) 队列满了还硬排 → 请求挂死、内存被排队任务拖爆。
// 所以这里既测「信号量语义」，也测「真并发上传 6 张仍然全部拿到缩略图」。
//
// 用法：
//   node scripts/verify/verify-thumb-gate.mjs
//   BASE=http://127.0.0.1:8787 node scripts/verify/verify-thumb-gate.mjs   # 加跑真实上传

import crypto from 'node:crypto';
import sharp from 'sharp';
import { createLimiter } from '../../src/core/limit.mjs';

const BASE = (process.env.BASE || 'http://127.0.0.1:8787').replace(/\/$/, '');
const results = [];
const rnd = () => crypto.randomBytes(4).toString('hex');

function check(name, ok, detail = '') {
  results.push({ name, ok });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? '  — ' + detail : ''}`);
}
function skip(name, detail = '') {
  results.push({ name, ok: true, skipped: true });
  console.log(`SKIP  ${name}${detail ? '  — ' + detail : ''}`);
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ---------------------------------------------------------------- 1) 信号量语义
async function unitTests() {
  {
    const lim = createLimiter({ concurrency: 2, maxQueue: 8, name: 'unit' });
    const a = lim.acquire();
    const b = lim.acquire();
    const c = lim.acquire(); // 必须排队
    const [ra, rb] = await Promise.all([a, b]);
    const st = lim.stats();
    check('并发 2：前两个立刻拿到名额', ra === true && rb === true, '');
    check('并发 2：第三个排队而不是失败', st.waiting === 1 && st.active === 2, JSON.stringify(st));

    lim.release();
    const rc = await c;
    const st2 = lim.stats();
    check('release 后名额直接转交给等待者', rc === true, '');
    check('转交时 active 不变（不会超发）', st2.active === 2 && st2.peak === 2, JSON.stringify(st2));

    lim.release();
    lim.release();
    const st3 = lim.stats();
    check('全部归还后 active 归零（没泄漏名额）', st3.active === 0 && st3.waiting === 0, JSON.stringify(st3));
    check('高峰从未超过 concurrency', st3.peak === 2, `peak=${st3.peak}`);
  }

  {
    const lim = createLimiter({ concurrency: 1, maxQueue: 2, name: 'bounded' });
    await lim.acquire();
    const q1 = lim.acquire();
    const q2 = lim.acquire();
    const overflow = await lim.acquire(); // 第 4 个：队列已满 → 立刻 false
    check('队列满时立刻拒绝（不无限堆积）', overflow === false, JSON.stringify(lim.stats()));
    check('拒绝被计数（可观测）', lim.stats().dropped === 1, `dropped=${lim.stats().dropped}`);
    lim.release();
    lim.release();
    const [r1, r2] = await Promise.all([q1, q2]);
    lim.release();
    check('排队的两个仍按序拿到名额', r1 === true && r2 === true, '');
    check('排空后 active=0', lim.stats().active === 0, JSON.stringify(lim.stats()));
  }

  {
    // 防御：0 / 负数 / 非整数必须启动即炸（否则闸门静默失效，等于没装）
    let threw = 0;
    for (const bad of [0, -1, 1.5, NaN]) {
      try { createLimiter({ concurrency: bad }); } catch { threw += 1; }
    }
    check('非法并发值直接抛错（不静默放行）', threw === 4, `${threw}/4`);
  }
}

// ---------------------------------------------------------------- 2) 真实并发上传
async function api(path, { method = 'GET', body, cookie, raw, contentType } = {}) {
  const headers = {};
  if (cookie) headers.cookie = cookie;
  if (contentType) headers['content-type'] = contentType;
  else if (body !== undefined) headers['content-type'] = 'application/json';
  const res = await fetch(`${BASE}${path}`, {
    method,
    headers,
    body: raw !== undefined ? raw : body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  let json = null;
  try { json = text ? JSON.parse(text) : null; } catch { json = null; }
  return { status: res.status, json, text, headers: res.headers };
}

async function register(name) {
  const email = `t_${rnd()}${rnd()}@test.dev`;
  const password = 'ThumbGate!2026';
  const r = await api('/api/auth/register', {
    method: 'POST',
    // 邀请制实例（生产）要带码；开放注册的本地留空即可
    body: { email, password, display_name: name, invite_code: process.env.REGISTER_CODE || '' },
  });
  if (r.status !== 200) throw new Error(`register ${r.status} ${String(r.text).slice(0, 120)}`);
  const setCookie = r.headers.getSetCookie ? r.headers.getSetCookie() : [];
  const cookie = setCookie.map((c) => c.split(';')[0]).join('; ');
  return { email, password, cookie, id: r.json?.user?.id ?? r.json?.principal?.id };
}

async function integration() {
  let health;
  try {
    health = await api('/healthz');
  } catch {
    skip('并发上传（BASE 不可达）', BASE);
    return;
  }
  if (health.status !== 200) {
    skip('并发上传（/healthz 非 200）', String(health.status));
    return;
  }

  const user = await register('缩略闸A');
  // 6 张 2400×1600 的图同时上传：单张解码约 15MB，够把并发闸压到排队
  const blobs = await Promise.all(
    Array.from({ length: 6 }, (_, i) =>
      sharp({
        create: { width: 2400, height: 1600, channels: 3, background: { r: 40 + i * 20, g: 90, b: 140 } },
      }).png().toBuffer()),
  );

  const started = Date.now();
  const uploads = await Promise.all(
    blobs.map((buf) =>
      api('/api/attachments', {
        method: 'POST',
        cookie: user.cookie,
        raw: buf,
        contentType: 'image/png',
      }),
    ),
  );
  const ms = Date.now() - started;

  const codes = uploads.map((u) => u.status);
  check('6 张图并发上传全部成功（闸门没把请求饿死）', codes.every((c) => c === 200), codes.join(','));
  const withThumb = uploads.filter((u) => u.json?.thumbUrl || u.json?.attachment?.thumbUrl);
  check(
    '每张都拿到 thumbUrl（队列排空后仍会派生，不是直接放弃）',
    withThumb.length === 6,
    `${withThumb.length}/6`,
  );
  const ids = uploads.map((u) => u.json?.id ?? u.json?.attachment?.id).filter(Boolean);
  check('返回的附件 id 各不相同', new Set(ids).size === ids.length, `${new Set(ids).size}/${ids.length}`);
  console.log(`      （6 张并发上传耗时 ${ms}ms）`);

  const after = await api('/healthz');
  check('并发上传后服务仍健康（没被 OOM 打死）', after.status === 200 && after.json?.ok === true, `status=${after.status}`);
  check(
    '内存仍在 400MB 口径内',
    Number(after.json?.memoryMB || 0) > 0 && Number(after.json.memoryMB) < 400,
    `memoryMB=${after.json?.memoryMB}`,
  );

  // 缩略图本身可读（签名 URL 没被并发写坏）
  const one = uploads[0]?.json;
  const thumbPath = one?.thumbUrl || one?.attachment?.thumbUrl;
  if (thumbPath) {
    const r = await fetch(`${BASE}${thumbPath}`);
    check('并发派生出的缩略图可读（200 image/webp）', r.status === 200 && String(r.headers.get('content-type')).includes('webp'),
      `${r.status} ${r.headers.get('content-type')}`);
    await r.arrayBuffer();
  } else {
    check('并发派生出的缩略图可读（200 image/webp）', false, '没有 thumbUrl');
  }

  await sleep(50);
}

const main = async () => {
  await unitTests();
  await integration();
  const failed = results.filter((r) => !r.ok);
  const skipped = results.filter((r) => r.skipped);
  console.log('\n' + '-'.repeat(60));
  if (failed.length) {
    console.log(`有失败：${results.length - failed.length}/${results.length}`);
    for (const f of failed) console.log(`  ✗ ${f.name}`);
    process.exit(1);
  }
  console.log(
    `全部通过：${results.length - skipped.length}/${results.length}` + (skipped.length ? `（跳过 ${skipped.length} 项）` : ''),
  );
};

main().catch((e) => {
  console.error('验证异常：', e.message);
  process.exit(1);
});
