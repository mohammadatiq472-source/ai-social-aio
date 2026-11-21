/**
 * 交互的验收探针（仅 dev 构建）。
 *
 * 为什么需要它：M10 的验收必须"走近椅子按 E"。而"走近"这件事在浏览器脚本里
 * 很难可靠地做——WASD 的方向是**相对相机**的，脚本按 W 到底往世界哪个方向走，
 * 取决于当时的相机 yaw（初始 π，即朝 -z）。写死按键组合会在相机被拖动后失效。
 *
 * 所以这里提供三个**确定性**的辅助：
 * - `walkToNearestSeat(ms)`：每帧把"朝座位走"的方向喂给控制器，直到进入 1.2m
 * - `pushNearestProp(ms)`：每帧朝最近的箱子走，返回箱子位移
 * - `focusAgent(index)`：点击第 index 个 Agent（走真实的射线拾取路径）
 *
 * 三条纪律：
 * 1. **这些辅助不改物理**。它们只填 `readMove()` 的返回值，
 *    位移仍然由 `CharacterController.update()` + Rapier 算出来。
 *    任何"直接 teleport 到座位"的辅助都会让验收变成假的。
 * 2. **只在 dev 构建存在**。生产构建里 `import.meta.env.DEV` 是字面量 false，
 *    整个 `if` 块被 Rollup 摇掉，线上无法通过它探测内部结构。
 * 3. **如实报告数字**。`walkToNearestSeat` 返回真实距离，
 *    如果 4 秒内没走到就返回 `inReach: false`——不假装成功。
 */

import type * as THREE from 'three';
import type { EntityId } from '../core/types';
import type { RoomSeat } from '../core/room';
import type { World } from '../core/world';
import type { PlayerController } from './player';
import { nearestSeat, SIT_REACH } from './index';
import { CAPSULE_CENTER_HEIGHT } from './player';
import { pickAvatarAt } from './bind';

/** 探针依赖（全部由 main.ts 注入，探针自己不持有所有权）。 */
export interface InteractProbeDeps {
  world: World;
  player: PlayerController;
  seats: readonly RoomSeat[];
  /** 当前可推动道具的位置（每帧读，箱子在动）。 */
  readPropPositions: () => readonly (readonly [number, number, number])[];
  /** 让玩家在下一物理步朝某方向走（覆盖 readMove 的返回值）。 */
  setAutoMove: (move: { dirX: number; dirZ: number; run: boolean; jump: boolean } | null) => void;
  camera: THREE.Camera;
  scene: THREE.Scene;
  canvas: HTMLCanvasElement;
}

/** 探针对外暴露的读接口。 */
export interface InteractProbeApi {
  read(): Record<string, unknown>;
  walkToNearestSeat(timeoutMs?: number): Promise<Record<string, unknown>>;
  pushNearestProp(timeoutMs?: number): Promise<Record<string, unknown>>;
  focusAgent(index: number): Promise<Record<string, unknown>>;
}

/**
 * 安装探针。返回句柄（`main.ts` 挂到 `window.__interactDebug`）。
 *
 * 用 rAF 驱动"每帧设定方向"，而不是在物理步里做——这样它与真实的
 * 键盘输入走完全相同的路径（`readMove()` → `buildInput()` → `controller.update()`）。
 */
export function createInteractProbe(deps: InteractProbeDeps): InteractProbeApi {
  const { world, player, seats, readPropPositions, setAutoMove, camera, scene, canvas } = deps;

  /** 玩家脚底位置（实体表里 y 是胶囊中心）。 */
  const feetOf = (): [number, number, number] => {
    const a = world.getActor(player.id);
    if (!a) return [0, 0, 0];
    return [a.transform.p[0], a.transform.p[1] - CAPSULE_CENTER_HEIGHT, a.transform.p[2]];
  };

  /** 朝目标点走一帧（只给方向，位移由物理算）。 */
  const stepToward = (target: readonly [number, number, number], stopAt: number): number => {
    const pos = feetOf();
    const dx = target[0] - pos[0];
    const dz = target[2] - pos[2];
    const dist = Math.hypot(dx, dz);
    if (dist <= stopAt || dist < 1e-4) {
      setAutoMove(null);
      return dist;
    }
    // 归一化方向：斜着走不能更快（与 KeyboardInput.sample 同规则）
    setAutoMove({ dirX: dx / dist, dirZ: dz / dist, run: false, jump: false });
    return dist;
  };

  /** 等一帧（rAF）。 */
  const nextFrame = (): Promise<void> =>
    new Promise((resolve) => requestAnimationFrame(() => resolve()));

  return {
    read(): Record<string, unknown> {
      const pos = feetOf();
      const near = nearestSeat(seats, pos);
      const a = world.getActor(player.id);
      return {
        mode: player.sitting ? 'sitting' : 'free',
        seatId: player.seatId,
        seatPos: near ? [near.seat.pos[0], near.seat.pos[1], near.seat.pos[2]] : null,
        seatRot: near ? near.seat.rot : null,
        seatDist: near ? Math.round(near.dist * 1000) / 1000 : null,
        inReach: near !== null,
        heroPos: [pos[0], pos[1], pos[2]],
        // 实体表里的原始 y（胶囊中心），验收脚本用它交叉验证脚底换算
        heroCenterY: a ? a.transform.p[1] : null,
        anim: a?.anim ?? null,
        seats: seats.map((s) => ({ id: s.id, pos: s.pos, rot: s.rot })),
        props: readPropPositions().map((p) => [p[0], p[1], p[2]]),
        toggles: player.toggles,
        focusTarget: player.focusTarget,
        focusT: player.focusState.t,
        prompt: player.prompt,
        reach: SIT_REACH,
      };
    },

    async walkToNearestSeat(timeoutMs = 5000): Promise<Record<string, unknown>> {
      const start = performance.now();
      let dist = Infinity;

      // 先算一次目标：取最近的座位（哪怕当前够不着，也要知道往哪走）
      const pos0 = feetOf();
      let target: RoomSeat | null = null;
      let best = Infinity;
      for (const s of seats) {
        const d = Math.hypot(s.pos[0] - pos0[0], s.pos[2] - pos0[2]);
        if (d < best) {
          best = d;
          target = s;
        }
      }
      if (!target) {
        return { inReach: false, dist: null, reason: 'no_seats' };
      }

      // 走到 SIT_REACH 的 70% 处停下（留余量，避免卡在边界上反复）
      const stopAt = SIT_REACH * 0.7;
      while (performance.now() - start < timeoutMs) {
        dist = stepToward(target.pos, stopAt);
        if (dist <= stopAt) break;
        await nextFrame();
      }
      setAutoMove(null);
      await nextFrame();

      const final = feetOf();
      const realDist = Math.hypot(final[0] - target.pos[0], final[2] - target.pos[2]);
      return {
        inReach: nearestSeat(seats, final) !== null,
        dist: realDist,
        seatId: target.id,
        elapsedMs: Math.round(performance.now() - start),
      };
    },

    async pushNearestProp(timeoutMs = 6000): Promise<Record<string, unknown>> {
      const props0 = readPropPositions();
      if (props0.length === 0) {
        return { moved: 0, reason: 'no_props' };
      }

      // 选最近的箱子
      const pos0 = feetOf();
      let idx = 0;
      let best = Infinity;
      for (let i = 0; i < props0.length; i++) {
        const p = props0[i]!;
        const d = Math.hypot(p[0] - pos0[0], p[2] - pos0[2]);
        if (d < best) {
          best = d;
          idx = i;
        }
      }
      const target0 = props0[idx]!;
      const start = performance.now();

      // 一直朝箱子走（箱子会被推走，所以每帧重读它的当前位置 → 持续追着推）
      //
      // 停止距离要**小于**"角色半径 + 箱子半宽"才会真的接触：
      // 角色胶囊半径 0.30，箱子半宽 0.25 → 中心距约 0.55 时刚好接触。
      // 取 0.30 意味着"持续朝箱心推进"，角色会被箱子挡住（物理会解算），
      // 于是接触持续存在、推力持续施加。
      // 之前取 0.55 是错的：那是"刚好接触"的距离，走不到就被判"已到位"，
      // 实测箱子只被推动 0.20m（偶尔 0.45m），刚好卡在阈值上导致 flaky。
      while (performance.now() - start < timeoutMs) {
        const cur = readPropPositions()[idx];
        if (!cur) break;
        stepToward(cur, 0.30);
        await nextFrame();
      }
      setAutoMove(null);
      await nextFrame();

      const target1 = readPropPositions()[idx];
      const moved = target1
        ? Math.hypot(target1[0] - target0[0], target1[2] - target0[2])
        : 0;
      return { moved, elapsedMs: Math.round(performance.now() - start) };
    },

    async focusAgent(index: number): Promise<Record<string, unknown>> {
      // 走**真实的射线拾取路径**：把 Agent 的屏幕坐标算出来，再调 pickAvatarAt。
      // 不直接调 player.setFocus(id)：那会绕过 bind.ts 里"单击 vs 拖拽"的判定，
      // 验收就变成"我调了个方法"，而不是"点击真的能切焦点"。
      const avatars: EntityId[] = [];
      scene.traverse((o) => {
        if (o.name.startsWith('avatar:')) avatars.push(o.name.slice('avatar:'.length));
      });
      if (avatars.length === 0) {
        return { focused: false, reason: 'no_avatars' };
      }
      const id = avatars[Math.min(index, avatars.length - 1)]!;
      const root = scene.getObjectByName(`avatar:${id}`);
      if (!root) return { focused: false, reason: 'avatar_not_found' };

      // 把角色胸口投影到屏幕
      const v = root.position.clone();
      v.y += 1.0;
      v.project(camera);
      const rect = canvas.getBoundingClientRect();
      const clientX = rect.left + ((v.x + 1) / 2) * rect.width;
      const clientY = rect.top + ((1 - v.y) / 2) * rect.height;

      const hit = pickAvatarAt(camera, scene, clientX, clientY, rect);
      const pickedId = hit?.id ?? null;

      // 用拾取结果设焦点（与 bind.ts 的 onPointerUp 走同一条路）
      player.setFocus(pickedId);

      // 等焦点缓动走完（1s）+ 余量
      const start = performance.now();
      let progress = player.focusState.t;
      while (progress < 1 && performance.now() - start < 3000) {
        await nextFrame();
        progress = player.focusState.t;
      }

      return {
        focused: player.focusTarget === id,
        target: player.focusTarget,
        picked: pickedId,
        expected: id,
        progress,
        elapsedMs: Math.round(performance.now() - start),
      };
    },
  };
}
