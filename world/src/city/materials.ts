import * as THREE from 'three';
import { LIGHTING_PRESETS, type LightingPreset } from '../render/lighting';
import type { CityBuilding } from './data';
import { PING_AN_ID } from './landmark';

export type FacadeStyle = 'glass' | 'office' | 'stone';
export const FACADE_MODULE = { width: 3.2, height: 3.8, textureSize: 512, columns: 4, rows: 6 } as const;
export const STREET_PALETTE = {
  paving: 0xb7b9b7, asphalt: 0x475259, metal: 0x364e57,
  timber: 0x9d7850, trunk: 0x72634c, leaves: [0x547a48, 0x6b914e, 0x3b6447],
  steel: 0xcad5d5, lamp: 0xffe6b2,
} as const;

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
    if (failed?.status === 'rejected') throw new Error(`街区PBR贴图加载失败：${name}`);
    return [name, Object.fromEntries(maps.map(result => (result as PromiseFulfilledResult<readonly [string, THREE.Texture]>).value))] as const;
  }));
  const failed = sets.find(result => result.status === 'rejected');
  if (failed?.status === 'rejected') {
    loaded.forEach(map => map.dispose());
    throw failed.reason;
  }
  return Object.fromEntries(sets.map(result => (result as PromiseFulfilledResult<readonly [string, object]>).value)) as unknown as SurfaceAssets;
}

export function facadeStyle(building: CityBuilding): FacadeStyle {
  if (building.id === PING_AN_ID || building.height >= 65) return 'glass';
  return building.height >= 24 ? 'office' : 'stone';
}

export const CITY_LIGHTING: Readonly<Record<string, LightingPreset>> = {
  day: { ...LIGHTING_PRESETS.day!, background: 0xc4d0d8,
    fog: { ...LIGHTING_PRESETS.day!.fog, color: 0xd6dcdf },
    sun: { ...LIGHTING_PRESETS.day!.sun, color: 0xfff3e8, intensity: 2.3 },
    hemi: { sky: 0xe0e5e8, ground: 0x767975, intensity: 0.7 },
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

export function facadeMaterial(style: FacadeStyle, stoneImage: CanvasImageSource): THREE.MeshPhysicalMaterial {
  const color = canvas(), roughness = canvas(), metalness = canvas(), normals = canvas();
  const c = color.getContext('2d')!, r = roughness.getContext('2d')!, m = metalness.getContext('2d')!, n = normals.getContext('2d')!;
  const glass = style === 'glass', size = FACADE_MODULE.textureSize;
  const cellW = size / FACADE_MODULE.columns, cellH = size / FACADE_MODULE.rows;
  c.fillStyle = glass ? '#a5adb0' : style === 'office' ? '#bbbdbb' : '#c7c5bf'; c.fillRect(0, 0, size, size);
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
      c.fillStyle = `rgb(${value},${value + 9},${value + 14})`; c.fillRect(x, y, width, height);
      if (!glass && random > .72) {
        c.fillStyle = '#8b887d'; c.fillRect(x + 2, y + 2, width - 4, height * .55);
        c.strokeStyle = '#666b6b'; c.lineWidth = .6;
        for (let line = y + 5; line < y + height * .55; line += 3) { c.beginPath(); c.moveTo(x + 2, line); c.lineTo(x + width - 2, line); c.stroke(); }
      }
      c.fillStyle = '#242e33'; c.fillRect(x, y + height - 2, width, 2);
      c.fillStyle = glass ? '#c8ced0' : '#969e9d'; c.fillRect(x - 1, y, 1, height);
      const rough = Math.round(32 + random * 19);
      r.fillStyle = `rgb(${rough},${rough},${rough})`; r.fillRect(x, y, width, height);
      m.fillStyle = '#050505'; m.fillRect(x, y, width, height);
      n.fillStyle = `rgb(${Math.round(127 + random * 3)},${Math.round(129 - random * 3)},255)`; n.fillRect(x, y, width, height);
      n.fillStyle = '#a080f0'; n.fillRect(x - 1, y, 1, height);
      n.fillStyle = '#6080f0'; n.fillRect(x + width, y, 1, height);
    }
  }
  return new THREE.MeshPhysicalMaterial({
    map: atlas(color, true), roughnessMap: atlas(roughness), metalnessMap: atlas(metalness), normalMap: atlas(normals),
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
