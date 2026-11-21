#!/usr/bin/env node
/**
 * M10 交互的**浏览器内**验收（spec §6 M10）。
 *
 * 为什么不能只靠单测：`src/interact/player.test.ts` 证明了"判定 + 接线"在 node 里对，
 * 但 M10 的验收原文是「走近椅子按键坐下、起身；走向箱子能推动；看向某角色时名字高亮」——
 * 主语是**页面上的玩家**。单测里没有键盘事件、没有渲染、没有 6 个 Agent。
 *
 * 这个脚本断言 6 条：
 *   1. 页面加载后 `__worldDebug` / `__interactDebug` 都在（接线真的装上了）
 *   2. 走近座位（WASD 走）→ 按 E → 状态变 sitting，且位置吸附到座位（<5cm）
 *   3. 坐着时按 W 前进 → 位置几乎不动（移动被禁用），但 y 不漂（物理仍在跑）
 *   4. 再按 E → 状态回 free，位置在座位前方
 *   5. 走向箱子 → 箱子被推动（位置变化 > 0.2m）
 *   6. 点击角色 → 相机焦点切过去（1s 内到位）
 *
 * **未验证项（必须如实列出）**：
 *   - 「坐/起切换**不穿模**」：穿模是视觉现象，需要人眼或几何相交检测。
 *     这个脚本只断言"位置吸附到了座位坐标"，**不能**证明模型没有嵌进椅子。
 *     原因：座位在 v0.1 不是实体几何（`RoomSeat` 只有 pos/rot，没有尺寸），
 *     没有可相交的网格，几何相交检测无从做起。→ 标注"未验证，需人眼"。
 *   - 「推箱自然」：脚本只断言"箱子位移 > 0.2m"，推起来是否自然（不飞、不抖）需人眼。
 *   - 「看向某角色时名字高亮」：spec 的验收原文包含名字高亮，但 v0.1 的 HUD
 *     没有实现高亮（`render/hud.ts` 只有 setName/showBubble）。→ 如实标"未实现"。
 *
 * 用法：
 *   node tools/verify-interact.mjs                 # 自动起 dev server
 *   node tools/verify-interact.mjs --url http://127.0.0.1:5173/
 *   node tools/verify-interact.mjs --shots tmp/interact   # 顺便存截图（人眼复核用）
 *
 * 退出码：0 = 全部通过；1 = 有断言失败；2 = 环境问题（起不来/找不到 chromium）。
 */

import { chromium } from '@playwright/test';
import { chromiumLaunchOptions } from './chromium.mjs';
import { spawn } from 'node:child_process';
import { setTimeout as sleep } from 'node:timers/promises';
import { existsSync, mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const WORLD_ROOT = resolve(HERE, '..');

const argv = process.argv.slice(2);
const opt = (name, dflt) => {
  const i = argv.indexOf(`--${name}`);
  return i >= 0 && argv[i + 1] ? argv[i + 1] : dflt;
};

const EXPLICIT_URL = opt('url', null);
const SHOTS_DIR = opt('shots', null);

// 浏览器路径统一由 chromium.mjs 解析（env → Playwright 缓存 → 系统 Chrome）。
// 不在本文件写死路径：换机器/换 Playwright 版本都会失效，且会泄漏本机目录结构。

// ───────────────────────────── 断言框架 ─────────────────────────────

const results = [];
function check(name, ok, detail = '') {
  results.push({ name, ok, detail });
  console.log(`${ok ? '✓' : '✗'} ${name}${detail ? `  ${detail}` : ''}`);
}
function skip(name, reason) {
  results.push({ name, ok: null, detail: reason });
  console.log(`⊘ ${name}  [未验证] ${reason}`);
}

// ───────────────────────────── 工具 ─────────────────────────────

async function waitForStableRender(page) {
  // 坑（Lead 审计 §3.1）：headless SwiftShader 在页面加载初期会有一次
  // webglcontextlost → webglcontextrestored（约 1 秒空窗）。
  // 空窗里读 drawCalls 会拿到 0、截图会全黑，极易误判成"渲染坏了"。
  // 必须等 context 不再丢失，再等 6 秒让画面稳定。
  await page.waitForFunction(
    () => {
      const c = document.querySelector('canvas');
      if (!c) return false;
      const gl = c.getContext('webgl2');
      return !!gl && !gl.isContextLost();
    },
    null,
    { timeout: 30_000 },
  );
  await sleep(6000);
}

/** 读页面内状态（所有断言的数据源都在这里，不猜）。 */
async function readState(page) {
  return page.evaluate(() => {
    const d = window.__worldDebug?.read?.() ?? {};
    const i = window.__interactDebug?.read?.() ?? {};
    return { debug: d, interact: i };
  });
}

/**
 * 等探针就绪。
 *
 * 踩过的坑：`__interactDebug` 是在**物理就绪 + 玩家控制器 + 6 Agent 化身**之后
 * 才挂上的（异步链，实测约 5~6 秒）。早先脚本在 waitForStableRender（固定 6 秒）
 * 之后立刻读，偶尔会拿到 undefined，于是误报"M10 还没接进 main.ts"。
 * 正确做法是**显式等它出现**，而不是赌某个固定时长。
 */
async function waitForProbes(page, timeoutMs = 30_000) {
  await page.waitForFunction(
    () =>
      typeof window.__worldDebug?.read === 'function' &&
      typeof window.__interactDebug?.read === 'function',
    null,
    { timeout: timeoutMs },
  );
}

/** 按住若干键 ms 毫秒后松开（模拟真人走一段）。 */
async function holdKeys(page, keys, ms) {
  for (const k of keys) await page.keyboard.down(k);
  await sleep(ms);
  for (const k of keys) await page.keyboard.up(k);
  await sleep(120); // 让减速/落地稳定一帧
}

// ───────────────────────────── 主流程 ─────────────────────────────

async function main() {
  let vite = null;
  let baseUrl = EXPLICIT_URL;

  if (!baseUrl) {
    // 用 0 让系统分配空闲端口，而不是固定 5187。
    // 踩过的坑：固定端口 + 上一次运行残留的 vite 进程 → strictPort 冲突，
    // 新进程立刻退出，脚本连上的还是旧进程，中途被替换就报
    // "Execution context was destroyed"（看起来像页面崩了，其实是端口打架）。
    vite = spawn(
      process.execPath,
      ['./node_modules/vite/bin/vite.js', '--port', '0', '--strictPort'],
      { cwd: WORLD_ROOT, stdio: ['ignore', 'pipe', 'pipe'] },
    );

    // 从 vite 的 stdout 里解析真实端口（"--port 0" 时它会打印 Local: http://...:PORT/）
    baseUrl = await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('vite 启动超时（15s）')), 15_000);
      let buf = '';
      const onData = (chunk) => {
        buf += String(chunk);
        const m = /Local:\s+(http:\/\/[^\s]+)/.exec(buf);
        if (m) {
          clearTimeout(timer);
          // 归一化成带尾斜杠的基址
          resolve(m[1].endsWith('/') ? m[1] : `${m[1]}/`);
        }
      };
      vite.stdout.on('data', onData);
      vite.stderr.on('data', onData);
      vite.on('exit', (code) => {
        clearTimeout(timer);
        reject(new Error(`vite 提前退出（code=${code}）：\n${buf.slice(-500)}`));
      });
    });
  }

  if (SHOTS_DIR) mkdirSync(SHOTS_DIR, { recursive: true });

  console.log('M10 交互验收（浏览器内）');
  console.log(`目标：${baseUrl}`);
  console.log('─'.repeat(68));

  let browser = null;
  try {
    browser = await chromium.launch({
      executablePath: chromiumLaunchOptions().executablePath,
      args: ['--no-sandbox', '--use-gl=swiftshader', '--enable-unsafe-swiftshader'],
    });
    const page = await browser.newPage({ viewport: { width: 1280, height: 720 } });
    const pageErrors = [];
    page.on('pageerror', (e) => pageErrors.push(String(e.message)));

    await page.goto(baseUrl, { waitUntil: 'load' });
    await waitForStableRender(page);
    // 探针是异步链挂上的（物理 → 控制器 → 化身，实测 ~6s），必须显式等
    await waitForProbes(page);

    // ── 1. 探针都在 ──
    const probe = await page.evaluate(() => ({
      worldDebug: typeof window.__worldDebug?.read === 'function',
      interactDebug: typeof window.__interactDebug?.read === 'function',
    }));
    check('接线已装载：__worldDebug + __interactDebug 都存在', probe.worldDebug && probe.interactDebug,
      `worldDebug=${probe.worldDebug} interactDebug=${probe.interactDebug}`);

    if (!probe.interactDebug) {
      throw new Error(
        '__interactDebug 不存在：M10 还没接进 main.ts，或构建把探针摇掉了。' +
          '这是本脚本能给出结论的前提，后面的断言全部无从谈起。',
      );
    }

    let state = await readState(page);
    const seats = state.interact.seats ?? [];
    const props = state.interact.props ?? [];
    check('房间里有座位（否则"走近椅子坐下"无从验收）', seats.length > 0, `${seats.length} 把`);
    check('房间里有可推动的箱子', props.length > 0, `${props.length} 个`);

    if (SHOTS_DIR) await page.screenshot({ path: `${SHOTS_DIR}/m10-1-boot.png` });

    // ── 2. 走近座位 + 按 E 坐下 ──
    // 座位在 ±1.9m（rooms/demo-room.ts）。出生在原点，朝 -z 是相机的正前方。
    // 用 __interactDebug 的 walkToSeat 辅助直接驱动"朝座位走"，
    // 比在脚本里拼 WASD 组合稳定得多（相机 yaw 会影响 WASD 的世界方向）。
    const walkOk = await page.evaluate(() => {
      const api = window.__interactDebug;
      return typeof api?.walkToNearestSeat === 'function';
    });
    check('有 walkToNearestSeat 辅助（脚本驱动走位，不靠猜按键方向）', walkOk === true);

    if (walkOk) {
      const approached = await page.evaluate(async () => {
        return await window.__interactDebug.walkToNearestSeat(4000);
      });
      check(
        '走近座位：进入了 1.2m 交互范围',
        approached?.inReach === true,
        `距离 ${approached?.dist?.toFixed?.(2) ?? '?'}m`,
      );

      if (SHOTS_DIR) await page.screenshot({ path: `${SHOTS_DIR}/m10-2-near-seat.png` });

      // 按 E
      await page.keyboard.press('KeyE');
      await sleep(300);
      state = await readState(page);
      check('按 E → 进入 sitting', state.interact.mode === 'sitting', `mode=${state.interact.mode}`);

      // 吸附位置
      const snap = state.interact;
      const seat = snap.seatPos;
      const pos = snap.heroPos;
      if (seat && pos) {
        const d = Math.hypot(pos[0] - seat[0], pos[2] - seat[2]);
        check('坐姿吸附到座位（水平误差 < 5cm）', d < 0.05, `${(d * 100).toFixed(1)}cm`);
        // 注意口径：heroPos 是**脚底**（探针已减去胶囊中心 0.85），
        // 所以坐姿时脚底应落在座位平面上（座位 y 通常为 0）。
        // 胶囊中心在 seat.y + 0.85，这个换算由 probe 的 feetOf() 做掉，
        // 这里直接断言"脚在座位高度上"才是可读的验收口径。
        const dyFeet = Math.abs(pos[1] - seat[1]);
        check('坐姿脚底落在座位平面（误差 < 5cm）', dyFeet < 0.05, `${(dyFeet * 100).toFixed(1)}cm`);
        // 交叉验证换算没写反：实体表里的 y（胶囊中心）必须比脚底高 0.85
        if (typeof snap.heroCenterY === 'number') {
          const gap = snap.heroCenterY - pos[1];
          check(
            '胶囊中心比脚底高 0.85m（换算没写反）',
            Math.abs(gap - 0.85) < 0.02,
            `${gap.toFixed(3)}m`,
          );
        }
      } else {
        check('坐姿吸附到座位', false, '探针没给 seatPos/heroPos');
      }

      if (SHOTS_DIR) await page.screenshot({ path: `${SHOTS_DIR}/m10-3-sitting.png` });

      // ── 3. 坐着时移动被禁用，但物理仍在跑 ──
      const beforeMove = (await readState(page)).interact.heroPos;
      await holdKeys(page, ['KeyW'], 1200);
      const afterMove = (await readState(page)).interact.heroPos;
      if (beforeMove && afterMove) {
        const moved = Math.hypot(afterMove[0] - beforeMove[0], afterMove[2] - beforeMove[2]);
        check('坐着时按 W：移动被禁用（水平位移 < 5cm）', moved < 0.05, `${(moved * 100).toFixed(1)}cm`);
        const dyDrift = Math.abs(afterMove[1] - beforeMove[1]);
        check('坐着时物理仍在跑（y 不漂，< 2cm）', dyDrift < 0.02, `${(dyDrift * 100).toFixed(1)}cm`);
      }

      // ── 4. 再按 E 起身 ──
      await page.keyboard.press('KeyE');
      await sleep(400);
      state = await readState(page);
      check('再按 E → 回到 free', state.interact.mode === 'free', `mode=${state.interact.mode}`);

      const standPos = state.interact.heroPos;
      if (seat && standPos) {
        const d = Math.hypot(standPos[0] - seat[0], standPos[2] - seat[2]);
        check('起身后站到座位前方（离座位 0.3~1.0m）', d > 0.3 && d < 1.0, `${d.toFixed(2)}m`);
      }

      if (SHOTS_DIR) await page.screenshot({ path: `${SHOTS_DIR}/m10-4-stood.png` });
    }

    // ── 5. 推箱 ──
    const pushOk = await page.evaluate(() => typeof window.__interactDebug?.pushNearestProp === 'function');
    if (pushOk) {
      const pushed = await page.evaluate(async () => {
        return await window.__interactDebug.pushNearestProp(5000);
      });
      check(
        '走向箱子 → 箱子被物理推动（位移 > 0.2m）',
        (pushed?.moved ?? 0) > 0.2,
        `位移 ${pushed?.moved?.toFixed?.(2) ?? '?'}m`,
      );
      if (SHOTS_DIR) await page.screenshot({ path: `${SHOTS_DIR}/m10-5-push.png` });
    } else {
      check('推箱验收辅助存在', false, '缺少 pushNearestProp');
    }

    // ── 6. 焦点切换 ──
    const focusOk = await page.evaluate(() => typeof window.__interactDebug?.focusAgent === 'function');
    if (focusOk) {
      const focus = await page.evaluate(async () => {
        return await window.__interactDebug.focusAgent(0);
      });
      check('点击角色 → 相机焦点切过去', focus?.focused === true, `目标 ${focus?.target ?? '?'}`);
      check(
        '焦点缓动 1s 内到位',
        focus?.progress >= 1,
        `progress=${focus?.progress?.toFixed?.(2) ?? '?'}，耗时 ${focus?.elapsedMs ?? '?'}ms`,
      );
      if (SHOTS_DIR) await page.screenshot({ path: `${SHOTS_DIR}/m10-6-focus.png` });
    } else {
      check('焦点切换验收辅助存在', false, '缺少 focusAgent');
    }

    // ── 页面错误 ──
    check('全程无 pageerror', pageErrors.length === 0, pageErrors.join(' | '));

    // ── 未验证项（如实列出，不与"通过"混在一起）──
    console.log('');
    console.log('未验证项（需要人眼或 v0.1 未实现）：');
    skip(
      '坐/起切换**不穿模**',
      '座位在 v0.1 不是实体几何（RoomSeat 只有 pos/rot，无尺寸），没有可相交网格；' +
        '只能证明"位置吸附到座位坐标"，不能证明模型没嵌进椅子',
    );
    skip('推箱**自然**（不飞、不抖）', '脚本只断言位移量，观感需人眼');
    skip('看向某角色时**名字高亮**', 'render/hud.ts 只有 setName/showBubble，v0.1 未实现高亮');
  } finally {
    await browser?.close();
    vite?.kill();
  }

  // ───────────────────────────── 汇总 ─────────────────────────────
  const pass = results.filter((r) => r.ok === true).length;
  const fail = results.filter((r) => r.ok === false).length;
  const skipped = results.filter((r) => r.ok === null).length;

  console.log('');
  console.log('─'.repeat(68));
  console.log(`通过 ${pass} / 失败 ${fail} / 未验证 ${skipped}`);
  if (fail > 0) {
    console.error('✗ 有断言失败');
    process.exit(1);
  }
  console.log(`✓ 全部通过：${pass}/${pass}`);
  if (skipped > 0) {
    console.log(`  （另有 ${skipped} 项未验证，见上面 ⊘ 行——它们不计入通过数）`);
  }
}

main().catch((err) => {
  console.error('✗ 验收脚本异常：', err?.message ?? err);
  process.exit(2);
});
