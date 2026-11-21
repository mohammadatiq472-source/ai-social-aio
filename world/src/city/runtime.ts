import * as THREE from 'three';
import type RAPIER_NS from '@dimforge/rapier3d-compat';
import type { Room } from '../core/room';
import type { PhysicsWorld } from '../physics/engine';
import { bakeTrimesh, type Rapier } from '../physics/bake';
import type { WorldRenderer } from '../render/scene';
import { parseCityData, type CityData } from './data';
import { facadeChunks, colliderArrays, roadGeometry } from './geometry';
import { CITY_LIGHTING, facadeMaterial, pavingMaterial, asphaltMaterial, streetKitMaterial, loadSurfaceAssets, type FacadeStyle, type SurfaceAssets } from './materials';
import { buildStreetKit, streetSign } from './kit';

export class CityScene {
  readonly room: Room;
  readonly lightingPresets = CITY_LIGHTING;
  readonly group = new THREE.Group();
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

  constructor(readonly data: CityData, private readonly surfaces?: SurfaceAssets) {
    const half = Math.ceil(Math.max(...data.bounds.map(Math.abs)) / 100) * 100 + 20;
    // Kilometre-wide thin cuboids lose contact precision; small coplanar slabs keep feet grounded.
    const ground: Room['static'] = [];
    for (let x = -half; x < half; x += 128) {
      for (let z = -half; z < half; z += 128) {
        const width = Math.min(128, half - x), depth = Math.min(128, half - z);
        ground.push({ type: 'box', pos: [x + width / 2, -0.1, z + depth / 2], size: [width, 0.2, depth], mat: 'floor' });
      }
    }
    this.room = {
      name: 'futian', spawn: [data.spawn], lights: [], props: [], seats: [],
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
    if (!this.surfaces) throw new Error('街区PBR材质尚未准备好');
    for (const maps of Object.values(this.surfaces)) this.textures.push(maps.color, maps.normal, maps.arm);
    this.group.name = 'futian-city';
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
      const facades = new Map<FacadeStyle, THREE.MeshPhysicalMaterial>();
      const chunks = facadeChunks(this.data);
      this.geometries.push(...chunks.map(chunk => chunk.geometry));
      for (const [index, { geometry, style }] of chunks.entries()) {
        let material = facades.get(style);
        if (!material) {
          material = facadeMaterial(style, this.surfaces.granite.color.image as CanvasImageSource);
          facades.set(style, material);
          this.reflectionMaterials.push(material);
          this.materials.push(material);
          this.textures.push(material.map!, material.normalMap!, material.roughnessMap!, material.metalnessMap!);
        }
        const mesh = new THREE.Mesh(geometry, material);
        mesh.name = `city-buildings-${style}-${index}`;
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
        const material = walkway ? pavingMaterial(this.surfaces.granite) : asphaltMaterial(this.surfaces.asphalt);
        this.geometries.push(geometry);
        this.materials.push(material);
        const mesh = new THREE.Mesh(geometry, material);
        mesh.name = walkway ? 'city-walkways' : 'city-roads';
        mesh.receiveShadow = true;
        this.group.add(mesh);
      }
      const kit = buildStreetKit(this.data);
      const pavement = pavingMaterial(this.surfaces.granite);
      const kitParts = [
        { name: 'city-paving', geometry: kit.paving, material: pavement, collision: true },
        { name: 'city-street-kit', geometry: kit.solids, material: streetKitMaterial(), collision: true },
        { name: 'city-lamp-glow', geometry: kit.lamps, material: new THREE.MeshBasicMaterial({ vertexColors: true }), collision: false },
      ];
      for (const part of kitParts) {
        this.geometries.push(part.geometry);
        this.materials.push(part.material);
        if (part.name === 'city-street-kit') this.reflectionMaterials.push(part.material as THREE.MeshStandardMaterial);
        const mesh = new THREE.Mesh(part.geometry, part.material);
        mesh.name = part.name;
        mesh.castShadow = part.name === 'city-street-kit';
        mesh.receiveShadow = true;
        this.group.add(mesh);
        if (part.collision) {
          const arrays = colliderArrays(part.geometry);
          this.colliders.push(bakeTrimesh(rapier, physics.world, arrays.vertices, arrays.indices));
        }
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
      this.captureEnvironment(renderer);
      const panel = document.createElement('section');
      panel.id = 'city-info';
      const title = document.createElement('strong');
      title.textContent = this.data.name;
      const text = document.createElement('p');
      text.textContent = `${this.data.buildings.length.toLocaleString()} 个建筑轮廓 · WASD 移动 / Shift 奔跑 / 空格跳跃`;
      const note = document.createElement('p');
      note.textContent = '地标与街道设施为简化示意，非实景复刻；平安金融中心 599.1m，其余高度为模型估算。';
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
      limits.textContent = '平地近似；道路宽度推定，尚无立交、地形或瓦片流式加载。';
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
    } catch (error) {
      this.dispose();
      throw error;
    }
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
      this.environmentTarget.texture.name = 'futian-local-reflection';
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
      camera.position.set(0, 1600, 2000);
      camera.lookAt(0, 70, 0);
    }
    const { sun, rim } = this.renderer.lights;
    sun.position.set(position.x + 320, position.y + 700, position.z + 440);
    sun.target.position.set(position.x, 1, position.z);
    rim.position.set(position.x - 5, 6, position.z - 5);
    rim.target.position.set(position.x, 1, position.z);
    const lighting = this.renderer.getLightingState();
    if (!lighting.target && lighting.current !== this.environmentPreset) this.captureEnvironment(this.renderer);
  }

  dispose(): void {
    if (this.physics) for (const collider of this.colliders) this.physics.world.removeCollider(collider, false);
    this.colliders = [];
    this.geometries.forEach(geometry => geometry.dispose());
    this.materials.forEach(material => material.dispose());
    if (this.renderer && this.environmentTarget) this.renderer.scene.environment = this.previousEnvironment;
    this.environmentTarget?.dispose();
    this.environmentTarget = null;
    this.previousEnvironment = null;
    this.reflectionMaterials = [];
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

export async function loadFutian(): Promise<CityScene> {
  const response = await fetch(new URL('assets/city/futian.json', document.baseURI));
  if (!response.ok) throw new Error(`福田街区数据加载失败（HTTP ${response.status}）`);
  const data = parseCityData(await response.json());
  return new CityScene(data, await loadSurfaceAssets());
}
