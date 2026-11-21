/**
 * 角色胶囊控制器（spec §6 M4）——这是整个物理层最容易做错的一块。
 *
 * 设计要点，每条都对应一个"做错了会怎样"：
 *
 * 1. **角色是 kinematicPositionBased，不是 dynamic。**
 *    dynamic 胶囊会被箱子顶飞、在斜坡上抖、被别的角色挤走，
 *    于是"意图执行结果"没法归因（spec §4.2 要求意图失败能回报）。
 *    位置由本控制器决定，物理只负责"这个位置和世界碰不碰"。
 *
 * 2. **状态机用 computedGrounded 判定，不用 y 速度绝对值猜。**
 *    "vy 接近 0 就是站地上"在斜坡上行、刚起跳、被顶一下的时候全是错的。
 *
 * 3. **移动用加速度限制逼近目标速度，不直接设线速度。**
 *    直接设速度会让角色瞬间达到全速，观感像"贴地飞行"，
 *    而且碰撞后速度立刻恢复，撞墙会持续"顶"着墙抖。
 *
 * 4. **转向用四元数 slerp，不瞬间对齐。**
 *    瞬间转向在第三人称下看着像"抽搐"。
 *
 * 5. **竖直方向的重力施加要分坡度。**
 *    这条是 M3 阶段用 P1/P2/P3 三个用例实测出来的（见下方 driveVertical 注释）：
 *    平地上每帧无脑加重力会让水平位移被吃掉 23cm；而陡坡上不加又完全滑不动。
 */

import type RAPIER_NS from '@dimforge/rapier3d-compat';
import type { Rapier } from './bake';
import type { PhysicsWorld } from './engine';
import { slerp, type Transform } from '../core/types';

// ───────────────────────────── 参数（spec §6 M4） ─────────────────────────────

export type CharacterStateName = 'idle' | 'walk' | 'run' | 'jump' | 'fall';

/** 重力（与 physics/engine.ts 的 GRAVITY 必须一致）。 */
export const GRAVITY_Y = -9.81;

/** 物理固定步长（与 core/types.ts 的 PHYSICS_DT 一致）。 */
export const PHYSICS_DT = 1 / 60;

/** 跳跃高度的设计目标（米）。P6 要求 1.20 ± 0.03。 */
export const JUMP_HEIGHT_TARGET = 1.2;

/**
 * 起跳初速的**解析解**：sqrt(2·g·h) = sqrt(2 × 9.81 × 1.20) ≈ 4.8522。
 * spec §6 M4 文字写的 4.85 是它的四舍五入。保留推导，不要写成魔法数。
 */
export const JUMP_VELOCITY_ANALYTIC = Math.sqrt(2 * Math.abs(GRAVITY_Y) * JUMP_HEIGHT_TARGET);

/**
 * 半步重力修正：g·dt/2 ≈ 0.0818 m/s。
 *
 * 为什么需要（实测数据）：半隐式欧拉每步先 `v += g·dt` 再 `x += v·dt`，
 * 起跳那一帧的速度已经比真实初速少了 g·dt，累积到最高点少走约 v0·dt/2 ≈ 4.0cm。
 * 实测 1/60 定步下：
 *   直接喂 4.85          → 跳高 1.1588m（比 1.20 少 4.12cm，**超出 ±3cm 容差，P6 红**）
 *   喂 4.85 + g·dt/2     → 跳高 1.1999m（落在 1.20±0.03，P6 绿）
 * 这不是凑数，是让离散轨迹对齐连续解析解的标准做法。
 * **改重力必须重算本值**，否则 P6 立刻偏。
 */
export const JUMP_HALF_STEP_CORRECTION = (Math.abs(GRAVITY_Y) * PHYSICS_DT) / 2;

export interface CharacterConfig {
  /** 胶囊半径（米）。 */
  radius: number;
  /** 胶囊圆柱段半高（不含两个半球）。总高 = 2*(halfHeight+radius)。 */
  halfHeight: number;
  walkSpeed: number;
  runSpeed: number;
  /** 解析起跳初速（不含半步修正）。 */
  jumpSpeed: number;
  /** 半步重力修正量（m/s），起跳时叠加。 */
  jumpHalfStepCorrection: number;
  /** 可爬坡度上限（弧度）。 */
  maxSlopeClimbAngle: number;
  /** 开始下滑的坡度（弧度）。 */
  minSlopeSlideAngle: number;
  /** 与障碍保持的间隙（米）。 */
  controllerOffset: number;
  autostepMaxHeight: number;
  autostepMinWidth: number;
  snapToGround: number;
  /** 地面加速度上限（m/s²）。 */
  accelGround: number;
  /** 空中加速度上限（m/s²）。 */
  accelAir: number;
  /**
   * 可被角色推动的道具质量上限（kg）。超重只推不飞。
   * spec §6 M4 第 7 条：给道具一个质量上限。
   */
  pushMassLimit: number;
  /** 转向的 slerp 速率（1/秒）。越大转得越快。 */
  turnRate: number;
}

export const DEFAULT_CHARACTER: CharacterConfig = {
  // spec §6 M4：胶囊半径 0.30m、半高 0.55m（总高 1.70m）
  radius: 0.3,
  halfHeight: 0.55,
  // spec §6 M4：walk 2.2 / run 4.6
  walkSpeed: 2.2,
  runSpeed: 4.6,
  jumpSpeed: JUMP_VELOCITY_ANALYTIC,
  jumpHalfStepCorrection: JUMP_HALF_STEP_CORRECTION,
  /**
   * 坡度上限：**40°**（不是 spec 原文的 50°）。
   *
   * spec 自身有矛盾，lead 已裁决（docs/world/决策-斜坡角与P3冲突.md）：
   * §6 M4 写 maxSlopeClimbAngle 50°，而 §7 的 P3 要求 45° 斜坡**不能上**。
   * 50° > 45°，按 50° 跑 45° 坡必然可爬（实测 climb=2.000m），P3 永远红。
   *
   * 约束是 30° < max < 45°：
   * - 必须 > 30°：否则 P2 的 30° 斜坡爬不上去；
   * - 必须 < 45°：否则 P3 的 45° 斜坡挡不住。
   *
   * 取 40° 而非 44°：44° 只给 45° 留 1° 余量，浮点/接触点抖动就可能翻车；
   * 40° 给 30° 留 10°、给 45° 留 5°，两侧都稳。
   */
  maxSlopeClimbAngle: (40 * Math.PI) / 180,
  /** 30°：45° > 30°，所以陡坡仍会下滑（P3 后半句"能下滑"成立）。 */
  minSlopeSlideAngle: (30 * Math.PI) / 180,
  controllerOffset: 0.02,
  autostepMaxHeight: 0.35,
  autostepMinWidth: 0.2,
  snapToGround: 0.3,
  accelGround: 40,
  accelAir: 8,
  pushMassLimit: 25,
  turnRate: 12,
};

/** 起跳时实际要喂给控制器的竖直速度（含半步修正）。 */
export function jumpLaunchVelocity(cfg: CharacterConfig = DEFAULT_CHARACTER): number {
  return cfg.jumpSpeed + cfg.jumpHalfStepCorrection;
}

// ───────────────────────────── 输入与状态 ─────────────────────────────

/**
 * 控制输入。
 *
 * ⚠️ **坐标空间契约（输入层必读，喂错方向会表现为"按 W 却往侧面走"）**：
 *
 * `dirX` / `dirZ` / `faceX` / `faceZ` 全部是**世界空间**的水平方向，
 * 不是相机空间、不是屏幕空间。物理层不知道相机朝哪，也不该知道。
 *
 * 键盘输入层必须先把相机方向转成世界方向再喂进来：
 * ```ts
 * // camYaw = 相机绕 Y 的朝向角（弧度），来自 render/camera.ts
 * // 屏幕上的"前" = 相机看向的水平方向
 * const fwdX = Math.sin(camYaw),  fwdZ = Math.cos(camYaw);
 * const rightX = Math.cos(camYaw), rightZ = -Math.sin(camYaw);
 * // W/S 用 fwd，A/D 用 right（注意 A 是 -right）
 * const dirX = fwdX * w + rightX * d;
 * const dirZ = fwdZ * w + rightZ * d;
 * controller.update({ dirX, dirZ, run: shift, jump: space });
 * ```
 * 这样"按 W"永远是"朝相机看向的方向走"，相机转到哪都对。
 * 若直接把 W 写成 `dirZ = -1`（世界 -Z），相机一旦转动，操作就会错位。
 *
 * **不直接改 transform**——这是 spec §4.2 的硬要求：物理是唯一的位置权威。
 */
export interface CharacterInput {
  /** 水平方向的世界空间 X 分量（会被归一化）。与 dirZ 组成方向向量。 */
  dirX: number;
  /** 水平方向的世界空间 Z 分量（会被归一化）。 */
  dirZ: number;
  /**
   * 是否跑步。语义是"目标速度的上限用 runSpeed 还是 walkSpeed"（4.6 / 2.2），
   * **不是**瞬间切换速度：实际速度仍受 accelGround(40 m/s²) 限制逐帧逼近，
   * 所以按住 Shift 会看到一个约 0.06s 的平滑加速，不是突兀跳变。
   * 松开 Shift 同理平滑减速。这正是 spec §6 M4 第 4 条要的"不要直接设线速度"。
   */
  run: boolean;
  /**
   * 速度缩放（0..1，默认 1）。**模拟量**，不是可有可无的装饰。
   *
   * 为什么需要：spec §6 M4 只说"目标速度 = 方向 × (walk 2.2 / run 4.6)"，
   * 但只有两档速度时，"走到某个点并停下"这件事表达不出来——
   * 以 2.2 m/s 走、加速度上限 40 m/s²，最短刹停距离是 v²/(2a) = 6.05cm，
   * 而 P1 要求终点误差 ≤1cm。没有中间速度就必然过冲（实测在目标点附近
   * 以 34 步为周期反复穿越，误差在 0.3cm~7.7cm 之间来回跳）。
   *
   * 现实里这个量也是必需的：手柄摇杆就是模拟量，"慢慢走向座位"也用它。
   */
  speedScale?: number;
  /** 本帧是否请求起跳（边沿触发：只在一帧置 true 即可，不需要保持按住）。 */
  jump: boolean;
  /** 朝向：希望面向的世界空间水平方向 X。省略则朝移动方向。 */
  faceX?: number;
  /** 朝向：希望面向的世界空间水平方向 Z。省略则朝移动方向。 */
  faceZ?: number;
}

export const IDLE_INPUT: CharacterInput = { dirX: 0, dirZ: 0, run: false, jump: false };

/** 状态机的状态。 */
export type CharacterState =
  | 'grounded' // 站在地上
  | 'airborne' // 空中，竖直速度接近 0（刚离地/到顶点）
  | 'jumping' // 上升中（vy > 0）
  | 'falling'; // 下落中（vy < 0）

/** 一个角色的运行时状态（对外只读）。 */
export interface CharacterRuntime {
  state: CharacterState;
  /** 映射到 spec §4.1 的动画名。 */
  anim: 'idle' | 'walk' | 'run' | 'jump' | 'fall';
  /** 当前水平速度（m/s）。 */
  speed: number;
  /** 当前竖直速度（m/s）。 */
  vy: number;
  grounded: boolean;
  /** 当前朝向四元数 [x,y,z,w]。 */
  rot: [number, number, number, number];
  /** 当前位置 [x,y,z]。 */
  pos: [number, number, number];
}

/**
 * 角色控制器。
 *
 * 用法：
 * ```ts
 * const c = new CharacterController(RAPIER, physicsWorld, { id: 'p:1' });
 * c.spawn([0, 1, 0]);
 * // 每物理步：
 * c.update({ dirX: 0, dirZ: -1, run: false, jump: false }, 1/60);
 * c.writeTransform(world);   // 写回 World 层的 ActorState
 * ```
 */
export class CharacterController {
  readonly body: RAPIER_NS.RigidBody;
  readonly collider: RAPIER_NS.Collider;
  readonly config: CharacterConfig;

  private readonly cc: RAPIER_NS.KinematicCharacterController;
  private readonly pw: PhysicsWorld;

  private vx = 0;
  private vz = 0;
  private vy = 0;
  private grounded = false;
  private slopeDeg = 0;
  private state: CharacterState = 'falling';
  private anim: CharacterRuntime['anim'] = 'fall';
  private rot: [number, number, number, number] = [0, 0, 0, 1];
  private jumpQueued = false;
  private lastAnim: CharacterRuntime['anim'] = 'fall';

  constructor(
    RAPIER: Rapier,
    pw: PhysicsWorld,
    x: number,
    y: number,
    z: number,
    config: CharacterConfig = DEFAULT_CHARACTER,
  ) {
    this.pw = pw;
    this.config = config;

    this.body = pw.createCharacter(x, y, z);
    const collider = this.body.collider(0);
    if (!collider) throw new Error('CharacterController: 角色刚体没有碰撞体');
    this.collider = collider;

    const cc = pw.world.createCharacterController(config.controllerOffset);
    cc.setUp({ x: 0, y: 1, z: 0 });
    cc.setMaxSlopeClimbAngle(config.maxSlopeClimbAngle);
    cc.setMinSlopeSlideAngle(config.minSlopeSlideAngle);
    cc.enableAutostep(config.autostepMaxHeight, config.autostepMinWidth, true);
    cc.enableSnapToGround(config.snapToGround);
    cc.setApplyImpulsesToDynamicBodies(true);
    cc.setSlideEnabled(true);
    // 角色质量用于推箱的冲量换算；spec 没给具体值，取成人常规体重
    cc.setCharacterMass(75);
    this.cc = cc;
    void RAPIER;
  }

  /** 胶囊中心到脚底的距离。 */
  get capsuleHalfTotal(): number {
    return this.config.halfHeight + this.config.radius;
  }

  /** 只读运行时快照（渲染/感知用）。 */
  snapshot(): CharacterRuntime {
    const t = this.body.translation();
    return {
      state: this.state,
      anim: this.anim,
      speed: Math.hypot(this.vx, this.vz),
      vy: this.vy,
      grounded: this.grounded,
      rot: [this.rot[0], this.rot[1], this.rot[2], this.rot[3]],
      pos: [t.x, t.y, t.z],
    };
  }

  /** 直接瞬移到某处（重生/坐下吸附用）。会清零速度。 */
  teleport(x: number, y: number, z: number): void {
    this.body.setTranslation({ x, y, z }, true);
    this.body.setNextKinematicTranslation({ x, y, z });
    this.vx = 0;
    this.vz = 0;
    this.vy = 0;
  }

  /** 请求起跳（可在任意时刻调用，下一帧生效一次）。 */
  requestJump(): void {
    this.jumpQueued = true;
  }

  /**
   * 推进一个物理步。
   *
   * 顺序（别调换）：
   * 1. 目标速度 = 方向 × 速度（归一化方向，斜着走不会更快）
   * 2. 用加速度限制把当前速度逼近目标速度
   * 3. 竖直方向：按"贴地/离地/坡度"决定是否累积重力
   * 4. 交给控制器算实际位移
   * 5. 写回刚体、更新状态机与朝向
   */
  update(input: CharacterInput, dt: number = PHYSICS_DT): void {
    const cfg = this.config;

    // ── 1. 目标水平速度 ──
    const dirLen = Math.hypot(input.dirX, input.dirZ);
    let targetVx = 0;
    let targetVz = 0;
    if (dirLen > 1e-6) {
      const baseSpeed = input.run ? cfg.runSpeed : cfg.walkSpeed;
      // speedScale 让"慢走/精确抵达"成为可能（见 CharacterInput.speedScale 注释）
      const scale = clamp01(input.speedScale ?? 1);
      const maxSpeed = baseSpeed * scale;
      targetVx = (input.dirX / dirLen) * maxSpeed;
      targetVz = (input.dirZ / dirLen) * maxSpeed;
    }

    // ── 2. 加速度限制逼近（不直接设速度） ──
    const accel = this.grounded ? cfg.accelGround : cfg.accelAir;
    const maxDelta = accel * dt;
    this.vx = approach(this.vx, targetVx, maxDelta);
    this.vz = approach(this.vz, targetVz, maxDelta);

    // ── 3. 起跳 ──
    // 两个入口都要支持：`update()` 的 input.jump（逐帧输入，游戏循环用）
    // 与 `requestJump()` 的排队标志（事件驱动，比如 Agent 意图触发的跳）。
    // 只读其中一个会让另一条路径静默失效——这里踩过：驱动传 input.jump，
    // 而 update 只读 this.jumpQueued，结果 P6 的跳跃高度恒为 0。
    const wantsJump = input.jump || this.jumpQueued;
    this.jumpQueued = false;
    if (wantsJump && this.grounded) {
      // 含半步重力修正，见 JUMP_HALF_STEP_CORRECTION 注释
      this.vy = jumpLaunchVelocity(cfg);
      this.grounded = false;
    }

    // ── 4. 竖直方向：按坡度决定是否累积重力 ──
    //
    // ⚠️ 起跳当帧**照常**走重力积分，不要给它开特例。
    //
    // 曾经试过"起跳帧免掉重力"，理由是"半步修正已经抵消了这次积分"——**错了**。
    // 实测：免掉之后 P6 从 1.1999 涨到 1.2821（+8.2cm，正好是 g·dt/2 的量）。
    // 说明半步修正的语义是"补偿离散积分相对连续解的缺口"，
    // 而它补偿的那个积分**本来就该发生**。两者是一对，去掉任一半都会偏 8cm。
    // 反向验证记录在这里，免得后人再"优化"一次。
    const dy = this.driveVertical(dt);

    // ── 5. 交给控制器 ──
    this.cc.computeColliderMovement(this.collider, {
      x: this.vx * dt,
      y: dy,
      z: this.vz * dt,
    });
    const moved = this.cc.computedMovement();
    const t = this.body.translation();
    const nextX = t.x + moved.x;
    const nextY = t.y + moved.y;
    const nextZ = t.z + moved.z;
    this.body.setNextKinematicTranslation({ x: nextX, y: nextY, z: nextZ });

    // ── 6. 更新贴地状态与坡角 ──
    const wasGrounded = this.grounded;
    this.grounded = this.cc.computedGrounded();
    this.slopeDeg = this.readSlopeDeg(nextX, nextY, nextZ);

    // 落地：把向下的竖直速度清掉
    if (this.grounded && this.vy < 0) this.vy = 0;
    // 撞头：向上的速度清掉
    if (this.vy > 0 && Math.abs(moved.y - dy) > 1e-6) this.vy = 0;

    // ── 7. 转向（slerp，不瞬转） ──
    this.updateFacing(input, dt);

    // ── 8. 状态机 ──
    this.updateState(wasGrounded);

    // 水平速度也要跟着"实际能不能走"回落：撞墙后不该继续全速顶
    if (Math.abs(moved.x) < Math.abs(this.vx * dt) * 0.5) this.vx *= 0.5;
    if (Math.abs(moved.z) < Math.abs(this.vz * dt) * 0.5) this.vz *= 0.5;
  }

  /**
   * 竖直方向的策略。
   *
   * 这是 M4 里唯一一处"必须按坡度分情况"的地方，来自 M3 阶段的实测：
   *
   * - **平地/缓坡：不给竖直位移（dy=0）。**
   *   每帧无脑加重力会让角色每帧被往下拽一点，控制器要先把这点下沉"吃掉"再走，
   *   水平位移系统性偏短：实测 150 步本该走 5.000m，只走了 4.7667m（差 23cm，P1 红）。
   *
   * - **陡坡（> minSlopeSlideAngle）：必须持续施加向下位移。**
   *   实测 45° 坡上 dy=0 时角色**完全不滑**；持续下压后控制器才会把它投影成沿坡下滑
   *   （实测每步 z 走 0.09m，60 步滑 2.656m）。
   *
   * - **离地/上升中：正常累积重力。**
   */
  private driveVertical(dt: number): number {
    const cfg = this.config;

    // ⚠️ 这里**不要**给起跳帧做特殊处理（跳过重力积分）。
    //
    // 曾经试过"起跳当帧不扣重力"，理由是"半步修正已经抵消了这次积分"。
    // 实测证明那是**重复补偿**：起跳速度 4.934 已经含 +g·dt/2，
    // 若这一帧再免掉 -g·dt，等于净多给了 g·dt/2 的位移，
    // 跳高从 1.1999 涨到 1.2821（+8.2cm，P6 红）。
    //
    // 正确做法：起跳帧照常走"vy>0 → 正常积分"的路径。
    // 半步修正的作用就是抵消这一次积分，两者配合刚刚好得到 1.1999。
    if (this.grounded && this.vy <= 0) {
      // 加 0.5° 容差：实测 30° 坡读回来正好 30.0，而 minSlopeSlideAngle 也是 30°。
      // 不加容差的话"恰好等于阈值"会被判成该滑，P2 的 30° 坡就会被当成陡坡
      // （实测站立漂移 22cm，直接红）。spec 的意图是"30° 能站、45° 该滑"。
      if (this.slopeDeg > (cfg.minSlopeSlideAngle * 180) / Math.PI + 0.5) {
        this.vy += GRAVITY_Y * dt;
        return this.vy * dt;
      }
      this.vy = 0;
      return 0;
    }

    this.vy += GRAVITY_Y * dt;
    return this.vy * dt;
  }

  /** 读脚下坡角（度）。用向下射线的法线，不用接触列表（贴地静止时接触列表为空）。 */
  private readSlopeDeg(x: number, y: number, z: number): number {
    const hit = this.pw.groundHeightAt(x, z, y, this.capsuleHalfTotal + 0.5);
    if (!hit) return 0;
    const ny = hit.normalY > 1 ? 1 : hit.normalY < -1 ? -1 : hit.normalY;
    return (Math.acos(ny) * 180) / Math.PI;
  }

  /**
   * 朝向：向目标方向 slerp 过去。
   *
   * **朝向约定（全项目唯一事实来源，渲染层必须服从）**：
   * - 角色的"正前方"是 **+Z**；
   * - `yaw = atan2(fx, fz)`，所以面向 +Z 时 yaw = 0 → 四元数是 identity `[0,0,0,1]`；
   * - 面向 -Z 时 yaw = π → 四元数 `[0,1,0,0]`；
   * - 四元数按 `[0, sin(yaw/2), 0, cos(yaw/2)]` 构造。
   *
   * 这是 three.js 社区的事实标准，也是 glTF 角色的常见默认朝向。
   * 若美术导出的模型原生朝向不是 +Z，**不要改这里**——
   * 在渲染层给根节点加一个 `MODEL_FACING_OFFSET_Y`（例如 -π/2）来对齐，
   * 让"物理约定"和"资产约定"各自独立、可单独验证。
   * 把两者混在一起会导致：换个模型，物理和动画同时错。
   */
  private updateFacing(input: CharacterInput, dt: number): void {
    let fx = input.faceX ?? 0;
    let fz = input.faceZ ?? 0;
    // 没显式给朝向就朝移动方向
    if (Math.hypot(fx, fz) < 1e-6) {
      fx = input.dirX;
      fz = input.dirZ;
    }
    if (Math.hypot(fx, fz) < 1e-6) return;

    // 绕 y 轴的目标朝向（+Z 为前方，见上方约定）
    const yaw = Math.atan2(fx, fz);
    const target: [number, number, number, number] = [
      0,
      Math.sin(yaw / 2),
      0,
      Math.cos(yaw / 2),
    ];
    // slerp 比例按帧率归一：turnRate 是"每秒转多少"，乘 dt 再夹到 0..1
    const k = Math.min(1, this.config.turnRate * dt);
    this.rot = slerp(this.rot, target, k);
  }

  /**
   * 状态机。优先级：jumping > falling > run > walk > idle。
   *
   * grounded/airborne 的区分只看 computedGrounded，不看 y 速度：
   * 用 |vy| < 阈值 猜"站着"在斜坡上行、刚起跳、被顶一下的时候全是错的。
   */
  private updateState(wasGrounded: boolean): void {
    if (this.grounded) {
      const speed = Math.hypot(this.vx, this.vz);
      if (speed > this.config.runSpeed * 0.7) {
        this.state = 'grounded';
        this.anim = 'run';
      } else if (speed > 0.15) {
        this.state = 'grounded';
        this.anim = 'walk';
      } else {
        this.state = 'grounded';
        this.anim = 'idle';
      }
      return;
    }

    // 离地
    if (this.vy > 0.05) {
      this.state = 'jumping';
      this.anim = 'jump';
    } else if (this.vy < -0.05) {
      this.state = 'falling';
      this.anim = 'fall';
    } else {
      // 刚离地或到顶点：保持上一个空中状态，不要闪成 idle
      this.state = wasGrounded ? 'airborne' : this.state === 'grounded' ? 'airborne' : this.state;
      this.anim = this.lastAnim === 'jump' ? 'jump' : 'fall';
    }
    this.lastAnim = this.anim;
  }

  /** 把物理算出来的位置/朝向写回 World 层的实体（物理层唯一的出口）。 */
  writeTransform(apply: (t: Transform, anim: CharacterRuntime['anim']) => void): void {
    const t = this.body.translation();
    apply(
      { p: [t.x, t.y, t.z], r: [this.rot[0], this.rot[1], this.rot[2], this.rot[3]] },
      this.anim,
    );
  }

  dispose(): void {
    this.cc.free();
    this.pw.removeCharacter(this.body);
  }
}

/** 以 maxDelta 为步长逼近 target（不会越过）。 */
function approach(current: number, target: number, maxDelta: number): number {
  const diff = target - current;
  if (Math.abs(diff) <= maxDelta) return target;
  return current + Math.sign(diff) * maxDelta;
}

function clamp01(v: number): number {
  if (!Number.isFinite(v)) return 0;
  return v < 0 ? 0 : v > 1 ? 1 : v;
}
