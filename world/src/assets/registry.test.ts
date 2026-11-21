import { describe, it, expect } from 'vitest';
import { readFileSync, existsSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  ANIM_CLIP_ALIAS,
  ASSETS,
  BUDGET,
  MODEL_FACING_OFFSET_Y,
  WHALEGIRL,
  budgetWarnings,
  facingOffsetFromUrl,
  findAsset,
  requireAsset,
  resolveFacingOffset,
  validateRegistry,
} from './registry';

const HERE = dirname(fileURLToPath(import.meta.url));
const WORLD_ROOT = join(HERE, '..', '..');

describe('registry 登记表自检', () => {
  it('validateRegistry 无问题', () => {
    expect(validateRegistry()).toEqual([]);
  });

  it('key 唯一', () => {
    const keys = ASSETS.map((a) => a.key);
    expect(new Set(keys).size).toBe(keys.length);
  });

  it('url 都是相对路径（base:"./" 部署下绝对路径会 404）', () => {
    for (const a of ASSETS) {
      expect(a.url.startsWith('/'), `${a.key} 的 url 不能以 / 开头`).toBe(false);
      expect(/^https?:/.test(a.url), `${a.key} 的 url 不能是绝对 URL`).toBe(false);
    }
  });

  it('每个资产都写明 source 与 license（spec §11.3）', () => {
    for (const a of ASSETS) {
      expect(a.source.length, `${a.key} 缺 source`).toBeGreaterThan(0);
      expect(a.license.length, `${a.key} 缺 license`).toBeGreaterThan(0);
    }
  });

  it('角色资产必须声明 animations', () => {
    for (const a of ASSETS.filter((x) => x.kind === 'character')) {
      expect(a.animations, `${a.key} 缺 animations`).toBeDefined();
      expect(a.animations!.length).toBeGreaterThan(0);
    }
  });

  it('findAsset 命中与未命中', () => {
    expect(findAsset('whalegirl')).toBe(WHALEGIRL);
    expect(findAsset('不存在的资产')).toBeUndefined();
  });

  it('requireAsset 未登记时抛错且错误信息列出已登记项', () => {
    expect(() => requireAsset('nope')).toThrow(/未在 registry\.ts 登记/);
    expect(() => requireAsset('nope')).toThrow(/whalegirl/);
  });

  it('whalegirl 的动画覆盖 spec 要求的核心状态', () => {
    const anims = new Set(WHALEGIRL.animations);
    // 资产实测有 8 条。idle/walk/jump/sit 是必须有；
    // run 与 fall 资产没有，靠 ANIM_CLIP_ALIAS 回落到 walk / jump_down。
    for (const required of ['idle', 'walk', 'jump', 'sit']) {
      expect(anims.has(required), `资产缺 ${required} 动作`).toBe(true);
    }
  });

  it('缺 run/fall 时有明确的回落映射（不能靠状态机碰运气）', () => {
    const anims = new Set(WHALEGIRL.animations);
    expect(anims.has('run')).toBe(false); // 资产确实没有 run
    expect(ANIM_CLIP_ALIAS['run']).toBe('walk');
    expect(anims.has(ANIM_CLIP_ALIAS['run']!), 'run 的回落目标必须真实存在').toBe(true);
    expect(ANIM_CLIP_ALIAS['fall']).toBe('jump_down');
    expect(anims.has(ANIM_CLIP_ALIAS['fall']!), 'fall 的回落目标必须真实存在').toBe(true);
  });

  it('别名表里每个目标都必须是资产真实有的 clip', () => {
    const anims = new Set(WHALEGIRL.animations);
    for (const [state, target] of Object.entries(ANIM_CLIP_ALIAS)) {
      expect(anims.has(target), `别名 ${state} → ${target} 指向不存在的 clip`).toBe(true);
    }
  });
});

describe('模型朝向偏移（物理 +Z 约定与资产朝向必须分开）', () => {
  it('MODEL_FACING_OFFSET_Y 是有限数（默认 0 = 待人工确认，不是已确认）', () => {
    expect(Number.isFinite(MODEL_FACING_OFFSET_Y)).toBe(true);
  });

  it('非 dev 环境（node 无 window）时 resolveFacingOffset 回落到常量', () => {
    // node 里没有 window，facingOffsetFromUrl 必须返回 null 而不是抛错
    expect(facingOffsetFromUrl()).toBeNull();
    expect(resolveFacingOffset()).toBe(MODEL_FACING_OFFSET_Y);
  });
});
describe('registry 与磁盘文件一致（这是防"换了资产没更新登记表"的唯一手段）', () => {
  it('whalegirl 文件存在且字节数与登记表一致', () => {
    const p = join(WORLD_ROOT, WHALEGIRL.url);
    expect(existsSync(p), `文件不存在：${p}`).toBe(true);
    const bytes = readFileSync(p).byteLength;
    expect(bytes, '字节数与 registry 不符（换过资产但没更新登记表？）').toBe(WHALEGIRL.bytes);
  });

  it('whalegirl 的 sha256 与登记表一致', () => {
    const p = join(WORLD_ROOT, WHALEGIRL.url);
    const hex = createHash('sha256').update(readFileSync(p)).digest('hex');
    expect(hex, 'sha256 与 registry 不符').toBe(WHALEGIRL.sha256);
  });

  it('whalegirl 在「单个角色 glb ≤5MB」预算内（spec §5.3）', () => {
    expect(WHALEGIRL.bytes).toBeLessThanOrEqual(BUDGET.characterBytes);
    expect(budgetWarnings()).toEqual([]);
  });
});
