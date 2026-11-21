/**
 * 资产加载（spec §6 M2）。
 *
 * 三条硬约束，每条都有血泪理由：
 *
 * 1. **KTX2 转码器必须从本地 vendor 目录加载，不走 CDN**。
 *    CDN 在国内/内网/评审环境随时可能被墙或被拦；一挂就是白屏。
 *
 * 2. **meshopt 必须注册 MeshoptDecoder**。
 *    我们的角色资产是 meshopt 压缩过的（EXT_meshopt_compression 标了 required），
 *    不注册解码器时 GLTFLoader 会抛"no decoder available"，
 *    或者更糟——某些版本会静默给出全零顶点。
 *
 * 3. **统一 1.62m 且脚底贴地**。
 *    用 Box3 实测包围盒算缩放，**不要写死 scale**：不同 Tripo 产出的原始高度不一样
 *    （本资产原始就是 1.000m 高），写死会让角色要么悬空要么陷地。
 *
 * 失败处理：抛结构化错误对象（含 url/status/phase），上层显示可读提示，不白屏。
 */

import * as THREE from 'three';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { KTX2Loader } from 'three/examples/jsm/loaders/KTX2Loader.js';
import { MeshoptDecoder } from 'three/examples/jsm/libs/meshopt_decoder.module.js';
import type { AssetEntry } from './registry';
import { requireAsset, resolveFacingOffset } from './registry';

/** spec §6 M2 第 3 条：所有角色统一到这个高度（米）。 */
export const AVATAR_HEIGHT_M = 1.62;

/** 结构化加载错误。字段是给人看的，也是给上层做降级判断的。 */
export interface AssetLoadError {
  /** 出错的阶段：解析 registry / 网络 / 解析 glb / 后处理。 */
  phase: 'registry' | 'fetch' | 'parse' | 'postprocess';
  url: string;
  status?: number;
  message: string;
  cause?: unknown;
}

export class AssetError extends Error {
  readonly detail: AssetLoadError;

  constructor(detail: AssetLoadError) {
    super(`[asset:${detail.phase}] ${detail.url} — ${detail.message}`);
    this.name = 'AssetError';
    this.detail = detail;
  }
}

/** 加载结果。`mixer` 不在这里——一个 glb 可以被多个角色实例共用，mixer 属于每个实例。 */
export interface LoadedAvatar {
  /** 模板场景。**不要直接挂到世界里**，用 `instantiate()` 克隆。 */
  template: THREE.Group;
  clips: THREE.AnimationClip[];
  /** 原始高度（米），用于诊断。 */
  originalHeight: number;
  /** 应用的缩放，使高度归一到 1.62m。 */
  scaleApplied: number;
  bytes: number;
}

export interface LoaderOptions {
  /** 资源根路径。默认用 Vite 的 BASE_URL。 */
  baseUrl?: string;
  /** 进度回调（0..1），按资产总字节加权。 */
  onProgress?: (loaded: number, total: number) => void;
  /** dev 构建校验 sha256（生产跳过，省启动时间）。 */
  verifyIntegrity?: boolean;
}

/** 浏览器是否支持 KTX2 需要的压缩纹理。不支持时我们退回 webp（本资产就是 webp）。 */
function detectKtx2Support(renderer?: THREE.WebGLRenderer): boolean {
  if (!renderer) return false;
  try {
    const ext = renderer.extensions;
    return ext.has('WEBGL_compressed_texture_astc') || ext.has('WEBGL_compressed_texture_etc');
  } catch {
    return false;
  }
}

/**
 * 资产加载器。一个实例可复用（内部缓存 GLTFLoader 与已解码资产）。
 */
export class AssetLoader {
  private gltfLoader: GLTFLoader | null = null;
  private ktx2Loader: KTX2Loader | null = null;
  private readonly cache = new Map<string, LoadedAvatar>();
  private readonly opts: LoaderOptions;
  private totalBytes = 0;
  private loadedBytes = 0;

  constructor(opts: LoaderOptions = {}) {
    this.opts = opts;
  }

  private baseUrl(): string {
    if (this.opts.baseUrl !== undefined) return this.opts.baseUrl;
    // Vite 注入的 BASE_URL 在 base:'./' 时是 './'
    const viteBase = (import.meta as unknown as { env?: { BASE_URL?: string } }).env?.BASE_URL;
    return viteBase ?? './';
  }

  private resolveUrl(url: string): string {
    const base = this.baseUrl();
    if (!base || base === '/') return url;
    return base.endsWith('/') ? `${base}${url}` : `${base}/${url}`;
  }

  /**
   * 建 GLTFLoader。KTX2 只在检测到支持时挂载，
   * 且转码器路径指向**本地 vendor**（`assets/vendor/basis/`），不走 CDN。
   */
  private getLoader(renderer?: THREE.WebGLRenderer): GLTFLoader {
    if (this.gltfLoader) return this.gltfLoader;

    const loader = new GLTFLoader();

    // meshopt：本资产必需（EXT_meshopt_compression 是 required 扩展）
    loader.setMeshoptDecoder(MeshoptDecoder);

    if (detectKtx2Support(renderer)) {
      const ktx2 = new KTX2Loader();
      // 本地 vendor：不依赖 CDN，评审/内网环境也能跑
      ktx2.setTranscoderPath(this.resolveUrl('assets/vendor/basis/'));
      ktx2.detectSupport(renderer!);
      this.ktx2Loader = ktx2;
      loader.setKTX2Loader(ktx2);
    }

    this.gltfLoader = loader;
    return loader;
  }

  /**
   * 加载一个角色并归一到 1.62m、脚底贴地。
   *
   * 归一化为什么要包一层 Group 而不是直接改 scene.scale：
   * 骨骼动画的目标是 scene 内的 Bone，改 scene.scale 会把动画一起缩放（视觉上没错），
   * 但物理胶囊是独立算的；用外层 Group 承载缩放与位移，内部保持原始尺度，
   * 这样渲染与物理的"1 单位 = 1 米"约定不会被破坏。
   */
  async loadAvatar(keyOrEntry: string | AssetEntry, renderer?: THREE.WebGLRenderer): Promise<LoadedAvatar> {
    const entry = typeof keyOrEntry === 'string' ? this.safeRequire(keyOrEntry) : keyOrEntry;

    const cached = this.cache.get(entry.key);
    if (cached) return cached;

    const url = this.resolveUrl(entry.url);
    this.totalBytes = Math.max(this.totalBytes, entry.bytes);

    if (this.opts.verifyIntegrity) {
      await this.verifySha256(url, entry);
    }

    const loader = this.getLoader(renderer);

    let gltf: Awaited<ReturnType<GLTFLoader['loadAsync']>>;
    try {
      gltf = await loader.loadAsync(url, (evt) => {
        if (this.opts.onProgress && evt.total > 0) {
          this.opts.onProgress(evt.loaded, evt.total);
        }
      });
    } catch (cause) {
      const detail: AssetLoadError = {
        phase: 'parse',
        url,
        message: cause instanceof Error ? cause.message : String(cause),
        cause,
      };
      // 结构化错误：不要只 console.error(字符串)，上层要能读字段做降级
      console.error('[asset] 加载失败', detail);
      throw new AssetError(detail);
    }

    const scene = gltf.scene;

    // ── 归一化到 1.62m ──
    const box = new THREE.Box3().setFromObject(scene);
    const size = box.getSize(new THREE.Vector3());
    const originalHeight = size.y;

    if (!Number.isFinite(originalHeight) || originalHeight <= 1e-6) {
      const detail: AssetLoadError = {
        phase: 'postprocess',
        url,
        message: `包围盒高度异常（${originalHeight}），无法归一化。资产可能损坏或全为空网格。`,
      };
      console.error('[asset] 归一化失败', detail);
      throw new AssetError(detail);
    }

    const scale = AVATAR_HEIGHT_M / originalHeight;

    // 用外层 Group 承载缩放与贴地位移，内部保持原始尺度
    const template = new THREE.Group();
    template.name = `avatar-template:${entry.key}`;
    template.add(scene);
    scene.scale.setScalar(scale);
    // 脚底贴地：包围盒最低点应在 y=0
    scene.position.y = -box.min.y * scale;

    // 模型原生朝向修正（见 registry.ts 的 MODEL_FACING_OFFSET_Y 注释）。
    // 加在内层 scene 上而不是外层 Group：外层 Group 由角色控制器按 yaw 旋转，
    // 内层只负责"把模型摆正到 +Z"，两者职责分开。
    const facing = resolveFacingOffset();
    if (facing !== 0) scene.rotation.y += facing;

    // ── 材质与阴影 ──
    scene.traverse((obj) => {
      if (!(obj instanceof THREE.Mesh) && !(obj instanceof THREE.SkinnedMesh)) return;
      // 蒙皮网格必须关视锥剔除：骨骼动画会让顶点跑出原始包围盒，
      // 保留剔除会导致"转身就消失"（three 的经典坑）
      if ((obj as THREE.SkinnedMesh).isSkinnedMesh) obj.frustumCulled = false;
      obj.castShadow = true;
      obj.receiveShadow = true;
    });

    const result: LoadedAvatar = {
      template,
      clips: gltf.animations,
      originalHeight,
      scaleApplied: scale,
      bytes: entry.bytes,
    };

    this.cache.set(entry.key, result);
    return result;
  }

  private safeRequire(key: string): AssetEntry {
    try {
      return requireAsset(key);
    } catch (cause) {
      const detail: AssetLoadError = {
        phase: 'registry',
        url: key,
        message: cause instanceof Error ? cause.message : String(cause),
        cause,
      };
      console.error('[asset] registry 未登记', detail);
      throw new AssetError(detail);
    }
  }

  /** dev 构建校验 sha256。用 WebCrypto，避免引入额外依赖。 */
  private async verifySha256(url: string, entry: AssetEntry): Promise<void> {
    try {
      const res = await fetch(url);
      if (!res.ok) {
        const detail: AssetLoadError = {
          phase: 'fetch',
          url,
          status: res.status,
          message: `HTTP ${res.status}`,
        };
        console.error('[asset] 完整性校验失败', detail);
        throw new AssetError(detail);
      }
      const buf = await res.arrayBuffer();

      if (buf.byteLength !== entry.bytes) {
        const detail: AssetLoadError = {
          phase: 'fetch',
          url,
          status: res.status,
          message: `字节数不符：磁盘 ${buf.byteLength} vs 登记表 ${entry.bytes}（资产被换过但没更新 registry）`,
        };
        console.error('[asset] 完整性校验失败', detail);
        throw new AssetError(detail);
      }

      const digest = await crypto.subtle.digest('SHA-256', buf);
      const hex = [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('');
      if (hex !== entry.sha256) {
        const detail: AssetLoadError = {
          phase: 'fetch',
          url,
          message: `sha256 不符：磁盘 ${hex.slice(0, 16)}… vs 登记表 ${entry.sha256.slice(0, 16)}…`,
        };
        console.error('[asset] 完整性校验失败', detail);
        throw new AssetError(detail);
      }
      this.loadedBytes += buf.byteLength;
    } catch (err) {
      if (err instanceof AssetError) throw err;
      // fetch 本身失败（离线/路径错）也要结构化
      const detail: AssetLoadError = {
        phase: 'fetch',
        url,
        message: err instanceof Error ? err.message : String(err),
        cause: err,
      };
      console.error('[asset] 完整性校验异常', detail);
      throw new AssetError(detail);
    }
  }

  dispose(): void {
    this.ktx2Loader?.dispose();
    this.ktx2Loader = null;
    this.gltfLoader = null;
    this.cache.clear();
  }
}

/**
 * 从模板克隆一个角色实例（染色变体走这里）。
 *
 * 关键：**共享 geometry 与 skeleton，只克隆 material**（spec §5.2）。
 * three 的 `SkeletonUtils.clone` 会克隆骨骼层级但复用 geometry 引用，
 * 正是我们要的：3 个变体同屏时 geometry 计数不变，只有 material 多 2 份。
 *
 * 不要用 `Object3D.clone()`：它不会重建 SkinnedMesh 的 bone 绑定，
 * 克隆出来的角色会保持 T-pose 不动（three 的另一个经典坑）。
 */
export async function instantiateAvatar(template: THREE.Group): Promise<THREE.Group> {
  // 动态 import：SkeletonUtils 只在需要克隆时加载，首屏不背这个包袱
  const { clone } = await import('three/examples/jsm/utils/SkeletonUtils.js');
  return clone(template) as THREE.Group;
}

/**
 * 染色（spec §6 M5 第 5 条：通过 material.color 设置，不动几何）。
 *
 * 为什么必须克隆 material：material 是引用共享的，直接改 color 会让所有实例一起变色。
 * 克隆 material 后 geometry 仍共享，所以显存增量只是材质，不是整份模型。
 */
export function applyTint(root: THREE.Object3D, hex: string): void {
  const color = new THREE.Color(hex);
  root.traverse((obj) => {
    if (!(obj instanceof THREE.Mesh) && !(obj instanceof THREE.SkinnedMesh)) return;
    const mats = Array.isArray(obj.material) ? obj.material : [obj.material];
    const cloned = mats.map((m) => {
      const c = m.clone();
      // 只改 color，保留贴图（贴图是角色辨识度的来源，不能丢）
      if ('color' in c && (c as THREE.MeshStandardMaterial).color) {
        (c as THREE.MeshStandardMaterial).color.copy(color);
      }
      return c;
    });
    obj.material = Array.isArray(obj.material) ? cloned : cloned[0]!;
  });
}
