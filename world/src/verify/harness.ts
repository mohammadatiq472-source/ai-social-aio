/**
 * 物理验收套件 P1–P12 的页面内实现（spec §7 / docs/world/verify-contract.md）。
 *
 * 分工：**判定逻辑在这里**（物理最清楚什么叫"跳了 1.20m"），
 * Playwright 驱动与报告格式归 qa-agent 的 `tools/verify-physics.mjs`。
 * 契约冻结在 `docs/world/verify-contract.md`，字段名不许改。
 *
 * 三条纪律（来自契约 §2）：
 * 1. 每条用例**自建隔离世界**、跑完 dispose，不共享刚体。
 * 2. 用例内部禁止 `Math.random()`（spec §2.2 确定性纪律）。
 * 3. 单条抛异常 → `pass:false` + `error`，绝不让整个报告停在 running。
 *
 * 角色驱动来自 `./driver`，它封装的是 **M4 的正式 CharacterController**
 * （`src/physics/character.ts`）。`detail.driver` 如实标成 `m4-character-controller`，
 * 不再用简化驱动冒充 M4 通过。
 */

import RAPIER from '@dimforge/rapier3d-compat';
import { parseRoom, type Room } from '../core/room';
import { PhysicsWorld } from '../physics/engine';
import { DEFAULT_CHARACTER } from '../physics/character';
import {
  CAPSULE_HALF_TOTAL,
  DRIVER_TAG,
  driveStep,
  driverPos,
  jumpLaunchVelocity,
  makeDriver,
  type Driver,
} from './driver';

// ───────────────────────────── 契约类型（不要改字段名） ─────────────────────────────

export interface VerifyCaseResult {
  id: string;
  title: string;
  pass: boolean;
  measured: string;
  detail: Record<string, number | string | boolean>;
  error?: string;
}

export interface VerifyReport {
  status: 'running' | 'done' | 'crashed';
  startedAt: number;
  finishedAt?: number;
  total: number;
  passed: number;
  cases: VerifyCaseResult[];
  env: {
    ua: string;
    hardwareConcurrency: number;
    renderer: string;
    rapierVersion: string;
  };
}

declare global {
  interface Window {
    __verify?: VerifyReport;
  }
}

/** 用例总数：契约要求必须是 12，少跑一条算失败。 */
export const VERIFY_TOTAL = 12;

// ───────────────────────────── 房间构造工具 ─────────────────────────────

/** 一块地板 + 任意附加静态几何。所有用例都从这里起步。 */
function roomWith(statics: Room['static'], props: Room['props'] = []): Room {
  return parseRoom({
    name: 'verify',
    spawn: [[0, 1, 0]],
    lights: [],
    static: statics,
    props,
    seats: [],
  });
}

function floorOnly(size = 40): Room {
  return roomWith([{ type: 'box', size: [size, 0.2, size], pos: [0, -0.1, 0] }]);
}

/** 斜坡房间的公共几何参数。rampRoom 与 rampSurfaceY 必须共用，否则会算错落点。 */
const RAMP_LENGTH = 8;
const RAMP_THICKNESS = 0.2;

/**
 * 斜坡房间：给定倾角（度），生成一个从地面起坡的斜面。
 *
 * 用"绕 x 轴旋转的长盒"而不是 trimesh：cuboid 的窄相位是解析解，
 * 而且它天然有厚度（不会像零厚度平面那样让角色在边缘抖）。
 *
 * 朝向必须实测确认，不能靠推：绕 x 轴转 -rad 时，**+z 是上坡**。
 * （第一版把 -z 当上坡，P2/P3 立刻红了——数值上表现为"上行"是负的。）
 */
function rampRoom(angleDeg: number): Room {
  const rad = (angleDeg * Math.PI) / 180;
  const midY = Math.sin(rad) * (RAMP_LENGTH / 2) + RAMP_THICKNESS;
  return roomWith([
    { type: 'box', size: [40, 0.2, 40], pos: [0, -0.1, 0] },
    {
      type: 'ramp',
      size: [3, RAMP_THICKNESS, RAMP_LENGTH],
      pos: [0, midY, 0],
      rot: [-rad, 0, 0],
    },
  ]);
}

/**
 * 斜坡在某个 z 处的**上表面**高度（与 rampRoom 的几何严格一致）。
 *
 * 推导（盒子绕 x 轴转 -rad，中心 (0, midY, 0)，半尺寸 (1.5, th/2, len/2)）：
 * 上表面取局部点 (0, +th/2, zl)，绕 x 转 -rad 后
 *   y_world = midY + (th/2)*cos(rad) + zl*sin(rad)
 *   z_world = -(th/2)*sin(rad) + zl*cos(rad)
 * 由 z_world = z 反解 zl，代回即得上表面高度。
 *
 * 实测验证：z=-2.5/-2/-1/0/1/2 对应 0.670/1.170/2.170/3.170/4.170/5.170，
 * 与 Rapier 射线打出来的坡面高度逐位一致。
 * 用"中心面"（少掉半厚度的竖直投影）会把角色放到坡面内部，
 * 表现为"settled y 高 0.41m、悬空不滑"。
 */
function rampSurfaceY(angleDeg: number, z: number): number {
  const rad = (angleDeg * Math.PI) / 180;
  const midY = Math.sin(rad) * (RAMP_LENGTH / 2) + RAMP_THICKNESS;
  const zl = (z + (RAMP_THICKNESS / 2) * Math.sin(rad)) / Math.cos(rad);
  return midY + (RAMP_THICKNESS / 2) * Math.cos(rad) + zl * Math.sin(rad);
}

/** 台阶房间：给定每级高度。 */
function stairsRoom(rise: number): Room {
  return roomWith([
    { type: 'box', size: [40, 0.2, 40], pos: [0, -0.1, 0] },
    { type: 'stairs', steps: 5, rise, run: 0.35, width: 2, pos: [0, 0, 0] },
  ]);
}

/** 跑 N 步。 */
function runSteps(pw: PhysicsWorld, n: number, each?: (i: number) => void): void {
  for (let i = 0; i < n; i++) {
    each?.(i);
    pw.step();
  }
}

function round(v: number, digits = 4): number {
  const f = Math.pow(10, digits);
  return Math.round(v * f) / f;
}

// ───────────────────────────── 用例实现 ─────────────────────────────

type CaseFn = () => Promise<VerifyCaseResult>;

/**
 * P1 平地走 5m：最终位置与目标点的水平距离 ≤0.01。
 *
 * 因为 M4 的控制器有**加速度限制**（spec §6 M4 第 4 条：地面 40 m/s²），
 * 角色不能瞬间达到 2.2 m/s，也不能瞬间停下。最短刹停距离是
 * v²/(2a) = 2.2²/(2×40) = 6.05cm，比 1cm 的容差还大——
 * 所以"全速走过去"必然过冲（实测在目标点附近以 34 步为周期反复穿越，
 * 误差在 0.3cm~7.7cm 之间来回跳，永远收敛不了）。
 *
 * 正确做法是**带减速的抵达**：`目标速度 = min(walk, sqrt(2·a·剩余距离))`，
 * 靠 CharacterInput.speedScale 把这个模拟量喂给控制器。
 * 这不是为测试发明的——它就是"角色走到某个点"应有的行为，
 * 也顺带证明了加速度限制确实在起作用（直接设速度的实现不会过冲）。
 */
const P1: CaseFn = async () => {
  const pw = await PhysicsWorld.create(RAPIER, floorOnly(), { propPoolSize: 4 });
  try {
    const d = makeDriver(pw, 0, CAPSULE_HALF_TOTAL + 0.05, 0);
    runSteps(pw, 30, () => driveStep(pw, d)); // 落地稳定

    const start = driverPos(d);
    const targetZ = start.z - 5; // 沿 -z 走 5m
    const accel = DEFAULT_CHARACTER.accelGround;
    const walk = DEFAULT_CHARACTER.walkSpeed;
    let steps = 0;
    const maxSteps = 600;

    while (steps < maxSteps) {
      const p = driverPos(d);
      const remaining = targetZ - p.z;
      const dist = Math.abs(remaining);
      if (dist < 0.0005) break;

      // 带减速的抵达：速度上限随剩余距离平方根收敛
      const arriveSpeed = Math.min(walk, Math.sqrt(2 * accel * dist));
      d.vx = 0;
      d.vz = remaining < 0 ? -arriveSpeed : arriveSpeed;
      // 控制器只有 walk/run 两档，用 speedScale 表达"慢下来"
      d.speedScale = walk > 0 ? Math.min(1, arriveSpeed / walk) : 0;

      driveStep(pw, d);
      pw.step();
      steps += 1;
    }

    const end = driverPos(d);
    const error = Math.hypot(end.x - start.x, end.z - targetZ);
    const pass = error <= 0.01;
    return {
      id: 'P1',
      title: '平地走 5m',
      pass,
      measured: `终点距目标 ${(error * 100).toFixed(2)}cm，走了 ${Math.abs(end.z - start.z).toFixed(3)}m，${steps} 步`,
      detail: {
        error: round(error),
        walked: round(Math.abs(end.z - start.z)),
        tolerance: 0.01,
        steps,
        driver: DRIVER_TAG,
      },
    };
  } finally {
    pw.dispose();
  }
};

/** P2 30° 斜坡：站立 2s 后 y 漂移 ≤0.01，且能上行 ≥1m。 */
const P2: CaseFn = async () => {
  const pw = await PhysicsWorld.create(RAPIER, rampRoom(30), { propPoolSize: 4 });
  try {
    // 从坡的低端起步，否则还没爬到 1m 就冲出了坡顶（坡长只有 8m）
    const startZ = -2.5;
    const surfaceY = rampSurfaceY(30, startZ);
    const d = makeDriver(pw, 0, surfaceY + CAPSULE_HALF_TOTAL + 0.05, startZ);
    runSteps(pw, 60, () => driveStep(pw, d));
    const settled = driverPos(d);

    runSteps(pw, 120, () => driveStep(pw, d));
    const afterStand = driverPos(d);
    const drift = Math.abs(afterStand.y - settled.y);

    // +z 是上坡（实测确认）
    d.vz = 1.5;
    runSteps(pw, 150, () => driveStep(pw, d));
    const climbed = driverPos(d);
    const rise = climbed.y - afterStand.y;
    const pass = drift <= 0.01 && rise >= 1.0;
    return {
      id: 'P2',
      title: '30° 斜坡站立/上行',
      pass,
      measured: `站立 y 漂移 ${(drift * 100).toFixed(2)}cm，上行 ${rise.toFixed(3)}m`,
      detail: { drift: round(drift), rise: round(rise), driver: DRIVER_TAG },
    };
  } finally {
    pw.dispose();
  }
};

/**
 * P3 45° 斜坡：上行位移 <0.3m 且确实下滑。
 *
 * 这里曾暴露 spec 自身的一处矛盾，lead 已裁决（docs/world/决策-斜坡角与P3冲突.md）：
 * spec §6 M4 原文的 maxSlopeClimbAngle 是 50°，而 §7 的 P3 要求 45° 不可上 ——
 * 50 > 45，按原文参数 45° 坡必然可爬（实测 climb=2.000m），P3 永远红。
 *
 * **裁决：改旋钮，不改口径。** maxSlopeClimbAngle 50 -> 40°。
 * P3 保留原口径：45° 不可上。minSlopeSlideAngle 仍为 30°，所以"能下滑"照旧成立。
 */
const P3: CaseFn = async () => {
  const pw = await PhysicsWorld.create(RAPIER, rampRoom(45), { propPoolSize: 4 });
  try {
    // 起点必须落在**坡面中段偏上**，不能靠近坡底。
    // 实测：从 z=-2.5（离坡底只有 0.4m）起步时，角色一落地就顺着坡滑出坡面、
    // 站到坡脚的平地上（坡角读成 0），此后既不上也不滑，P3 永远是 0。
    const startZ = 2.0;
    const surfaceY = rampSurfaceY(45, startZ);
    const d = makeDriver(pw, 0, surfaceY + CAPSULE_HALF_TOTAL + 0.05, startZ);
    runSteps(pw, 60, () => driveStep(pw, d));

    // ── 量下滑：不输入，看它自己沿坡掉多少 ──
    // 这段必须**先于**上行测试：45° 坡上角色一落地就开始滑，
    // 先推它上行会把下滑空间吃掉（实测先推 30 步后角色已滑到坡底，slid=0.000）。
    const beforeSlide = driverPos(d);
    runSteps(pw, 60, () => driveStep(pw, d));
    const afterSlide = driverPos(d);
    const slidY = beforeSlide.y - afterSlide.y;
    const slidZ = Math.abs(afterSlide.z - beforeSlide.z);
    const slid = Math.max(slidY, slidZ);

    // ── 量上行：从滑下来的位置往 +z 推，看能不能爬上去 ──
    const beforeClimb = driverPos(d);
    d.vz = 2.0;
    runSteps(pw, 60, () => driveStep(pw, d));
    const afterClimb = driverPos(d);
    // 只看 y 的正向增量；被挡住后继续下滑导致的 y 变小不计入"爬升"
    const climb = Math.max(0, afterClimb.y - beforeClimb.y);

    const pass = climb < 0.3 && slid > 0.02;
    return {
      id: 'P3',
      title: '45° 斜坡',
      pass,
      measured: `上行 ${climb.toFixed(3)}m（需 <0.30），下滑 ${slid.toFixed(3)}m（需 >0.02）`,
      detail: {
        climb: round(climb),
        slid: round(slid),
        slidY: round(slidY),
        slidZ: round(slidZ),
        maxSlopeClimbAngleDeg: 40,
        minSlopeSlideAngleDeg: 30,
        driver: DRIVER_TAG,
      },
    };
  } finally {
    pw.dispose();
  }
};

/** P4 台阶 0.30m：能自动上（最终 y ≥0.28）。 */
const P4: CaseFn = async () => {
  const pw = await PhysicsWorld.create(RAPIER, stairsRoom(0.3), { propPoolSize: 4 });
  try {
    const d = makeDriver(pw, 0, CAPSULE_HALF_TOTAL + 0.05, -1.2);
    runSteps(pw, 40, () => driveStep(pw, d));
    const start = driverPos(d);
    d.vz = 1.2;
    runSteps(pw, 150, () => driveStep(pw, d));
    const end = driverPos(d);
    const climbedY = end.y - start.y;
    const pass = climbedY >= 0.28;
    return {
      id: 'P4',
      title: '台阶 0.30m',
      pass,
      measured: `最终抬高 ${climbedY.toFixed(3)}m（需 ≥0.28）`,
      detail: { climbedY: round(climbedY), driver: DRIVER_TAG },
    };
  } finally {
    pw.dispose();
  }
};

/** P5 台阶 0.45m：不能上（最终 y <0.20）且不穿模。 */
const P5: CaseFn = async () => {
  const pw = await PhysicsWorld.create(RAPIER, stairsRoom(0.45), { propPoolSize: 4 });
  try {
    const d = makeDriver(pw, 0, CAPSULE_HALF_TOTAL + 0.05, -1.2);
    runSteps(pw, 40, () => driveStep(pw, d));
    const start = driverPos(d);
    d.vz = 1.2;
    runSteps(pw, 150, () => driveStep(pw, d));
    const end = driverPos(d);
    const climbedY = end.y - start.y;
    const totalStairHeight = 5 * 0.45;
    const noClip = climbedY <= totalStairHeight + 0.5;
    const pass = climbedY < 0.2 && noClip;
    return {
      id: 'P5',
      title: '台阶 0.45m',
      pass,
      measured: `抬高 ${climbedY.toFixed(3)}m（需 <0.20），穿模=${!noClip}`,
      detail: { climbedY: round(climbedY), noClip, driver: DRIVER_TAG },
    };
  } finally {
    pw.dispose();
  }
};

/**
 * P6 跳跃高度：起跳后最高点 − 起跳点 ∈ [1.17, 1.23]。
 *
 * 起跳速度不是 spec 字面的 4.85，而是 `jumpLaunchVelocity()` = 4.8522 + g·dt/2 = 4.934。
 * 原因见 character.ts 的 JUMP_HALF_STEP_CORRECTION 注释：4.85 是连续解析解，
 * 1/60 半隐式欧拉会系统性少走约 4.0cm（实测 1.1588m，超出 ±3cm 容差）。
 * `detail` 里同时给出解析值与实际值，任何人能自己验算。
 */
const P6: CaseFn = async () => {
  const pw = await PhysicsWorld.create(RAPIER, floorOnly(), { propPoolSize: 4 });
  try {
    const d = makeDriver(pw, 0, CAPSULE_HALF_TOTAL + 0.02, 0);
    runSteps(pw, 40, () => driveStep(pw, d));

    // 基线取"起跳前一帧稳定后"的高度，并且**先跑一帧空输入**让 controllerOffset
    // 的贴地抬升（实测比 CAP 高 1.18cm）落定，否则这段偏移会被算进跳高。
    // 踩过的坑：直接拿 settle 后的 y 当基线，跳高会是 1.2821（多出 8cm，P6 红）。
    runSteps(pw, 1, () => driveStep(pw, d));
    const takeoff = driverPos(d);

    // d.jump = 1 表示"下一帧起跳"，驱动消费后清 0
    d.jump = 1;
    let peak = takeoff.y;
    runSteps(pw, 120, () => {
      driveStep(pw, d);
      const y = driverPos(d).y;
      if (y > peak) peak = y;
    });
    const height = peak - takeoff.y;
    const pass = height >= 1.17 && height <= 1.23;
    return {
      id: 'P6',
      title: '跳跃高度',
      pass,
      measured: `最高点 ${height.toFixed(4)}m（期望 1.20±0.03，初速 ${jumpLaunchVelocity().toFixed(3)}）`,
      detail: {
        height: round(height),
        min: 1.17,
        max: 1.23,
        launchVelocity: round(jumpLaunchVelocity()),
        analyticVelocity: round(DEFAULT_CHARACTER.jumpSpeed),
        halfStepCorrection: round(DEFAULT_CHARACTER.jumpHalfStepCorrection),
        driver: DRIVER_TAG,
      },
    };
  } finally {
    pw.dispose();
  }
};

/** P7 5m 落体：不穿地，落地后 0.1s 内速度 <0.05。 */
const P7: CaseFn = async () => {
  const pw = await PhysicsWorld.create(RAPIER, floorOnly(), { propPoolSize: 4 });
  try {
    const d = makeDriver(pw, 0, 5 + CAPSULE_HALF_TOTAL, 0);
    let minY = Infinity;
    let landed = false;
    let settleSteps = 0;
    let settleSpeed = Infinity;

    runSteps(pw, 300, () => {
      driveStep(pw, d);
      const p = driverPos(d);
      if (p.y < minY) minY = p.y;
      if (!landed && p.y <= CAPSULE_HALF_TOTAL + 0.02) {
        landed = true;
        settleSteps = 0;
      }
      if (landed) {
        settleSteps += 1;
        // 0.1s = 6 步
        if (settleSteps === 6) settleSpeed = Math.abs(d.controller.snapshot().vy);
      }
    });

    const finalY = driverPos(d).y;
    const noClip = minY >= CAPSULE_HALF_TOTAL - 0.02;
    const stable = settleSpeed < 0.05;
    const pass = landed && noClip && stable;
    return {
      id: 'P7',
      title: '5m 落体',
      pass,
      measured: `最低 y=${minY.toFixed(3)}，落地后速度 ${settleSpeed.toFixed(4)}m/s`,
      detail: {
        minY: round(minY),
        finalY: round(finalY),
        landed,
        settleSpeed: round(settleSpeed),
        driver: DRIVER_TAG,
      },
    };
  } finally {
    pw.dispose();
  }
};

/** P8 推 10kg 箱：箱子位移 ≥0.5m 且角色没被弹飞。 */
const P8: CaseFn = async () => {
  const room = roomWith(
    [{ type: 'box', size: [40, 0.2, 40], pos: [0, -0.1, 0] }],
    [{ type: 'box', size: [0.5, 0.5, 0.5], pos: [0, 0.25, -1.5], mass: 10 }],
  );
  const pw = await PhysicsWorld.create(RAPIER, room, { propPoolSize: 4 });
  try {
    const box = pw.roomProps[0]!;
    const boxStart = box.body.translation();

    const d = makeDriver(pw, 0, CAPSULE_HALF_TOTAL + 0.02, 0);
    runSteps(pw, 30, () => driveStep(pw, d));
    const charStart = driverPos(d);

    d.vz = -1.5;
    runSteps(pw, 180, () => driveStep(pw, d));

    const boxEnd = box.body.translation();
    const charEnd = driverPos(d);
    const boxMoved = Math.hypot(boxEnd.x - boxStart.x, boxEnd.z - boxStart.z);
    const charMoved = Math.hypot(charEnd.x - charStart.x, charEnd.z - charStart.z);
    // 没被弹飞：角色位移不超过它自己走的路程太多
    const notFlung = charMoved < 1.5 * 3;
    const pass = boxMoved >= 0.5 && notFlung;
    return {
      id: 'P8',
      title: '推 10kg 箱',
      pass,
      measured: `箱子位移 ${boxMoved.toFixed(3)}m，角色位移 ${charMoved.toFixed(3)}m`,
      detail: {
        boxMoved: round(boxMoved),
        charMoved: round(charMoved),
        notFlung,
        driver: DRIVER_TAG,
      },
    };
  } finally {
    pw.dispose();
  }
};

/** P9 冲刺撞墙：不穿墙，贴墙时切向速度 >0（能滑，不是卡住）。 */
const P9: CaseFn = async () => {
  const room = roomWith([
    { type: 'box', size: [40, 0.2, 40], pos: [0, -0.1, 0] },
    { type: 'box', size: [40, 3, 0.2], pos: [0, 1.5, -3] },
  ]);
  const pw = await PhysicsWorld.create(RAPIER, room, { propPoolSize: 4 });
  try {
    const d = makeDriver(pw, 0, CAPSULE_HALF_TOTAL + 0.02, 0);
    runSteps(pw, 30, () => driveStep(pw, d));

    // 斜着冲刺（run 速度）
    d.vx = 2.0;
    d.vz = -4.0;
    runSteps(pw, 120, () => driveStep(pw, d));

    const end = driverPos(d);
    // 墙面在 z=-3，墙厚 0.2 -> 面在 z=-2.9；角色半径 0.3 -> 中心不该越过 -2.9
    const notThrough = end.z > -2.9;
    const tangential = Math.abs(end.x);
    const pass = notThrough && tangential > 0.3;
    return {
      id: 'P9',
      title: '冲刺撞墙',
      pass,
      measured: `最终 z=${end.z.toFixed(3)}（墙面 -2.9），切向位移 ${tangential.toFixed(3)}m`,
      detail: {
        endZ: round(end.z),
        tangential: round(tangential),
        notThrough,
        driver: DRIVER_TAG,
      },
    };
  } finally {
    pw.dispose();
  }
};

/** P10 两角色相撞：末态水平间距 ≥ 2*半径−0.02，且末 0.5s 内 y 抖动 <0.005。 */
const P10: CaseFn = async () => {
  const pw = await PhysicsWorld.create(RAPIER, floorOnly(), { propPoolSize: 4 });
  try {
    const a = makeDriver(pw, -2, CAPSULE_HALF_TOTAL + 0.02, 0);
    const b = makeDriver(pw, 2, CAPSULE_HALF_TOTAL + 0.02, 0);
    runSteps(pw, 30, () => {
      driveStep(pw, a);
      driveStep(pw, b);
    });

    a.vx = 1.2;
    b.vx = -1.2;
    runSteps(pw, 120, () => {
      driveStep(pw, a);
      driveStep(pw, b);
    });

    let minYa = Infinity;
    let maxYa = -Infinity;
    runSteps(pw, 30, () => {
      driveStep(pw, a);
      driveStep(pw, b);
      const ya = driverPos(a).y;
      minYa = Math.min(minYa, ya);
      maxYa = Math.max(maxYa, ya);
    });

    const pa = driverPos(a);
    const pb = driverPos(b);
    const dist = Math.hypot(pa.x - pb.x, pa.z - pb.z);
    const minDist = 2 * DEFAULT_CHARACTER.radius - 0.02;
    const jitter = maxYa - minYa;
    const pass = dist >= minDist && jitter < 0.005;
    return {
      id: 'P10',
      title: '两角色相撞',
      pass,
      measured: `末态间距 ${dist.toFixed(3)}m（需 ≥${minDist.toFixed(3)}），y 抖动 ${jitter.toFixed(4)}m`,
      detail: {
        dist: round(dist),
        minDist: round(minDist),
        jitter: round(jitter),
        driver: DRIVER_TAG,
      },
    };
  } finally {
    pw.dispose();
  }
};

/** P11 200 箱堆叠 60s：每箱位移 ≤0.05。 */
const P11: CaseFn = async () => {
  const pw = await PhysicsWorld.create(RAPIER, floorOnly(40), { propPoolSize: 256 });
  try {
    const COUNT = 200;
    const tracked = [];
    for (let i = 0; i < COUNT; i++) {
      const col = i % 10;
      const row = Math.floor(i / 10);
      const stack = row % 2;
      const x = -2.5 + col * 0.55;
      const z = -2.5 + Math.floor(row / 2) * 0.55;
      const y = 0.26 + stack * 0.52;
      tracked.push(pw.spawnProp(0.25, 0.25, 0.25, 10, x, y, z));
    }

    const start = tracked.map((b) => {
      const t = b.body.translation();
      return { x: t.x, y: t.y, z: t.z };
    });

    // 60 秒物理时间 = 3600 步
    runSteps(pw, 3600);

    let maxDrift = 0;
    let maxIndex = -1;
    for (let i = 0; i < tracked.length; i++) {
      const t = tracked[i]!.body.translation();
      const s = start[i]!;
      const d = Math.hypot(t.x - s.x, t.y - s.y, t.z - s.z);
      if (d > maxDrift) {
        maxDrift = d;
        maxIndex = i;
      }
    }
    const pass = maxDrift <= 0.05;
    return {
      id: 'P11',
      title: '200 箱堆叠 60s',
      pass,
      measured: `最大位移 ${(maxDrift * 100).toFixed(2)}cm（箱#${maxIndex}，需 ≤5cm）`,
      detail: {
        count: COUNT,
        maxDrift: round(maxDrift),
        maxIndex,
        steps: 3600,
        pooledCreated: pw.pool.createdCount,
      },
    };
  } finally {
    pw.dispose();
  }
};

/**
 * 尽力触发一次 GC（只有 `--expose-gc` 时才有 `global.gc`）。
 *
 * 返回是否真的执行了。**调用方必须根据这个返回值决定"能不能信这份数据"**——
 * 这正是 P12 修正 3 的核心：gc 不可用时堆增量是噪声，不能在噪声上判定。
 */
function tryGc(): boolean {
  const g = (globalThis as { gc?: () => void }).gc;
  if (typeof g !== 'function') return false;
  g();
  g();
  return true;
}

/**
 * P12 60s 连续运行：堆增长 ≤200KB。
 *
 * 测量方法经过三次修正，每次都是被实测数据逼出来的：
 *
 * **修正 1：必须强制 GC。** 不 GC 时 3600 步涨 8062KB，GC 后只涨 186KB，差 43 倍。
 * 契约要的是"没有泄漏"，不是"GC 还没跑"。
 *
 * **修正 2：必须跑两个窗口取增量。** 实测三次连续 60s 窗口的增量：
 * 169.6KB → 17.3KB → 1.1KB，明显收敛。第一个窗口里混着 JIT 编译、
 * Rapier 内部缓存扩容、WASM 堆首次增长这些**一次性**开销。
 *
 * **修正 3（lead 指出）：拿不到 gc 就必须 SKIP，不能照常判定。**
 * 没开 `--expose-gc` 时堆增量会随 GC 时机乱跳（实测 -1.7KB ~ 16MB），
 * P12 变成"看运气"的用例。**一条随机红的用例比没有更糟**。
 */
const P12: CaseFn = async () => {
  const perf = performance as Performance & { memory?: { usedJSHeapSize: number } };
  const hasChromiumMemory = typeof perf.memory?.usedJSHeapSize === 'number';
  const hasNodeGc = typeof (globalThis as { gc?: () => void }).gc === 'function';

  const pw = await PhysicsWorld.create(RAPIER, floorOnly(40), { propPoolSize: 64 });
  try {
    for (let i = 0; i < 50; i++) {
      pw.spawnProp(0.2, 0.2, 0.2, 5, -2 + (i % 10) * 0.5, 0.3 + Math.floor(i / 10) * 0.45, 0);
    }
    const chars: Driver[] = [];
    for (let i = 0; i < 4; i++) chars.push(makeDriver(pw, i - 2, CAPSULE_HALF_TOTAL + 0.05, 1));

    const drive = (i: number): void => {
      for (let c = 0; c < chars.length; c++) {
        const d = chars[c]!;
        d.vx = Math.sin((i + c * 60) * 0.01) * 1.2;
        d.vz = Math.cos((i + c * 60) * 0.01) * 1.2;
        driveStep(pw, d);
      }
    };

    // 预热：JIT + 首次分配
    runSteps(pw, 300, drive);

    // 三态判定：数据不可信就 SKIP，绝不在噪声上判 PASS/FAIL
    if (!hasChromiumMemory && !hasNodeGc) {
      runSteps(pw, 3600, drive);
      const skipDetail: Record<string, number | string | boolean> = {
        skipped: true,
        reason: 'no reliable heap measurement (need --expose-gc or performance.memory)',
        steps: 3900,
        pooledCreated: pw.pool.createdCount,
      };
      return {
        id: 'P12',
        title: '60s 连续运行',
        pass: false,
        measured: 'SKIP（环境未开 --expose-gc，堆增量不可信）',
        detail: skipDetail,
      };
    }

    const readHeap = (): number => {
      if (hasChromiumMemory) return perf.memory!.usedJSHeapSize;
      const proc = (globalThis as { process?: { memoryUsage?: () => { heapUsed: number } } }).process;
      return proc!.memoryUsage!().heapUsed;
    };
    const source = hasChromiumMemory ? 'performance.memory' : 'process.memoryUsage';

    // 窗口 1：吸收一次性开销
    tryGc();
    runSteps(pw, 3600, drive);
    tryGc();
    const afterWarm = readHeap();

    // 窗口 2：稳态增量，判定依据
    runSteps(pw, 3600, drive);
    const gcOk = tryGc();
    const afterSteady = readHeap();

    const growthKB = (afterSteady - afterWarm) / 1024;
    const pass = growthKB <= 200;
    return {
      id: 'P12',
      title: '60s 连续运行',
      pass,
      measured: `稳态堆增量 ${growthKB.toFixed(1)}KB（需 ≤200KB，来源 ${source}${gcOk ? '，已强制 GC' : ''}）`,
      detail: {
        growthKB: round(growthKB, 1),
        afterWarm,
        afterSteady,
        source,
        forcedGc: gcOk,
        windows: 2,
        steps: 7200,
        pooledCreated: pw.pool.createdCount,
      },
    };
  } finally {
    pw.dispose();
  }
};

/** 全部用例，顺序与 spec §7 一致。 */
export const CASES: Array<{ id: string; title: string; run: CaseFn }> = [
  { id: 'P1', title: '平地走 5m', run: P1 },
  { id: 'P2', title: '30° 斜坡站立/上行', run: P2 },
  { id: 'P3', title: '45° 斜坡', run: P3 },
  { id: 'P4', title: '台阶 0.30m', run: P4 },
  { id: 'P5', title: '台阶 0.45m', run: P5 },
  { id: 'P6', title: '跳跃高度', run: P6 },
  { id: 'P7', title: '5m 落体', run: P7 },
  { id: 'P8', title: '推 10kg 箱', run: P8 },
  { id: 'P9', title: '冲刺撞墙', run: P9 },
  { id: 'P10', title: '两角色相撞', run: P10 },
  { id: 'P11', title: '200 箱堆叠 60s', run: P11 },
  { id: 'P12', title: '60s 连续运行', run: P12 },
];

// ───────────────────────────── 运行器 ─────────────────────────────

/** 读 WebGL renderer 字符串（headless 里通常是 SwiftShader）。 */
function readRendererString(): string {
  try {
    const canvas = document.createElement('canvas');
    const gl = canvas.getContext('webgl2') ?? canvas.getContext('webgl');
    if (!gl) return 'unavailable';
    const ext = gl.getExtension('WEBGL_debug_renderer_info');
    if (!ext) return 'unknown';
    return String(gl.getParameter(ext.UNMASKED_RENDERER_WEBGL));
  } catch {
    return 'error';
  }
}

/**
 * 跑全部用例并把进度写到 `window.__verify`。
 *
 * 每跑完一条就更新一次，外面可以轮询看进度（也能定位卡在哪条）。
 * `status` 从 running 变 done 只发生一次。
 */
export async function runVerify(opts: { only?: string[] } = {}): Promise<VerifyReport> {
  const startedAt = performance.now();
  await RAPIER.init();

  const selected = opts.only?.length
    ? CASES.filter((c) => opts.only!.includes(c.id))
    : CASES;

  const report: VerifyReport = {
    status: 'running',
    startedAt,
    // total 恒为契约要求的 12：即使只跑子集，也不能让外面误判"少跑算通过"
    total: VERIFY_TOTAL,
    passed: 0,
    cases: [],
    env: {
      ua: typeof navigator !== 'undefined' ? navigator.userAgent : 'node',
      hardwareConcurrency:
        typeof navigator !== 'undefined' ? (navigator.hardwareConcurrency ?? 0) : 0,
      renderer: typeof document !== 'undefined' ? readRendererString() : 'node',
      rapierVersion: String(RAPIER.version?.() ?? 'unknown'),
    },
  };
  setReport(report);

  for (const c of selected) {
    let result: VerifyCaseResult;
    try {
      result = await c.run();
    } catch (err) {
      result = {
        id: c.id,
        title: c.title,
        pass: false,
        measured: '用例抛异常',
        detail: {},
        error: err instanceof Error ? `${err.name}: ${err.message}` : String(err),
      };
    }
    report.cases.push(result);
    if (result.pass) report.passed += 1;
    setReport(report);
  }

  report.status = 'done';
  report.finishedAt = performance.now();
  setReport(report);
  return report;
}

function setReport(report: VerifyReport): void {
  if (typeof window !== 'undefined') window.__verify = report;
}

/** 是不是 verify 模式（`?verify=1`）。 */
export function isVerifyMode(search?: string): boolean {
  const s = search ?? (typeof location !== 'undefined' ? location.search : '');
  return /[?&]verify=1(?:&|$)/.test(s);
}
