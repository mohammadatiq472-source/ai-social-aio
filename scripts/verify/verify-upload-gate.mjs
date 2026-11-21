// 验证上传闸门：认证在收 body 前、并发被限制、内存峰值有上界
const BASE = process.env.BASE || 'http://127.0.0.1:8787';
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/131.0.0.0 Safari/537.36';
const fs = await import('node:fs');
const readMem = () => {
  try {
    const base = '/sys/fs/cgroup/system.slice/qqmini.service';
    const cur = Number(fs.readFileSync(base + '/memory.current', 'utf8').trim());
    const peak = Number(fs.readFileSync(base + '/memory.peak', 'utf8').trim());
    return { curMB: Math.round(cur / 1048576), peakMB: Math.round(peak / 1048576) };
  } catch { return null; }
};
const login = async () => {
  const r = await fetch(`${BASE}/api/auth/login`, { method: 'POST', headers: { 'content-type': 'application/json', 'user-agent': UA }, body: JSON.stringify({ email: 'demo@qqmini.dev', password: 'demo-qqmini-2026' }) });
  return (r.headers.getSetCookie?.() || []).map((c) => String(c).split(';')[0]).join('; ');
};
const cookie = await login();
const png = Buffer.concat([Buffer.from('89504e470d0a1a0a', 'hex'), Buffer.alloc(6 * 1024 * 1024, 0)]);
const before = readMem();
const t0 = Date.now();
const results = await Promise.all(Array.from({ length: 4 }, () => fetch(`${BASE}/api/attachments`, {
  method: 'POST',
  headers: { cookie, 'user-agent': UA, 'content-type': 'image/png' },
  body: png,
}).then((r) => r.status).catch(() => 0)));
const after = readMem();
console.log('并发 4×6MB 上传:', results, '耗时', Date.now() - t0, 'ms');
console.log('内存:', { before, after });

// 未登录的大 body：应该在收 body 前就被拒（拿不到 401 很快 + 不涨内存）
const t1 = Date.now();
const unauth = await fetch(`${BASE}/api/attachments`, { method: 'POST', headers: { 'user-agent': UA, 'content-type': 'image/png' }, body: png }).then((r) => r.status).catch(() => 0);
console.log('未登录上传:', unauth, '耗时', Date.now() - t1, 'ms');

const problems = [];
if (results.some((s) => s !== 200)) problems.push(`并发上传有失败：${results}`);
if (unauth !== 401) problems.push(`未登录上传没返回 401（${unauth}）`);
if (after && after.peakMB > 260) problems.push(`内存峰值过高：${after.peakMB}MB`);
console.log(JSON.stringify({ problems }, null, 2));
process.exit(problems.length ? 1 : 0);
