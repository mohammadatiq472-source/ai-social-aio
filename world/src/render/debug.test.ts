import { describe, it, expect, beforeEach } from 'vitest';
import {
  DEBUG_PANEL_MARKER,
  DebugPanel,
  PANEL_REFRESH_MS,
  STEP_WINDOW_SIZE,
  StepWindow,
  formatMetrics,
  formatToggles,
  isDebugQuery,
  shouldEnableDebugPanel,
  type DebugActions,
  type DebugMetrics,
} from './debug';

/**
 * M11 面板的**逻辑**单测（node 环境，不碰真 DOM）。
 *
 * 分工说明（避免下一个人以为这里漏了测试）：
 * - 这里测：开关判定、环形窗口统计、文本格式、按键守卫、DOM 生命周期。
 * - **生产构建里不存在这段代码**这条，只能对着**构建产物**断言，
 *   所以它在 `tools/verify-debug-treeshake.mjs`（grep dist/ 里的 marker），
 *   不在本文件——node 单测里 import 得到这个模块，本来就证明不了它会被摇掉。
 */

function baseMetrics(over: Partial<DebugMetrics> = {}): DebugMetrics {
  return {
    fps: 60,
    frameMs: 16.67,
    physicsAvgMs: 1.234,
    physicsMaxMs: 3.456,
    rigidBodies: 7,
    dynamicBodies: 2,
    colliders: 9,
    entities: 7,
    overruns: 0,
    physicsOverruns: 0,
    drawCalls: 12,
    triangles: 3456,
    tier: 'desktop',
    dpr: 1,
    paused: false,
    physicsWireframe: false,
    gridVisible: true,
    ...over,
  };
}

describe('M11 面板：开关判定', () => {
  it('只认 ?debug=1', () => {
    expect(isDebugQuery('?debug=1')).toBe(true);
    expect(isDebugQuery('?debug=1&x=2')).toBe(true);
    expect(isDebugQuery('?x=2&debug=1')).toBe(true);
    // 下面这些都必须是 false：verify 不能误开面板，debug=0 也不算
    expect(isDebugQuery('?debug=0')).toBe(false);
    expect(isDebugQuery('?debug=10')).toBe(false);
    expect(isDebugQuery('?debug=')).toBe(false);
    expect(isDebugQuery('')).toBe(false);
    expect(isDebugQuery('?verify=1')).toBe(false);
  });

  it('dev 构建无条件启用（开发时不用带参数）', () => {
    expect(shouldEnableDebugPanel({ isDev: true, mode: 'development', search: '' })).toBe(true);
    expect(shouldEnableDebugPanel({ isDev: true, mode: 'development', search: '?debug=0' })).toBe(
      true,
    );
  });

  it('生产构建永远不启用 —— 即使 URL 带 ?debug=1', () => {
    // 这条是"不许自欺欺人"的守门：生产产物里根本没有面板代码，
    // 如果这个函数返回 true，就会有人以为"线上带参数能开面板"。
    expect(shouldEnableDebugPanel({ isDev: false, mode: 'production', search: '?debug=1' })).toBe(
      false,
    );
    expect(shouldEnableDebugPanel({ isDev: false, mode: 'production', search: '' })).toBe(false);
  });

  it('--mode debug 构建：只在 ?debug=1 时启用', () => {
    expect(shouldEnableDebugPanel({ isDev: false, mode: 'debug', search: '?debug=1' })).toBe(true);
    expect(shouldEnableDebugPanel({ isDev: false, mode: 'debug', search: '' })).toBe(false);
    expect(shouldEnableDebugPanel({ isDev: false, mode: 'debug', search: '?verify=1' })).toBe(false);
  });
});

describe('M11 面板：StepWindow（近 60 帧物理步耗时）', () => {
  it('窗口未满时只统计已采集的样本', () => {
    const w = new StepWindow(4);
    expect(w.sampleCount).toBe(0);
    expect(w.avg).toBe(0);
    expect(w.max).toBe(0);

    w.push(1);
    w.push(3);
    expect(w.sampleCount).toBe(2);
    expect(w.avg).toBe(2);
    expect(w.max).toBe(3);
  });

  it('窗口满了以后丢弃最旧样本（环形覆盖，sum 不能漂）', () => {
    const w = new StepWindow(3);
    w.push(10);
    w.push(10);
    w.push(10);
    expect(w.avg).toBe(10);

    // 覆盖第一个 10 → 窗口变成 [2,10,10]，均值 22/3
    w.push(2);
    expect(w.sampleCount).toBe(3);
    expect(w.avg).toBeCloseTo(22 / 3, 10);
    expect(w.max).toBe(10);

    // 再覆盖一个 → [2,2,10] = 14/3
    w.push(2);
    expect(w.avg).toBeCloseTo(14 / 3, 10);
  });

  it('默认窗口是 60 帧（spec 要求"最近 60 帧"）', () => {
    expect(STEP_WINDOW_SIZE).toBe(60);
    expect(new StepWindow().size).toBe(60);
  });

  it('非法输入被夹成 0，不污染均值（NaN 会让整个面板显示 NaN）', () => {
    const w = new StepWindow(2);
    w.push(Number.NaN);
    w.push(-5);
    w.push(Infinity);
    expect(w.avg).toBe(0);
    expect(w.max).toBe(0);
    expect(w.sampleCount).toBe(2);
  });

  it('size 必须是 ≥1 的整数', () => {
    expect(() => new StepWindow(0)).toThrow(RangeError);
    expect(() => new StepWindow(-1)).toThrow(RangeError);
    expect(() => new StepWindow(1.5)).toThrow(RangeError);
  });

  it('reset 清空所有统计', () => {
    const w = new StepWindow(3);
    w.push(5);
    w.push(7);
    w.reset();
    expect(w.sampleCount).toBe(0);
    expect(w.avg).toBe(0);
    expect(w.max).toBe(0);
  });
});

describe('M11 面板：文本格式（spec §6 M11 第 2 条的六项指标都要在）', () => {
  it('指标行包含 fps / 帧耗时 / 物理步均峰 / 刚体 / 实体 / overrun', () => {
    const text = formatMetrics(baseMetrics());
    expect(text).toContain('fps');
    expect(text).toContain('60.0');
    expect(text).toContain('帧耗时');
    expect(text).toContain('16.67ms');
    // 物理步必须同时给均值和最大值（spec 明写"均值/最大值"）
    expect(text).toContain('1.23ms 均');
    expect(text).toContain('3.46ms 峰');
    expect(text).toContain('近 60 帧');
    expect(text).toContain('刚体');
    expect(text).toContain('7');
    expect(text).toContain('实体');
    expect(text).toContain('overrun');
  });

  it('数值精度固定，不会因为浮点尾数抖动而改变面板宽度', () => {
    const a = formatMetrics(baseMetrics({ fps: 59.999999, physicsAvgMs: 1.005 }));
    const b = formatMetrics(baseMetrics({ fps: 60.0, physicsAvgMs: 1.0 }));
    expect(a.split('\n')[0]).toBe('fps        60.0');
    expect(b.split('\n')[0]).toBe('fps        60.0');
    expect(a.split('\n')[2]).toBe(b.split('\n')[2]);
  });

  it('三个开关状态都在，且按键提示与 spec 一致（D/G/P）', () => {
    const off = formatToggles(baseMetrics());
    expect(off).toContain('物理线框 关（D）');
    expect(off).toContain('网格     开（G）');
    expect(off).toContain('运行中（P）');

    const on = formatToggles(
      baseMetrics({ physicsWireframe: true, gridVisible: false, paused: true }),
    );
    expect(on).toContain('物理线框 开（D）');
    expect(on).toContain('网格     关（G）');
    expect(on).toContain('已暂停（P）');
  });
});

/** 造一个"假 DOM"：够 DebugPanel 用，避免引入 jsdom。 */
interface FakeEl {
  tagName: string;
  id: string;
  style: { cssText: string };
  dataset: Record<string, string>;
  textContent: string;
  children: FakeEl[];
  parent: FakeEl | null;
  appendChild(c: FakeEl): FakeEl;
  remove(): void;
  ownerDocument?: FakeDoc;
}

interface FakeDoc {
  body: FakeEl;
  createElement(tag: string): FakeEl;
}

function makeFakeDom(): { doc: FakeDoc; body: FakeEl; makeEl: (tag: string) => FakeEl } {
  const makeEl = (tag: string): FakeEl => {
    const el: FakeEl = {
      tagName: tag.toUpperCase(),
      id: '',
      style: { cssText: '' },
      dataset: {},
      textContent: '',
      children: [],
      parent: null,
      appendChild(c: FakeEl) {
        c.parent = el;
        el.children.push(c);
        return c;
      },
      remove() {
        if (!el.parent) return;
        const i = el.parent.children.indexOf(el);
        if (i >= 0) el.parent.children.splice(i, 1);
        el.parent = null;
      },
    };
    return el;
  };
  const body = makeEl('body');
  const doc: FakeDoc = {
    body,
    createElement: (tag: string) => {
      const el = makeEl(tag);
      el.ownerDocument = doc;
      return el;
    },
  };
  return { doc, body, makeEl };
}

/** 记录调用次数的动作桩。 */
function makeActions(): DebugActions & { calls: string[] } {
  const calls: string[] = [];
  return {
    calls,
    togglePhysicsWireframe() {
      calls.push('wireframe');
      return true;
    },
    toggleGrid() {
      calls.push('grid');
      return true;
    },
    togglePausePhysics() {
      calls.push('pause');
      return true;
    },
  };
}

/** 最小 KeyEvent 形状（DebugPanel 只读这几个字段）。 */
function keyEvent(key: string, over: Partial<KeyboardEvent> = {}): KeyboardEvent {
  return {
    key,
    ctrlKey: false,
    metaKey: false,
    altKey: false,
    repeat: false,
    target: null,
    preventDefault() {},
    ...over,
  } as unknown as KeyboardEvent;
}

describe('M11 面板：DOM 生命周期与按键', () => {
  let dom: ReturnType<typeof makeFakeDom>;
  let container: FakeEl;

  beforeEach(() => {
    dom = makeFakeDom();
    container = dom.makeEl('div');
    // DebugPanel 通过 `container.ownerDocument` 找 document；假 DOM 里手动接上，
    // 这样测试覆盖的是"真实挂载路径"，而不是绕过它。
    container.ownerDocument = dom.doc;
  });

  /** 用假 container 造面板（DebugPanel 会读 container.ownerDocument）。 */
  function makePanel(actions: DebugActions, opts: { bindKeys?: boolean } = {}): DebugPanel {
    return new DebugPanel(() => baseMetrics(), actions, {
      container: container as unknown as HTMLElement,
      bindKeys: opts.bindKeys ?? false,
    });
  }

  it('构造函数不碰 DOM（这样 node 单测能直接 new）', () => {
    const p = makePanel(makeActions());
    expect(p.mounted).toBe(false);
    expect(container.children).toHaveLength(0);
    expect(dom.body.children).toHaveLength(0);
  });

  it('mount 后把面板挂进容器，并带 marker（产物 grep 用的那个字符串）', () => {
    const p = makePanel(makeActions());
    p.mount();
    expect(p.mounted).toBe(true);
    expect(container.children).toHaveLength(1);
    const root = container.children[0]!;
    expect(root.id).toBe('aio-debug-panel');
    expect(root.dataset['marker']).toBe(DEBUG_PANEL_MARKER);
    // 关键：不能吃指针事件，否则左上角的相机拖拽会断
    expect(root.style.cssText).toContain('pointer-events:none');
    // 面板里必须真的写进了指标文本
    expect(root.children[0]!.textContent).toContain('fps');
    expect(root.children[1]!.textContent).toContain('物理线框');
  });

  it('mount 幂等：重复调不会挂两个面板', () => {
    const p = makePanel(makeActions());
    p.mount();
    p.mount();
    expect(container.children).toHaveLength(1);
  });

  it('dispose 摘掉 DOM 与按键监听', () => {
    const p = makePanel(makeActions());
    p.mount();
    p.dispose();
    expect(p.mounted).toBe(false);
    expect(container.children).toHaveLength(0);
    // dispose 后再 mount 不应复活（已 disposed 的实例是死的）
    p.mount();
    expect(p.mounted).toBe(false);
  });

  it('update 按 refreshMs 节流（每帧写 DOM 会让布局抖动吃掉 fps）', () => {
    let reads = 0;
    const p = new DebugPanel(
      () => {
        reads += 1;
        return baseMetrics();
      },
      makeActions(),
      { container: container as unknown as HTMLElement, bindKeys: false },
    );
    p.mount();
    const afterMount = reads; // mount 里 render 了一次

    // 同一毫秒内连打 5 次 update：只有第一次跨过阈值
    p.update(PANEL_REFRESH_MS);
    expect(reads).toBe(afterMount + 1);
    p.update(PANEL_REFRESH_MS + 1);
    p.update(PANEL_REFRESH_MS + 2);
    expect(reads).toBe(afterMount + 1);

    // 再等一个周期
    p.update(PANEL_REFRESH_MS * 2);
    expect(reads).toBe(afterMount + 2);
  });

  it('D / G / P 分别触发三个动作，且按键后立刻重绘', () => {
    const actions = makeActions();
    const p = new DebugPanel(() => baseMetrics(), actions, {
      container: container as unknown as HTMLElement,
      bindKeys: true,
      keyTarget: {
        addEventListener: (_t: string, fn: (e: KeyboardEvent) => void) => {
          (globalThis as { __h?: unknown }).__h = fn;
        },
        removeEventListener: () => {},
      } as unknown as Window,
    });
    p.mount();

    const handler = (globalThis as { __h?: (e: KeyboardEvent) => void }).__h!;
    expect(typeof handler).toBe('function');

    handler(keyEvent('d'));
    handler(keyEvent('G'));
    handler(keyEvent('p'));
    expect(actions.calls).toEqual(['wireframe', 'grid', 'pause']);
  });

  it('按键守卫：输入框 / 组合键 / 长按重复都不触发', () => {
    const actions = makeActions();
    const p = new DebugPanel(() => baseMetrics(), actions, {
      container: container as unknown as HTMLElement,
      bindKeys: true,
      keyTarget: {
        addEventListener: (_t: string, fn: (e: KeyboardEvent) => void) => {
          (globalThis as { __h2?: unknown }).__h2 = fn;
        },
        removeEventListener: () => {},
      } as unknown as Window,
    });
    p.mount();
    const handler = (globalThis as { __h2?: (e: KeyboardEvent) => void }).__h2!;

    // 输入框里按 d 是在打字
    handler(keyEvent('d', { target: { tagName: 'INPUT' } as unknown as EventTarget }));
    handler(keyEvent('d', { target: { tagName: 'TEXTAREA' } as unknown as EventTarget }));
    handler(
      keyEvent('d', { target: { isContentEditable: true } as unknown as EventTarget }),
    );
    // 浏览器快捷键
    handler(keyEvent('d', { ctrlKey: true }));
    handler(keyEvent('g', { metaKey: true }));
    handler(keyEvent('p', { altKey: true }));
    // 长按自动重复会让开关狂闪
    handler(keyEvent('d', { repeat: true }));

    expect(actions.calls).toEqual([]);
  });

  it('非 D/G/P 的键完全不管（不能吞掉别人的快捷键）', () => {
    const actions = makeActions();
    let prevented = 0;
    const p = new DebugPanel(() => baseMetrics(), actions, {
      container: container as unknown as HTMLElement,
      bindKeys: true,
      keyTarget: {
        addEventListener: (_t: string, fn: (e: KeyboardEvent) => void) => {
          (globalThis as { __h3?: unknown }).__h3 = fn;
        },
        removeEventListener: () => {},
      } as unknown as Window,
    });
    p.mount();
    const handler = (globalThis as { __h3?: (e: KeyboardEvent) => void }).__h3!;

    handler(keyEvent('w', { preventDefault: () => (prevented += 1) }));
    handler(keyEvent('Space', { preventDefault: () => (prevented += 1) }));
    expect(actions.calls).toEqual([]);
    expect(prevented).toBe(0); // 也不该 preventDefault
  });

  it('node 环境（没有 document）下 mount 静默跳过，不抛', () => {
    const p = new DebugPanel(() => baseMetrics(), makeActions(), { bindKeys: false });
    expect(() => p.mount()).not.toThrow();
    expect(p.mounted).toBe(false);
    expect(() => p.dispose()).not.toThrow();
  });
});
