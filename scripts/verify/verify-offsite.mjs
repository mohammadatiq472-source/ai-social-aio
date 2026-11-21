// 异地备份回归：起一个最小 S3 兼容端点，跑 scripts/offsite-backup.mjs，校验上传内容与签名头。
// 不依赖任何外部服务；真实 R2/COS 只需要把 OFFSITE_S3_* 指过去。
import crypto from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';

const problems = [];
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'offsite-'));
const backupDir = path.join(tmp, 'backups');
const storeDir = path.join(tmp, 'store');
fs.mkdirSync(backupDir, { recursive: true });
fs.mkdirSync(storeDir, { recursive: true });

// 造一份"备份"
const name = 'qqmini-20260101-000000.sql.gz';
const payload = Buffer.concat([Buffer.from('fake-backup-'), crypto.randomBytes(4096)]);
fs.writeFileSync(path.join(backupDir, name), payload);

const seen = [];
const server = http.createServer((req, res) => {
  const chunks = [];
  req.on('data', (c) => chunks.push(c));
  req.on('end', () => {
    const body = Buffer.concat(chunks);
    seen.push({
      method: req.method,
      url: req.url,
      auth: req.headers.authorization || '',
      amzDate: req.headers['x-amz-date'] || '',
      contentSha: req.headers['x-amz-content-sha256'] || '',
      bytes: body.length,
    });
    if (req.method !== 'PUT') {
      res.statusCode = 405;
      res.end('method not allowed');
      return;
    }
    const rel = decodeURIComponent(req.url.replace(/^\/[^/]+\//, ''));
    const target = path.join(storeDir, rel);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, body);
    res.setHeader('etag', `"${crypto.createHash('md5').update(body).digest('hex')}"`);
    res.statusCode = 200;
    res.end('');
  });
});

await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
const port = server.address().port;

const run = (args) =>
  new Promise((resolve) => {
    const child = spawn(process.execPath, [path.join('scripts', 'offsite-backup.mjs'), ...args], {
      cwd: path.resolve('.'),
      env: {
        ...process.env,
        BACKUP_DIR: backupDir,
        OFFSITE_S3_ENDPOINT: `http://127.0.0.1:${port}`,
        OFFSITE_S3_REGION: 'auto',
        OFFSITE_S3_BUCKET: 'testbucket',
        OFFSITE_S3_ACCESS_KEY: 'AKIATEST',
        OFFSITE_S3_SECRET_KEY: 'secret',
        OFFSITE_S3_PREFIX: 'qqmini-backups/',
      },
    });
    let out = '';
    child.stdout.on('data', (d) => (out += d));
    child.stderr.on('data', (d) => (out += d));
    child.on('close', (code) => resolve({ code, out }));
  });

// 1) dry-run 不应上传
const dry = await run(['--dry']);
if (dry.code !== 0) problems.push(`--dry 退出码 ${dry.code}: ${dry.out.slice(0, 200)}`);
if (seen.length !== 0) problems.push('--dry 竟然发起了上传');

// 2) 真上传
const real = await run([]);
const stored = path.join(storeDir, 'qqmini-backups', name);
const storedOk = fs.existsSync(stored) && Buffer.compare(fs.readFileSync(stored), payload) === 0;
console.log('上传结果:', real.code, real.out.trim().split('\n').slice(-3).join(' | '));
console.log('远端文件:', storedOk, '请求:', seen);
if (real.code !== 0) problems.push(`上传退出码 ${real.code}`);
if (!storedOk) problems.push('远端内容与本地备份不一致');
const req = seen.at(-1);
if (!req || !req.auth.startsWith('AWS4-HMAC-SHA256')) problems.push('缺少 SigV4 Authorization');
if (!req || !req.contentSha || !req.amzDate) problems.push('缺少 x-amz-* 签名头');
if (req && req.bytes !== payload.length) problems.push(`上传字节数不符 ${req.bytes} != ${payload.length}`);

// 3) 未配置时：默认跳过（退出 0），--require 时报错（退出 3）
const skip = await new Promise((resolve) => {
  const child = spawn(process.execPath, [path.join('scripts', 'offsite-backup.mjs')], {
    cwd: path.resolve('.'),
    env: { ...process.env, BACKUP_DIR: backupDir, OFFSITE_S3_ENDPOINT: '', OFFSITE_S3_BUCKET: '' },
  });
  child.on('close', (code) => resolve(code));
});
if (skip !== 0) problems.push(`未配置时应跳过并返回 0，实际 ${skip}`);

server.close();
fs.rmSync(tmp, { recursive: true, force: true });

console.log(JSON.stringify({ problems }, null, 2));
console.log(problems.length ? 'OFFSITE BACKUP FAILED' : 'OFFSITE BACKUP PASSED');
process.exit(problems.length ? 1 : 0);
