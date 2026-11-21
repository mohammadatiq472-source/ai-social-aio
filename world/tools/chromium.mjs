// 跨平台定位 Chromium：从环境变量 → Playwright 缓存目录 → 系统默认，逐级回退。
//
// 为什么需要这个文件：之前 19 个验收脚本各自写死了本机绝对路径
// （形如 `<LOCALAPPDATA>\ms-playwright\chromium-<版本>\chrome-win64\chrome.exe`）。
// 后果有三个，都很实际：
//   1. 换一台机器全部失效（路径不存在）
//   2. 公开仓库会泄漏本机用户名与目录结构（发布扫描器会拦）
//   3. Playwright 升级后版本号变了（1217 → 1255）又要改 19 处
//
// 优先级：显式环境变量 > Playwright 已安装的浏览器 > 系统 Chrome/Edge。
import { existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { homedir, platform } from 'node:os';

/** Playwright 浏览器缓存根目录（各平台默认位置）。 */
function playwrightCacheDirs() {
  const env = process.env.PLAYWRIGHT_BROWSERS_PATH;
  if (env) return [env];
  const home = homedir();
  if (platform() === 'win32') {
    return [
      join(process.env.LOCALAPPDATA ?? join(home, 'AppData', 'Local'), 'ms-playwright'),
      join(home, '.cache', 'ms-playwright'),
    ];
  }
  if (platform() === 'darwin') return [join(home, 'Library', 'Caches', 'ms-playwright')];
  return [join(home, '.cache', 'ms-playwright')];
}

/** 在 Playwright 缓存里找最新的 chromium（按目录名版本号倒序）。 */
function findPlaywrightChromium() {
  for (const root of playwrightCacheDirs()) {
    if (!existsSync(root)) continue;
    let dirs;
    try {
      dirs = readdirSync(root).filter((d) => d.startsWith('chromium-'));
    } catch {
      continue;
    }
    // 版本号倒序：chromium-1255 优先于 chromium-1217
    dirs.sort((a, b) => {
      const na = Number(a.split('-')[1]) || 0;
      const nb = Number(b.split('-')[1]) || 0;
      return nb - na;
    });
    for (const d of dirs) {
      const candidates =
        platform() === 'win32'
          ? [join(root, d, 'chrome-win64', 'chrome.exe'), join(root, d, 'chrome-win', 'chrome.exe')]
          : platform() === 'darwin'
            ? [join(root, d, 'chrome-mac', 'Chromium.app', 'Contents', 'MacOS', 'Chromium')]
            : [join(root, d, 'chrome-linux', 'chrome')];
      for (const c of candidates) {
        if (existsSync(c)) return c;
      }
    }
  }
  return null;
}

/** 系统安装的 Chrome / Edge（最后兜底）。 */
function findSystemBrowser() {
  if (platform() === 'win32') {
    const candidates = [
      join(process.env.PROGRAMFILES ?? 'C:\\Program Files', 'Google', 'Chrome', 'Application', 'chrome.exe'),
      join(
        process.env['PROGRAMFILES(X86)'] ?? 'C:\\Program Files (x86)',
        'Google',
        'Chrome',
        'Application',
        'chrome.exe',
      ),
      join(process.env.LOCALAPPDATA ?? '', 'Google', 'Chrome', 'Application', 'chrome.exe'),
      join(process.env.PROGRAMFILES ?? 'C:\\Program Files', 'Microsoft', 'Edge', 'Application', 'msedge.exe'),
    ];
    return candidates.find((c) => c && existsSync(c)) ?? null;
  }
  if (platform() === 'darwin') {
    const c = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
    return existsSync(c) ? c : null;
  }
  for (const c of ['/usr/bin/google-chrome', '/usr/bin/chromium', '/usr/bin/chromium-browser']) {
    if (existsSync(c)) return c;
  }
  return null;
}

/**
 * 解析可用的浏览器可执行文件路径。
 * @returns {{ path: string, source: string } | null} 找不到时返回 null（调用方给可读错误）
 */
export function resolveChromium() {
  // 1. 显式指定优先（CI / 特殊环境用）
  for (const key of ['CHROMIUM_PATH', 'PUPPETEER_EXECUTABLE_PATH', 'CHROME_PATH']) {
    const v = process.env[key];
    if (v && existsSync(v)) return { path: v, source: `env:${key}` };
  }
  // 2. Playwright 自带的
  const pw = findPlaywrightChromium();
  if (pw) return { path: pw, source: 'playwright' };
  // 3. 系统浏览器
  const sys = findSystemBrowser();
  if (sys) return { path: sys, source: 'system' };
  return null;
}

/**
 * 给 `chromium.launch()` 用的标准参数。
 *
 * 为什么必须带这几个：
 * - `--no-sandbox`：容器/CI 里没有用户命名空间
 * - `--use-gl=swiftshader --enable-unsafe-swiftshader`：无 GPU 环境用软件光栅
 * - `--enable-precise-memory-info`：P12 的内存用例需要
 * - `--js-flags=--expose-gc`：P12 必须能强制 GC，否则堆增量在 0.5MB~16MB 乱跳
 */
export const LAUNCH_ARGS = [
  '--no-sandbox',
  '--use-gl=swiftshader',
  '--enable-unsafe-swiftshader',
  '--enable-precise-memory-info',
  '--js-flags=--expose-gc',
];

/** 解析 + 参数，一步到位。找不到浏览器时抛出可读错误。 */
export function chromiumLaunchOptions() {
  const found = resolveChromium();
  if (!found) {
    throw new Error(
      '找不到 Chromium。请任选一种方式：\n' +
        '  1) 设置环境变量 CHROMIUM_PATH=/path/to/chrome\n' +
        '  2) 运行 npx playwright install chromium\n' +
        '  3) 安装系统版 Chrome',
    );
  }
  return { executablePath: found.path, args: LAUNCH_ARGS };
}
