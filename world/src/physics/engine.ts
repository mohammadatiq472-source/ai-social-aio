/**
 * 物理世界（spec §6 M3 核心）。
 *
 * 这一层是"物理之上那一层"，也是我们真正要写的东西。三条不能让步的纪律：
 *
 * 1. **物理只吃固定步长**。`step()` 只接受 1/60，传别的直接抛。
 *    渲染帧率怎么抖都不该改变物理轨迹——这是后面服务端权威纠正能对得上的前提。
 *
 * 2. **单帧最多追 3 步，超出丢弃并记 overrun**。
 *    不这么做的话，卡顿一次（比如切标签页回来 dt=2s）会要追 120 步，
 *    每步都变慢 → 下一帧要追更多步 → 死亡螺旋，页面直接假死。
 *    宁可让世界"慢一拍"，也不要卡顿后突然快进。
 *
 * 3. **热路径零 new**。道具走 PropPool；步进中不建临时 Vector，
 *    不在物理循环里读 `Date.now()`（确定性纪律）。
 *
 * 与 Clock 的分工：Clock 负责"这一帧该跑几步"，Engine 负责"跑一步"。
 * 不要在这里再写一个累加器——两份累加器一定会对不上。
 */

import type RAPIER_NS from '@dimforge/rapier3d-compat';
import { PHYSICS_DT } from '../core/types';
import type { Room } from '../core/room';
import { roomPropSolids } from '../core/room';
import { bakeRoom, type BakedRoom, type Rapier } from './bake';
import { interactionGroups, LAYERS, type LayerName } from './layers';
import { PropPool, type PooledProp } from './pool';

/** 重力。spec §6 M3 第 3 条：固定 (0, -9.81, 0)。 */
export const GRAVITY = { x: 0, y: -9.81, z: 0 } as const;

/**
 * 角色的胶囊尺寸（M4 用，这里先集中定义避免两处写两个值）。
 * 半径 0.30、半高 0.55（圆柱段一半）→ 总高 = 2*(0.55+0.30) = 1.70m。
 *
 * **关于 1.70 vs 资产 1.62 的 8cm 差异（有意保留）**：
 * 渲染层把角色归一化到 1.62m（`assets/loader.ts` 的 AVATAR_HEIGHT_M），
 * 而物理胶囊是 1.70m。这不是笔误：
 * - 物理胶囊略大于视觉模型是 FPS/动作游戏的标准做法（"胶囊稍胖"），
 *   避免角色模型的手肘/头发穿墙，同时让碰撞判定更宽容、更不容易卡住；
 * - 若两者严格相等，模型边缘会与墙面发生视觉穿插。
 * 8cm ≈ 身高的 5%，在这个范围内既不会让角色"悬空"（脚底仍贴地），
 * 也不会出现明显的"隔空碰撞"。
 * 如果将来要改，请同步改 spec §6 M4 的胶囊参数，不要只改这里。
 */
export const CHARACTER_CAPSULE = { radius: 0.3, halfHeight: 0.55 } as const;

/** 单步耗时统计窗口（帧数）。取 60 帧 ≈ 1 秒，够平滑又能看出抖动。 */
const STEP_SAMPLE_WINDOW = 60;

export interface PhysicsStats {
  /** 累计物理步数。 */
  steps: number;
  /** 最近一步耗时（毫秒）。 */
  lastStepMs: number;
  /** 最近 60 步平均耗时（毫秒）。 */
  avgStepMs: number;
  /** 最近 60 步最坏耗时（毫秒）。 */
  maxStepMs: number;
  /** 累计 overrun 次数（单帧超 3 步被丢弃）。 */
  overruns: number;
  /** 累计被丢弃的时间（秒）。 */
  droppedSeconds: number;
  /** 动态刚体数（道具 + 角色）。 */
  dynamicBodies: number;
  /** 碰撞体总数。 */
  colliders: number;
  /** 道具池建过的总数（稳态下不增长 = 零 new）。 */
  pooledCreated: number;
}

export interface PhysicsWorldOptions {
  /**
   * 道具池预分配数量。给够就不会在热路径扩容。
   * 默认 256 覆盖 spec §8 的"同屏刚体 200"。
   */
  propPoolSize?: number;
  /** 池是否允许扩容。false 时池空即抛，用于验证"零 new"。 */
  allowPoolGrowth?: boolean;
  /**
   * 事件队列容量行为。true 表示每步自动 drain（我们不关心事件内容时会丢），
   * 默认 false：传感器事件必须能被读到，不能被自动清掉。
   */
  autoDrainEvents?: boolean;
}

/**
 * 传感器事件回调。spec：sensor 只与 character 产生事件。
 * 参数是触发的传感器所属的 `userData` 标签与进入/离开。
 */
export type SensorHandler = (tag: string, other: RAPIER_NS.Collider, entered: boolean) => void;

/**
 * 物理世界。一个实例 = 一个房间。
 *
 * 生命周期：`await PhysicsWorld.create(...)` → 用 → `dispose()`。
 * 用静态工厂而不是构造函数，是因为 `RAPIER.init()` 是异步的，
 * 而"初始化失败"必须能被 await 到（否则错误会变成未处理的 Promise）。
 */
export class PhysicsWorld {
  readonly world: RAPIER_NS.World;
  readonly clockless = true; // 标记：本类不含累加器，步数由外部 Clock 决定

  private readonly RAPIER: Rapier;
  private readonly eventQueue: RAPIER_NS.EventQueue;
  private readonly propPool: PropPool;
  private baked: BakedRoom | null = null;
  private readonly props: PooledProp[] = [];
  private readonly sensorTags = new Map<number, string>();
  private sensorHandler: SensorHandler | null = null;

  private stepCount = 0;
  private overruns = 0;
  private droppedSeconds = 0;
  private readonly stepSamples = new Float64Array(STEP_SAMPLE_WINDOW);
  private sampleCount = 0;
  private sampleCursor = 0;
  private lastStepMs = 0;

  private disposed = false;

  private constructor(RAPIER: Rapier, opts: PhysicsWorldOptions) {
    this.RAPIER = RAPIER;
    // spec §6 M3 第 3 条：重力固定
    this.world = new RAPIER.World(GRAVITY);
    // spec §6 M3 第 2/3 条：timestep 固定 1/60
    this.world.timestep = PHYSICS_DT;
    // 事件队列：autoDrain=false，这样我们能读到每一次 enter/exit
    this.eventQueue = new RAPIER.EventQueue(opts.autoDrainEvents ?? false);
    this.propPool = new PropPool(RAPIER, this.world, {
      preallocate: opts.propPoolSize ?? 256,
      allowGrowth: opts.allowPoolGrowth ?? true,
      layer: 'PROP',
      ccd: false, // 普通箱子不开 CCD，开销大；快速道具在 spawnProp 时单独开
    });
  }

  /**
   * 建物理世界。会 `await RAPIER.init()`（WASM 加载），
   * 并把房间的静态几何烘焙进去、把房间道具生成成动态刚体。
   */
  static async create(
    RAPIER: Rapier,
    room: Room,
    opts: PhysicsWorldOptions = {},
  ): Promise<PhysicsWorld> {
    await RAPIER.init();
    const pw = new PhysicsWorld(RAPIER, opts);
    pw.loadRoom(room);
    return pw;
  }

  /** 把房间烘焙进当前世界。换房间时先 dispose 旧的静态几何。 */
  loadRoom(room: Room): void {
    this.assertLive();
    this.baked?.dispose();
    this.baked = bakeRoom(this.RAPIER, this.world, room);

    // 房间道具：走池。池不够时 grow（受 allowPoolGrowth 约束）
    for (const p of roomPropSolids(room)) {
      const prop = this.propPool.acquireBox(
        p.halfExtents[0],
        p.halfExtents[1],
        p.halfExtents[2],
        p.mass,
        p.pos[0],
        p.pos[1],
        p.pos[2],
        p.rot[0],
        p.rot[1],
        p.rot[2],
        p.rot[3],
      );
      // 房间道具**必须开 CCD**。
      //
      // 为什么（这是 2026-11-20 发现的一个真实缺陷）：
      // 之前这里直接 acquireBox，绕过了 spawnProp 的 fast 分支，而池的默认 ccd=false。
      // 于是所有房间道具都没有连续碰撞检测 —— 被玩家推、被其他箱子撞飞时，
      // 单帧位移可能超过半个箱子厚度，直接穿过墙。
      //
      // spec §6 M3 第 3 条写的是"只有角色胶囊与快速道具开 CCD"。
      // 房间道具正是"可能变快"的那类：静止时开销可忽略（CCD 只在高速时激活），
      // 被推起来才需要。所以对它们开 CCD 是符合规格的，不是超配。
      prop.body.enableCcd(true);
      this.props.push(prop);
    }
  }

  /** 已烘焙的静态几何（debug draw 与测试用）。 */
  get bakedRoom(): BakedRoom | null {
    return this.baked;
  }

  /** 房间道具（池化条目）。 */
  get roomProps(): readonly PooledProp[] {
    return this.props;
  }

  /** 道具池本身（测试"零 new"时用）。 */
  get pool(): PropPool {
    return this.propPool;
  }

  /**
   * 推进一步。**只接受 PHYSICS_DT**，传别的直接抛——
   * 这不是防御性编程，是防止有人"顺手"把渲染 dt 喂进来。
   */
  step(dt: number = PHYSICS_DT): void {
    this.assertLive();
    if (dt !== PHYSICS_DT) {
      throw new RangeError(
        `PhysicsWorld.step: 物理固定步长必须是 ${PHYSICS_DT}（1/60），收到 ${dt}。` +
          '可变 dt 喂物理会让轨迹随帧率改变，spec §2.2 明令禁止。' +
          '帧间 dt 请交给 core/clock.ts 的 Clock。',
      );
    }

    const t0 = now();
    this.world.step(this.eventQueue);
    const ms = now() - t0;

    this.stepCount += 1;
    this.lastStepMs = ms;
    this.stepSamples[this.sampleCursor] = ms;
    this.sampleCursor = (this.sampleCursor + 1) % STEP_SAMPLE_WINDOW;
    if (this.sampleCount < STEP_SAMPLE_WINDOW) this.sampleCount += 1;

    // 事件必须在 step 之后立刻 drain：队列是环形的，下一步会覆盖
    this.drainEvents();
  }

  /** 记一次 overrun（由外部 Clock 的 advance 结果驱动）。 */
  recordOverrun(dropped: number): void {
    this.overruns += 1;
    if (dropped > 0) this.droppedSeconds += dropped;
  }

  private drainEvents(): void {
    if (this.sensorTags.size === 0) {
      // 没有登记任何传感器时仍然要 drain，否则队列会积压到溢出
      this.eventQueue.drainCollisionEvents(() => {});
      return;
    }
    const handler = this.sensorHandler;
    this.eventQueue.drainCollisionEvents((h1, h2, started) => {
      if (!handler) return;
      const tag1 = this.sensorTags.get(h1);
      const tag2 = this.sensorTags.get(h2);
      if (tag1 === undefined && tag2 === undefined) return;
      // 确定哪个是传感器、哪个是"另一方"
      const c1 = this.world.getCollider(h1);
      const c2 = this.world.getCollider(h2);
      if (tag1 !== undefined) handler(tag1, c2 ?? c1!, started);
      else handler(tag2!, c1 ?? c2!, started);
    });
  }

  // ───────────────────────────── 传感器 ─────────────────────────────

  /**
   * 建一个传感器（座位/交互区）。返回 collider 句柄，dispose 时会一起清掉。
   *
   * 注意：传感器**不属于**道具池。传感器在房间里是固定的、数量可数的，
   * 池化它没有收益，反而让 tag 映射更难维护。
   *
   * 必须显式设 `setActiveCollisionTypes(ALL)`，这是实测出来的坑：
   * Rapier 默认 `ActiveCollisionTypes.DEFAULT = 15`，只含
   * DYNAMIC_DYNAMIC | DYNAMIC_FIXED | DYNAMIC_KINEMATIC，**不含 KINEMATIC_FIXED（8704）**。
   * 而我们的传感器是 fixed、角色是 kinematic，两者恰好落在没开的那一格 →
   * 传感器永远不触发、且不报错。这个 bug 只在"角色走到座位上"时才显形，
   * 所以这里必须开 ALL 并留下这条注释，否则下一个人会把 ALL 当成冗余改回 DEFAULT。
   */
  addSensor(
    tag: string,
    hx: number,
    hy: number,
    hz: number,
    x: number,
    y: number,
    z: number,
  ): RAPIER_NS.Collider {
    this.assertLive();
    const body = this.world.createRigidBody(
      this.RAPIER.RigidBodyDesc.fixed().setTranslation(x, y, z),
    );
    const collider = this.world.createCollider(
      this.RAPIER.ColliderDesc.cuboid(hx, hy, hz)
        // 传感器只产生事件、不产生物理响应；但事件要求两边 filter 互相包含，
        // 所以 SENSOR 的 filter 里含 CHARACTER，CHARACTER 的 filter 里含 SENSOR（见 layers.ts）
        .setCollisionGroups(interactionGroups('SENSOR'))
        .setSensor(true)
        .setActiveEvents(this.RAPIER.ActiveEvents.COLLISION_EVENTS)
        // 见上面注释：不开 ALL 的话 fixed 传感器碰不到 kinematic 角色
        .setActiveCollisionTypes(this.RAPIER.ActiveCollisionTypes.ALL),
      body,
    );
    this.sensorTags.set(collider.handle, tag);
    return collider;
  }

  /** 注册传感器回调。 */
  onSensor(handler: SensorHandler | null): void {
    this.sensorHandler = handler;
  }

  // ───────────────────────────── 角色 ─────────────────────────────

  /**
   * 建一个角色胶囊刚体（kinematicPositionBased）。
   *
   * 为什么是 kinematic 而不是 dynamic（spec §6 M4 末尾明确禁止做成 dynamic）：
   * dynamic 胶囊会被箱子顶飞、会在斜坡上抖、会被别的角色挤走——
   * 那样"意图执行结果"就没法归因了。角色位置由 M4 的控制器决定，
   * 物理只负责"这个位置和世界碰不碰"。
   *
   * CCD 打开（spec §6 M3 第 3 条：角色胶囊与快速道具开 CCD）：
   * 角色一帧可能移动 0.077m（run 4.6m/s），薄墙是 0.1m，不开 CCD 会穿。
   */
  createCharacter(x: number, y: number, z: number): RAPIER_NS.RigidBody {
    this.assertLive();
    const body = this.world.createRigidBody(
      this.RAPIER.RigidBodyDesc.kinematicPositionBased()
        .setTranslation(x, y, z)
        .setCcdEnabled(true),
    );
    this.world.createCollider(
      this.RAPIER.ColliderDesc.capsule(CHARACTER_CAPSULE.halfHeight, CHARACTER_CAPSULE.radius)
        .setCollisionGroups(interactionGroups('CHARACTER'))
        .setFriction(0.4)
        .setRestitution(0),
      body,
    );
    return body;
  }

  /** 删角色（连带其胶囊 collider）。 */
  removeCharacter(body: RAPIER_NS.RigidBody): void {
    this.assertLive();
    this.world.removeRigidBody(body);
  }

  // ───────────────────────────── 道具 ─────────────────────────────

  /**
   * 从池里取一个道具。`fast=true` 时开 CCD（spec：快速道具开 CCD）。
   * 返回的条目在 releaseProp 之前一直有效。
   */
  spawnProp(
    hx: number,
    hy: number,
    hz: number,
    mass: number,
    x: number,
    y: number,
    z: number,
    fast = false,
  ): PooledProp {
    this.assertLive();
    const prop = this.propPool.acquireBox(hx, hy, hz, mass, x, y, z, 0, 0, 0, 1);
    if (fast) prop.body.enableCcd(true);
    else prop.body.enableCcd(false);
    return prop;
  }

  /** 归还道具到池。 */
  releaseProp(prop: PooledProp): void {
    this.assertLive();
    this.propPool.release(prop);
    const i = this.props.indexOf(prop);
    if (i >= 0) this.props.splice(i, 1);
  }

  // ───────────────────────────── 查询 ─────────────────────────────

  /**
   * 沿 -y 方向探测地面高度（M4 的贴地判定会用）。
   *
   * 射线过滤有个容易搞反的地方：`filterGroups` 的低 16 位要和**被查碰撞体自己的 filter**
   * 做与运算，不是和它的 membership 比。静态几何的 filter 是 CHARACTER|PROP|AGENT
   * （见 layers.ts 的 SOLID 表），所以这里必须用一个"愿意被静态几何接受"的成员位。
   *
   * 实测踩过的坑：传 `interactionGroups('WORLD_STATIC', WORLD_STATIC|PROP)` 会**永远打不到**，
   * 因为静态几何的 filter 里没有 WORLD_STATIC 这一位——它不和自己碰撞。
   * 正确做法是用 CHARACTER 当射线的成员位（地面本来就该被角色打到）。
   */
  groundHeightAt(
    x: number,
    z: number,
    fromY: number,
    maxDistance = 100,
  ): { y: number; collider: RAPIER_NS.Collider; normalY: number } | null {
    const ray = new this.RAPIER.Ray({ x, y: fromY, z }, { x: 0, y: -1, z: 0 });
    const hit = this.world.castRayAndGetNormal(
      ray,
      maxDistance,
      true,
      undefined,
      // 以 CHARACTER 身份查询：静态几何与道具的 filter 都含 CHARACTER
      interactionGroups('CHARACTER', LAYERS.WORLD_STATIC | LAYERS.PROP),
    );
    if (!hit) return null;
    return {
      y: fromY - hit.timeOfImpact,
      collider: hit.collider,
      // 命中面的法线 y 分量：1 = 平地，cos(45°)≈0.707 = 45° 坡。
      // M4 用它判断"脚下是不是陡到该滑"，比读控制器接触列表可靠（见 harness 注释）。
      normalY: hit.normal.y,
    };
  }

  /**
   * 任意方向的射线查询，返回命中距离（米）；无命中返回 null。
   *
   * 与 `groundHeightAt` 的区别：那个是**固定向下**打地面，这个是任意方向。
   * 用途：相机避障（注视点 → 理想机位之间有没有墙）。
   *
   * 过滤规则与 groundHeightAt 一致：以 CHARACTER 身份查询，
   * 命中 WORLD_STATIC | PROP。**不包含 AGENT**——相机不该被其他角色挡住，
   * 否则一群角色围过来时镜头会疯狂拉近（那是"穿人"，不是"穿墙"）。
   */
  raycastDistance(
    from: { x: number; y: number; z: number },
    to: { x: number; y: number; z: number },
    maxDistance = 100,
  ): number | null {
    const dx = to.x - from.x;
    const dy = to.y - from.y;
    const dz = to.z - from.z;
    const len = Math.hypot(dx, dy, dz);
    if (len < 1e-6) return null;
    // 归一化方向：Rapier 的 Ray 要求单位方向，否则 timeOfImpact 的单位不是米
    const dir = { x: dx / len, y: dy / len, z: dz / len };
    const ray = new this.RAPIER.Ray(from, dir);
    const hit = this.world.castRay(
      ray,
      Math.min(maxDistance, len),
      true,
      undefined,
      interactionGroups('CHARACTER', LAYERS.WORLD_STATIC | LAYERS.PROP),
    );
    return hit ? hit.timeOfImpact : null;
  }

  /** 指标快照（暴露到 __worldDebug）。 */
  stats(): PhysicsStats {
    // 只数**启用中**的碰撞体：池里闲置的（setEnabled(false)）仍然挂在世界里、
    // forEachCollider 照样会遍历到。把它们算进去会让调试面板显示"32 个碰撞体"
    // 而实际场景里只有 9 个，这种数字比没有数字更误导人。
    let colliders = 0;
    this.world.forEachCollider((c) => {
      if (c.isEnabled()) colliders += 1;
    });
    let dynamicBodies = 0;
    this.world.forEachRigidBody((b) => {
      if (b.isEnabled() && b.isDynamic()) dynamicBodies += 1;
    });

    let sum = 0;
    let max = 0;
    for (let i = 0; i < this.sampleCount; i++) {
      const v = this.stepSamples[i]!;
      sum += v;
      if (v > max) max = v;
    }
    return {
      steps: this.stepCount,
      lastStepMs: round(this.lastStepMs),
      avgStepMs: round(this.sampleCount > 0 ? sum / this.sampleCount : 0),
      maxStepMs: round(max),
      overruns: this.overruns,
      droppedSeconds: round(this.droppedSeconds),
      dynamicBodies,
      colliders,
      pooledCreated: this.propPool.createdCount,
    };
  }

  /** 该层当前的 interactionGroups（测试与 debug 用）。 */
  groupsOf(layer: LayerName): number {
    return interactionGroups(layer);
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.baked?.dispose();
    this.baked = null;
    this.propPool.dispose();
    this.props.length = 0;
    this.sensorTags.clear();
    this.sensorHandler = null;
    // EventQueue 与 World 都有 WASM 内存，必须显式释放
    this.eventQueue.free();
    this.world.free();
  }

  private assertLive(): void {
    if (this.disposed) {
      throw new Error('PhysicsWorld 已 dispose，不能再使用（换房间请新建实例）');
    }
  }
}

/** 向上取整到 3 位小数：调试面板不需要更高精度，且避免浮点尾巴晃眼。 */
function round(v: number): number {
  return Math.round(v * 1000) / 1000;
}

/** `performance.now()` 浏览器/node 都有。 */
function now(): number {
  return typeof performance !== 'undefined' ? performance.now() : Date.now();
}

// ───────────────────────────── 与 Clock 的接线 ─────────────────────────────

/**
 * 把 PhysicsWorld 挂到 Clock 上。
 *
 * 这是 spec §6 M3 第 2 条"用累加器 + 单帧最多追 3 步"的落点。
 * overrun 必须在这里记到物理侧，否则 __worldDebug 里的 overruns 永远是 0
 * （Clock 自己也有计数，但调试面板读的是物理这一份，两边都要对）。
 */
export function createPhysicsPump(
  clock: { runSteps(dt: number, fn: (fixedDt: number) => void): { steps: number; overrun: boolean; droppedSeconds: number } ; readonly alpha: number },
  physics: PhysicsWorld,
): { pump(frameDt: number): { steps: number; alpha: number; overrun: boolean } } {
  return {
    pump(frameDt: number) {
      const info = clock.runSteps(frameDt, (dt) => physics.step(dt));
      if (info.overrun) physics.recordOverrun(info.droppedSeconds);
      return { steps: info.steps, alpha: clock.alpha, overrun: info.overrun };
    },
  };
}
