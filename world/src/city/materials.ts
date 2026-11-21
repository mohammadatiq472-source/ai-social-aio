/**
 * 城市材质。
 *
 * 注：2026-11-21 一次工具编码事故把部分内联注释写成了乱码；这里已清掉损坏的注释行，
 * 代码与测试保持完整。需要看原注释请翻 git 历史（P2 之前）。
 */
import * as THREE from 'three';
import { LIGHTING_PRESETS, type LightingPreset } from '../render/lighting';
import type { CityBuilding } from './data';
import { PING_AN_ID } from './landmark';

export type FacadeStyle = 'glass' | 'office' | 'stone';
export const FACADE_MODULE = { width: 3.2, height: 3.8, textureSize: 512, columns: 4, rows: 6 } as const;

/**
 *
 */
export type FacadeTint = 'cool' | 'teal' | 'silver';
export const FACADE_TINT_KEYS = ['cool', 'teal', 'silver'] as const;

export interface FacadeTintSpec {
  base: string;
  window: readonly [number, number, number];
  frame: string;
  level: number;
}

export const FACADE_TINTS: Readonly<Record<FacadeTint, FacadeTintSpec>> = {
  cool: { base: '#4f6a7a', window: [0, 8, 16], frame: '#9fb2bb', level: 1 },
  teal: { base: '#4f7168', window: [0, 12, 8], frame: '#9ab8ae', level: 0.97 },
  silver: { base: '#6f6f69', window: [4, 4, 6], frame: '#a8a8a0', level: 1.04 },
};

export function stableHash(value: string): number {
  let hash = 0x811c9dc5;
  for (let i = 0; i < value.length; i++) {
    hash ^= value.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash >>> 0;
}

export function facadeTint(id: string): FacadeTint {
  return FACADE_TINT_KEYS[stableHash(id) % FACADE_TINT_KEYS.length]!;
}

// ───────────────────────────── 逐窗亮（窗口 mask + 每窗 hash） ─────────────────────────────

/**
 * 立面窗格在 512² atlas 里的像素矩形。
 *
 * **颜色/粗糙度/metalness/法线/夜间亮窗 mask 全部从这一份矩形来**：以前 mask 想复刻
 * 一遍 inset 公式，改一处忘一处就会"亮的格子比窗偏 2px"；现在只有一个来源。
 *
 * `tone` 是窗面明度扰动（0..1，确定性），不是随机数：同一格每次生成都一样。
 */
export interface FacadeWindowCell {
  column: number;
  row: number;
  x: number;
  y: number;
  width: number;
  height: number;
  tone: number;
}

export function facadeWindowCells(style: FacadeStyle): FacadeWindowCell[] {
  const glass = style === 'glass', size = FACADE_MODULE.textureSize;
  const cellW = size / FACADE_MODULE.columns, cellH = size / FACADE_MODULE.rows;
  const inset = glass ? 1.1 : style === 'office' ? 5 : 3;
  const cells: FacadeWindowCell[] = [];
  for (let row = 0; row < FACADE_MODULE.rows; row++) {
    for (let column = 0; column < FACADE_MODULE.columns * 2; column++) {
      const tone = ((row * 37 + column * 17 + (glass ? 3 : 13)) % 23) / 23;
      cells.push({
        column, row, tone,
        x: column * cellW / 2 + inset,
        y: row * cellH + (glass ? 1 : 10),
        width: cellW / 2 - inset * 2,
        height: cellH - (glass ? 3 : 14),
      });
    }
  }
  return cells;
}

/** 窗格的世界米制间距（与 atlas 的 4 模块 × 每模块 2 窗 / 6 行对齐）。 */
export const WINDOW_PITCH = { x: FACADE_MODULE.width / 2, y: FACADE_MODULE.height } as const;

/** 夜间亮窗 mask 的尺寸/阈值/增益：512² 与立面 atlas 同尺寸、同 repeat。 */
export const WINDOW_MASK = {
  size: FACADE_MODULE.textureSize,
  /** 每扇窗的亮/暗阈值（hash 0..1）：约 55% 的窗亮。 */
  litThreshold: 0.45,
  /** 同样点亮的窗也有明暗差（0.55–1.0），否则整面墙像一块亮板。 */
  minGain: 0.55,
} as const;

/** 立面几何上的顶点属性名：每栋楼一个 0..1 的 hash（屋顶写 -1，永不亮）。 */
export const WINDOW_SEED_ATTRIBUTE = 'windowSeed';
export const WINDOW_SEED_ROOF = -1;

/** 楼栋 id → 窗组 hash（稳定；不同楼/窗组亮暗不同，同一楼每次加载相同）。 */
export function windowSeed(id: string): number {
  return (stableHash(`window:${id}`) % 1000) / 1000;
}

/**
 * 夜间亮窗 mask：只覆盖窗洞的 512² 单通道数据贴图（RGBA 存储，GPU 直读）。
 *
 * 为什么不用 canvas：DataTexture 可离线确定性生成、node 测试能直接断言像素，
 * 也少了 9 次 512² canvas 绘制。mask 与颜色 atlas 用**同一个 repeat/offset 和 flipY**，
 * 所以窗洞逐像素对齐；真实亮暗由顶点属性 `windowSeed` + 窗格 hash 在着色器里决定。
 */
export function windowMaskTexture(style: FacadeStyle): THREE.DataTexture {
  const size = WINDOW_MASK.size;
  const data = new Uint8Array(size * size * 4);
  for (let i = 3; i < data.length; i += 4) data[i] = 255;
  for (const cell of facadeWindowCells(style)) {
    const x0 = Math.max(0, Math.ceil(cell.x)), x1 = Math.min(size, Math.floor(cell.x + cell.width));
    const y0 = Math.max(0, Math.ceil(cell.y)), y1 = Math.min(size, Math.floor(cell.y + cell.height));
    for (let y = y0; y < y1; y++) {
      for (let x = x0; x < x1; x++) {
        const index = (y * size + x) * 4;
        data[index] = 255; data[index + 1] = 255; data[index + 2] = 255;
      }
    }
  }
  const texture = new THREE.DataTexture(data, size, size, THREE.RGBAFormat);
  // CanvasTexture 的 atlas 默认 flipY=true；mask 必须同样翻转，否则窗洞上下错位一格。
  texture.flipY = true;
  texture.colorSpace = THREE.NoColorSpace;
  texture.wrapS = texture.wrapT = THREE.RepeatWrapping;
  texture.repeat.set(1 / (FACADE_MODULE.width * FACADE_MODULE.columns), 1 / (FACADE_MODULE.height * FACADE_MODULE.rows));
  texture.magFilter = THREE.LinearFilter;
  texture.minFilter = THREE.LinearMipmapLinearFilter;
  texture.generateMipmaps = true;
  texture.anisotropy = 8;
  texture.needsUpdate = true;
  texture.name = `city-window-mask-${style}`;
  return texture;
}

/**
 * 给立面材质装"按窗格 hash 点亮"的着色器补丁。
 *
 * 为什么不用多套 mask 贴图：batch 按 `样式 × 色调` 共享材质，一栋楼一个 mask 变体
 * 会把 draw call 从 9 涨到 9×N；这里保持一张 mask/样式，靠顶点属性 `windowSeed`
 * 把"哪几扇窗亮"变成逐片元 hash。屋顶顶点 seed=-1，永远不会亮。
 *
 * 补丁只改自发光，不动 PBR；`emissiveIntensity` 仍由 `windowEmissiveIntensity()` 白天 0 / 夜间 0.6。
 */
export function installWindowEmissiveShader(material: THREE.Material): void {
  material.onBeforeCompile = shader => {
    shader.vertexShader = `attribute float ${WINDOW_SEED_ATTRIBUTE};\nvarying float vWindowSeed;\nvarying vec2 vWindowUv;\n` + shader.vertexShader;
    shader.vertexShader = shader.vertexShader.replace(
      '#include <begin_vertex>',
      `#include <begin_vertex>\nvWindowSeed = ${WINDOW_SEED_ATTRIBUTE};\nvWindowUv = uv;`,
    );
    shader.fragmentShader = 'varying float vWindowSeed;\nvarying vec2 vWindowUv;\n' + shader.fragmentShader;
    shader.fragmentShader = shader.fragmentShader.replace(
      '#include <emissivemap_fragment>',
      `#include <emissivemap_fragment>
      vec2 windowCell = floor(vWindowUv / vec2(${WINDOW_PITCH.x.toFixed(5)}, ${WINDOW_PITCH.y.toFixed(5)}));
      float windowNoise = fract(sin(dot(windowCell + vec2(vWindowSeed * 91.7, vWindowSeed * 47.3), vec2(12.9898, 78.233))) * 43758.5453);
      float windowLit = step(${WINDOW_MASK.litThreshold.toFixed(5)}, windowNoise)
        * mix(${WINDOW_MASK.minGain.toFixed(5)}, 1.0, fract(windowNoise * 17.0));
      totalEmissiveRadiance *= windowLit * step(0.0, vWindowSeed);`,
    );
  };
  material.customProgramCacheKey = () => 'city-window-emissive-v1';
}

// ───────────────────────────── 水面法线（程序生成，不请求资产） ─────────────────────────────

/** 水面法线贴图边长与重复周期（米）。256² 是"看得见细碎反光"与显存的下限折中。 */
export const WATER_NORMAL = { size: 256, meters: 512, scale: 0.0 } as const;

/**
 * 程序法线贴图：几组整数频率的正弦叠加，**可无缝平铺**、确定性、无外部请求。
 *
 * 为什么不是每帧重算：256² 每帧重算会把主线程吃满；这里只生成一次，
 * 运行时改 `offset` 做流动（见 `waterNormalOffset`）。
 */
export function waterNormalTexture(): THREE.DataTexture {
  const size = WATER_NORMAL.size;
  const data = new Uint8Array(size * size * 4);
  const waves = [
    { nx: 2, nz: 3, amp: 1, phase: 0.4 },
    { nx: 5, nz: -2, amp: 0.55, phase: 1.7 },
    { nx: -3, nz: 7, amp: 0.3, phase: 3.1 },
  ];
  const tau = Math.PI * 2;
  for (let y = 0; y < size; y++) {
    const v = y / size;
    for (let x = 0; x < size; x++) {
      const u = x / size;
      let du = 0, dv = 0;
      for (const wave of waves) {
        const angle = tau * (wave.nx * u + wave.nz * v) + wave.phase;
        const slope = wave.amp * tau;
        du += slope * wave.nx * Math.cos(angle);
        dv += slope * wave.nz * Math.cos(angle);
      }
      // 高度场 h(u,v) 的切线法线 = normalize(-∂h/∂u, -∂h/∂v, 1)，压到 0..255。
      const nx = -du * 0.02, nz = -dv * 0.02, length = Math.hypot(nx, nz, 1);
      const index = (y * size + x) * 4;
      data[index] = Math.round((nx / length * 0.5 + 0.5) * 255);
      data[index + 1] = Math.round((nz / length * 0.5 + 0.5) * 255);
      data[index + 2] = Math.round((1 / length * 0.5 + 0.5) * 255);
      data[index + 3] = 255;
    }
  }
  const texture = new THREE.DataTexture(data, size, size, THREE.RGBAFormat);
  texture.colorSpace = THREE.NoColorSpace;
  texture.wrapS = texture.wrapT = THREE.RepeatWrapping;
  texture.repeat.set(1 / WATER_NORMAL.meters, 1 / WATER_NORMAL.meters);
  texture.magFilter = THREE.LinearFilter;
  texture.minFilter = THREE.LinearMipmapLinearFilter;
  texture.generateMipmaps = true;
  texture.anisotropy = 4;
  texture.needsUpdate = true;
  texture.name = 'city-water-normal';
  return texture;
}

/** 水面法线 offset（纹理单位）：纯函数、按秒推进，测试可断言而不用真的等帧。 */
export function waterNormalOffset(seconds: number): [number, number] {
  const t = Number.isFinite(seconds) ? seconds : 0;
  return [t * 0.015, t * 0.011];
}

export const STREET_PALETTE = {
  paving: 0xb7b9b7, asphalt: 0x475259, metal: 0x364e57,
  timber: 0x9d7850, trunk: 0x72634c, leaves: [0x547a48, 0x6b914e, 0x3b6447],
  steel: 0xcad5d5, lamp: 0xffe6b2,
} as const;

/**
 */
export const WATER_COLOR = 0x2e5f73;
export const SHORE_COLOR = 0xe2ece6;
export const RIDGE_COLOR = 0x35485a;

export interface SurfaceMaps { color: THREE.Texture; normal: THREE.Texture; arm: THREE.Texture }
export interface SurfaceAssets { granite: SurfaceMaps; asphalt: SurfaceMaps }

const SURFACE_URLS = {
  granite: {
    color: new URL('../../assets/city/materials/granite-color.webp', import.meta.url).href,
    normal: new URL('../../assets/city/materials/granite-normal.webp', import.meta.url).href,
    arm: new URL('../../assets/city/materials/granite-arm.webp', import.meta.url).href,
  },
  asphalt: {
    color: new URL('../../assets/city/materials/asphalt-color.webp', import.meta.url).href,
    normal: new URL('../../assets/city/materials/asphalt-normal.webp', import.meta.url).href,
    arm: new URL('../../assets/city/materials/asphalt-arm.webp', import.meta.url).href,
  },
};

export async function loadSurfaceAssets(): Promise<SurfaceAssets> {
  const loader = new THREE.TextureLoader();
  const loaded: THREE.Texture[] = [];
  const sets = await Promise.allSettled(Object.entries(SURFACE_URLS).map(async ([name, urls]) => {
    const maps = await Promise.allSettled(Object.entries(urls).map(async ([kind, url]) => {
      const map = await loader.loadAsync(url);
      loaded.push(map);
      map.colorSpace = kind === 'color' ? THREE.SRGBColorSpace : THREE.NoColorSpace;
      map.wrapS = map.wrapT = THREE.RepeatWrapping;
      map.anisotropy = 8;
      const meters = name === 'granite' ? 2 : 3;
      map.repeat.set(1 / meters, 1 / meters);
      return [kind, map] as const;
    }));
    const failed = maps.find(result => result.status === 'rejected');
    if (failed?.status === 'rejected') throw new Error(`街区PBR贴图加载失败?{name}`);
    return [name, Object.fromEntries(maps.map(result => (result as PromiseFulfilledResult<readonly [string, THREE.Texture]>).value))] as const;
  }));
  const failed = sets.find(result => result.status === 'rejected');
  if (failed?.status === 'rejected') {
    loaded.forEach(map => map.dispose());
    throw failed.reason;
  }
  return Object.fromEntries(sets.map(result => (result as PromiseFulfilledResult<readonly [string, object]>).value)) as unknown as SurfaceAssets;
}

/**
 * 立面样式。`landmarkIds` 来自数据（`data.landmark` + `data.landmarks[]`）：
 */
export function facadeStyle(building: CityBuilding, landmarkIds?: ReadonlySet<string>): FacadeStyle {
  if (landmarkIds?.has(building.id) || building.id === PING_AN_ID || building.height >= 65) return 'glass';
  return building.height >= 24 ? 'office' : 'stone';
}

export const CITY_LIGHTING: Readonly<Record<string, LightingPreset>> = {
  day: { ...LIGHTING_PRESETS.day!, background: 0xc4d0d8,
    fog: { ...LIGHTING_PRESETS.day!.fog, color: 0xd8d3c9, near: 36, far: 84 },
    sun: { ...LIGHTING_PRESETS.day!.sun, color: 0xfff3e8, intensity: 1.9 },
    hemi: { sky: 0xdbe6ec, ground: 0x77736c, intensity: 0.72 },
    rim: { color: 0xfff1db, intensity: 0 }, envIntensity: 0.6, exposure: 0.92 },
  dusk: { ...LIGHTING_PRESETS.dusk!, background: 0xc4a496,
    fog: { ...LIGHTING_PRESETS.dusk!.fog, color: 0xd3b6a7 },
    hemi: { sky: 0xc8b3bb, ground: 0x665d52, intensity: 0.55 }, rim: { color: 0xffd0ad, intensity: 0 } },
  night: { ...LIGHTING_PRESETS.night!, background: 0x101d32,
    fog: { ...LIGHTING_PRESETS.night!.fog, color: 0x192a40 }, rim: { color: 0x8cbaff, intensity: 0 } },
  storm: { ...LIGHTING_PRESETS.storm!, background: 0x788b96,
    fog: { ...LIGHTING_PRESETS.storm!.fog, color: 0x8a989e },
    hemi: { sky: 0x9facb2, ground: 0x5a605b, intensity: 0.65 }, rim: { color: 0x8a9ca4, intensity: 0 } },
};

function canvas(): HTMLCanvasElement {
  const result = document.createElement('canvas');
  result.width = result.height = FACADE_MODULE.textureSize;
  return result;
}

function atlas(source: HTMLCanvasElement, srgb = false): THREE.CanvasTexture {
  const map = new THREE.CanvasTexture(source);
  map.colorSpace = srgb ? THREE.SRGBColorSpace : THREE.NoColorSpace;
  map.wrapS = map.wrapT = THREE.RepeatWrapping;
  map.anisotropy = 8;
  map.repeat.set(1 / (FACADE_MODULE.width * FACADE_MODULE.columns), 1 / (FACADE_MODULE.height * FACADE_MODULE.rows));
  return map;
}

function clamp255(value: number): number {
  return Math.max(0, Math.min(255, Math.round(value)));
}

function shade(hex: string, level: number): string {
  const r = parseInt(hex.slice(1, 3), 16), g = parseInt(hex.slice(3, 5), 16), b = parseInt(hex.slice(5, 7), 16);
  return `rgb(${clamp255(r * level)},${clamp255(g * level)},${clamp255(b * level)})`;
}

/**
 *
 */
export const TILE_TINT_RGB: Readonly<Record<FacadeTint, readonly [number, number, number]>> = {
  cool: [0.50, 0.64, 0.82],
  teal: [0.48, 0.74, 0.66],
  silver: [0.70, 0.70, 0.68],
};

/**
 *
 */
export const NIGHT_WINDOW_EMISSIVE = 0xffc98a;
export const NIGHT_EMISSIVE_INTENSITY = 0.6;

/**
 *
 */
export function windowEmissiveIntensity(state: { current?: string | null; target?: string | null }): number {
  return state.current === 'night' || state.target === 'night' ? NIGHT_EMISSIVE_INTENSITY : 0;
}

export function facadeMaterial(style: FacadeStyle, stoneImage: CanvasImageSource, tint: FacadeTint = 'cool', windowMask?: THREE.Texture): THREE.MeshPhysicalMaterial {
  const color = canvas(), roughness = canvas(), metalness = canvas(), normals = canvas();
  const c = color.getContext('2d')!, r = roughness.getContext('2d')!, m = metalness.getContext('2d')!, n = normals.getContext('2d')!;
  const glass = style === 'glass', size = FACADE_MODULE.textureSize;
  const spec = FACADE_TINTS[tint];
  const cellW = size / FACADE_MODULE.columns, cellH = size / FACADE_MODULE.rows;
  const base = glass ? spec.base : style === 'office' ? shade('#6f7a80', spec.level) : shade('#8f8371', spec.level);
  c.fillStyle = base; c.fillRect(0, 0, size, size);
  r.fillStyle = glass ? '#777777' : '#dddddd'; r.fillRect(0, 0, size, size);
  m.fillStyle = glass ? '#dddddd' : '#080808'; m.fillRect(0, 0, size, size);
  n.fillStyle = '#8080ff'; n.fillRect(0, 0, size, size);
  if (!glass) {
    c.globalAlpha = style === 'stone' ? 0.30 : 0.10;
    for (let y = 0; y < size; y += cellH) for (let x = 0; x < size; x += cellW) c.drawImage(stoneImage, x, y, cellW, cellH);
    c.globalAlpha = 1;
  }
  for (const cell of facadeWindowCells(style)) {
      const random = cell.tone;
      const { x, y, width, height } = cell;
      const value = Math.round(38 + random * 20);
      // 三种色调的区别主要在窗面：冷蓝偏 B、青绿偏 G、银灰三通道接近。
      const [dr, dg, db] = spec.window;
      c.fillStyle = `rgb(${clamp255((value + dr) * spec.level)},${clamp255((value + dg) * spec.level)},${clamp255((value + db) * spec.level)})`;
      c.fillRect(x, y, width, height);
      if (!glass && random > .72) {
        c.fillStyle = shade('#8b887d', spec.level); c.fillRect(x + 2, y + 2, width - 4, height * .55);
        c.strokeStyle = '#666b6b'; c.lineWidth = .6;
        for (let line = y + 5; line < y + height * .55; line += 3) { c.beginPath(); c.moveTo(x + 2, line); c.lineTo(x + width - 2, line); c.stroke(); }
      }
      c.fillStyle = '#1f2a30'; c.fillRect(x, y + height - 3, width, 3);
      c.fillStyle = glass ? spec.frame : '#8e9694'; c.fillRect(x - 2, y, 2, height);
      const rough = Math.round(32 + random * 19);
      r.fillStyle = `rgb(${rough},${rough},${rough})`; r.fillRect(x, y, width, height);
      m.fillStyle = '#050505'; m.fillRect(x, y, width, height);
      n.fillStyle = `rgb(${Math.round(127 + random * 3)},${Math.round(129 - random * 3)},255)`; n.fillRect(x, y, width, height);
      n.fillStyle = '#a080f0'; n.fillRect(x - 1, y, 1, height);
      n.fillStyle = '#6080f0'; n.fillRect(x + width, y, 1, height);
  }
  // 夜间亮窗：emissiveMap 换成**窗洞 mask**（与颜色 atlas 同尺寸/repeat，逐窗对齐），
  // 不再复用颜色 atlas（那会把窗框/层间带点亮成暖色描边，不是"窗亮"）。
  const colorMap = atlas(color, true);
  const material = new THREE.MeshPhysicalMaterial({
    map: colorMap, emissiveMap: windowMask ?? windowMaskTexture(style), emissive: NIGHT_WINDOW_EMISSIVE, emissiveIntensity: 0,
    roughnessMap: atlas(roughness), metalnessMap: atlas(metalness), normalMap: atlas(normals),
    normalScale: new THREE.Vector2(.22, .22), color: 0xffffff, roughness: 1, metalness: 1,
    clearcoat: glass ? .6 : .2, clearcoatRoughness: .18, envMapIntensity: glass ? 2.2 : 1.4, vertexColors: true,
  });
  // 逐窗亮暗由顶点 windowSeed + 窗格 hash 在片元着色器里决定（mask 只负责"哪些像素是窗"）。
  installWindowEmissiveShader(material);
  return material;
}

export function pavingMaterial(maps: SurfaceMaps): THREE.MeshStandardMaterial {
  return new THREE.MeshStandardMaterial({ map: maps.color, normalMap: maps.normal, normalScale: new THREE.Vector2(.3, .3),
    roughnessMap: maps.arm, aoMap: maps.arm, aoMapIntensity: .55, roughness: .95, color: 0xffffff });
}

export function asphaltMaterial(maps: SurfaceMaps): THREE.MeshStandardMaterial {
  return new THREE.MeshStandardMaterial({ map: maps.color, normalMap: maps.normal, normalScale: new THREE.Vector2(.22, .22),
    roughnessMap: maps.arm, aoMap: maps.arm, aoMapIntensity: .45, roughness: 1, color: 0xc3c7c9 });
}

export function streetKitMaterial(): THREE.MeshStandardMaterial {
  const material = new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 1, metalness: 1 });
  material.onBeforeCompile = shader => {
    shader.vertexShader = 'attribute vec2 surface; varying vec2 vSurface;\n' + shader.vertexShader;
    shader.vertexShader = shader.vertexShader.replace('#include <begin_vertex>', '#include <begin_vertex>\nvSurface = surface;');
    shader.fragmentShader = 'varying vec2 vSurface;\n' + shader.fragmentShader;
    shader.fragmentShader = shader.fragmentShader.replace('#include <roughnessmap_fragment>', '#include <roughnessmap_fragment>\nroughnessFactor *= vSurface.x;');
    shader.fragmentShader = shader.fragmentShader.replace('#include <metalnessmap_fragment>', '#include <metalnessmap_fragment>\nmetalnessFactor *= vSurface.y;');
  };
  return material;
}

/**
 *
 *
 */
export function waterMaterial(): THREE.MeshPhysicalMaterial {
  const material = new THREE.MeshPhysicalMaterial({
    color: WATER_COLOR, roughness: 0.05, metalness: 0.3,
    // 256² 程序法线：水面不再是一块死板镜面；运行时只改 offset（见 waterNormalOffset），
    // 不换纹理、不发请求、也不每帧重算。
    normalMap: waterNormalTexture(), normalScale: new THREE.Vector2(WATER_NORMAL.scale, WATER_NORMAL.scale),
    clearcoat: 0.45, clearcoatRoughness: 0.06, envMapIntensity: 2,
    // 水面与远景地坪/岸线在 2–5km 外会 z-fighting：给水面负 offset，让它压过地坪。
    polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -2,
  });
  material.name = 'city-water';
  return material;
}

/**
 *
 */
export function shoreMaterial(): THREE.MeshStandardMaterial {
  const material = new THREE.MeshStandardMaterial({ color: SHORE_COLOR, roughness: 0.92, metalness: 0, polygonOffset: true, polygonOffsetFactor: -1, polygonOffsetUnits: -1 });
  material.name = 'city-shore';
  return material;
}

/**
 *
 */
export function roofMaterial(): THREE.MeshStandardMaterial {
  const material = new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.86, metalness: 0.04 });
  material.name = 'city-roofs';
  return material;
}

/**
 *
 */
export function ridgeMaterial(): THREE.MeshBasicMaterial {
  const material = new THREE.MeshBasicMaterial({ color: 0xffffff, vertexColors: true, fog: true, side: THREE.DoubleSide, polygonOffset: true, polygonOffsetFactor: 1, polygonOffsetUnits: 1 });
  material.name = 'city-ridges';
  return material;
}

export function sidewalkMaterial(maps: SurfaceMaps): THREE.MeshStandardMaterial {
  return new THREE.MeshStandardMaterial({ map: maps.color, normalMap: maps.normal, normalScale: new THREE.Vector2(.18, .18),
    roughnessMap: maps.arm, aoMap: maps.arm, aoMapIntensity: .4, roughness: 1, color: 0xd2d4d0 });
}

export function carMaterial(): THREE.MeshStandardMaterial {
  return new THREE.MeshStandardMaterial({ vertexColors: true, roughness: .42, metalness: .35, envMapIntensity: 1.2 });
}

// ───────────────────────────── 春茧壳体 ─────────────────────────────

/** 壳体面板色：灰蓝半透明膜。太蓝会像塑料棚，太灰在雾里会消失。 */
export const SHELL_PANEL_COLOR = 0x8299a6;
/**
 * 面板不透明度。0.55 是"看得见里面两瓣的轮廓、又不会把壳读成一个空洞"的折中：
 * 0.3 在浅灰地面/海面前几乎看不见（只剩肋条，像一张网）；0.7 又把壳内糊死。
 */
export const SHELL_PANEL_OPACITY = 0.55;
/** 肋条色：白/浅灰。春茧的识别色就是白色编织壳。 */
export const SHELL_RIB_COLOR = 0xecf0ef;

/**
 * 壳体面板材质：**半透明、DoubleSide、不写深度**。
 *
 * 为什么 `depthWrite=false`：膜是单层曲面，写深度会把背面那层面板挡掉一半，
 * 从街上抬头看会出现"半边壳消失"；不写深度让两面叠出均匀的膜感。
 * 它**不接收也不投阴影**（半透明壳投满阴影会把壳内压成黑箱）。
 */
export function shellPanelMaterial(): THREE.MeshStandardMaterial {
  const material = new THREE.MeshStandardMaterial({
    color: SHELL_PANEL_COLOR, roughness: 0.28, metalness: 0.14,
    transparent: true, opacity: SHELL_PANEL_OPACITY, depthWrite: false,
    side: THREE.DoubleSide, envMapIntensity: 1.6,
  });
  material.name = 'city-shell-panels';
  return material;
}

/** 壳体肋条材质：白色细条，轻微金属感（室外钢结构），DoubleSide 兜住绕序。 */
export function shellRibMaterial(): THREE.MeshStandardMaterial {
  const material = new THREE.MeshStandardMaterial({
    color: SHELL_RIB_COLOR, roughness: 0.38, metalness: 0.18,
    side: THREE.DoubleSide, envMapIntensity: 1.2,
  });
  material.name = 'city-shell-ribs';
  return material;
}


