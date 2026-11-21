/**
 * M11 调试面板（spec §6 M11）：`?debug=1` 或 dev 构建下的可观测浮层。
 *
 * 三条纪律，每条都对应一个踩过的坑：
 *
 * 1. **生产构建必须被 tree-shake 掉。**
 *    `main.ts` 里的守卫写成 `import.meta.env.DEV || import.meta.env.MODE === 'debug'`，
 *    两者都是**编译期字面量**，生产构建里折叠成 `false`，Rollup 把整个
 *    `import('./render/debug')` 丢掉，本文件连 chunk 都不会产出。
 *    所以这里**不许**有顶层副作用（不许在模块顶层 `document.createElement` /
 *    `addEventListener`）——所有副作用必须在 `installDebugPanel()` 里发生。
 *    验证：`node tools/verify-debug-treeshake.mjs`（在产物里 grep marker 字符串）。
 *
 * 2. **面板不能吃掉指针事件。**
 *    浮层用 `pointer-events:none`：否则鼠标拖到左上角时相机拖拽会断掉，
 *    而"相机在某个区域失灵"这种 bug 极难和输入逻辑本身的问题区分开。
 *
 * 3. **不引 UI 库。**
 *    一个 `div` + `textContent` 就够。为了面板多 100KB 依赖是拿主线程预算开玩笑。
 *
 * 关于"物理步耗时（近 60 帧）"的口径：引擎 `stats()` 给的是**近 60 步**的均值/最大，
 * 而面板要的是**近 60 帧**。60fps 下两者等价，掉帧时不等价（一帧可能跑 2~3 步）。
 * 所以面板自己维护 60 槽窗口，每帧 push 一次"这一帧里物理总共花了多少毫秒"，
 * 数字与"玩家感觉到的一帧里物理占了多少"严格对应。
 */

import * as THREE from 'three';
import type { Clock } from '../core/clock';
import type { World } from '../core/world';
import type { PhysicsWorld } from '../physics/engine';
import type { ThirdPersonCamera } from './camera';
import type { WorldRenderer } from './scene';
import { PhysicsDebugDraw, bindDebugDrawRapier } from '../physics/debug-draw';

/** 产物 grep 用的标记。改了这里要同步改 `tools/verify-debug-treeshake.mjs`。 */
export const DEBUG_PANEL_MARKER = '__AIO_DEBUG_PANEL__';

/** 面板统计窗口：60 帧 ≈ 1 秒。 */
export const STEP_WINDOW_SIZE = 60;

/** 面板刷新频率（毫秒）。每帧写 DOM 会让布局抖动吃掉 fps，4Hz 足够读数。 */
export const PANEL_REFRESH_MS = 250;

/** 只认 `?debug=1`（与 `?verify=1` 同一套正则风格，避免两处规则漂移）。 */
export function isDebugQuery(search: string): boolean {
  return /[?&]debug=1(?:&|$)/.test(search);
}

/**
 * 是否启用面板（spec §6 M11 第 1 条「只在 ?debug=1 或 dev 构建下启用」）。
 *
 * - dev server（`import.meta.env.DEV`）→ 启用，开发时不用额外带参数
 * - `--mode debug` 构建 → 只在 `?debug=1` 时启用（用于在真机 GPU 上量 fps）
 * - **生产构建（mode=production）→ 永远 false**，即使 URL 带 `?debug=1`。
 *   这条不是"顺手加的"：面板代码在生产构建里根本不存在，
 *   所以"带参数就出现面板"在生产上不可能成立，返回 true 只是自欺欺人。
 */
export function shouldEnableDebugPanel(opts: {
  isDev: boolean;
  mode: string;
  search: string;
}): boolean {
  if (opts.isDev) return true;
  if (opts.mode !== 'debug') return false;
  return isDebugQuery(opts.search);
}

/** 面板要显示的指标。 */
export interface DebugMetrics {
  fps: number;
  frameMs: number;
  /** 近 60 帧的物理步耗时均值（毫秒）。 */
  physicsAvgMs: number;
  /** 近 60 帧的物理步耗时最大值（毫秒）。 */
  physicsMaxMs: number;
  /** 刚体总数（含 kinematic 的角色——只数 dynamic 会显示 0，见 readMetrics 注释）。 */
  rigidBodies: number;
  /** 其中动态刚体数（道具）。 */
  dynamicBodies: number;
  /** 启用中的碰撞体总数。 */
  colliders: number;
  /** 实体数（World 的 actor 表大小）。 */
  entities: number;
  /** 时钟因超过 maxSteps 丢弃时间的次数。 */
  overruns: number;
  /**
   * 累计被丢弃的时间（秒）。可选：老的测试夹具没这个字段时按 0 处理。
   *
   * 为什么光有次数不够：`overrun 55` 这个数字本身不说明问题——
   * 在 4fps 的软渲染下它是**必然**（每帧必超 maxSteps），在 60fps 真机上它是 0。
   * 配上"丢弃秒数 / 世界时间"的比值才能判断严重程度。
   */
  droppedSeconds?: number;
  /** 世界时间（秒）。与 droppedSeconds 一起算出"时间丢弃率"。 */
  worldTime?: number;
  /** 物理层自己记的 overrun（与时钟独立，两者都看才不漏）。 */
  physicsOverruns: number;
  drawCalls: number;
  triangles: number;
  tier: string;
  dpr: number;
  paused: boolean;
  physicsWireframe: boolean;
  gridVisible: boolean;
}

/** 面板按键能触发的三个动作（spec §6 M11 第 3 条）。 */
export interface DebugActions {
  togglePhysicsWireframe(): boolean;
  toggleGrid(): boolean;
  togglePausePhysics(): boolean;
}

/**
 * 固定窗口的耗时统计（最近 N 个样本的均值/最大值）。
 *
 * 用 `Float64Array` 环形缓冲而不是 `Array.shift()`：后者每次 push 都是 O(n)，
 * 60 槽在 60fps 下每秒 60 次 shift，纯属白烧 CPU。
 */
export class StepWindow {
  private readonly buf: Float64Array;
  private count = 0;
  private cursor = 0;
  private sum = 0;

  constructor(readonly size: number = STEP_WINDOW_SIZE) {
    if (!Number.isInteger(size) || size < 1) {
      throw new RangeError(`StepWindow: size 必须是 ≥1 的整数，收到 ${size}`);
    }
    this.buf = new Float64Array(size);
  }

  /** 已采集的样本数（≤ size）。 */
  get sampleCount(): number {
    return this.count;
  }

  push(ms: number): void {
    const v = Number.isFinite(ms) && ms > 0 ? ms : 0;
    if (this.count < this.size) {
      this.buf[this.cursor] = v;
      this.sum += v;
      this.count += 1;
    } else {
      // 满了：覆盖最旧的，先减后加，sum 永远等于窗口内之和
      this.sum -= this.buf[this.cursor]!;
      this.buf[this.cursor] = v;
      this.sum += v;
    }
    this.cursor = (this.cursor + 1) % this.size;
  }

  get avg(): number {
    return this.count === 0 ? 0 : this.sum / this.count;
  }

  get max(): number {
    let m = 0;
    for (let i = 0; i < this.count; i++) {
      const v = this.buf[i]!;
      if (v > m) m = v;
    }
    return m;
  }

  reset(): void {
    this.buf.fill(0);
    this.count = 0;
    this.cursor = 0;
    this.sum = 0;
  }
}

/** 把指标排成面板上的多行文本（纯函数，单测直接断言）。 */export function formatMetrics(m: DebugMetrics): string {
  const lines = [
    `fps        ${m.fps.toFixed(1)}`,
    `帧耗时     ${m.frameMs.toFixed(2)}ms`,
    `物理步     ${m.physicsAvgMs.toFixed(2)}ms 均 / ${m.physicsMaxMs.toFixed(2)}ms 峰（近 ${STEP_WINDOW_SIZE} 帧）`,
    // 刚体总数 + 动态数：只给一个数字会让人以为"全是动态的"或"没刚体"
    `刚体       ${m.rigidBodies}（动态 ${m.dynamicBodies} · 碰撞体 ${m.colliders}）`,
    `实体       ${m.entities}`,
    // overrun 单独看次数会误导：4fps 软渲染下每帧必 overrun，60fps 真机是 0。
    // 所以同时给出"丢弃了多少秒"与"丢弃率"，一眼能判断是帧率问题还是物理问题。
    `overrun    ${m.overruns}（物理 ${m.physicsOverruns}）丢弃 ${(m.droppedSeconds ?? 0).toFixed(1)}s${
      (m.droppedSeconds ?? 0) > 0 && (m.worldTime ?? 0) > 0
        ? ` / 世界 ${(m.worldTime ?? 0).toFixed(1)}s（${Math.round(((m.droppedSeconds ?? 0) / (m.worldTime ?? 1)) * 100)}%）`
        : ''
    }`,
    `drawCall   ${m.drawCalls} / 三角面 ${m.triangles}`,
    `档位       ${m.tier} · dpr ${m.dpr.toFixed(2)}`,
  ];
  return lines.join('\n');
}

/** 面板上的开关状态行：每按一次键就变，和数字分开更好读。 */
export function formatToggles(m: DebugMetrics): string {
  return [
    `物理线框 ${m.physicsWireframe ? '开' : '关'}（D）`,
    `网格     ${m.gridVisible ? '开' : '关'}（G）`,
    `物理     ${m.paused ? '已暂停' : '运行中'}（P）`,
  ].join('   ');
}

/**
 * 数**启用中的全部刚体**（不区分 dynamic / kinematic / fixed）。
 *
 * 为什么不能直接用 `PhysicsWorld.stats().dynamicBodies`：
 * 角色胶囊是 `kinematicPositionBased`（位移由自写控制器算，spec §6 M4），
 * 所以只有角色的场景里 dynamicBodies = 0。面板显示"刚体 0"、
 * 而画面里 7 个角色在动，这种数字比不给数字更误导人。
 *
 * 只读遍历：`forEachRigidBody` 是 Rapier 的只读访问器，不改世界状态。
 */
export function countRigidBodies(pw: PhysicsWorld | null): number {
  if (!pw) return 0;
  let n = 0;
  pw.world.forEachRigidBody((b) => {
    // 池里闲置的道具 body 仍然挂在世界上（setEnabled(false)），不能算
    if (b.isEnabled()) n += 1;
  });
  return n;
}

/**
 * 面板 DOM 本体。
 *
 * 生命周期：`new DebugPanel(...)`（无副作用）→ `mount()`（建 DOM、挂键）→ `update()` → `dispose()`。
 * 构造函数**不碰 DOM**，这样 node 单测可以直接 `new` 出来测逻辑。
 */
export class DebugPanel {
  private root: HTMLDivElement | null = null;
  private metricsEl: HTMLPreElement | null = null;
  private togglesEl: HTMLDivElement | null = null;
  private keyHandler: ((e: KeyboardEvent) => void) | null = null;
  private keyTarget: Pick<Window, 'addEventListener' | 'removeEventListener'> | null = null;
  private lastRenderAt = 0;
  private disposed = false;

  constructor(
    private readonly read: () => DebugMetrics,
    private readonly actions: DebugActions,
    private readonly opts: {
      /** 挂载容器，默认 document.body。 */
      container?: HTMLElement;
      /** 按键宿主，默认 window。 */
      keyTarget?: Window;
      /** 是否自动挂 D/G/P 键。e2e 里通常关掉，直接调 actions。 */
      bindKeys?: boolean;
      /** 刷新间隔（毫秒）。 */
      refreshMs?: number;
    } = {},
  ) {}

  /** 建 DOM 并挂键。重复调用是幂等的。 */
  mount(): void {
    if (this.disposed || this.root) return;
    const doc = this.opts.container?.ownerDocument ?? globalThis.document;
    if (!doc) return; // node 环境：静默不挂，逻辑仍可测

    const root = doc.createElement('div');
    root.id = 'aio-debug-panel';
    root.dataset['marker'] = DEBUG_PANEL_MARKER;
    root.style.cssText = [
      'position:fixed',
      'top:8px',
      'left:8px',
      'z-index:2147483647',
      // 关键：不吃指针事件，否则左上角的相机拖拽会断
      'pointer-events:none',
      'padding:8px 10px',
      'border-radius:6px',
      'background:rgba(12,16,22,0.78)',
      'border:1px solid rgba(120,140,170,0.35)',
      'color:#cfe0f5',
      'font:11px/1.5 ui-monospace,SFMono-Regular,Menlo,Consolas,monospace',
      'white-space:pre',
      'text-shadow:0 1px 2px rgba(0,0,0,0.8)',
    ].join(';');

    const metrics = doc.createElement('pre');
    metrics.style.cssText = 'margin:0;font:inherit;white-space:pre';
    root.appendChild(metrics);

    const toggles = doc.createElement('div');
    toggles.style.cssText =
      'margin-top:6px;padding-top:6px;border-top:1px solid rgba(120,140,170,0.25)';
    root.appendChild(toggles);

    (this.opts.container ?? doc.body).appendChild(root);
    this.root = root;
    this.metricsEl = metrics;
    this.togglesEl = toggles;

    if (this.opts.bindKeys ?? true) {
      const target = this.opts.keyTarget ?? (typeof window !== 'undefined' ? window : null);
      if (target) {
        this.keyTarget = target;
        this.keyHandler = (e: KeyboardEvent) => this.onKey(e);
        target.addEventListener('keydown', this.keyHandler);
      }
    }

    this.render();
  }

  /**
   * 按键处理（spec §6 M11 第 3 条）：D 物理线框 / G 网格 / P 暂停物理。
   *
   * 三条守卫都不是可选的：
   * - 输入框里按 d 是在打字，不是切线框；
   * - 带 ctrl/meta/alt 是浏览器快捷键（Ctrl+D 收藏、Cmd+G 查找下一个）；
   * - 长按的自动重复会让开关狂闪，所以忽略 `e.repeat`。
   */
  private onKey(e: KeyboardEvent): void {
    if (e.ctrlKey || e.metaKey || e.altKey) return;
    if (e.repeat) return;
    const t = e.target as (HTMLElement & { tagName?: string }) | null;
    const tag = t?.tagName;
    if (tag === 'INPUT' || tag === 'TEXTAREA' || t?.isContentEditable) return;

    const k = e.key.toLowerCase();
    if (k === 'd') this.actions.togglePhysicsWireframe();
    else if (k === 'g') this.actions.toggleGrid();
    else if (k === 'p') this.actions.togglePausePhysics();
    else return;

    e.preventDefault();
    this.render(); // 立刻反映，不等下一个 250ms 周期
  }

  /** 按 `refreshMs` 节流重绘。 */
  update(nowMs: number): void {
    if (this.disposed || !this.root) return;
    const refresh = this.opts.refreshMs ?? PANEL_REFRESH_MS;
    if (nowMs - this.lastRenderAt < refresh) return;
    this.lastRenderAt = nowMs;
    this.render();
  }

  /** 立即重绘（按键后、或测试里直接调）。 */
  render(): void {
    if (this.disposed || !this.metricsEl || !this.togglesEl) return;
    const m = this.read();
    this.metricsEl.textContent = formatMetrics(m);
    this.togglesEl.textContent = formatToggles(m);
  }

  /** 面板是否已挂到 DOM 上（e2e 断言用）。 */
  get mounted(): boolean {
    return this.root !== null;
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    if (this.keyHandler && this.keyTarget) {
      this.keyTarget.removeEventListener('keydown', this.keyHandler);
    }
    this.keyHandler = null;
    this.keyTarget = null;
    this.root?.remove();
    this.root = null;
    this.metricsEl = null;
    this.togglesEl = null;
  }
}

// ───────────────────────────── 接线（只在 debug chunk 里存在） ─────────────────────────────

/** `main.ts` 传给面板的实时状态。用 getter 而不是快照，避免每帧 new 对象。 */
export interface DebugHostDeps {
  renderer: WorldRenderer;
  camera: ThirdPersonCamera;
  clock: Clock;
  world: World;
  /** 物理可能异步就绪/初始化失败，所以必须每次现取。 */
  getPhysics(): PhysicsWorld | null;
  /** Rapier 命名空间（debug draw 解析形状类要用），可能还没就绪。 */
  getRapier(): unknown;
  /** 主场景的网格线（桌面档才有），可能为 null。 */
  getGrid(): THREE.Object3D | null;
  /** 本帧物理总共花了多少毫秒（含一帧内的多步）。 */
  getFramePhysicsMs(): number;
  /** 累计物理步数（`__aioDebug.probe()` 用；不进面板文字）。 */
  getPhysicsSteps(): number;
  /** 物理是否被面板暂停。 */
  isPhysicsPaused(): boolean;
  /** 设暂停态。 */
  setPhysicsPaused(v: boolean): void;
  /** 面板是否已挂载（`window.__aioDebug` 读它做 e2e 断言）。 */
  container?: HTMLElement;
}

/** `installDebugPanel()` 的返回值：每帧 tick 一次，卸载时 dispose。 */
export interface DebugHandle {
  /** 每帧调（未节流：debug draw 要逐帧同步，面板文字内部才节流）。 */
  tick(nowMs: number): void;
  /** 面板 DOM 是否已挂上。 */
  readonly mounted: boolean;
  dispose(): void;
}

/**
 * 装上 M11 面板 + 物理线框。
 *
 * 只从 `main.ts` 的**编译期守卫**里动态 import 本函数，
 * 生产构建中那段 import 会被整块删除，所以这里的一切都不会进产物。
 */
export function installDebugPanel(deps: DebugHostDeps): DebugHandle {
  const stepWindow = new StepWindow(STEP_WINDOW_SIZE);

  let physicsPaused = false;
  let gridVisible = false;
  let debugDraw: PhysicsDebugDraw | null = null;
  let debugDrawRapierBound = false;

  /** 惰性建物理线框：物理与 Rapier 都可能还没就绪，所以不能在建面板时就 new。 */
  const ensureDebugDraw = (): PhysicsDebugDraw | null => {
    const pw = deps.getPhysics();
    if (!pw) return null;
    if (!debugDraw) {
      const ns = deps.getRapier();
      if (!ns) return null;
      if (!debugDrawRapierBound) {
        bindDebugDrawRapier(ns);
        debugDrawRapierBound = true;
      }
      // bindKey:false —— D 键由面板统一处理。两处都挂会让一次按键切两次 = 净零。
      debugDraw = new PhysicsDebugDraw(deps.renderer.scene, {
        visible: false,
        capacity: 512,
        bindKey: false,
      });
    }
    return debugDraw;
  };

  /**
   * 网格线。桌面档 main.ts 已经建了一个，这里只切它的可见性；
   * 移动端没有（省一次 drawCall），G 按下时就地补一个，
   * 否则这个键在移动端是死的——"按键存在但无效果"比没有这个键更误导。
   */
  const toggleGrid = (): boolean => {
    const existing = deps.getGrid();
    if (existing) {
      existing.visible = !existing.visible;
      gridVisible = existing.visible;
      return gridVisible;
    }
    const grid = new THREE.GridHelper(24, 24, 0x3d4552, 0x252a33);
    grid.position.y = 0.002;
    grid.name = 'debug-grid';
    deps.renderer.scene.add(grid);
    gridVisible = true;
    return true;
  };

  const actions: DebugActions = {
    togglePhysicsWireframe(): boolean {
      const dd = ensureDebugDraw();
      if (!dd) return false;
      dd.setVisible(!dd.visible);
      return dd.visible;
    },
    toggleGrid,
    togglePausePhysics(): boolean {
      physicsPaused = !physicsPaused;
      deps.setPhysicsPaused(physicsPaused);
      return physicsPaused;
    },
  };

  const readMetrics = (): DebugMetrics => {
    const rs = deps.renderer.getStats();
    const pw = deps.getPhysics();
    const ps = pw?.stats();
    return {
      fps: rs.fps,
      frameMs: rs.frameMs,
      physicsAvgMs: Math.round(stepWindow.avg * 100) / 100,
      physicsMaxMs: Math.round(stepWindow.max * 100) / 100,
      // 刚体总数：**必须**数全部，不能只用 `stats().dynamicBodies`。
      // 实测踩到的坑：角色胶囊是 `kinematicPositionBased`（spec §6 M4 要求，
      // 因为位移由自写控制器算，不该让求解器再推一次），
      // 所以 `dynamicBodies` 在只有角色的场景里是 **0** ——
      // 面板显示"刚体 0"而画面里明明有 7 个角色，这种数字比没有数字更误导人。
      rigidBodies: countRigidBodies(pw),
      dynamicBodies: ps?.dynamicBodies ?? 0,
      colliders: ps?.colliders ?? 0,
      entities: deps.world.actorCount,
      overruns: deps.clock.overruns,
      droppedSeconds: deps.clock.droppedSeconds,
      worldTime: deps.clock.worldTime,
      physicsOverruns: ps?.overruns ?? 0,
      drawCalls: rs.drawCalls,
      triangles: rs.triangles,
      tier: deps.renderer.tier.kind,
      dpr: deps.renderer.renderer.getPixelRatio(),
      paused: physicsPaused,
      physicsWireframe: debugDraw?.visible ?? false,
      gridVisible: deps.getGrid()?.visible ?? gridVisible,
    };
  };

  const panel = new DebugPanel(readMetrics, actions, {
    container: deps.container,
    refreshMs: PANEL_REFRESH_MS,
  });
  panel.mount();

  // e2e / 手工排障口。只在 debug chunk 里存在，生产构建没有。
  //
  // 为什么它自带 `physicsSteps` / `tick`：`__worldDebug` 只在 **dev** 构建存在，
  // 而面板要在 `--mode debug` 的生产产物里也能验收（那条路径才是"真机 GPU 上量 fps"用的）。
  // 如果 e2e 只能靠 `__worldDebug`，那 debug 构建就永远测不了——验收路径本身就成了缺口。
  // 所以这个口自己把 e2e 需要的量都暴露出来，不依赖另一个只在 dev 存在的口。
  (window as unknown as { __aioDebug?: unknown }).__aioDebug = {
    marker: DEBUG_PANEL_MARKER,
    mounted: (): boolean => panel.mounted,
    read: (): DebugMetrics => readMetrics(),
    /** e2e 用来判"物理停了但世界还在动"的探针。 */
    probe: (): { physicsSteps: number; tick: number; entities: number; paused: boolean } => ({
      physicsSteps: deps.getPhysicsSteps(),
      tick: deps.world.tickCount,
      entities: deps.world.actorCount,
      paused: physicsPaused,
    }),
    togglePhysicsWireframe: () => actions.togglePhysicsWireframe(),
    toggleGrid: () => actions.toggleGrid(),
    togglePausePhysics: () => actions.togglePausePhysics(),
    stepWindowSize: STEP_WINDOW_SIZE,
  };

  return {
    tick(nowMs: number): void {
      // 1) 收样本：本帧物理耗时（掉帧时一帧多步会一次累加进去，口径见文件头）
      stepWindow.push(deps.getFramePhysicsMs());

      // 2) 物理线框逐帧同步（不可见时 sync 内部直接 return，零成本）
      if (debugDraw && debugDraw.visible) {
        const pw = deps.getPhysics();
        if (pw) debugDraw.sync(pw.world);
      }

      // 3) 面板文字 4Hz 刷新
      panel.update(nowMs);
    },
    get mounted(): boolean {
      return panel.mounted;
    },
    dispose(): void {
      panel.dispose();
      debugDraw?.dispose();
      debugDraw = null;
      delete (window as unknown as { __aioDebug?: unknown }).__aioDebug;
    },
  };
}
