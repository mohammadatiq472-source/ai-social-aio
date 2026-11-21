// 样式色值守卫（评审 §4-7）：组件样式里不许再出现字面色值，只许用 var(--token)。
//
// 允许写字面色值的地方只有两处：
//   1. web/src/styles/01-tokens.css —— 浅色 token 定义
//   2. web/src/styles/18-dark.css 的 :root { } —— 深色 token 值
// 其它文件/其它位置出现 #rrggbb / rgba(...) 的字面 hex 一律失败（渐变里的也算）。
//
// 为什么要有这个门：以前暗色靠 18-dark.css 48 处逐组件覆盖，每加一个组件就多一处漏网；
// 现在颜色只有 token 一个入口，新组件天然跟着深色走，这个脚本防止回退。
//
// 用法：node scripts/check-style-tokens.mjs
import fs from 'node:fs';
import path from 'node:path';

const ROOT = path.join(import.meta.dirname, '..');
const DIR = path.join(ROOT, 'web', 'src', 'styles');
const HEX = /#[0-9a-fA-F]{3,8}\b/g;

/** 把 18-dark.css 的 :root 块替换成空白，剩下的部分才接受检查 */
function stripDarkRoot(source) {
  return source.replace(/:root\s*\{[^}]*\}/, (block) => block.replace(/[^\n]/g, ' '));
}

// 服务器上只部署 web/dist（没有 web/src）：这是开发侧守卫，缺目录就明确跳过而不是报错
if (!fs.existsSync(DIR)) {
  console.log(`样式色值守卫：跳过（没有 ${path.relative(ROOT, DIR)}；本检查只在开发仓库运行）`);
  process.exit(0);
}

const violations = [];
let tokenCount = 0;

for (const file of fs.readdirSync(DIR).filter((f) => f.endsWith('.css')).sort()) {
  const full = path.join(DIR, file);
  let text = fs.readFileSync(full, 'utf8');
  if (file === '01-tokens.css') {
    tokenCount += (text.match(HEX) || []).length;
    continue;
  }
  if (file === '18-dark.css') {
    tokenCount += (text.match(HEX) || []).length - (stripDarkRoot(text).match(HEX) || []).length;
    text = stripDarkRoot(text);
  }
  const lines = text.split('\n');
  lines.forEach((line, i) => {
    for (const hit of line.match(HEX) || []) {
      violations.push(`${file}:${i + 1}  ${hit}  — ${line.trim().slice(0, 90)}`);
    }
  });
}

if (violations.length) {
  console.error(`样式色值守卫：发现 ${violations.length} 处字面色值（只许写在 01-tokens.css 或 18-dark.css 的 :root 里）`);
  for (const v of violations.slice(0, 40)) console.error('  ' + v);
  process.exitCode = 1;
} else {
  console.log(`样式色值守卫：通过（token 定义 ${tokenCount} 个色值；组件样式零字面色值）`);
}
