/**
 * 把 harness 的临时驱动换成 M4 的正式封装（CharacterController）。
 *
 * 为什么单独一个文件：`harness.ts` 是判定逻辑的单一来源，P1–P12 的用例体不该被
 * "用哪个驱动"这件事污染。这里做一个适配层，`harness.ts` 只依赖这层暴露的
 * 三个动作：`makeDriver` / `driveStep` / 读状态。M4 落地前后只换这一层的实现。
 *
 * 重要：`DRIVER_TAG` 必须如实反映"现在用的是哪个驱动"。
 * lead 明确要求不得用简化驱动冒充 M4 通过。
 */

import RAPIER from '@dimforge/rapier3d-compat';
import { PHYSICS_DT } from '../core/types';
import type { PhysicsWorld } from '../physics/engine';
import {
  CharacterController,
  DEFAULT_CHARACTER,
  GRAVITY_Y,
  jumpLaunchVelocity,
  type CharacterConfig,
} from '../physics/character';

/** 驱动标识：写进 `detail.driver`，让外面一眼看出测的是哪套实现。 */
export const DRIVER_TAG = 'm4-character-controller';

/** 驱动句柄。P1–P10 的用例只通过这层操作角色。 */
export interface Driver {
  controller: CharacterController;
  /** 目标水平速度（m/s），由用例设置。 */
  vx: number;
  vz: number;
  /**
   * 速度缩放 0..1（可选）。用例要做"精确抵达某个点"时用：
   * 控制器本身只有 walk/run 两档，靠它才能表达"减速靠近"。
   */
  speedScale: number;
  /** 请求起跳的边沿标志。用例置 1 表示"下一帧起跳"，驱动消费后清 0。 */
  jump: number;
  /** 上一帧是否贴地（用例读）。 */
  grounded: boolean;
}

/** 胶囊中心到脚底的距离。 */
export const CAPSULE_HALF_TOTAL = DEFAULT_CHARACTER.halfHeight + DEFAULT_CHARACTER.radius;

/** 重力加速度（与 PhysicsWorld.GRAVITY 一致）。 */
export const G = Math.abs(GRAVITY_Y);

export function makeDriver(
  pw: PhysicsWorld,
  x: number,
  y: number,
  z: number,
  cfg: CharacterConfig = DEFAULT_CHARACTER,
): Driver {
  const controller = new CharacterController(RAPIER, pw, x, y, z, cfg);
  return { controller, vx: 0, vz: 0, speedScale: 1, jump: 0, grounded: false };
}

/**
 * 推进一步。
 *
 * 用例设置的是"目标速度"（vx/vz，可叠加 speedScale 缩放）与"是否起跳"（jump 边沿），
 * 这里翻译成 CharacterInput 交给 M4 控制器：
 * - 方向 = 归一化后的 (vx, vz)
 * - run = 目标速度是否超过 walkSpeed
 * - speedScale = 用例显式设的缩放（精确抵达用）
 * - jump = 边沿触发，消费后清 0
 *
 * 注意：控制器内部有加速度限制（地面 40 m/s²），所以角色不会立刻达到目标速度。
 * 这是 spec §6 M4 第 4 条要求的（"用加速度限制逼近，不要直接设线速度"）。
 */
export function driveStep(pw: PhysicsWorld, d: Driver): void {
  const speed = Math.hypot(d.vx, d.vz);
  const dirX = speed > 1e-6 ? d.vx / speed : 0;
  const dirZ = speed > 1e-6 ? d.vz / speed : 0;

  const jump = d.jump > 0;
  if (jump) d.jump = 0;

  d.controller.update(
    {
      dirX,
      dirZ,
      run: speed > DEFAULT_CHARACTER.walkSpeed + 1e-6,
      speedScale: d.speedScale,
      jump,
      faceX: dirX,
      faceZ: dirZ,
    },
    PHYSICS_DT,
  );

  d.grounded = d.controller.snapshot().grounded;
  void pw;
}

/** 读当前位置。 */
export function driverPos(d: Driver): { x: number; y: number; z: number } {
  const p = d.controller.snapshot().pos;
  return { x: p[0], y: p[1], z: p[2] };
}

/** 直接瞬移（用例摆位用）。 */
export function driverTeleport(d: Driver, x: number, y: number, z: number): void {
  d.controller.teleport(x, y, z);
}

/** 起跳速度（含半步修正），用例要断言 P6 时用。 */
export { jumpLaunchVelocity };
