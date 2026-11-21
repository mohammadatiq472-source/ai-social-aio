import { describe, it, expect, beforeEach } from 'vitest';
import { IDLE_INPUT, KeyboardInput, horizontalize } from './keyboard';

/**
 * 键盘输入层的单测（不依赖 DOM：直接构造假事件喂给内部处理器）。
 *
 * 为什么这层值得单独测：WASD 的三个坑全部是"逻辑错"而不是"渲染错"，
 * 看画面很难发现，但用坐标断言一眼就穿：
 *   1. 相对相机 vs 世界轴（按 W 往侧面走）
 *   2. 对角线不归一化（斜着走快 41%）
 *   3. 跳跃按住连跳（不是边沿触发）
 */

/** 最小的假 window：能注册/派发 keydown/keyup/blur。 */
function makeFakeWindow() {
  const listeners = new Map<string, Set<(e: unknown) => void>>();
  const win = {
    addEventListener(type: string, fn: (e: unknown) => void) {
      let s = listeners.get(type);
      if (!s) {
        s = new Set();
        listeners.set(type, s);
      }
      s.add(fn);
    },
    removeEventListener(type: string, fn: (e: unknown) => void) {
      listeners.get(type)?.delete(fn);
    },
    dispatch(type: string, ev: Record<string, unknown>) {
      const e = {
        code: ev['code'] ?? '',
        target: ev['target'] ?? null,
        preventDefault() {},
        ...ev,
      };
      for (const fn of listeners.get(type) ?? []) fn(e);
    },
  };
  return win;
}

/** 标准相机朝向：看向 -Z（three 默认相机朝向），右向 +X。 */
const CAM_FORWARD = { x: 0, z: -1 };
const CAM_RIGHT = { x: 1, z: 0 };

let win: ReturnType<typeof makeFakeWindow>;
let kb: KeyboardInput;

beforeEach(() => {
  win = makeFakeWindow();
  kb = new KeyboardInput();
  // KeyboardInput 内部对 blur 用 window，这里把全局换成假的
  (globalThis as unknown as { window: unknown }).window = win;
  kb.attach(win as unknown as Window);
});

describe('键盘输入：WASD 方向（相对相机）', () => {
  it('无按键 → 零向量', () => {
    const i = kb.sample(CAM_FORWARD, CAM_RIGHT);
    expect(i).toEqual({ ...IDLE_INPUT, run: false, jump: false });
  });

  it('W → 沿相机前方（不是世界 +Z）', () => {
    win.dispatch('keydown', { code: 'KeyW' });
    const i = kb.sample(CAM_FORWARD, CAM_RIGHT);
    // 相机看 -Z，所以 W 应该给 (0, -1)
    expect(i.dirX).toBeCloseTo(0, 6);
    expect(i.dirZ).toBeCloseTo(-1, 6);
    expect(i.moving).toBe(true);
  });

  it('S → 相机后方', () => {
    win.dispatch('keydown', { code: 'KeyS' });
    const i = kb.sample(CAM_FORWARD, CAM_RIGHT);
    expect(i.dirZ).toBeCloseTo(1, 6);
  });

  it('D → 相机右侧', () => {
    win.dispatch('keydown', { code: 'KeyD' });
    const i = kb.sample(CAM_FORWARD, CAM_RIGHT);
    expect(i.dirX).toBeCloseTo(1, 6);
    expect(i.dirZ).toBeCloseTo(0, 6);
  });

  it('A → 相机左侧', () => {
    win.dispatch('keydown', { code: 'KeyA' });
    const i = kb.sample(CAM_FORWARD, CAM_RIGHT);
    expect(i.dirX).toBeCloseTo(-1, 6);
  });

  it('相机转向后，W 的方向跟着转（这是"相对相机"的核心）', () => {
    // 相机转到看 +X
    const fwd = { x: 1, z: 0 };
    const right = { x: 0, z: 1 };
    win.dispatch('keydown', { code: 'KeyW' });
    const i = kb.sample(fwd, right);
    expect(i.dirX).toBeCloseTo(1, 6);
    expect(i.dirZ).toBeCloseTo(0, 6);
  });

  it('方向键等价于 WASD', () => {
    win.dispatch('keydown', { code: 'ArrowUp' });
    expect(kb.sample(CAM_FORWARD, CAM_RIGHT).dirZ).toBeCloseTo(-1, 6);
  });
});

describe('键盘输入：对角线归一化', () => {
  it('W+D 的长度是 1，不是 √2', () => {
    win.dispatch('keydown', { code: 'KeyW' });
    win.dispatch('keydown', { code: 'KeyD' });
    const i = kb.sample(CAM_FORWARD, CAM_RIGHT);
    const len = Math.hypot(i.dirX, i.dirZ);
    expect(len).toBeCloseTo(1, 6);
    // 且两个分量都是 1/√2
    expect(i.dirX).toBeCloseTo(Math.SQRT1_2, 6);
    expect(i.dirZ).toBeCloseTo(-Math.SQRT1_2, 6);
  });

  it('四向同按时长度仍是 1（互相抵消后为 0）', () => {
    for (const c of ['KeyW', 'KeyA', 'KeyS', 'KeyD']) win.dispatch('keydown', { code: c });
    const i = kb.sample(CAM_FORWARD, CAM_RIGHT);
    expect(Math.hypot(i.dirX, i.dirZ)).toBeCloseTo(0, 6);
    expect(i.moving).toBe(false);
  });

  it('斜走不比直走快（速度大小相同）', () => {
    win.dispatch('keydown', { code: 'KeyW' });
    const straight = kb.sample(CAM_FORWARD, CAM_RIGHT);
    win.dispatch('keydown', { code: 'KeyD' });
    const diagonal = kb.sample(CAM_FORWARD, CAM_RIGHT);
    expect(Math.hypot(diagonal.dirX, diagonal.dirZ)).toBeCloseTo(
      Math.hypot(straight.dirX, straight.dirZ),
      6,
    );
  });
});

describe('键盘输入：Shift 奔跑 / 空格跳跃', () => {
  it('Shift 按下 → run=true', () => {
    win.dispatch('keydown', { code: 'KeyW' });
    win.dispatch('keydown', { code: 'ShiftLeft' });
    expect(kb.sample(CAM_FORWARD, CAM_RIGHT).run).toBe(true);
  });

  it('右 Shift 也认', () => {
    win.dispatch('keydown', { code: 'ShiftRight' });
    expect(kb.sample(CAM_FORWARD, CAM_RIGHT).run).toBe(true);
  });

  it('空格是**边沿触发**：按住只跳一次', () => {
    win.dispatch('keydown', { code: 'Space' });
    expect(kb.sample(CAM_FORWARD, CAM_RIGHT).jump).toBe(true);
    // 第二次采样（键还按着）不该再触发
    expect(kb.sample(CAM_FORWARD, CAM_RIGHT).jump).toBe(false);
    expect(kb.sample(CAM_FORWARD, CAM_RIGHT).jump).toBe(false);
  });

  it('松开再按 → 又能跳一次', () => {
    win.dispatch('keydown', { code: 'Space' });
    expect(kb.sample(CAM_FORWARD, CAM_RIGHT).jump).toBe(true);
    win.dispatch('keyup', { code: 'Space' });
    win.dispatch('keydown', { code: 'Space' });
    expect(kb.sample(CAM_FORWARD, CAM_RIGHT).jump).toBe(true);
  });
});

describe('键盘输入：松开与失焦', () => {
  it('松开 W → 方向归零（不残留）', () => {
    win.dispatch('keydown', { code: 'KeyW' });
    expect(kb.sample(CAM_FORWARD, CAM_RIGHT).moving).toBe(true);
    win.dispatch('keyup', { code: 'KeyW' });
    expect(kb.sample(CAM_FORWARD, CAM_RIGHT).moving).toBe(false);
  });

  it('失焦清空所有按键（Alt+Tab 回来不会一直走）', () => {
    win.dispatch('keydown', { code: 'KeyW' });
    win.dispatch('blur', {});
    expect(kb.sample(CAM_FORWARD, CAM_RIGHT).moving).toBe(false);
  });

  it('输入框里打字不抢键（isEditableTarget）', () => {
    // 构造一个 tagName=INPUT 的假 target
    class FakeInput {
      tagName = 'INPUT';
      isContentEditable = false;
    }
    win.dispatch('keydown', { code: 'KeyW', target: new FakeInput() });
    expect(kb.sample(CAM_FORWARD, CAM_RIGHT).moving).toBe(false);
  });

  it('dispose 后不再响应', () => {
    kb.dispose();
    win.dispatch('keydown', { code: 'KeyW' });
    expect(kb.sample(CAM_FORWARD, CAM_RIGHT).moving).toBe(false);
  });
});

describe('键盘输入：表情键', () => {
  it('数字键触发对应 clip', () => {
    const seen: string[] = [];
    kb.bindEmotes({ Digit1: 'angry_01', Digit2: 'cry' }, (clip) => seen.push(clip));
    win.dispatch('keydown', { code: 'Digit1' });
    win.dispatch('keydown', { code: 'Digit2' });
    expect(seen).toEqual(['angry_01', 'cry']);
  });

  it('未绑定的数字键不触发', () => {
    const seen: string[] = [];
    kb.bindEmotes({ Digit1: 'angry_01' }, (clip) => seen.push(clip));
    win.dispatch('keydown', { code: 'Digit9' });
    expect(seen).toEqual([]);
  });

  it('按住不放只触发一次（不是每帧都播）', () => {
    const seen: string[] = [];
    kb.bindEmotes({ Digit1: 'angry_01' }, (clip) => seen.push(clip));
    win.dispatch('keydown', { code: 'Digit1' });
    win.dispatch('keydown', { code: 'Digit1' }); // 系统的 key repeat
    expect(seen).toEqual(['angry_01']);
  });
});

describe('horizontalize：相机朝向投影到水平面', () => {
  it('俯视的相机（forward 带 y）也能得到水平单位向量', () => {
    const h = horizontalize({ x: 0.3, y: -0.9, z: -0.3 });
    expect(Math.hypot(h.x, h.z)).toBeCloseTo(1, 6);
  });

  it('正下方看时给默认前方，不返回 NaN', () => {
    const h = horizontalize({ x: 0, y: -1, z: 0 });
    expect(Number.isFinite(h.x)).toBe(true);
    expect(Number.isFinite(h.z)).toBe(true);
    expect(Math.hypot(h.x, h.z)).toBeCloseTo(1, 6);
  });

  it('水平向量原样返回（已是单位长度）', () => {
    const h = horizontalize({ x: 0, y: 0, z: -1 });
    expect(h.x).toBeCloseTo(0, 6);
    expect(h.z).toBeCloseTo(-1, 6);
  });
});
