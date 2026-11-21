import * as THREE from 'three';
import type RAPIER_NS from '@dimforge/rapier3d-compat';
import type { Room } from '../core/room';
import type { PhysicsWorld } from '../physics/engine';
import { bakeTrimesh, type Rapier } from '../physics/bake';
import type { WorldRenderer } from '../render/scene';
import {
  parseCityData, type CityBuilding, type CityData, type CityLandmark,
} from './data';
import {
  facadeChunks, colliderArrays, landmarkProfiles, roadGeometry, ridgeGeometry, roofGeometry,
  waterGeometry, shoreGeometry, sidewalkGeometry, carGeometry,
} from './geometry';
import {
  CITY_LIGHTING, FACADE_TINT_KEYS, facadeMaterial, pavingMaterial, asphaltMaterial, streetKitMaterial,
  waterMaterial, shoreMaterial, roofMaterial, ridgeMaterial, sidewalkMaterial, carMaterial,
  windowEmissiveIntensity, loadSurfaceAssets, type SurfaceAssets,
  type FacadeStyle, type FacadeTint,
} from './materials';
import { buildStreetKit, streetSign, type StreetKitGeometry } from './kit';
import {
  DynamicGround, TileStreamer, fetchTileJson, parseCityIndex, prefetchSpawnTiles, spawnTileIds,
  type CityIndexLandmark, type CityTileIndex, type CityTilePayload, type TileStats,
} from './tiles';

/** 可加载的街区。新增街区 = 加一个 key + 一份 `assets/city/<key>.json`，不改装配代码。 */
export type CitySceneKey = 'futian' | 'nanshan';

/** 没有 `data.note` 时的通用说明；不写死任何具体建筑/高度。 */
export const GENERIC_CITY_NOTE = '地标与街道设施为简化示意，非实景复刻。';

export interface CityInfoText {
  title: string;
  summary: string;
  note: string;
}

/** 瓦片路径没有逐楼清单：总建筑/道路数由 `index.json#counts` 提供。 */
export interface CityInfoCounts {
  buildings: number;
  roads: number;
}

/**
 * 信息卡文案（纯函数，便于在 node 里断言）。
 *
 * 规则：标题用 `data.name`；**地标说明只在数据声明了地标时写**（单个 `landmark` 与
 * `landmarks[]` 合并、同 id 去重），不能把某条街区的名字/高度挂到别的街区；
 * note 用 `data.note ?? 通用文案`。瓦片路径传 `counts`——索引里没有 buildings[]，
 * 直接读 `data.buildings.length` 会把 12,194 栋说成 0。
 */
export function cityInfoText(data: CityData, counts?: CityInfoCounts): CityInfoText {
  const declared = new Map<string, { name: string; height: number }>();
  if (data.landmark) declared.set(data.landmark.id, data.landmark);
  for (const landmark of data.landmarks ?? []) if (!declared.has(landmark.id)) declared.set(landmark.id, landmark);
  const landmarkText = declared.size
    ? `地标 ${[...declared.values()].map(item => `${item.name} ${item.height}m`).join('、')} 为识别型简化，其余高度为模型估算。`
    : '建筑高度均为模型估算。';
  return {
    title: data.name,
    summary: `${(counts?.buildings ?? data.buildings.length).toLocaleString()} 个建筑轮廓 · WASD 移动 / Shift 奔跑 / 空格跳跃`,
    note: `${landmarkText}${data.note ?? GENERIC_CITY_NOTE}`,
  };
}

/** 几何是否有顶点。空几何（无铺装/无零件/零长度道路）不该建 mesh，也不该烘焙碰撞。 */
export function hasVertices(geometry: THREE.BufferGeometry): boolean {
  const position = geometry.getAttribute('position');
  return position !== undefined && position.count > 0;
}

export type StreetKitPartName = 'city-paving' | 'city-street-kit' | 'city-lamp-glow';

export interface StreetKitPart {
  name: StreetKitPartName;
  geometry: THREE.BufferGeometry;
  collision: boolean;
}

/**
 * 街道零件里**真的有顶点**的那几个。`mount` 只遍历这个清单，
 * 因此空 street（没有铺装/没有零件）既不建空 mesh，也不给空几何调 `bakeTrimesh`。
 */
export function streetKitParts(kit: StreetKitGeometry): StreetKitPart[] {
  const parts: StreetKitPart[] = [
    { name: 'city-paving', geometry: kit.paving, collision: true },
    { name: 'city-street-kit', geometry: kit.solids, collision: true },
    { name: 'city-lamp-glow', geometry: kit.lamps, collision: false },
  ];
  return parts.filter(part => hasVertices(part.geometry));
}

/** 只在视觉层出现的静态图层：水面 / 岸线 / 人行道 / 低模车。**都不进碰撞**。 */
export type CityLayerName = 'city-water' | 'city-shore' | 'city-sidewalks' | 'city-cars';

export interface CityLayerPart {
  name: CityLayerName;
  geometry: THREE.BufferGeometry;
}

/**
 * 水面 + 岸线亮带（两个全局图层；瓦片模式只用这两个，人行道/车按片走）。
 *
 * 没有 `data.water` 就两层都不建（南山以外的街区可能没有海）。
 */
export function waterLayerParts(data: CityData): { name: 'city-water' | 'city-shore'; geometry: THREE.BufferGeometry }[] {
  const parts: { name: 'city-water' | 'city-shore'; geometry: THREE.BufferGeometry }[] = [];
  const push = (name: 'city-water' | 'city-shore', geometry: THREE.BufferGeometry): void => {
    if (hasVertices(geometry)) parts.push({ name, geometry });
    else geometry.dispose();
  };
  if (!data.water) return parts;
  const level = data.water.level ?? -0.1;
  push('city-water', waterGeometry(data.water.rings, level));
  push('city-shore', shoreGeometry(data.water.rings, level));
  return parts;
}

/**
 * 水面 / 岸线 / 人行道 / 车这些层都是纯视觉：不 bakeTrimesh、不加 collider。
 *
 * 为什么单独抽成纯函数：`mount()` 需要 DOM/WebGL，node 里跑不了；
 * 把"建哪些层、有没有顶点"放在这里，测试就能断言
 * 「water 存在且 collision=false」「空 water/空道路不建 mesh」而不用假的渲染器。
 */
export function cityLayerParts(data: CityData): CityLayerPart[] {
  const parts: CityLayerPart[] = [...waterLayerParts(data)];
  const push = (name: CityLayerName, geometry: THREE.BufferGeometry): void => {
    if (hasVertices(geometry)) parts.push({ name, geometry });
    else geometry.dispose();
  };
  push('city-sidewalks', sidewalkGeometry(data.roads));
  push('city-cars', carGeometry(data));
  return parts;
}

/** 瓦片模式需要的索引与出生预取（由 `loadCity` 准备；mount 只是同步装配）。 */
export interface TiledCity {
  index: CityTileIndex;
  /** 出生 3×3 的 compact JSON 片（`loadCity` 已取回并校验）。 */
  preloaded: ReadonlyMap<string, CityTilePayload>;
}

/** `single` = 一次性整城（旧路径/回退）；`tiles` = 1km 瓦片流式。 */
export type CitySceneMode = 'single' | 'tiles';

export class CityScene {
  readonly room: Room;
  readonly lightingPresets = CITY_LIGHTING;
  readonly group = new THREE.Group();
  readonly mode: CitySceneMode;
  private renderer: WorldRenderer | null = null;
  private physics: PhysicsWorld | null = null;
  private colliders: RAPIER_NS.Collider[] = [];
  private geometries: THREE.BufferGeometry[] = [];
  private materials: THREE.Material[] = [];
  private textures: THREE.Texture[] = [];
  private panel: HTMLElement | null = null;
  private overview = false;
  private environmentTarget: THREE.WebGLRenderTarget | null = null;
  private previousEnvironment: THREE.Texture | null = null;
  private environmentPreset = '';
  private reflectionMaterials: THREE.MeshStandardMaterial[] = [];
  /** 立面材质（9 个或更少）：夜间亮窗逐帧调 `emissiveIntensity` 用。 */
  private facadeMaterials: THREE.MeshPhysicalMaterial[] = [];
  private streamer: TileStreamer | null = null;
  private ground: DynamicGround | null = null;
  private debugRestore: (() => void) | null = null;

  constructor(
    readonly data: CityData,
    private readonly surfaces?: SurfaceAssets,
    readonly sceneKey: CitySceneKey = 'futian',
    readonly tiled?: TiledCity,
  ) {
    this.mode = tiled ? 'tiles' : 'single';
    const half = Math.ceil(Math.max(...data.bounds.map(Math.abs)) / 100) * 100 + 20;
    // Kilometre-wide thin cuboids lose contact precision; small coplanar slabs keep feet grounded.
    const ground: Room['static'] = [];
    // 瓦片模式不铺整城地面：`DynamicGround` 维护跟随玩家的 5×5×128m 块（契约 §4）。
    // 单 JSON 回退保持旧行为（整城小块），既有测试与浏览器验收据此不动。
    if (!tiled) {
      for (let x = -half; x < half; x += 128) {
        for (let z = -half; z < half; z += 128) {
          const width = Math.min(128, half - x), depth = Math.min(128, half - z);
          ground.push({ type: 'box', pos: [x + width / 2, -0.1, z + depth / 2], size: [width, 0.2, depth], mat: 'floor' });
        }
      }
    }
    this.room = {
      name: data.name, spawn: [data.spawn], lights: [], props: [], seats: [],
      static: [
        ...ground,
        ...([-1, 1] as const).flatMap(sign => [
          { type: 'box' as const, pos: [sign * half, 0.7, 0] as [number, number, number], size: [0.4, 1.4, half * 2] as [number, number, number], mat: 'stair' },
          { type: 'box' as const, pos: [0, 0.7, sign * half] as [number, number, number], size: [half * 2, 1.4, 0.4] as [number, number, number], mat: 'stair' },
        ]),
      ],
    };
  }

  mount(renderer: WorldRenderer, physics: PhysicsWorld, rapier: Rapier): void {
    this.renderer = renderer;
    this.physics = physics;
    const surfaces = this.surfaces;
    if (!surfaces) throw new Error('街区PBR材质尚未准备好');
    for (const maps of Object.values(surfaces)) this.textures.push(maps.color, maps.normal, maps.arm);
    this.group.name = `${this.sceneKey}-city`;
    this.group.userData = { buildings: this.data.buildings.length, roads: this.data.roads.length };
    renderer.scene.add(this.group);
    const floor = renderer.scene.getObjectByName('room-floor') as THREE.Mesh<THREE.BufferGeometry, THREE.MeshStandardMaterial>;
    floor.material.color.setHex(0x949a95);
    const shadow = renderer.lights.sun.shadow.camera;
    shadow.left = shadow.bottom = -45;
    shadow.right = shadow.top = 45;
    shadow.far = 1800;
    shadow.updateProjectionMatrix();
    floor.material.map = null;
    floor.material.vertexColors = false;
    floor.material.needsUpdate = true;
    try {
      if (this.tiled) this.mountTiles(surfaces, physics, rapier);
      else this.mountSingle(surfaces, physics, rapier);
      this.captureEnvironment(renderer);
      this.mountInfoPanel();
      this.attachTileDebug();
      // mount 发生在 `setLightingImmediate(?time=night)` 之后：进来就按当前预设点亮窗户，
      // 不能等第一帧 update（首帧会闪一下黑楼）。
      this.applyWindowEmissive();
    } catch (error) {
      this.dispose();
      throw error;
    }
  }

  /**
   * 视觉层挂载：几何/材质进同一本销毁台账，**不 bakeTrimesh**。
   *
   * 只在视觉层使用（水面/岸线/远山/屋顶/车）：这些几何一旦进了 `colliderArrays()`，
   * 玩家就会撞到"楼顶的女儿墙""山脚"，而它们本来只是远景。
   */
  private addVisualLayer(name: string, geometry: THREE.BufferGeometry, material: THREE.Material,
    castShadow = false, receiveShadow = false): THREE.Mesh {
    this.geometries.push(geometry);
    this.materials.push(material);
    const mesh = new THREE.Mesh(geometry, material);
    mesh.name = name;
    mesh.castShadow = castShadow;
    mesh.receiveShadow = receiveShadow;
    this.group.add(mesh);
    return mesh;
  }

  /** 单 JSON 回退路径：几何全部在这里一次性建好（瓦片化之前的旧行为不变）。 */
  private mountSingle(surfaces: SurfaceAssets, physics: PhysicsWorld, rapier: Rapier): void {
      const facades = new Map<string, THREE.MeshPhysicalMaterial>();
      const chunks = facadeChunks(this.data);
      this.geometries.push(...chunks.map(chunk => chunk.geometry));
      for (const [index, { geometry, style, tint }] of chunks.entries()) {
        const key = `${style}:${tint}`;
        let material = facades.get(key);
        if (!material) {
          material = facadeMaterial(style, surfaces.granite.color.image as CanvasImageSource, tint);
          facades.set(key, material);
          this.reflectionMaterials.push(material);
          this.facadeMaterials.push(material);
          this.materials.push(material);
          this.textures.push(material.map!, material.normalMap!, material.roughnessMap!, material.metalnessMap!);
        }
        const mesh = new THREE.Mesh(geometry, material);
        mesh.name = `city-buildings-${style}-${tint}-${index}`;
        mesh.castShadow = true;
        mesh.receiveShadow = true;
        this.group.add(mesh);
        const { vertices, indices } = colliderArrays(geometry);
        this.colliders.push(bakeTrimesh(rapier, physics.world, vertices, indices));
      }
      for (const walkway of [false, true]) {
        const roads = this.data.roads.filter(road => road.walkway === walkway);
        if (!roads.length) continue;
        const geometry = roadGeometry(roads);
        // 全是重复点/零长段时顶点为 0：不建 mesh，也不把空几何塞进销毁清单。
        if (!hasVertices(geometry)) { geometry.dispose(); continue; }
        const material = walkway ? pavingMaterial(surfaces.granite) : asphaltMaterial(surfaces.asphalt);
        this.geometries.push(geometry);
        this.materials.push(material);
        const mesh = new THREE.Mesh(geometry, material);
        mesh.name = walkway ? 'city-walkways' : 'city-roads';
        mesh.receiveShadow = true;
        this.group.add(mesh);
      }
      const kit = buildStreetKit(this.data);
      const streetParts = streetKitParts(kit);
      for (const part of streetParts) {
        const material = part.name === 'city-paving' ? pavingMaterial(surfaces.granite)
          : part.name === 'city-street-kit' ? streetKitMaterial()
            : new THREE.MeshBasicMaterial({ vertexColors: true });
        this.geometries.push(part.geometry);
        this.materials.push(material);
        if (part.name === 'city-street-kit') this.reflectionMaterials.push(material as THREE.MeshStandardMaterial);
        const mesh = new THREE.Mesh(part.geometry, material);
        mesh.name = part.name;
        mesh.castShadow = part.name === 'city-street-kit';
        mesh.receiveShadow = true;
        this.group.add(mesh);
        if (part.collision) {
          const arrays = colliderArrays(part.geometry);
          this.colliders.push(bakeTrimesh(rapier, physics.world, arrays.vertices, arrays.indices));
        }
      }
      // 没进清单的空几何（没有铺装/没有街道零件）在这里统一释放，避免留着没人管的空对象。
      const usedStreetGeometry = new Set(streetParts.map(part => part.geometry));
      for (const geometry of [kit.paving, kit.solids, kit.lamps]) {
        if (!usedStreetGeometry.has(geometry)) geometry.dispose();
      }
      // 视觉层：水面 / 岸线 / 人行道 / 低模车。**不 bakeTrimesh、不建 collider**：
      // 水是远景、岸线只是水边一条亮带、人行道只是贴地条带、车是静态装饰，都不该挡住玩家。
      const layers = cityLayerParts(this.data);
      for (const layer of layers) {
        const material = layer.name === 'city-water' ? waterMaterial()
          : layer.name === 'city-shore' ? shoreMaterial()
            : layer.name === 'city-sidewalks' ? sidewalkMaterial(surfaces.granite)
              : carMaterial();
        // 水和车是金属/低粗糙度材质：必须显式绑定反射图，否则会变成灰板。
        // 岸线/人行道是粗糙面，绑了反射反而像一条发亮的马路牙子。
        if (layer.name === 'city-water' || layer.name === 'city-cars') {
          this.reflectionMaterials.push(material as THREE.MeshStandardMaterial);
        }
        const mesh = this.addVisualLayer(layer.name, layer.geometry, material,
          layer.name === 'city-cars', layer.name !== 'city-water' && layer.name !== 'city-shore');
        // 水面不接收阴影（海面没有可投影的遮挡）。
        if (layer.name === 'city-water') mesh.receiveShadow = false;
      }
      // 屋顶细节：单独 mesh、不碰撞、不 bake（`roofGeometry` 的返回值绝不进 facadeChunks）。
      const roofs = roofGeometry(this.data.buildings, landmarkProfiles(this.data));
      if (hasVertices(roofs)) this.addVisualLayer('city-roofs', roofs, roofMaterial(), false, true);
      else roofs.dispose();
      // 远山：只在城市南/西 bounds 之外，靠雾收尾，不碰撞也不参与阴影。
      const ridges = ridgeGeometry(this.data.bounds);
      if (hasVertices(ridges)) this.addVisualLayer('city-ridges', ridges, ridgeMaterial());
      else ridges.dispose();
      this.group.userData = {
        buildings: this.data.buildings.length, roads: this.data.roads.length,
        layers: [...layers.map(layer => layer.name), 'city-roofs', 'city-ridges'],
      };
      for (const label of kit.labels) {
        const mesh = streetSign(label.text, label.width);
        mesh.position.set(label.x, label.y, label.z);
        mesh.rotation.y = label.yaw;
        mesh.name = 'city-sign';
        this.geometries.push(mesh.geometry);
        this.materials.push(mesh.material);
        this.textures.push(mesh.material.map!);
        this.group.add(mesh);
      }
  }

  /**
   * 瓦片路径：全局图层（水/街道零件/地标构件）在这里一次装配，
   * 建筑/道路/人行道按片由 `TileStreamer` 加载；碰撞只给 250m 内的 LOD0。
   */
  private mountTiles(surfaces: SurfaceAssets, physics: PhysicsWorld, rapier: Rapier): void {
    const tiled = this.tiled!;
    // 复用单 JSON 路径的 9 个立面材质（样式 × 色调）并在瓦片间共享：
    // compact JSON 瓦片走 `facadeChunks()`，每片最多 9 批，但材质/atlas 只建一次。
    const facade = {} as Record<FacadeStyle, Record<FacadeTint, THREE.Material>>;
    for (const style of ['glass', 'office', 'stone'] as const) {
      const tints = {} as Record<FacadeTint, THREE.Material>;
      for (const tint of FACADE_TINT_KEYS) {
        const material = facadeMaterial(style, surfaces.granite.color.image as CanvasImageSource, tint);
        tints[tint] = material;
        this.facadeMaterials.push(material);
        this.materials.push(material);
        this.reflectionMaterials.push(material);
        this.textures.push(material.map!, material.normalMap!, material.roughnessMap!, material.metalnessMap!);
      }
      facade[style] = tints;
    }
    const lod1 = new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.92, metalness: 0.02 });
    lod1.name = 'city-tile-lod1';
    const roads = asphaltMaterial(surfaces.asphalt);
    const walkways = pavingMaterial(surfaces.granite);
    const sidewalks = sidewalkMaterial(surfaces.granite);
    // 屋顶细节材质跨片共享（每片一个 mesh、一个材质）：LOD1 不建屋顶，所以只有 LOD0 片有。
    const roofs = roofMaterial();
    this.materials.push(lod1, roads, walkways, sidewalks, roofs);

    // 全局街道零件（树/灯/雨棚/铺装）来自 `index.street`，不按片重复。
    const kit = buildStreetKit(this.data);
    const streetParts = streetKitParts(kit);
    for (const part of streetParts) {
      const material = part.name === 'city-paving' ? pavingMaterial(surfaces.granite)
        : part.name === 'city-street-kit' ? streetKitMaterial()
          : new THREE.MeshBasicMaterial({ vertexColors: true });
      this.geometries.push(part.geometry);
      this.materials.push(material);
      if (part.name === 'city-street-kit') this.reflectionMaterials.push(material as THREE.MeshStandardMaterial);
      const mesh = new THREE.Mesh(part.geometry, material);
      mesh.name = part.name;
      mesh.castShadow = part.name === 'city-street-kit';
      mesh.receiveShadow = true;
      this.group.add(mesh);
      if (part.collision) {
        const arrays = colliderArrays(part.geometry);
        this.colliders.push(bakeTrimesh(rapier, physics.world, arrays.vertices, arrays.indices));
      }
    }
    const usedStreetGeometry = new Set(streetParts.map(part => part.geometry));
    for (const geometry of [kit.paving, kit.solids, kit.lamps]) {
      if (!usedStreetGeometry.has(geometry)) geometry.dispose();
    }
    for (const label of kit.labels) {
      const mesh = streetSign(label.text, label.width);
      mesh.position.set(label.x, label.y, label.z);
      mesh.rotation.y = label.yaw;
      mesh.name = 'city-sign';
      this.geometries.push(mesh.geometry);
      this.materials.push(mesh.material);
      this.textures.push(mesh.material.map!);
      this.group.add(mesh);
    }

    // 水面 + 岸线是全局远景：各 1 个 mesh、不碰撞、不参与瓦片（契约 §4）。
    for (const layer of waterLayerParts(this.data)) {
      const material = layer.name === 'city-water' ? waterMaterial() : shoreMaterial();
      if (layer.name === 'city-water') this.reflectionMaterials.push(material as THREE.MeshStandardMaterial);
      const mesh = this.addVisualLayer(layer.name, layer.geometry, material);
      mesh.receiveShadow = false;
    }
    // 远山剪影是全局的（不按片重复），在瓦片模式下也照样挂一次。
    const ridges = ridgeGeometry(this.data.bounds);
    if (hasVertices(ridges)) this.addVisualLayer('city-ridges', ridges, ridgeMaterial());
    else ridges.dispose();

    const indexUrl = new URL(`assets/city/${this.sceneKey}/index.json`, document.baseURI);
    this.streamer = new TileStreamer({
      index: tiled.index,
      group: this.group,
      materials: { facade, lod1, roads, walkways, sidewalks, roofs },
      loadJson: url => fetchTileJson(url),
      baseUrl: indexUrl.href,
      preloaded: tiled.preloaded,
      collision: {
        bake: (vertices, indices) => bakeTrimesh(rapier, physics.world, vertices, indices),
        remove: handle => physics.world.removeCollider(handle as RAPIER_NS.Collider, false),
      },
    });
    // 出生 3×3 LOD0 已在 `loadCity` 预取完，这里同步挂上（不再 fetch）。
    this.streamer.warmup(spawnTileIds(tiled.index));
    this.ground = new DynamicGround(rapier, physics.world);
    this.ground.install(this.data.spawn[0], this.data.spawn[2]);
    this.group.userData = {
      buildings: tiled.index.counts?.buildings ?? 0,
      roads: tiled.index.counts?.roads ?? 0,
      tiles: tiled.index.tiles.length,
      mode: 'tiles',
    };
  }

  /** 信息卡（数据来源、局限、鸟瞰按钮）。单 JSON 与瓦片路径共用。 */
  private mountInfoPanel(): void {
    const info = cityInfoText(this.data, this.tiled?.index.counts);
    const panel = document.createElement('section');
    panel.id = 'city-info';
    const title = document.createElement('strong');
    title.textContent = info.title;
    const text = document.createElement('p');
    text.textContent = info.summary;
    const note = document.createElement('p');
    note.textContent = info.note;
    const details = document.createElement('details');
    const summary = document.createElement('summary');
    summary.textContent = '数据来源与局限';
    details.append(summary);
    for (const source of this.data.attribution) {
      const link = document.createElement('a');
      link.textContent = source.label;
      link.href = source.url;
      link.target = '_blank';
      link.rel = 'noopener noreferrer';
      details.append(link);
    }
    const limits = document.createElement('p');
    limits.textContent = this.tiled
      ? '平地近似；道路宽度推定；1km 瓦片流式加载（出生 3×3 LOD0，视距 LOD1），尚无立交/地形。'
      : '平地近似；道路宽度推定，尚无立交、地形或瓦片流式加载。';
    details.append(limits);
    const view = document.createElement('button');
    view.type = 'button';
    view.textContent = '鸟瞰街区';
    view.setAttribute('aria-pressed', 'false');
    view.addEventListener('click', () => {
      this.overview = !this.overview;
      view.textContent = this.overview ? '返回步行' : '鸟瞰街区';
      view.setAttribute('aria-pressed', String(this.overview));
    });
    panel.append(title, text, note, view, details);
    document.body.append(panel);
    this.panel = panel;
  }

  /**
   * `__worldDebug` 的瓦片统计。单 JSON 路径返回全 0（字段始终存在，脚本不用判空）。
   *
   * 为什么由 city 模块自己挂：`main.ts` 是公共脊柱（只 L 可改），而它已经冻结
   * `__worldDebug` 的形状。这里在 mount 时**包装** `read()` 并补 6 个字段，
   * 既有 e2e（`read().fps` 等）逐字段不变；dispose 时还原。
   */
  tileStats(): TileStats {
    return this.streamer?.stats() ?? {
      tilesLoaded: 0, lod0: 0, lod1: 0, collisionTiles: 0, loadsLastFrame: 0, msLastFrame: 0,
    };
  }

  private attachTileDebug(): void {
    if (typeof window === 'undefined') return;
    const debug = (window as unknown as { __worldDebug?: { read?: () => Record<string, unknown> } }).__worldDebug;
    if (!debug || typeof debug.read !== 'function') return;
    const original = debug.read.bind(debug);
    debug.read = (): Record<string, unknown> => ({ ...original(), ...this.tileStats() });
    const keys = ['tilesLoaded', 'lod0', 'lod1', 'collisionTiles', 'loadsLastFrame', 'msLastFrame'] as const;
    for (const key of keys) {
      Object.defineProperty(debug, key, { configurable: true, get: () => this.tileStats()[key] });
    }
    this.debugRestore = () => {
      debug.read = original;
      for (const key of keys) delete (debug as Record<string, unknown>)[key];
    };
  }

  private captureEnvironment(renderer: WorldRenderer): void {
    if (!this.environmentTarget) this.previousEnvironment = renderer.scene.environment;
    const previousTarget = this.environmentTarget;
    renderer.scene.environment = this.previousEnvironment;
    for (const material of this.reflectionMaterials) material.envMap = null;
    const cube = new THREE.WebGLCubeRenderTarget(128, { type: THREE.HalfFloatType });
    const probe = new THREE.CubeCamera(1, 2500, cube);
    probe.position.set(this.data.spawn[0], 18, this.data.spawn[2]);
    const pmrem = new THREE.PMREMGenerator(renderer.renderer);
    const shadowAutoUpdate = renderer.renderer.shadowMap.autoUpdate;
    renderer.renderer.shadowMap.autoUpdate = false;
    try {
      probe.update(renderer.renderer, renderer.scene);
      this.environmentTarget = pmrem.fromCubemap(cube.texture);
      this.environmentTarget.texture.name = `${this.sceneKey}-local-reflection`;
      renderer.scene.environment = this.environmentTarget.texture;
      // three.js overrides envMapIntensity with scene intensity unless envMap is explicit.
      for (const material of this.reflectionMaterials) {
        material.envMap = this.environmentTarget.texture;
        material.needsUpdate = true;
      }
      previousTarget?.dispose();
      this.environmentPreset = renderer.getLightingState().current;
    } finally {
      renderer.renderer.shadowMap.autoUpdate = shadowAutoUpdate;
      pmrem.dispose();
      cube.dispose();
    }
  }

  update(position: THREE.Vector3, camera: THREE.PerspectiveCamera): void {
    if (!this.renderer) return;
    if (this.overview) {
      // 瓦片模式只加载了玩家周围 3×3；鸟瞰要框住**已加载的街区**，不是整座 5km 城市，
      // 否则画面里 90% 是没加载的空地。单 JSON 模式仍框整城。
      if (this.mode === 'tiles') {
        camera.position.set(position.x, 1100, position.z + 700);
        camera.lookAt(position.x, 0, position.z);
      } else {
        const half = Math.max(...this.data.bounds.map(Math.abs));
        camera.position.set(0, half * 1.25 + 400, half * 0.25);
        camera.lookAt(0, 0, 0);
      }
    }
    const { sun, rim } = this.renderer.lights;
    sun.position.set(position.x + 320, position.y + 700, position.z + 440);
    sun.target.position.set(position.x, 1, position.z);
    rim.position.set(position.x - 5, 6, position.z - 5);
    rim.target.position.set(position.x, 1, position.z);
    const lighting = this.renderer.getLightingState();
    if (!lighting.target && lighting.current !== this.environmentPreset) this.captureEnvironment(this.renderer);
    // 夜间暖色亮窗：跟着光照预设走（过渡中看 target），白天归 0。
    this.applyWindowEmissive();
    // 流式加载跟随**玩家**（不是相机）：鸟瞰时也要保证脚下有瓦片/地面。
    this.streamer?.update(position.x, position.z, camera);
    this.ground?.update(position.x, position.z);
  }

  /**
   * 把立面自发光强度调到当前光照对应的值（0 / 0.6）。
   *
   * 为什么每帧比较而不是监听事件：光照状态由渲染器在 0.8s 过渡里逐帧推进，
   * 没有"切换完成"的事件可挂；比较两个数字再按需写入是零成本的。
   */
  private applyWindowEmissive(): void {
    if (!this.renderer) return;
    const intensity = windowEmissiveIntensity(this.renderer.getLightingState());
    for (const material of this.facadeMaterials) {
      if (material.emissiveIntensity !== intensity) material.emissiveIntensity = intensity;
    }
  }

  dispose(): void {
    // 先拆流式图层：它自己持有 tile geometry 与 250m 碰撞体（不能落进台账之外）。
    this.streamer?.dispose();
    this.streamer = null;
    this.ground?.dispose();
    this.ground = null;
    this.debugRestore?.();
    this.debugRestore = null;
    if (this.physics) for (const collider of this.colliders) this.physics.world.removeCollider(collider, false);
    this.colliders = [];
    this.geometries.forEach(geometry => geometry.dispose());
    this.materials.forEach(material => material.dispose());
    if (this.renderer && this.environmentTarget) this.renderer.scene.environment = this.previousEnvironment;
    this.environmentTarget?.dispose();
    this.environmentTarget = null;
    this.previousEnvironment = null;
    this.reflectionMaterials = [];
    this.facadeMaterials = [];
    this.textures.forEach(texture => texture.dispose());
    this.textures = [];
    this.geometries = [];
    this.materials = [];
    this.group.clear();
    this.group.removeFromParent();
    this.panel?.remove();
    this.panel = null;
    this.renderer = null;
    this.physics = null;
  }
}

export interface LoadCityOptions {
  /** 测试用：覆盖 `location.search`（默认读浏览器地址栏）。 */
  search?: string;
  /** 测试用：覆盖 `document.baseURI`；node 里默认 `http://localhost/`。 */
  baseURI?: string;
  /** 测试用：覆盖 `fetch`（合成 fixture 用内存表）。 */
  fetch?: typeof fetch;
  /** 测试用：跳过真实贴图加载（node 没有 DOM canvas / Image）。 */
  surfaces?: SurfaceAssets;
}

/**
 * 瓦片索引 → `CityData`（只用于信息卡 / 出生相机朝向 / 全局图层）。
 *
 * 为什么造一份近似 `CityData`：`main.ts`（公共脊柱）读 `city.data.landmarks` 与
 * `city.data.buildings` 算出生朝向，`CityScene` 的冻结接口也以 `CityData` 为数据源。
 * 瓦片里没有逐楼清单，所以 `buildings` 只放**索引带上真实轮廓的地标**，
 * 总建筑数由 `counts` 补（`cityInfoText(data, counts)`）；`roads=[]` 由瓦片负责。
 */
export function cityDataFromIndex(index: CityTileIndex): CityData {
  const landmarks = [...(index.landmark ? [index.landmark] : []), ...(index.landmarks ?? [])];
  const buildings: CityBuilding[] = [];
  for (const landmark of landmarks) {
    if (landmark.rings?.length) {
      buildings.push({
        id: landmark.id, name: landmark.name, height: landmark.height,
        // 索引里的地标都是核验高度（OSM 轮廓 + CTBUH），与单 JSON 的标记一致。
        heightSource: 'ctbuh', rings: landmark.rings,
      });
    }
  }
  const street = index.street ?? { pavingHeight: 0.12, paving: [], placements: [] };
  return {
    version: 1,
    name: index.name,
    origin: index.origin,
    bounds: index.bounds,
    spawn: index.spawn,
    buildings,
    roads: [],
    street,
    attribution: index.attribution,
    ...(index.landmark ? { landmark: landmarkShallow(index.landmark) } : {}),
    ...(index.landmarks ? { landmarks: index.landmarks.map(landmarkShallow) } : {}),
    ...(index.water ? { water: index.water } : {}),
    ...(index.note ? { note: index.note } : {}),
  };
}

/** 索引里的地标 → 冻结的 `CityLandmark`（去掉只给相机朝向用的 `rings`）。 */
function landmarkShallow(landmark: CityIndexLandmark): CityLandmark {
  return { id: landmark.id, name: landmark.name, height: landmark.height, profile: landmark.profile };
}

/**
 * 加载一个街区：**先探测瓦片索引**，404 或 `?tiles=0` 回退单 JSON。
 *
 * 顺序是契约的一部分：
 * 1. `?tiles=0` → 不发索引请求，直接单 JSON（排障/对照用）；
 * 2. `assets/city/<scene>/index.json` 200 **且是 JSON** → 走瓦片；404 → 单 JSON；
 *    200 但不是 JSON（Vite/SPA 把缺失文件回退成 index.html）等价于"没有瓦片"，回退单 JSON；
 *    其它非 2xx 抛错（索引在但坏了要立刻暴露，不能悄悄换成单 JSON 掩盖烘焙问题）；
 * 3. 瓦片路径在返回前 **await 出生 3×3 预取**，`mount()` 才能保持同步。
 */
export async function loadCity(scene: CitySceneKey = 'futian', options: LoadCityOptions = {}): Promise<CityScene> {
  const search = options.search ?? (typeof location !== 'undefined' ? location.search : '');
  const baseURI = options.baseURI ?? (typeof document !== 'undefined' ? document.baseURI : 'http://localhost/');
  const fetchImpl = options.fetch ?? globalThis.fetch.bind(globalThis);
  const surfacesPromise = options.surfaces ? Promise.resolve(options.surfaces) : loadSurfaceAssets();
  if (new URLSearchParams(search).get('tiles') !== '0') {
    const indexUrl = new URL(`assets/city/${scene}/index.json`, baseURI);
    const response = await fetchImpl(indexUrl.href);
    if (response.ok) {
      // 开发服务器会把不存在的 assets 路径回退成 index.html（200 text/html）。
      // 这不是"瓦片索引坏了"，只是这个街区还没烘焙瓦片；必须回退单 JSON。
      const contentType = response.headers?.get?.('content-type') ?? 'application/json';
      if (contentType.includes('json')) {
        const index = parseCityIndex(await response.json());
        if (index.scene !== scene) throw new Error(`瓦片索引场景不符：期望 ${scene}，索引写的是 ${index.scene}`);
        const preloaded = await prefetchSpawnTiles(index, {
          loadJson: (url: string) => fetchTileJson(url, fetchImpl),
          baseUrl: indexUrl.href,
        });
        if (preloaded.size === 0) throw new Error(`瓦片索引缺少出生点附近的瓦片（${scene}）`);
        return new CityScene(cityDataFromIndex(index), await surfacesPromise, scene, { index, preloaded });
      }
    } else if (response.status !== 404) {
      // 404 = 这个街区还没烘焙瓦片（契约允许的回退）；其它状态码是故障，抛出来。
      throw new Error(`街区瓦片索引加载失败（${scene}，HTTP ${response.status}）`);
    }
  }
  const response = await fetchImpl(new URL(`assets/city/${scene}.json`, baseURI).href);
  if (!response.ok) throw new Error(`街区数据加载失败（${scene}，HTTP ${response.status}）`);
  const data = parseCityData(await response.json());
  return new CityScene(data, await surfacesPromise, scene);
}

/**
 * @deprecated 兼容旧调用方（`?scene=futian` 时代只有这一个入口）。
 * 新代码用 `loadCity('futian')`；保留它是因为 main.ts / 验证脚本可能还按名字引用。
 */
export function loadFutian(): Promise<CityScene> {
  return loadCity('futian');
}
