import * as THREE from 'three';
import { LIGHTING_PRESETS, type LightingPreset } from '../render/lighting';
import type { CityBuilding } from './data';
import { PING_AN_ID } from './landmark';

export type FacadeStyle = 'glass' | 'office' | 'stone';
export const FACADE_MODULE = { width: 3.2, height: 3.8, textureSize: 512, columns: 4, rows: 6 } as const;

/**
 * 绔嬮潰鑹叉澘锛氬悓涓€涓牱寮忓啀鍒嗕笁绉嶈壊璋冿紙鍐疯摑 / 闈掔豢 / 閾剁伆锛夈€?
 *
 * 涓轰粈涔堢敤鍥哄畾鏋氫妇鑰屼笉鏄殢鏈鸿壊锛氳鍖洪噷鍑犲崈鏍嬫ゼ鑻ュ悇鑷彇闅忔満鑹诧紝杩滅湅浼氬儚鍣偣锛?
 * 涓夌鏈夋剰鐨勮壊璋?+ 鎸?id 绋冲畾鍒嗘《锛屾墠鑳?涓€鐗囩幓鐠冨箷澧欓噷鐪嬪嚭涓嶅悓妤?锛?
 * 鍚屾椂淇濊瘉鍚屼竴 id 姣忔鍔犺浇閮芥槸鍚屼竴涓鑹诧紙鎴浘/鍥炲綊鍙鐜帮級銆?
 */
export type FacadeTint = 'cool' | 'teal' | 'silver';
export const FACADE_TINT_KEYS = ['cool', 'teal', 'silver'] as const;

export interface FacadeTintSpec {
  /** 鐜荤拑搴曡壊銆?*/
  base: string;
  /** 绐楅潰鑹茬浉瀵?`value` 鐨?RGB 鍋忕Щ锛堝喎钃?闈掔豢/閾剁伆鐨勫尯鍒富瑕佸湪 B 涓?G锛夈€?*/
  window: readonly [number, number, number];
  /** 绐楁/绔栨棰滆壊銆?*/
  frame: string;
  /** 鏁翠綋鏄庡害绯绘暟锛岄伩鍏嶄笁绉嶈壊璋冧寒搴﹀樊寮傝繃澶с€?*/
  level: number;
}

export const FACADE_TINTS: Readonly<Record<FacadeTint, FacadeTintSpec>> = {
  cool: { base: '#a5adb0', window: [0, 9, 14], frame: '#c8ced0', level: 1 },
  teal: { base: '#9daaa8', window: [0, 12, 8], frame: '#c2cfc9', level: 0.97 },
  silver: { base: '#b2b2ae', window: [6, 6, 7], frame: '#d3d3ce', level: 1.04 },
};

/** FNV-1a 32 浣嶏細缁?鎸?id 绋冲畾鍒嗘《"鐢紝涓嶄緷璧栬繍琛屾椂闅忔満/鎻掑叆椤哄簭銆?*/
export function stableHash(value: string): number {
  let hash = 0x811c9dc5;
  for (let i = 0; i < value.length; i++) {
    hash ^= value.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash >>> 0;
}

/** 寤虹瓚 id 鈫?鍥哄畾鑹茶皟锛涘悓涓€ id 姘歌繙鍚岃壊銆?*/
export function facadeTint(id: string): FacadeTint {
  return FACADE_TINT_KEYS[stableHash(id) % FACADE_TINT_KEYS.length]!;
}

export const STREET_PALETTE = {
  paving: 0xb7b9b7, asphalt: 0x475259, metal: 0x364e57,
  timber: 0x9d7850, trunk: 0x72634c, leaves: [0x547a48, 0x6b914e, 0x3b6447],
  steel: 0xcad5d5, lamp: 0xffe6b2,
} as const;

/**
 * 娣卞湷婀炬按鑹层€備负浠€涔堜笉鏄師鏉ョ殑 0x5b7280 鐏拌摑锛氶偅涓€鐗堝湪鏆栫伆娴烽浘涓嬪拰澶╃┖鍑犱箮鍚岃壊锛?
 * 娴烽潰璇讳笉鍑?姘?锛涙繁鍦虫咕鍐呮咕鍦ㄦ櫞澶╂槸鍋忕豢鐨勮摑锛堣椈绫?+ 娴呮哗锛夛紝鎵€浠ュ彇 0x2e5f73銆?
 */
export const WATER_COLOR = 0x2e5f73;
/** 宀哥嚎娉℃搏/娌欑嚎锛氭瘮姘撮潰浜袱妗ｇ殑鍐风櫧锛岀函鑹插嚑浣曪紝涓嶇敤璐村浘銆?*/
export const SHORE_COLOR = 0xe2ece6;
/** 杩滃北鍓奖锛氭繁钃濈伆锛堝彈闆惧悗浼氳瀺杩涙捣闆撅紝涓嶈兘鍙栫函钃濆惁鍒欏儚璐寸焊锛夈€?*/
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
    if (failed?.status === 'rejected') throw new Error(`琛楀尯PBR璐村浘鍔犺浇澶辫触锛?{name}`);
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
 * 绔嬮潰鏍峰紡銆俙landmarkIds` 鏉ヨ嚜鏁版嵁锛坄data.landmark` + `data.landmarks[]`锛夛細
 * 鏁版嵁澹版槑鐨勫湴鏍囦竴寰嬭蛋鐜荤拑妯℃澘锛屽摢鎬曞畠鍙湁鍑犲崄绫抽珮銆?
 */
export function facadeStyle(building: CityBuilding, landmarkIds?: ReadonlySet<string>): FacadeStyle {
  if (landmarkIds?.has(building.id) || building.id === PING_AN_ID || building.height >= 65) return 'glass';
  return building.height >= 24 ? 'office' : 'stone';
}

export const CITY_LIGHTING: Readonly<Record<string, LightingPreset>> = {
  day: { ...LIGHTING_PRESETS.day!, background: 0xc4d0d8,
    // 娣卞湷婀剧殑鐧藉ぉ涓嶆槸骞插喎鏅村ぉ锛氭捣闈㈡妸澶槼鍏夋礂鎴愭殩鐏帮紝闆句篃鏇磋繙锛堟繁鍦虫咕 3km 澶栦粛鏈夎疆寤擄級銆?
    fog: { ...LIGHTING_PRESETS.day!.fog, color: 0xd8d3c9, near: 36, far: 84 },
    sun: { ...LIGHTING_PRESETS.day!.sun, color: 0xfff3e8, intensity: 2.3 },
    hemi: { sky: 0xdbe6ec, ground: 0x77736c, intensity: 0.72 },
    rim: { color: 0xfff1db, intensity: 0 }, envIntensity: 0.6, exposure: 1.0 },
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

/** 鎸夋槑搴︾郴鏁扮缉鏀句竴涓?#rrggbb 棰滆壊锛岃繑鍥?canvas 鑳藉悆鐨?rgb() 瀛楃涓层€?*/
function shade(hex: string, level: number): string {
  const r = parseInt(hex.slice(1, 3), 16), g = parseInt(hex.slice(3, 5), 16), b = parseInt(hex.slice(5, 7), 16);
  return `rgb(${clamp255(r * level)},${clamp255(g * level)},${clamp255(b * level)})`;
}

/**
 * 鐡︾墖 LOD1 椤剁偣鑹茬殑**鍞竴鏉ユ簮**锛歵int 鈫?绾挎€?0..1 鐨?RGB 涔樺瓙銆?
 *
 * LOD1 鏄函鑹茬洅瀛愶紙涓嶉噰鏍风珛闈?atlas锛夛紝鍚屼竴鏍嬫ゼ鍦?LOD0锛坅tlas + 鑹茶皟鏉愯川锛変笌
 * LOD1锛堥《鐐硅壊锛夊繀椤荤湅璧锋潵鏄悓涓€鑹茬郴锛涙敼杩欓噷瑕佸悓鏃跺鏌ヤ袱鏉¤矾寰勩€?
 */
export const TILE_TINT_RGB: Readonly<Record<FacadeTint, readonly [number, number, number]>> = {
  cool: [0.90, 0.95, 1.0],
  teal: [0.90, 1.0, 0.96],
  silver: [1.0, 1.0, 0.98],
};

/**
 * 澶滈棿浜獥鐨勬殩鑹蹭笌寮哄害銆?*涓嶆敼鍘熸埧闂撮璁?*锛氳繖閲屽彧褰卞搷鍩庡競绔嬮潰鏉愯川鐨勮嚜鍙戝厜銆?
 *
 * `emissiveMap` 鐩存帴澶嶇敤绔嬮潰鐨勯鑹?atlas锛堣 `facadeMaterial`锛夛細鍚屼竴寮?512虏 璐村浘
 * 鍚屾椂褰?map 涓?emissiveMap锛屼笉棰濆鍗犱竴寮犵汗鐞嗐€備唬浠锋槸绐楁锛堜寒鐏帮級姣旂獥闈紙娣辫壊锛?
 * 鑷彂鍏夋洿寮猴紝鎵€浠ュ閲岀殑鏁堟灉鏄?鏁存爧妤艰鏆栬壊鐐逛寒"鑰屼笉鏄?閫愮獥闅忔満浜?鈥斺€?
 * 閫愮獥闇€瑕佸崟鐙殑 emissive atlas锛岃 README銆屾湭鍋氥€嶃€?
 */
export const NIGHT_WINDOW_EMISSIVE = 0xffc98a;
/** 澶滈棿鑷彂鍏夊己搴︼紱鐧藉ぉ涓?0銆?*/
export const NIGHT_EMISSIVE_INTENSITY = 0.6;

/**
 * 鎸夊厜鐓х姸鎬佺粰鍑虹珛闈㈣嚜鍙戝厜寮哄害锛堢函鍑芥暟锛屼究浜庡湪 node 閲屾柇瑷€锛夈€?
 *
 * `current` 鍙湪杩囨浮**缁撴潫**鎵嶅彉鎴愮洰鏍囬璁撅紝鎵€浠ヨ繃娓￠€斾腑杩樿鐪?`target`锛?
 * 鍚﹀垯鍒囧埌澶滄櫄鐨?0.8s 閲屾ゼ鏄粦鐨勶紝杩囨浮涓€缁撴潫"鍟?涓€涓嬪叏浜紝姣旂洿鎺ヤ笉浜洿鍒虹溂銆?
 */
export function windowEmissiveIntensity(state: { current?: string | null; target?: string | null }): number {
  return state.current === 'night' || state.target === 'night' ? NIGHT_EMISSIVE_INTENSITY : 0;
}

export function facadeMaterial(style: FacadeStyle, stoneImage: CanvasImageSource, tint: FacadeTint = 'cool'): THREE.MeshPhysicalMaterial {
  const color = canvas(), roughness = canvas(), metalness = canvas(), normals = canvas();
  const c = color.getContext('2d')!, r = roughness.getContext('2d')!, m = metalness.getContext('2d')!, n = normals.getContext('2d')!;
  const glass = style === 'glass', size = FACADE_MODULE.textureSize;
  const spec = FACADE_TINTS[tint];
  const cellW = size / FACADE_MODULE.columns, cellH = size / FACADE_MODULE.rows;
  const base = glass ? spec.base : style === 'office' ? shade('#bbbdbb', spec.level) : shade('#c7c5bf', spec.level);
  c.fillStyle = base; c.fillRect(0, 0, size, size);
  r.fillStyle = glass ? '#777777' : '#dddddd'; r.fillRect(0, 0, size, size);
  m.fillStyle = glass ? '#dddddd' : '#080808'; m.fillRect(0, 0, size, size);
  n.fillStyle = '#8080ff'; n.fillRect(0, 0, size, size);
  if (!glass) {
    c.globalAlpha = style === 'stone' ? 0.52 : 0.22;
    for (let y = 0; y < size; y += cellH) for (let x = 0; x < size; x += cellW) c.drawImage(stoneImage, x, y, cellW, cellH);
    c.globalAlpha = 1;
  }
  for (let row = 0; row < FACADE_MODULE.rows; row++) {
    for (let column = 0; column < FACADE_MODULE.columns * 2; column++) {
      const random = ((row * 37 + column * 17 + (glass ? 3 : 13)) % 23) / 23;
      const inset = glass ? 1.1 : style === 'office' ? 8 : 4;
      const x = column * cellW / 2 + inset, y = row * cellH + (glass ? 1 : 14);
      const width = cellW / 2 - inset * 2, height = cellH - (glass ? 3 : 21);
      const value = Math.round(48 + random * 22);
      // 涓夌鑹茶皟鐨勫尯鍒富瑕佸湪绐楅潰锛氬喎钃濆亸 B銆侀潚缁垮亸 G銆侀摱鐏颁笁閫氶亾鎺ヨ繎銆?
      const [dr, dg, db] = spec.window;
      c.fillStyle = `rgb(${clamp255((value + dr) * spec.level)},${clamp255((value + dg) * spec.level)},${clamp255((value + db) * spec.level)})`;
      c.fillRect(x, y, width, height);
      if (!glass && random > .72) {
        c.fillStyle = shade('#8b887d', spec.level); c.fillRect(x + 2, y + 2, width - 4, height * .55);
        c.strokeStyle = '#666b6b'; c.lineWidth = .6;
        for (let line = y + 5; line < y + height * .55; line += 3) { c.beginPath(); c.moveTo(x + 2, line); c.lineTo(x + width - 2, line); c.stroke(); }
      }
      c.fillStyle = '#242e33'; c.fillRect(x, y + height - 2, width, 2);
      c.fillStyle = glass ? spec.frame : '#969e9d'; c.fillRect(x - 1, y, 1, height);
      const rough = Math.round(32 + random * 19);
      r.fillStyle = `rgb(${rough},${rough},${rough})`; r.fillRect(x, y, width, height);
      m.fillStyle = '#050505'; m.fillRect(x, y, width, height);
      n.fillStyle = `rgb(${Math.round(127 + random * 3)},${Math.round(129 - random * 3)},255)`; n.fillRect(x, y, width, height);
      n.fillStyle = '#a080f0'; n.fillRect(x - 1, y, 1, height);
      n.fillStyle = '#6080f0'; n.fillRect(x + width, y, 1, height);
    }
  }
  // 鍚屼竴寮犻鑹?atlas 鍚屾椂褰?emissiveMap锛氫笉棰濆鍗犵汗鐞嗗唴瀛橈紙9 涓珛闈㈠悇涓€寮?512虏 宸茬粡涓嶅皬锛夈€?
  const colorMap = atlas(color, true);
  return new THREE.MeshPhysicalMaterial({
    map: colorMap, emissiveMap: colorMap, emissive: NIGHT_WINDOW_EMISSIVE, emissiveIntensity: 0,
    roughnessMap: atlas(roughness), metalnessMap: atlas(metalness), normalMap: atlas(normals),
    normalScale: new THREE.Vector2(.22, .22), color: 0xffffff, roughness: 1, metalness: 1,
    clearcoat: glass ? .85 : .25, clearcoatRoughness: .16, envMapIntensity: glass ? 4 : 1.8, vertexColors: true,
  });
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
 * 娣卞湷婀炬按闈細鍋忕豢鐨勮摑銆?*寰堝厜婊?*鐨勯暅闈紙roughness 0.05锛夈€佽交寰噾灞炴劅锛?.3锛夈€?
 *
 * 涓轰粈涔?roughness 蹇呴』鍘嬪埌 0.05锛氬煄甯傞噷娌℃湁姘撮潰娉曠嚎鍔ㄧ敾锛堥潤鎬佸钩闈級锛?
 * roughness 楂樹簬 0.1 鏃剁幆澧冭创鍥句細琚钩鍧囨垚涓€鍧楃伆鏉匡紝娴烽潰鐪嬩笉鍑?鍙嶅厜"锛?
 * 浣庣矖绯欏害 + envMapIntensity 2 鎵嶈兘璁?128虏 灞€閮ㄧ珛鏂逛綋鍙嶅皠鎶婂宀?澶╃┖鎷夎繘姘撮噷銆?
 * metalness 0.3 鏄?鑴忔捣姘?鎮诞娉ユ矙"鐨勬姌涓細0 澶儚濉戞枡锛? 浼氭妸婕弽灏勫叏閮ㄥ悆鎺夈€?
 *
 * **蹇呴』鏈夋樉寮?envMap**锛堢敱 `CityScene.captureEnvironment()` 缁戝畾锛夛細three r170 鍦?
 * `material.envMap` 涓虹┖鏃剁敤 `scene.environmentIntensity` 瑕嗙洊鏉愯川鐨?envMapIntensity锛?
 * 姘撮潰浼氬彉鎴愪竴鍧椾笉鍙嶅皠鐨勭伆鏉裤€?
 */
export function waterMaterial(): THREE.MeshPhysicalMaterial {
  const material = new THREE.MeshPhysicalMaterial({
    color: WATER_COLOR, roughness: 0.05, metalness: 0.3,
    clearcoat: 0.45, clearcoatRoughness: 0.06, envMapIntensity: 2,
  });
  material.name = 'city-water';
  return material;
}

/**
 * 宀哥嚎娉℃搏/娌欑嚎锛氳创鐫€姘村哺鍐呬晶鐨勪竴鏉′寒甯︼紙鍑犱綍瑙?`geometry.ts#shoreGeometry`锛夈€?
 *
 * 鐢ㄤ綆閲戝睘搴︺€侀珮绮楃硻搴︾殑鏍囧噯鏉愯川锛?*涓嶇粦鍙嶅皠鍥?*锛氳繖鏉″甫瀛愭槸鐧芥搏锛屼笉鏄暅闈紱
 * 缁戜簡 envMap 浼氬彉鎴愪竴鏉″彂浜殑閾惰竟锛屽弽鑰屾洿鍍忛┈璺墮瀛愩€?
 */
export function shoreMaterial(): THREE.MeshStandardMaterial {
  const material = new THREE.MeshStandardMaterial({ color: SHORE_COLOR, roughness: 0.92, metalness: 0 });
  material.name = 'city-shore';
  return material;
}

/**
 * LOD0 灞嬮《缁嗚妭锛堝コ鍎垮 + 灞嬮《璁惧鐩掞級锛氶《鐐硅壊銆佷笉閲囨牱绔嬮潰 atlas銆?
 *
 * 涓轰粈涔堝崟鐙竴涓潗璐ㄨ€屼笉鏄鐢?`facadeMaterial`锛氬眿椤剁粏鑺?*涓嶈繘纰版挒銆佷笉 bake**锛?
 * 鑰屼笖姣旂珛闈㈡繁涓€妗ｏ紱娣疯繘 9 涓珛闈㈡壒娆′細鎶婂眿椤朵篃甯﹁繘 `colliderArrays()`锛?
 * 鐮村潖"娓叉煋涓庣鎾炲悓婧?鐨勮竟鐣屻€?
 */
export function roofMaterial(): THREE.MeshStandardMaterial {
  const material = new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.86, metalness: 0.04 });
  material.name = 'city-roofs';
  return material;
}

/**
 * 杩滃北鍓奖锛欱asic 鏉愯川 + 椤剁偣鑹?+ 闆俱€?
 *
 * 涓轰粈涔堜笉鐢?Standard锛氳繙鏅北鑴婂彧璇ヨ础鐚?*杞粨涓庨鑹?*锛屽彈鍏変細闅忓お闃虫柟鍚戝彉锛?
 * 鍙嶈€屾毚闇插畠鏄袱鐗囩珫澧欙紱Basic + 闆炬墠鏄?琚捣闆惧悆鎺夌殑灞卞奖"銆?
 * `fog` 蹇呴』淇濇寔榛樿 true锛堥浘浼氭妸瀹冩帹杩滐級锛宍side: DoubleSide` 璁╅笩鐬颁粠鑳岄潰涔熺湅寰楀埌銆?
 */
export function ridgeMaterial(): THREE.MeshBasicMaterial {
  const material = new THREE.MeshBasicMaterial({ color: 0xffffff, vertexColors: true, fog: true, side: THREE.DoubleSide });
  material.name = 'city-ridges';
  return material;
}

/** 浜鸿閬擄細姣旀播闈掍寒銆佹瘮鑺卞矖宀╅摵瑁呮祬锛屽鐢ㄨ姳宀楀博璐村浘浣嗕笉棰濆鍔犺浇璧勪骇銆?*/
export function sidewalkMaterial(maps: SurfaceMaps): THREE.MeshStandardMaterial {
  return new THREE.MeshStandardMaterial({ map: maps.color, normalMap: maps.normal, normalScale: new THREE.Vector2(.18, .18),
    roughnessMap: maps.arm, aoMap: maps.arm, aoMapIntensity: .4, roughness: 1, color: 0xd2d4d0 });
}

/** 浣庢ā杞︼細椤剁偣鑹诧紙姣忚締杞︿竴涓鑹诧級锛岀矖绯欓噾灞炴紗锛屼笉鎶曞奖涔熶笉鍚冮槾褰便€?*/
export function carMaterial(): THREE.MeshStandardMaterial {
  return new THREE.MeshStandardMaterial({ vertexColors: true, roughness: .42, metalness: .35, envMapIntensity: 1.2 });
}


