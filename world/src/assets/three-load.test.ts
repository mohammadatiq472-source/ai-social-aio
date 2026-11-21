import { describe, it, expect, beforeAll } from 'vitest';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import * as THREE from 'three';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { MeshoptDecoder } from 'three/examples/jsm/libs/meshopt_decoder.module.js';
import { WHALEGIRL } from './registry';
import { AVATAR_HEIGHT_M } from './loader';
import { installDomStubs } from './dom-stub';

/**
 * 资产在 three 里的真实可加载性（M2 验收的硬前提）。
 *
 * 为什么这条必须存在：
 * `build-character.mjs` 只验证 glTF 结构（用 gltf-transform 读）。
 * 但 three 的 GLTFLoader 是另一套实现——我们用了 meshopt + KHR_mesh_quantization，
 * 少注册一个扩展就加载失败，而那种失败在浏览器里表现为"角色不出现"，
 * 排查成本很高。所以这里在 node 里用 three 真的解析一遍。
 *
 * 这个测试能跑在 node 里，是因为 three 的 GLTFLoader 解析几何/骨骼/动画
 * 不需要 WebGL 上下文（只有贴图解码需要浏览器 API，见 dom-stub.ts）。
 */

// 必须在 import three 的 loader 之后、调用 parse 之前装桩
installDomStubs();

const HERE = dirname(fileURLToPath(import.meta.url));
const WORLD_ROOT = join(HERE, '..', '..');

let gltf: Awaited<ReturnType<GLTFLoader['parseAsync']>>;

beforeAll(async () => {
  await MeshoptDecoder.ready;
  const loader = new GLTFLoader();
  loader.setMeshoptDecoder(MeshoptDecoder);
  const p = join(WORLD_ROOT, WHALEGIRL.url);
  const buf = readFileSync(p);
  const ab = buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength);
  gltf = await loader.parseAsync(ab, '');
});

describe('资产在 three 里可加载（M2 硬前提）', () => {
  it('解析成功且只有 1 个 SkinnedMesh（draw call 预算的关键）', () => {
    let skinned = 0;
    gltf.scene.traverse((o) => {
      if ((o as THREE.SkinnedMesh).isSkinnedMesh) skinned += 1;
    });
    expect(skinned, '多于 1 个 SkinnedMesh 会让 draw call 线性增长').toBe(1);
  });

  it('只有 1 份 geometry（染色变体共享的前提）', () => {
    const geoms = new Set<THREE.BufferGeometry>();
    gltf.scene.traverse((o) => {
      const m = o as THREE.Mesh;
      if (m.isMesh && m.geometry) geoms.add(m.geometry);
    });
    expect(geoms.size, '染色变体共享 geometry 的前提是只有 1 份').toBe(1);
  });

  it('只有 1 个材质（染色变体只克隆 material）', () => {
    const mats = new Set<THREE.Material>();
    gltf.scene.traverse((o) => {
      const m = o as THREE.Mesh;
      if (!m.isMesh) return;
      const mm = m.material;
      if (Array.isArray(mm)) mm.forEach((x) => mats.add(x));
      else if (mm) mats.add(mm);
    });
    expect(mats.size).toBe(1);
  });

  it('只有 1 个 Skeleton 且 41 根骨骼', () => {
    const skeletons = new Set<THREE.Skeleton>();
    gltf.scene.traverse((o) => {
      const sm = o as THREE.SkinnedMesh;
      if (sm.isSkinnedMesh && sm.skeleton) skeletons.add(sm.skeleton);
    });
    expect(skeletons.size).toBe(1);
    expect([...skeletons][0]!.bones.length).toBe(41);
  });

  it('动画 clip 与 registry 登记逐字一致', () => {
    const loaded = gltf.animations.map((a) => a.name).sort();
    // registry 的 animations 是可选的（AssetEntry.animations?），这里必须存在
    const registered = [...(WHALEGIRL.animations ?? [])].sort();
    expect(registered.length, '角色资产必须登记 animations').toBeGreaterThan(0);
    expect(loaded).toEqual(registered);
  });

  it('所有动画轨道都有非空且有限的值（防"动画在但不动"）', () => {
    let total = 0;
    for (const clip of gltf.animations) {
      for (const track of clip.tracks) {
        total += 1;
        expect(track.values.length, `${clip.name} 的 ${track.name} 是空轨道`).toBeGreaterThan(0);
        expect(
          Array.from(track.values).every((v) => Number.isFinite(v)),
          `${clip.name} 的 ${track.name} 含 NaN`,
        ).toBe(true);
      }
    }
    expect(total).toBeGreaterThan(0);
  });

  it('归一化到 1.62m 且脚底贴地（用 Box3 算，不写死 scale）', () => {
    const box = new THREE.Box3().setFromObject(gltf.scene);
    const size = box.getSize(new THREE.Vector3());
    const scale = AVATAR_HEIGHT_M / size.y;

    gltf.scene.scale.setScalar(scale);
    gltf.scene.position.y = -box.min.y * scale;

    const box2 = new THREE.Box3().setFromObject(gltf.scene);
    expect(box2.max.y - box2.min.y).toBeCloseTo(AVATAR_HEIGHT_M, 2);
    expect(Math.abs(box2.min.y)).toBeLessThan(0.01);
  });

  it('骨骼 matrixWorld 全是有限值（防绑定矩阵损坏）', () => {
    gltf.scene.traverse((o) => {
      const sm = o as THREE.SkinnedMesh;
      if (!sm.isSkinnedMesh || !sm.skeleton) return;
      for (const bone of sm.skeleton.bones) {
        expect(bone.matrixWorld.elements.every((v) => Number.isFinite(v))).toBe(true);
      }
    });
  });
});
