/**
 * 时间/天气光照预设（spec §6 M1 光照系统的扩展）。
 *
 * 为什么单独一个模块而不是塞进 scene.ts：
 * 1. 预设是**纯数据 + 纯插值**，不碰 WebGL，可以在 node 里单测（scene.ts 不行，它要真渲染器）；
 * 2. 四种氛围的参数需要反复调，放在一起改比散在 300 行渲染代码里快；
 * 3. 以后加"室内/洞穴"之类只需要加一个对象，不用动渲染逻辑。
 *
 * 设计要点：
 * - 每个预设控制**同一组**参数（太阳、半球光、轮廓光、背景、雾、环境强度、曝光、雨量），
 *   这样切换时不会有"某个属性忘了改"的残留 —— 那是最难查的一类视觉 bug。
 * - 颜色用十六进制数字，插值时走 THREE.Color.lerpColors（线性空间插值才对，
 *   直接 lerp RGB 分量会让中间态发灰）。
 */

/** 光照预设的完整参数集。字段全部必填，避免"漏改某一项"。 */
export interface LightingPreset {
  /** 给用户看的中文名。 */
  readonly label: string;
  /** 太阳（主方向光）。 */
  readonly sun: {
    readonly color: number;
    readonly intensity: number;
    readonly position: readonly [number, number, number];
  };
  /** 半球光：天空色 / 地面反射色 / 强度。 */
  readonly hemi: {
    readonly sky: number;
    readonly ground: number;
    readonly intensity: number;
  };
  /** 轮廓光（从背后打的补光，让角色边缘从深色背景里分离）。 */
  readonly rim: {
    readonly color: number;
    readonly intensity: number;
  };
  /** 画面底色。 */
  readonly background: number;
  /** 雾：颜色 + 起止距离。暴雨时雾更近，观感上"看不远"。 */
  readonly fog: {
    readonly color: number;
    readonly near: number;
    readonly far: number;
  };
  /** 环境贴图强度（IBL）。夜景要低，否则失去"夜"的感觉。 */
  readonly envIntensity: number;
  /** 色调映射曝光。夜景调高一点补偿低照度。 */
  readonly exposure: number;
  /** 雨滴强度 0..1，0 = 不下雨。 */
  readonly rain: number;
}

/**
 * 四个预设。
 *
 * 调参依据（不是随手填的）：
 * - **白天**：太阳偏高偏暖（0xfff4e6），半球光给足天空蓝，阴影短而清晰。
 * - **黄昏**：太阳压低（y 从 16 降到 6）+ 强橙（0xff9a4d），长阴影；
 *   半球光偏紫（夕阳的天空是紫的），轮廓光加强到 30 让边缘发光。
 * - **夜晚**：太阳换成冷月光（0x8fb4ff）且强度只有 0.55；
 *   曝光提到 1.18 补偿，否则整体死黑看不清角色。
 * - **暴雨**：**低对比 + 去饱和 + 雾更近**才是"雨"的观感，不是"变暗"。
 *   太阳几乎无方向感（强度 0.9 但位置接近正上方），半球光反而要加强
 *   —— 阴天的光是**散射**的，没有明确方向，全靠环境漫射。
 */
export const LIGHTING_PRESETS: Readonly<Record<string, LightingPreset>> = {
  day: {
    label: '白天',
    sun: { color: 0xfff4e6, intensity: 2.2, position: [8, 16, 6] },
    hemi: { sky: 0xbfd8ff, ground: 0x4a4038, intensity: 0.7 },
    rim: { color: 0xffd9b0, intensity: 12 },
    background: 0x1a2028,
    fog: { color: 0x1a2028, near: 20, far: 50 },
    envIntensity: 0.45,
    exposure: 1.0,
    rain: 0,
  },
  dusk: {
    label: '黄昏',
    sun: { color: 0xff9a4d, intensity: 2.6, position: [-10, 6, 4] },
    hemi: { sky: 0x8a6a9e, ground: 0x2a1a18, intensity: 0.45 },
    rim: { color: 0xff6b3d, intensity: 30 },
    background: 0x2a1a24,
    fog: { color: 0x2a1a24, near: 16, far: 45 },
    envIntensity: 0.3,
    exposure: 1.05,
    rain: 0,
  },
  night: {
    label: '夜晚',
    sun: { color: 0x8fb4ff, intensity: 0.55, position: [5, 14, -8] },
    hemi: { sky: 0x2a3a5a, ground: 0x0a0c12, intensity: 0.35 },
    rim: { color: 0x6a9aff, intensity: 16 },
    background: 0x080a10,
    fog: { color: 0x080a10, near: 12, far: 38 },
    envIntensity: 0.15,
    exposure: 1.18,
    rain: 0,
  },
  storm: {
    label: '暴雨',
    // 阴天的光是**散射**的：没有明确方向，靠环境漫射。
    // 但"散射"不等于"更亮" —— 实测第一版半球光给 0.85 时画面比白天还亮（52 vs 44），
    // 看起来像"冷调白天"而不是暴雨。压低到 0.5 并降低曝光，才有阴郁感。
    sun: { color: 0x8a98a8, intensity: 0.55, position: [2, 18, 3] },
    hemi: { sky: 0x4a5460, ground: 0x161a20, intensity: 0.5 },
    rim: { color: 0x6a7a8a, intensity: 4 },
    background: 0x0e1318,
    // 雾更近更浓是"雨"的关键观感：看不远。
    fog: { color: 0x0e1318, near: 6, far: 22 },
    envIntensity: 0.35,
    exposure: 0.88,
    rain: 1,
  },
};

/** 默认预设（用户不带参数时用哪个）。 */
export const DEFAULT_PRESET = 'day';

/** 所有可用的预设 key（给 URL 参数校验与文档用）。 */
export const PRESET_KEYS = Object.keys(LIGHTING_PRESETS) as readonly string[];

/**
 * 把用户输入（URL 参数）解析成合法 preset key。
 * 不合法时回落到默认值，**不抛错** —— URL 参数是用户输入，不该炸页面。
 */
export function resolvePresetKey(raw: string | null | undefined): string {
  if (!raw) return DEFAULT_PRESET;
  const k = raw.trim().toLowerCase();
  return PRESET_KEYS.includes(k) ? k : DEFAULT_PRESET;
}

// ───────────────────────────── 插值 ─────────────────────────────

/** 线性插值单个数。 */
function lerp(a: number, b: number, t: number): number {
  return a + (b - a) * t;
}

/**
 * 颜色对象的最小接口。
 *
 * 为什么用自定义接口而不是直接依赖 `THREE.Color`：
 * 这个模块要保持"node 里能单测、不依赖 WebGL"。
 * `THREE.Color` 本身在 node 里可用（three 的纯数学部分），但用它会把类型绑死到 three；
 * 用最小接口后，测试里传个假对象也能跑，将来换渲染库也不用改这里。
 */
export interface BlendableColor {
  r: number;
  g: number;
  b: number;
  /** 就地与另一颜色插值。 */
  lerp(color: BlendableColor, alpha: number): unknown;
  /** 取回十六进制表示（用于写回场景）。 */
  getHex(): number;
}

/**
 * 在两个预设之间插值，用于切换时的平滑过渡。
 *
 * 为什么颜色不能直接 lerp 分量：sRGB 空间插值会让中间态发灰发脏
 * （例如纯红到纯蓝，中点会是暗紫而不是亮品红）。
 * 这里走颜色对象的 `lerp`，three 会在工作色彩空间（线性）里插值。
 *
 * `makeColor` 通过参数注入而不是 import —— 让这个模块在 node 单测里也能跑。
 */
export function blendPreset(
  a: LightingPreset,
  b: LightingPreset,
  t: number,
  makeColor: (hex: number) => BlendableColor,
): LightingPreset {
  const k = t < 0 ? 0 : t > 1 ? 1 : t;

  // 颜色走 Color 插值，标量直接 lerp
  const blendHex = (ha: number, hb: number): number => {
    if (ha === hb) return ha;
    const ca = makeColor(ha);
    const cb = makeColor(hb);
    ca.lerp(cb, k);
    return ca.getHex();
  };

  return {
    label: k < 0.5 ? a.label : b.label,
    sun: {
      color: blendHex(a.sun.color, b.sun.color),
      intensity: lerp(a.sun.intensity, b.sun.intensity, k),
      position: [
        lerp(a.sun.position[0], b.sun.position[0], k),
        lerp(a.sun.position[1], b.sun.position[1], k),
        lerp(a.sun.position[2], b.sun.position[2], k),
      ],
    },
    hemi: {
      sky: blendHex(a.hemi.sky, b.hemi.sky),
      ground: blendHex(a.hemi.ground, b.hemi.ground),
      intensity: lerp(a.hemi.intensity, b.hemi.intensity, k),
    },
    rim: {
      color: blendHex(a.rim.color, b.rim.color),
      intensity: lerp(a.rim.intensity, b.rim.intensity, k),
    },
    background: blendHex(a.background, b.background),
    fog: {
      color: blendHex(a.fog.color, b.fog.color),
      near: lerp(a.fog.near, b.fog.near, k),
      far: lerp(a.fog.far, b.fog.far, k),
    },
    envIntensity: lerp(a.envIntensity, b.envIntensity, k),
    exposure: lerp(a.exposure, b.exposure, k),
    rain: lerp(a.rain, b.rain, k),
  };
}

/** 过渡时长（秒）。0.8s 足够盖住"突变"感，又不至于让人觉得卡。 */
export const TRANSITION_SECONDS = 0.8;

/**
 * 推进过渡进度。
 * @returns 新的 t（0..1）。达到 1 表示过渡结束。
 */
export function advanceTransition(t: number, dt: number): number {
  if (!Number.isFinite(dt) || dt <= 0) return t;
  const next = t + dt / TRANSITION_SECONDS;
  return next > 1 ? 1 : next;
}

/** 缓动：smoothstep。线性过渡在起止两端会有"顿一下"的感觉。 */
export function smoothstep(t: number): number {
  const x = t < 0 ? 0 : t > 1 ? 1 : t;
  return x * x * (3 - 2 * x);
}
