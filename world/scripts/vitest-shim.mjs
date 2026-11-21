/**
 * `vitest` 的最小替身（只给 scripts/run-tests-sandbox.mjs 用）。
 *
 * 覆盖本仓库实际用到的 matcher。语义尽量与 Vitest 对齐，特别是：
 * - toBe 用 Object.is（所以 NaN === NaN 通过、+0/-0 不通过）
 * - toEqual 做深比较（不比较原型）
 * - toBeCloseTo 的精度参数是小数点后位数，容差 10^-digits / 2
 * - toThrow 接受构造函数或正则
 */

let currentSuite = [];

// ───────────────────────────── 用例收集 ─────────────────────────────
// 与 Vitest 一致：describe 的回调是同步的，it 的回调可以返回 Promise。
// 所以这里先**收集**，再由运行器统一 await 执行——否则异步用例会被提前判失败。

const collected = [];

export function describe(name, fn) {
  currentSuite.push(name);
  globalThis.__runner?.onSuite?.();
  try {
    fn();
  } finally {
    currentSuite.pop();
  }
}

export function it(name, fn) {
  const full = [...currentSuite, name].join(' › ');
  collected.push({ name: full, fn });
}

it.skip = (name) => {
  const full = [...currentSuite, name].join(' › ');
  collected.push({ name: full, fn: null, skipped: true });
};
it.only = it;

/** 由运行器调用：按收集顺序 await 执行所有用例。 */
export async function __runCollected() {
  const list = collected.splice(0, collected.length);
  for (const c of list) {
    if (c.skipped || !c.fn) {
      globalThis.__runner?.onSkip?.(c.name);
      console.log(`  - ${c.name}（skip）`);
      continue;
    }
    try {
      await __runBeforeEach();
      await c.fn();
      globalThis.__runner?.onPass?.();
      console.log(`  ✓ ${c.name}`);
    } catch (err) {
      globalThis.__runner?.onFail?.(c.name, err);
      console.log(`  ✗ ${c.name}`);
    } finally {
      try {
        await __runAfterEach();
      } catch (err) {
        globalThis.__runner?.onFail?.(`${c.name}（afterEach）`, err);
      }
    }
  }
}

// ───────────────────────────── 钩子 ─────────────────────────────
// 这些钩子必须真的执行：beforeAll 里通常做 RAPIER.init() / bind 注入，
// beforeEach 里通常造假 DOM 并接到 container.ownerDocument。
// 空实现会让后续用例拿到未初始化的状态（表现为"handler is not a function"这类谜之错误）。

let pendingBeforeAll = [];
let pendingAfterAll = [];
let pendingBeforeEach = [];
let pendingAfterEach = [];

export function beforeEach(fn) {
  pendingBeforeEach.push(fn);
}
export function afterEach(fn) {
  pendingAfterEach.push(fn);
}
export function beforeAll(fn) {
  pendingBeforeAll.push(fn);
}
export function afterAll(fn) {
  pendingAfterAll.push(fn);
}

/** 由运行器在每个文件 import 之后调用：执行本文件注册的 beforeAll。 */
export async function __runBeforeAll() {
  const hooks = pendingBeforeAll;
  pendingBeforeAll = [];
  for (const fn of hooks) await fn();
}

/** 由运行器在每个文件结束时调用：执行 afterAll。 */
export async function __runAfterAll() {
  const hooks = pendingAfterAll;
  pendingAfterAll = [];
  for (const fn of hooks) await fn();
}

/** 每个用例前执行（运行器在 __runCollected 里逐条调）。 */
export async function __runBeforeEach() {
  for (const fn of pendingBeforeEach) await fn();
}

/** 每个用例后执行。 */
export async function __runAfterEach() {
  for (const fn of pendingAfterEach) await fn();
}

// ───────────────────────────── expect ─────────────────────────────

function deepEqual(a, b) {
  // 非对称匹配器优先：arrayContaining / objectContaining / any
  if (b && typeof b === 'object' && typeof b.__matcher === 'string') {
    if (b.__matcher === 'arrayContaining') {
      if (!Array.isArray(a)) return false;
      return b.sample.every((s) => a.some((v) => deepEqual(v, s)));
    }
    if (b.__matcher === 'objectContaining') {
      if (a === null || typeof a !== 'object') return false;
      return Object.keys(b.sample).every((k) => deepEqual(a[k], b.sample[k]));
    }
    if (b.__matcher === 'any') {
      if (b.ctor === String) return typeof a === 'string';
      if (b.ctor === Number) return typeof a === 'number';
      if (b.ctor === Boolean) return typeof a === 'boolean';
      if (b.ctor === Function) return typeof a === 'function';
      return a instanceof b.ctor;
    }
  }

  if (Object.is(a, b)) return true;
  if (typeof a !== typeof b) return false;
  if (a === null || b === null) return false;
  if (typeof a !== 'object') return false;

  const aIsArr = Array.isArray(a);
  const bIsArr = Array.isArray(b);
  if (aIsArr !== bIsArr) return false;

  if (aIsArr) {
    if (a.length !== b.length) return false;
    for (let i = 0; i < a.length; i++) if (!deepEqual(a[i], b[i])) return false;
    return true;
  }

  const ka = Object.keys(a).filter((k) => a[k] !== undefined);
  const kb = Object.keys(b).filter((k) => b[k] !== undefined);
  if (ka.length !== kb.length) return false;
  for (const k of ka) {
    if (!Object.prototype.hasOwnProperty.call(b, k)) return false;
    if (!deepEqual(a[k], b[k])) return false;
  }
  return true;
}

function show(v) {
  if (typeof v === 'string') return JSON.stringify(v);
  if (typeof v === 'number' || typeof v === 'boolean' || v === null || v === undefined) return String(v);
  try {
    return JSON.stringify(v);
  } catch {
    return String(v);
  }
}

function makeAssertions(actual, negated, customMessage) {
  const check = (ok, msg) => {
    if (negated ? ok : !ok) {
      // Vitest 的 expect(value, message) 第二参数是"失败时附加的上下文"
      const suffix = customMessage ? `\n   上下文: ${customMessage}` : '';
      throw new Error(msg + suffix);
    }
  };

  const api = {
    toBe(expected) {
      check(Object.is(actual, expected), `期望 ${negated ? '不等于' : '等于'} ${show(expected)}，实际 ${show(actual)}`);
    },
    toEqual(expected) {
      check(deepEqual(actual, expected), `期望深等于 ${show(expected)}，实际 ${show(actual)}`);
    },
    toBeNull() {
      check(actual === null, `期望 ${negated ? '不为' : '为'} null，实际 ${show(actual)}`);
    },
    toBeUndefined() {
      check(actual === undefined, `期望 ${negated ? '不为' : '为'} undefined，实际 ${show(actual)}`);
    },
    toBeDefined() {
      check(actual !== undefined, `期望${negated ? '为' : '不为'} undefined，实际 ${show(actual)}`);
    },
    toHaveLength(n) {
      const len = actual == null ? -1 : actual.length;
      check(len === n, `期望长度 ${n}，实际 ${len}`);
    },
    toContain(needle) {
      let found = false;
      if (typeof actual === 'string') found = actual.includes(needle);
      else if (Array.isArray(actual)) found = actual.some((v) => deepEqual(v, needle));
      else throw new Error('toContain 只支持字符串或数组');
      check(found, `期望${negated ? '不' : ''}包含 ${show(needle)}，实际 ${show(actual)}`);
    },
    toMatch(re) {
      if (typeof actual !== 'string') throw new Error('toMatch 只支持字符串');
      const pattern = re instanceof RegExp ? re : new RegExp(String(re));
      const ok = pattern.test(actual);
      check(ok, `期望${negated ? '不' : ''}匹配 ${pattern}，实际 ${show(actual).slice(0, 200)}`);
    },
    toMatchObject(expected) {
      const ok = deepEqual(actual, objectContaining(expected));
      check(ok, `期望包含字段 ${show(expected)}，实际 ${show(actual)}`);
    },
    toBeInstanceOf(ctor) {
      const ok = actual instanceof ctor;
      const actualName = actual?.constructor?.name ?? String(actual);
      check(ok, `期望是 ${ctor?.name} 的实例，实际是 ${actualName}`);
    },
    toBeGreaterThan(n) {
      check(actual > n, `期望 > ${n}，实际 ${actual}`);
    },
    toBeGreaterThanOrEqual(n) {
      check(actual >= n, `期望 >= ${n}，实际 ${actual}`);
    },
    toBeLessThan(n) {
      check(actual < n, `期望 < ${n}，实际 ${actual}`);
    },
    toBeLessThanOrEqual(n) {
      check(actual <= n, `期望 <= ${n}，实际 ${actual}`);
    },
    toBeCloseTo(expected, digits = 2) {
      const tol = Math.pow(10, -digits) / 2;
      const ok = Math.abs(actual - expected) < tol;
      check(ok, `期望接近 ${expected}（容差 ${tol}），实际 ${actual}，差 ${Math.abs(actual - expected)}`);
    },
    toThrow(matcher) {
      let threw = false;
      let caught;
      try {
        actual();
      } catch (e) {
        threw = true;
        caught = e;
      }
      if (negated) {
        if (threw) throw new Error(`期望不抛错，实际抛了 ${caught && caught.message}`);
        return;
      }
      if (!threw) throw new Error('期望抛错，实际没有抛');
      if (matcher === undefined) return;
      if (typeof matcher === 'function') {
        if (!(caught instanceof matcher)) {
          throw new Error(`期望抛 ${matcher.name}，实际抛 ${caught && caught.constructor && caught.constructor.name}`);
        }
        return;
      }
      if (matcher instanceof RegExp) {
        if (!matcher.test(String(caught && caught.message))) {
          throw new Error(`期望错误信息匹配 ${matcher}，实际 "${caught && caught.message}"`);
        }
        return;
      }
      throw new Error('toThrow 只支持构造函数或正则');
    },
  };
  return api;
}

export function expect(actual, message) {
  const api = makeAssertions(actual, false, message);
  api.not = makeAssertions(actual, true, message);
  return api;
}

// ───────────────────────────── 非对称匹配器 ─────────────────────────────
// 只实现本仓库用到的 arrayContaining / objectContaining / any。
// 它们是"预期值的包装"，在 toEqual/toContain 里被识别。

export function arrayContaining(sample) {
  return { __matcher: 'arrayContaining', sample };
}

export function objectContaining(sample) {
  return { __matcher: 'objectContaining', sample };
}

export function any(ctor) {
  return { __matcher: 'any', ctor };
}

// Vitest 里这些既是命名导出，也是 expect 的静态属性（`expect.arrayContaining(...)`）。
// 两种写法都要支持，否则调用方换个写法就炸。
expect.arrayContaining = arrayContaining;
expect.objectContaining = objectContaining;
expect.any = any;
expect.stringContaining = (s) => ({ __matcher: 'stringContaining', s });
expect.stringMatching = (re) => ({ __matcher: 'stringMatching', re });
