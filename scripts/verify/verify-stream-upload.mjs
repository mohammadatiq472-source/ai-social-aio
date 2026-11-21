// 流式上传验收：并发峰值内存、类型/大小校验、临时文件不残留
import fs from 'node:fs';

const BASE = process.env.BASE || 'http://127.0.0.1:8787';
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/131.0.0.0 Safari/537.36';
const problems = [];

const readMem = () => {
  try {
    const base = '/sys/fs/cgroup/system.slice/qqmini.service';
    return {
      curMB: Math.round(Number(fs.readFileSync(base + '/memory.current', 'utf8')) / 1048576),
      peakMB: Math.round(Number(fs.readFileSync(base + '/memory.peak', 'utf8')) / 1048576),
    };
  } catch { return null; }
};
const tmpCount = () => {
  try { return fs.readdirSync('/opt/aio/data/media/tmp').filter((f) => f.endsWith('.part')).length; } catch { return 0; }
};

const login = async () => {
  const r = await fetch(`${BASE}/api/auth/login`, {
    method: 'POST', headers: { 'content-type': 'application/json', 'user-agent': UA },
    body: JSON.stringify({ email: 'demo@qqmini.dev', password: 'demo-qqmini-2026' }),
  });
  return (r.headers.getSetCookie?.() || []).map((c) => String(c).split(';')[0]).join('; ');
};
const cookie = await login();
const PNG = (size) => Buffer.concat([Buffer.from('89504e470d0a1a0a', 'hex'), Buffer.alloc(size - 8, 0)]);
const upload = (buf, headers = {}) => fetch(`${BASE}/api/attachments`, {
  method: 'POST', headers: { cookie, 'user-agent': UA, 'content-type': 'image/png', ...headers }, body: buf,
}).then(async (r) => ({ status: r.status, body: await r.json().catch(() => null) }));

// 1) 4 个并发的 6MB 上传（同一份内容 → 去重，只落一个文件）
const before = readMem();
const t0 = Date.now();
const burst = await Promise.all([1, 2, 3, 4].map(() => upload(PNG(6 * 1024 * 1024))));
const after = readMem();
console.log('4×6MB 并发:', burst.map((x) => x.status), '耗时', Date.now() - t0, 'ms', '重复复用:', burst.filter((x) => x.body?.reused).length);
console.log('内存:', before, '→', after);

// 2) 超大图片（9MB > 8MB 上限）→ 413
const big = await upload(PNG(9 * 1024 * 1024));
console.log('9MB 图片:', big.status, big.body?.error);
if (big.status !== 413) problems.push(`超限图片应 413，实际 ${big.status}`);

// 3) 伪装成 png 的 HTML → 415
const fake = await upload(Buffer.concat([Buffer.from('<html><script>alert(1)</script>'), Buffer.alloc(200, 0)]));
console.log('伪装 HTML:', fake.status, fake.body?.error);
if (fake.status !== 415) problems.push(`伪装 HTML 应 415，实际 ${fake.status}`);

// 4) 小文件正常
const small = await upload(PNG(200 * 1024));
console.log('200KB 图片:', small.status, 'reused=', small.body?.reused);
if (small.status !== 200) problems.push(`正常上传失败 ${small.status}`);

// 5) 临时文件残留
const leftovers = tmpCount();
console.log('tmp 残留:', leftovers);
if (leftovers > 0) problems.push(`tmp 目录残留 ${leftovers} 个 .part`);

if (burst.some((x) => x.status !== 200)) problems.push(`并发有失败：${burst.map((x) => x.status)}`);
if (after && after.peakMB > 120) problems.push(`内存峰值过高：${after.peakMB}MB`);

console.log(JSON.stringify({ problems }, null, 2));
console.log(problems.length ? 'STREAM UPLOAD FAILED' : 'STREAM UPLOAD PASSED');
process.exit(problems.length ? 1 : 0);
