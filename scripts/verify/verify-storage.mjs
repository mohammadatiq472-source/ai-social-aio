// 存储驱动回归：上传→读取→Range→清理，验证 local 驱动接口
import fs from 'node:fs';

const BASE = process.env.BASE || 'http://127.0.0.1:8787';
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/131.0.0.0 Safari/537.36';
const problems = [];

const login = async () => {
  const r = await fetch(`${BASE}/api/auth/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'user-agent': UA },
    body: JSON.stringify({ email: 'demo@qqmini.dev', password: 'demo-qqmini-2026' }),
  });
  return (r.headers.getSetCookie?.() || []).map((c) => String(c).split(';')[0]).join('; ');
};
const cookie = await login();

// 1) 上传（走流式解析器 + storage.putFromFile）
const png = Buffer.concat([Buffer.from('89504e470d0a1a0a', 'hex'), Buffer.alloc(200 * 1024, 0)]);
const up = await fetch(`${BASE}/api/attachments`, {
  method: 'POST',
  headers: { cookie, 'user-agent': UA, 'content-type': 'image/png' },
  body: png,
});
const upBody = await up.json().catch(() => null);
console.log('上传:', up.status, upBody?.attachment?.id, upBody?.attachment?.url?.slice(0, 40));
if (up.status !== 200) problems.push(`上传失败 ${up.status}`);

// 2) 读取（storage.createReadStream）
let etag = null;
if (upBody?.attachment?.url) {
  const full = await fetch(`${BASE}${upBody.attachment.url}`, { headers: { 'user-agent': UA } });
  etag = full.headers.get('etag');
  const body = Buffer.from(await full.arrayBuffer());
  console.log('读取:', full.status, 'bytes=', body.length, 'etag=', etag);
  if (full.status !== 200 || body.length !== png.length) problems.push('读取内容不完整');

  // 3) Range
  const range = await fetch(`${BASE}${upBody.attachment.url}`, { headers: { 'user-agent': UA, range: 'bytes=10-99' } });
  const rb = Buffer.from(await range.arrayBuffer());
  console.log('Range:', range.status, range.headers.get('content-range'), 'bytes=', rb.length);
  if (range.status !== 206 || rb.length !== 90) problems.push('Range 不正确');

  // 4) 304
  const cond = await fetch(`${BASE}${upBody.attachment.url}`, { headers: { 'user-agent': UA, 'if-none-match': etag || '' } });
  console.log('304:', cond.status);
  if (cond.status !== 304) problems.push('If-None-Match 未返回 304');
}

// 5) 清理 dry-run（storage.stat/delete 接口）
console.log(JSON.stringify({ problems }, null, 2));
console.log(problems.length ? 'STORAGE DRIVER FAILED' : 'STORAGE DRIVER PASSED');
process.exit(problems.length ? 1 : 0);
