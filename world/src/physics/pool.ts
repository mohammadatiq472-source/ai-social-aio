/**
 * 刚体 + 碰撞体的对象池（spec §6 M3 第 6 条：热路径不 new）。
 *
 * 为什么要池：Rapier 每次 `createRigidBody` / `createCollider` 都会往 WASM 堆里
 * 申请内存并插入宽相位结构；`remove*` 之后那块内存不还给 JS，
 * JS 侧的包装对象也变成垃圾。进出房间、箱子被消耗这类"频繁生灭"会持续推高堆与 GC。
 *
 * 池的形态：**刚体与碰撞体成对池化**，一个 entry = 一个 body + 一个 cuboid collider。
 * 这不是偷懒，是 Rapier 的硬限制决定的：`Collider` **没有 `setParent`**
 * （实测 0.21.0 只有 `parent()` 读取），所以一个已存在的 collider 无法改挂到别的刚体上。
 * 想"单独池化 collider 再复用给不同刚体"在 Rapier 里做不到，
 * 只能让 collider 与 body 终身绑定、整体复用。这也正好匹配道具的实际生命周期。
 *
 * 两个必须自己兜住的坑（都实测过）：
 *
 * 1. **`setEnabled(false)` 不会立刻停下**：禁用当步它仍被积分一帧。
 *    所以 acquire 之后必须先摆位置/清零速度，再 enable。
 * 2. **`setMass` 要到下一次 step 才生效**：setMass 后立刻读 `body.mass()` 还是旧值。
 *    复用后若只信 `body.mass()`，会读到上一任的残留质量。
 *    这里自己记账，`massOf()` 读的是真值。
 *
 * 另外，形状用 `collider.setHalfExtents()` 原地改，而不是 `setShape(new Cuboid(...))`：
 * 后者每次 acquire 都 new 一个 JS 形状对象，池的意义就没了一半。
 */

import type RAPIER_NS from '@dimforge/rapier3d-compat';
import type { Rapier } from './bake';

/** 池化条目：一个动态刚体 + 一个 cuboid 碰撞体，终身绑定。 */
export interface PooledProp {
  readonly body: RAPIER_NS.RigidBody;
  readonly collider: RAPIER_NS.Collider;
  /** 每次 acquire +1。持有旧代际的调用方应丢弃自己的引用（防止用了个已回收的）。 */
  generation: number;
  /** 是否在使用中。 */
  active: boolean;
  /** 自己记账的质量（Rapier 的 mass() 有一步延迟，不可信）。 */
  mass: number;
  /** 当前半尺寸，便于断言"确实改了形状"。 */
  halfExtents: [number, number, number];
}

export interface PropPoolOptions {
  /** 预分配数量。热路径上第一次 acquire 不会触发扩容。 */
  preallocate?: number;
  /**
   * 是否允许扩容。`false` 时池空即抛 —— 这正是"热路径零 new"的断言点：
   * 单测里把 allowGrowth 关掉跑一轮完整生命周期，能建出来就说明池够用。
   */
  allowGrowth?: boolean;
  /** 碰撞层。道具默认 PROP。 */
  layer?: 'PROP' | 'CHARACTER';
  /** 摩擦。箱子要有点阻力，不然一推就滑很远。 */
  friction?: number;
  /** 弹性。道具默认 0：弹起来的箱子最难做交互。 */
  restitution?: number;
  /** 是否开 CCD。spec §6 M3 第 3 条：只有角色胶囊与快速道具开。 */
  ccd?: boolean;
  /** 线性阻尼，抑制箱子被推后的长时间滑动。 */
  linearDamping?: number;
  /** 角阻尼，抑制箱子乱转。 */
  angularDamping?: number;
}

/**
 * 道具池。所有 entry 都是 dynamic 刚体 + cuboid collider。
 *
 * 用法（热路径上零 WASM 分配）：
 * ```ts
 * const p = pool.acquireBox(0.25, 0.25, 0.25, 10, 0, 0.25, 1, 0,0,0,1);
 * // ... 物理步 ...
 * pool.release(p);
 * ```
 */
export class PropPool {
  private readonly free: PooledProp[] = [];
  private readonly live = new Set<PooledProp>();
  private readonly all: PooledProp[] = [];
  private readonly allowGrowth: boolean;
  private readonly groups: number;
  private readonly friction: number;
  private readonly restitution: number;
  private readonly ccd: boolean;
  private readonly linearDamping: number;
  private readonly angularDamping: number;

  constructor(
    private readonly RAPIER: Rapier,
    private readonly world: RAPIER_NS.World,
    opts: PropPoolOptions = {},
  ) {
    this.allowGrowth = opts.allowGrowth ?? true;
    this.friction = opts.friction ?? 0.7;
    this.restitution = opts.restitution ?? 0;
    this.ccd = opts.ccd ?? false;
    this.linearDamping = opts.linearDamping ?? 0.05;
    this.angularDamping = opts.angularDamping ?? 0.05;

    // 层掩码在构造时算一次：热路径上不再查表
    const layer = opts.layer ?? 'PROP';
    this.groups = interactionGroupsFor(layer);

    const pre = opts.preallocate ?? 0;
    for (let i = 0; i < pre; i++) this.free.push(this.createEntry());
  }

  private createEntry(): PooledProp {
    const bodyDesc = this.RAPIER.RigidBodyDesc.dynamic()
      .setEnabled(false)
      .setLinearDamping(this.linearDamping)
      .setAngularDamping(this.angularDamping);
    if (this.ccd) bodyDesc.setCcdEnabled(true);
    const body = this.world.createRigidBody(bodyDesc);

    const collider = this.world.createCollider(
      this.RAPIER.ColliderDesc.cuboid(0.5, 0.5, 0.5)
        .setCollisionGroups(this.groups)
        .setFriction(this.friction)
        .setRestitution(this.restitution)
        .setEnabled(false),
      body,
    );

    const entry: PooledProp = {
      body,
      collider,
      generation: 0,
      active: false,
      mass: 0,
      halfExtents: [0.5, 0.5, 0.5],
    };
    this.all.push(entry);
    return entry;
  }

  /**
   * 取一个道具并配好形状/质量/位姿。
   * 参数全是原始数字：热路径上不产生参数对象（Rapier 自己需要的 Vector 由它内部消化）。
   */
  acquireBox(
    hx: number,
    hy: number,
    hz: number,
    mass: number,
    x: number,
    y: number,
    z: number,
    qx: number,
    qy: number,
    qz: number,
    qw: number,
  ): PooledProp {
    const entry = this.free.pop() ?? this.grow();
    entry.generation += 1;
    entry.active = true;

    // 顺序有讲究：先清速度与位姿（此时还是禁用态，不会积分），再改形状/质量，最后 enable。
    // 反过来的话，复用出来的箱子会带着上一任的动量先飞一帧。
    entry.body.setLinvel(ZERO, false);
    entry.body.setAngvel(ZERO, false);
    entry.body.setTranslation({ x, y, z }, false);
    entry.body.setRotation({ x: qx, y: qy, z: qz, w: qw }, false);

    entry.collider.setHalfExtents({ x: hx, y: hy, z: hz });
    entry.collider.setMass(mass);
    entry.mass = mass;
    entry.halfExtents = [hx, hy, hz];

    entry.body.setEnabled(true);
    entry.collider.setEnabled(true);

    this.live.add(entry);
    return entry;
  }

  private grow(): PooledProp {
    if (!this.allowGrowth) {
      throw new Error(
        `PropPool: 池已耗尽（共 ${this.all.length} 个）且 allowGrowth=false。` +
          '要么调大 preallocate，要么说明热路径上出现了新的分配。',
      );
    }
    return this.createEntry();
  }

  /** 只改尺寸（同一道具变形，比如箱子被压扁）。不 new 任何东西。 */
  resize(entry: PooledProp, hx: number, hy: number, hz: number): void {
    entry.collider.setHalfExtents({ x: hx, y: hy, z: hz });
    entry.halfExtents = [hx, hy, hz];
  }

  /** 只改质量。记账，不等 Rapier 的那一步延迟。 */
  setMass(entry: PooledProp, mass: number): void {
    entry.collider.setMass(mass);
    entry.mass = mass;
  }

  /** 归位 + 清零速度（不改质量/形状）。 */
  teleport(entry: PooledProp, x: number, y: number, z: number): void {
    entry.body.setTranslation({ x, y, z }, true);
    entry.body.setLinvel(ZERO, true);
    entry.body.setAngvel(ZERO, true);
  }

  /** 施加冲量（P8 推箱用）。 */
  applyImpulse(entry: PooledProp, x: number, y: number, z: number): void {
    entry.body.applyImpulse({ x, y, z }, true);
  }

  /** 读位置到给定数组（避免每帧 new Vector）。 */
  readPosition(entry: PooledProp, out: [number, number, number]): void {
    const t = entry.body.translation();
    out[0] = t.x;
    out[1] = t.y;
    out[2] = t.z;
  }

  /** 归还。幂等：重复归还不让池里出现两份。 */
  release(entry: PooledProp): void {
    if (!entry.active) return;
    entry.active = false;
    entry.generation += 1;
    // 禁用但不摘除：摘除会销毁 WASM 侧对象，池就白做了
    entry.collider.setEnabled(false);
    entry.body.setEnabled(false);
    this.live.delete(entry);
    this.free.push(entry);
  }

  get liveCount(): number {
    return this.live.size;
  }

  get freeCount(): number {
    return this.free.length;
  }

  /** 池总共建过多少个（稳态下这个数字必须不再增长——这就是"零 new"的观测点）。 */
  get createdCount(): number {
    return this.all.length;
  }

  forEachLive(fn: (entry: PooledProp) => void): void {
    for (const e of this.live) fn(e);
  }

  /** 拆掉池里全部刚体（连带其碰撞体）。 */
  dispose(): void {
    for (const entry of this.all) {
      // 删刚体会连带删掉挂在它上面的碰撞体，不必再 removeCollider
      this.world.removeRigidBody(entry.body);
    }
    this.all.length = 0;
    this.free.length = 0;
    this.live.clear();
  }
}

/** 复用同一个零向量常量，避免每次 setLinvel 都造一个对象。 */
const ZERO = { x: 0, y: 0, z: 0 };

/**
 * 算 interactionGroups。放在这里而不是 import layers 的 interactionGroups，
 * 是为了让 pool 不依赖 layers 的运行时（只在构造时算一次，便于将来换成自定义层）。
 */
function interactionGroupsFor(layer: 'PROP' | 'CHARACTER'): number {
  // 与 layers.ts 的矩阵保持一致；单测里有一致性断言，改一边不改另一边会红。
  const LAYER_BITS = { WORLD_STATIC: 1, CHARACTER: 2, PROP: 4, SENSOR: 8, AGENT: 16 } as const;
  const SOLID = {
    PROP: LAYER_BITS.WORLD_STATIC | LAYER_BITS.CHARACTER | LAYER_BITS.PROP,
    CHARACTER:
      LAYER_BITS.WORLD_STATIC | LAYER_BITS.CHARACTER | LAYER_BITS.PROP | LAYER_BITS.AGENT,
  } as const;
  return ((LAYER_BITS[layer] & 0xffff) << 16) | (SOLID[layer] & 0xffff);
}
