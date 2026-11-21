/**
 * 资产登记表（spec §6 M2）。
 *
 * 纪律（spec §11.3）：**每个进仓库的资产都要写明来源与许可**。
 * 这里不是"填个字段意思一下"——许可争议是本项目最容易翻车的地方（见 spec §11），
 * 所以 `source` 与 `license` 是必填的，且 source 要能追溯到具体文件。
 *
 * 字节数与 sha256 必须与磁盘上的文件一致：
 * - dev 构建会校验 sha256（生产跳过，省启动时间）
 * - 两者不符 = 有人换了资产却没更新登记表，必须当错误处理（否则线上 404/黑模型）
 */

export type AssetKind = 'character' | 'env' | 'texture';

export interface AssetEntry {
  /** 代码里引用的稳定 key，不要用文件名（换格式时不用改调用点）。 */
  key: string;
  /** 相对 `base` 的路径。Vite 的 `base: './'` 下必须是相对路径。 */
  url: string;
  /** 文件字节数，用于体积预算与完整性校验。 */
  bytes: number;
  /** 小写十六进制 sha256。 */
  sha256: string;
  kind: AssetKind;
  /** 来源：必须能追溯到具体产物（谁生成的、从哪来的）。 */
  source: string;
  /** 许可：必须是可商用的明确许可。 */
  license: string;
  /** 动画 clip 名（仅 character）。渲染层按名字找 clip，名字错了要能立刻发现。 */
  animations?: readonly string[];
  /** 这个资产在压缩管线里经历了什么，便于复现。 */
  pipeline?: string;
}

/**
 * 鲸鱼娘角色（自有资产）。
 *
 * 管线记录（`node tools/build-character.mjs` 实测，可复跑）：
 *
 *   原始  4,516,756 B (4.31 MB)  /  139 primitive / 20 动画 / 顶点 36893 / 三角形 30753
 *   [1] 合并 139 个蒙皮网格 → **1 个 primitive**（draw call 1112 → 8 @ 同屏 8 角色）
 *   [2] 动画裁剪 20 → 8 条（spec §4.1 的 7 个状态够用）
 *   [3] 关键帧抽稀 动画 401.0 KB → 66.7 KB（tolerance 1e-2）
 *   [4] 贴图 755.2 KB → 242.0 KB（512px webp q75）
 *   [5] 量化 NORMAL/TEXCOORD/WEIGHTS + meshopt（**POSITION 保持 float32**）
 *   产出  1,771,944 B (1.69 MB) raw / 1,300,350 B (1.24 MB) gzip
 *
 * ⚠ 为什么合并蒙皮网格要自己写：`@gltf-transform/functions` 的 `join()`
 * 源码里直接 `if (node.getSkin()) continue;`，**跳过所有蒙皮节点**。
 * 本资产 139 个蒙皮网格共享 1 skin / 1 material / 1 种属性布局，是最理想的合并场景，
 * 但 join() 一个都不碰。所以 tools/build-character.mjs 里手动拼顶点与索引。
 *
 * ⚠ 为什么不量化 POSITION：实测会让模型尺寸翻倍
 * （0.3130×0.9995×0.6196 → 0.6263×2.0000×1.2399）。
 * 原因是 quantize 的位移补偿要写进 node transform 或 skin 的 IBM，
 * 而本资产的蒙皮节点 transform 是单位值，补偿没落地。多个变体上都复现了。
 * 这条由管线末尾的「尺寸一致」校验兜住，改坏了会直接失败。
 *
 * ⚠ 动画缺口（重要，M5 状态机要处理）：
 * 本资产**没有 `run` 也没有 `fall`** 这两个 clip。
 * - `run`：状态机请求 run 时回落到 `walk`（`AvatarAnimator.transition` 找不到 clip 就保持当前，
 *   所以实际上会在 walk 上加速播放；后续若拿到带 run 的资产，改 animations 表即可）
 * - `fall`：回落到 `jump_down`（资产里就是"落下"的动作）
 */
export const WHALEGIRL: AssetEntry = {
  key: 'whalegirl',
  url: 'assets/characters/whalegirl.glb',
  bytes: 2117328,
  sha256: '2f73d0b8d9514d760e87e40868e29bd60cf90d13c8d0202f12d83b298c8fd6e8',
  kind: 'character',
  source:
    '自有资产：Tripo 智能网格生成（见 .workbuddy/whale-extract/handover/鲸鱼娘项目交接包/README_交接文档.md）',
  license: '自有（AIO 项目所有），非第三方授权资产',
  animations: [
    // 移动与状态
    'idle',
    'walk',
    'jump',
    'jump_down',
    'sit',
    'turn',
    'wait',
    // 情绪（用户点名"愤怒"）
    'angry_01',
    'angry_02',
    'angry_03',
    'afraid',
    'cry',
    // 表情键
    'bow',
    'agree',
    'hug',
    'heart_pose',
    'fold_arms',
    // 场景动作（v0.1 房间里暂时没有对应物体，但保留以便后续）
    'box_01',
    'basketball_shot',
    'cast_a_spell',
  ],
  pipeline:
    'merge(139→1 primitive) → resample(1e-2) → texture(512px webp q75) → quantize(NORMAL/TEXCOORD/WEIGHTS, 不量化POSITION) → meshopt；4.31MB → 1.54MB raw / 0.93MB gzip（20 条动画全保留）',
};

/**
 * 全部 20 条动画的体积实测（2026-11-20，`tools/build-character.mjs`）：
 *
 * | 动画条数 | raw      | gzip     | brotli   |
 * |---------|----------|----------|----------|
 * | 8 条     | 1.69 MB  | 1.24 MB  | —        |
 * | 15 条    | 1.55 MB  | 1.02 MB  | —        |
 * | **20 条**| **1.54 MB** | **0.93 MB** | **911 KB** |
 *
 * **反直觉但实测如此：动画越多，体积越小。**
 * 原因是 `resample(tolerance 1e-2)` 对**短动画**的抽稀效率更高
 * （短动画的关键帧密度更大、冗余更多），而 20 条里多数是 2~4 秒的短动作。
 * 所以"砍动画省体积"这个假设在抽稀之后不成立——**先抽稀再决定砍不砍**。
 *
 * 首屏预算：JS 1335.2 + 资产 brotli 911.3 = **2246.5 KB / 3072 KB**（余量 825 KB）。
 */

/**
 * 染色变体：tint key → 十六进制颜色（spec §5.2 一份几何 × N 份材质）。
 *
 * 为什么颜色表放在 registry 而不是 agents 层：
 * tint 是**资产层的概念**（"这份几何的一个外观变体"），不是行为概念。
 * Agent 只负责说"我要 tint-3"，具体 tint-3 长什么样是资产的事。
 *
 * 6 个颜色刻意拉开色相（蓝/橙/绿/紫/粉/青），保证同屏 6 个角色一眼能区分——
 * 这也是 M2「染色变体」的现场验证：如果 6 个都长一样，说明材质没克隆成功。
 */
export const TINT_COLORS: Readonly<Record<string, string>> = {
  'tint-0': '#7fa8ff', // 蓝
  'tint-1': '#ffb37a', // 橙
  'tint-2': '#8ce99a', // 绿
  'tint-3': '#d0a9ff', // 紫
  'tint-4': '#ff9ec4', // 粉
  'tint-5': '#7ce7e0', // 青
};

/** 未知 tint 的兜底色（不抛错：染色失败不该让角色消失）。 */
export const TINT_FALLBACK = '#cfd6e4';

/** 把 tint key 解析成颜色。未知 key 返回兜底色，并允许调用方决定是否告警。 */
export function tintColor(tint: string | undefined): string {
  if (!tint) return TINT_FALLBACK;
  return TINT_COLORS[tint] ?? TINT_FALLBACK;
}

/**
 * 模型原生朝向 → 世界 +Z 的偏移（绕 Y 轴，弧度）。
 *
 * **为什么这个常量必须显式写死一处**：
 * 物理侧（`src/physics/character.ts`）约定「正前方 = +Z，yaw = atan2(fx, fz)」，
 * 这是全项目的坐标系事实来源。但**资产原生朝哪，是另一件事**——
 * Tripo 产出的模型可能默认朝 -Z、+X 或任意方向。两者必须分开：
 * 物理约定不变，资产朝向只在渲染层用这个 offset 修正。
 * 如果混在一起（例如去改物理的 yaw 约定），换个模型会让物理和动画同时错。
 *
 * **实测值 `-π/2`（2026-11-20 修正，第二次）**：
 *
 * ⚠️ 这里我犯过一次错，必须记下来：
 *
 * **第一次**我用 `?ry=` 逐角度截图，看到 `+π/2` 时"正脸朝镜头"，就定了 `+π/2`。
 * 但那个测试有个致命盲区：**我只验证了"脸朝哪"，没验证"走的方向对不对"**。
 *
 * 用户实测反馈：按 W 向前走，**身体是倒退着走的**（脸朝镜头、背朝前进方向）。
 *
 * 根因：`?cam=face` 时相机 yaw=π（相机在 -Z 侧看向 +Z），
 * 所以"脸朝镜头"= 脸朝 -Z。而物理约定角色朝向 +Z。
 * 于是模型正面朝 -Z、移动方向 +Z ⇒ 倒退。
 *
 * **正确做法是把两个约束一起验**：
 * 1. 走动时身体正面必须朝**前进方向**
 * 2. 相机从背后（默认 yaw=π）看时应该看到**后脑勺**
 *
 * 修正为 `-π/2` 后，`root.rotation.y=0`（朝 +Z）时模型正面也朝 +Z ✓，
 * 同时特写相机 yaw 改为 0（相机在 +Z 侧看向 -Z）才能看到正脸。
 *
 * | ry      | 正面朝向 |
 * |---------|---------|
 * | 0       | -Z（错，倒退走） |
 * | +π/2    | -X |
 * | **-π/2**| ✅ **+Z**（与物理约定一致） |
 * | π       | +Z（也能对，但会让 yaw 映射反号，不选） |
 *
 * 教训：**朝向验证必须同时验"脸朝哪"和"走的方向"**，只验一个必然出错。
 */
export const MODEL_FACING_OFFSET_Y = -Math.PI / 2;

/**
 * 从 URL 读 `?ry=` 调试参数（仅 dev 构建生效）。
 *
 * 为什么需要：模型朝向只能人眼看，现场调参比改代码+重启快得多。
 * 生产构建里这个函数返回 null（Vite 把 `import.meta.env.DEV` 摇成 false），
 * 所以线上不会被 URL 参数改朝向。
 */
export function facingOffsetFromUrl(): number | null {
  if (typeof window === 'undefined') return null;
  const dev = (import.meta as unknown as { env?: { DEV?: boolean } }).env?.DEV;
  if (!dev) return null;
  const raw = new URLSearchParams(window.location.search).get('ry');
  if (raw === null) return null;
  const v = Number(raw);
  return Number.isFinite(v) ? v : null;
}

/** 生效的朝向偏移：URL 参数优先（dev），否则用常量。 */
export function resolveFacingOffset(): number {
  return facingOffsetFromUrl() ?? MODEL_FACING_OFFSET_Y;
}

/**
 * 状态名 → 资产 clip 名的映射。
 *
 * spec §4.1 有 7 个状态，资产只有 8 个 clip 且缺 run/fall。
 * 这里显式写死回落关系，而不是让状态机"碰运气"：
 * - run → walk（资产没有跑步动作；宁可走路快一点也不 T-pose）
 * - fall → jump_down（资产里的下落动作）
 * - emote → 由调用方指定具体 clip（agree/bow/afraid）
 */
export const ANIM_CLIP_ALIAS: Readonly<Record<string, string>> = {
  run: 'walk',
  fall: 'jump_down',
  emote: 'agree',
};

/** 全部资产。新增资产必须在这里登记，否则 loader 会拒绝加载（防止漏登记）。 */
export const ASSETS: readonly AssetEntry[] = [WHALEGIRL];

const BY_KEY = new Map(ASSETS.map((a) => [a.key, a]));

export function findAsset(key: string): AssetEntry | undefined {
  return BY_KEY.get(key);
}

/** 拿不到就抛：静默返回 undefined 会让调用方拿着 undefined 去 fetch，错误信息很难查。 */
export function requireAsset(key: string): AssetEntry {
  const a = BY_KEY.get(key);
  if (!a) {
    throw new Error(
      `资产 "${key}" 未在 registry.ts 登记。已登记：${ASSETS.map((x) => x.key).join(', ') || '(空)'}`,
    );
  }
  return a;
}

/**
 * 登记表自检。dev 构建与单测都调它。
 *
 * 检查项：
 * - key 唯一（重复会让 findByKey 静默取到其中一个）
 * - url 是相对路径（绝对路径在 `base: './'` 部署下会 404）
 * - bytes/sha256 形状合法（运行时真正比对文件由 verifyAsset 做）
 * - character 必须声明 animations（否则渲染层无法建状态机）
 */
export function validateRegistry(): string[] {
  const problems: string[] = [];
  const seen = new Set<string>();

  for (const a of ASSETS) {
    if (seen.has(a.key)) problems.push(`key 重复："${a.key}"`);
    seen.add(a.key);

    if (!a.key.trim()) problems.push('存在空 key');
    if (!a.url.trim()) problems.push(`"${a.key}" 的 url 为空`);
    if (/^(https?:)?\/\//.test(a.url) || a.url.startsWith('/')) {
      problems.push(`"${a.key}" 的 url 必须是相对路径（当前 "${a.url}"），否则部署到子路径会 404`);
    }
    if (!Number.isInteger(a.bytes) || a.bytes <= 0) {
      problems.push(`"${a.key}" 的 bytes 非法：${a.bytes}`);
    }
    if (!/^[0-9a-f]{64}$/.test(a.sha256)) {
      problems.push(`"${a.key}" 的 sha256 不是 64 位小写十六进制：${a.sha256}`);
    }
    if (!a.source.trim()) problems.push(`"${a.key}" 缺 source（spec §11.3 要求写明来源）`);
    if (!a.license.trim()) problems.push(`"${a.key}" 缺 license（spec §11.3 要求写明许可）`);
    if (a.kind === 'character' && (!a.animations || a.animations.length === 0)) {
      problems.push(`角色资产 "${a.key}" 必须声明 animations`);
    }
  }

  return problems;
}

/** 体积预算（spec §5.3）。超了给警告，不阻断——预算超了要在构建报告里看见，而不是静默通过。 */
export const BUDGET = {
  /** 单个角色 glb 上限。 */
  characterBytes: 5 * 1024 * 1024,
  /** 房间环境 glb 上限。 */
  envBytes: 8 * 1024 * 1024,
} as const;

export function budgetWarnings(): string[] {
  const out: string[] = [];
  for (const a of ASSETS) {
    const limit = a.kind === 'character' ? BUDGET.characterBytes : a.kind === 'env' ? BUDGET.envBytes : Infinity;
    if (a.bytes > limit) {
      out.push(`"${a.key}" ${(a.bytes / 1024 / 1024).toFixed(2)}MB 超过 ${a.kind} 预算 ${(limit / 1024 / 1024).toFixed(0)}MB`);
    }
  }
  return out;
}
