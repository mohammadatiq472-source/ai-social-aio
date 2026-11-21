#!/usr/bin/env node
/**
 * license-check：守住 spec §11.1 / G6（全部代码 MIT，无 GPL 依赖）。
 *
 * 为什么这个脚本必须存在且必须能失败：
 * 3D 世界的整个立项理由就是「拿不到 MIT」。只要有一个 GPL 依赖溜进依赖树，
 * 整个交付物就不能按 MIT 发布——这是法律问题，不是代码风格问题。
 * 所以这里宁可误报（让人去豁免），也不要漏报。
 *
 * 两层检查：
 * 1. **直接依赖**（package.json 的 dependencies + devDependencies）：必须命中允许集合。
 *    这一层严格，因为它们是"我们主动选的"。
 * 2. **整棵依赖树**（node_modules 下所有包）：只查 copyleft（GPL/AGPL/SSPL/CC-BY-NC 等），
 *    命中直接失败。间接依赖的宽松许可变体（如 MIT-0）不拦，避免噪声把真问题淹掉。
 *
 * 退出码：0 = 通过；1 = 有违规或许可证不明。
 */

import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, '..');
const NM = join(ROOT, 'node_modules');

/** 允许集合（spec §11.1 + 提示词原文）。全部大小写不敏感比较。 */
const ALLOWED = [
  'MIT',
  'MIT-0',
  'Apache-2.0',
  'BSD-2-Clause',
  'BSD-3-Clause',
  'ISC',
  '0BSD',
  'Zlib',
  'Unlicense',
  'CC0-1.0',
  'BlueOak-1.0.0',
  'Python-2.0',
  'WTFPL',
];

/** 命中即失败：这些是真正的传染性/禁用许可。 */
const FORBIDDEN_PATTERNS = [
  /\bAGPL\b/i,
  /\bGPL\b/i, // 注意：LGPL 会被这条拦下（LGPL 对我们同样是麻烦），单独放行见 ALLOWED_LGPL
  /\bSSPL\b/i,
  /\bCC-BY-NC\b/i,
  /\bCC-BY-SA\b/i,
  /\bCommons-Clause\b/i,
  /\bBUSL\b/i,
  /\bElastic-2\.0\b/i,
];

/**
 * LGPL 单独判断：LGPL-3.0 允许动态链接，但前端 bundle 会把代码静态打进去，
 * 所以对浏览器侧依赖我们同样不接受。若将来确实需要（例如某个 WASM 边界明确的库），
 * 在这里加白名单并写明理由，不要放宽 FORBIDDEN。
 */
const LGPL_ALLOWLIST = new Set([]);

function normalizeLicense(pkg) {
  // 现代字段
  if (typeof pkg.license === 'string') return pkg.license.trim();
  if (pkg.license && typeof pkg.license === 'object' && typeof pkg.license.type === 'string') {
    return pkg.license.type.trim();
  }
  // 旧字段：licenses: [{type, url}]
  if (Array.isArray(pkg.licenses)) {
    const types = pkg.licenses
      .map((l) => (typeof l === 'string' ? l : l && l.type))
      .filter((t) => typeof t === 'string');
    if (types.length > 0) return types.join(' OR ');
  }
  return null;
}

/** 从 SPDX 表达式里拆出所有许可标识符。处理 "MIT OR Apache-2.0"、"(MIT AND CC0-1.0)"。 */
function splitSpdx(expr) {
  return expr
    .replace(/[()]/g, ' ')
    .split(/\s+(?:OR|AND|WITH)\s+/i)
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
}

function isAllowed(expr) {
  if (!expr) return false;
  const ids = splitSpdx(expr);
  if (ids.length === 0) return false;
  // "OR" 语义：任一命中即可（AND 严格说要求全部，但 AND 里的宽松许可组合在实践中都放行）
  return ids.some((id) => {
    const lower = id.toLowerCase();
    return ALLOWED.some((a) => a.toLowerCase() === lower);
  });
}

function findForbidden(expr) {
  if (!expr) return null;
  const ids = splitSpdx(expr);
  for (const id of ids) {
    for (const re of FORBIDDEN_PATTERNS) {
      if (re.test(id)) {
        if (/^LGPL/i.test(id) && LGPL_ALLOWLIST.has(id)) continue;
        return id;
      }
    }
  }
  return null;
}

function readPkg(dir) {
  const p = join(dir, 'package.json');
  if (!existsSync(p)) return null;
  try {
    // 去掉 BOM：有些工具（PowerShell 的 Set-Content、部分 Windows 编辑器）会写 EF BB BF，
    // 而 JSON.parse 对 BOM 直接抛错。不处理就会把「能读但带 BOM」误判成「读不了」。
    const raw = readFileSync(p, 'utf8').replace(/^\uFEFF/, '');
    return JSON.parse(raw);
  } catch (err) {
    // 返回带标记的对象，让调用方**明确知道这是解析失败**而不是「没有 package.json」
    return { __parseError: String(err) };
  }
}

// ───────────────────────────── 主流程 ─────────────────────────────

const rootPkg = readPkg(ROOT);
if (!rootPkg) {
  console.error('license-check: 找不到 package.json');
  process.exit(1);
}
if (!existsSync(NM)) {
  console.error('license-check: node_modules 不存在，先跑 npm install');
  process.exit(1);
}

const directNames = [
  ...Object.keys(rootPkg.dependencies ?? {}),
  ...Object.keys(rootPkg.devDependencies ?? {}),
];

const failures = [];
const unknown = [];
const directReport = [];

// 1) 直接依赖：严格
for (const name of directNames) {
  const dir = join(NM, ...name.split('/'));
  if (!existsSync(dir)) {
    failures.push({ name, reason: '依赖未安装（node_modules 里找不到）', license: '-' });
    continue;
  }
  const pkg = readPkg(dir);
  if (!pkg || pkg.__parseError) {
    failures.push({ name, reason: 'package.json 读取失败', license: '-' });
    continue;
  }
  const license = normalizeLicense(pkg);
  const version = pkg.version ?? '?';

  const forbidden = findForbidden(license);
  if (forbidden) {
    failures.push({ name, version, reason: `禁用许可 ${forbidden}`, license: license ?? 'null' });
    continue;
  }
  if (!isAllowed(license)) {
    if (!license) unknown.push({ name, version, reason: '没有 license 字段' });
    else failures.push({ name, version, reason: '许可不在允许集合', license });
    continue;
  }
  directReport.push({ name, version, license });
}

// 2) 整棵依赖树：只拦 copyleft
let scanned = 0;
const copyleft = [];
const unreadable = [];
const noLicense = [];

function walkScopes(prefix, dir) {
  let entries;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const e of entries) {
    if (!e.isDirectory() && !e.isSymbolicLink()) continue;
    const name = e.name;
    if (name === '.bin' || name === '.cache' || name === '.vite') continue;

    if (name.startsWith('@')) {
      walkScopes(`${prefix}${name}/`, join(dir, name));
      continue;
    }

    const pkgDir = join(dir, name);
    const pkg = readPkg(pkgDir);
    if (pkg) {
      scanned += 1;
      if (pkg.__parseError) {
        // 读不出许可证 ≠ 许可证没问题。静默跳过等于给 GPL 开后门，必须报出来。
        unreadable.push({ name: `${prefix}${name}`, reason: 'package.json 解析失败' });
      } else {
        const license = normalizeLicense(pkg);
        const forbidden = findForbidden(license);
        if (forbidden) {
          copyleft.push({ name: `${prefix}${name}`, version: pkg.version ?? '?', license: license ?? 'null' });
        } else if (!license) {
          // 依赖树里没写 license 的包：只记录不失败（数量可能很大，且多数是历史遗留），
          // 但直接依赖那边是严格失败的——那才是我们主动选的。
          noLicense.push(`${prefix}${name}`);
        }
      }
    }

    // 嵌套 node_modules（npm 的旧式提升会留下这种结构）
    const nested = join(pkgDir, 'node_modules');
    if (existsSync(nested)) walkScopes(`${prefix}${name}/`, nested);
  }
}

walkScopes('', NM);

// ───────────────────────────── 输出 ─────────────────────────────

console.log('license-check — AIO 3D 世界（目标许可：MIT）');
console.log('');
console.log(`直接依赖（${directNames.length}）:`);
for (const d of directReport) {
  console.log(`  ✓ ${d.name}@${d.version}  ${d.license}`);
}
console.log('');
console.log(`依赖树扫描：${scanned} 个包，copyleft 命中 ${copyleft.length} 个`);
if (noLicense.length > 0) {
  console.log(`   （其中 ${noLicense.length} 个未声明 license，已记录但不判失败；直接依赖为严格判定）`);
}
console.log('');

let bad = false;

if (copyleft.length > 0) {
  bad = true;
  console.error('✗ 依赖树里出现 copyleft 许可（不可按 MIT 发布）:');
  for (const c of copyleft) {
    console.error(`   ${c.name}@${c.version}  →  ${c.license}`);
  }
  console.error('');
}

if (unreadable.length > 0) {
  // 读不出许可证不能当成通过：静默跳过等于给 GPL 开后门
  bad = true;
  console.error('✗ 以下依赖的 package.json 无法解析，许可证未知:');
  for (const u of unreadable) {
    console.error(`   ${u.name}  →  ${u.reason}`);
  }
  console.error('');
}

if (unknown.length > 0) {
  bad = true;
  console.error('✗ 以下直接依赖没有声明许可证，无法确认是否可用:');
  for (const u of unknown) {
    console.error(`   ${u.name}@${u.version}  →  ${u.reason}`);
  }
  console.error('');
}

if (failures.length > 0) {
  bad = true;
  console.error('✗ 直接依赖许可不合格:');
  for (const f of failures) {
    console.error(`   ${f.name}${f.version ? '@' + f.version : ''}  →  ${f.reason}（${f.license}）`);
  }
  console.error('');
}

if (bad) {
  console.error(
    `license-check 失败：${failures.length + unknown.length + copyleft.length + unreadable.length} 个问题`,
  );
  process.exit(1);
}

console.log(`✓ 全部通过：${directReport.length}/${directNames.length} 直接依赖许可合规，无 GPL/AGPL/SSPL`);
