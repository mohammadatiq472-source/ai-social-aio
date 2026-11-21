/**
 * Agent 化身的渲染接线（M5 的 avatar.ts + M2 的染色变体 → 场景里的 6 个角色）。
 *
 * 为什么单独一个文件而不是塞进 main.ts：
 * main.ts 已经负责"渲染器 + 相机 + Clock + 物理"的装配，再加 6 个角色的
 * 加载/克隆/染色/动画驱动/HUD 会让它变成什么都干的上帝对象。
 * 这里只做一件事：**把 AgentSystem 的实体表映射成场景里的可见角色**。
 *
 * 关键设计：**数据源只有一个**——`World` 的实体表。
 * AgentSystem 每 tick 把物理算出的 transform 写回 `world.updateActor()`，
 * 这里每帧从 `world.getActor()` 读，所以渲染**永远不会**和物理各跑各的。
 * 反过来（渲染自己维护位置）是这类项目最典型的漂移 bug。
 */

import * as THREE from 'three';
import type { EntityId } from '../core/types';
import type { World } from '../core/world';
import { AvatarAnimator, type MotionInput } from './avatar';
import { Hud } from './hud';
import { AssetLoader, instantiateAvatar, type LoadedAvatar } from '../assets/loader';
import { WHALEGIRL } from '../assets/registry';
import { CAPSULE_CENTER_HEIGHT } from '../interact/player';
import { ANIM_CLIP_ALIAS } from '../assets/registry';

/**
 * 把"胶囊中心"换算成"脚底"的世界 y。
 *
 * **为什么渲染层必须做这个换算**：
 * `ActorState.transform.p` 是**胶囊中心**的位置（Rapier 刚体的 translation 就是几何中心），
 * 而 avatar 模型的脚底在局部坐标 y=0。
 * 如果直接把 `root.position` 设成 `p`，模型会**悬空 0.85m**——
 * 表现为"角色浮在半空中，脚在网格线上方半个人高"。
 *
 * 这个 bug 很隐蔽：物理是对的（胶囊确实站在地上），
 * 只是渲染层把"中心"当成了"脚底"。integration-agent 用截图发现了它。
 *
 * 常量从 `interact/player.ts` 复用（那里由 `DEFAULT_CHARACTER` 算出 0.85），
 * 避免两处各写一份、以后改胶囊尺寸时只改一处漏另一处。
 */
export function feetYFromCenter(centerY: number): number {
  return centerY - CAPSULE_CENTER_HEIGHT;
}

export interface AgentAvatarOptions {
  scene: THREE.Scene;
  world: World;
  /** HUD 挂载的容器（通常是 canvas 父元素）。 */
  hudContainer: HTMLElement;
  /** 是否开阴影（移动端关）。 */
  shadows: boolean;
  /** 要渲染的 Agent id 与 tint。 */
  agents: ReadonlyArray<{ id: EntityId; name: string; tint: string }>;
  /** 加载进度回调（0..1）。 */
  onProgress?: (loaded: number, total: number) => void;
}

interface AgentView {
  id: EntityId;
  name: string;
  tint: string;
  root: THREE.Group;
  animator: AvatarAnimator;
  mixer: THREE.AnimationMixer;
  /** 上一帧位置，用于算水平速度（状态机需要）。 */
  lastPos: THREE.Vector3;
  /** 上一帧是否在地面。 */
  lastGrounded: boolean;
}

/**
 * 管理 6 个 Agent 的可见化身。
 *
 * 生命周期：`create()` 异步加载资产 → 克隆 6 份 → `update()` 每帧驱动。
 */
export class AgentAvatars {
  private readonly scene: THREE.Scene;
  private readonly world: World;
  private readonly hud: Hud;
  private readonly shadows: boolean;
  private readonly views: AgentView[] = [];
  private readonly loader: AssetLoader;
  private loaded: LoadedAvatar | null = null;
  private disposed = false;

  private constructor(opts: AgentAvatarOptions) {
    this.scene = opts.scene;
    this.world = opts.world;
    this.shadows = opts.shadows;
    this.hud = new Hud({ container: opts.hudContainer });
    this.loader = new AssetLoader({ onProgress: opts.onProgress });
    this.specs = opts.agents;
  }

  private readonly specs: ReadonlyArray<{ id: EntityId; name: string; tint: string }>;

  /** 加载资产并实例化所有 Agent。失败时不抛（降级为"没有化身"，世界照常跑）。 */
  static async create(opts: AgentAvatarOptions, renderer?: THREE.WebGLRenderer): Promise<AgentAvatars | null> {
    const self = new AgentAvatars(opts);
    try {
      self.loaded = await self.loader.loadAvatar(WHALEGIRL, renderer);
    } catch (err) {
      // 资产挂了不该让 3D 世界白屏（spec §6 M2：缺资产要显示可读错误，不白屏）
      console.error('[avatars] 角色资产加载失败，以降级模式继续（无化身）', err);
      self.hud.dispose();
      return null;
    }

    for (const spec of self.specs) {
      await self.spawnView(spec);
    }
    return self;
  }

  private async spawnView(spec: { id: EntityId; name: string; tint: string }): Promise<void> {
    if (!this.loaded) return;

    // 克隆：SkeletonUtils.clone 会重建骨骼绑定但复用 geometry
    const root = await instantiateAvatar(this.loaded.template);
    root.name = `avatar:${spec.id}`;
    // 不染色：用户明确要求"不要再把颜色涂上去"。
    // 6 个 Agent 现在都用原始材质，靠位置/朝向/动作/名字标签区分。
    // tint 字段仍保留在 ActorState 里（协议 §4.1 要求），只是渲染层不消费它——
    // 将来若要做"队长高亮"之类的局部标记，从这里恢复。
    void spec.tint;

    // 阴影：桌面开、移动关（M1 的降级规则）
    root.traverse((o) => {
      const m = o as THREE.Mesh;
      if (!m.isMesh) return;
      m.castShadow = this.shadows;
      m.receiveShadow = this.shadows;
    });

    // 每个角色独立的 mixer：相位 offset 才能互不相同
    const mixer = new THREE.AnimationMixer(root);
    const animator = new AvatarAnimator(spec.id);
    animator.bind(mixer, this.loaded.clips, ANIM_CLIP_ALIAS);

    const actor = this.world.getActor(spec.id);
    const p = actor?.transform.p ?? [0, 0, 0];
    root.position.set(p[0], feetYFromCenter(p[1]), p[2]);
    this.scene.add(root);

    // 名字标签（HUD）
    this.hud.setName(spec.id, spec.name, root);

    this.views.push({
      id: spec.id,
      name: spec.name,
      tint: spec.tint,
      root,
      animator,
      mixer,
      lastPos: new THREE.Vector3(p[0], p[1], p[2]),
      lastGrounded: true,
    });
  }

  /**
   * 每**渲染帧**调一次（不是物理步）。
   *
   * 为什么用渲染 dt：动画与相机是观感，要跟画面帧率走。
   * 位置仍来自 `world`（物理写的），所以不会漂移。
   */
  update(renderDt: number, now: number): void {
    if (this.disposed) return;

    for (const v of this.views) {
      const actor = this.world.getActor(v.id);
      if (!actor) continue;

      const [x, y, z] = actor.transform.p;
      const prevX = v.lastPos.x;
      const prevZ = v.lastPos.z;

      // 位置直接对齐物理（不插值：60Hz 物理 + 60fps 渲染时插值收益很小，
      // 而插值会引入一帧延迟，让"角色看起来比物理慢"）
      //
      // ⚠ y 必须减掉胶囊中心高度：`transform.p[1]` 是胶囊中心，
      // 模型脚底在局部 y=0。不减会让角色悬空 0.85m（见 CAPSULE_CENTER_HEIGHT 注释）。
      v.root.position.set(x, feetYFromCenter(y), z);

      // 朝向：用位移方向推 yaw（spec §6 M5：状态由物理状态 + 输入决定）
      const dx = x - prevX;
      const dz = z - prevZ;
      if (dx * dx + dz * dz > 1e-6) {
        // 物理侧约定 +Z 为前方，yaw = atan2(fx, fz)
        const yaw = Math.atan2(dx, dz);
        v.root.rotation.y = yaw;
      }

      // 水平速度（m/s），供状态机选 walk/run
      const speed = Math.hypot(dx, dz) / Math.max(renderDt, 1e-6);

      // 离地判定：y 明显低于站立高度视为下落
      // （真正的 grounded 由物理给，这里用 y 变化的近似，M4 落地后可换成精确值）
      const grounded = y > -0.05;
      const vSpeed = (y - v.lastPos.y) / Math.max(renderDt, 1e-6);

      const input: MotionInput = {
        speed,
        grounded,
        verticalSpeed: vSpeed,
      };

      v.animator.update(input, renderDt);

      v.lastPos.set(x, y, z);
      v.lastGrounded = grounded;
    }

    // HUD：气泡过期 + 出队
    this.hud.update(now, (id) => this.views.find((v) => v.id === id)?.root);
  }

  /** 让某个 Agent 说一句话（气泡）。 */
  say(id: EntityId, text: string, now = performance.now()): void {
    const view = this.views.find((v) => v.id === id);
    if (!view) return;
    this.hud.showBubble(id, text, view.root, now);
  }

  /** HUD 渲染（CSS2D 需要每帧 render）。 */
  renderHud(camera: THREE.Camera): void {
    this.hud.render(this.scene, camera);
  }

  resize(width: number, height: number): void {
    this.hud.resize(width, height);
  }

  /** 调试信息：6 个角色的状态（验收脚本与调试面板用）。 */
  debug(): Array<{ id: EntityId; name: string; tint: string; state: string; pos: [number, number, number]; bubbles: number }> {
    return this.views.map((v) => {
      const p = v.root.position;
      return {
        id: v.id,
        name: v.name,
        tint: v.tint,
        state: v.animator.debug().state,
        pos: [Math.round(p.x * 100) / 100, Math.round(p.y * 100) / 100, Math.round(p.z * 100) / 100],
        bubbles: this.hud.activeBubbleCount(),
      };
    });
  }

  get count(): number {
    return this.views.length;
  }

  /** 所有 avatar 的根节点（验收脚本用来数场景里的角色）。 */
  roots(): THREE.Object3D[] {
    return this.views.map((v) => v.root);
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    for (const v of this.views) {
      v.animator.dispose();
      v.mixer.stopAllAction();
      v.root.removeFromParent();
    }
    this.views.length = 0;
    this.hud.dispose();
    this.loader.dispose();
  }
}
