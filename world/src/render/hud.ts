/**
 * HUD：角色名字与头顶气泡（spec §6 M5 第 4 条）。
 *
 * 为什么用 CSS2DRenderer 而不是 canvas 贴图 sprite：
 * - 文字要清晰（sprite 缩放后糊），中文尤其明显；
 * - 气泡要能被读屏软件读到、能被选中复制；
 * - DOM 不占 WebGL 的 drawCall，`__worldDebug.drawCalls` 的数字才干净。
 *
 * 代价：DOM 元素多了会有布局开销。所以气泡**同屏最多 3 个**（spec 明写），
 * 超出的排队等前一个消失——不是静默丢弃，那样会让人以为"AI 没说话"。
 */

import * as THREE from 'three';
import { CSS2DObject, CSS2DRenderer } from 'three/examples/jsm/renderers/CSS2DRenderer.js';
import type { EntityId } from '../core/types';

/** spec §6 M5 第 4 条：气泡 3s 自动消失。 */
export const BUBBLE_TTL_MS = 3000;

/** spec §6 M5 第 4 条：同屏最多 3 个气泡。 */
export const MAX_BUBBLES = 3;

export interface HudOptions {
  /** HUD 挂载的容器（通常是 canvas 的父元素）。 */
  container: HTMLElement;
  /** 名字标签相对头顶的偏移（米）。 */
  labelHeight?: number;
}

interface BubbleRecord {
  el: HTMLDivElement;
  object: CSS2DObject;
  /** 到期时间（毫秒，performance.now 基准）。 */
  expiresAt: number;
  /** 排队中的文字（还没显示）。 */
  queued?: string;
}

/**
 * 名字 + 气泡的 DOM 层。
 *
 * 与 renderer 的耦合只有一个 `render(scene, camera)` 调用，
 * 所以可以在 e2e 里单独断言 DOM（不需要截图比对）。
 */
export class Hud {
  readonly css2d: CSS2DRenderer;
  private readonly labelHeight: number;
  private readonly labels = new Map<EntityId, CSS2DObject>();
  private readonly bubbles = new Map<EntityId, BubbleRecord>();
  /** 排队等待显示的气泡（同屏超 3 个时）。FIFO。 */
  private readonly pending: Array<{ id: EntityId; text: string }> = [];

  constructor(opts: HudOptions) {
    this.labelHeight = opts.labelHeight ?? 1.85;

    this.css2d = new CSS2DRenderer();
    this.css2d.domElement.style.position = 'absolute';
    this.css2d.domElement.style.top = '0';
    this.css2d.domElement.style.left = '0';
    this.css2d.domElement.style.width = '100%';
    this.css2d.domElement.style.height = '100%';
    // 关键：HUD 不能吃掉鼠标事件，否则相机的拖拽/滚轮会被它挡住
    this.css2d.domElement.style.pointerEvents = 'none';
    this.css2d.domElement.className = 'world-hud';
    opts.container.appendChild(this.css2d.domElement);
  }

  resize(width: number, height: number): void {
    this.css2d.setSize(width, height);
  }

  /** 给角色挂名字标签。重复调用是幂等的（只更新文字）。 */
  setName(id: EntityId, name: string, root: THREE.Object3D): void {
    let obj = this.labels.get(id);
    if (!obj) {
      const el = document.createElement('div');
      el.className = 'world-name';
      el.textContent = name;
      obj = new CSS2DObject(el);
      obj.position.set(0, this.labelHeight, 0);
      // 名字不应该遮挡交互
      obj.center.set(0.5, 1);
      this.labels.set(id, obj);
      root.add(obj);
    } else if (obj.element.textContent !== name) {
      obj.element.textContent = name;
    }
  }

  /**
   * 弹气泡。同屏已满 3 个时**排队**，等前面的过期后再显示。
   *
   * 为什么排队而不是丢弃：丢弃会让"AI 说话了但没显示"变成不可解释的现象。
   * 排队至少保证最终会显示（延迟几秒），且顺序不错乱。
   */
  showBubble(id: EntityId, text: string, root: THREE.Object3D, now = performance.now()): void {
    if (!text) return;

    const active = this.countActiveBubbles(now);
    if (active >= MAX_BUBBLES && !this.bubbles.has(id)) {
      this.pending.push({ id, text });
      return;
    }

    this.spawnBubble(id, text, root, now);
  }

  private spawnBubble(id: EntityId, text: string, root: THREE.Object3D, now: number): void {
    this.removeBubble(id);

    const el = document.createElement('div');
    el.className = 'world-bubble';
    el.textContent = text;
    const obj = new CSS2DObject(el);
    // 气泡在名字上方
    obj.position.set(0, this.labelHeight + 0.28, 0);
    obj.center.set(0.5, 1);
    root.add(obj);

    this.bubbles.set(id, {
      el,
      object: obj,
      expiresAt: now + BUBBLE_TTL_MS,
    });
  }

  private removeBubble(id: EntityId): void {
    const rec = this.bubbles.get(id);
    if (!rec) return;
    rec.object.removeFromParent();
    rec.el.remove();
    this.bubbles.delete(id);
  }

  private countActiveBubbles(now: number): number {
    let n = 0;
    for (const rec of this.bubbles.values()) {
      if (rec.expiresAt > now) n += 1;
    }
    return n;
  }

  /** 角色离场时清掉它的 DOM（否则会留下一堆孤儿节点）。 */
  remove(id: EntityId): void {
    const label = this.labels.get(id);
    if (label) {
      label.removeFromParent();
      label.element.remove();
      this.labels.delete(id);
    }
    this.removeBubble(id);
    const qi = this.pending.findIndex((p) => p.id === id);
    if (qi >= 0) this.pending.splice(qi, 1);
  }

  /**
   * 每帧调用：处理气泡过期 + 出队。
   *
   * `resolveRoot` 由调用方提供（从 id 拿 Object3D），
   * 这样 HUD 不需要持有角色树，避免循环引用与泄漏。
   */
  update(now: number, resolveRoot: (id: EntityId) => THREE.Object3D | undefined): void {
    // 过期清理
    for (const [id, rec] of [...this.bubbles]) {
      if (now >= rec.expiresAt) {
        this.removeBubble(id);
      }
    }

    // 出队：有空位就补
    while (this.pending.length > 0 && this.countActiveBubbles(now) < MAX_BUBBLES) {
      const next = this.pending.shift()!;
      const root = resolveRoot(next.id);
      if (!root) continue; // 角色已离场，跳过这条
      this.spawnBubble(next.id, next.text, root, now);
    }
  }

  render(scene: THREE.Scene, camera: THREE.Camera): void {
    this.css2d.render(scene, camera);
  }

  /** 调试：当前活跃气泡数（e2e 断言"最多 3 个"用）。 */
  activeBubbleCount(now = performance.now()): number {
    return this.countActiveBubbles(now);
  }

  pendingBubbleCount(): number {
    return this.pending.length;
  }

  dispose(): void {
    for (const id of [...this.labels.keys()]) this.remove(id);
    this.bubbles.clear();
    this.pending.length = 0;
    this.css2d.domElement.remove();
  }
}
