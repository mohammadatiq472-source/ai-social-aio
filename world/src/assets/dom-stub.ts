/**
 * node 环境下的最小浏览器 API 桩（**只给单测用**）。
 *
 * 为什么需要：three 的 `GLTFLoader` 在解析贴图时会用 `new Image()`、`createImageBitmap`、
 * `self.URL.createObjectURL`。node 里没有这些，解析会直接抛 `ReferenceError`。
 *
 * 为什么不能靠"用 any 糊过去"：那会让真正的类型错误也一起被吞掉。
 * 这里统一用 `as unknown as X` 明确表达"我知道这不是真货"，
 * 且所有转型集中在这一个文件里，测试文件本身保持干净的类型。
 *
 * 局限（必须知道）：桩只让流程走完，**不验证贴图是否真的解码**。
 * 贴图解码的正确性由浏览器里的 `tools/measure-assets.mjs` 与人工目视确认。
 */

type GlobalWithBrowserBits = typeof globalThis & {
  Image?: unknown;
  createImageBitmap?: unknown;
  self?: unknown;
};

const g = globalThis as GlobalWithBrowserBits;

interface ImageStub {
  width: number;
  height: number;
  onload: ((ev: { target: ImageStub }) => void) | null;
  onerror: ((ev: unknown) => void) | null;
  src: string;
  addEventListener: (type: string, fn: (ev: unknown) => void) => void;
  removeEventListener: (type: string, fn: (ev: unknown) => void) => void;
}

/** 造一个"能触发 onload"的假 Image。 */
export function installImageStub(): void {
  if (g.Image !== undefined) return;

  function FakeImage(this: ImageStub) {
    let srcValue = '';
    Object.defineProperty(this, 'src', {
      get: () => srcValue,
      set: (v: string) => {
        srcValue = v;
        // 异步触发，模拟真实加载时序（同步触发会让 three 的 await 链行为失真）
        queueMicrotask(() => this.onload?.({ target: this }));
      },
    });
    this.width = 1;
    this.height = 1;
    this.onload = null;
    this.onerror = null;
    this.addEventListener = (type, fn) => {
      if (type === 'load') this.onload = fn as never;
      if (type === 'error') this.onerror = fn;
    };
    this.removeEventListener = () => {};
  }

  g.Image = FakeImage as unknown as typeof Image;
}

/** 假 createImageBitmap：返回 1×1 的位图形状。 */
export function installCreateImageBitmapStub(): void {
  if (g.createImageBitmap !== undefined) return;
  g.createImageBitmap = (async () => ({
    width: 1,
    height: 1,
    close() {},
  })) as unknown as typeof createImageBitmap;
}

/**
 * `self` 与 blob URL。
 * GLTFLoader 里是 `const URL = self.URL || self.webkitURL;`，node 没有 `self` 会直接抛。
 */
export function installSelfAndUrlStub(): void {
  // `self` 在 lib.dom 里被声明为 `Window & typeof globalThis`，而 node 的 globalThis
  // 没有 Window 的那些成员（name / onbeforexrselect ...）。
  // 这里造的就是个"能当 self.URL 用的壳"，所以显式转型，不假装它是真 Window。
  if (g.self === undefined) {
    g.self = globalThis as unknown as Window & typeof globalThis;
  }

  const u = globalThis.URL as typeof URL & {
    createObjectURL?: (o: unknown) => string;
    revokeObjectURL?: (s: string) => void;
  };
  if (typeof u.createObjectURL !== 'function') {
    u.createObjectURL = () => 'blob:aio-world-test-stub';
  }
  if (typeof u.revokeObjectURL !== 'function') {
    u.revokeObjectURL = () => {};
  }
}

/** 一次性装齐（测试文件在 import 阶段调用）。 */
export function installDomStubs(): void {
  installImageStub();
  installCreateImageBitmapStub();
  installSelfAndUrlStub();
}
