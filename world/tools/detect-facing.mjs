// 用 three.js 真正加载资产，判定"原生朝向"。
//
// 为什么不用手写 glb 解析：资产经过 meshopt + 量化（KHR_mesh_quantization）+
// 可能有 sparse accessor，手写解析器要处理全部扩展，容易读错偏移。
// three 的 GLTFLoader 在 node 里能跑（配 dom-stub），让它算最可靠。
//
// 判据：人形角色脚尖朝正面。取最低 12% 的顶点（脚），看质心相对整体偏向哪个轴。
import { readFileSync } from 'node:fs';
import * as THREE from 'three';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { MeshoptDecoder } from 'three/examples/jsm/libs/meshopt_decoder.module.js';

// 最小 DOM 桩（GLTFLoader 需要）
globalThis.self = globalThis;
globalThis.URL.createObjectURL ??= () => 'blob:stub';
globalThis.URL.revokeObjectURL ??= () => {};
globalThis.createImageBitmap ??= async () => ({ width: 1, height: 1, close() {} });
globalThis.Image ??= class {
  width = 1; height = 1; onload = null; onerror = null; src = '';
  addEventListener() {} removeEventListener() {}
};

const path = process.argv[2];
const buf = readFileSync(path);
const ab = buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength);

const loader = new GLTFLoader();
// 资产是 meshopt 压缩过的（EXT_meshopt_compression required），必须注册解码器，
// 否则 GLTFLoader 直接抛错（某些版本会静默给全零顶点，更危险）。
await MeshoptDecoder.ready;
loader.setMeshoptDecoder(MeshoptDecoder);

const gltf = await new Promise((res, rej) => loader.parse(ab, '', res, rej));

const scene = gltf.scene;
scene.updateMatrixWorld(true);

// 收集所有 skinned/mesh 的世界坐标顶点
const points = [];
scene.traverse((o) => {
  if (!o.isMesh) return;
  const pos = o.geometry.getAttribute('position');
  if (!pos) return;
  const v = new THREE.Vector3();
  for (let i = 0; i < pos.count; i++) {
    v.fromBufferAttribute(pos, i);
    o.localToWorld(v);
    points.push([v.x, v.y, v.z]);
  }
});

if (points.length === 0) {
  console.error('没有顶点');
  process.exit(1);
}

const min = [Infinity, Infinity, Infinity];
const max = [-Infinity, -Infinity, -Infinity];
for (const p of points) {
  for (let i = 0; i < 3; i++) {
    if (p[i] < min[i]) min[i] = p[i];
    if (p[i] > max[i]) max[i] = p[i];
  }
}
const size = [max[0] - min[0], max[1] - min[1], max[2] - min[2]];

console.log(`顶点数 ${points.length}`);
console.log(`包围盒  X ${size[0].toFixed(3)}  Y ${size[1].toFixed(3)}  Z ${size[2].toFixed(3)}`);
console.log(`  高 ${size[1].toFixed(3)}m（应≈1.0，渲染层会归一化到 1.62）`);

const centroid = (arr) => {
  const c = [0, 0, 0];
  for (const p of arr) { c[0] += p[0]; c[1] += p[1]; c[2] += p[2]; }
  return [c[0] / arr.length, c[1] / arr.length, c[2] / arr.length];
};

const overall = centroid(points);

// 脚部：最低 12%
const yLow = min[1] + size[1] * 0.12;
const feet = points.filter((p) => p[1] <= yLow);
const feetC = centroid(feet);
console.log(`\n脚部 ${feet.length} 顶点 质心 (${feetC[0].toFixed(3)}, ${feetC[1].toFixed(3)}, ${feetC[2].toFixed(3)})`);
console.log(`整体质心 (${overall[0].toFixed(3)}, ${overall[1].toFixed(3)}, ${overall[2].toFixed(3)})`);

const dx = feetC[0] - overall[0];
const dz = feetC[2] - overall[2];
console.log(`脚部相对偏移  dx=${dx.toFixed(4)}  dz=${dz.toFixed(4)}`);

// 头部：最高 15%，脸/鼻子朝前
const yHigh = max[1] - size[1] * 0.15;
const head = points.filter((p) => p[1] >= yHigh);
const headC = centroid(head);
const hdx = headC[0] - overall[0];
const hdz = headC[2] - overall[2];
console.log(`头部 ${head.length} 顶点 质心 (${headC[0].toFixed(3)}, ${headC[1].toFixed(3)}, ${headC[2].toFixed(3)})`);
console.log(`头部相对偏移  dx=${hdx.toFixed(4)}  dz=${hdz.toFixed(4)}`);

console.log('\n=== 判定 ===');
const ax = Math.abs(dx), az = Math.abs(dz);
let axis = null;
if (ax > az * 1.3) axis = dx > 0 ? '+X' : '-X';
else if (az > ax * 1.3) axis = dz > 0 ? '+Z' : '-Z';

if (axis) {
  console.log(`脚部沿 ${axis} 偏移 → 模型正面很可能朝 ${axis}`);
  const deg = axis === '+Z' ? 0 : axis === '+X' ? -90 : axis === '-Z' ? 180 : 90;
  console.log(`若物理约定正面是 +Z，则 MODEL_FACING_OFFSET_Y ≈ ${(deg * Math.PI / 180).toFixed(4)} rad (${deg}°)`);
} else {
  console.log(`X/Z 偏移接近，脚部判据不明确（dx=${dx.toFixed(4)} dz=${dz.toFixed(4)}）`);
  console.log(`  参考头部偏移 dx=${hdx.toFixed(4)} dz=${hdz.toFixed(4)}`);
}
console.log('\n⚠️ 这是几何启发式，不是权威。最终用 ?ry= 目视确认。');
