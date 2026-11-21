# `assets/` — 资产加载与登记

## 这层管什么

glTF 角色的加载、朝向修正、动画 clip 别名、登记表校验。

| 文件 | 职责 |
|---|---|
| `registry.ts` | **资产登记表**（sha256 / bytes / 动画清单）+ `MODEL_FACING_OFFSET_Y` |
| `loader.ts` | GLTFLoader 封装：加载 → 归一化高度到 1.62m → 应用朝向修正 |
| `dom-stub.ts` | node 单测用的 DOM 桩（GLTFLoader 需要 `document`） |

## 对外暴露什么

```ts
import { WHALEGIRL, MODEL_FACING_OFFSET_Y } from './assets/registry';
import { loadAvatar } from './assets/loader';
```

## 硬约束（改这里之前必读）

1. **换资产必须同时更新 `registry.ts` 的 `bytes` 与 `sha256`**。
   `registry.test.ts` 会读磁盘文件校验，不一致直接失败 —— 这是防"换了资产没更新登记表"的唯一手段。

2. **换资产必须重新验朝向**，不能照抄旧值。
   `MODEL_FACING_OFFSET_Y` 是顶点数据决定的，不同模型可能完全不同。
   验证方法：**同时验"脸朝哪"和"走的方向"**。
   只验"特写能看到正脸"会漏掉"倒退着走"（实测踩过两次）。

3. **资产不会自动进构建产物**。`url: 'assets/...'` 是普通字符串不是模块依赖，
   Vite 不拷它 → 部署后角色 100% 消失且**不报错**。
   已由 `vite.config.ts` 的 `copyStaticAssets` 插件处理。
   ⚠️ 不能用 `publicDir: 'assets'`（会把目录层级摊平，仍然 404）。

4. **首屏预算 3 MB（brotli）**。当前角色资产 2.02 MB。
   贴图分级：baseColor 1024 / normal 1024 / rm 512。
   再往上升会导致预算超支（2048 曾让首屏到 3.094 MB，超 94 KB）。

## 资产管线

```bash
node tools/build-character.mjs <源 glb> assets/characters/whalegirl.glb
```

做的事：合并 139 网格为 1（drawCall 1112→8）/ 关键帧抽稀 / 贴图分级压缩 /
量化 + meshopt / 校验（顶点守恒 / 三角形守恒 / 动画条数）。

源资产：`tmp/ui-code/char/whalegirl-pbr.glb`（8K 贴图，34 MB）。
⚠️ 不要用 `submission/qoder-sites/assets/whalegirl.glb`（那份只有 1024 贴图）。

## 验收

```bash
npx vitest run src/assets/
node tools/tex-size.mjs assets/characters/whalegirl.glb   # 看贴图分辨率
node tools/asset-size.mjs assets/characters/whalegirl.glb # 看 raw/gzip 体积
```
