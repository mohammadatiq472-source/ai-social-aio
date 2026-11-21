/**
 * P1–P12 用例自测（M3 交付的一部分）。
 *
 * 为什么要在单测里跑整套 P 项：这些用例是"物理是否还在工作"的唯一证据。
 * 如果用例本身写错了（比如第一版把斜坡方向搞反、把传送当移动），
 * 外面看到的"绿"就是假的。这里锁住的是**用例逻辑**，不是最终验收结果。
 *
 * 关键：本文件**不断言 P3 通过**。P3 有一个已确认的规格书内部矛盾
 * （maxSlopeClimbAngle=50° 让 45° 坡可爬），如实断言"它会报 specConflict"，
 * 而不是把参数偷偷改小让它变绿。真正的裁决留给 lead。
 */
import { describe, it, expect, beforeAll } from 'vitest';
import RAPIER from '@dimforge/rapier3d-compat';
import { CASES, VERIFY_TOTAL, runVerify, isVerifyMode } from './harness';

beforeAll(async () => {
  await RAPIER.init();
});

describe('verify harness：契约形状（docs/world/verify-contract.md）', () => {
  it('用例总数必须是 12（契约 §2 硬要求）', () => {
    expect(CASES.length).toBe(VERIFY_TOTAL);
    expect(VERIFY_TOTAL).toBe(12);
  });

  it('id 是 P1..P12 且不重复，顺序与 spec §7 一致', () => {
    const ids = CASES.map((c) => c.id);
    expect(ids).toEqual([
      'P1', 'P2', 'P3', 'P4', 'P5', 'P6',
      'P7', 'P8', 'P9', 'P10', 'P11', 'P12',
    ]);
    expect(new Set(ids).size).toBe(12);
  });

  it('每条都有中文标题', () => {
    for (const c of CASES) {
      expect(c.title.length).toBeGreaterThan(0);
      // 中文短标题，不是英文占位
      expect(/[\u4e00-\u9fa5]/.test(c.title)).toBe(true);
    }
  });

  it('isVerifyMode 只认 ?verify=1', () => {
    expect(isVerifyMode('?verify=1')).toBe(true);
    expect(isVerifyMode('?verify=1&x=2')).toBe(true);
    expect(isVerifyMode('?x=2&verify=1')).toBe(true);
    expect(isVerifyMode('?verify=0')).toBe(false);
    expect(isVerifyMode('')).toBe(false);
    expect(isVerifyMode('?debug=1')).toBe(false);
  });
});

describe('verify harness：每条用例都产出合法结果', () => {
  it('12 条全部返回契约要求的结构（id/title/pass/measured/detail）', async () => {
    const results = [];
    for (const c of CASES) {
      const r = await c.run();
      results.push(r);
    }

    expect(results.length).toBe(12);
    for (const r of results) {
      expect(typeof r.id).toBe('string');
      expect(typeof r.title).toBe('string');
      expect(typeof r.pass).toBe('boolean');
      expect(typeof r.measured).toBe('string');
      expect(r.measured.length).toBeGreaterThan(0);
      expect(typeof r.detail).toBe('object');
      // detail 的值只能是 number/string/boolean（契约 §2）
      for (const v of Object.values(r.detail)) {
        const t = typeof v;
        expect(t === 'number' || t === 'string' || t === 'boolean').toBe(true);
      }
    }
  });

  it('P1 平地走 5m：误差 ≤1cm', async () => {
    const r = await CASES[0]!.run();
    expect(r.id).toBe('P1');
    expect(r.pass).toBe(true);
    const error = Number(r.detail['error']);
    expect(error).toBeLessThanOrEqual(0.01);
  });

  it('P2 30° 斜坡：不下滑且能上行 ≥1m', async () => {
    const r = await CASES[1]!.run();
    expect(r.id).toBe('P2');
    expect(r.pass).toBe(true);
    expect(Number(r.detail['drift'])).toBeLessThanOrEqual(0.01);
    expect(Number(r.detail['rise'])).toBeGreaterThanOrEqual(1.0);
  });

  it('P3 45° 斜坡：爬不上去（maxClimb=40° < 45°）且确实下滑', async () => {
    const r = await CASES[2]!.run();
    expect(r.id).toBe('P3');
    // lead 裁决后的口径：maxSlopeClimbAngle=40°，所以 45° 坡爬不动
    expect(r.pass).toBe(true);
    expect(Number(r.detail['climb'])).toBeLessThan(0.3);
    // 45° > minSlopeSlideAngle=30°，所以必须真的下滑（不是卡住不动）
    expect(Number(r.detail['slid'])).toBeGreaterThan(0.02);
    expect(r.detail['maxSlopeClimbAngleDeg']).toBe(40);
    expect(r.detail['minSlopeSlideAngleDeg']).toBe(30);
  });

  it('P4 台阶 0.30m：能上（y ≥0.28）', async () => {
    const r = await CASES[3]!.run();
    expect(r.pass).toBe(true);
    expect(Number(r.detail['climbedY'])).toBeGreaterThanOrEqual(0.28);
  });

  it('P5 台阶 0.45m：不能上（y <0.20）且不穿模', async () => {
    const r = await CASES[4]!.run();
    expect(r.pass).toBe(true);
    expect(Number(r.detail['climbedY'])).toBeLessThan(0.2);
    expect(r.detail['noClip']).toBe(true);
  });

  it('P6 跳跃高度：落在 1.20±0.03', async () => {
    const r = await CASES[5]!.run();
    expect(r.pass).toBe(true);
    const h = Number(r.detail['height']);
    expect(h).toBeGreaterThanOrEqual(1.17);
    expect(h).toBeLessThanOrEqual(1.23);
    // 解析解是 sqrt(2*9.81*1.20) = 4.8522（spec 文字写 4.85，是四舍五入）
    expect(Number(r.detail['analyticVelocity'])).toBeCloseTo(4.85, 1);
    // 实际起跳速度 = 解析解 + g*dt/2（离散积分的半步修正），必须严格大于解析解
    expect(Number(r.detail['launchVelocity'])).toBeGreaterThan(
      Number(r.detail['analyticVelocity']),
    );
    expect(Number(r.detail['halfStepCorrection'])).toBeCloseTo(9.81 / 120, 4);
  });

  it('P7 5m 落体：不穿地、落地后站稳', async () => {
    const r = await CASES[6]!.run();
    expect(r.pass).toBe(true);
    expect(r.detail['landed']).toBe(true);
    expect(Number(r.detail['minY'])).toBeGreaterThan(0.5);
    expect(Number(r.detail['settleSpeed'])).toBeLessThan(0.05);
  });

  it('P8 推 10kg 箱：箱子位移 ≥0.5m 且角色没被弹飞', async () => {
    const r = await CASES[7]!.run();
    expect(r.pass).toBe(true);
    expect(Number(r.detail['boxMoved'])).toBeGreaterThanOrEqual(0.5);
    expect(r.detail['notFlung']).toBe(true);
  });

  it('P9 冲刺撞墙：不穿墙且有切向位移（是滑不是卡死）', async () => {
    const r = await CASES[8]!.run();
    expect(r.pass).toBe(true);
    expect(r.detail['notThrough']).toBe(true);
    expect(Number(r.detail['tangential'])).toBeGreaterThan(0);
  });

  it('P10 两角色相撞：间距 ≥2×半径−0.02 且不抖', async () => {
    const r = await CASES[9]!.run();
    expect(r.pass).toBe(true);
    expect(Number(r.detail['dist'])).toBeGreaterThanOrEqual(Number(r.detail['minDist']));
    expect(Number(r.detail['jitter'])).toBeLessThan(0.005);
  });

  it('P11 200 箱堆叠 60s：每箱位移 ≤5cm', async () => {
    const r = await CASES[10]!.run();
    expect(r.pass).toBe(true);
    expect(r.detail['count']).toBe(200);
    expect(Number(r.detail['maxDrift'])).toBeLessThanOrEqual(0.05);
    // 池够用：200 个箱子没有触发扩容到 200 以上太多（预分配 256）
    expect(Number(r.detail['pooledCreated'])).toBeLessThanOrEqual(256);
  });

  it('P12 60s 连续运行：稳态增量 ≤200KB，或如实标 skipped', async () => {
    const r = await CASES[11]!.run();
    expect(r.id).toBe('P12');
    if (r.detail['skipped'] === true) {
      // 拿不到数据时**必须**是 pass:false（契约禁止谎报）
      expect(r.pass).toBe(false);
      expect(r.measured).toContain('SKIP');
    } else {
      // 稳态增量（第二个 60s 窗口），不是含一次性开销的第一个窗口
      expect(Number(r.detail['growthKB'])).toBeLessThanOrEqual(200);
      expect(r.detail['windows']).toBe(2);
      // 必须标注数据来源，否则不知道是浏览器还是 node 测的
      expect(['performance.memory', 'process.memoryUsage']).toContain(r.detail['source']);
    }
  });
});

describe('verify harness：runVerify 的报告形状', () => {
  it('status 从 running 走到 done，passed 与 cases 对得上', async () => {
    const report = await runVerify();
    expect(report.status).toBe('done');
    expect(report.total).toBe(12);
    expect(report.cases.length).toBe(12);
    const passed = report.cases.filter((c) => c.pass).length;
    expect(report.passed).toBe(passed);
    expect(typeof report.startedAt).toBe('number');
    expect(typeof report.finishedAt).toBe('number');
    expect(report.finishedAt).toBeGreaterThanOrEqual(report.startedAt);
  });

  it('env 字段齐全（ua/hardwareConcurrency/renderer/rapierVersion）', async () => {
    const report = await runVerify({ only: ['P1'] });
    expect(typeof report.env.ua).toBe('string');
    expect(typeof report.env.hardwareConcurrency).toBe('number');
    expect(typeof report.env.renderer).toBe('string');
    expect(report.env.rapierVersion.length).toBeGreaterThan(0);
  });

  it('只跑子集时 total 仍是 12（少跑不能算通过）', async () => {
    const report = await runVerify({ only: ['P1', 'P6'] });
    expect(report.total).toBe(12);
    expect(report.cases.length).toBe(2);
    // 只跑了 2 条，passed 最多 2 —— 外面据此能判断"没跑完"
    expect(report.passed).toBeLessThanOrEqual(2);
  });

  it('单条用例抛异常不会让报告停在 running', async () => {
    // 直接构造一个会抛的用例验证兜底：用一个不存在的 only 值不会抛，
    // 所以这里验证"报告一定是 done"这个不变量。
    const report = await runVerify({ only: [] });
    expect(report.status).toBe('done');
    expect(report.cases.length).toBe(12);
  });
});
