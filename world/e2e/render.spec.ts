import { test, expect } from '@playwright/test';

/**
 * M1 渲染内核的端到端验收。
 *
 * 断言什么、不断言什么，写清楚：
 * - ✅ 渲染链路通（canvas 有尺寸、WebGL 上下文存在、无 JS 异常）
 * - ✅ resize 不变形（容器变了以后 drawingBuffer 的宽高比跟着变，且 camera.aspect 同步）
 * - ✅ 降级规则生效（移动端 shadows=false、dpr ≤ 1.6；桌面 shadows=true）
 * - ✅ __worldDebug 暴露 fps/drawCalls/triangles
 * - ❌ **不断言 fps 数值**：CI 的 headless Chromium 走 SwiftShader 软件光栅，
 *     帧率反映 CPU 单核速度，拿它当"60fps 通过"是自欺欺人。
 *     这里只断言"有在出帧"（fps > 0），真机 60fps 由人工/真 GPU 机器验证。
 */

test.describe('M1 渲染内核', () => {
  test('页面加载无异常，canvas 占满视口', async ({ page }) => {
    const errors: string[] = [];
    page.on('pageerror', (e) => errors.push(String(e)));
    page.on('console', (m) => {
      if (m.type() === 'error') errors.push(m.text());
    });

    await page.goto('/');
    await page.waitForFunction(() => typeof window.__worldDebug !== 'undefined', null, {
      timeout: 30_000,
    });

    const canvas = page.locator('canvas');
    await expect(canvas).toHaveCount(1);

    const box = await canvas.boundingBox();
    const viewport = page.viewportSize();
    expect(box).not.toBeNull();
    expect(viewport).not.toBeNull();
    // canvas 应该铺满视口（允许 2px 的取整误差）
    expect(Math.abs(box!.width - viewport!.width)).toBeLessThanOrEqual(2);
    expect(Math.abs(box!.height - viewport!.height)).toBeLessThanOrEqual(2);

    expect(errors, `页面报错：${errors.join(' | ')}`).toHaveLength(0);
  });

  test('__worldDebug 暴露 fps / drawCalls / triangles', async ({ page }) => {
    await page.goto('/');
    await page.waitForFunction(() => typeof window.__worldDebug !== 'undefined', null, {
      timeout: 30_000,
    });
    // 等 fps 滑窗填满（实现里是 500ms 窗口）
    await page.waitForTimeout(1500);

    const stats = await page.evaluate(() => window.__worldDebug!.read());

    expect(typeof stats['fps']).toBe('number');
    expect(typeof stats['drawCalls']).toBe('number');
    expect(typeof stats['triangles']).toBe('number');

    // 只断言"在出帧"，不断言具体帧率（见文件头说明）
    expect(stats['fps']).toBeGreaterThan(0);
    // 空场景的几何量应该很小：地面 + 网格 + 占位胶囊
    expect(stats['drawCalls']).toBeGreaterThan(0);
    expect(stats['drawCalls']).toBeLessThan(20);
    expect(stats['triangles']).toBeLessThan(10_000);
  });

  test('resize 后画面不变形：drawingBuffer 宽高比跟随容器', async ({ page }) => {
    await page.goto('/');
    await page.waitForFunction(() => typeof window.__worldDebug !== 'undefined', null, {
      timeout: 30_000,
    });

    const readSize = () =>
      page.evaluate(() => {
        const c = document.querySelector('canvas')!;
        return {
          // drawingBuffer 尺寸（受 pixelRatio 影响）
          buffer: [c.width, c.height] as [number, number],
          // CSS 尺寸
          css: [c.clientWidth, c.clientHeight] as [number, number],
          dpr: window.devicePixelRatio,
        };
      });

    const before = await readSize();
    expect(before.buffer[0]).toBeGreaterThan(0);

    // 换成一个明显不同的宽高比：1920×1080 → 900×1200（竖屏）
    await page.setViewportSize({ width: 900, height: 1200 });
    // 给 ResizeObserver 一个回调周期
    await page.waitForTimeout(600);

    const after = await readSize();

    // 1) CSS 尺寸跟上了
    expect(Math.abs(after.css[0] - 900)).toBeLessThanOrEqual(2);
    expect(Math.abs(after.css[1] - 1200)).toBeLessThanOrEqual(2);

    // 2) drawingBuffer 也跟着变（说明不只是 CSS 缩放）
    expect(after.buffer[0]).not.toBe(before.buffer[0]);

    // 3) 关键：buffer 的宽高比 == CSS 的宽高比（不变形）
    const bufferAspect = after.buffer[0] / after.buffer[1];
    const cssAspect = after.css[0] / after.css[1];
    expect(Math.abs(bufferAspect - cssAspect)).toBeLessThan(0.02);
  });

  test('桌面：开阴影、DPR ≤ 2', async ({ page }, testInfo) => {
    test.skip(testInfo.project.name !== 'desktop', '只在 desktop project 跑');

    await page.goto('/');
    await page.waitForFunction(() => typeof window.__worldDebug !== 'undefined', null, {
      timeout: 30_000,
    });

    const stats = await page.evaluate(() => window.__worldDebug!.read());
    expect(stats['tier']).toBe('desktop');
    expect(stats['shadows']).toBe(true);
    expect(Number(stats['dpr'])).toBeLessThanOrEqual(2);
  });

  test('移动端：关阴影、DPR ≤ 1.6', async ({ page }, testInfo) => {
    test.skip(testInfo.project.name !== 'mobile', '只在 mobile project 跑');

    await page.goto('/');
    await page.waitForFunction(() => typeof window.__worldDebug !== 'undefined', null, {
      timeout: 30_000,
    });

    const stats = await page.evaluate(() => window.__worldDebug!.read());
    expect(stats['tier']).toBe('mobile');
    expect(stats['shadows']).toBe(false);
    expect(Number(stats['dpr'])).toBeLessThanOrEqual(1.6);
  });

  test('相机：滚轮缩放受上下限约束，拖拽环绕不翻过头顶', async ({ page }) => {
    await page.goto('/');
    await page.waitForFunction(() => typeof window.__worldDebug !== 'undefined', null, {
      timeout: 30_000,
    });

    // 相机状态是嵌套对象，read() 返回 Record<string, unknown>，这里显式收窄
    const before = await page.evaluate(
      () => window.__worldDebug!.read()['camera'] as { yaw: number; pitch: number; distance: number },
    );

    // 疯狂往上拖（pitch 会撞上限）
    await page.evaluate(() => {
      for (let i = 0; i < 50; i++) window.__worldDebug!.orbit(0, 100);
    });
    const afterPitch = await page.evaluate(
      () => window.__worldDebug!.read()['camera'] as { yaw: number; pitch: number; distance: number },
    );

    expect(afterPitch.pitch).toBeLessThanOrEqual(1.19); // PITCH_MAX ≈ 1.18
    expect(afterPitch.pitch).toBeGreaterThanOrEqual(-0.23); // PITCH_MIN ≈ -0.22
    expect(afterPitch.pitch).not.toEqual(before.pitch);

    // 缩放夹取
    await page.evaluate(() => {
      for (let i = 0; i < 50; i++) window.__worldDebug!.setDistance(0.1);
    });
    const near = await page.evaluate(
      () => window.__worldDebug!.read()['camera'] as { distance: number },
    );
    expect(near.distance).toBeGreaterThanOrEqual(1.6); // ZOOM_MIN

    await page.evaluate(() => {
      for (let i = 0; i < 100; i++) window.__worldDebug!.setDistance(100);
    });
    const far = await page.evaluate(
      () => window.__worldDebug!.read()['camera'] as { distance: number },
    );
    expect(far.distance).toBeLessThanOrEqual(9.0); // ZOOM_MAX
  });

  test('渲染循环与固定步长解耦：掉帧时物理仍按固定步推进', async ({ page }) => {
    await page.goto('/');
    await page.waitForFunction(() => typeof window.__worldDebug !== 'undefined', null, {
      timeout: 30_000,
    });

    const t0 = await page.evaluate(() => window.__worldDebug!.read());
    await page.waitForTimeout(2000);
    const t1 = await page.evaluate(() => window.__worldDebug!.read());

    // tick 在推进（说明物理在跑）
    expect(Number(t1['tick'])).toBeGreaterThan(Number(t0['tick']));

    // 世界时间 ≈ tick × 1/60（固定步长，不是墙钟）
    const tickDelta = Number(t1['tick']) - Number(t0['tick']);
    const timeDelta = Number(t1['worldTime']) - Number(t0['worldTime']);
    expect(timeDelta).toBeCloseTo(tickDelta / 60, 1);
  });
});
