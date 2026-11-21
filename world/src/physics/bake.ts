/**
 * 房间静态几何 → 碰撞体烘焙（spec §6 M3 第 5 条）。
 *
 * 为什么"烘焙"：静态几何只在进房时建一次，之后物理步里零分配。
 * 运行时反复 createCollider 是帧率杀手，而且每建一次都要重算 AABB 与宽相位条目。
 *
 * 两个刻意的实现选择：
 *
 * 1. **所有静态几何挂在一个 fixed 刚体上**，而不是每块几何一个刚体。
 *    Rapier 里 fixed 刚体永不移动，多挂一个刚体只是多一份积分器记账；
 *    挂同一个刚体后，碰撞体之间用 local 偏移区分，宽相位照样正确。
 *
 * 2. **只建 cuboid，不建 trimesh**。
 *    房间格式里的 box/ramp/stairs 全部是盒子（台阶在 room.ts 里已展开成实心盒），
 *    cuboid 的窄相位是解析解，比 trimesh 快一个量级，且没有薄墙穿透问题。
 *    trimesh 留给将来的任意网格房间：`bakeTrimesh` 已经接好，只是当前格式用不到。
 *
 * RAPIER 用参数注入而不是 `import * as RAPIER`：
 * - 让本文件能在 node 单测里直接跑（WASM 已 init 的真实引擎）；
 * - 避免 core/ 与 physics/ 之间出现循环 import。
 */

import type RAPIER_NS from '@dimforge/rapier3d-compat';
import type { Room, RoomSolid, Vec3 } from '../core/room';
import { roomSolids } from '../core/room';
import { LAYERS, interactionGroups } from './layers';

/** 注入的 Rapier 命名空间（已 init）。 */
export type Rapier = typeof RAPIER_NS;

/** 一个已烘焙的碰撞体句柄。dispose 时按它回收。 */
export interface BakedCollider {
  /** 来源在 room.static 里的下标。 */
  sourceIndex: number;
  sourceType: RoomSolid['sourceType'];
  /** 世界空间中心。 */
  pos: Vec3;
  /** 半尺寸（cuboid 用；trimesh 为 0）。 */
  halfExtents: Vec3;
  /** 旋转四元数 [x,y,z,w]。 */
  rot: [number, number, number, number];
  collider: RAPIER_NS.Collider;
}

export interface BakeStats {
  /** 建出来的碰撞体数量（台阶会展开成多个）。 */
  colliders: number;
  /** 烘焙耗时（毫秒），进 __worldDebug。 */
  ms: number;
  /** 创建过程中抛错的几何下标（正常为空）。 */
  failed: number[];
}

export interface BakedRoom {
  /** 承载全部静态碰撞体的那个 fixed 刚体。 */
  body: RAPIER_NS.RigidBody | null;
  colliders: BakedCollider[];
  stats: BakeStats;
  /** 拆掉全部碰撞体与那个 fixed 刚体。重复调用安全。 */
  dispose(): void;
}

/** 静态几何的摩擦/弹性：地面要"抓得住"，但不要粘住（否则贴墙走会卡）。 */
const STATIC_FRICTION = 0.85;
const STATIC_RESTITUTION = 0.0;

/**
 * 把房间烘焙进给定物理世界。
 *
 * 一次性、同步、可测：不读时钟、不读随机数，同样的房间永远得到同样的碰撞体。
 */
export function bakeRoom(RAPIER: Rapier, world: RAPIER_NS.World, room: Room): BakedRoom {
  const t0 = now();
  const solids = roomSolids(room);
  const colliders: BakedCollider[] = [];
  const failed: number[] = [];

  // 全部静态几何挂同一个 fixed 刚体。放在原点：碰撞体用 local 偏移定位。
  let body: RAPIER_NS.RigidBody | null = null;
  if (solids.length > 0) {
    body = world.createRigidBody(RAPIER.RigidBodyDesc.fixed().setTranslation(0, 0, 0));
  }

  const groups = interactionGroups('WORLD_STATIC');

  for (const solid of solids) {
    try {
      const desc = RAPIER.ColliderDesc.cuboid(
        solid.halfExtents[0],
        solid.halfExtents[1],
        solid.halfExtents[2],
      )
        // 碰撞体局部变换：中心 + 旋转都写在 local 上，刚体本身留在原点
        .setTranslation(solid.pos[0], solid.pos[1], solid.pos[2])
        .setRotation({
          x: solid.rot[0],
          y: solid.rot[1],
          z: solid.rot[2],
          w: solid.rot[3],
        })
        .setCollisionGroups(groups)
        .setFriction(STATIC_FRICTION)
        .setRestitution(STATIC_RESTITUTION);

      const collider = body
        ? world.createCollider(desc, body)
        : world.createCollider(desc);

      colliders.push({
        sourceIndex: solid.sourceIndex,
        sourceType: solid.sourceType,
        pos: solid.pos,
        halfExtents: solid.halfExtents,
        rot: solid.rot,
        collider,
      });
    } catch (err) {
      // 单块几何建不出来不该让整个房间失败：记下来，让上层显示"这面墙没烘焙成功"
      failed.push(solid.sourceIndex);
      console.error('[bake] 碰撞体创建失败', {
        sourceIndex: solid.sourceIndex,
        sourceType: solid.sourceType,
        halfExtents: solid.halfExtents,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  let disposed = false;
  const baked: BakedRoom = {
    body,
    colliders,
    stats: {
      colliders: colliders.length,
      ms: now() - t0,
      failed,
    },
    dispose() {
      if (disposed) return;
      disposed = true;
      // 删刚体会连带删掉挂在它上面的所有碰撞体，所以有 body 时不必逐个 removeCollider。
      if (body) {
        world.removeRigidBody(body);
        body = null;
      } else {
        for (const c of colliders) world.removeCollider(c.collider, false);
      }
      colliders.length = 0;
    },
  };

  return baked;
}

/**
 * 任意三角网格 → trimesh 碰撞体（当前房间格式用不到，留给 v0.3 的场景摆放）。
 * 顶点/索引必须是 world 空间，且索引是三的倍数。
 */
export function bakeTrimesh(
  RAPIER: Rapier,
  world: RAPIER_NS.World,
  vertices: Float32Array,
  indices: Uint32Array,
): RAPIER_NS.Collider {
  if (indices.length % 3 !== 0) {
    throw new RangeError(`bakeTrimesh: 索引数量必须是 3 的倍数，收到 ${indices.length}`);
  }
  if (vertices.length % 3 !== 0) {
    throw new RangeError(`bakeTrimesh: 顶点数量必须是 3 的倍数，收到 ${vertices.length}`);
  }
  const desc = RAPIER.ColliderDesc.trimesh(vertices, indices)
    .setCollisionGroups(interactionGroups('WORLD_STATIC'))
    .setFriction(STATIC_FRICTION)
    .setRestitution(STATIC_RESTITUTION);
  return world.createCollider(desc);
}

/** 层号（调试用：确认烘焙出来的碰撞体确实在 WORLD_STATIC 层）。 */
export const BAKED_MEMBERSHIP = LAYERS.WORLD_STATIC;

/** `performance.now()` 在浏览器与 node 都有；兜底 Date.now 只为极老的运行环境。 */
function now(): number {
  return typeof performance !== 'undefined' ? performance.now() : Date.now();
}
