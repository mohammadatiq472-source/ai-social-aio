/**
 * 交互的 DOM 事件绑定（M10 的"按键/点击 → 控制器"这一层）。
 *
 * 为什么单独一个文件，而不是直接写在 `main.ts` 里：
 * `main.ts` 是多人共用的热文件（M1 渲染、M5 化身、M9 Agent 都往里加东西）。
 * M10 只该往里加**一行** `bindInteract(...)`，而不是加三块事件监听。
 *
 * 这里只做"把 DOM 事件翻译成控制器方法调用"，不含任何判定逻辑：
 * 判定在 `./index.ts`（纯函数），状态与物理在 `./player.ts`。
 *
 * ═══════════════ 两条容易踩的坑 ═══════════════
 *
 * **1. 右键必须 preventDefault，且不能和相机的环绕打架。**
 *    `render/camera.ts` 的 `attachInput` 已经绑了 `pointerdown(button=2)` 做环绕、
 *    也绑了 `contextmenu` 做 preventDefault。M10 的"点击角色切焦点"必须
 *    只在**左键单击且没有拖动**时触发，否则玩家每次拖镜头都会切一次焦点。
 *
 * **2. 点击要区分"单击"与"拖拽"。**
 *    判据用位移阈值（8px）+ 时长（500ms）。不用 `click` 事件：
 *    相机用 pointer capture 后，`click` 在某些浏览器上不会触发到 canvas。
 */

import * as THREE from 'three';
import type { EntityId } from '../core/types';
import type { PlayerController } from './player';

/** 判定"单击"而非"拖拽"的位移阈值（CSS 像素）。 */
export const CLICK_SLOP_PX = 8;

/** 判定"单击"而非"长按"的时长阈值（毫秒）。 */
export const CLICK_MAX_MS = 500;

/** 坐/起切换键（spec §6 M10 原文：按 E）。 */
export const SIT_KEY = 'KeyE';

export interface BindInteractOptions {
  player: PlayerController;
  /** 事件挂载点（通常是 canvas）。 */
  canvas: HTMLElement;
  /** 键盘挂载点（通常是 window；与 input/keyboard.ts 一致）。 */
  keyTarget?: Window | HTMLElement;
  /**
   * 屏幕点 → 射线拾取角色。
   *
   * 由 `main.ts` 注入（它同时持有 camera 与 scene）。
   * 返回命中的实体 id，没命中返回 null（点空地 = 取消焦点）。
   *
   * 为什么用回调而不是在这里做 raycast：
   * 这个文件不该 import three 的渲染器，也不该知道场景结构；
   * 而且射线拾取需要 camera 与 scene 两个 M1 的对象，它们都在 main.ts 里。
   */
  pickEntity: (clientX: number, clientY: number) => EntityId | null;
}

/**
 * 绑定交互事件。返回卸载函数。
 */
export function bindInteract(opts: BindInteractOptions): () => void {
  const { player, canvas, pickEntity } = opts;
  const keyTarget = opts.keyTarget ?? (typeof window !== 'undefined' ? window : null);

  // ── 键盘：E 坐/起 ──
  const onKeyDown = (e: Event): void => {
    const ev = e as KeyboardEvent;
    // 输入框里打字时不要抢键
    if (isEditableTarget(ev.target)) return;
    // 浏览器快捷键（Ctrl+E 是搜索框、Cmd+E 是"用所选内容查找"）
    if (ev.ctrlKey || ev.metaKey || ev.altKey) return;
    // 长按自动重复会让坐/起狂闪
    if (ev.repeat) return;

    if (ev.code === SIT_KEY) {
      ev.preventDefault();
      player.pressSit();
    }
  };

  keyTarget?.addEventListener('keydown', onKeyDown);

  // ── 指针：左键单击角色 → 切焦点 ──
  let downAt = 0;
  let downX = 0;
  let downY = 0;
  let downButton = -1;

  const onPointerDown = (e: Event): void => {
    const ev = e as PointerEvent;
    downButton = ev.button;
    downAt = performance.now();
    downX = ev.clientX;
    downY = ev.clientY;
  };

  const onPointerUp = (e: Event): void => {
    const ev = e as PointerEvent;
    if (downButton !== 0 || ev.button !== 0) return;

    const moved = Math.hypot(ev.clientX - downX, ev.clientY - downY);
    const elapsed = performance.now() - downAt;
    if (moved > CLICK_SLOP_PX || elapsed > CLICK_MAX_MS) return;

    // 点到角色 → 聚焦它；点到空地 → 取消焦点（回自己）
    const hit = pickEntity(ev.clientX, ev.clientY);
    player.setFocus(hit);
  };

  // 右键环绕由相机自己处理；这里只保证不弹菜单（相机已 preventDefault，
  // 但指针事件的目标可能是 HUD 层，所以补一道）
  const onContextMenu = (e: Event): void => {
    e.preventDefault();
  };

  canvas.addEventListener('pointerdown', onPointerDown);
  canvas.addEventListener('pointerup', onPointerUp);
  canvas.addEventListener('contextmenu', onContextMenu);

  return () => {
    keyTarget?.removeEventListener('keydown', onKeyDown);
    canvas.removeEventListener('pointerdown', onPointerDown);
    canvas.removeEventListener('pointerup', onPointerUp);
    canvas.removeEventListener('contextmenu', onContextMenu);
  };
}

/** 焦点在 input/textarea/contenteditable 时不要抢键盘（与 input/keyboard.ts 同规则）。 */
function isEditableTarget(t: EventTarget | null): boolean {
  if (!t || typeof HTMLElement === 'undefined' || !(t instanceof HTMLElement)) return false;
  const tag = t.tagName;
  return tag === 'INPUT' || tag === 'TEXTAREA' || t.isContentEditable;
}

// ───────────────────────────── 射线拾取 ─────────────────────────────

/** 射线拾取的结果。 */
export interface PickHit {
  id: EntityId;
  /** 命中点到相机的距离（米）。 */
  distance: number;
}

/**
 * 从屏幕坐标发射线，找最近的、带 `avatar:<id>` 名字的根节点。
 *
 * 为什么按节点名而不是 userData：
 * `render/agent-avatars.ts` 与 `main.ts` 都已经把根节点命名成 `avatar:<id>`，
 * 这是现成的、可搜索的锚点。用 userData 需要改那两个文件（都在别人的作用域里）。
 *
 * 命中后要**向上找到根**：射线打到的是骨骼网格（`SkinnedMesh`），
 * 它的 `name` 是 glb 里的网格名，不是 `avatar:*`。所以要沿 parent 爬。
 */
export function pickAvatarAt(
  camera: THREE.Camera,
  scene: THREE.Scene,
  clientX: number,
  clientY: number,
  canvasRect: { left: number; top: number; width: number; height: number },
): PickHit | null {
  const ndc = new THREE.Vector2(
    ((clientX - canvasRect.left) / canvasRect.width) * 2 - 1,
    -((clientY - canvasRect.top) / canvasRect.height) * 2 + 1,
  );
  const raycaster = new THREE.Raycaster();
  raycaster.setFromCamera(ndc, camera);

  const hits = raycaster.intersectObjects(scene.children, true);
  for (const h of hits) {
    const id = findAvatarId(h.object);
    if (id) return { id, distance: h.distance };
  }
  return null;
}

/** 沿 parent 链找 `avatar:<id>` 根节点，取出 id。 */
export function findAvatarId(obj: THREE.Object3D | null): EntityId | null {
  let cur: THREE.Object3D | null = obj;
  // 上限防止异常深的场景图把这里变成死循环
  for (let depth = 0; cur && depth < 64; depth++) {
    const name = cur.name;
    if (name.startsWith('avatar:')) {
      const id = name.slice('avatar:'.length);
      return id.length > 0 ? id : null;
    }
    cur = cur.parent;
  }
  return null;
}
