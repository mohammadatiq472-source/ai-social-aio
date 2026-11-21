#!/usr/bin/env node
// ============================================================================
// scripts/check-contrast.mjs —— 文字对比度守卫（WCAG AA）
//
// 为什么需要它：2026-11-14 前端审查发现次要文字只有 3.25:1、11px 时间戳只有 1.72:1、
// 深色「AI 1」徽标 1.97:1。这些值全在 `01-tokens.css` / `18-dark.css` 的 :root 里，
// 改错一个数不会让构建失败、也不会被 `verify:tokens` 抓到（那条只管「不许写字面色」）。
//
// 做法：解析两个 CSS 的变量 → 解析 var() 引用 → 按 WCAG 相对亮度算比值 → 对照阈值。
//   · guard=true 的组合不达标 → 退出码 1（CI/提交前必须过）
//   · guard=false 的组合不达标 → 只打印 ⚠️（品牌色/气泡色要改得先做设计决定，不能悄悄改）
//
// 用法：node scripts/check-contrast.mjs
// ============================================================================
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const LIGHT = path.join(ROOT, 'web/src/styles/01-tokens.css');
const DARK = path.join(ROOT, 'web/src/styles/18-dark.css');

/** 抽一个 CSS 文件里所有 `--name: value;`（后出现的覆盖先出现的，正好对应层叠） */
function readVars(file) {
  const text = fs.readFileSync(file, 'utf8');
  const map = new Map();
  for (const m of text.matchAll(/--([a-z0-9-]+)\s*:\s*([^;]+);/gi)) {
    map.set(m[1], m[2].trim());
  }
  return map;
}

/** 解析 var(--x)（可能嵌套），解析不到就原样返回 */
function resolve(name, vars, depth = 0) {
  if (depth > 10) return null;
  const raw = vars.get(name);
  if (!raw) return null;
  const ref = raw.match(/^var\(\s*--([a-z0-9-]+)\s*\)$/i);
  if (ref) return resolve(ref[1], vars, depth + 1);
  const hex = raw.match(/^#([0-9a-f]{3,8})$/i);
  if (hex) {
    let h = hex[1];
    if (h.length === 3) h = h.split('').map((c) => c + c).join('');
    if (h.length === 6) return `#${h.toLowerCase()}`;
    if (h.length === 8) return `#${h.slice(0, 6).toLowerCase()}`; // 忽略 alpha：这里都是不透明底色
  }
  const rgb = raw.match(/^rgba?\(\s*(\d+)[ ,]+(\d+)[ ,]+(\d+)/i);
  if (rgb) return `#${[1, 2, 3].map((i) => Number(rgb[i]).toString(16).padStart(2, '0')).join('')}`;
  return null;
}

function luminance(hex) {
  const [r, g, b] = hex.replace('#', '').match(/../g).map((x) => parseInt(x, 16) / 255)
    .map((v) => (v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4));
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

function ratio(a, b) {
  const [x, y] = [luminance(a), luminance(b)].sort((p, q) => q - p);
  return (x + 0.05) / (y + 0.05);
}

// 语义组合：fg 变量 / bg 变量 / 最小比值 / 是否守卫
// 4.5 = 普通字号 AA；3.0 只允许大字/图标/纯装饰
const PAIRS = [
  // —— 浅色：必须达标 ——
  { mode: 'light', fg: 'text', bg: 'card', min: 4.5, guard: true, note: '正文' },
  { mode: 'light', fg: 'text-2', bg: 'card', min: 4.5, guard: true, note: '次要文字（会话预览/副标题）' },
  { mode: 'light', fg: 'text-2', bg: 'bg', min: 4.5, guard: true, note: '次要文字（灰底：成员数/未激活 Tab）' },
  { mode: 'light', fg: 'text-3', bg: 'bg', min: 4.5, guard: true, note: '三级文字（11px 时间戳/日期分隔/占位）' },
  { mode: 'light', fg: 'composer-hint-fg', bg: 'bg', min: 4.5, guard: true, note: '输入栏提示' },
  { mode: 'light', fg: 'badge-dot-fg', bg: 'badge-dot-bg', min: 4.5, guard: true, note: '未读徽标' },
  { mode: 'light', fg: 'ai', bg: 'ai-weak', min: 4.5, guard: true, note: 'AI 徽标' },
  // —— 深色：必须达标 ——
  { mode: 'dark', fg: 'text', bg: 'card', min: 4.5, guard: true, note: '正文' },
  { mode: 'dark', fg: 'text-2', bg: 'card', min: 4.5, guard: true, note: '次要文字' },
  { mode: 'dark', fg: 'text-3', bg: 'bg', min: 4.5, guard: true, note: '三级文字' },
  { mode: 'dark', fg: 'ai', bg: 'ai-weak', min: 4.5, guard: true, note: 'AI 徽标（曾漏覆盖 → 1.97）' },
  // —— 自己气泡：微信浅绿底 + 深色字，现在必须达标（之前蓝底白字只有 3.00） ——
  { mode: 'light', fg: 'bubble-self-fg', bg: 'bubble-self', min: 4.5, guard: true, note: '自己气泡' },
  { mode: 'dark', fg: 'bubble-self-fg', bg: 'bubble-self', min: 4.5, guard: true, note: '自己气泡（深色）' },
  // —— 品牌色：不守卫，只提醒（主按钮仍是品牌蓝，白字 3.0，改它要先做设计决定） ——
  { mode: 'light', fg: 'badge-dot-fg', bg: 'primary', min: 4.5, guard: false, note: '主按钮白字' },
];

const lightVars = readVars(LIGHT);
const darkVars = new Map([...lightVars, ...readVars(DARK)]);

let failed = 0;
let warned = 0;
for (const pair of PAIRS) {
  const vars = pair.mode === 'dark' ? darkVars : lightVars;
  const fg = resolve(pair.fg, vars);
  const bg = resolve(pair.bg, vars);
  const label = `[${pair.mode === 'dark' ? '深' : '浅'}] ${pair.note}  --${pair.fg} on --${pair.bg}`;
  if (!fg || !bg) {
    console.log(`⚠️  ${label}：变量解析不到（fg=${fg} bg=${bg}）`);
    warned += 1;
    continue;
  }
  const r = ratio(fg, bg);
  const ok = r >= pair.min;
  const line = `${ok ? '✅' : (pair.guard ? '❌' : '⚠️')} ${label} = ${r.toFixed(2)}:1（需 ${pair.min}）${ok ? '' : ` ${fg} / ${bg}`}`;
  if (!ok && pair.guard) { failed += 1; console.log(line); }
  else if (!ok) { warned += 1; console.log(line); }
  else console.log(line);
}

console.log(`\n对比度守卫：${failed === 0 ? '通过' : `${failed} 项不达标`}（另有 ${warned} 项提醒：品牌色/解析失败）`);
if (failed) {
  console.log('修法：只改 web/src/styles/01-tokens.css 或 18-dark.css 的 :root 值；不要改组件。');
  process.exit(1);
}
