#!/usr/bin/env node
// dsh-plugin 包的发布前自检（2026-11-19）。
//
// 为什么需要它：插件市场那条 PR 被拒的真实原因是「tarball 里没有 index.js，
// 装完没有入口」——而这种错在本地完全无感：`npm pack` 成功、`node index.js` 也能跑，
// 只有「解包后按 package.json 的 main 去 import」才会暴露。
// 所以这里按「用户真的安装之后会发生什么」验：
//   1) npm pack 打出来的文件清单必须含入口与补丁；
//   2) 解包后 main/exports 指向的文件必须真实存在；
//   3) 解包后的入口能被 ESM 动态 import 并导出 name/apply；
//   4) 补丁里引用的 MCP 客户端包名必须写清（否则装了也不知道连什么）。
//
// 用法：node scripts/verify/verify-plugin-package.mjs

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { pathToFileURL, fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const PLUGIN = path.join(ROOT, 'dsh-plugin');
const results = [];
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'aio-plugin-'));

function check(name, ok, detail = '') {
  results.push({ name, ok: Boolean(ok) });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? '  — ' + detail : ''}`);
}

const main = async () => {
  const pkg = JSON.parse(fs.readFileSync(path.join(PLUGIN, 'package.json'), 'utf8'));

  // ---------- 1) npm pack 的文件清单
  const raw = execFileSync('npm', ['pack', '--dry-run', '--json'], { cwd: PLUGIN, encoding: 'utf8', shell: true });
  let info = null;
  try { info = JSON.parse(raw); } catch { info = null; }
  const entry = Array.isArray(info) ? info[0] : info;
  const files = (entry?.files || []).map((f) => f.path);
  check('npm pack 能列出文件', files.length > 0, `${files.length} 个`);

  const mustHave = ['package.json', 'index.js', 'cordis.patch.yml', 'icon.svg', 'README.md', 'LICENSE'];
  const missing = mustHave.filter((f) => !files.includes(f));
  check('入口 index.js 与补丁都在包里（PR 被拒就是因为缺它）', missing.length === 0, missing.join(', '));
  check('locale 至少一种语言', files.some((f) => /^locale\/.+\.json$/.test(f)), files.filter((f) => f.startsWith('locale/')).join(', '));

  // ---------- 2) 真实安装 + 按 main 解析
  // 为什么用 npm install 而不是 tar 解包：Windows 的 tar 会把 "C:\..." 当成远端主机
  //（报 "Cannot connect to C: resolve failed"）；而 npm install 正是用户真实路径，
  // 验的是「装完之后长什么样」，比解包更贴近事实。
  const tgz = execFileSync('npm', ['pack', '--silent'], { cwd: PLUGIN, encoding: 'utf8', shell: true })
    .trim()
    .split(String.fromCharCode(10))
    .pop();
  const tgzAbs = path.join(PLUGIN, tgz);
  fs.writeFileSync(path.join(tmp, 'package.json'), JSON.stringify({ name: 'probe', private: true, version: '1.0.0' }));
  execFileSync('npm', ['install', tgzAbs, '--no-audit', '--no-fund', '--loglevel=error'], {
    cwd: tmp, encoding: 'utf8', shell: true,
  });
  const pkgDir = path.join(tmp, 'node_modules', 'dsh-plugin-aio');

  check('解包后 package.json 存在', fs.existsSync(path.join(pkgDir, 'package.json')), pkgDir);
  const mainFile = path.join(pkgDir, pkg.main || 'index.js');
  check(`package.json 的 main（${pkg.main || 'index.js'}）在包里`, fs.existsSync(mainFile), mainFile);

  const exportRoot = typeof pkg.exports === 'object' && pkg.exports ? pkg.exports['.'] : null;
  const exportPath = typeof exportRoot === 'string' ? exportRoot : (exportRoot?.default ?? null);
  check('exports["."] 指向的文件在包里',
    Boolean(exportPath) && fs.existsSync(path.join(pkgDir, String(exportPath).replace(/^\.\//, ''))),
    String(exportPath));

  // ---------- 3) ESM 入口能 import 且导出 name/apply
  const mod = await import(pathToFileURL(mainFile).href);
  check('入口能被 ESM 动态 import', Boolean(mod), '');
  check('入口导出 name', typeof mod.name === 'string' && mod.name.length > 0, mod.name);
  check('入口导出 apply()', typeof mod.apply === 'function', typeof mod.apply);

  // ---------- 4) 补丁里写清了 MCP 客户端依赖
  const patch = fs.readFileSync(path.join(pkgDir, 'cordis.patch.yml'), 'utf8');
  check('补丁引用了 @deepseek-ai/dsh-mcp-client', patch.includes('@deepseek-ai/dsh-mcp-client'), '');
  check('补丁用环境变量而不是硬编码 token', patch.includes('AIO_MCP_TOKEN') && !/Bearer qqa_/.test(patch), '');

  // ---------- 5) 包元数据
  check('包名可在 npm 发布（无 scope 冲突）', pkg.name === 'dsh-plugin-aio', pkg.name);
  check('license 是 MIT', pkg.license === 'MIT', pkg.license);
  check('keywords 覆盖 dsh-plugin / aio（可搜到）',
    (pkg.keywords || []).includes('dsh-plugin') && (pkg.keywords || []).includes('aio'),
    (pkg.keywords || []).join(','));

  fs.rmSync(tgz ? path.join(PLUGIN, tgz) : '', { force: true });
  fs.rmSync(tmp, { recursive: true, force: true });

  const failed = results.filter((r) => !r.ok);
  console.log('\n' + '-'.repeat(60));
  if (failed.length) {
    console.log(`有失败：${results.length - failed.length}/${results.length}`);
    for (const f of failed) console.log(`  ✗ ${f.name}`);
    process.exit(1);
  }
  console.log(`全部通过：${results.length}/${results.length}`);
};

main().catch((err) => {
  fs.rmSync(tmp, { recursive: true, force: true });
  console.error('验证异常：', err.message);
  process.exit(1);
});
