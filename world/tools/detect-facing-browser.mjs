// 在真实浏览器里判定模型"原生朝向"。
//
// 为什么必须在浏览器里做：资产是 meshopt 压缩的，node 侧要自己配解码器与 DOM 桩，
// 很容易因为纹理加载 unsettled 而卡住。浏览器里 three 跑的是完整路径。
//
// 判据（人形角色通用）：取最低 12% 顶点（脚），脚尖朝正面 → 脚部质心偏向正面轴。
// 同时用头部（最高 15%）做交叉验证：脸/鼻子朝正面。
import { chromium } from '@playwright/test';
import { chromiumLaunchOptions } from './chromium.mjs';

const URL = process.argv[2] ?? 'http://127.0.0.1:5199/';

const browser = await chromium.launch({
  executablePath: chromiumLaunchOptions().executablePath,
  args: chromiumLaunchOptions().args,
});
const page = await browser.newPage({ viewport: { width: 800, height: 600 } });
await page.goto(URL, { waitUntil: 'load' });
await page.waitForFunction(() => typeof window.__worldDebug === 'object', { timeout: 30000 });

const result = await page.evaluate(async () => {
  const THREE = window.__THREE__;
  if (!THREE) return { error: 'window.__THREE__ 不存在（dev 构建才暴露）' };

  // 用应用自己的 loader（Vite 已解析好依赖图），不要在 evaluate 里裸 import 包名。
  // 应用把加载器挂在 __worldAssets 上（dev only）。
  const probe = window.__worldAssets;
  let scene = null;
  if (probe?.loadRaw) {
    scene = await probe.loadRaw('whalegirl');
  } else {
    return { error: '__worldAssets.loadRaw 不存在；可用字段：' + Object.keys(probe ?? {}).join(',') };
  }
  scene.updateMatrixWorld(true);

  const pts = [];
  const v = new THREE.Vector3();
  scene.traverse((o) => {
    if (!o.isMesh) return;
    const pos = o.geometry.getAttribute('position');
    if (!pos) return;
    for (let i = 0; i < pos.count; i++) {
      v.fromBufferAttribute(pos, i);
      o.localToWorld(v);
      pts.push([v.x, v.y, v.z]);
    }
  });
  if (!pts.length) return { error: '没有顶点' };

  const min = [Infinity, Infinity, Infinity], max = [-Infinity, -Infinity, -Infinity];
  for (const p of pts) for (let i = 0; i < 3; i++) {
    if (p[i] < min[i]) min[i] = p[i];
    if (p[i] > max[i]) max[i] = p[i];
  }
  const size = [max[0] - min[0], max[1] - min[1], max[2] - min[2]];
  const centroid = (arr) => {
    const c = [0, 0, 0];
    for (const p of arr) { c[0] += p[0]; c[1] += p[1]; c[2] += p[2]; }
    return [c[0] / arr.length, c[1] / arr.length, c[2] / arr.length];
  };
  const overall = centroid(pts);

  const yLow = min[1] + size[1] * 0.12;
  const feet = pts.filter((p) => p[1] <= yLow);
  const feetC = centroid(feet);

  const yHigh = max[1] - size[1] * 0.15;
  const head = pts.filter((p) => p[1] >= yHigh);
  const headC = centroid(head);

  // 另外：按 Z 轴切片，看"最突出的点"在哪个方向（鼻子/胸/脚尖）
  const extremeZplus = Math.max(...pts.map((p) => p[2]));
  const extremeZminus = Math.min(...pts.map((p) => p[2]));
  const extremeXplus = Math.max(...pts.map((p) => p[0]));
  const extremeXminus = Math.min(...pts.map((p) => p[0]));

  return {
    verts: pts.length,
    size: size.map((x) => +x.toFixed(3)),
    overall: overall.map((x) => +x.toFixed(3)),
    feet: { n: feet.length, c: feetC.map((x) => +x.toFixed(3)), dx: +(feetC[0] - overall[0]).toFixed(4), dz: +(feetC[2] - overall[2]).toFixed(4) },
    head: { n: head.length, c: headC.map((x) => +x.toFixed(3)), dx: +(headC[0] - overall[0]).toFixed(4), dz: +(headC[2] - overall[2]).toFixed(4) },
    extremes: {
      xPlus: +extremeXplus.toFixed(3), xMinus: +extremeXminus.toFixed(3),
      zPlus: +extremeZplus.toFixed(3), zMinus: +extremeZminus.toFixed(3),
    },
  };
});

console.log(JSON.stringify(result, null, 2));

if (result.feet) {
  const { dx, dz } = result.feet;
  const ax = Math.abs(dx), az = Math.abs(dz);
  console.log('\n=== 判定（脚部判据）===');
  if (ax > az * 1.3) console.log(`脚部沿 X 偏移 ${dx > 0 ? '+X' : '-X'} → 正面朝 ${dx > 0 ? '+X' : '-X'}`);
  else if (az > ax * 1.3) console.log(`脚部沿 Z 偏移 ${dz > 0 ? '+Z' : '-Z'} → 正面朝 ${dz > 0 ? '+Z' : '-Z'}`);
  else console.log(`脚部 X/Z 偏移接近（dx=${dx} dz=${dz}），判据不明确，看头部与极值`);
}

await browser.close();
