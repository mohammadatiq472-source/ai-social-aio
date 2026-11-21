/**
 * 演示房间定义（数据，不是代码）。
 *
 * 形状直接用 `core/room.ts` 的 `Room`（M6 的权威格式，归 physics-agent 维护）：
 * 渲染侧和物理侧读**同一份**房间数据，避免"物理里有地板、画面里没有"这类分叉。
 *
 * ═══════════════ 两份房间数据的分工（别再造第三份） ═══════════════
 *
 * - `rooms/demo-room.json` = **物理验收**用的房间（P1–P12 跑它，被 `room.test.ts` 逐字段锁住）。
 *   它有 10×10 地板 / 两面墙 / 斜坡 / 5 级台阶。它的地板只有 10m 见方，
 *   容不下 6 个 Agent 的 4m 环 + 1.6m 巡逻半径（最远 5.6m），所以**不能**拿它当页面房间。
 * - `rooms/demo-room.ts`   = **页面**用的房间（这一份，`main.ts` 同时喂给渲染与 `PhysicsWorld`）。
 *
 * 两者都是 `Room` 类型、都走 `roomSolids()` 派生网格与碰撞体，
 * 所以"同一份数据既生成网格也生成碰撞体"这条不变量在**每一份**上成立，
 * 不需要（也不允许）为渲染再造一份几何定义。
 *
 * ═══════════════ 为什么这一轮加了墙 ═══════════════
 *
 * v0.1 早期刻意只有一块 24×24 地面 + 两把椅子 + 两个箱子，几何量压到最低是为了
 * 让 M1 的「1080p 空场景 60fps」不被场景本身拖累。代价是观感：
 * 画面里只有一块纯色平板和网格线，人看起来"漂浮在虚空里"（用户原话：再优化一下这个场景）。
 *
 * 现在加四面 3m 高的墙 + 踢脚线 + 一组台阶，把"房间"这件事在画面上立起来。
 * 加的都是**静态盒体**，走的是同一条 `roomSolids()` 派生路径，
 * 所以渲染看到的墙和撞得到的墙必然是同一面（不是两套几何）。
 *
 * 尺寸取舍：
 * - 地板 20×20：6 个 Agent 的环半径 4m + 巡逻 1.6m 最远到 5.6m，留足余量；
 *   同时保证 `tools/verify-locomotion-live.mjs` 从原点朝 +z 走 1s + 跑 1s
 *   （≈6.8m）不会撞到墙。
 * - 墙高 3.0m：默认镜头在 4.2m 距离、俯角 0.32rad，墙顶刚好不出画，围合感成立。
 * - 台阶放在左后侧（x≈-7.5）：避开原点朝 +z 的行走走廊，也避开两把椅子（±1.9m）。
 */

import type { Room } from '../src/core/room';

/** 地板半边长（米）。地板是 20×20。 */
export const ROOM_HALF = 10;

/** 墙高（米）。 */
export const WALL_HEIGHT = 3;

/** 墙厚（米）。 */
export const WALL_THICKNESS = 0.2;

/** 踢脚线高度（米）与厚度（米）。 */
export const TRIM_HEIGHT = 0.12;
export const TRIM_DEPTH = 0.06;

export const DEMO_ROOM: Room = {
  name: 'demo-room',
  // 出生点：原点。相机初始站在角色背后，所以人朝 -z（yaw 0 的默认朝向由控制器决定）
  spawn: [[0, 0, 0]],
  lights: [
    {
      type: 'hemi',
      color: '#dfeaff',
      intensity: 0.55,
    },
    {
      type: 'dir',
      // 从右上前方打下来，让地面与角色的阴影方向可读
      dir: [-0.45, -0.78, -0.44],
      color: '#fff2e0',
      intensity: 1.9,
      shadows: true,
    },
  ],
  static: [
    {
      type: 'box',
      // 地面：中心在 y=-0.1，半高 0.1 → 顶面正好 y=0
      pos: [0, -0.1, 0],
      size: [ROOM_HALF * 2, 0.2, ROOM_HALF * 2],
      mat: 'floor',
    },

    // ── 四面墙 ──
    // 尺寸是**全尺寸**（不是半尺寸），中心点因此要抬到 WALL_HEIGHT/2。
    // 渲染侧把这些墙当"从房间内部看的壳"（BackSide）：站在屋里看得见，
    // 镜头退到屋外就自动隐去，不需要相机做穿墙射线（camera.ts 不改）。
    {
      type: 'box',
      pos: [0, WALL_HEIGHT / 2, -ROOM_HALF],
      size: [ROOM_HALF * 2, WALL_HEIGHT, WALL_THICKNESS],
      mat: 'wall',
    },
    {
      type: 'box',
      pos: [0, WALL_HEIGHT / 2, ROOM_HALF],
      size: [ROOM_HALF * 2, WALL_HEIGHT, WALL_THICKNESS],
      mat: 'wall',
    },
    {
      type: 'box',
      pos: [-ROOM_HALF, WALL_HEIGHT / 2, 0],
      size: [WALL_THICKNESS, WALL_HEIGHT, ROOM_HALF * 2],
      mat: 'wall',
    },
    {
      type: 'box',
      pos: [ROOM_HALF, WALL_HEIGHT / 2, 0],
      size: [WALL_THICKNESS, WALL_HEIGHT, ROOM_HALF * 2],
      mat: 'wall',
    },

    // ── 踢脚线 ──
    // 贴墙内侧（内表面在 ±(ROOM_HALF - WALL_THICKNESS/2) = ±9.9），
    // 向外凸出 TRIM_DEPTH/2，让墙脚有一条深色分界。
    // 这条线是"房间感"性价比最高的一笔：只花 4 个盒体，但把墙与地板的交界讲清楚了。
    {
      type: 'box',
      pos: [0, TRIM_HEIGHT / 2, -(ROOM_HALF - WALL_THICKNESS / 2) + TRIM_DEPTH / 2],
      size: [ROOM_HALF * 2 - WALL_THICKNESS, TRIM_HEIGHT, TRIM_DEPTH],
      mat: 'trim',
    },
    {
      type: 'box',
      pos: [0, TRIM_HEIGHT / 2, ROOM_HALF - WALL_THICKNESS / 2 - TRIM_DEPTH / 2],
      size: [ROOM_HALF * 2 - WALL_THICKNESS, TRIM_HEIGHT, TRIM_DEPTH],
      mat: 'trim',
    },
    {
      type: 'box',
      pos: [-(ROOM_HALF - WALL_THICKNESS / 2) + TRIM_DEPTH / 2, TRIM_HEIGHT / 2, 0],
      size: [TRIM_DEPTH, TRIM_HEIGHT, ROOM_HALF * 2 - WALL_THICKNESS],
      mat: 'trim',
    },
    {
      type: 'box',
      pos: [ROOM_HALF - WALL_THICKNESS / 2 - TRIM_DEPTH / 2, TRIM_HEIGHT / 2, 0],
      size: [TRIM_DEPTH, TRIM_HEIGHT, ROOM_HALF * 2 - WALL_THICKNESS],
      mat: 'trim',
    },

    // ── 台阶 + 平台 ──
    // 台阶沿 +z 展开（`roomSolids()` 的约定：第 i 级中心 z = pos.z + run·(i+0.5)），
    // 5 级 × rise 0.16 = 顶面 0.8m。后面的平台顶面也是 0.8m，两级接得上。
    // 位置刻意放左后侧：默认镜头在 -z 侧朝 +z 看，这一组在画面左侧、
    // 既进得了画面，又不在原点朝 +z 的行走走廊上。
    {
      type: 'stairs',
      steps: 5,
      rise: 0.16,
      run: 0.32,
      width: 1.6,
      pos: [-7.5, 0, 4],
      mat: 'stair',
    },
    {
      type: 'box',
      // 平台：顶面 0.8m（与台阶最高级齐平），z 从 5.6 接在台阶后面
      pos: [-7.5, 0.4, 6.4],
      size: [1.6, 0.8, 1.6],
      mat: 'stair',
    },
  ],
  props: [
    {
      type: 'box',
      // 正前方 1.8m：走两步就能推。y=0.25 是半边长，箱子底面正好贴地。
      size: [0.5, 0.5, 0.5],
      pos: [0, 0.25, -1.8],
      mass: 10,
      mat: 'crate',
    },
    {
      type: 'box',
      // 第二个箱子错开一点，推的时候能看到两个箱子互相影响（物理是真的）
      size: [0.5, 0.5, 0.5],
      pos: [0.62, 0.25, -1.8],
      mass: 10,
      mat: 'crate',
    },
  ],
  seats: [
    // 两把椅子放在原点两侧 1.9m 处：出生点够不着（>1.2m），必须走过去。
    // 朝向都朝向原点，坐下后面朝场地中心，观感自然。
    { id: 's1', pos: [1.9, 0, 0], rot: -Math.PI / 2 },
    { id: 's2', pos: [-1.9, 0, 0], rot: Math.PI / 2 },
  ],
};

export default DEMO_ROOM;
