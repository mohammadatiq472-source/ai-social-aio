import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import {
  DEFAULT_STAIR_WIDTH,
  RoomValidationError,
  eulerToQuat,
  formatIssues,
  parseRoom,
  roomPropSolids,
  roomSolids,
  spawnPoint,
  validateRoom,
  yawToQuat,
  type Room,
} from './room';

/** 从磁盘读真实的 demo 房间：测试必须覆盖"仓库里那份文件"，不是测试里另造的一份。 */
function loadDemoJson(): unknown {
  const url = new URL('../../rooms/demo-room.json', import.meta.url);
  return JSON.parse(readFileSync(fileURLToPath(url), 'utf8'));
}

/** 一份最小合法房间，供各用例按需改坏某一个字段。 */
function minimalRoom(): Record<string, unknown> {
  return {
    name: '最小房间',
    spawn: [[0, 0, 0]],
    lights: [{ type: 'dir', dir: [1, 2, 1], color: '#fff', intensity: 2 }],
    static: [{ type: 'box', size: [8, 0.2, 8], pos: [0, -0.1, 0], mat: 'floor' }],
    props: [{ type: 'box', size: [0.5, 0.5, 0.5], pos: [0, 0.25, 1], mass: 10 }],
    seats: [{ id: 's1', pos: [1.5, 0, -1], rot: 0 }],
  };
}

/** 取第一条错误（断言用），断言失败时把全部错误打出来便于定位。 */
function firstIssue(raw: unknown): { path: string; message: string } {
  const result = validateRoom(raw);
  expect(result.ok, `期望校验失败，但通过了：${JSON.stringify(raw)}`).toBe(false);
  const issue = result.issues[0];
  expect(issue, '校验失败却没有给出任何 issue').toBeDefined();
  return issue!;
}

describe('房间校验：错误必须能定位到字段路径', () => {
  it('demo-room.json 本身合法，且字段齐全', () => {
    const result = validateRoom(loadDemoJson());
    expect(result.issues).toEqual([]);
    expect(result.ok).toBe(true);
    const room = result.room!;
    expect(room.name.length).toBeGreaterThan(0);
    expect(room.spawn.length).toBeGreaterThanOrEqual(2);
    expect(room.lights.length).toBeGreaterThanOrEqual(1);
    // spec §6 M6 第 3 条：地板、两面墙、斜坡、5 级台阶
    expect(room.static.some((s) => s.type === 'box')).toBe(true);
    expect(room.static.some((s) => s.type === 'ramp')).toBe(true);
    const stairs = room.static.find((s) => s.type === 'stairs');
    expect(stairs, 'demo 房间必须有一段台阶').toBeDefined();
    expect(stairs!.type === 'stairs' && stairs!.steps).toBe(5);
    // 两个箱子、两把椅子
    expect(room.props.length).toBe(2);
    expect(room.seats.length).toBe(2);
    expect(room.seats.map((s) => s.id)).toEqual(['s1', 's2']);
  });

  it('static[2].size 不是长度 3 的数组 → 报出精确路径', () => {
    const raw = minimalRoom();
    raw['static'] = [
      { type: 'box', size: [1, 1, 1], pos: [0, 0, 0] },
      { type: 'box', size: [1, 1, 1], pos: [0, 0, 0] },
      // 第 3 个（下标 2）：size 只有两个分量
      { type: 'box', size: [1, 1], pos: [0, 0, 0] },
    ];
    const issue = firstIssue(raw);
    expect(issue.path).toBe('static[2].size');
    expect(issue.message).toContain('长度 3');
  });

  it('static[2].size 里混进字符串 → 定位到具体分量', () => {
    const raw = minimalRoom();
    raw['static'] = [
      { type: 'box', size: [1, 1, 1], pos: [0, 0, 0] },
      { type: 'box', size: [1, 1, 1], pos: [0, 0, 0] },
      { type: 'box', size: [1, 'x', 1], pos: [0, 0, 0] },
    ];
    const issue = firstIssue(raw);
    expect(issue.path).toBe('static[2].size[1]');
    expect(issue.message).toContain('有限数字');
  });

  it('pos 缺分量 → 定位到 static[0].pos[2]', () => {
    const raw = minimalRoom();
    raw['static'] = [{ type: 'box', size: [1, 1, 1], pos: [0, 0] }];
    const issue = firstIssue(raw);
    expect(issue.path).toBe('static[0].pos');
  });

  it('未知 type → 明确列出允许值', () => {
    const raw = minimalRoom();
    raw['static'] = [{ type: 'cylinder', size: [1, 1, 1], pos: [0, 0, 0] }];
    const issue = firstIssue(raw);
    expect(issue.path).toBe('static[0].type');
    expect(issue.message).toContain('box');
    expect(issue.message).toContain('ramp');
    expect(issue.message).toContain('stairs');
  });

  it('尺寸为 0 或负数 → 拒绝（负半长会造出"看不见但挡人"的墙）', () => {
    const raw = minimalRoom();
    raw['static'] = [{ type: 'box', size: [0, 1, 1], pos: [0, 0, 0] }];
    const issue = firstIssue(raw);
    expect(issue.path).toBe('static[0].size[0]');
    expect(issue.message).toContain('> 0');
  });

  it('台阶缺 steps → 定位到 static[i].steps', () => {
    const raw = minimalRoom();
    raw['static'] = [{ type: 'stairs', rise: 0.16, run: 0.32, pos: [0, 0, 0] }];
    const issue = firstIssue(raw);
    expect(issue.path).toBe('static[0].steps');
  });

  it('台阶 steps 不是整数 → 拒绝', () => {
    const raw = minimalRoom();
    raw['static'] = [{ type: 'stairs', steps: 2.5, rise: 0.16, run: 0.32, pos: [0, 0, 0] }];
    const issue = firstIssue(raw);
    expect(issue.path).toBe('static[0].steps');
    expect(issue.message).toContain('整数');
  });

  it('道具质量为 0 → 定位到 props[0].mass', () => {
    const raw = minimalRoom();
    raw['props'] = [{ type: 'box', size: [0.5, 0.5, 0.5], pos: [0, 0.25, 1], mass: 0 }];
    const issue = firstIssue(raw);
    expect(issue.path).toBe('props[0].mass');
  });

  it('座位 id 重复 → 拒绝（sit 意图按 id 寻址，重复会变成未定义行为）', () => {
    const raw = minimalRoom();
    raw['seats'] = [
      { id: 'dup', pos: [0, 0, 0], rot: 0 },
      { id: 'dup', pos: [1, 0, 0], rot: 0 },
    ];
    const issue = firstIssue(raw);
    expect(issue.path).toBe('seats[1].id');
    expect(issue.message).toContain('重复');
  });

  it('颜色格式非法 → 定位到 lights[0].color', () => {
    const raw = minimalRoom();
    raw['lights'] = [{ type: 'dir', dir: [1, 2, 1], color: 'red', intensity: 1 }];
    const issue = firstIssue(raw);
    expect(issue.path).toBe('lights[0].color');
    expect(issue.message).toContain('#');
  });

  it('dir 光缺 dir → 拒绝（没有方向的方向光等于没开）', () => {
    const raw = minimalRoom();
    raw['lights'] = [{ type: 'dir', color: '#fff', intensity: 1 }];
    const issue = firstIssue(raw);
    expect(issue.path).toBe('lights[0].dir');
  });

  it('顶层缺 static / props / seats → 各自报出字段名', () => {
    for (const field of ['static', 'props', 'seats', 'spawn', 'lights']) {
      const raw = minimalRoom();
      delete raw[field];
      const issue = firstIssue(raw);
      expect(issue.path).toBe(field);
    }
  });

  it('整体不是对象 → 报 $ 路径', () => {
    const issue = firstIssue([]);
    expect(issue.path).toBe('$');
  });

  it('一次收集全部错误，而不是遇到第一个就停', () => {
    const raw = minimalRoom();
    raw['static'] = [
      { type: 'box', size: [1, 1], pos: [0, 0, 0] },
      { type: 'box', size: [1, 1, 1], pos: [0, 0] },
    ];
    raw['props'] = [{ type: 'box', size: [1, 1, 1], pos: [0, 0, 0], mass: -1 }];
    const result = validateRoom(raw);
    expect(result.ok).toBe(false);
    expect(result.issues.length).toBeGreaterThanOrEqual(3);
    const paths = result.issues.map((i) => i.path);
    expect(paths).toContain('static[0].size');
    expect(paths).toContain('static[1].pos');
    expect(paths).toContain('props[0].mass');
  });

  it('parseRoom 抛 RoomValidationError，issues 与 formatIssues 可读', () => {
    const raw = minimalRoom();
    raw['static'] = [{ type: 'box', size: [1, 1], pos: [0, 0, 0] }];
    let caught: unknown;
    try {
      parseRoom(raw);
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(RoomValidationError);
    const err = caught as RoomValidationError;
    expect(err.issues[0]!.path).toBe('static[0].size');
    expect(err.message).toContain('static[0].size');
    expect(formatIssues(err.issues)).toContain('static[0].size');
  });

  it('rot 可选；省略时视为无旋转', () => {
    const raw = minimalRoom();
    const room = validateRoom(raw).room!;
    const solids = roomSolids(room);
    expect(solids[0]!.rot).toEqual([0, 0, 0, 1]);
  });
});

describe('房间几何推导（渲染与物理的共同输入）', () => {
  it('box/ramp 的 size 是全尺寸，半尺寸要除以 2', () => {
    const room = parseRoom({
      name: 't',
      spawn: [[0, 0, 0]],
      lights: [],
      static: [{ type: 'box', size: [4, 2, 6], pos: [1, 2, 3] }],
      props: [],
      seats: [],
    });
    const s = roomSolids(room)[0]!;
    expect(s.halfExtents).toEqual([2, 1, 3]);
    expect(s.pos).toEqual([1, 2, 3]);
  });

  it('台阶展开成 steps 个实心盒，且逐级升高（不是薄板）', () => {
    const room = parseRoom({
      name: 't',
      spawn: [[0, 0, 0]],
      lights: [],
      static: [{ type: 'stairs', steps: 5, rise: 0.16, run: 0.32, pos: [0, 0, 0] }],
      props: [],
      seats: [],
    });
    const solids = roomSolids(room);
    expect(solids.length).toBe(5);
    // 每级都是"从地面堆到该级顶面"的实心盒：中心 y = rise*(i+1)/2，半高 = rise*(i+1)/2
    for (let i = 0; i < 5; i++) {
      const height = 0.16 * (i + 1);
      expect(solids[i]!.pos[1]).toBeCloseTo(height / 2, 10);
      expect(solids[i]!.halfExtents[1]).toBeCloseTo(height / 2, 10);
      // 沿 +z 递进
      expect(solids[i]!.pos[2]).toBeCloseTo(0.32 * (i + 0.5), 10);
      expect(solids[i]!.halfExtents[2]).toBeCloseTo(0.16, 10);
    }
    // 末级顶面正好是 5 * rise
    const top = solids[4]!.pos[1] + solids[4]!.halfExtents[1];
    expect(top).toBeCloseTo(0.8, 10);
    // 宽度默认值
    expect(solids[0]!.halfExtents[0]).toBeCloseTo(DEFAULT_STAIR_WIDTH / 2, 10);
  });

  it('台阶的 width 可覆盖', () => {
    const room = parseRoom({
      name: 't',
      spawn: [[0, 0, 0]],
      lights: [],
      static: [{ type: 'stairs', steps: 2, rise: 0.1, run: 0.3, width: 3, pos: [0, 0, 0] }],
      props: [],
      seats: [],
    });
    expect(roomSolids(room)[0]!.halfExtents[0]).toBeCloseTo(1.5, 10);
  });

  it('sourceIndex 指回原 static 下标（烘焙失败时能定位是哪一块）', () => {
    const room = parseRoom({
      name: 't',
      spawn: [[0, 0, 0]],
      lights: [],
      static: [
        { type: 'box', size: [1, 1, 1], pos: [0, 0, 0] },
        { type: 'stairs', steps: 3, rise: 0.1, run: 0.2, pos: [0, 0, 0] },
      ],
      props: [],
      seats: [],
    });
    const solids = roomSolids(room);
    expect(solids[0]!.sourceIndex).toBe(0);
    // 台阶展开出的 3 块都指回下标 1
    expect(solids.slice(1).map((s) => s.sourceIndex)).toEqual([1, 1, 1]);
    expect(solids[1]!.sourceType).toBe('stairs');
  });

  it('道具质量与半尺寸正确带入', () => {
    const room = parseRoom({
      name: 't',
      spawn: [[0, 0, 0]],
      lights: [],
      static: [],
      props: [{ type: 'box', size: [0.5, 0.4, 0.6], pos: [0, 0.2, 1], mass: 10 }],
      seats: [],
    });
    const p = roomPropSolids(room)[0]!;
    expect(p.halfExtents).toEqual([0.25, 0.2, 0.3]);
    expect(p.mass).toBe(10);
    expect(p.pos).toEqual([0, 0.2, 1]);
  });

  it('demo 房间烘焙出的实心块数量对得上（1 地 + 2 墙 + 1 坡 + 5 台阶 = 9）', () => {
    const room = validateRoom(loadDemoJson()).room!;
    expect(roomSolids(room).length).toBe(9);
  });
});

describe('欧拉角 → 四元数：必须与 three 的 XYZ 约定逐位一致', () => {
  /**
   * 这些期望值是拿 three r170 的 `new Quaternion().setFromEuler(new Euler(x,y,z,'XYZ'))`
   * 实算出来的金标（不是手推）。
   * 为什么要在测试里锁死：渲染侧用 three 的 setFromEuler 摆网格，
   * 物理侧用这里算的四元数建碰撞体。两边约定一旦分叉，
   * 斜坡会"看着朝东、撞着朝西"——这种 bug 极难从画面上判断。
   */
  const GOLDEN: Array<{ euler: [number, number, number]; quat: [number, number, number, number] }> = [
    { euler: [0, 0, -0.52], quat: [0, 0, -0.257081, 0.96639] },
    { euler: [0.7, 0, 0], quat: [0.342898, 0, 0, 0.939373] },
    { euler: [0, 0.9, 0.4], quat: [0.086414, 0.426295, 0.178891, 0.882498] },
    { euler: [0.3, 0.5, -0.2], quat: [0.119647, 0.257859, -0.058857, 0.956937] },
  ];

  for (const { euler, quat } of GOLDEN) {
    it(`euler(${euler.join(', ')}) 与 three 一致`, () => {
      const q = eulerToQuat(euler);
      for (let i = 0; i < 4; i++) {
        expect(q[i]!).toBeCloseTo(quat[i]!, 5);
      }
      // 必须是单位四元数，否则 Rapier 会把它当成带缩放的旋转
      expect(Math.hypot(...q)).toBeCloseTo(1, 10);
    });
  }

  it('yawToQuat 与 eulerToQuat([0,yaw,0]) 等价', () => {
    const yaw = 1.234;
    const a = yawToQuat(yaw);
    const b = eulerToQuat([0, yaw, 0]);
    for (let i = 0; i < 4; i++) expect(a[i]).toBeCloseTo(b[i]!, 12);
  });
});

describe('出生点分配', () => {
  const room: Room = parseRoom({
    name: 't',
    spawn: [
      [0, 0, 2],
      [1.2, 0, 2],
    ],
    lights: [],
    static: [],
    props: [],
    seats: [],
  });

  it('按顺序取出生点', () => {
    expect(spawnPoint(room, 0)).toEqual([0, 0, 2]);
    expect(spawnPoint(room, 1)).toEqual([1.2, 0, 2]);
  });

  it('人数超过出生点时环绕复用，并沿 x 错位避免出生即重叠', () => {
    // 用 toBeCloseTo 而不是 toEqual：1.2 + 0.6 在 IEEE754 下是 1.7999999999999998，
    // 这不是 bug，是"叠加偏移量"的必然结果。断言的意图是"错位了 0.6m"，不是逐位相等。
    const p2 = spawnPoint(room, 2);
    const p3 = spawnPoint(room, 3);
    expect(p2[0]).toBeCloseTo(0.6, 10);
    expect(p3[0]).toBeCloseTo(1.8, 10);
    expect(p2[2]).toBe(2);
    expect(p3[2]).toBe(2);
  });

  it('空出生点列表 → 给一个安全默认值，不抛', () => {
    const empty = parseRoom({
      name: 't',
      spawn: [],
      lights: [],
      static: [],
      props: [],
      seats: [],
    });
    const p = spawnPoint(empty, 0);
    expect(p[1]).toBeGreaterThan(0); // 必须离地一点，否则第一帧会嵌进地板
  });
});
