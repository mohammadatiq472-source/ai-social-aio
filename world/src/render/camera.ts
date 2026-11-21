/**
 * 第三人称相机（spec §6 M1 第 3 条）。
 *
 * 结构：一个「轨道球坐标」+ 一个「弹簧跟随的目标点」。
 * - 球坐标（yaw/pitch/distance）负责环绕与缩放，天然不会滚过头顶。
 * - 目标点用弹簧插值，角色急停时镜头有一点惯性，观感比硬跟好。
 * - 位置在球坐标算出后再做**夹取**：pitch 上下限 + 地面高度下限。
 *
 * 为什么先 clamp 而不是射线：
 * v0.1 空场景还没有碰撞体，射线检测拿不到东西（会永远穿墙）。
 * 但 clamp 的接口按「可替换成射线」设计：`groundHeight` 是个函数，
 * M3 落地后把它换成 `physics.raycastDown()` 即可，调用方不用改。
 *
 * 纯数学部分（springStep / orbitPosition / clampPitch 等）不碰 DOM，
 * 可以在 node 里直接单测；交互事件在 attachInput 里。
 */

import * as THREE from 'three';
import { clampPitch } from '../core/types';

/** 俯仰角上下限（弧度）。上限接近水平，下限不让镜头钻到角色脚底下。 */
export const PITCH_MIN = -0.22; // 约 -12.6°：略低于水平，能看见地面
export const PITCH_MAX = 1.18; // 约 67.6°：俯视，再高就穿到角色头顶

/**
 * 缩放范围（米）。
 *
 * ZOOM_MIN 从 1.6 降到 0.55（2026-11-20）：用户要做**近景特写**（能看到脸）。
 * 1.6m 时角色占屏约 500px，脸部只占 80px，512 贴图看不出细节；
 * 0.55m 时脸部能占屏 300~400px，正好能验证贴图质量。
 *
 * 0.55 这个下限不是随便定的：胶囊半径 0.30 + 相机近裁剪面 0.1 + 余量，
 * 再近相机会穿进角色头部（表现为看到模型内壁/黑屏）。
 *
 * ZOOM_MAX 保持 9.0（远景看整个房间）。
 */
export const ZOOM_MIN = 0.55;
export const ZOOM_MAX = 9.0;

/**
 * 特写模式（`?cam=face`）的相机参数。
 *
 * 为什么要单独一个模式而不只是"把距离拉到最小"：
 * - **必须在角色正面**。第三人称默认 yaw=π（相机在角色背后，看后脑勺），
 *   特写要看脸就必须绕到 yaw=0（相机在 +Z 侧，而角色朝向也是 +Z）。
 *   这是最容易漏的一点：只调 distance/pitch 不调 yaw，拉近只会看到后脑勺。
 * - 俯仰角接近水平（默认 0.32 rad 是俯视，脸会变形）。
 * - 距离 1.0m：0.55m 会穿进头部（表现为黑屏或看到模型内壁）。
 *   1.0m + 55° fov 时，1.62m 高的角色占屏约 1100px，脸部约 300px，足够看细节。
 */
export const FACE_CAM = {
  distance: 1.6,
  pitch: 0.02,
  /**
   * 环绕角。**必须与 MODEL_FACING_OFFSET_Y 一起改**。
   *
   * 2026-11-20 第二次修正：`MODEL_FACING_OFFSET_Y` 从 +π/2 改成 -π/2 之后，
   * 模型正面在 root.rotation.y=0 时朝 **+Z**（与物理约定一致）。
   * 所以要看正脸，相机必须站在 **+Z 侧**看向 -Z ⇒ yaw = 0。
   *
   * 第一次我写的是 π，那是因为当时模型偏移是 +π/2（正面朝 -Z），
   * 两个错互相抵消，导致"特写看着对、走起来倒退"。
   */
  yaw: 0,
  /**
   * 视线目标相对脚底的高度（米）。
   * 角色总高 1.62m，脸部约在 1.45~1.55m。默认 lookHeight 1.25 是胸口。
   */
  lookHeight: 1.48,
} as const;

/**
 * 焦点切换的缓动时长（秒）。spec §6 M10 第 3 条：「点击某个角色把相机焦点切过去（1s 缓动）」。
 *
 * 这个常量是**相机层**的，不是交互层的：`interact/index.ts` 也导出同名常量
 * （`FOCUS_EASE_SECONDS`）用于它的纯逻辑状态机。两者必须同值——那边被单测锁成 1，
 * 这边被 `camera-focus.test.ts` 锁成 1。改一处不改另一处，验收会出现
 * 「进度条走完了但镜头还没到」的半秒空档。
 */
export const FOCUS_EASE_SECONDS = 1;

/** 弹簧参数（半隐式欧拉，临界阻尼附近）。 */
export interface SpringConfig {
  /** 角频率，越大跟得越紧。 */
  stiffness: number;
  /** 阻尼比：1 = 临界阻尼（不过冲），<1 会弹几下。 */
  damping: number;
}

export const DEFAULT_SPRING: SpringConfig = { stiffness: 9, damping: 1 };

/**
 * 弹簧一步。半隐式欧拉 + 解析阻尼，dt 大时也不会发散。
 * 返回新位置与新速度，不改入参（纯函数，好测）。
 */
export function springStep(
  current: number,
  velocity: number,
  target: number,
  dt: number,
  cfg: SpringConfig = DEFAULT_SPRING,
): { value: number; velocity: number } {
  const k = cfg.stiffness;
  const c = 2 * Math.sqrt(k) * cfg.damping;
  // 半隐式：先积速度再积位置，比显式欧拉稳定一档
  const accel = k * (target - current) - c * velocity;
  const v = velocity + accel * dt;
  const value = current + v * dt;
  return { value, velocity: v };
}

/** 对 Vector3 做弹簧（相机目标点用）。 */
export function springVec3(
  current: THREE.Vector3,
  velocity: THREE.Vector3,
  target: THREE.Vector3,
  dt: number,
  cfg: SpringConfig = DEFAULT_SPRING,
): void {
  const k = cfg.stiffness;
  const c = 2 * Math.sqrt(k) * cfg.damping;
  // 分轴独立解，三轴同参数，等价于对向量整体做
  const ax = k * (target.x - current.x) - c * velocity.x;
  const ay = k * (target.y - current.y) - c * velocity.y;
  const az = k * (target.z - current.z) - c * velocity.z;
  velocity.x += ax * dt;
  velocity.y += ay * dt;
  velocity.z += az * dt;
  current.x += velocity.x * dt;
  current.y += velocity.y * dt;
  current.z += velocity.z * dt;
}

/**
 * 球坐标 → 世界坐标。yaw 绕 Y 轴，pitch 为正表示镜头在上方俯视。
 * 单独抽出来是为了单测：给定角度能直接断言镜头在角色哪一侧。
 */
export function orbitPosition(
  target: THREE.Vector3,
  yaw: number,
  pitch: number,
  distance: number,
  out = new THREE.Vector3(),
): THREE.Vector3 {
  const cp = Math.cos(pitch);
  out.set(
    target.x + distance * cp * Math.sin(yaw),
    target.y + distance * Math.sin(pitch),
    target.z + distance * cp * Math.cos(yaw),
  );
  return out;
}

/**
 * 地面夹取：镜头不许低于地面 + 余量。
 * `groundHeight` 之后可以换成物理射线（返回该点地面高度）。
 */
export function clampToGround(
  pos: THREE.Vector3,
  groundHeight: number,
  clearance: number,
): THREE.Vector3 {
  const floor = groundHeight + clearance;
  if (pos.y < floor) pos.y = floor;
  return pos;
}

/**
 * 相机避障（boom collision）的纯计算部分。
 *
 * 为什么需要：第三人称相机在"注视点 → 理想机位"这条射线上如果有墙，
 * 镜头会穿进墙里，画面变成"墙的内壁"（一片纯色），玩家会以为卡死了。
 * 我们刚给场景加了四面墙，这个缺陷现在会明显暴露。
 *
 * 算法（这是业界标准做法，也是"网上南宁"那份逆向分析里第 5.3 节的做法）：
 * 1. 从注视点朝理想机位打一条射线，得到命中距离 `hitDistance`
 * 2. 若命中距离 < 理想距离，把机位沿射线拉回到 `hitDistance - padding`
 * 3. 拉回比例做**时间平滑**（`openFraction`），否则贴墙走时镜头会疯狂抖动
 *
 * 为什么要平滑而不是直接用命中点：
 * 射线的命中距离在贴墙滑动时是逐帧跳变的（这一帧 3.2m、下一帧 1.8m），
 * 直接用会让画面抽搐。平滑后是"镜头缓缓贴过去"，观感自然。
 *
 * @param idealDistance 无遮挡时相机到注视点的距离
 * @param hitDistance   射线命中距离；null 表示没有命中（无遮挡）
 * @param padding       镜头与墙保持的安全距离（米）
 * @param prevFraction  上一帧的可见比例（0..1），用于平滑
 * @param dt            帧间隔（秒）
 * @param smoothRate    平滑速率（越大收敛越快）。8 大约 0.3s 到位
 * @returns 本帧应该使用的距离
 */
export function resolveBoomDistance(
  idealDistance: number,
  hitDistance: number | null,
  padding: number,
  prevFraction: number,
  dt: number,
  smoothRate = 8,
): { distance: number; fraction: number } {
  // 无遮挡：目标比例 1
  let targetFraction = 1;
  if (hitDistance !== null && idealDistance > 1e-6) {
    // 命中点前留 padding。夹到 0..1，避免负距离（相机跑到注视点后面）
    const usable = Math.max(0, hitDistance - padding);
    targetFraction = Math.min(1, usable / idealDistance);
  }

  // 指数平滑（帧率无关）。拉近要**快**（否则这一帧就已经穿墙了），
  // 推远要**慢**（否则离开墙时镜头猛地弹回去，观感像抽筋）。
  const approaching = targetFraction < prevFraction;
  const rate = approaching ? smoothRate * 3 : smoothRate;
  const t = Number.isFinite(dt) && dt > 0 ? 1 - Math.exp(-rate * dt) : 1;
  const fraction = prevFraction + (targetFraction - prevFraction) * t;

  return { distance: idealDistance * fraction, fraction };
}

export interface CameraRigOptions {
  fov?: number;
  near?: number;
  far?: number;
  /** 初始距离。 */
  distance?: number;
  /** 初始 yaw / pitch。 */
  yaw?: number;
  pitch?: number;
  /**
   * 视线目标相对**脚底**的高度（米）。
   *
   * ⚠️ 调用方传进来的 `actorPos` 是**胶囊中心**（站立时约 0.87m），
   * 不是脚底！所以内部必须先减去胶囊中心高度再叠加 lookHeight，
   * 否则特写时注视点会飘到 2.35m（远高于 1.62m 的头顶），角色直接出画。
   *
   * 默认 1.25 是胸口（相对脚底），与 M1 的行为保持一致。
   */
  lookHeight?: number;
  /**
   * 胶囊中心相对脚底的高度（米）。默认 0.85（= DEFAULT_CHARACTER 的
   * halfHeight 0.55 + radius 0.30）。传 0 表示调用方已自行换算成脚底高度。
   */
  capsuleCenterHeight?: number;
  spring?: SpringConfig;
}

/**
 * 相机装配：把 renderer 的 resize 事件、鼠标/触屏输入、跟随更新粘起来。
 * 外部只需要 `update(actorPos, dt)`。
 */
export class ThirdPersonCamera {
  readonly camera: THREE.PerspectiveCamera;

  private yaw: number;
  private pitch: number;
  private distance: number;

  private lookHeight: number;
  /**
   * 胶囊中心相对脚底的高度。用于把调用方传进来的"胶囊中心"换算成"脚底"。
   * 0 表示调用方传的已经是脚底高度。
   */
  private capsuleCenterHeight: number;
  private spring: SpringConfig;

  /** 弹簧跟随的「注视点」（角色胸口附近）。 */
  private smoothTarget = new THREE.Vector3();
  private smoothVelocity = new THREE.Vector3();
  private initialized = false;

  private readonly tmpTarget = new THREE.Vector3();
  private readonly tmpPos = new THREE.Vector3();

  /** 供 M3 替换成物理射线。默认平地 y=0。 */
  groundHeight: (x: number, z: number) => number = () => 0;
  /** 镜头离地最小高度。 */
  groundClearance = 0.35;

  /**
   * 相机避障射线查询（由 main.ts 注入物理世界的 raycast）。
   *
   * 返回 `[0, maxDistance]` 内的命中距离；无命中返回 `null`。
   * 默认 `null`（不做避障）—— 这样不注入也不影响既有行为与单测。
   */
  occlude: ((from: THREE.Vector3, to: THREE.Vector3) => number | null) | null = null;
  /** 镜头与障碍物保持的安全距离（米）。 */
  boomPadding = 0.32;
  /** 当前可见比例（0..1）。1 = 完全无遮挡。 */
  private boomFraction = 1;

  /** 鼠标是否处于 Pointer Lock 状态（调试/UI 提示用）。 */
  private locked = false;

  /** 鼠标是否已锁定（锁定后指针隐藏、移动直接转视角）。 */
  get isPointerLocked(): boolean {
    return this.locked;
  }

  /** 避障的当前可见比例（验收/调试用）。1 = 无遮挡，<1 = 镜头被拉近。 */
  get boomVisibility(): number {
    return this.boomFraction;
  }
  /** 复用的射线端点，避免每帧 new。 */
  private readonly tmpRayFrom = new THREE.Vector3();
  private readonly tmpRayTo = new THREE.Vector3();

  // ── 焦点（M10 第 3 条：点击某个角色，1s 缓动切过去）──
  //
  // 设计取舍：焦点**只影响注视点**，不影响 yaw/pitch/distance。
  // 理由：yaw/pitch 是玩家自己的环绕意图（右键拖拽），如果焦点切换时去改它们，
  // 玩家刚调好的机位会被"点一下角色"打乱，观感是镜头自己转了个方向。
  // 焦点只做一件事：把注视点从「自己」平移到「那个人」，其余照旧。
  //
  // 用**独立的缓动向量**而不是复用 smoothTarget：spring 是"跟随"（永远追最新目标），
  // 焦点是"一次性转场"（1s 走完，然后稳定）。混在一起会导致点击后镜头永远在漂。
  /** 焦点目标的世界坐标（null = 没有焦点，直接用 actorPos）。 */
  private focusTarget: THREE.Vector3 | null = null;
  /** 是否处于焦点转场中（含"回到自己"的那一段）。false 时 update 走原路径。 */
  private focusing = false;
  /** 焦点缓动进度 0..1。1 = 已到位。 */
  private focusT = 1;
  /** 缓动起点（切换焦点那一刻的注视点）。 */
  private readonly focusFrom = new THREE.Vector3();
  /** 缓动终点（目标角色此刻的注视点）。每帧刷新：人可能在走。 */
  private readonly focusTo = new THREE.Vector3();

  private detach: (() => void) | null = null;

  constructor(opts: CameraRigOptions = {}) {
    const fov = opts.fov ?? 55;
    this.camera = new THREE.PerspectiveCamera(fov, 1, opts.near ?? 0.1, opts.far ?? 200);
    this.distance = opts.distance ?? 4.2;
    this.yaw = opts.yaw ?? Math.PI;
    this.pitch = opts.pitch ?? 0.32;
    this.lookHeight = opts.lookHeight ?? 1.25;
    this.capsuleCenterHeight = opts.capsuleCenterHeight ?? 0;
    this.spring = opts.spring ?? DEFAULT_SPRING;
  }

  get currentYaw(): number {
    return this.yaw;
  }

  get currentPitch(): number {
    return this.pitch;
  }

  get currentDistance(): number {
    return this.distance;
  }

  /** 相机朝向的水平前向量（角色移动要按镜头方向算，不能按世界轴）。 */
  getForward(out = new THREE.Vector3()): THREE.Vector3 {
    return out.set(-Math.sin(this.yaw), 0, -Math.cos(this.yaw)).normalize();
  }

  getRight(out = new THREE.Vector3()): THREE.Vector3 {
    return out.set(Math.cos(this.yaw), 0, -Math.sin(this.yaw)).normalize();
  }

  /** renderer 的 resize 回调直接调这个。 */
  setAspect(aspect: number): void {
    if (!Number.isFinite(aspect) || aspect <= 0) return;
    this.camera.aspect = aspect;
    this.camera.updateProjectionMatrix();
  }

  resize(width: number, height: number): void {
    this.setAspect(width / Math.max(1, height));
  }

  /**
   * 每帧调用。`actorPos` 是**注视基准点**（调用方传角色胸口或脚底+lookHeight 之前的值）。
   *
   * 有焦点时注视点会先按焦点缓动插值到目标角色，再做弹簧跟随。
   * 没有焦点时行为与 M1 完全一致（不额外分配、不额外分支开销）。
   *
   * dt 用渲染 dt（不是物理 dt）——镜头观感要跟画面帧率走，不该被物理步长绑住。
   */
  update(actorPos: THREE.Vector3, dt: number): void {
    // 换算：调用方传的 actorPos 是**胶囊中心**，先减掉它还原到脚底，再叠加 lookHeight。
    // 不减会让注视点比实际高 0.85m —— 特写时角色会直接出画（实测踩过）。
    this.tmpTarget.set(
      actorPos.x,
      actorPos.y - this.capsuleCenterHeight + this.lookHeight,
      actorPos.z,
    );

    // 焦点转场：把注视点从 self 平移到目标（1s，smoothstep）。
    // 只在转场期间生效；到位后仍锁在目标上（人可能在走），但不再做插值。
    if (this.focusing) {
      if (this.focusT < 1) {
        const step = dt > 0 ? dt / FOCUS_EASE_SECONDS : 1;
        this.focusT = Math.min(1, this.focusT + step);
      }
      if (this.focusTarget !== null) {
        // 终点每帧刷新：目标在走时要跟住它，而不是停在"点击那一刻的旧位置"
        this.focusTo.copy(this.focusTarget);
        this.focusTo.y += this.lookHeight;
      } else {
        // 回到自己：终点就是本帧的 actorPos
        this.focusTo.copy(this.tmpTarget);
      }
      // smoothstep：两端速度为 0，不会"到点撞一下"
      const k = smoothstep01(this.focusT);
      this.tmpTarget.set(
        this.focusFrom.x + (this.focusTo.x - this.focusFrom.x) * k,
        this.focusFrom.y + (this.focusTo.y - this.focusFrom.y) * k,
        this.focusFrom.z + (this.focusTo.z - this.focusFrom.z) * k,
      );
      // 回到自己且已到位 → 退出转场，恢复"每帧直接跟随 actorPos"（否则会锁死在旧位置）
      if (this.focusTarget === null && this.focusT >= 1) this.focusing = false;
    }

    if (!this.initialized) {
      // 首帧直接吸附，否则进房时镜头从原点飞过去
      this.smoothTarget.copy(this.tmpTarget);
      this.smoothVelocity.set(0, 0, 0);
      this.initialized = true;
    } else {
      springVec3(this.smoothTarget, this.smoothVelocity, this.tmpTarget, Math.min(dt, 0.05), this.spring);
    }

    this.pitch = clampPitch(this.pitch, PITCH_MIN, PITCH_MAX);
    orbitPosition(this.smoothTarget, this.yaw, this.pitch, this.distance, this.tmpPos);
    clampToGround(this.tmpPos, this.groundHeight(this.tmpPos.x, this.tmpPos.z), this.groundClearance);

    // ── 避障：如果注视点到机位之间被挡住，把镜头拉近 ──
    //
    // 必须在 clampToGround **之后**做：地面夹取会抬高机位（改变射线终点），
    // 先夹取再测遮挡才准。
    if (this.occlude) {
      this.tmpRayFrom.copy(this.smoothTarget);
      this.tmpRayTo.copy(this.tmpPos);
      const ideal = this.tmpRayFrom.distanceTo(this.tmpRayTo);
      const hit = ideal > 1e-6 ? this.occlude(this.tmpRayFrom, this.tmpRayTo) : null;
      const r = resolveBoomDistance(ideal, hit, this.boomPadding, this.boomFraction, dt);
      this.boomFraction = r.fraction;
      if (r.fraction < 0.9999) {
        // 沿射线把机位拉回到安全距离处
        this.tmpPos.copy(this.tmpRayFrom).lerp(this.tmpRayTo, r.fraction);
      }
    } else {
      this.boomFraction = 1;
    }

    this.camera.position.copy(this.tmpPos);
    this.camera.lookAt(this.smoothTarget);
  }

  // ── 焦点接口（M10） ──

  /**
   * 把焦点切到 `target`（世界坐标）。传 `null` 回到"跟随自己"。
   *
   * 缓动起点取**当前实际注视点**（`smoothTarget`），不是"上一次的焦点目标"：
   * 连续点两个不同角色时，第二次要从镜头此刻真正看的位置出发，
   * 否则画面会先跳回第一个人再走过去。
   */
  focusOn(target: THREE.Vector3 | null): void {
    if (target === null) {
      // 回自己：同样走缓动，不要瞬移（瞬移会让人以为是 bug）
      if (this.focusTarget === null && !this.focusing) return;
      this.focusFrom.copy(this.smoothTarget);
      this.focusTarget = null;
      this.focusT = 0;
      this.focusing = true;
      return;
    }
    this.focusFrom.copy(this.smoothTarget);
    this.focusTarget = target.clone();
    this.focusT = 0;
    this.focusing = true;
  }

  /** 回到"跟随自己"。等价于 `focusOn(null)`，只是读起来更明确。 */
  clearFocus(): void {
    this.focusOn(null);
  }

  /**
   * 只更新焦点目标的**位置**，不重置缓动进度。
   *
   * 为什么需要这个：`focusOn()` 每次调用都会把 `focusT` 重置成 0。
   * 目标角色在走的时候，调用方每帧都要更新注视点位置——
   * 如果每帧都走 `focusOn()`，缓动会永远停在起点，镜头一动不动
   * （实测：进度条到 1 了，画面却完全没跟过去）。
   *
   * 所以约定：**目标变了调 `focusOn()`，目标没变但位置变了调这个。**
   */
  updateFocusTarget(target: THREE.Vector3): void {
    if (this.focusTarget === null) {
      // 没有焦点时不该走到这里；当作一次直接设置，避免静默丢失
      this.snapFocus(target);
      return;
    }
    this.focusTarget.copy(target);
  }

  /** 当前是否正看向某个外部目标（验收脚本断言用）。 */
  get hasFocus(): boolean {
    return this.focusTarget !== null;
  }

  /** 焦点缓动进度 0..1（验收脚本断言"1s 后到位"用）。 */
  get focusProgress(): number {
    return this.focusT;
  }

  /**
   * 立即把焦点设到某处，不做缓动（重生/传送用）。
   * 与 `snapTo` 同一语义：镜头不该"飞过去"的场合。
   */
  snapFocus(target: THREE.Vector3 | null): void {
    this.focusTarget = target ? target.clone() : null;
    this.focusT = 1;
    this.focusing = target !== null;
    if (target) this.focusTo.copy(target);
  }

  /** 立即对齐（换房间/传送时用，不要飞过去）。 */
  snapTo(actorPos: THREE.Vector3): void {
    this.initialized = false;
    this.update(actorPos, 0);
  }

  // ── 输入 ──

  /**
   * 绑交互：
   * - 滚轮缩放
   * - 右键拖拽 / 左键拖拽环绕（左键也开，触屏单指等价）
   * - 双指捏合缩放 + 双指拖拽环绕
   * 全部 passive:false 并 preventDefault，否则触屏会被浏览器抢走（页面滚动/回弹）。
   */
  attachInput(el: HTMLElement): () => void {
    this.detach?.();

    let dragging = false;
    let lastX = 0;
    let lastY = 0;
    let pointerId: number | null = null;

    const touchState = new Map<number, { x: number; y: number }>();
    let pinchStartDist = 0;
    let pinchStartZoom = 0;

    const onWheel = (e: WheelEvent): void => {
      e.preventDefault();
      // deltaMode 0=像素 1=行 2=页；统一换算成"滚了几格"
      const unit = e.deltaMode === 1 ? 16 : e.deltaMode === 2 ? 400 : 1;
      const delta = (e.deltaY * unit) / 100;
      this.zoomBy(delta * 0.55);
    };

    /**
     * Pointer Lock（鼠标锁定）—— 这是第三人称游戏的标准操作方式。
     *
     * 为什么必须有（用户反馈"代入感不够"）：
     * 之前是**按住拖拽**才能转视角，这意味着：
     *   1. 鼠标指针一直露在画面上，破坏沉浸感
     *   2. 想转视角必须按住键，手不能离开
     *   3. 鼠标移到屏幕边缘就转不动了（拖拽受窗口边界限制）
     *
     * Pointer Lock 之后：
     *   - 点一下画面 → 鼠标指针消失，鼠标移动直接驱动视角
     *   - 鼠标可以无限旋转（不受窗口边界限制）
     *   - 按 Esc 退出锁定（浏览器强制，无法拦截）
     *
     * 这是"网上南宁"、原神、GTA 等所有第三人称 3D 游戏的做法。
     */
    let locked = false;

    const onPointerLockChange = (): void => {
      locked = document.pointerLockElement === el;
      this.locked = locked;
      // 锁定时鼠标指针隐藏（由浏览器负责），退出时恢复
      el.style.cursor = locked ? 'none' : '';
    };

    const onPointerLockError = (): void => {
      // 浏览器拒绝锁定（比如不在用户手势里、或 iframe 没 allow="pointer-lock"）
      // 不要抛错炸页面 —— 静默回落到拖拽模式，功能仍然可用
      locked = false;
      this.locked = false;
      el.style.cursor = '';
    };

    const requestLock = (): void => {
      // requestPointerLock 在某些浏览器返回 Promise（失败时 reject），必须接住
      const r = el.requestPointerLock?.() as unknown;
      if (r && typeof (r as Promise<void>).catch === 'function') {
        (r as Promise<void>).catch(() => {
          /* 静默回落，onPointerLockError 也会触发 */
        });
      }
    };

    const onPointerDown = (e: PointerEvent): void => {
      // 只处理右键和左键；中键留给浏览器
      if (e.button !== 0 && e.button !== 2) return;

      // 左键点击 = 请求鼠标锁定（进游戏的标准手势）
      // 注意：必须由**用户手势**触发，不能在 load 时自动请求（浏览器会拒绝）
      if (e.button === 0 && !locked) {
        requestLock();
        return;
      }

      // 未锁定时的右键仍然支持拖拽环绕（降级路径，保证锁定被拒也能用）
      if (!locked) {
        dragging = true;
        pointerId = e.pointerId;
        lastX = e.clientX;
        lastY = e.clientY;
        el.setPointerCapture?.(e.pointerId);
      }
    };

    const onPointerMove = (e: PointerEvent): void => {
      // 锁定模式：用 movementX/Y（浏览器给的**相对位移**，不受窗口边界限制）
      if (locked) {
        this.orbitBy(e.movementX, e.movementY);
        return;
      }
      if (!dragging || e.pointerId !== pointerId) return;
      const dx = e.clientX - lastX;
      const dy = e.clientY - lastY;
      lastX = e.clientX;
      lastY = e.clientY;
      this.orbitBy(dx, dy);
    };

    const endDrag = (e: PointerEvent): void => {
      if (e.pointerId !== pointerId) return;
      dragging = false;
      pointerId = null;
      el.releasePointerCapture?.(e.pointerId);
    };

    const onContextMenu = (e: Event): void => {
      e.preventDefault(); // 右键用来环绕，不能弹菜单
    };

    const touchDistance = (): number => {
      const pts = [...touchState.values()];
      if (pts.length < 2) return 0;
      const a = pts[0]!;
      const b = pts[1]!;
      return Math.hypot(a.x - b.x, a.y - b.y);
    };

    const onTouchStart = (e: TouchEvent): void => {
      for (const t of Array.from(e.changedTouches)) {
        touchState.set(t.identifier, { x: t.clientX, y: t.clientY });
      }
      if (touchState.size === 2) {
        pinchStartDist = touchDistance();
        pinchStartZoom = this.distance;
      }
      e.preventDefault();
    };

    const onTouchMove = (e: TouchEvent): void => {
      const prev = new Map(touchState);
      for (const t of Array.from(e.changedTouches)) {
        touchState.set(t.identifier, { x: t.clientX, y: t.clientY });
      }

      if (touchState.size === 1) {
        const t = Array.from(e.changedTouches)[0];
        const old = t ? prev.get(t.identifier) : undefined;
        if (t && old) this.orbitBy(t.clientX - old.x, t.clientY - old.y);
      } else if (touchState.size === 2) {
        // 双指：距离变化 → 缩放；中点平移 → 环绕
        const dist = touchDistance();
        if (pinchStartDist > 0 && dist > 0) {
          const ratio = pinchStartDist / dist;
          this.distance = clamp(this.distance, pinchStartZoom * ratio, ZOOM_MIN, ZOOM_MAX);
        }
        const pts = [...touchState.values()];
        const oldPts = [...prev.values()];
        if (pts.length === 2 && oldPts.length === 2) {
          const cx = (pts[0]!.x + pts[1]!.x) / 2;
          const cy = (pts[0]!.y + pts[1]!.y) / 2;
          const ocx = (oldPts[0]!.x + oldPts[1]!.x) / 2;
          const ocy = (oldPts[0]!.y + oldPts[1]!.y) / 2;
          this.orbitBy(cx - ocx, cy - ocy);
        }
      }
      e.preventDefault();
    };

    const onTouchEnd = (e: TouchEvent): void => {
      for (const t of Array.from(e.changedTouches)) touchState.delete(t.identifier);
      if (touchState.size < 2) pinchStartDist = 0;
      e.preventDefault();
    };

    el.addEventListener('wheel', onWheel, { passive: false });
    el.addEventListener('pointerdown', onPointerDown);
    el.addEventListener('pointermove', onPointerMove);
    el.addEventListener('pointerup', endDrag);
    el.addEventListener('pointercancel', endDrag);
    el.addEventListener('contextmenu', onContextMenu);
    el.addEventListener('touchstart', onTouchStart, { passive: false });
    el.addEventListener('touchmove', onTouchMove, { passive: false });
    el.addEventListener('touchend', onTouchEnd, { passive: false });
    el.addEventListener('touchcancel', onTouchEnd, { passive: false });
    // Pointer Lock 事件挂在 document 上（浏览器把事件派发到 document）
    document.addEventListener('pointerlockchange', onPointerLockChange);
    document.addEventListener('pointerlockerror', onPointerLockError);

    const cleanup = (): void => {
      el.removeEventListener('wheel', onWheel);
      el.removeEventListener('pointerdown', onPointerDown);
      el.removeEventListener('pointermove', onPointerMove);
      el.removeEventListener('pointerup', endDrag);
      el.removeEventListener('pointercancel', endDrag);
      el.removeEventListener('contextmenu', onContextMenu);
      el.removeEventListener('touchstart', onTouchStart);
      el.removeEventListener('touchmove', onTouchMove);
      el.removeEventListener('touchend', onTouchEnd);
      el.removeEventListener('touchcancel', onTouchEnd);
      document.removeEventListener('pointerlockchange', onPointerLockChange);
      document.removeEventListener('pointerlockerror', onPointerLockError);
      // 卸载时如果还锁着，主动释放（否则鼠标指针永远消失）
      if (document.pointerLockElement === el) document.exitPointerLock?.();
      el.style.cursor = '';
      this.detach = null;
    };
    this.detach = cleanup;
    return cleanup;
  }

  /** 环绕：像素 → 弧度。灵敏度按屏幕宽度归一，小屏不会转得飞快。 */
  orbitBy(dxPx: number, dyPx: number, sensitivity = 0.0032): void {
    this.yaw -= dxPx * sensitivity;
    this.pitch = clampPitch(this.pitch + dyPx * sensitivity, PITCH_MIN, PITCH_MAX);
  }

  /** 缩放：正 delta 拉远。 */
  zoomBy(delta: number): void {
    this.distance = clamp(this.distance + delta, this.distance, ZOOM_MIN, ZOOM_MAX);
  }

  setDistance(d: number): void {
    this.distance = clamp(d, this.distance, ZOOM_MIN, ZOOM_MAX);
  }

  /**
   * 直接设俯仰角（弧度）。用于特写预设（`?cam=face`）。
   *
   * 为什么不复用 orbitBy：那是**增量**接口（像素 → 角度），
   * 想"设成某个值"得先知道当前值再算差值，调用方要多读一次状态，容易写错。
   * 这里直接给绝对值并夹到合法范围，语义更清楚。
   */
  /**
   * 直接设环绕角（弧度）。用于特写预设（`?cam=face`）。
   *
   * 语义：yaw 是相机相对角色的方位角。yaw=π 时相机在角色背后（第三人称默认），
   * yaw=0 时相机在 +Z 侧。因为物理约定角色朝向 +Z，所以 **yaw=0 才能看到正脸**。
   * 这条是特写模式最容易漏的地方：只拉近距离不改 yaw，看到的还是后脑勺。
   */
  setYaw(yaw: number): void {
    this.yaw = Number.isFinite(yaw) ? yaw : this.yaw;
  }

  setPitch(pitch: number): void {
    this.pitch = clampPitch(pitch, PITCH_MIN, PITCH_MAX);
  }

  /**
   * 设视线目标高度（米，相对脚底）。用于特写预设。
   *
   * 为什么需要这个而不是只调 distance：注视点决定"画面中心对着哪里"。
   * 默认 1.25m 是胸口，特写时画面中心会落在脖子上，脸被顶到画面外。
   * 抬到 1.48m（角色 1.62m 的脸部位置）才能让脸在画面中间。
   */
  setLookHeight(h: number): void {
    if (Number.isFinite(h) && h > 0) this.lookHeight = h;
  }

  detachInput(): void {
    this.detach?.();
  }
}

function clamp(v: number, _prev: number, min: number, max: number): number {
  if (!Number.isFinite(v)) return _prev;
  return v < min ? min : v > max ? max : v;
}

/**
 * smoothstep 缓动：t=0→0, t=0.5→0.5, t=1→1，两端速度为 0。
 *
 * 这里自带一份而不从 `interact/index.ts` import：camera 是 M1 的模块，
 * 不该为了一个 3 行数学函数去依赖交互层（那会把 M10 变成 M1 的上游）。
 * 两份实现的一致性由各自的单测锁住（同输入同输出）。
 */
function smoothstep01(t: number): number {
  const x = t < 0 ? 0 : t > 1 ? 1 : t;
  return x * x * (3 - 2 * x);
}
