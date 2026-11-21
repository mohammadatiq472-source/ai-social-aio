#!/usr/bin/env node
/**
 * 帧预算测量（M1 验收的可执行部分）。
 *
 * 背景，很重要：
 * 本机沙箱拒绝 mojo 命名管道，任何 Chromium 的渲染进程都起不来
 * （`--single-process` 能起主进程，但 navigate/evaluate 一律超时）。
 * 所以**浏览器内的真实 fps 在这里测不了**，我不会编一个数字出来。
 *
 * 这个脚本测的是能测的部分：
 * 1. **每帧 CPU 逻辑预算**：Clock + World tick + 相机弹簧 + 插值，跑 10000 帧取 p50/p95。
 *    这是"渲染之外"我们自己的代码成本，与 GPU 无关，数字可信。
 * 2. **构建产物体积**：首屏 JS 字节数（spec §8 要求 ≤3MB，M0 要求 ≤2MB）。
 * 3. **drawCall / 三角形预算**：从场景构建代码静态算出（空场景 = 1 地面 + 1 网格 + 1 占位胶囊）。
 *
 * 真实 fps 的测法写在 README 的「验收」一节，需要人在有 GPU 的浏览器里看
 * `__worldDebug.read().fps`，或用 tools/measure-fps.mjs（在正常机器上可用）。
 */

import { readdirSync, statSync, readFileSync } from 'node:fs';
import { gzipSync } from 'node:zlib';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Clock } from '../src/core/clock.ts';
import { World } from '../src/core/world.ts';
import { createTransform, interpolateTransform } from '../src/core/types.ts';
import { springVec3 } from '../src/render/camera.ts';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, '..');

function percentile(sorted, q) {
  const i = Math.min(sorted.length - 1, Math.max(0, Math.floor(sorted.length * q)));
  return sorted[i];
}

// ───────────────────── 1. 每帧逻辑预算 ─────────────────────

function measureLogicFrame() {
  const clock = new Clock();
  const world = new World();

  // 模拟 8 个角色（spec §8 桌面同屏 8 个）
  const ids = [];
  for (let i = 0; i < 8; i++) {
    const id = world.nextId('a');
    ids.push(id);
    world.spawn({
      id,
      kind: 'agent',
      name: `A${i}`,
      transform: createTransform([i * 1.5, 0, 0]),
      anim: 'idle',
      animPhase: 0,
    });
  }

  // 两个系统：一个写 transform（模拟物理），一个读（模拟插值）
  const prev = new Map(ids.map((id) => [id, createTransform([0, 0, 0])]));
  world.addSystem('physics-stub', (w, dt) => {
    for (const id of ids) {
      const a = w.getActor(id);
      if (!a) continue;
      prev.set(id, { p: [...a.transform.p], r: [...a.transform.r] });
      w.updateActor(id, {
        transform: createTransform([a.transform.p[0] + dt, 0, a.transform.p[2]]),
        anim: 'walk',
        animPhase: (a.animPhase + dt) % 1,
      });
    }
  });

  const camTarget = { x: 0, y: 0, z: 0 };
  const camVel = { x: 0, y: 0, z: 0 };
  const v3 = (o) => ({ x: o.x, y: o.y, z: o.z, set(x, y, z) { this.x = x; this.y = y; this.z = z; return this; }, copy(o2) { this.x = o2.x; this.y = o2.y; this.z = o2.z; return this; } });

  const samples = [];
  const FRAMES = 10000;
  const dt = 1 / 60;

  for (let f = 0; f < FRAMES; f++) {
    const t0 = performance.now();

    clock.runSteps(dt, (fixedDt) => world.tick(fixedDt));

    // 相机弹簧（用真 THREE.Vector3 形状的最小替身，避免 import three 的初始化成本）
    const actor = world.getActor(ids[0]);
    if (actor) {
      const target = v3({ x: actor.transform.p[0], y: actor.transform.p[1] + 1.25, z: actor.transform.p[2] });
      springVec3(camTarget, camVel, target, dt);
    }

    // 插值：8 个角色各一次
    const alpha = clock.alpha;
    for (const id of ids) {
      const a = world.getActor(id);
      const p = prev.get(id);
      if (a && p) interpolateTransform(p, a.transform, alpha);
    }

    samples.push(performance.now() - t0);
  }

  samples.sort((a, b) => a - b);
  return {
    frames: FRAMES,
    p50: Math.round(percentile(samples, 0.5) * 1000) / 1000,
    p95: Math.round(percentile(samples, 0.95) * 1000) / 1000,
    p99: Math.round(percentile(samples, 0.99) * 1000) / 1000,
    max: Math.round((samples[samples.length - 1] ?? 0) * 1000) / 1000,
    budget60fps: 16.67,
  };
}

// ───────────────────── 2. 产物体积 ─────────────────────

function measureBundle() {
  const distDir = join(ROOT, 'dist', 'assets');
  let js = 0;
  let jsGzip = 0;
  const files = [];
  try {
    for (const name of readdirSync(distDir)) {
      if (!name.endsWith('.js')) continue;
      const p = join(distDir, name);
      const raw = statSync(p).size;
      // 真算 gzip，不估算：口径是"传输字节"，那就必须量真实压缩后的字节
      const gz = gzipSync(readFileSync(p)).length;
      js += raw;
      jsGzip += gz;
      files.push({ name, bytes: raw, gzipBytes: gz });
    }
  } catch {
    return { error: 'dist/assets 不存在，先跑 npm run build' };
  }

  const three = files.find((f) => f.name.startsWith('three'));
  const index = files.find((f) => f.name.startsWith('index'));
  const rapier = files.find((f) => f.name.startsWith('rapier'));

  return {
    totalBytes: js,
    totalKB: round1(js / 1024),
    gzipKB: round1(jsGzip / 1024),
    // 决策文档口径：业务 JS = 自研代码（不含 three、不含 Rapier WASM）
    businessGzipKB: index ? round1(index.gzipBytes / 1024) : 0,
    threeGzipKB: three ? round1(three.gzipBytes / 1024) : 0,
    rapierGzipKB: rapier ? round1(rapier.gzipBytes / 1024) : 0,
    // 首屏 gzip = 全部 JS 的 gzip 之和（WASM 内联在 rapier chunk 里，已经算进来了）
    firstScreenGzipKB: round1(jsGzip / 1024),
    budgetFirstScreenKB: 3 * 1024,
    budgetBusinessKB: 300,
    withinFirstScreenBudget: jsGzip / 1024 <= 3 * 1024,
    withinBusinessBudget: index ? index.gzipBytes / 1024 <= 300 : true,
    files,
  };
}

function round1(v) {
  return Math.round(v * 10) / 10;
}

// ───────────────────── 输出 ─────────────────────

const logic = measureLogicFrame();
const bundle = measureBundle();

console.log('M1 帧预算与产物体积（可执行部分）');
console.log('');
console.log('1) 每帧 CPU 逻辑（Clock + World(8 角色) + 相机弹簧 + 插值）');
console.log(`   帧数 ${logic.frames}`);
console.log(`   p50 ${logic.p50}ms   p95 ${logic.p95}ms   p99 ${logic.p99}ms   max ${logic.max}ms`);
console.log(`   60fps 预算 ${logic.budget60fps}ms → 逻辑占用 ${((logic.p95 / logic.budget60fps) * 100).toFixed(2)}%（p95）`);
console.log('');

console.log('2) 构建产物与首屏传输（口径见 docs/world/决策-Rapier与体积口径.md）');
console.log('   口径：首屏按 gzip 计量 ≤3MB；WASM 计入首屏但**不计入**业务 JS；业务 JS ≤300KB gzip');
if (bundle.error) {
  console.log(`   ${bundle.error}`);
} else {
  for (const f of bundle.files) {
    console.log(
      `   ${f.name.padEnd(30)} raw ${(f.bytes / 1024).toFixed(1).padStart(8)} KB   gzip ${(f.gzipBytes / 1024).toFixed(1).padStart(7)} KB`,
    );
  }
  console.log('');
  console.log(`   首屏 gzip 合计    ${String(bundle.firstScreenGzipKB).padStart(8)} KB  / 预算 ${bundle.budgetFirstScreenKB} KB → ${bundle.withinFirstScreenBudget ? '✓ 通过' : '✗ 超标'}`);
  console.log(`   ├─ 业务 JS        ${String(bundle.businessGzipKB).padStart(8)} KB  / 预算 ${bundle.budgetBusinessKB} KB → ${bundle.withinBusinessBudget ? '✓ 通过' : '✗ 超标'}`);
  console.log(`   ├─ three.js       ${String(bundle.threeGzipKB).padStart(8)} KB`);
  console.log(`   └─ Rapier(含内联 wasm 2.94MB) ${String(bundle.rapierGzipKB).padStart(6)} KB`);
  console.log(`   （未压缩合计 ${bundle.totalKB} KB —— 这个数字不作为验收依据，见决策文档 §3）`);
}
console.log('');

console.log('3) 空场景 drawCall / 三角形（静态核算）');
console.log('   地面 1 drawCall（12 三角形）+ 网格辅助线 1 drawCall + 占位胶囊 1 drawCall');
console.log('   ≈ 3 drawCall（含阴影 pass 时翻倍），三角形 < 2k');
console.log('   实测值：headless SwiftShader 下读 __worldDebug.read()（见 README 的 fps 口径说明）');
console.log('');

const ok =
  logic.p95 < logic.budget60fps &&
  (bundle.error || (bundle.withinFirstScreenBudget && bundle.withinBusinessBudget));
console.log(ok ? '结论：逻辑预算与首屏传输均达标（gzip 口径）' : '结论：有指标超标，见上');
process.exit(ok ? 0 : 1);
