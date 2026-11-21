/**
 * 渲染内核（spec §6 M1）。
 *
 * 设计取舍，写在这里免得后人踩回去：
 * 1. **渲染循环不碰物理**。rAF 只算 dt 交给 Clock；Clock 决定这一步跑几步物理。
 *    渲染拿到的是 alpha（0..1），用插值画，所以 120Hz 屏上是"补间"而不是"两帧一样"。
 * 2. **resize 用 ResizeObserver 而不是 window.onresize**。canvas 所在容器可能被 HUD/侧栏
 *    挤小而不触发 window resize（嵌入式 iframe、分屏、DevTools 打开都会踩到）。
 * 3. **降级是构建期就决定的，不是运行时反复试探**。移动端一次判定：关阴影、DPR≤1.6。
 *    反复开关阴影会导致 shader 重编译，表现为进房第一秒卡顿。
 * 4. **不引入后处理链**（spec 明说 v0.1 不需要）：EffectComposer 会让整条管线多一次全屏拷贝，
 *    并且让 renderer.info 的 drawCalls 失真。
 */

import * as THREE from 'three';
// RoomEnvironment：three 自带的程序化室内环境，用于 IBL（不需下载 HDR 资产）。
// 动态 import 会让首帧多一次往返，而这个模块很小（~4KB），直接静态引入。
import { RoomEnvironment } from 'three/examples/jsm/environments/RoomEnvironment.js';
import {
  LIGHTING_PRESETS,
  DEFAULT_PRESET,
  blendPreset,
  advanceTransition,
  smoothstep,
  type LightingPreset,
  type BlendableColor,
} from './lighting';
import { Rain } from './rain';
import { RoomVisual, type ActorSource } from './env';
import type { Room } from '../core/room';

export interface QualityTier {
  /** 'mobile' 时关阴影、压 DPR。 */
  kind: 'desktop' | 'mobile';
  /** devicePixelRatio 上限。 */
  maxDpr: number;
  /** 是否开方向光阴影。 */
  shadows: boolean;
  /** 阴影贴图边长。 */
  shadowMapSize: number;
}

/**
 * 判定规则（spec §6 M1 验收：移动端 DPR 与阴影按规则降级）：
 * - 触屏 + 短边 < 900 → mobile
 * - 否则 desktop
 * 用 `pointer: coarse` 而不是 UA 嗅探：UA 会骗人，触屏能力不会。
 */
export function detectQualityTier(env?: {
  coarsePointer?: boolean;
  minSide?: number;
}): QualityTier {
  const coarsePointer =
    env?.coarsePointer ??
    (typeof window !== 'undefined' &&
      typeof window.matchMedia === 'function' &&
      window.matchMedia('(pointer: coarse)').matches);
  const minSide =
    env?.minSide ??
    (typeof window !== 'undefined'
      ? Math.min(window.innerWidth || 0, window.innerHeight || 0)
      : 1080);

  const isMobile = coarsePointer && minSide < 900;

  return isMobile
    ? { kind: 'mobile', maxDpr: 1.6, shadows: false, shadowMapSize: 512 }
    : { kind: 'desktop', maxDpr: 2, shadows: true, shadowMapSize: 2048 };
}

export interface SceneOptions {
  /** 挂载点。默认 document.body。 */
  container?: HTMLElement;
  /** 强制质量档（e2e 用），不传则自动判定。 */
  tier?: QualityTier;
  /**
   * 房间数据（与物理同一份）。给了就建房间视觉（地板/墙/踢脚线/台阶/接触阴影）。
   *
   * 为什么不在这里 import DEMO_ROOM：场景内核不该知道"默认房间是哪个"。
   * 房间是数据，由调用方（main.ts）注入；换房间文件不改这里一行。
   * 不传则保持"只有一个空场景"的行为（e2e 的纯渲染用例不需要房间）。
   */
  room?: Room;
  fogDistanceScale?: number;
  lightingPresets?: Readonly<Record<string, LightingPreset>>;
}

/** 光照句柄，供 M6 房间定义（灯光来自 room.json）覆盖。 */
export interface LightRig {
  hemi: THREE.HemisphereLight;
  sun: THREE.DirectionalLight;
  rim: THREE.SpotLight;
}

/** 时间/天气预设切换的状态。 */
export interface LightingState {
  /** 当前生效的 preset key。 */
  current: string;
  /** 正在过渡到的 key（null 表示没在过渡）。 */
  target: string | null;
  /** 过渡进度 0..1。 */
  progress: number;
}

export interface RenderStats {
  fps: number;
  frameMs: number;
  drawCalls: number;
  triangles: number;
  /** three 的累计帧号（renderer.info.render.frame），便于确认读数不是陈旧的。 */
  frameCount: number;
  geometries: number;
  textures: number;
}

/**
 * 场景 + 渲染器 + 光照 + resize + 循环。
 * 相机与输入在 camera.ts，这里只负责"把画出来"。
 */
export class WorldRenderer {
  readonly renderer: THREE.WebGLRenderer;
  readonly scene: THREE.Scene;
  readonly lights: LightRig;
  readonly tier: QualityTier;
  readonly canvas: HTMLCanvasElement;

  private container: HTMLElement;
  private resizeObserver: ResizeObserver | null = null;
  private rafId = 0;
  private running = false;
  private disposed = false;

  /** 当前生效的光照预设（过渡中时是插值结果）。 */
  private lighting: LightingState = {
    current: DEFAULT_PRESET,
    target: null,
    progress: 1,
  };
  /** 过渡起点快照（切换时冻结当前视觉状态，避免"从预设值跳到中途"）。 */
  private lightingFrom: LightingPreset = LIGHTING_PRESETS[DEFAULT_PRESET]!;
  /** 复用的颜色对象，避免过渡期间每帧分配（每帧要插值 5 个颜色）。 */
  private readonly tmpColorA = new THREE.Color();
  /** 雨系统（只有暴雨预设才会显示，平时 points.visible=false 省 draw call）。 */
  private readonly rain = new Rain();

  /**
   * 房间视觉（地板/墙/踢脚线/台阶/网格线/接触阴影）。
   *
   * null = 没注入房间数据，场景保持"空"（e2e 纯渲染用例走这条路）。
   */
  private roomVisual: RoomVisual | null = null;
  /**
   * 角色位置数据源（接触阴影用）。
   *
   * 为什么是 setter 而不是构造参数：`World` 由 main.ts 在 renderer 之后创建，
   * 且物理就绪前角色表是空的。设成"随时可替换"比要求构造顺序干净更实际。
   */
  private actorSource: ActorSource | null = null;

  /** 注入的房间数据（保留引用供 `rebuildRoomVisual()` 用）。 */
  private readonly roomData: Room | null;
  private readonly fogDistanceScale: number;
  private readonly presets: Readonly<Record<string, LightingPreset>>;

  private frameCount = 0;
  private fpsWindowStart = 0;
  private fps = 0;
  private lastFrameMs = 0;

  /**
   * 上一帧 render 后的统计快照。
   *
   * 为什么要自己存：`renderer.info.render` 是**每帧累加、render 时结算**的。
   * 如果在 render 之后调 `info.reset()`（three 的默认行为），读到的永远是 0；
   * 如果等到下一帧的任意时刻再读，又可能已经被新的 render 覆盖。
   * 所以在这一帧 render 完、reset 前把值抓下来，是最稳的。
   */
  private lastCalls = 0;
  private lastTriangles = 0;
  private lastFrameCount = 0;

  /** 每帧回调：dt 秒（已夹上限）、alpha 0..1。物理订阅它。 */
  private frameHandlers: Array<(dt: number) => void> = [];

  constructor(opts: SceneOptions = {}) {
    this.tier = opts.tier ?? detectQualityTier();
    this.container = opts.container ?? document.body;
    this.roomData = opts.room ?? null;
    this.fogDistanceScale = opts.fogDistanceScale ?? 1;
    this.presets = opts.lightingPresets ?? LIGHTING_PRESETS;
    this.lightingFrom = this.presets[DEFAULT_PRESET]!;

    // antialias 只在 DPR<2 时开：高 DPR 下 MSAA 收益趋零，却要多占带宽与显存
    const dpr = this.effectiveDpr();
    this.renderer = new THREE.WebGLRenderer({
      antialias: dpr < 2,
      alpha: false,
      powerPreference: 'high-performance',
      stencil: false,
      depth: true,
    });

    this.renderer.outputColorSpace = THREE.SRGBColorSpace;
    this.renderer.toneMapping = THREE.ACESFilmicToneMapping;
    // exposure 1.0 在 ACES 下偏暗，1.05 让空场景的灰盒不至于像阴天
    this.renderer.toneMappingExposure = 1.05;
    this.renderer.setPixelRatio(dpr);
    this.renderer.shadowMap.enabled = this.tier.shadows;
    this.renderer.shadowMap.type = THREE.PCFSoftShadowMap;
    this.renderer.info.autoReset = false;

    this.canvas = this.renderer.domElement;
    this.canvas.style.display = 'block';
    this.canvas.style.width = '100%';
    this.canvas.style.height = '100%';
    this.canvas.style.touchAction = 'none'; // 触屏拖拽不要被浏览器当成滚动
    this.container.appendChild(this.canvas);

    this.scene = new THREE.Scene();
    this.scene.background = new THREE.Color(0x0f1218);
    // 线性雾：把远处的空场景边缘收掉，观感上像"房间有边界"而不是"漂浮在虚空"
    this.scene.fog = new THREE.Fog(0x0f1218, 18, 42);

    // ── 环境贴图（IBL）──
    //
    // 为什么必须有（"角色看起来假"的头号原因，2026-11-20 实测确认）：
    // 角色材质 roughness 平均 0.456（偏光滑，26.8% 区域 <0.3）。
    // PBR 下这类表面**主要靠环境反射出颜色**。之前场景完全没有 environment，
    // 光滑区域只能反射纯色背景 → 渲染成灰黑塑料块，暗部死黑、亮部过曝。
    //
    // 用 RoomEnvironment（three 自带，程序化生成，不需下载 HDR 文件）：
    // 模拟有窗光的室内环境，给光滑/金属表面提供合理反射与间接光。
    // 成本：一次 PMREM 预滤波（约 10~30ms，仅启动时跑一次）。
    //
    // 注意 `environment` ≠ `background`：前者只影响反射与间接光，后者是画面底色。
    // 这里只设 environment，保留深色背景（房间氛围）。
    const pmrem = new THREE.PMREMGenerator(this.renderer);
    const envRT = pmrem.fromScene(new RoomEnvironment(), 0.04);
    this.scene.environment = envRT.texture;
    // 强度 0.85 → 0.32：实测 0.85 时角色平均亮度从 43 飙到 135，3.4% 像素过曝，
    // 整个人发白失去层次。0.32 既保留环境反射带来的立体感，又不冲掉固有色。
    // 这个值要配合下面的灯光强度一起看 —— 它们是相加关系，不是替代关系。
    this.scene.environmentIntensity = 0.32;
    pmrem.dispose();

    this.lights = this.buildLights();
    // 雨挂进场景（默认不可见，由预设的 rain 参数控制显隐）
    this.scene.add(this.rain.points);

    // ── 房间视觉 ──
    // 放在光照之后：房间的材质要用到 shadows 档位（receiveShadow）。
    // 房间几何走 `core/room.ts#roomSolids()`，与物理烘焙**同一个函数**，
    // 所以"看得见的墙"与"撞得到的墙"不可能分叉。
    if (opts.room) {
      this.roomVisual = new RoomVisual(this.scene, {
        room: opts.room,
        shadows: this.tier.shadows,
      });
    }
    // 建完灯先应用一次默认预设，否则第一帧用的是 buildLights 里的硬编码值，
    // 与预设不一致 → 带 ?time=night 时会闪一帧白天再切过去。
    this.applyPreset(this.presets[DEFAULT_PRESET]!);

    this.applySize();
    this.observeResize();
  }

  /**
   * 应用一个光照预设（立即生效，不做过渡）。
   *
   * 为什么单独抽出来：初始化时要用它（无过渡），过渡结束时也要用它（收尾对齐）。
   * 过渡过程中的中间态由 `applyBlended` 处理。
   */
  private applyPreset(p: LightingPreset): void {
    const { hemi, sun, rim } = this.lights;

    sun.color.setHex(p.sun.color);
    sun.intensity = p.sun.intensity;
    sun.position.set(p.sun.position[0], p.sun.position[1], p.sun.position[2]);

    hemi.color.setHex(p.hemi.sky);
    hemi.groundColor.setHex(p.hemi.ground);
    hemi.intensity = p.hemi.intensity;

    rim.color.setHex(p.rim.color);
    rim.intensity = p.rim.intensity;

    (this.scene.background as THREE.Color).setHex(p.background);
    const fog = this.scene.fog as THREE.Fog;
    fog.color.setHex(p.fog.color);
    fog.near = p.fog.near * this.fogDistanceScale;
    fog.far = p.fog.far * this.fogDistanceScale;

    this.scene.environmentIntensity = p.envIntensity;
    this.renderer.toneMappingExposure = p.exposure;

    // 雨量跟着预设走。非暴雨预设 rain=0，雨对象自动隐藏（不产生 draw call）。
    this.rain.setIntensity(p.rain);
  }

  /**
   * 切换时间/天气预设（带平滑过渡）。
   *
   * 为什么不能直接改值：光照突变会让眼睛"闪一下"，录片时尤其难看。
   * 0.8s 的 smoothstep 过渡既有变化感又不刺眼。
   *
   * 过渡从**当前视觉状态**开始（不是从上一个预设的静态值开始），
   * 否则连续切换两次会出现"跳回去再走"的抖动。
   */
  setLighting(key: string): boolean {
    const target = this.presets[key];
    if (!target) return false;
    if (this.lighting.target === key) return true; // 已经在去这个目标的路上

    // 冻结当前状态作为过渡起点
    this.lightingFrom = this.captureCurrent();
    this.lighting.target = key;
    this.lighting.progress = 0;
    return true;
  }

  /** 立即应用（无过渡）。用于初始化与验收脚本。 */
  setLightingImmediate(key: string): boolean {
    const target = this.presets[key];
    if (!target) return false;
    this.applyPreset(target);
    this.lighting = { current: key, target: null, progress: 1 };
    this.lightingFrom = target;
    return true;
  }

  /** 当前光照状态（调试面板/验收用）。 */
  getLightingState(): LightingState {
    return { ...this.lighting };
  }

  /**
   * 把当前灯光/场景的**实际值**读回来组成一个 preset。
   * 过渡起点必须用它，不能用"上一次的 preset 常量" —— 连续切换时才不会跳。
   */
  private captureCurrent(): LightingPreset {
    const { hemi, sun, rim } = this.lights;
    const fog = this.scene.fog as THREE.Fog;
    return {
      label: '过渡中',
      sun: {
        color: sun.color.getHex(),
        intensity: sun.intensity,
        position: [sun.position.x, sun.position.y, sun.position.z],
      },
      hemi: {
        sky: hemi.color.getHex(),
        ground: hemi.groundColor.getHex(),
        intensity: hemi.intensity,
      },
      rim: { color: rim.color.getHex(), intensity: rim.intensity },
      background: (this.scene.background as THREE.Color).getHex(),
      fog: { color: fog.color.getHex(), near: fog.near / this.fogDistanceScale, far: fog.far / this.fogDistanceScale },
      envIntensity: this.scene.environmentIntensity,
      exposure: this.renderer.toneMappingExposure,
      rain: 0,
    };
  }

  /**
   * 每帧推进光照过渡。由渲染循环调用（不单独开定时器）。
   * @returns 本帧是否仍在过渡中（调试面板可据此显示"过渡中"）
   */
  private tickLighting(dt: number): boolean {
    if (this.lighting.target === null) return false;

    this.lighting.progress = advanceTransition(this.lighting.progress, dt);
    const t = smoothstep(this.lighting.progress);
    const target = this.presets[this.lighting.target]!;

    if (this.lighting.progress >= 1) {
      // 收尾：直接对齐目标值，避免浮点误差累积
      this.applyPreset(target);
      this.lighting = { current: this.lighting.target, target: null, progress: 1 };
      this.lightingFrom = target;
      return false;
    }

    // 中间态：颜色走 three 的 Color.lerp（线性空间），标量直接插值。
    // 复用同一个 Color 对象避免每帧分配 —— 过渡期间每帧都要插值 5 个颜色。
    const blended = blendPreset(this.lightingFrom, target, t, (hex) =>
      this.tmpColorA.setHex(hex) as unknown as BlendableColor,
    );
    this.applyPreset(blended);
    return true;
  }

  private effectiveDpr(): number {
    const raw = typeof window !== 'undefined' ? window.devicePixelRatio || 1 : 1;
    return Math.min(raw, this.tier.maxDpr);
  }

  /**
   * 光照（spec §6 M1 第 2 条）：半球光 + 带阴影方向光 + 暖色轮廓光。
   * 数值理由：
   * - hemi 0.55 给环境底色，太亮会让阴影区失去层次；
   * - sun 1.9 是主光，ACES 下需要比线性管线更高的强度才不灰；
   * - rim 用暖橙（0xffb37a）从背后打，角色边缘才从深色背景里分离出来。
   */
  private buildLights(): LightRig {
    const hemi = new THREE.HemisphereLight(0xdfeaff, 0x2a2622, 0.55);
    hemi.position.set(0, 20, 0);
    this.scene.add(hemi);

    const sun = new THREE.DirectionalLight(0xfff2e0, 1.9);
    sun.position.set(6, 12, 8);
    sun.target.position.set(0, 1, 0);
    this.scene.add(sun);
    this.scene.add(sun.target);

    if (this.tier.shadows) {
      sun.castShadow = true;
      sun.shadow.mapSize.set(this.tier.shadowMapSize, this.tier.shadowMapSize);
      const cam = sun.shadow.camera;
      cam.near = 0.5;
      cam.far = 60;
      // 覆盖 24×24m 的活动区；再大阴影就糊（2048/24m ≈ 85px/m）
      cam.left = -12;
      cam.right = 12;
      cam.top = 12;
      cam.bottom = -12;
      cam.updateProjectionMatrix();
      // 阴影痤疮与彼得潘现象的两端折中
      sun.shadow.bias = -0.0004;
      sun.shadow.normalBias = 0.02;
      sun.shadow.radius = 2;
    }

    // 轮廓光用 SpotLight 而不是第二个 DirectionalLight：要有明确方向感，且不投影
    const rim = new THREE.SpotLight(0xffb37a, 24, 30, Math.PI / 5, 0.6, 1.2);
    rim.position.set(-7, 6, -9);
    rim.target.position.set(0, 1.2, 0);
    rim.castShadow = false;
    this.scene.add(rim);
    this.scene.add(rim.target);

    return { hemi, sun, rim };
  }

  /** 视口尺寸以容器为准；容器没尺寸时退回 window（否则 canvas 会 0×0 永远黑屏）。 */
  private measure(): { width: number; height: number } {
    const rect = this.container.getBoundingClientRect();
    const width = Math.max(1, Math.round(rect.width) || window.innerWidth || 1);
    const height = Math.max(1, Math.round(rect.height) || window.innerHeight || 1);
    return { width, height };
  }

  private applySize(): void {
    const { width, height } = this.measure();
    // setSize 的第三个参数 false：不要让它写 style，尺寸由 CSS（100%/100%）决定
    this.renderer.setSize(width, height, false);
    this.renderer.setPixelRatio(this.effectiveDpr());
  }

  private observeResize(): void {
    if (typeof ResizeObserver === 'undefined') {
      // 老浏览器兜底：至少别白屏
      window.addEventListener('resize', this.onWindowResize);
      return;
    }
    this.resizeObserver = new ResizeObserver(() => {
      if (this.disposed) return;
      this.applySize();
      this.events?.resize?.(this.width, this.height);
    });
    this.resizeObserver.observe(this.container);
  }

  private onWindowResize = (): void => {
    this.applySize();
    this.events?.resize?.(this.width, this.height);
  };

  /** resize / 相机 aspect 的订阅口。相机在这里挂上，避免 scene 依赖 camera。 */
  events: {
    resize?: (width: number, height: number) => void;
    frame?: (dt: number) => void;
  } = {};

  get width(): number {
    return this.renderer.domElement.width;
  }

  get height(): number {
    return this.renderer.domElement.height;
  }

  /** CSS 像素尺寸（不是 drawingBuffer 尺寸），相机 aspect 要用这个。 */
  get cssWidth(): number {
    const rect = this.container.getBoundingClientRect();
    return Math.max(1, Math.round(rect.width) || window.innerWidth || 1);
  }

  get cssHeight(): number {
    const rect = this.container.getBoundingClientRect();
    return Math.max(1, Math.round(rect.height) || window.innerHeight || 1);
  }

  /** 注册每帧回调。返回取消函数。 */
  onFrame(fn: (dt: number) => void): () => void {
    this.frameHandlers.push(fn);
    return () => {
      const i = this.frameHandlers.indexOf(fn);
      if (i >= 0) this.frameHandlers.splice(i, 1);
    };
  }

  /**
   * 设置角色位置数据源（接触阴影每帧从这里读）。
   *
   * 可重复调用：物理没就绪时先传一个空世界，就绪后传同一个 `World` 即可
   * （`World` 是引用，之后长出来的角色自动出现在下一帧的阴影里）。
   */
  setActorSource(source: ActorSource | null): void {
    this.actorSource = source;
  }

  /** 房间视觉句柄（验收脚本读 drawCall 预算、M11 面板切网格线用）。 */
  getRoomVisual(): RoomVisual | null {
    return this.roomVisual;
  }

  /**
   * 重建房间视觉（**仅泄漏验收用**）。
   *
   * 为什么需要它：任务书要求"新增渲染对象必须能被 dispose() 清理"，
   * 而这条只能靠**反复建/拆再对比显存计数**来证明，不能靠读代码判断。
   * 重建时若 dispose 漏了 InstancedMesh / LineSegments / 程序化贴图，
   * `renderer.info.memory` 会一轮一轮涨上去。
   */
  rebuildRoomVisual(): void {
    if (!this.roomData) return;
    this.roomVisual?.dispose();
    this.roomVisual = new RoomVisual(this.scene, {
      room: this.roomData,
      shadows: this.tier.shadows,
    });
  }

  /**
   * 场景图盘点（验收/排障用，不是渲染逻辑）。
   *
   * 为什么需要它：`renderer.info.render.calls` 只给一个总数，
   * 而"drawCall 增幅 ≤ 5"这条验收要求说清楚**多出来的是哪几个**。
   * 只报总数的话，一旦某个对象因为被视锥剔除而没画，
   * 总数看起来"达标"，实际画面里却少了东西——那是假绿。
   */
  describeScene(): {
    meshes: Array<{ name: string; visible: boolean; triangles: number; instanced: number }>;
    contactShadowVisible: number;
    gridVisible: boolean;
  } {
    const meshes: Array<{ name: string; visible: boolean; triangles: number; instanced: number }> = [];
    this.scene.traverse((o) => {
      const m = o as THREE.Mesh;
      if (!m.isMesh) return;
      const geo = m.geometry;
      const tri = geo.index
        ? geo.index.count / 3
        : (geo.attributes['position']?.count ?? 0) / 3;
      const inst = m instanceof THREE.InstancedMesh ? m.count : 1;
      meshes.push({
        name: m.name || '(unnamed)',
        visible: m.visible,
        triangles: Math.round(tri * inst),
        instanced: inst,
      });
    });
    return {
      meshes,
      contactShadowVisible: this.roomVisual?.contactShadows.visibleCount ?? 0,
      gridVisible: this.roomVisual?.grid?.visible ?? false,
    };
  }

  /**
   * 启动循环。dt 以秒为单位，夹到 0.1（切后台回来不要一次补 3 秒）。
   * 注意：这里**不**直接喂物理——调用方的 onFrame 里交给 Clock。
   */
  start(camera: THREE.Camera): void {
    if (this.running) return;
    this.running = true;
    this.fpsWindowStart = performance.now();
    this.frameCount = 0;

    let prev = performance.now();

    const loop = (now: number): void => {
      if (!this.running || this.disposed) return;
      this.rafId = requestAnimationFrame(loop);

      const rawDt = (now - prev) / 1000;
      prev = now;
      const dt = rawDt > 0.1 ? 0.1 : rawDt < 0 ? 0 : rawDt;

      this.frameCount += 1;
      const elapsed = now - this.fpsWindowStart;
      if (elapsed >= 500) {
        this.fps = (this.frameCount * 1000) / elapsed;
        this.frameCount = 0;
        this.fpsWindowStart = now;
      }

      const t0 = performance.now();
      // 光照过渡必须在 render **之前**推进，否则这一帧画的是上一帧的光照，
      // 过渡看起来会慢一帧（0.8s 的过渡里几乎看不出来，但连续切换会累积成滞后）。
      this.tickLighting(dt);
      this.rain.update(dt);
      // 接触阴影跟角色走。放在 render 之前、frameHandlers 之前：
      // 它的输入是**上一物理步**写回世界的位置（frameHandlers 里才推物理），
      // 差一帧肉眼看不出来，但能保证"这一帧画出来的阴影"和"这一帧画出来的角色"
      // 用的是同一个位置快照（否则角色与阴影会互相抖）。
      if (this.roomVisual && this.actorSource) this.roomVisual.update(this.actorSource);
      for (const fn of this.frameHandlers) fn(dt);
      this.events.frame?.(dt);
      this.renderer.render(this.scene, camera);
      this.lastFrameMs = performance.now() - t0;

      // 关键：在 render **之后**立刻把统计快照下来。
      // 不能在这里调 `info.reset()` —— 那会把刚累加好的 calls/triangles 清成 0，
      // 于是 getStats() 永远读到 0（调试面板显示 "drawCall 0 / 三角形 0" 就是这个原因）。
      // 也不能等 getStats() 再去读：`info.autoReset` 是 false，但下一帧的 render 会重新累加，
      // 所以必须在这一帧 render 完、下一帧开始前把值存进自己的字段。
      this.lastCalls = this.renderer.info.render.calls;
      this.lastTriangles = this.renderer.info.render.triangles;
      this.lastFrameCount = this.renderer.info.render.frame;
      // 显式重置：我们已把值存好，重置只影响内部累加器，为下一帧做准备
      this.renderer.info.reset();
    };

    // 自举：没有这一行，loop 永远不会被调度，整个渲染循环不启动。
    // （曾经被一次改动误删，症状是 fps/drawCall/tick 全是 0、但 rAF 本身正常——
    // 很容易被误判成"物理没起来"，其实是循环没开。）
    this.rafId = requestAnimationFrame(loop);
  }

  stop(): void {
    this.running = false;
    if (this.rafId) cancelAnimationFrame(this.rafId);
    this.rafId = 0;
  }

  /** 调试面板读这个。fps 是 500ms 滑窗，不是瞬时值（瞬时值抖得没法看）。 */
  getStats(): RenderStats {
    const info = this.renderer.info;
    return {
      fps: Math.round(this.fps * 10) / 10,
      frameMs: Math.round(this.lastFrameMs * 100) / 100,
      // 用自己存的快照，不是 info.render（那个在 reset 后是 0）
      drawCalls: this.lastCalls,
      triangles: this.lastTriangles,
      frameCount: this.lastFrameCount,
      geometries: info.memory.geometries,
      textures: info.memory.textures,
    };
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.stop();
    this.resizeObserver?.disconnect();
    this.resizeObserver = null;
    window.removeEventListener('resize', this.onWindowResize);
    this.frameHandlers.length = 0;
    // 雨是 Points 不是 Mesh，上面的 traverse 清不到它，要单独 dispose。
    this.rain.dispose();
    // 房间视觉也必须单独 dispose：它持有 InstancedMesh（接触阴影）与 GridHelper（LineSegments），
    // 这两个**都不是** `instanceof THREE.Mesh`，下面那个 traverse 覆盖不到它们。
    // 更关键的是：它自己记着 geometries/materials/textures 三个数组，
    // 靠 traverse 逐对象释放会漏掉"已经不在场景树上但还占显存"的那部分。
    this.roomVisual?.dispose();
    this.roomVisual = null;
    this.actorSource = null;
    this.scene.traverse((obj) => {
      if (obj instanceof THREE.Mesh) {
        obj.geometry.dispose();
        const mat = obj.material;
        if (Array.isArray(mat)) mat.forEach((m) => m.dispose());
        else mat.dispose();
      }
    });
    this.renderer.dispose();
    this.canvas.remove();
  }
}
