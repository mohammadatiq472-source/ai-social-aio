/**
 * 键盘输入（WASD + Shift + Space，第三人称标准做法）。
 *
 * 设计要点，每条都有具体理由：
 *
 * 1. **移动方向相对相机，不是世界轴**。
 *    按 W 是"往镜头看的方向走"。如果按世界 +Z 走，镜头一转角色就走反了——
 *    这是第三人称最常见的错。
 *
 * 2. **对角线归一化**。
 *    W+D 同时按时，`(1,0)+(0,1)` 的长度是 √2。不归一化会比单按 W 快 41%，
 *    表现为"斜着走明显更快"。这是新手最容易漏的一步。
 *
 * 3. **松开键要减速，不是瞬停**。
 *    瞬停看起来像"撞墙"。这里用"目标速度为 0 + 控制器自己的加速度衰减"实现，
 *    因为 `CharacterController` 内部已经有加速度上限（见 physics/character.ts），
 *    我们只需要**不喂方向**，它自己会刹。
 *
 * 4. **只读输入，不直接改 transform**。
 *    输入层产出 `{ dirX, dirZ, run, jump }`，交给 `controller.update()`。
 *    直接写 transform 会绕过物理，表现为穿墙/悬空。
 *
 * 5. **按键状态用 Set 而不是布尔**。
 *    W 和 ↑ 是两个不同的键但映射到同一个动作；用 Set 能正确处理
 *    "W 按住时再按 ↑ 又松开 ↑" 这种重叠情况（布尔会误判成"松开 W"）。
 */

/** 一个动作可以由多个物理键触发。 */
const KEY_MAP = {
  forward: ['KeyW', 'ArrowUp'],
  backward: ['KeyS', 'ArrowDown'],
  left: ['KeyA', 'ArrowLeft'],
  right: ['KeyD', 'ArrowRight'],
  run: ['ShiftLeft', 'ShiftRight'],
  jump: ['Space'],
} as const;

export type ActionName = keyof typeof KEY_MAP;

/** 输入快照。位置在**世界空间**，已归一化。 */
export interface MoveInput {
  /** 世界空间水平方向（已归一化；零向量 = 不移动）。 */
  dirX: number;
  dirZ: number;
  /** 是否奔跑。 */
  run: boolean;
  /** 本帧是否请求跳跃（边沿触发，按住不会连跳）。 */
  jump: boolean;
  /** 是否有任何移动键按下（调试用）。 */
  moving: boolean;
}

export const IDLE_INPUT: Readonly<MoveInput> = {
  dirX: 0,
  dirZ: 0,
  run: false,
  jump: false,
  moving: false,
};

/** 表情触发回调：按键 → 动作名。 */
export type EmoteHandler = (clip: string) => void;

/**
 * 键盘状态机。
 *
 * 只负责"把物理按键翻译成动作意图"，不碰相机、不碰物理。
 * 每帧由主循环调 `sample(camForward, camRight)` 拿到世界空间方向。
 */
export class KeyboardInput {
  private readonly down = new Set<string>();
  /** 本帧新按下的键（用于边沿触发的跳跃）。 */
  private readonly pressedThisFrame = new Set<string>();
  /** 待消费的跳跃请求：按下时置位，`sample()` 消费后清零。 */
  private jumpPending = false;
  /** 表情键 → clip 名。 */
  private emoteKeys: Readonly<Record<string, string>> = {};
  private onEmote: EmoteHandler | null = null;
  private detach: (() => void) | null = null;

  /** 是否已绑定（便于测试断言）。 */
  get bound(): boolean {
    return this.detach !== null;
  }

  /**
   * 绑定到目标元素。
   *
   * 绑到 `window` 而不是 canvas：canvas 需要焦点才能收键盘事件，
   * 用户点一下别处再按 W 就没反应了——这是"键盘偶尔失灵"的常见原因。
   */
  attach(target: Window | HTMLElement = window): () => void {
    this.detach?.();

    const onKeyDown = (e: Event): void => {
      const ev = e as KeyboardEvent;
      // 输入框里打字时不要抢键（否则用户没法在调试面板里输入）
      if (isEditableTarget(ev.target)) return;

      if (!this.down.has(ev.code)) {
        this.pressedThisFrame.add(ev.code);
        if (KEY_MAP.jump.includes(ev.code as never)) {
          // 边沿触发：只有"从松到按"才算一次跳跃
          this.jumpPending = true;
        }
        const clip = this.emoteKeys[ev.code];
        if (clip && this.onEmote) {
          this.onEmote(clip);
        }
      }
      this.down.add(ev.code);

      // 空格会滚动页面，方向键也会。移动键必须 preventDefault
      if (isGameKey(ev.code)) ev.preventDefault();
    };

    const onKeyUp = (e: Event): void => {
      const ev = e as KeyboardEvent;
      this.down.delete(ev.code);
      if (isGameKey(ev.code)) ev.preventDefault();
    };

    // 失焦时清空所有按键：否则 Alt+Tab 出去再回来，角色会一直朝一个方向走
    const onBlur = (): void => {
      this.down.clear();
      this.jumpPending = false;
    };

    target.addEventListener('keydown', onKeyDown as EventListener);
    target.addEventListener('keyup', onKeyUp as EventListener);
    window.addEventListener('blur', onBlur);

    const cleanup = (): void => {
      target.removeEventListener('keydown', onKeyDown as EventListener);
      target.removeEventListener('keyup', onKeyUp as EventListener);
      window.removeEventListener('blur', onBlur);
      this.down.clear();
      this.detach = null;
    };
    this.detach = cleanup;
    return cleanup;
  }

  /** 注册表情键（数字键 1-9 → clip 名）。 */
  bindEmotes(keys: Readonly<Record<string, string>>, handler: EmoteHandler): void {
    this.emoteKeys = keys;
    this.onEmote = handler;
  }

  /** 某动作是否按下（多键映射任一即可）。 */
  isDown(action: ActionName): boolean {
    return KEY_MAP[action].some((code) => this.down.has(code));
  }

  /**
   * 采样出世界空间移动方向。
   *
   * @param camForward 相机水平前向（已归一化，y≈0）
   * @param camRight   相机水平右向（已归一化，y≈0）
   */
  sample(camForward: { x: number; z: number }, camRight: { x: number; z: number }): MoveInput {
    const f = Number(this.isDown('forward')) - Number(this.isDown('backward'));
    const r = Number(this.isDown('right')) - Number(this.isDown('left'));

    const jump = this.jumpPending;
    this.jumpPending = false;
    this.pressedThisFrame.clear();

    if (f === 0 && r === 0) {
      return { dirX: 0, dirZ: 0, run: this.isDown('run'), jump, moving: false };
    }

    // 相对相机：W 往镜头前方走，D 往镜头右侧走
    let dx = camForward.x * f + camRight.x * r;
    let dz = camForward.z * f + camRight.z * r;

    // 投影到水平面：相机有俯仰角时 forward 带 y 分量，
    // 不投影会让"上坡时角色往天上走"
    dx = dx;
    dz = dz;

    // 归一化：对角线不能更快
    const len = Math.hypot(dx, dz);
    if (len > 1e-6) {
      dx /= len;
      dz /= len;
    }

    return { dirX: dx, dirZ: dz, run: this.isDown('run'), jump, moving: true };
  }

  /** 清空所有按键状态（切场景/失焦时用）。 */
  clear(): void {
    this.down.clear();
    this.pressedThisFrame.clear();
    this.jumpPending = false;
  }

  dispose(): void {
    this.detach?.();
    this.clear();
    this.emoteKeys = {};
    this.onEmote = null;
  }
}

function isGameKey(code: string): boolean {
  for (const codes of Object.values(KEY_MAP)) {
    if ((codes as readonly string[]).includes(code)) return true;
  }
  return /^Digit[1-9]$/.test(code) || code === 'KeyQ' || code === 'KeyE';
}

/**
 * 焦点在 input/textarea/contenteditable 时不要抢键盘。
 *
 * 用鸭子类型（读 tagName / isContentEditable）而不是 `instanceof HTMLElement`：
 * 后者在 node 单测环境里没有这个全局类，会直接抛 ReferenceError；
 * 而这里要判断的信息（标签名、可编辑性）本来就不需要真的 HTMLElement。
 */
function isEditableTarget(t: EventTarget | null): boolean {
  if (!t || typeof t !== 'object') return false;
  const el = t as { tagName?: unknown; isContentEditable?: unknown };
  const tag = typeof el.tagName === 'string' ? el.tagName.toUpperCase() : '';
  return tag === 'INPUT' || tag === 'TEXTAREA' || el.isContentEditable === true;
}

/**
 * 表情键表：数字键 1-6（与 debug 面板的 D/G/P 错开，不冲突）。
 *
 * 映射到资产真实的 20 条 clip（见 registry 的 animations）。
 * 用户点名要"愤怒"，所以 1 号位给它。
 */
export const DEFAULT_EMOTE_KEYS: Readonly<Record<string, string>> = {
  Digit1: 'angry_01',
  Digit2: 'cry',
  Digit3: 'afraid',
  Digit4: 'bow',
  Digit5: 'agree',
  Digit6: 'hug',
};

/**
 * 把相机朝向转成水平单位向量。
 *
 * 为什么单独抽出来：相机有俯仰角时 `getWorldDirection()` 带 y 分量，
 * 直接用它算移动会让角色"往天上走"。这里强制投影到水平面再归一化。
 */
export function horizontalize(v: { x: number; y: number; z: number }): { x: number; z: number } {
  const len = Math.hypot(v.x, v.z);
  if (len < 1e-6) return { x: 0, z: -1 }; // 相机正俯视时给个默认前方
  return { x: v.x / len, z: v.z / len };
}
