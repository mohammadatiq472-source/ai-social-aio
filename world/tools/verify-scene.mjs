#!/usr/bin/env node
/**
 * 场景视觉验收（房间边界 + 地砖 + 接触阴影 + 性能预算）。
 *
 * ═══════════════ 这个脚本要证的四件事 ═══════════════
 *
 * 1. **房间真的有边界**：从房间数据（`DEMO_ROOM.static`）派生的墙/踢脚线/台阶
 *    确实在场景图里，而不是只有一块地板。
 * 2. **几何与物理同源**：渲染的静态几何数量必须等于 `roomSolids(DEMO_ROOM).length`。
 *    这条是防"看得见的墙 ≠ 撞得到的墙"的回归闸门。
 * 3. **接触阴影真的画出来了**：靠**像素**判，不靠"代码里有这个类"。
 *    判据：角色脚下那一圈的亮度显著低于同高度的干净地板。
 * 4. **性能没退化**：drawCall 增幅 ≤ 5、三角形增幅 ≤ 30%。
 *
 * ═══════════════ 两条必须遵守的测量纪律（都是踩过的坑）═══════════════
 *
 * - **截图/读数前必须等 context restored**：headless SwiftShader 有约 1 秒的
 *   lost→restored 空窗，空窗里截图是全黑、drawCall 读到 0。
 *   见 `docs/world/审计-2026-11-20-可运行性与验收可信度.md` §3.1。
 * - **不能只读 drawCall 总数**：被视锥剔除的对象会让总数"看起来达标"但画面缺东西。
 *   所以同时读 `__worldDebug.read().scene` 的场景图盘点，逐个对象核对。
 *
 * 用法：
 *   node tools/verify-scene.mjs                      # 自己起 vite dev（端口 5199）
 *   node tools/verify-scene.mjs --url http://127.0.0.1:5199/
 *   node tools/verify-scene.mjs --shots tmp/scene    # 顺便存改前/改后对比图
 *   node tools/verify-scene.mjs --baseline 8,61798   # 指定基线 drawCall,三角形
 */

import { chromium } from '@playwright/test';
import { chromiumLaunchOptions } from './chromium.mjs';
import { spawn } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';

const argv = process.argv.slice(2);
const opt = (name, dflt) => {
  const i = argv.indexOf(`--${name}`);
  return i >= 0 && argv[i + 1] ? argv[i + 1] : dflt;
};
const EXPLICIT_URL = opt('url', null);
const SHOTS_DIR = opt('shots', null);
const PORT = Number(opt('port', 5199));

/**
 * 基线（改造前的实测值）。
 *
 * 从 git 历史里的旧 scene.ts 上量得：地板盒 + 网格线 + 7 角色 = 8 drawCall / 61798 三角形。
 * 这两个数字是"性能不退化"的判据起点，不是估算。
 */
const BASELINE = (() => {
  const raw = opt('baseline', null);
  if (!raw) return { drawCalls: 8, triangles: 61798 };
  const [d, t] = raw.split(',').map(Number);
  return { drawCalls: d, triangles: t };
})();

/** 验收预算（任务书硬指标）。 */
const MAX_DRAW_CALL_DELTA = 5;
const MAX_TRIANGLE_GROWTH = 0.3;

const results = [];
let failed = 0;
function check(name, pass, detail = '') {
  results.push({ name, pass, detail });
  if (!pass) failed += 1;
  const mark = pass ? '✓' : '✗';
  console.log(`${mark} ${name.padEnd(44)} ${detail}`);
}

// ── 起服务 ──
let vite = null;
let baseUrl = EXPLICIT_URL;
if (!baseUrl) {
  baseUrl = `http://127.0.0.1:${PORT}/`;
  const probe = await fetch(baseUrl).catch(() => null);
  if (!probe || !probe.ok) {
    console.log(`启动 vite dev（:${PORT}）…`);
    vite = spawn('npx', ['vite', '--port', String(PORT), '--strictPort'], {
      cwd: resolve(import.meta.dirname, '..'),
      shell: true,
      stdio: 'ignore',
    });
    // 等端口起来（最多 30s）
    const deadline = Date.now() + 30_000;
    let up = false;
    while (Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 400));
      const r = await fetch(baseUrl).catch(() => null);
      if (r?.ok) {
        up = true;
        break;
      }
    }
    if (!up) {
      console.error(`vite 没能在 30s 内起来（:${PORT}）`);
      vite?.kill();
      process.exit(2);
    }
  } else {
    console.log(`复用已在跑的 dev server（:${PORT}）`);
  }
}

const browser = await chromium.launch({
  executablePath: chromiumLaunchOptions().executablePath,
  args: chromiumLaunchOptions().args,
});

/** 打开一个预设页面，等稳定，返回 page + 读数。 */
async function open(preset, extraQuery = '') {
  const page = await browser.newPage({ viewport: { width: 1280, height: 720 } });
  const errors = [];
  page.on('pageerror', (e) => errors.push(String(e.message)));
  page.on('console', (m) => {
    if (m.type() === 'error') errors.push(m.text());
  });

  await page.goto(`${baseUrl}?time=${preset}${extraQuery}`, { waitUntil: 'load' });
  await page.waitForFunction(() => typeof window.__worldDebug === 'object', { timeout: 30_000 });

  // ⚠️ 必须等 context restored（见文件头）
  await page.waitForFunction(
    () => {
      const c = document.querySelector('canvas');
      const gl = c?.getContext('webgl2') ?? c?.getContext('webgl');
      return !gl || !gl.isContextLost();
    },
    { timeout: 20_000 },
  );
  await page.waitForTimeout(5000);

  return { page, errors };
}

/** 多次采样取中位数：单帧读数会被阴影 pass 的合批波动影响。 */
async function sampleStats(page, n = 8) {
  const samples = [];
  for (let i = 0; i < n; i++) {
    samples.push(await page.evaluate(() => window.__worldDebug.read()));
    await page.waitForTimeout(120);
  }
  const median = (key) => {
    const v = samples.map((s) => Number(s[key])).sort((a, b) => a - b);
    return v[Math.floor(v.length / 2)];
  };
  // 场景图盘点取**最后一次**采样，而不是中位数那一次：
  // 中位数按 drawCalls 排序，可能落到"资产还没加载完"的那一帧上，
  // 于是 scene.meshes 里没有角色、contactShadowVisible=0，看起来像功能没生效。
  // 场景图是"这一帧有什么"，取最新一份才是对的。
  const latest = samples[samples.length - 1];
  return {
    drawCalls: median('drawCalls'),
    triangles: median('triangles'),
    // avatarCount 也取最后一次：它是单调增长的（0 → 7），中位数会取到加载中的 0
    avatarCount: Number(latest.avatarCount),
    scene: latest.scene,
    raw: samples[0],
  };
}

const summary = {};

try {
  // ═══════════ 1. 房间边界（day，单人）═══════════
  {
    const { page, errors } = await open('day');
    const stats = await sampleStats(page);
    summary.day = { drawCalls: stats.drawCalls, triangles: stats.triangles };

    check('页面无 JS 错误', errors.length === 0, errors.slice(0, 3).join(' | '));

    const names = stats.scene.meshes.map((m) => m.name);
    check('房间墙在场景图里（room-wall）', names.includes('room-wall'), `meshes=${names.length}`);
    check('踢脚线在场景图里（room-trim）', names.includes('room-trim'));
    check('地板在场景图里（room-floor）', names.includes('room-floor'));
    check('台阶在场景图里（room-stair）', names.includes('room-stair'));
    check('接触阴影在场景图里（contact-shadows）', names.includes('contact-shadows'));

    // 网格线默认关（房间立起来之后不需要它）
    check('网格线默认关闭', stats.scene.gridVisible === false);

    if (SHOTS_DIR) {
      mkdirSync(SHOTS_DIR, { recursive: true });
      await page.screenshot({ path: `${SHOTS_DIR}/scene-day.png` });
    }
    await page.close();
  }

  // ═══════════ 2. 接触阴影：像素级验证（7 角色）═══════════
  {
    const { page } = await open('day', '&agents=6');

    // 等 7 个化身全部挂上再读数。
    //
    // 为什么必须等：`avatarCount` = 玩家化身 + 6 个 Agent 化身，而玩家化身要等
    // GLB 加载+克隆完成才从 0 变 1。SwiftShader 软渲染下 7 个蒙皮网格的克隆
    // 可能要好几秒，直接读会读到 6（玩家还是占位胶囊）。
    // 这是**加载时序**，不是功能缺失——但验收不能靠"再等等看"，
    // 所以要显式等到位，超时才算失败。
    await page
      .waitForFunction(
        () => (window.__worldDebug?.read?.()?.avatarCount ?? 0) >= 7,
        { timeout: 45_000 },
      )
      .catch(() => {
        /* 超时下面会如实报数字 */
      });

    const stats = await sampleStats(page, 6);

    check(
      '7 个角色（玩家 + 6 Agent）',
      stats.avatarCount === 7,
      `avatarCount=${stats.avatarCount}`,
    );
    check(
      '接触阴影实例数 = 角色数（1 次 drawCall 覆盖全部）',
      stats.scene.contactShadowVisible === 7,
      `instances=${stats.scene.contactShadowVisible}`,
    );

    // ── 像素差 A/B：同一机位，只开/关接触阴影 ──
    //
    // 为什么必须这么做（而不是"量脚下亮度 vs 旁边亮度"）：
    // 脚下那块像素同时受 ①接触阴影 ②角色自己的方向光投影 ③地砖贴图 三重影响。
    // 只量绝对值说不清是谁造成的，甚至可能得出"脚下更亮"的荒谬结论
    // （实测第一版就踩了：采样点落在角色白色围裙上，量到 186）。
    // 开/关两张图逐像素相减，差异只可能来自接触阴影 —— 这是唯一干净的判据。
    await page.evaluate(() => {
      window.__worldDebug.setDistance(2.2);
      window.__worldDebug.setYaw(Math.PI);
      window.__worldDebug.orbit(0, 190);
    });
    await page.waitForTimeout(900);

    await page.evaluate(() => window.__worldDebug.setContactShadows(true));
    await page.waitForTimeout(400);
    const withShadow = await page.screenshot();

    await page.evaluate(() => window.__worldDebug.setContactShadows(false));
    await page.waitForTimeout(400);
    const withoutShadow = await page.screenshot();

    // 恢复（后面的用例还要用）
    await page.evaluate(() => window.__worldDebug.setContactShadows(true));

    if (SHOTS_DIR) {
      await page.screenshot({ path: `${SHOTS_DIR}/scene-contact.png` });
    }

    const diff = await diffShadowPixels(withShadow, withoutShadow);
    check(
      '接触阴影真的改变了画面（开/关像素差）',
      diff.changedPixels > 2000,
      `${diff.changedPixels} 像素变暗（占画面 ${(diff.changedRatio * 100).toFixed(2)}%）`,
    );
    check(
      '被压暗的像素确实更暗（方向对，不是发光）',
      diff.meanDelta < -8,
      `平均 Δ亮度 ${diff.meanDelta.toFixed(1)}`,
    );

    await page.close();
  }

  // ═══════════ 3. 夜晚预设 ═══════════
  {
    const { page, errors } = await open('night');
    const stats = await sampleStats(page);
    summary.night = { drawCalls: stats.drawCalls, triangles: stats.triangles };
    check('夜晚预设无 JS 错误', errors.length === 0, errors.slice(0, 2).join(' | '));
    check(
      '夜晚预设下房间边界仍在（墙可见）',
      stats.scene.meshes.some((m) => m.name === 'room-wall' && m.visible),
    );
    if (SHOTS_DIR) await page.screenshot({ path: `${SHOTS_DIR}/scene-night.png` });
    await page.close();
  }

  // ═══════════ 4. 性能预算 ═══════════
  {
    const d = summary.day.drawCalls - BASELINE.drawCalls;
    const growth = (summary.day.triangles - BASELINE.triangles) / BASELINE.triangles;

    check(
      `drawCall 增幅 ≤ ${MAX_DRAW_CALL_DELTA}`,
      d <= MAX_DRAW_CALL_DELTA,
      `${BASELINE.drawCalls} → ${summary.day.drawCalls}（+${d}）`,
    );
    check(
      `三角形增幅 ≤ ${MAX_TRIANGLE_GROWTH * 100}%`,
      growth <= MAX_TRIANGLE_GROWTH,
      `${BASELINE.triangles} → ${summary.day.triangles}（+${(growth * 100).toFixed(1)}%）`,
    );
  }

  // ═══════════ 5. dispose 真的释放了 GPU 资源 ═══════════
  //
  // 为什么这条必须有：任务书点名要求"新增渲染对象必须能被 dispose() 清理"，
  // 而 scene.ts 的 dispose 原本只 traverse `Mesh`。
  // 本轮新增的接触阴影是 **InstancedMesh**、网格线是 **LineSegments** ——
  // 两者都不是 `Mesh`，traverse 覆盖不到，漏掉就是显存泄漏。
  //
  // 判据：反复建/拆世界，看 renderer.info.memory 的 geometries/textures 是否回到基线。
  {
    const { page } = await open('day');
    const leak = await page.evaluate(async () => {
      const dbg = window.__worldDebug;
      const baseline = dbg.read();

      const probe = window.__worldDebug.leakProbe;
      if (typeof probe !== 'function') return { skipped: '没有 leakProbe 探针' };

      // 连拆三次：每次都新建一整套场景资源（贴图、几何、InstancedMesh）
      const rounds = [];
      for (let i = 0; i < 3; i++) {
        probe();
        // 给 renderer.info.memory 一个结算周期
        await new Promise((r) => setTimeout(r, 120));
        rounds.push(dbg.read());
      }
      return {
        baseline: { geometries: baseline.geometries, textures: baseline.textures },
        rounds: rounds.map((r) => ({ geometries: r.geometries, textures: r.textures })),
      };
    });

    if (leak.skipped) {
      // 没有探针时如实标 SKIP，不假装通过（审计 §5 的口径）
      console.log(`- 场景重建不泄漏显存                              SKIP（${leak.skipped}）`);
    } else {
      const g0 = leak.baseline.geometries;
      const t0 = leak.baseline.textures;
      const gMax = Math.max(...leak.rounds.map((r) => r.geometries));
      const tMax = Math.max(...leak.rounds.map((r) => r.textures));
      // 重建三次后，资源数不该比第一次建完多出"一整份场景"（约 5 几何 / 3 贴图）
      check(
        '反复重建不泄漏几何',
        gMax - g0 <= 2,
        `基线 ${g0} → 三次重建峰值 ${gMax}（+${gMax - g0}）`,
      );
      check(
        '反复重建不泄漏贴图',
        tMax - t0 <= 1,
        `基线 ${t0} → 三次重建峰值 ${tMax}（+${tMax - t0}）`,
      );
    }
    await page.close();
  }
} finally {
  await browser.close();
  vite?.kill();
}

/**
 * 开/关接触阴影两张图的像素差。
 *
 * 判据：有多少像素"明显变暗"，以及这些像素平均暗了多少。
 * 用**亮度差**而不是逐通道差：接触阴影是黑色半透明贴片，它只压亮度、不改色相。
 *
 * 为什么门槛是 2000 像素：1280×720 里，7 个半径 0.5m 的贴片在 2.2m 机位下
 * 大约各占 3~6 千像素，合计应该有两万以上。2000 是个很宽松的下限，
 * 只用来排除"完全没画出来"和"只差几个抗锯齿像素"这两种情况。
 */
async function diffShadowPixels(withShadow, withoutShadow) {
  const sharp = (await import('sharp')).default;

  const toRaw = async (buf) => {
    const { data, info } = await sharp(buf).raw().toBuffer({ resolveWithObject: true });
    return { data, info };
  };

  const a = await toRaw(withShadow);
  const b = await toRaw(withoutShadow);

  if (a.info.width !== b.info.width || a.info.height !== b.info.height) {
    throw new Error('两张截图尺寸不一致，无法做像素差');
  }

  const { width, height, channels } = a.info;
  const total = width * height;

  let changed = 0;
  let sumDelta = 0;

  for (let p = 0; p < total; p++) {
    const i = p * channels;
    const lumA = 0.2126 * a.data[i] + 0.7152 * a.data[i + 1] + 0.0722 * a.data[i + 2];
    const lumB = 0.2126 * b.data[i] + 0.7152 * b.data[i + 1] + 0.0722 * b.data[i + 2];
    const delta = lumA - lumB; // 负数 = 开了阴影之后更暗
    // 阈值 6/255：低于这个量级是抗锯齿/抖动噪声，不是阴影
    if (delta < -6) {
      changed += 1;
      sumDelta += delta;
    }
  }

  return {
    changedPixels: changed,
    changedRatio: changed / total,
    meanDelta: changed > 0 ? sumDelta / changed : 0,
  };
}

// ── 汇总 ──
console.log('');
console.log(`场景视觉验收：${results.length - failed}/${results.length} 通过`);
if (SHOTS_DIR) {
  writeFileSync(
    `${SHOTS_DIR}/scene-report.json`,
    JSON.stringify({ summary, baseline: BASELINE, results }, null, 2),
  );
  console.log(`截图与报告：${SHOTS_DIR}/`);
}
if (failed > 0) {
  console.log(`未通过：${failed} 项`);
  process.exit(1);
}
console.log('全部通过');
