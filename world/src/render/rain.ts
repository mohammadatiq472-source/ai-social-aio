/**
 * 雨滴（spec §6 M1 光照系统的配套：暴雨预设需要可见的雨）。
 *
 * 为什么用 Points 而不是 InstancedMesh 或逐滴 Mesh：
 * - 雨滴是**大量、极小、无光照**的粒子。Points 一次 draw call 就能画几千个，
 *   而且不需要法线/材质计算。
 * - InstancedMesh 每个雨滴要有几何体，3000 个雨滴的变换矩阵更新本身就是负担。
 *
 * 为什么用 GPU 位移（着色器里按时间推 y）而不是 CPU 每帧改 position 数组：
 * - CPU 改 3000 个点的 position 每帧要上传整个 buffer（~36KB），是纯浪费。
 * - 着色器里 `mod(y - t*speed, height)` 一行就能循环下落，CPU 零开销。
 *   代价是雨滴的"位置"不再能直接读回来 —— 但雨滴本来也不需要被查询。
 *
 * 局限（如实记录）：这是**视觉雨**，不是物理雨。它不落地溅射、不积水、不影响碰撞。
 * v0.1 只需要"看起来在下雨"。
 */
import * as THREE from 'three';

export interface RainOptions {
  /** 雨滴数量。1000 在中端设备上很安全，3000 已接近移动端上限。 */
  count?: number;
  /** 雨区边长（米）。以角色为中心的一个立方体范围。 */
  area?: number;
  /** 雨区高度（米）。雨滴从 top 落到 bottom 后循环。 */
  height?: number;
  /** 下落速度（米/秒）。真实雨滴约 9m/s，但视觉上 14~18 更快更"暴雨"。 */
  speed?: number;
}

/**
 * 雨系统。`update(dt)` 只推进 uniform 里的时间，不碰几何。
 */
export class Rain {
  readonly points: THREE.Points;
  private readonly material: THREE.ShaderMaterial;
  private readonly geometry: THREE.BufferGeometry;
  private elapsed = 0;
  private intensity = 0;
  private readonly maxCount: number;

  constructor(opts: RainOptions = {}) {
    const count = opts.count ?? 2500;
    const area = opts.area ?? 26;
    const height = opts.height ?? 14;
    const speed = opts.speed ?? 16;
    this.maxCount = count;

    const positions = new Float32Array(count * 3);
    // 每滴的随机相位：让雨滴不在同一高度（否则会看到"一层雨帘"整体下落）
    const offsets = new Float32Array(count);
    // 每滴的横向漂移（斜雨更有速度感）
    const drifts = new Float32Array(count);

    // 确定性伪随机：用固定种子的 LCG，保证每次刷新雨的形状一致（录片可复现）。
    let seed = 20261120;
    const rand = (): number => {
      seed = (seed * 1664525 + 1013904223) >>> 0;
      return seed / 4294967296;
    };

    for (let i = 0; i < count; i++) {
      positions[i * 3] = (rand() - 0.5) * area;
      positions[i * 3 + 1] = rand() * height;
      positions[i * 3 + 2] = (rand() - 0.5) * area;
      offsets[i] = rand() * height;
      drifts[i] = (rand() - 0.5) * 0.6;
    }

    this.geometry = new THREE.BufferGeometry();
    this.geometry.setAttribute('position', new THREE.BufferAttribute(positions, 3));
    this.geometry.setAttribute('aOffset', new THREE.BufferAttribute(offsets, 1));
    this.geometry.setAttribute('aDrift', new THREE.BufferAttribute(drifts, 1));

    this.material = new THREE.ShaderMaterial({
      transparent: true,
      depthWrite: false, // 半透明粒子不写深度，否则会互相遮挡出黑边
      blending: THREE.AdditiveBlending,
      uniforms: {
        uTime: { value: 0 },
        uHeight: { value: height },
        uSpeed: { value: speed },
        uIntensity: { value: 0 },
        uColor: { value: new THREE.Color(0xaaccee) },
      },
      vertexShader: /* glsl */ `
        attribute float aOffset;
        attribute float aDrift;
        uniform float uTime;
        uniform float uHeight;
        uniform float uSpeed;
        uniform float uIntensity;
        varying float vAlpha;

        void main() {
          // 下落：y 随时间递减，mod 到 [0, uHeight) 内循环。
          // 加 aOffset 让每滴起始高度不同（否则整层一起落，像帘子）。
          float y = mod(position.y - uTime * uSpeed + aOffset, uHeight);
          // 斜雨：横向随时间轻微漂移
          float x = position.x + aDrift * uTime * 2.0;
          vec3 p = vec3(x, y, position.z);

          vec4 mv = modelViewMatrix * vec4(p, 1.0);
          gl_Position = projectionMatrix * mv;

          // 近处雨滴大一点、远处小一点（透视感）
          gl_PointSize = (60.0 / -mv.z) * uIntensity;
          // 强度控制整体透明度；intensity=0 时完全不可见
          vAlpha = uIntensity;
        }
      `,
      fragmentShader: /* glsl */ `
        uniform vec3 uColor;
        varying float vAlpha;

        void main() {
          // 圆形雨滴：用 pointCoord 到中心的距离裁出圆，边缘柔化
          vec2 d = gl_PointCoord - vec2(0.5);
          float r = length(d);
          if (r > 0.5) discard;
          // 竖向拉长成"雨丝"感：x 方向收窄
          float streak = smoothstep(0.5, 0.05, abs(d.x) * 2.2) * smoothstep(0.5, 0.1, r);
          gl_FragColor = vec4(uColor, streak * vAlpha * 0.55);
        }
      `,
    });

    this.points = new THREE.Points(this.geometry, this.material);
    this.points.name = 'rain';
    // 雨滴是相机无关的粒子云，不参与视锥剔除（否则转身就整片消失）
    this.points.frustumCulled = false;
    this.points.renderOrder = 10;
    this.points.visible = false;
  }

  /**
   * 设置雨量 0..1。
   * 0 时整个对象不可见（省掉 draw call），>0 时按强度淡入。
   */
  setIntensity(v: number): void {
    const next = v < 0 ? 0 : v > 1 ? 1 : v;
    this.intensity = next;
    this.material.uniforms['uIntensity']!.value = next;
    this.points.visible = next > 0.01;
    // 雨量小时只画一部分粒子，避免"毛毛雨"看起来像暴雨
    this.geometry.setDrawRange(0, Math.floor(this.maxCount * Math.min(1, next * 1.2)));
  }

  /** 当前雨量（调试用）。 */
  getIntensity(): number {
    return this.intensity;
  }

  /**
   * 推进时间。只改 uniform，不动几何 —— 所以这个方法几乎零开销。
   * 雨不跟随角色移动（雨区足够大，跟不跟看不出差别），省一次矩阵更新。
   */
  update(dt: number): void {
    if (!this.points.visible) return;
    if (!Number.isFinite(dt) || dt <= 0) return;
    this.elapsed += dt;
    this.material.uniforms['uTime']!.value = this.elapsed;
  }

  dispose(): void {
    this.geometry.dispose();
    this.material.dispose();
    this.points.removeFromParent();
  }
}
