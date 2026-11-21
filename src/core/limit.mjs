/**
 * 进程内并发闸（[C1] 单进程 / [C8] 不引 Redis）。
 *
 * 为什么要它：sharp 一张 40MP 的图解出来约 160MB（40,000,000 × 4B），而进程内存口径是 400MB。
 * 并发上传或历史回填时，两三个解码同时进行就会 OOM——单进程一挂就是全站不可用（R3）。
 * 像素上限只挡得住「单张太大」，挡不住「同时来五张」，所以必须再加一层并发闸。
 *
 * 为什么队列也要有上限：排队本身不占内存，但会让请求一直挂着。
 * 超过上限直接拒绝（调用方回退原图）比无限堆积更好——宁可这次不派生，也不要把进程拖死。
 *
 * 语义：
 *   acquire() → Promise<boolean>；true = 拿到名额（用完必须 release），false = 队列满，请放弃本次工作。
 *   release() 在拿到名额后必须**恰好调用一次**（用 try/finally），否则名额会泄漏。
 *   名额转交是「直接把 waiter 置 true」，不是因为先减再加——否则中间的瞬时值会让并发数超限。
 */
export function createLimiter({ concurrency, maxQueue = 32, name = 'limiter' } = {}) {
  if (!Number.isInteger(concurrency) || concurrency < 1) {
    throw new Error(`${name}: concurrency 必须是 >=1 的整数`);
  }
  if (!Number.isInteger(maxQueue) || maxQueue < 0) {
    throw new Error(`${name}: maxQueue 必须是 >=0 的整数`);
  }

  let active = 0;
  let peak = 0;
  let done = 0;
  let dropped = 0;
  const waiters = [];

  function acquire() {
    if (active < concurrency) {
      active += 1;
      if (active > peak) peak = active;
      return Promise.resolve(true);
    }
    if (waiters.length >= maxQueue) {
      dropped += 1;
      return Promise.resolve(false);
    }
    return new Promise((resolve) => waiters.push(resolve));
  }

  function release() {
    const next = waiters.shift();
    if (next) {
      done += 1;
      next(true); // 名额直接转交：active 不变，永远不超过 concurrency
      return;
    }
    active = Math.max(0, active - 1);
    done += 1;
  }

  function stats() {
    return { name, concurrency, maxQueue, active, waiting: waiters.length, peak, done, dropped };
  }

  return { acquire, release, stats };
}
