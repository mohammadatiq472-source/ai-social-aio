#!/usr/bin/env node
// 校验提交站：文件齐全、本地引用都能解析、无外部依赖、体积在预算内。
// 用法：node scripts/verify/verify-submission-site.mjs
import fs from 'node:fs';
import path from 'node:path';

const ROOT = 'submission/qoder-sites';
let pass = 0;
const fail = [];

function ok(name, cond, detail = '') {
  if (cond) { pass += 1; console.log(`  ✓ ${name}`); }
  else { fail.push(name + (detail ? ` — ${detail}` : '')); console.log(`  ✗ ${name}${detail ? ` — ${detail}` : ''}`); }
}

console.log('== 文件结构 ==');
const REQUIRED = [
  'index.html', 'style.css', 'app.js',
  'assets/whalegirl.glb',
  'vendor/three.module.js', 'vendor/three.core.js',
  'vendor/jsm/loaders/GLTFLoader.js',
  'vendor/jsm/controls/OrbitControls.js',
  'vendor/jsm/utils/BufferGeometryUtils.js',
];
for (const f of REQUIRED) ok(f, fs.existsSync(path.join(ROOT, f)));

console.log('\n== 模型体积 ==');
const glb = fs.statSync(path.join(ROOT, 'assets/whalegirl.glb'));
ok('模型 ≤ 6MB', glb.size <= 6 * 1024 * 1024, `${(glb.size / 1048576).toFixed(2)}MB`);
// 校验 GLB 里仍有动画
const buf = fs.readFileSync(path.join(ROOT, 'assets/whalegirl.glb'));
ok('GLB 魔数正确', buf.readUInt32LE(0) === 0x46546c67);
let off = 12, json = null;
while (off < buf.length && !json) {
  const len = buf.readUInt32LE(off);
  const type = buf.readUInt32LE(off + 4);
  if (type === 0x4e4f534a) json = JSON.parse(buf.subarray(off + 8, off + 8 + len).toString('utf8'));
  off += 8 + len + ((4 - (len % 4)) % 4);
}
const anims = (json?.animations || []).map((a) => a.name);
ok('动画数量 ≥ 15', anims.length >= 15, `${anims.length} 个`);
for (const need of ['idle', 'walk', 'agree', 'bow', 'heart_pose', 'sit']) {
  ok(`动画含 ${need}`, anims.includes(need));
}

console.log('\n== 本地引用可解析 ==');
const html = fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8');
const refs = [...html.matchAll(/(?:href|src)="(\.\/[^"]+)"/g)].map((m) => m[1]);
ok('index.html 有本地引用', refs.length > 0, `${refs.length} 条`);
for (const r of refs) ok(`存在 ${r}`, fs.existsSync(path.join(ROOT, r)));

const imports = [...html.matchAll(/"(\.\/vendor\/[^"]+)"/g)].map((m) => m[1]);
for (const i of imports) {
  // importmap 里的目录映射（以 / 结尾）不校验
  if (i.endsWith('/')) continue;
  ok(`importmap 目标存在 ${i}`, fs.existsSync(path.join(ROOT, i)));
}

console.log('\n== 无外部运行时依赖 ==');
const js = fs.readFileSync(path.join(ROOT, 'app.js'), 'utf8');
const css = fs.readFileSync(path.join(ROOT, 'style.css'), 'utf8');
const externalInCode = /(?:import|from)\s+["']https?:\/\//.test(js) || /@import\s+url\(["']?https?:\/\//.test(css);
ok('JS/CSS 不引用外网资源', !externalInCode);
const cdnRefs = [...html.matchAll(/(?:src|href)="(https?:\/\/[^"]+)"/g)].map((m) => m[1]);
const nonLink = cdnRefs.filter((u) => !/^https:\/\/qq\.example\.cn/.test(u));
ok('除产品外链外无 CDN 资源', nonLink.length === 0, nonLink.join(','));

console.log('\n== 关键交互与文案 ==');
for (const act of ['walk', 'agree', 'bow', 'heart_pose', 'sit']) {
  ok(`按钮 data-act=${act}`, html.includes(`data-act="${act}"`));
}
ok('有说话气泡元素', html.includes('id="bubble"'));
ok('有加载态', html.includes('id="loading"'));
ok('中文标题存在', html.includes('住在同一个房间'));
ok('GPL 归属声明存在', html.includes('Hyperfy'));

console.log(`\n${fail.length === 0 ? '全部通过' : '有失败项'}：${pass}/${pass + fail.length}`);
if (fail.length) { for (const f of fail) console.log('  - ' + f); process.exit(1); }
