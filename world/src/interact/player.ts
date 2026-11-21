/**
 * 玩家交互控制器（spec §6 M10 的接线层）。
 *
 * 这个文件把三样东西粘起来：**键盘输入 → 交互状态机 → 物理控制器**。
 * 它不碰渲染（座位/箱子的可见性在 `./scene.ts`），也不碰相机（焦点接口在
 * `render/camera.ts`，由 `main.ts` 调用）。
 *
 * ═══════════════ 三条硬纪律（Lead 反复强调，违反会让验收变成假的） ═══════════════
 *
 * **1. 禁用移动输入 ≠ 跳过物理步。**
 *    `movementAllowed(state) === false` 时，这里把方向位清零，但**仍然**调
 *    `controller.update(零输入)`。原因：`update()` 不只是"移动"，它还负责
 *    贴地、坡度、重力、autostep、落地清 vy。跳过它，角色会在空中冻结、
 *    在斜坡上不下滑、站着站着穿进地里。
 *    所以禁用的是**方向**，不是**物理**。
 *
 * **2. 坐下吸附走 `controller.teleport()`，绝不写 transform。**
 *    直接写 `world.updateActor({transform})` 会让实体表和物理刚体脱节：
 *    下一帧物理还在旧位置，`writeTransform()` 又把实体表覆盖回去，
 *    表现为"坐下瞬间弹回原地"。`teleport()` 同时设 `setTranslation` 与
 *    `setNextKinematicTranslation`，物理与实体表在同一帧对齐。
 *
 * **3. 推箱不写脚本。**
 *    推力来自 `CharacterController` 构造时的
 *    `cc.setApplyImpulsesToDynamicBodies(true)`（M4 已开）。
 *    这里**一行推力代码都没有**，只提供 `canPush()` 给 HUD 提示。
 *    写 `applyImpulse` 会变成双重推力，P8 的"箱位移 2.757m"会翻倍。
 *
 * ═══════════════ 为什么坐下要"分两帧" ═══════════════
 *
 * 按 E 的那一帧只改状态（`mode: 'free' → 'sitting'`），**不**立刻 teleport；
 * 下一个物理步看到 `sitting` 才吸附。理由：
 * - `teleport()` 之后紧跟一次 `update()`，`update()` 里的
 *   `computeColliderMovement` 会拿**吸附后**的位置做碰撞解算，
 *   如果同一帧里又跑了 `setNextKinematicTranslation`，两者会打架；
 * - 分开之后，"按 E → 下一物理步吸附"的延迟是 1/60 秒，肉眼不可见。
 *
 * 另外，吸附**每次物理步都重设**（而不是只设一次）：座位是静态几何，
 * 但角色会被别的角色/箱子撞偏。持续重设才能保证"坐着就一直坐在那"。
 */

import type { EntityId } from '../core/types';
import type { RoomSeat } from '../core/room';
import type { CharacterController, CharacterInput } from '../physics/character';
import { DEFAULT_CHARACTER } from '../physics/character';
import type { World } from '../core/world';
import {
  advanceFocus,
  canPush,
  focusOn,
  initialInteractState,
  movementAllowed,
  nearestSeat,
  sitPose,
  standPose,
  toggleSit,
  type FocusState,
  type InteractState,
} from './index';

/** 胶囊中心离脚底的高度（= halfHeight + radius = 0.85）。 */
export const CAPSULE_CENTER_HEIGHT = DEFAULT_CHARACTER.halfHeight + DEFAULT_CHARACTER.radius;

/** 玩家控制器需要的依赖。 */
export interface PlayerControllerOptions {
  world: World;
  /** 玩家实体 id（`p:*`）。 */
  id: EntityId;
  /** 物理控制器。物理没就绪时可以是 null（此时只跑状态机，不动人）。 */
  controller: CharacterController | null;
  /** 房间座位表。 */
  seats: readonly RoomSeat[];
  /**
   * 每帧读一次"玩家想往哪走"。返回世界空间水平方向 + run/jump。
   *
   * 用回调而不是直接吃 `KeyboardInput`：输入层归 M1（`src/input/keyboard.ts`），
   * 这里只消费它的输出，避免交互层反向依赖输入层的实现细节。
   */
  readMove: () => { dirX: number; dirZ: number; run: boolean; jump: boolean };
  /**
   * 可推动道具的当前位置（推箱提示用）。
   *
   * 传函数而不是数组：道具在动，每步读一次才是最新位置。
   * 注意这**只用于提示**——真正的推力由物理侧角色控制器施加。
   */
  readPropPositions?: () => readonly (readonly [number, number, number])[];
  /** 可选：HUD 提示回调。 */
  onPrompt?: (prompt: PlayerPrompt) => void;
}

/** 给 HUD 的一句话提示（M10 的可读性要求：按键存在但不能用时要说明原因）。 */
export interface PlayerPrompt {
  /** 现在按 E 会发生什么。 */
  sit: 'none' | 'can_sit' | 'can_stand';
  /** 面前是否有可推的箱子（纯提示，不产生推力）。 */
  canPush: boolean;
  /** 当前模式。 */
  mode: 'free' | 'sitting';
}

/**
 * 玩家控制器。
 *
 * 生命周期：`new PlayerController(...)` → 每物理步 `step(dt)` → `dispose()`。
 * 每**渲染帧**调 `tickFocus(dt)` 推进焦点缓动（焦点是观感，跟画面帧率走）。
 */
export class PlayerController {
  readonly id: EntityId;

  private readonly world: World;
  private readonly seats: readonly RoomSeat[];
  private readonly readMove: PlayerControllerOptions['readMove'];
  private readonly readPropPositions: PlayerControllerOptions['readPropPositions'];
  private readonly onPrompt: PlayerControllerOptions['onPrompt'];

  private controller: CharacterController | null;
  private state: InteractState = initialInteractState();
  private focus: FocusState = focusOn(null);
  /** 焦点状态是否"已经到位"，避免每帧都重置缓动。 */
  private focusSettled = true;

  /** 上一步的模式（检测 sitting → free 的边沿，做起身吸附）。 */
  private lastMode: InteractState['mode'] = 'free';
  /**
   * 起身吸附要用的座位 id。
   *
   * 必须在 pressSit() 把 `state.seatId` 清空**之前**存下来，
   * 否则起身那一步找不到座位，人就原地站起来（然后立刻又被判定够得着，反复坐）。
   */
  private standFromSeatId: string | null = null;

  /** 累计按 E 的次数（验收脚本断言"按了 E 真的处理了"）。 */
  private sitToggleCount = 0;

  /** 最近一次 step 算出的提示（验收脚本读）。 */
  private lastPrompt: PlayerPrompt = { sit: 'none', canPush: false, mode: 'free' };

  constructor(opts: PlayerControllerOptions) {
    this.id = opts.id;
    this.world = opts.world;
    this.seats = opts.seats;
    this.readMove = opts.readMove;
    this.readPropPositions = opts.readPropPositions;
    this.onPrompt = opts.onPrompt;
    this.controller = opts.controller;
  }

  /** 物理就绪后补挂控制器（物理是异步初始化的）。 */
  attachController(c: CharacterController | null): void {
    this.controller = c;
  }

  get interactState(): Readonly<InteractState> {
    return this.state;
  }

  get focusState(): Readonly<FocusState> {
    return this.focus;
  }

  get prompt(): Readonly<PlayerPrompt> {
    return this.lastPrompt;
  }

  get toggles(): number {
    return this.sitToggleCount;
  }

  /** 当前是否坐着。 */
  get sitting(): boolean {
    return this.state.mode === 'sitting';
  }

  /** 当前坐的座位 id（没坐时 null）。 */
  get seatId(): string | null {
    return this.state.seatId;
  }

  /** 当前焦点实体（null = 跟随自己）。 */
  get focusTarget(): EntityId | null {
    return this.state.focusId;
  }

  /**
   * 按一次 E（坐/起切换）。由键盘事件或验收脚本调用。
   *
   * 返回本次动作，便于调用方打日志/断言。
   * **注意：这里只改状态，位移发生在下一个物理步**（见文件头"分两帧"）。
   */
  pressSit(): 'sit' | 'stand' | 'none' {
    const pos = this.positionOf();
    const result = toggleSit(this.state, this.seats, pos);
    this.sitToggleCount += 1;

    if (result.action === 'sit') {
      this.state = { ...this.state, mode: 'sitting', seatId: result.seat.id };
      this.standFromSeatId = null;
      return 'sit';
    }
    if (result.action === 'stand') {
      // 先把座位 id 存到 standFromSeatId，再清 state.seatId——
      // 顺序反了会导致 step() 里找不到座位、人原地站起来。
      this.standFromSeatId = result.from;
      this.state = { ...this.state, mode: 'free', seatId: null };
      return 'stand';
    }
    return 'none';
  }

  /** 点击某个角色 → 相机焦点切过去（null = 回自己）。 */
  setFocus(target: EntityId | null): void {
    if (this.state.focusId === target) return;
    this.state = { ...this.state, focusId: target, focusT: 0 };
    this.focus = focusOn(target);
    this.focusSettled = false;
  }

  /**
   * 推进焦点缓动（**渲染帧**调用，不是物理步）。
   *
   * 返回当前进度 0..1。`main.ts` 拿它算相机注视点，
   * 或者直接用 `camera.focusOn()` + `camera.update()`（后者自己缓动）。
   */
  tickFocus(dt: number): number {
    if (this.focusSettled) return 1;
    const t = advanceFocus(this.focus, dt);
    this.focus = { ...this.focus, t };
    this.state = { ...this.state, focusT: t };
    if (t >= 1) this.focusSettled = true;
    return t;
  }

  /**
   * 一个物理步。**顺序：先定输入，再交给控制器。**
   *
   * 这是整个 M10 接线里唯一"必须照抄"的地方：
   * ```
   * const input = this.buildInput();     // 坐着 → 方向位清零
   * this.controller.update(input, dt);   // 但**仍然**喂物理
   * this.syncWorld();                    // 物理结果 → 实体表
   * ```
   * 任何"坐着就 return 不调 update"的写法都会让角色失去贴地。
   */
  step(dt: number): void {
    const c = this.controller;
    if (!c) {
      // 物理没就绪：只跑状态机（验收脚本在无物理模式下也能断言状态切换）
      this.lastPrompt = this.computePrompt();
      this.onPrompt?.(this.lastPrompt);
      return;
    }

    // ── 坐下/起身的吸附（在物理步里做，不在事件里做）──
    if (this.state.mode === 'sitting') {
      const seat = this.seatOf(this.state.seatId);
      if (seat) {
        // 持续吸附：座位是静态的，但角色可能被别的角色/箱子撞偏。
        // 每步重设才能保证"坐着就一直坐在那"，而不是被撞一下滑走。
        const pose = sitPose(seat, CAPSULE_CENTER_HEIGHT);
        c.teleport(pose.p[0], pose.p[1], pose.p[2]);
      } else {
        // 座位被删了：自动起身，避免状态卡死（与 toggleSit 的语义一致）
        this.standFromSeatId = this.state.seatId;
        this.state = { ...this.state, mode: 'free', seatId: null };
      }
    } else if (this.lastMode === 'sitting' && this.standFromSeatId !== null) {
      // 刚从 sitting → free：吸附到座位前方。
      // 不原地起身，否则人还在座位 1.2m 内，按 E 会立刻又坐下。
      const seat = this.seatOf(this.standFromSeatId);
      if (seat) {
        const pose = standPose(seat, CAPSULE_CENTER_HEIGHT);
        c.teleport(pose.p[0], pose.p[1], pose.p[2]);
      }
      this.standFromSeatId = null;
    }
    this.lastMode = this.state.mode;

    // ── 输入：坐着时方向位清零，但仍然喂给控制器 ──
    const input = this.buildInput();
    c.update(input, dt);

    // ── 物理结果 → 实体表（唯一出口）──
    const sitting = this.state.mode === 'sitting';
    const seat = sitting ? this.seatOf(this.state.seatId) : null;
    c.writeTransform((t, anim) => {
      // 坐着时动画用 sit，朝向对齐座位；其余情况用控制器给的地面状态
      const transform = seat ? { p: t.p, r: yawQuat(seat.rot) } : t;
      this.world.updateActor(this.id, {
        transform,
        anim: sitting ? 'sit' : anim,
        animPhase: 0,
      });
    });

    this.lastPrompt = this.computePrompt();
    this.onPrompt?.(this.lastPrompt);
  }

  /**
   * 组装本步的控制输入。
   *
   * 关键：`movementAllowed() === false` 时只清方向位与 jump，
   * 但**永远返回一个合法的输入对象**——这样调用方没有任何理由去写
   * "坐着就跳过 update"（那是让角色失去贴地的经典错法）。
   *
   * 坐着的朝向不走这里：`update()` 的 faceX/faceZ 只在本步移动时才有意义，
   * 而坐姿朝向由 step() 里直接写 transform.r 决定（座位是静态的，不需要 slerp）。
   */
  private buildInput(): CharacterInput {
    if (!movementAllowed(this.state)) {
      return { dirX: 0, dirZ: 0, run: false, jump: false };
    }
    const raw = this.readMove();
    return { dirX: raw.dirX, dirZ: raw.dirZ, run: raw.run, jump: raw.jump };
  }

  /** 玩家脚底位置（交互判定用；实体表里的 y 是胶囊中心）。 */
  private positionOf(): readonly [number, number, number] {
    const a = this.world.getActor(this.id);
    if (!a) return [0, 0, 0];
    return [a.transform.p[0], a.transform.p[1] - CAPSULE_CENTER_HEIGHT, a.transform.p[2]];
  }

  private seatOf(id: string | null): RoomSeat | null {
    if (!id) return null;
    return this.seats.find((s) => s.id === id) ?? null;
  }

  private computePrompt(): PlayerPrompt {
    const pos = this.positionOf();
    const canSitNow = nearestSeat(this.seats, pos) !== null;
    const sit: PlayerPrompt['sit'] =
      this.state.mode === 'sitting' ? 'can_stand' : canSitNow ? 'can_sit' : 'none';

    // 推箱提示：用当前朝向判"面前有没有箱子"。纯提示，不产生推力。
    let pushable = false;
    if (this.readPropPositions) {
      const yaw = this.currentYaw();
      pushable = canPush(pos, yaw, this.readPropPositions());
    }

    return { sit, canPush: pushable, mode: this.state.mode };
  }

  /** 从实体表读当前朝向（yaw）。坐着时朝向是座位朝向。 */
  private currentYaw(): number {
    const a = this.world.getActor(this.id);
    if (!a) return 0;
    return quatToYaw(a.transform.r);
  }

  dispose(): void {
    this.controller = null;
    this.state = initialInteractState();
    this.standFromSeatId = null;
  }
}

/** yaw → 四元数（绕 Y，与 physics/character.ts 的朝向约定一致）。 */
export function yawQuat(yaw: number): [number, number, number, number] {
  const h = yaw * 0.5;
  return [0, Math.sin(h), 0, Math.cos(h)];
}

/** 四元数 → yaw（与 physics/character.ts 的 `yaw = atan2(fx, fz)` 约定一致）。 */
export function quatToYaw(q: readonly [number, number, number, number]): number {
  const [x, y, z, w] = q;
  // 绕 Y 的四元数只有 y/w 分量；通用公式取 yaw
  const siny = 2 * (w * y + x * z);
  const cosy = 1 - 2 * (y * y + x * x);
  return Math.atan2(siny, cosy);
}
