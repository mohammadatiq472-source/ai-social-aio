/**
 * 物理 debug draw（spec §6 M3 第 7 条 / §6 M11）。
 *
 * 用 `THREE.LineSegments` 画 collider 线框，按碰撞层着色，D 键切换。
 *
 * 三个实现要点：
 *
 * 1. **预分配固定容量的顶点缓冲**，每帧只改内容不改长度。
 *    `BufferGeometry.setAttribute` 每帧重建会让 GPU 反复上传，
 *    而且旧的 BufferAttribute 变成垃圾——这正是 spec §8 要盯的堆增长来源。
 *
 * 2. **形状用解析式画，不读 Rapier 的 debugRender**。
 *    Rapier 的 `world.debugRender()` 会返回它自己算好的线框，但它只按形状类型上色、
 *    且每次调用都新建 Float32Array（每帧一次分配）。
 *    我们自己遍历 collider、按层取色，颜色语义才对得上 layers.ts 的矩阵。
 *
 * 3. **D 键监听可卸载**。e2e 与 verify 里会反复建销毁世界，
 *    监听器泄漏会让第一次的 D 键还能切到已经销毁的场景。
 */

import * as THREE from 'three';
import type RAPIER_NS from '@dimforge/rapier3d-compat';
import { LAYER_COLORS, layerOfGroups } from './layers';

/** 单个碰撞体最多画多少条线段：cuboid 12 条边，capsule 约 40 条。留足余量。 */
const SEGMENTS_PER_COLLIDER = 64;
/** 顶点数 = 线段数 × 2 个端点。 */
const VERTS_PER_COLLIDER = SEGMENTS_PER_COLLIDER * 2;

export interface DebugDrawOptions {
  /** 初始是否可见。默认 false（D 键第一次按下才显示）。 */
  visible?: boolean;
  /** 容量：能同时画多少个碰撞体。超出的不画（并在 stats 里报告）。 */
  capacity?: number;
  /** 是否自动挂 D 键监听。e2e 里通常关掉，用 setVisible 直接控制。 */
  bindKey?: boolean;
  /** 按键监听的宿主，默认 window。 */
  keyTarget?: Pick<Window, 'addEventListener' | 'removeEventListener'>;
}

export interface DebugDrawStats {
  visible: boolean;
  /** 本帧实际画出的碰撞体数。 */
  drawn: number;
  /** 因容量不足被跳过的数量（正常应为 0）。 */
  skipped: number;
  /** 本帧线段数。 */
  segments: number;
}

/**
 * 物理线框渲染器。
 *
 * 用法：
 * ```ts
 * const dd = new PhysicsDebugDraw({ scene, capacity: 512 });
 * dd.sync(world);       // 每帧（或每 N 帧）调一次
 * dd.setVisible(true);  // 或按 D
 * dd.dispose();
 * ```
 */
export class PhysicsDebugDraw {
  readonly lines: THREE.LineSegments;
  readonly material: THREE.LineBasicMaterial;
  readonly geometry: THREE.BufferGeometry;

  private readonly capacity: number;
  private readonly positions: Float32Array;
  private readonly colors: Float32Array;
  private readonly posAttr: THREE.BufferAttribute;
  private readonly colAttr: THREE.BufferAttribute;
  private visibleFlag: boolean;
  private drawn = 0;
  private skipped = 0;
  private segments = 0;

  private readonly keyHandler: ((e: KeyboardEvent) => void) | null = null;
  private readonly keyTarget: Pick<Window, 'addEventListener' | 'removeEventListener'> | null = null;

  /** 复用的临时向量：热路径不 new。 */
  private readonly tmpV = new THREE.Vector3();
  private readonly tmpQ = new THREE.Quaternion();
  private readonly tmpM = new THREE.Matrix4();

  constructor(scene: THREE.Scene, opts: DebugDrawOptions = {}) {
    this.capacity = Math.max(1, opts.capacity ?? 512);
    const vertCount = this.capacity * VERTS_PER_COLLIDER;

    this.positions = new Float32Array(vertCount * 3);
    this.colors = new Float32Array(vertCount * 3);
    this.posAttr = new THREE.BufferAttribute(this.positions, 3);
    this.colAttr = new THREE.BufferAttribute(this.colors, 3);
    // 线框每帧都在变，标记为动态用途，让 three 知道别做静态优化
    this.posAttr.setUsage(THREE.DynamicDrawUsage);
    this.colAttr.setUsage(THREE.DynamicDrawUsage);

    this.geometry = new THREE.BufferGeometry();
    this.geometry.setAttribute('position', this.posAttr);
    this.geometry.setAttribute('color', this.colAttr);
    // 初始 0 长度：没有任何线段时不画
    this.geometry.setDrawRange(0, 0);

    this.material = new THREE.LineBasicMaterial({
      vertexColors: true,
      transparent: true,
      opacity: 0.85,
      // 线框要"浮"在场景上，否则贴地的碰撞体边线会被地面 z-fighting 吃掉
      depthTest: true,
      depthWrite: false,
    });

    this.lines = new THREE.LineSegments(this.geometry, this.material);
    this.lines.frustumCulled = false; // 顶点每帧改，包围盒不可靠
    this.lines.renderOrder = 999; // 最后画，盖在实体上
    this.lines.name = 'physics-debug-draw';
    this.lines.visible = opts.visible ?? false;
    this.visibleFlag = this.lines.visible;
    scene.add(this.lines);

    if (opts.bindKey ?? true) {
      this.keyTarget = opts.keyTarget ?? (typeof window !== 'undefined' ? window : null);
      this.keyHandler = (e: KeyboardEvent) => {
        // 不抢输入框里的 D
        const t = e.target as HTMLElement | null;
        if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.isContentEditable)) return;
        if (e.key === 'd' || e.key === 'D') {
          if (e.ctrlKey || e.metaKey || e.altKey) return;
          this.toggle();
        }
      };
      this.keyTarget?.addEventListener('keydown', this.keyHandler);
    }
  }

  get visible(): boolean {
    return this.visibleFlag;
  }

  setVisible(v: boolean): void {
    this.visibleFlag = v;
    this.lines.visible = v;
  }

  toggle(): boolean {
    this.setVisible(!this.visibleFlag);
    return this.visibleFlag;
  }

  /**
   * 把当前物理世界的碰撞体同步到线框缓冲。
   *
   * 不可见时**直接返回**（不做任何遍历）——这是"debug draw 不影响正常帧率"的保证。
   */
  sync(world: RAPIER_NS.World): DebugDrawStats {
    if (!this.visibleFlag) {
      return { visible: false, drawn: 0, skipped: 0, segments: 0 };
    }

    let vertCursor = 0;
    let drawn = 0;
    let skipped = 0;

    const maxVerts = this.capacity * VERTS_PER_COLLIDER;

    world.forEachCollider((collider) => {
      if (!collider.isEnabled()) return;
      if (vertCursor + VERTS_PER_COLLIDER > maxVerts) {
        skipped += 1;
        return;
      }

      const layer = layerOfGroups(collider.collisionGroups());
      const color = LAYER_COLORS[layer ?? 'WORLD_STATIC'];
      const r = ((color >> 16) & 0xff) / 255;
      const g = ((color >> 8) & 0xff) / 255;
      const b = (color & 0xff) / 255;

      const t = collider.translation();
      const q = collider.rotation();
      this.tmpV.set(t.x, t.y, t.z);
      this.tmpQ.set(q.x, q.y, q.z, q.w);
      this.tmpM.compose(this.tmpV, this.tmpQ, ONE);

      const startVert = vertCursor;
      vertCursor = this.emitShape(collider.shape, startVert, r, g, b);
      if (vertCursor > startVert) drawn += 1;
      else skipped += 1;
    });

    this.segments = vertCursor / 2;
    this.geometry.setDrawRange(0, vertCursor);
    // 只更新用到的区间，避免每帧上传整个缓冲
    this.posAttr.addUpdateRange(0, vertCursor * 3);
    this.colAttr.addUpdateRange(0, vertCursor * 3);
    this.posAttr.needsUpdate = true;
    this.colAttr.needsUpdate = true;

    this.drawn = drawn;
    this.skipped = skipped;
    return { visible: true, drawn, skipped, segments: this.segments };
  }

  /**
   * 按形状类型写线段。返回写完后的顶点游标。
   *
   * 用 `instanceof` 而不是 `shape.type` 枚举：type 是数字，读代码时要翻文档；
   * instanceof 在 TS 里还能自动收窄类型拿到 halfExtents/radius。
   */
  private emitShape(
    shape: RAPIER_NS.Shape,
    cursor: number,
    r: number,
    g: number,
    b: number,
  ): number {
    const R = shape.constructor as unknown;
    void R;

    if (shape instanceof CUBOID_CLASS()) {
      return this.emitBox(shape.halfExtents, cursor, r, g, b);
    }
    if (shape instanceof CAPSULE_CLASS()) {
      return this.emitCapsule(shape.halfHeight, shape.radius, cursor, r, g, b);
    }
    if (shape instanceof BALL_CLASS()) {
      return this.emitBall(shape.radius, cursor, r, g, b);
    }
    if (shape instanceof CYLINDER_CLASS()) {
      return this.emitCylinder(shape.halfHeight, shape.radius, cursor, r, g, b);
    }
    if (shape instanceof TRIMESH_CLASS()) {
      return this.emitTrimeshEdges(shape.vertices, shape.indices, cursor, r, g, b);
    }
    // 未支持的形状：画一个 0.1m 的十字标记，至少能看出"这里有个碰撞体"
    return this.emitBox({ x: 0.1, y: 0.1, z: 0.1 }, cursor, r, g, b);
  }

  /** 盒体 12 条边。 */
  private emitBox(he: { x: number; y: number; z: number }, cursor: number, r: number, g: number, b: number): number {
    const { x: hx, y: hy, z: hz } = he;
    // 8 个角，索引按 (x,y,z) 的符号位
    const corners: Array<[number, number, number]> = [
      [-hx, -hy, -hz], [hx, -hy, -hz], [hx, hy, -hz], [-hx, hy, -hz],
      [-hx, -hy, hz], [hx, -hy, hz], [hx, hy, hz], [-hx, hy, hz],
    ];
    const edges: Array<[number, number]> = [
      [0, 1], [1, 2], [2, 3], [3, 0], // 后
      [4, 5], [5, 6], [6, 7], [7, 4], // 前
      [0, 4], [1, 5], [2, 6], [3, 7], // 连接
    ];
    for (const [a, bIdx] of edges) {
      const p = corners[a]!;
      const q = corners[bIdx]!;
      cursor = this.pushLine(p, q, cursor, r, g, b);
    }
    return cursor;
  }

  /** 胶囊：上下两个半球 + 若干母线。用 8 段经线近似，够看形状。 */
  private emitCapsule(halfHeight: number, radius: number, cursor: number, r: number, g: number, b: number): number {
    const RINGS = 8;
    const SEG = 8;
    for (let ring = 0; ring <= RINGS; ring++) {
      const phi = (ring / RINGS) * Math.PI; // 0..PI，从上到下
      // 上半球在 +halfHeight 之上，下半球在 -halfHeight 之下，中间是圆柱
      const y = halfHeight + radius * Math.cos(phi);
      const rad = radius * Math.sin(phi);
      for (let s = 0; s < SEG; s++) {
        const a0 = (s / SEG) * Math.PI * 2;
        const a1 = ((s + 1) / SEG) * Math.PI * 2;
        // 只在球冠区域画纬线，圆柱段由母线表达
        if (ring === 0 || ring === RINGS) continue;
        cursor = this.pushLine(
          [Math.cos(a0) * rad, y, Math.sin(a0) * rad],
          [Math.cos(a1) * rad, y, Math.sin(a1) * rad],
          cursor, r, g, b,
        );
      }
    }
    // 母线
    for (let s = 0; s < SEG; s++) {
      const a = (s / SEG) * Math.PI * 2;
      const x = Math.cos(a) * radius;
      const z = Math.sin(a) * radius;
      cursor = this.pushLine([x, -halfHeight, z], [x, halfHeight, z], cursor, r, g, b);
      // 两个半球的极点连到赤道
      cursor = this.pushLine([0, halfHeight + radius, 0], [x, halfHeight, z], cursor, r, g, b);
      cursor = this.pushLine([0, -halfHeight - radius, 0], [x, -halfHeight, z], cursor, r, g, b);
    }
    return cursor;
  }

  /** 球：3 个正交大圆。 */
  private emitBall(radius: number, cursor: number, r: number, g: number, b: number): number {
    const SEG = 12;
    for (let axis = 0; axis < 3; axis++) {
      for (let s = 0; s < SEG; s++) {
        const a0 = (s / SEG) * Math.PI * 2;
        const a1 = ((s + 1) / SEG) * Math.PI * 2;
        const p0: [number, number, number] = [0, 0, 0];
        const p1: [number, number, number] = [0, 0, 0];
        if (axis === 0) {
          p0[0] = Math.cos(a0) * radius; p0[1] = Math.sin(a0) * radius;
          p1[0] = Math.cos(a1) * radius; p1[1] = Math.sin(a1) * radius;
        } else if (axis === 1) {
          p0[0] = Math.cos(a0) * radius; p0[2] = Math.sin(a0) * radius;
          p1[0] = Math.cos(a1) * radius; p1[2] = Math.sin(a1) * radius;
        } else {
          p0[1] = Math.cos(a0) * radius; p0[2] = Math.sin(a0) * radius;
          p1[1] = Math.cos(a1) * radius; p1[2] = Math.sin(a1) * radius;
        }
        cursor = this.pushLine(p0, p1, cursor, r, g, b);
      }
    }
    return cursor;
  }

  /** 圆柱：上下两个圆 + 4 条母线。 */
  private emitCylinder(halfHeight: number, radius: number, cursor: number, r: number, g: number, b: number): number {
    const SEG = 12;
    for (let s = 0; s < SEG; s++) {
      const a0 = (s / SEG) * Math.PI * 2;
      const a1 = ((s + 1) / SEG) * Math.PI * 2;
      const c0 = Math.cos(a0) * radius;
      const s0 = Math.sin(a0) * radius;
      const c1 = Math.cos(a1) * radius;
      const s1 = Math.sin(a1) * radius;
      cursor = this.pushLine([c0, halfHeight, s0], [c1, halfHeight, s1], cursor, r, g, b);
      cursor = this.pushLine([c0, -halfHeight, s0], [c1, -halfHeight, s1], cursor, r, g, b);
      if (s % 3 === 0) {
        cursor = this.pushLine([c0, -halfHeight, s0], [c0, halfHeight, s0], cursor, r, g, b);
      }
    }
    return cursor;
  }

  /**
   * 三角网格的边。每个三角形画 3 条边（重复边不合并：合并要建哈希表，debug 用不着省这点）。
   * 容量吃紧时截断，绝不越界写。
   */
  private emitTrimeshEdges(
    vertices: Float32Array,
    indices: Uint32Array,
    cursor: number,
    r: number,
    g: number,
    b: number,
  ): number {
    const maxVerts = this.capacity * VERTS_PER_COLLIDER;
    for (let i = 0; i + 2 < indices.length; i += 3) {
      if (cursor + 6 > maxVerts) break; // 3 条边 = 6 个顶点
      const i0 = indices[i]! * 3;
      const i1 = indices[i + 1]! * 3;
      const i2 = indices[i + 2]! * 3;
      const p0: [number, number, number] = [vertices[i0]!, vertices[i0 + 1]!, vertices[i0 + 2]!];
      const p1: [number, number, number] = [vertices[i1]!, vertices[i1 + 1]!, vertices[i1 + 2]!];
      const p2: [number, number, number] = [vertices[i2]!, vertices[i2 + 1]!, vertices[i2 + 2]!];
      cursor = this.pushLine(p0, p1, cursor, r, g, b);
      cursor = this.pushLine(p1, p2, cursor, r, g, b);
      cursor = this.pushLine(p2, p0, cursor, r, g, b);
    }
    return cursor;
  }

  /** 写一条线段（局部坐标 → 世界坐标）。 */
  private pushLine(
    a: [number, number, number] | readonly number[],
    b: [number, number, number] | readonly number[],
    cursor: number,
    r: number,
    g: number,
    bl: number,
  ): number {
    const pos = this.positions;
    const col = this.colors;
    const base = cursor * 3;

    // 变换到世界空间
    this.tmpV.set(a[0]!, a[1]!, a[2]!).applyMatrix4(this.tmpM);
    pos[base] = this.tmpV.x;
    pos[base + 1] = this.tmpV.y;
    pos[base + 2] = this.tmpV.z;

    this.tmpV.set(b[0]!, b[1]!, b[2]!).applyMatrix4(this.tmpM);
    pos[base + 3] = this.tmpV.x;
    pos[base + 4] = this.tmpV.y;
    pos[base + 5] = this.tmpV.z;

    col[base] = r; col[base + 1] = g; col[base + 2] = bl;
    col[base + 3] = r; col[base + 4] = g; col[base + 5] = bl;

    return cursor + 2;
  }

  stats(): DebugDrawStats {
    return {
      visible: this.visibleFlag,
      drawn: this.drawn,
      skipped: this.skipped,
      segments: this.segments,
    };
  }

  dispose(): void {
    if (this.keyHandler && this.keyTarget) {
      this.keyTarget.removeEventListener('keydown', this.keyHandler);
    }
    this.lines.removeFromParent();
    this.geometry.dispose();
    this.material.dispose();
  }
}

const ONE = new THREE.Vector3(1, 1, 1);

// ───────────────────────────── 形状类型解析 ─────────────────────────────
// Rapier 的形状类要从注入的命名空间拿（compat 包导出的是同一批类）。
// 这里做一次惰性解析并缓存：debug draw 只在可见时跑，构造开销可接受，
// 但每帧都去查一次命名空间属性就没必要了。

let cachedRapier: RapierShapeClasses | null = null;

interface RapierShapeClasses {
  Cuboid: new (...args: never[]) => { halfExtents: { x: number; y: number; z: number } };
  Capsule: new (...args: never[]) => { halfHeight: number; radius: number };
  Ball: new (...args: never[]) => { radius: number };
  Cylinder: new (...args: never[]) => { halfHeight: number; radius: number };
  TriMesh: new (...args: never[]) => { vertices: Float32Array; indices: Uint32Array };
}

/** 绑定 Rapier 命名空间（在创建 DebugDraw 之前调一次即可）。 */
export function bindDebugDrawRapier(ns: unknown): void {
  cachedRapier = ns as RapierShapeClasses;
}

function needClasses(): RapierShapeClasses {
  if (!cachedRapier) {
    throw new Error(
      'PhysicsDebugDraw: 未绑定 Rapier 命名空间。请先调 bindDebugDrawRapier(RAPIER)。' +
        '（不直接 import 是为了让本文件不硬依赖 WASM 包，便于 node 单测。）',
    );
  }
  return cachedRapier;
}

const CUBOID_CLASS = () => needClasses().Cuboid;
const CAPSULE_CLASS = () => needClasses().Capsule;
const BALL_CLASS = () => needClasses().Ball;
const CYLINDER_CLASS = () => needClasses().Cylinder;
const TRIMESH_CLASS = () => needClasses().TriMesh;
