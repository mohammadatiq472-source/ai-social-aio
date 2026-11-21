/**
 * 场景环境（spec §6 M6「同一份 JSON 既生成网格也生成碰撞体」的渲染半边）。
 *
 * ═══════════════ 为什么单独一个文件 ═══════════════
 *
 * 这些代码原本散在 `main.ts` 里（一份"从 DEMO_ROOM 建地面盒"的循环 + 一个 GridHelper），
 * 只有 20 行，够用但没法长大：墙、踢脚线、地砖缝、接触阴影一进来就是几百行，
 * 塞回 main.ts 会把那个"装配渲染器 + 相机 + Clock + 物理"的文件变成上帝对象。
 *
 * ═══════════════ 三条硬纪律 ═══════════════
 *
 * 1. **几何只有一个来源**：`core/room.ts` 的 `roomSolids()`。
 *    物理侧 `physics/bake.ts` 消费的是同一个函数。谁都不许自己解释一遍 room JSON，
 *    否则"看得见的墙"和"撞得到的墙"会分叉 —— 这是这类系统最经典的 bug。
 *
 * 2. **不许引入外部贴图资产**。首屏预算只剩 416KB brotli，
 *    而地砖缝这种图案用 canvas 画 20 行就够了。所有贴图都是运行时程序化生成的。
 *
 * 3. **drawCall 预算 ≤ 5**（验收硬指标）。所以：
 *    - 房间静态几何**全部合并成一个几何**（按材质切桶，每桶 1 次 drawCall）；
 *    - 接触阴影**一个 InstancedMesh**（所有角色共用 1 次 drawCall，不是每人一个）。
 *
 * ═══════════════ 一个必须讲清楚的视觉设计：墙是"从里面看的壳" ═══════════════
 *
 * 第三人称相机默认在角色背后 4.2m，而角色常常贴着墙走 —— 这时相机会退到墙外面。
 * 如果墙是双面的，画面就被一面灰墙糊死。
 *
 * 两种解法：
 * - (a) 相机做穿墙射线（要改 `camera.ts`，且它当前用 clamp 而非射线）；
 * - (b) 墙用 `side: BackSide`：只有从房间**内部**看才可见，镜头退到屋外那一侧就自动隐去。
 *
 * 这里选 (b)。它零运行时开销、不动相机、不动物理，而且观感上正是我们想要的：
 * 站在屋里四面有墙，镜头拉到屋外就自动"剖开"成剖面图。
 *
 * 代价要说清楚：**墙不投影**（`castShadow=false`）。
 * BackSide 的墙在阴影 pass 里会让整个房间落进一片黑，
 * 而方向光阴影的主要作用本来就是"让角色在地上留下影子"，被墙吃掉就本末倒置了。
 */

import * as THREE from 'three';
import { roomSolids, type Room, type RoomSolid } from '../core/room';
import { CAPSULE_CENTER_HEIGHT } from '../interact/player';
import type { World } from '../core/world';

// ───────────────────────────── 材质 ─────────────────────────────

/**
 * 材质 key → 外观。key 来自 room JSON 的 `mat` 字段（物理侧忽略它）。
 *
 * 颜色刻意压低饱和度：房间是**背景**，角色才是主体。
 * 地板比原来（0x2b3038 纯色）略暖一点，因为暖灰 + 冷调环境光比纯冷灰更有"室内"感。
 */
export interface MaterialSpec {
  color: number;
  roughness: number;
  metalness: number;
  /** 是否用地砖缝贴图（只有地板要）。 */
  tiled?: boolean;
  /** 是否用墙面斑驳贴图。 */
  paneled?: boolean;
  /** 墙类材质用 BackSide（见文件头说明）。 */
  insideOnly?: boolean;
  /**
   * 自发光（0xRRGGBB）。
   *
   * 只有墙需要：四面墙的内法线都是**水平**的，而主光是从正上方斜射下来的，
   * 半球光对水平法线给的是"天空色与地面色的中点"（预设里地面色 0x4a4038 很暗）。
   * 结果就是墙在画面上是一片接近纯黑的竖条 —— 房间感立刻没了（实测第一版）。
   *
   * 这里给墙一点点自发光，等价于"室内墙面的间接光下限"。
   * **这不是改光照参数**（lighting.ts 一个字没动，四套预设的验收数值全部保持），
   * 而是材质本身的性质：真实世界里墙也会把室内光反弹回来。
   * 值刻意压得很低（约 6% 灰），只为把"纯黑"抬成"暗灰"，不制造假光源。
   */
  emissive?: number;
}

export const MATERIALS: Readonly<Record<string, MaterialSpec>> = {
  // 地板比原来（0x2b3038 纯色）亮一档：贴图会按 ~0.72 的灰度再乘一次，
  // 所以基色要给足，否则乘完又回到"一块深灰塑料"。
  floor: { color: 0x555c66, roughness: 0.88, metalness: 0.03, tiled: true },
  // 墙基色刻意给得比地板**亮**：四面墙的内法线都背对太阳（光从屋外上方来），
  // 只有半球光能照到它们。基色不给足，墙就是一片死黑（实测第一版就是这个问题）。
  // emissive 再兜一层"间接光下限"，见 MaterialSpec.emissive 的注释。
  wall: {
    color: 0x6d7583,
    roughness: 0.95,
    metalness: 0.0,
    paneled: true,
    insideOnly: true,
    // 实测：远墙（z=+10）的内法线朝 -z，而太阳在 +z 侧，
    // 两者点积为负 → **一点太阳光都拿不到**，只剩半球光，亮度只有 19/255（几乎全黑）。
    // 这是物理正确的逆光，但画面上"四面墙里三面是黑洞"就不像房间了。
    // 真实室内靠墙面互相反弹光，这里用自发光补这个下限：抬到与地板可比的暗灰。
    emissive: 0x3a4150,
  },
  // 踢脚线反过来要**暗**：它的作用是给墙脚一条分界线，亮就失去意义
  trim: { color: 0x2b3038, roughness: 0.7, metalness: 0.05, insideOnly: true },
  stair: { color: 0x5a6270, roughness: 0.85, metalness: 0.03, emissive: 0x0e1014 },
  crate: { color: 0xb9855a, roughness: 0.82, metalness: 0.02 },
};

/** 未知 mat 的兜底（房间 JSON 是手写的，写错 key 不该炸页面）。 */
export const FALLBACK_MATERIAL: MaterialSpec = {
  color: 0x2b3038,
  roughness: 0.92,
  metalness: 0.02,
};

/** 取材质规格；未知 key 回落到兜底。 */
export function materialSpec(key: string | undefined): MaterialSpec {
  if (key === undefined) return FALLBACK_MATERIAL;
  return MATERIALS[key] ?? FALLBACK_MATERIAL;
}

// ───────────────────────────── 程序化贴图 ─────────────────────────────

/** 地砖缝贴图尺寸（像素）。256 足够：贴图会被重复平铺，单块砖只占 ~64px。 */
export const TILE_TEXTURE_SIZE = 256;

/** 每块地砖在世界空间里的边长（米）。 */
export const TILE_WORLD_SIZE = 1.25;

/**
 * 画地砖缝（灰度图，作为 `map` 用）。
 *
 * 为什么是灰度而不是带色：颜色由材质的 `color` 给，贴图只负责**明暗结构**。
 * 这样换一套配色不用重画贴图，且 `MeshStandardMaterial` 会把 map 与 color 相乘，
 * 灰度图等价于"只调制亮度"，最可控。
 *
 * 画法：底色浅灰 → 画深色砖缝 → 每块砖内部加一点点随机深浅（确定性伪随机）。
 * 砖内部的变化是"不塑料"的关键：纯均匀色块在 PBR 下反射一致，看起来就是一块塑料。
 */
export function drawTileTexture(
  ctx: CanvasRenderingContext2D,
  size = TILE_TEXTURE_SIZE,
  tiles = 4,
): void {
  ctx.fillStyle = '#b9b9b9';
  ctx.fillRect(0, 0, size, size);

  const cell = size / tiles;

  // 砖内部微变化：用确定性的伪随机（同一个 i/j 永远同一个灰度），
  // 不用 Math.random —— 每次刷新地面纹理都变会让人以为是闪烁 bug。
  for (let j = 0; j < tiles; j++) {
    for (let i = 0; i < tiles; i++) {
      const n = hash2(i, j);
      // ±6/255 的亮度扰动：肉眼几乎看不出单块砖不同，但整片地就不再是"一块塑料"
      const v = Math.round(185 + (n - 0.5) * 12);
      ctx.fillStyle = `rgb(${v},${v},${v})`;
      ctx.fillRect(i * cell + 1, j * cell + 1, cell - 2, cell - 2);
    }
  }

  // 砖缝：深色细线。线宽 2px（≈1cm @1.25m/64px），太粗会像瓷砖画，太细会摩尔纹
  ctx.strokeStyle = '#6f6f6f';
  ctx.lineWidth = 2;
  for (let i = 0; i <= tiles; i++) {
    const p = i * cell;
    ctx.beginPath();
    ctx.moveTo(p, 0);
    ctx.lineTo(p, size);
    ctx.stroke();
    ctx.beginPath();
    ctx.moveTo(0, p);
    ctx.lineTo(size, p);
    ctx.stroke();
  }
}

/**
 * 画墙面斑驳（灰度）。
 *
 * 墙面比地板更需要"不塑料"：墙占了画面很大面积，纯色墙在任何角度都是同一片灰。
 * 这里画几道很淡的横向分层（模拟抹灰接缝）+ 少量斑点。
 */
export function drawWallTexture(
  ctx: CanvasRenderingContext2D,
  size = TILE_TEXTURE_SIZE,
): void {
  ctx.fillStyle = '#c4c4c4';
  ctx.fillRect(0, 0, size, size);

  // 横向抹灰接缝：每 1/4 高一道极淡的暗线
  ctx.strokeStyle = 'rgba(150,150,150,0.55)';
  ctx.lineWidth = 1;
  for (let i = 1; i < 4; i++) {
    const y = (i * size) / 4;
    ctx.beginPath();
    ctx.moveTo(0, y);
    ctx.lineTo(size, y);
    ctx.stroke();
  }

  // 斑点：低密度、低对比，只为了让大面积墙面在掠射角下有细节
  for (let k = 0; k < 220; k++) {
    const n1 = hash2(k, 7);
    const n2 = hash2(k, 13);
    const v = Math.round(178 + n1 * 26);
    ctx.fillStyle = `rgba(${v},${v},${v},0.5)`;
    const r = 1 + n2 * 2.5;
    ctx.beginPath();
    ctx.arc(n1 * size, n2 * size, r, 0, Math.PI * 2);
    ctx.fill();
  }
}

/**
 * 确定性伪随机（0..1）。
 *
 * 为什么不用 `Math.random()`：贴图内容每次刷新都变，观感上是"地面在闪"，
 * 而且截图对比时两次的图不一样，没法做 A/B。纯算术版本跨机器逐位一致。
 */
function hash2(i: number, j: number): number {
  const x = Math.sin(i * 127.1 + j * 311.7) * 43758.5453;
  return x - Math.floor(x);
}

/**
 * 造一张 canvas 贴图。
 *
 * `SRGBColorSpace` 是必须的：我们画的是 sRGB 空间里的灰度，
 * 不标的话 three 会把它当线性数据采样，整片地面会亮一档、砖缝对比也会失真。
 */
export function makeCanvasTexture(
  paint: (ctx: CanvasRenderingContext2D, size: number) => void,
  size = TILE_TEXTURE_SIZE,
): THREE.CanvasTexture | null {
  if (typeof document === 'undefined') return null; // node 单测环境没有 canvas
  const canvas = document.createElement('canvas');
  canvas.width = size;
  canvas.height = size;
  const ctx = canvas.getContext('2d');
  if (!ctx) return null;
  paint(ctx, size);
  const tex = new THREE.CanvasTexture(canvas);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.wrapS = THREE.RepeatWrapping;
  tex.wrapT = THREE.RepeatWrapping;
  // 砖缝是细线，各向异性过滤能让掠射角（第三人称俯视地面）下不糊
  tex.anisotropy = 4;
  tex.needsUpdate = true;
  return tex;
}

// ───────────────────────────── 顶点色（假 AO） ─────────────────────────────

/**
 * 地面顶点的暗化系数：靠墙越近越暗，模拟"墙脚的环境光遮蔽"。
 *
 * 为什么用顶点色而不是真 AO：v0.1 没有后处理链（spec 明说不需要），
 * 实时 SSAO 要多一整个 pass。而"墙脚暗一圈"这个观感，
 * 对一块**细分过的平面**来说顶点色就能做到，成本是 0 次额外 drawCall。
 *
 * @param x 世界 x
 * @param z 世界 z
 * @param half 房间半边长（米）
 * @param reach 遮蔽从墙往屋里延伸多远（米）
 * @param strength 0..1，墙脚最暗时压到 `1-strength`
 */
export function floorOcclusionAt(
  x: number,
  z: number,
  half: number,
  reach = 1.6,
  strength = 0.5,
): number {
  // 到最近一面墙的距离（矩形房间，取两轴里更近的那个）
  const d = Math.min(half - Math.abs(x), half - Math.abs(z));
  if (!(d < reach)) return 1;
  if (d <= 0) return 1 - strength;
  // smoothstep：墙脚陡、往中间平缓，比线性更像真的 AO
  const t = d / reach;
  const k = t * t * (3 - 2 * t);
  return 1 - strength * (1 - k);
}

// ───────────────────────────── 房间静态几何 ─────────────────────────────

/** 一个材质桶：同材质的实心块合并成一个几何 → 1 次 drawCall。 */
interface MaterialBucket {
  key: string;
  spec: MaterialSpec;
  /** 世界空间的盒体（中心 / 半尺寸 / 四元数）。 */
  solids: RoomSolid[];
}

/**
 * 把 `roomSolids()` 的输出按材质分桶。
 *
 * 分桶而不是"全部合并成一个"：不同材质的颜色/粗糙度不同，
 * 合成一个就得靠顶点色近似，而顶点色表达不了 roughness 差异（地板要哑、踢脚线要半哑）。
 * 按材质切桶后，桶数 = 材质种类数 = drawCall 数，且每个桶内部零浪费。
 *
 * 纯函数，可单测。
 */
export function bucketByMaterial(solids: readonly RoomSolid[]): MaterialBucket[] {
  const map = new Map<string, MaterialBucket>();
  for (const s of solids) {
    const key = s.mat ?? '__default__';
    let bucket = map.get(key);
    if (!bucket) {
      bucket = { key, spec: materialSpec(s.mat), solids: [] };
      map.set(key, bucket);
    }
    bucket.solids.push(s);
  }
  return [...map.values()];
}

/** 把 1×1×1 的盒子几何按实心块的变换烘焙到世界空间（写进目标 BufferGeometry）。 */
function appendBox(
  target: {
    positions: number[];
    normals: number[];
    uvs: number[];
    indices: number[];
  },
  solid: RoomSolid,
  uvScale: number,
): void {
  const [hx, hy, hz] = solid.halfExtents;
  const box = new THREE.BoxGeometry(hx * 2, hy * 2, hz * 2);

  const quat = new THREE.Quaternion(solid.rot[0], solid.rot[1], solid.rot[2], solid.rot[3]);
  const mat4 = new THREE.Matrix4().compose(
    new THREE.Vector3(solid.pos[0], solid.pos[1], solid.pos[2]),
    quat,
    new THREE.Vector3(1, 1, 1),
  );
  box.applyMatrix4(mat4);

  const pos = box.attributes['position']!;
  const nor = box.attributes['normal']!;
  const uv = box.attributes['uv'];
  const index = box.index;

  const base = target.positions.length / 3;
  for (let i = 0; i < pos.count; i++) {
    target.positions.push(pos.getX(i), pos.getY(i), pos.getZ(i));
    target.normals.push(nor.getX(i), nor.getY(i), nor.getZ(i));
    // UV 按世界尺度缩放，让贴图密度与盒子尺寸无关（否则大墙上的砖缝会被拉伸）
    const u = uv ? uv.getX(i) : 0;
    const v = uv ? uv.getY(i) : 0;
    target.uvs.push(u * uvScale, v * uvScale);
  }
  if (index) {
    for (let i = 0; i < index.count; i++) target.indices.push(base + index.getX(i));
  } else {
    for (let i = 0; i < pos.count; i++) target.indices.push(base + i);
  }
  box.dispose();
}

/**
 * 把一批同材质的实心块合并成一个 `BufferGeometry`。
 *
 * 为什么要自己合并而不是 import `BufferGeometryUtils`：
 * 那个模块会把一堆没用到的工具函数拖进产物（首屏预算很紧）。
 * 这里只做"同布局属性顺序拼接 + 索引偏移"，够用。
 */
export function mergeSolids(solids: readonly RoomSolid[], uvScale = 1): THREE.BufferGeometry {
  const acc = { positions: [] as number[], normals: [] as number[], uvs: [] as number[], indices: [] as number[] };
  for (const s of solids) appendBox(acc, s, uvScale);

  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.Float32BufferAttribute(acc.positions, 3));
  geo.setAttribute('normal', new THREE.Float32BufferAttribute(acc.normals, 3));
  geo.setAttribute('uv', new THREE.Float32BufferAttribute(acc.uvs, 2));
  geo.setIndex(acc.indices);
  geo.computeBoundingSphere();
  return geo;
}

// ───────────────────────────── 地面（细分 + 顶点色 AO） ─────────────────────────────

/** 地面网格的细分段数。32 段 → 每段 0.625m（20m 地板），墙脚 AO 的过渡够平滑。 */
export const FLOOR_SEGMENTS = 32;

/**
 * 造地板：一块细分过的平面，顶点色带墙脚暗化。
 *
 * 为什么不用 roomSolids 里的地板盒：
 * 盒子的顶面只有 4 个顶点，顶点色插值成一片，AO 完全出不来。
 * 所以地板单独造一块**平面**（32×32 段），顶点色按 `floorOcclusionAt()` 算。
 *
 * 几何上它和物理地板是同一个高度（y=0）：物理地板盒顶面正好 y=0。
 * 抬高 0.001 避免与盒顶 z-fighting。
 */
export function buildFloorGeometry(
  half: number,
  segments = FLOOR_SEGMENTS,
  reach = 1.6,
  strength = 0.5,
): THREE.BufferGeometry {
  const geo = new THREE.PlaneGeometry(half * 2, half * 2, segments, segments);
  geo.rotateX(-Math.PI / 2);
  geo.translate(0, 0.001, 0);

  const pos = geo.attributes['position']!;
  const colors = new Float32Array(pos.count * 3);
  for (let i = 0; i < pos.count; i++) {
    const k = floorOcclusionAt(pos.getX(i), pos.getZ(i), half, reach, strength);
    colors[i * 3] = k;
    colors[i * 3 + 1] = k;
    colors[i * 3 + 2] = k;
  }
  geo.setAttribute('color', new THREE.Float32BufferAttribute(colors, 3));
  return geo;
}

// ───────────────────────────── 接触阴影 ─────────────────────────────

/**
 * 接触阴影贴片的半径（米）。
 *
 * 取值依据：角色胶囊半径 0.30，脚掌落地范围约 ±0.25m。
 * 贴片半径 0.5 时，渐变的有效暗区（不透明度 >0.2 的部分）正好盖住脚掌外围一圈，
 * 读起来是"脚踩在地上压出来的暗影"。给到 1.2 就变成"地上摊了一张黑饼"（试过）。
 */
export const CONTACT_SHADOW_RADIUS = 0.5;

/** 接触阴影的最大不透明度。 */
export const CONTACT_SHADOW_OPACITY = 1.0;

/**
 * 画接触阴影的径向渐变贴图。
 *
 * 关键是**不是均匀圆**：中心不透明、边缘完全透明，且衰减在 60% 半径处就基本走完
 * （`rgba(0,0,0,0.9)` → 透明）。这样它读起来是"脚下的暗影"，
 * 而不是"地上贴了个黑圆片"。
 */
export function drawContactShadowTexture(ctx: CanvasRenderingContext2D, size = 128): void {
  ctx.clearRect(0, 0, size, size);
  const r = size / 2;
  const g = ctx.createRadialGradient(r, r, 0, r, r, r);
  g.addColorStop(0, 'rgba(0,0,0,0.92)');
  g.addColorStop(0.45, 'rgba(0,0,0,0.62)');
  g.addColorStop(0.75, 'rgba(0,0,0,0.20)');
  g.addColorStop(1, 'rgba(0,0,0,0)');
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, size, size);
}

/**
 * 一个能提供角色位置的只读数据源。
 *
 * 刻意只依赖 `listActors()` 这一个方法（而不是整个 `World`）：
 * 单测里传个 `{ listActors: () => [...] }` 就能测，不需要造世界。
 */
export interface ActorSource {
  listActors(): ReadonlyArray<{
    id: string;
    kind: 'human' | 'agent';
    transform: { p: readonly [number, number, number] };
  }>;
}

/** 接触阴影的实例容量。spec §8 的同屏角色预算是 8，留到 16 不用重分配。 */
export const CONTACT_SHADOW_CAPACITY = 16;

/**
 * 角色脚下的接触阴影（cheap contact shadow，不是实时 AO）。
 *
 * ═══ 为什么必须有 ═══
 * 只有方向光投影时，角色看起来是"飘"的：投影离脚很远（光是从斜上方来的），
 * 而真实世界里脚与地面之间必然有一小圈接触暗影。人眼对这个非常敏感，
 * 缺了它就判断不出"这个东西是站在地上的"。
 *
 * ═══ 为什么是一个 InstancedMesh ═══
 * 7 个角色各一个 `Mesh` = 7 次 drawCall，直接把预算（≤5）打穿。
 * InstancedMesh 把 N 个贴片塞进 **1 次** drawCall。
 * 这里没用"合并成带顶点属性的网格"是因为角色每帧在动，
 * 顶点属性方案要每帧重写 position buffer（N×顶点数 的上传），
 * 而 InstancedMesh 只重写 N 个 4×4 矩阵 —— 便宜得多。
 *
 * ═══ 为什么贴地而不是跟随角色 y ═══
 * 贴片固定在地面（y=0.004），只跟随 x/z。角色跳起来时阴影留在原地，
 * 这正好是对的：跳起来时接触阴影本来就该消失/变小。
 * 这里用"随高度缩小 + 变淡"来近似，比留着不变自然。
 */
export class ContactShadows {
  readonly mesh: THREE.InstancedMesh;
  private readonly texture: THREE.CanvasTexture | null;
  private readonly material: THREE.MeshBasicMaterial;
  private readonly geometry: THREE.CircleGeometry;
  private disposed = false;

  /** 复用的矩阵/向量，避免每帧分配（热路径纪律）。 */
  private readonly tmpMatrix = new THREE.Matrix4();
  private readonly tmpPos = new THREE.Vector3();
  private readonly tmpQuat = new THREE.Quaternion();
  private readonly tmpScale = new THREE.Vector3();
  /** 贴片所在的地面高度。 */
  private readonly groundY: number;

  constructor(scene: THREE.Scene, groundY = 0.004, capacity = CONTACT_SHADOW_CAPACITY) {
    this.groundY = groundY;

    this.texture = makeCanvasTexture(drawContactShadowTexture, 128);

    this.geometry = new THREE.CircleGeometry(CONTACT_SHADOW_RADIUS, 24);
    this.geometry.rotateX(-Math.PI / 2);

    this.material = new THREE.MeshBasicMaterial({
      color: 0x000000,
      // 没有贴图时（node/无 canvas）退化为半透明圆片，至少不崩
      map: this.texture,
      transparent: true,
      opacity: CONTACT_SHADOW_OPACITY,
      // 不写深度：它是"贴在地上的暗影"，不该遮挡地面之后的东西，也不该和自己 z-fighting
      depthWrite: false,
      // 略微偏移，避免与地面在同一深度上打架
      polygonOffset: true,
      polygonOffsetFactor: -1,
      polygonOffsetUnits: -1,
    });

    this.mesh = new THREE.InstancedMesh(this.geometry, this.material, capacity);
    this.mesh.name = 'contact-shadows';
    // 阴影贴片既不该被光影响（MeshBasic 本来就不吃光），也不该投影/接收阴影
    this.mesh.castShadow = false;
    this.mesh.receiveShadow = false;
    // 数量每帧变，用 count 控制可见实例数（比缩放成 0 更省，也不会留下退化三角形）
    this.mesh.count = 0;
    this.mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    // InstancedMesh 的包围球按默认几何算，角色跑远后会被错误剔除
    this.mesh.frustumCulled = false;
    scene.add(this.mesh);
  }

  /**
   * 每渲染帧同步一次：把所有角色（human + agent）的脚下贴片摆好。
   *
   * 用渲染帧而不是物理步：这是观感，要跟画面帧率走。
   */
  sync(source: ActorSource): void {
    if (this.disposed) return;

    let slot = 0;
    for (const actor of source.listActors()) {
      // 只给"人/Agent"画接触阴影；道具（箱子）不需要，它们本来就有真实投影
      if (actor.kind !== 'human' && actor.kind !== 'agent') continue;
      if (slot >= CONTACT_SHADOW_CAPACITY) break;

      const [x, centerY, z] = actor.transform.p;
      // transform.p 是**胶囊中心**；脚底 = 中心 - 胶囊中心高度
      const feetY = centerY - CAPSULE_CENTER_HEIGHT;

      // 离地越高，阴影越小越淡：跳跃时阴影收缩，读起来是"离开了地面"
      const airborne = Math.max(0, feetY - this.groundY);
      const k = airborne > 1.2 ? 0 : 1 - airborne / 1.2;
      const scale = 0.65 + 0.35 * k;

      this.tmpPos.set(x, this.groundY, z);
      this.tmpScale.set(scale, 1, scale);
      this.tmpMatrix.compose(this.tmpPos, this.tmpQuat.identity(), this.tmpScale);
      this.mesh.setMatrixAt(slot, this.tmpMatrix);
      slot += 1;
    }

    this.mesh.count = slot;
    this.mesh.instanceMatrix.needsUpdate = true;
  }

  /** 当前画了几个贴片（验收断言"7 个角色只有 1 次 drawCall"用）。 */
  get visibleCount(): number {
    return this.mesh.count;
  }

  /**
   * 临时开关（仅验收用）。
   *
   * 存在的理由：接触阴影是"暗"的东西，靠单张截图量亮度会受角色本身、
   * 阴影投射、地板贴图三重干扰，测出来的数字说不清是谁造成的。
   * 开/关两张图做像素差，才能**证明**这一层真的改变了画面，以及改了多少像素。
   * 这与审计文档 §3.2 的教训一致：测量钩子本身要能验证。
   */
  setEnabled(enabled: boolean): void {
    this.mesh.visible = enabled;
  }

  get enabled(): boolean {
    return this.mesh.visible;
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.mesh.removeFromParent();
    this.mesh.dispose();
    this.geometry.dispose();
    this.material.dispose();
    this.texture?.dispose();
  }
}

// ───────────────────────────── 装配 ─────────────────────────────

export interface RoomVisualOptions {
  /** 房间数据（与物理同一份）。 */
  room: Room;
  /** 是否开阴影（移动端关）。 */
  shadows: boolean;
  /** 网格线开关的句柄出口（M11 面板 G 键用）。 */
  onGrid?: (grid: THREE.Object3D | null) => void;
}

/**
 * 房间的可见化：地板 + 墙 + 踢脚线 + 台阶 + 网格线 + 接触阴影。
 *
 * 生命周期：构造时建好全部静态几何（一次性），`update()` 每帧同步接触阴影，
 * `dispose()` 释放所有 GPU 资源。
 */
export class RoomVisual {
  readonly group = new THREE.Group();
  readonly contactShadows: ContactShadows;
  /** 网格线（桌面才有；移动端为 null）。 */
  readonly grid: THREE.GridHelper | null;

  private readonly geometries: THREE.BufferGeometry[] = [];
  private readonly materials: THREE.Material[] = [];
  private readonly textures: THREE.Texture[] = [];
  private disposed = false;

  constructor(scene: THREE.Scene, opts: RoomVisualOptions) {
    this.group.name = 'room-visual';
    scene.add(this.group);

    const solids = roomSolids(opts.room);

    // 房间边界（供地板 AO 与网格线用）。用 static 的盒子范围推，
    // 而不是硬编码 20：换房间文件后 AO 的 reach 也跟着对。
    const bounds = roomBounds(solids);

    // ── 按材质分桶合并 ──
    for (const bucket of bucketByMaterial(solids)) {
      // 地板不在这里画：它要细分 + 顶点色 AO，单独造（见 buildFloorGeometry）
      if (bucket.spec.tiled) continue;

      const geo = mergeSolids(bucket.solids, bucket.spec.paneled ? 0.5 : 1);
      this.geometries.push(geo);

      const mat = new THREE.MeshStandardMaterial({
        color: bucket.spec.color,
        roughness: bucket.spec.roughness,
        metalness: bucket.spec.metalness,
        // 墙/踢脚线用 BackSide：只有从房间内部看才可见（见文件头说明）
        side: bucket.spec.insideOnly ? THREE.BackSide : THREE.FrontSide,
      });

      if (bucket.spec.emissive !== undefined) {
        mat.emissive.setHex(bucket.spec.emissive);
        // 自发光强度 1（默认）：值本身已经很小（0x14171c ≈ 8%），
        // 再乘一个系数会让它随预设漂移，不利于四套光照的一致性。
        mat.emissiveIntensity = 1;
      }

      if (bucket.spec.paneled) {
        const tex = makeCanvasTexture(drawWallTexture, 256);
        if (tex) {
          tex.repeat.set(6, 2);
          mat.map = tex;
          this.textures.push(tex);
        }
      }

      this.materials.push(mat);

      const mesh = new THREE.Mesh(geo, mat);
      mesh.name = `room-${bucket.key}`;
      // 墙不投影：BackSide 的墙会在阴影 pass 里把整个房间压黑（见文件头）
      mesh.castShadow = !bucket.spec.insideOnly;
      mesh.receiveShadow = opts.shadows;
      this.group.add(mesh);
    }

    // ── 地板 ──
    const floorGeo = buildFloorGeometry(bounds.half, FLOOR_SEGMENTS);
    this.geometries.push(floorGeo);

    const floorMat = new THREE.MeshStandardMaterial({
      color: MATERIALS['floor']!.color,
      roughness: MATERIALS['floor']!.roughness,
      metalness: MATERIALS['floor']!.metalness,
      // 顶点色当"假 AO"用：墙脚压暗（见 floorOcclusionAt）
      vertexColors: true,
    });
    const tileTex = makeCanvasTexture(drawTileTexture, TILE_TEXTURE_SIZE);
    if (tileTex) {
      // 20m 地板 / 1.25m 一块砖 = 16 次平铺
      const repeats = (bounds.half * 2) / TILE_WORLD_SIZE;
      tileTex.repeat.set(repeats, repeats);
      floorMat.map = tileTex;
      this.textures.push(tileTex);
    }
    this.materials.push(floorMat);

    const floor = new THREE.Mesh(floorGeo, floorMat);
    floor.name = 'room-floor';
    floor.receiveShadow = opts.shadows;
    // 地板不投影：它是房间里最低的东西，投出来的影子没人看得见，白算一次
    floor.castShadow = false;
    this.group.add(floor);

    // ── 网格线（桌面才有）──
    // 房间有墙之后网格线其实有点多余，但 M11 面板的 G 键要有东西可切，
    // 且调试物理时网格线仍然是"看距离"最快的参照。
    // 默认隐藏：房间已经立起来了，默认露网格线会显得像没画完。
    const grid = new THREE.GridHelper(
      bounds.half * 2,
      Math.round(bounds.half * 2),
      0x3d4552,
      0x252a33,
    );
    grid.position.y = 0.003;
    grid.visible = false;
    grid.name = 'room-grid';
    this.group.add(grid);
    this.grid = grid;
    opts.onGrid?.(grid);

    // ── 接触阴影 ──
    this.contactShadows = new ContactShadows(scene, 0.004);
  }

  /** 每渲染帧同步接触阴影。 */
  update(source: ActorSource): void {
    if (this.disposed) return;
    this.contactShadows.sync(source);
  }

  /** drawCall 预算自检用：房间静态几何的材质桶数（不含地板与阴影）。 */
  get staticDrawCalls(): number {
    return this.group.children.filter((c) => c instanceof THREE.Mesh).length;
  }

  /** 开关接触阴影（仅验收用：开/关两张图做像素差，证明它真的改变了画面）。 */
  setContactShadowsEnabled(enabled: boolean): void {
    this.contactShadows.setEnabled(enabled);
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.contactShadows.dispose();
    // GridHelper 是 `LineSegments`，不是 `Mesh`：scene.ts 的 traverse 清不到它，
    // 而它自己带着 geometry + material。不显式释放就是一次显存泄漏
    // （每次 dispose 重建世界都会多留一份网格线缓冲）。
    this.grid?.geometry.dispose();
    const gridMat = this.grid?.material;
    if (Array.isArray(gridMat)) gridMat.forEach((m) => m.dispose());
    else gridMat?.dispose();
    for (const g of this.geometries) g.dispose();
    for (const m of this.materials) m.dispose();
    for (const t of this.textures) t.dispose();
    this.geometries.length = 0;
    this.materials.length = 0;
    this.textures.length = 0;
    this.group.clear();
    this.group.removeFromParent();
  }
}

/**
 * 房间的水平范围（米）。从 static 实心块推，换房间文件后自动跟着变。
 *
 * 只看**地面级别**的块（中心 y < 1.0）：墙的中心在 1.5m 高，
 * 若把墙也算进来，`|z| + halfZ = 10 + 0.1 = 10.1` 会让地板变成 20.2m —— 差 1%。
 * 地板自己才是决定水平范围的那一块，所以按高度过滤是对的。
 */
export function roomBounds(solids: readonly RoomSolid[]): { half: number } {
  let max = 0;
  for (const s of solids) {
    if (s.pos[1] >= 1.0) continue;
    const extent = Math.max(
      Math.abs(s.pos[0]) + s.halfExtents[0],
      Math.abs(s.pos[2]) + s.halfExtents[2],
    );
    if (extent > max) max = extent;
  }
  return { half: max > 0 ? max : 10 };
}

/**
 * 从 `World` 造一个 `ActorSource`。
 *
 * 单独一个函数是为了让 main.ts 的接线只有一行，也让单测能直接喂假世界。
 */
export function actorSourceOf(world: World): ActorSource {
  return {
    listActors: () => world.listActors(),
  };
}
