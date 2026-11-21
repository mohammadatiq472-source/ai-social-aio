/**
 * 交互对象的可见化（spec §6 M10 的"能看见才能验收"）。
 *
 * 为什么需要这个文件：`rooms/demo-room.ts` 原来 `props` 与 `seats` 都是空数组，
 * 于是 M10 的三件事在页面上**一个都看不见**——
 * 走近椅子坐下（没有椅子）、推箱子（没有箱子）、点角色切焦点（角色有，但没有可视反馈）。
 * 一个看不见的功能没法验收，也没法录片。
 *
 * 三条边界：
 *
 * 1. **这个文件只画，不判定。** 座位是否够得着由 `interact/index.ts` 的
 *    `nearestSeat()` 算，箱子在哪由物理侧 `physics.roomProps` 给。
 *    这里只把"已有的数据"变成可见的网格，避免出现"看见的椅子"和"能坐的椅子"不是同一把。
 *
 * 2. **座位标记必须是**矮的、半透明的、无碰撞的**。**
 *    座位在 v0.1 不是实体家具（`RoomSeat` 只有 pos/rot，没有尺寸），
 *    画一把"真椅子"会让人以为它挡路；但画个完全看不见的点又没法瞄准。
 *    折中：地面上一个薄圆环 + 一条朝向短线。圆环告诉你"站这儿按 E"，
 *    短线告诉你"坐下后面朝哪"。
 *
 * 3. **箱子用物理侧的真实位置。**
 *    道具是动态刚体，位置每帧在变。若渲染自己记位置，推箱时画面会和物理错开。
 *    所以 `syncProps()` 每帧从 `physics.roomProps` 读 `body.translation()`。
 */

import * as THREE from 'three';
import type { RoomSeat } from '../core/room';

/** 座位标记的外径（米）。略大于角色胶囊半径 0.30，看起来"站得进去"。 */
export const SEAT_MARKER_RADIUS = 0.34;

/** 座位朝向短线的长度（米）。 */
export const SEAT_FACING_LEN = 0.42;

/** 座位标记离地高度（米）。抬高一点避免与地面 z-fighting。 */
export const SEAT_MARKER_Y = 0.012;

/** 交互提示色（与 6 个 Agent 的染色都不同，避免混淆）。 */
const SEAT_COLOR = 0x8fe3c8;

/**
 * 座位标记集合。
 *
 * **drawCall 纪律**：所有座位的所有标记合并成**一个** mesh（一次 drawCall）。
 *
 * 为什么值得这么做：审计实测 7 个角色 63 drawCall/帧，已经贴着移动端上限；
 * 若每个座位再各占 2 个（圆环 + 朝向条），两把椅子就是 4 个，
 * 将来加到 8 个座位就变成 16 个——交互提示这种"辅助图形"不该吃掉角色预算。
 * 合并的代价是失去"单独高亮某个座位"的能力，所以高亮改成**顶点色**实现：
 * 每个座位的顶点带一个 baseColor，highlight 时只改那一段顶点色并标 needsUpdate。
 * 这比换材质（会拆 drawCall）或加 mesh（会加 drawCall）都省。
 */
export class SeatMarkers {
  readonly group = new THREE.Group();
  private readonly markers = new Map<string, { start: number; count: number }>();
  private merged: THREE.Mesh | null = null;
  private baseColors: Float32Array | null = null;
  private colorAttr: THREE.BufferAttribute | null = null;
  private disposed = false;

  constructor(scene: THREE.Scene, seats: readonly RoomSeat[]) {
    this.group.name = 'seat-markers';
    scene.add(this.group);

    if (seats.length === 0) return;

    // 每个座位：一个圆环（RingGeometry）+ 一条朝向短线（PlaneGeometry）
    const parts: THREE.BufferGeometry[] = [];
    let vertexCursor = 0;

    for (const seat of seats) {
      const seatStart = vertexCursor;

      // 圆环：绕 Y 转到水平面，再摆到座位位置
      const ring = new THREE.RingGeometry(SEAT_MARKER_RADIUS - 0.035, SEAT_MARKER_RADIUS, 28);
      ring.rotateX(-Math.PI / 2);
      ring.translate(seat.pos[0], seat.pos[1] + SEAT_MARKER_Y, seat.pos[2]);
      parts.push(ring);
      vertexCursor += vertexCountOf(ring);

      // 朝向短线：从圆心指向"坐下后面对的方向"（+Z 是 yaw=0 的前方）
      const facing = new THREE.PlaneGeometry(0.06, SEAT_FACING_LEN);
      facing.rotateX(-Math.PI / 2);
      // 先绕 Y 转座位朝向，再平移到座位
      facing.rotateY(seat.rot);
      const fx = Math.sin(seat.rot) * (SEAT_FACING_LEN / 2 + 0.02);
      const fz = Math.cos(seat.rot) * (SEAT_FACING_LEN / 2 + 0.02);
      facing.translate(seat.pos[0] + fx, seat.pos[1] + SEAT_MARKER_Y + 0.001, seat.pos[2] + fz);
      parts.push(facing);
      vertexCursor += vertexCountOf(facing);

      this.markers.set(seat.id, { start: seatStart, count: vertexCursor - seatStart });
    }

    const mergedGeo = mergeGeometries(parts);
    for (const p of parts) p.dispose();
    if (!mergedGeo) return;

    // 顶点色：高亮时只改这一段，不拆 drawCall
    const count = vertexCountOf(mergedGeo);
    const colors = new Float32Array(count * 3);
    const base = new THREE.Color(SEAT_COLOR);
    for (let i = 0; i < count; i++) {
      colors[i * 3] = base.r;
      colors[i * 3 + 1] = base.g;
      colors[i * 3 + 2] = base.b;
    }
    const colorAttr = new THREE.BufferAttribute(colors, 3);
    mergedGeo.setAttribute('color', colorAttr);

    this.baseColors = colors.slice();
    this.colorAttr = colorAttr;

    const mat = new THREE.MeshBasicMaterial({
      vertexColors: true,
      transparent: true,
      opacity: 0.6,
      side: THREE.DoubleSide,
      depthWrite: false,
    });

    const mesh = new THREE.Mesh(mergedGeo, mat);
    mesh.name = 'seat-markers-merged';
    // 座位标记不参与碰撞、不投影：它只是提示，不是几何
    mesh.castShadow = false;
    mesh.receiveShadow = false;
    this.group.add(mesh);
    this.merged = mesh;
  }

  /** 高亮某个座位（玩家站得够近时）。null = 全部恢复默认。 */
  highlight(seatId: string | null): void {
    const attr = this.colorAttr;
    const baseColors = this.baseColors;
    if (!attr || !baseColors) return;

    const colors = attr.array as Float32Array;
    colors.set(baseColors);

    if (seatId !== null) {
      const range = this.markers.get(seatId);
      if (range) {
        // 高亮色：提亮到接近白，读起来是"这个座位现在是激活的"
        const hi = new THREE.Color(0xffffff);
        for (let i = range.start; i < range.start + range.count; i++) {
          colors[i * 3] = hi.r;
          colors[i * 3 + 1] = hi.g;
          colors[i * 3 + 2] = hi.b;
        }
      }
    }
    attr.needsUpdate = true;
  }

  get count(): number {
    return this.markers.size;
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    if (this.merged) {
      this.merged.geometry.dispose();
      (this.merged.material as THREE.Material).dispose();
      this.merged = null;
    }
    this.group.removeFromParent();
    this.markers.clear();
    this.baseColors = null;
    this.colorAttr = null;
  }
}

/**
 * 取一个几何的顶点数。
 *
 * `attributes['position']` 在类型上是可选的（`noUncheckedIndexedAccess` 会报
 * "possibly undefined"）。所有 three 的内建几何都有 position，所以缺了就说明
 * 传进来的是坏几何——静默当 0 会让后续索引偏移错位，直接抛更好定位。
 */
function vertexCountOf(g: THREE.BufferGeometry): number {
  const attr = g.attributes['position'];
  if (!attr) {
    throw new Error('mergeGeometries: 几何缺少 position 属性（无法参与合并）');
  }
  return attr.count;
}

/**
 * 合并若干几何成一个（只用 position/normal/uv 三个属性）。
 *
 * 为什么不 import `three/examples/jsm/utils/BufferGeometryUtils.js`：
 * 那个模块会把一堆没用到的工具函数也拖进产物（首屏预算 3MB 很紧）。
 * 这里只做"所有输入几何属性布局相同 → 顺序拼起来 + 索引偏移"这一件事，
 * 20 行够用，且 RingGeometry 与 PlaneGeometry 都是 indexed + 同属性集。
 */
function mergeGeometries(geos: readonly THREE.BufferGeometry[]): THREE.BufferGeometry | null {
  if (geos.length === 0) return null;
  if (geos.length === 1) return geos[0]!.clone();

  const attrs = ['position', 'normal', 'uv'] as const;
  let vertexTotal = 0;
  let indexTotal = 0;
  for (const g of geos) {
    vertexTotal += vertexCountOf(g);
    indexTotal += g.index ? g.index.count : vertexCountOf(g);
  }

  const out = new THREE.BufferGeometry();
  for (const name of attrs) {
    const first = geos[0]!.attributes[name];
    if (!first) continue;
    const itemSize = first.itemSize;
    const merged = new Float32Array(vertexTotal * itemSize);
    let offset = 0;
    for (const g of geos) {
      const a = g.attributes[name];
      if (!a) continue;
      const src = a.array as ArrayLike<number>;
      for (let i = 0; i < src.length; i++) merged[offset + i] = src[i]!;
      offset += src.length;
    }
    out.setAttribute(name, new THREE.BufferAttribute(merged, itemSize));
  }

  const indices = new Uint32Array(indexTotal);
  let idxOffset = 0;
  let vertexBase = 0;
  for (const g of geos) {
    const vCount = vertexCountOf(g);
    if (g.index) {
      const src = g.index.array as ArrayLike<number>;
      for (let i = 0; i < src.length; i++) indices[idxOffset + i] = src[i]! + vertexBase;
      idxOffset += src.length;
    } else {
      for (let i = 0; i < vCount; i++) indices[idxOffset + i] = i + vertexBase;
      idxOffset += vCount;
    }
    vertexBase += vCount;
  }
  out.setIndex(new THREE.BufferAttribute(indices, 1));
  return out;
}

/**
 * 道具（箱子）的可见化。
 *
 * 数据源是**物理侧**的 `roomProps`（`physics.engine` 的池化条目），
 * 每帧读 `body.translation()` / `rotation()`。
 * 绝不自己积分位置：那会和物理漂移，表现为"箱子被推走了但画面里的箱子还在原地"。
 *
 * **drawCall 纪律**：所有同尺寸的箱子合并成一个 `InstancedMesh`（1 次 drawCall）。
 * 箱子天然是"同一几何 × N 个实例"，是 InstancedMesh 的标准场景；
 * 每个箱子一个 Mesh 在 2 个箱子时只是 +2，但道具池上限是 256，
 * 将来"推箱子小游戏"一放就是十几个，那时差别就是 15 次 drawCall。
 * 不同尺寸的箱子会分成不同的 InstancedMesh（按 halfExtents 分桶）。
 */
export interface PropBodyLike {
  body: {
    translation(): { x: number; y: number; z: number };
    rotation(): { x: number; y: number; z: number; w: number };
  };
  halfExtents: [number, number, number];
  active: boolean;
}

/** 一个尺寸桶：同尺寸的道具共用一个 InstancedMesh。 */
interface PropBucket {
  /** 这个桶里每个实例对应 props 数组的哪个下标。 */
  indices: number[];
  mesh: THREE.InstancedMesh;
  geo: THREE.BoxGeometry;
}

export class PropMeshes {
  readonly group = new THREE.Group();
  private readonly buckets: PropBucket[] = [];
  private readonly material: THREE.MeshStandardMaterial;
  private readonly shadows: boolean;
  /** 复用矩阵/四元数，避免每帧 new（热路径纪律）。 */
  private readonly tmpMatrix = new THREE.Matrix4();
  private readonly tmpQuat = new THREE.Quaternion();
  private readonly tmpPos = new THREE.Vector3();
  private readonly tmpScale = new THREE.Vector3(1, 1, 1);
  private disposed = false;

  constructor(scene: THREE.Scene, props: readonly PropBodyLike[], opts: { shadows: boolean }) {
    this.group.name = 'prop-meshes';
    this.shadows = opts.shadows;
    scene.add(this.group);

    // 箱子用暖木色，与地面（冷灰）和角色（彩色）都区分得开
    this.material = new THREE.MeshStandardMaterial({
      color: 0xb9855a,
      roughness: 0.82,
      metalness: 0.02,
    });

    // 按尺寸分桶（同尺寸才能共用 InstancedMesh）
    const byKey = new Map<string, number[]>();
    for (let i = 0; i < props.length; i++) {
      const [hx, hy, hz] = props[i]!.halfExtents;
      const key = `${hx},${hy},${hz}`;
      let arr = byKey.get(key);
      if (!arr) {
        arr = [];
        byKey.set(key, arr);
      }
      arr.push(i);
    }

    for (const indices of byKey.values()) {
      const [hx, hy, hz] = props[indices[0]!]!.halfExtents;
      // BoxGeometry 的参数是**全尺寸**，而 halfExtents 是半尺寸
      const geo = new THREE.BoxGeometry(hx * 2, hy * 2, hz * 2);
      const mesh = new THREE.InstancedMesh(geo, this.material, indices.length);
      mesh.name = 'prop-instanced';
      mesh.castShadow = this.shadows;
      mesh.receiveShadow = this.shadows;
      // 实例矩阵每帧都会写，先标脏一次让首帧可见
      mesh.instanceMatrix.needsUpdate = true;
      this.group.add(mesh);
      this.buckets.push({ indices, mesh, geo });
    }

    // 首帧就摆到位，避免"进房瞬间箱子在原点"
    this.sync(props);
  }

  /**
   * 每**渲染帧**同步一次位置与朝向。
   *
   * 用渲染帧而不是物理步：物理 60Hz、画面 60/120Hz，
   * 在渲染帧里读刚体的**最新**位置，画面永远跟得上物理。
   * （这里不做插值：60Hz 物理 + 60fps 渲染时插值收益很小，还会引入一帧延迟。）
   */
  sync(props: readonly PropBodyLike[]): void {
    if (this.disposed) return;

    for (const bucket of this.buckets) {
      let visibleCount = 0;
      for (let slot = 0; slot < bucket.indices.length; slot++) {
        const p = props[bucket.indices[slot]!];
        if (!p || !p.active) {
          // 池里闲置的条目：缩到 0 让它在屏幕上消失（InstancedMesh 没有 per-instance visible）
          this.tmpScale.set(0, 0, 0);
          this.tmpMatrix.compose(this.tmpPos.set(0, 0, 0), this.tmpQuat.identity(), this.tmpScale);
          bucket.mesh.setMatrixAt(slot, this.tmpMatrix);
          continue;
        }
        const t = p.body.translation();
        const r = p.body.rotation();
        this.tmpScale.set(1, 1, 1);
        this.tmpMatrix.compose(
          this.tmpPos.set(t.x, t.y, t.z),
          this.tmpQuat.set(r.x, r.y, r.z, r.w),
          this.tmpScale,
        );
        bucket.mesh.setMatrixAt(slot, this.tmpMatrix);
        visibleCount += 1;
      }
      // 整桶都空了就藏起来（省一次 drawCall）
      bucket.mesh.visible = visibleCount > 0;
      bucket.mesh.instanceMatrix.needsUpdate = true;
    }
  }

  get count(): number {
    let n = 0;
    for (const b of this.buckets) n += b.indices.length;
    return n;
  }

  /** drawCall 数（= 尺寸桶数）。验收断言"箱子不额外增加 drawCall"用。 */
  get drawCallCount(): number {
    return this.buckets.length;
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    for (const b of this.buckets) {
      b.mesh.dispose();
      b.geo.dispose();
      b.mesh.removeFromParent();
    }
    this.buckets.length = 0;
    this.material.dispose();
    this.group.removeFromParent();
  }
}
