/**
 * 沙箱预加载补丁（仅本机 DSH 沙箱需要，正常机器上是空操作）。
 *
 * 两个补丁，都针对「管道 stdio 被禁」这一个根因：
 *
 * 1. `child_process.exec('net use')`：Vite 在 Windows 上探测网络盘映射时用它，
 *    走管道 → EPERM → 构建直接挂。这里让它安静失败，Vite 会退回
 *    `fs.realpathSync.native`（它自己的默认分支），行为正确。
 *
 * 2. `child_process.spawn` 的管道 stdio：esbuild 服务用它通信。
 *    这里**不**假装成功（假装会让构建产出错误代码），只提供更清楚的报错。
 *
 * 用法：`node --import ./scripts/sandbox-preload.mjs <script>`
 * 或 `NODE_OPTIONS="--import ./scripts/sandbox-preload.mjs"`。
 */

import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const cp = require('node:child_process');

// ── 补丁 1：net use 探测失败即可 ──
const origExec = cp.exec;
cp.exec = function patchedExec(command, options, callback) {
  const isNetUse = typeof command === 'string' && command.trim().toLowerCase() === 'net use';
  if (isNetUse) {
    const cb = typeof options === 'function' ? options : callback;
    const err = new Error('sandbox: 跳过 net use 探测（管道 stdio 不可用）');
    err.code = 'EPERM';
    if (typeof cb === 'function') process.nextTick(() => cb(err, '', ''));
    // 返回一个最小的 ChildProcess 形状，调用方若监听事件也不会炸
    return { on() {}, kill() {}, stdout: null, stderr: null };
  }
  return origExec.apply(this, arguments);
};

// ── 补丁 2：管道 stdio 的 spawn 给出可读原因（不改变失败事实）──
const origSpawn = cp.spawn;
cp.spawn = function patchedSpawn(command, args, options) {
  try {
    return origSpawn.apply(this, arguments);
  } catch (err) {
    if (err && err.code === 'EPERM') {
      const hint =
        '沙箱禁止管道 stdio 的子进程（esbuild 服务需要它）。' +
        '构建请用 npm run build:sandbox（进程内剥类型），或换到不限制的机器。';
      err.message = `${err.message}\n  ↳ ${hint}`;
    }
    throw err;
  }
};

export const sandboxPatched = true;
