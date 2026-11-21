# AIO 的 3D 世界

AIO 的 3D 世界，**按规格书独立实现**，MIT 许可。

- 设计依据：仓库根目录 `docs/自研3D世界-规格说明书.md`（唯一事实来源）。
- **不派生自 Hyperfy**。Hyperfy 是 GPL-3.0-only，本仓库不合并、不移植、不逐行翻译它的代码，
  也不引入它的任何包。设计过程记录在规格书与交接文档里，作为独立实现的证据。
- 物理用 Rapier（Apache-2.0），渲染用 three.js（MIT）。不自研物理求解器；
  自研的是求解器之上那一层：固定步长、碰撞层、角色控制器、静态几何烘焙、对象池、debug draw。

## 跑起来

```bash
npm install
npm run dev          # http://127.0.0.1:5173
```

| 命令 | 作用 |
|---|---|
| `npm run dev` | 开发服务器（含 `window.__worldDebug`） |
| `npm run build` | `tsc --noEmit` + Vite 生产构建，产物在 `dist/` |
| `npm run preview` | 预览构建产物 |
| `npm run test` | Vitest 单测（纯逻辑，node 环境） |
| `npm run test:e2e` | Playwright 端到端（桌面 1920×1080 + Pixel 5 两档） |
| `npm run verify` | 物理验收套件 P1–P12（真实控制器，`npm run build` 后跑成品；12/12） |
| `npm run license-check` | 扫描直接依赖的许可证，GPL/AGPL/SSPL 直接失败 |

## 贡献（2026-11-21 起）

三个人 + 各自的 Agent 通过 **GitHub 分支 + PR** 合并。动手前读根目录 [`CONTRIBUTING.md`](../CONTRIBUTING.md)：
写域（谁能改哪个目录）、公共脊柱（`src/main.ts` / `src/render/scene.ts` / `index.html` 等只由维护者改）、
验证矩阵（改什么跑什么）、数据与许可。城市零件的硬规则另见 [`src/city/README.md`](src/city/README.md)。

- 不要直接推 `main`；一个任务一个分支、一个 PR。
- PR 里写"跑过什么、结果多少"，**没跑就写未验证**。
- 数据/瓦片/纹理原图不进 git；原始输入与本机截图放 `tmp/`（已 gitignore）。

## 福田街区原型

点右上角「福田街区」或打开 `?scene=futian`。WASD/Shift/空格沿用原控制器，鸟瞰按钮只切相机，不传送角色；原房间仍是默认入口，不加载城市数据。

- 约 2×2km，1,230 个建筑、809 段地面道路；三种程序化立面按四象限合成最多12批，同一份顶点用于静态三角网格碰撞，保留凹轮廓和内院。
- 平安金融中心增加简化收分、顶部与竖向构件；附近样板街增加0.12m铺装、7棵街树、4盏路灯、2张长椅、路牌与入口雨棚。石材/沥青采用本地CC0 PBR贴图，玻璃显式绑定街区局部反射，不再使用重复蓝色渐变。零件、尺寸、材质、来源、许可、碰撞与复跑命令完整保存在 [city 模块文档](src/city/README.md)。
- 地面碰撞必须保持小块（当前最大 128m）。两公里宽薄 cuboid 的真实接触探针曾出现约 22cm 下沉，不能简单合回一块，也不能靠抬高玩家掩盖。
- 是简化样板街，不是实景复刻：除平安金融中心建筑高度599.1m有参考记录外，其余为模型估高；收分曲线、设施及入口布局是设计示意。道路宽度推定、平地近似，未实现立交、真实地形、建筑内部和流式瓦片；长椅有碰撞，暂未接E坐下交互。
- 代码为 MIT；建筑轮廓及估高来自 [3D-GloBFP](https://zenodo.org/records/15487037)（Che et al. 2024，CC BY 4.0），路网和地标轮廓来自 [OpenStreetMap](https://www.openstreetmap.org/copyright)（ODbL 1.0）。派生数据不能当 MIT 代码发布，保留两者署名及 ODbL 义务。平安高度参考 [CTBUH 建筑记录](https://www.skyscrapercenter.com/shenzhen/ping-an-finance-center/54)。

在 `world/` 下复跑（数据转换需要 Python + Shapely，浏览器验证需要 Python Playwright；运行街区不需要 Python）：

```bash
python tools/build-city/build_futian.py
python tools/build-city/build_materials.py
python tools/build-city/test_futian.py
npx vitest run src/city/
python ../scripts/verify/verify-futian-city.py --url http://127.0.0.1:5199/
python ../scripts/verify/verify-futian-street.py --url http://127.0.0.1:5199/
```

裁出的输入与来源保留在 `tools/build-city/source/`，运行数据输出到 `assets/city/futian.json`，随现有资产拷贝流程进入构建。新增城市代码只在选中场景时加载。本轮独立浏览器确认使用RTX4060 Laptop/D3D11，1920×1080三处步行机位短采样约144fps、帧时P95约7.1ms；是本机特定路线的实测，不外推为所有硬件/区域/多角色场景的保证。不能沿用原房间120fps或SwiftShader软渲染数值。

## 当前状态（v0.1 / D1–D6）

**M0–M6、M9、M10 已落地**（spec §6 的 12 个模块里，只剩 M7 协议与 M12 完整套件）。

- 渲染：`WebGLRenderer`（DPR<2 开 antialias）、ACESFilmic 色调映射、sRGB 输出。
- 光照：半球光 + 带阴影方向光（桌面开、移动关）+ 暖色轮廓光。
- 相机：第三人称弹簧跟随、滚轮/双指缩放、右键或拖拽环绕、俯仰角与离地夹取。
- 循环：`requestAnimationFrame` → `core/clock.ts` 固定步长累加器（物理 1/60，单帧最多追 3 步）。
- resize：`ResizeObserver` 观察容器，不依赖 `window.onresize`。
- 移动端降级：关阴影、`pixelRatio ≤ 1.6`。
- 物理（M3/M4）：Rapier 固定步长、碰撞层矩阵、静态几何烘焙、胶囊角色控制器（斜坡/台阶/跳跃）。
- 房间（M6）：`core/room.ts` 校验 + 烘焙，`rooms/demo-room.json` 可换不改代码。
- 资产：glTF + meshopt 解码、dev 校验 sha256、统一 1.62m 脚底贴地、染色变体共享 geometry 只克隆 material。
- 动画：优先级 `jump > fall > run > walk > idle`、crossfade 0.2s、一次性动作 LoopOnce + finished 回落、
  每角色确定性相位偏移；资产缺 clip 时按 `ANIM_CLIP_ALIAS` 显式回落。20 条动画全保留。
- HUD：CSS2D 名字与气泡，气泡 3s 过期、同屏最多 3 个、超出排队不丢弃。
- 操作（M1 输入层）：**WASD/方向键移动（相对相机）、Shift 奔跑、空格跳跃、1–6 表情**。
- 交互（M10）：E 坐/起、推箱、点角色切焦点。
- Agent（M9）：6 个 Agent 循环活动，意图队列 + 失败双通道回报。

未落地：M7 网络协议（v0.1 只定类型，v0.2 才实现）、M12 完整验收套件。

### 键盘操作

| 键 | 作用 |
|---|---|
| `W A S D` / 方向键 | 移动（**相对相机朝向**，不是世界轴） |
| `Shift`（按住） | 奔跑（walk 速度 2.2 → run 4.6 m/s） |
| `空格` | 跳跃（跳高 1.20m，边沿触发不连跳） |
| `E` | 坐下 / 起身 |
| `1`–`6` | 表情：`angry_01` / `cry` / `afraid` / `bow` / `agree` / `hug` |
| `D` / `G` / `P` | 调试面板：物理线框 / 网格 / 暂停物理（仅 dev） |

### M9 Agent 控制面（D5）

- 队列：`agents/queue.ts`，上限 8 条，**超限拒绝新的**（不丢最旧）并返回
  `{t:'failed', reason:'queue_full', intent}`。理由见文件头：丢最旧会让一条 Agent
  以为会执行的意图凭空消失，既非成功也非失败，无法归因；拒绝新的则可观测、可退避。
- 执行器：`agents/executor.ts`，只产出 `ControlInput`（方向/跑/跳/坐/朝向/表情），
  **类型里没有位置字段**，物理不可能被绕过。`say` 走旁路车道，`[move, say]` 在
  第一 tick 就开口同时继续走。`move` 撞住 → `failed(blocked)` 并停止（判定用
  「停滞窗口内离目标没有更近」，沿墙滑也算挡住）。
- 感知：`agents/perceive.ts`，只读。无副作用由「地雷法」锁住：把 World 的 14 个
  写方法换成抛异常的桩，`perceive` 跑完不抛即证明没写过世界。
- 演示：`demo/agents-demo.ts` 6 Agent 循环 walk→say→wait，相位 `i / count`（纯算术，
  零随机，有静态检查断言源码不含 `Math.random`/`Date.now`）。实测首轮开口
  间隔严格 `[0.50 × 5]`s = `LOOP_PERIOD/6`。
- 接线：`demo/wire-demo.ts#startAgentDemo({world, physics, room})`，`main.ts` 加 3 行即可。
- 验收：`node --import ./tools/ts-transform-loader.mjs tools/demo-agents.mts --seconds 30`
  （1800 步，打印 avg/p50/p95/p99/max、每 Agent 路径长与完成/失败数、真实失败 JSON、
  队列上限实测、perceive 指纹自检；任一不达标非零退出）。
  实测 p95 **0.64–0.69ms**（帧预算 16.67ms 的 4.1%），overruns 0。

> 为什么 `tools/` 用新 loader：原 `scripts/ts-node-loader.mjs` 只用 strip 模式，
> 不支持 TS 参数属性（`physics/pool.ts` 用了），任何 import 到物理层的脚本会在
> 加载期抛 `ERR_UNSUPPORTED_TYPESCRIPT_SYNTAX`。`tools/ts-transform-loader.mjs`
> 先 strip、不支持才降级 transform。

### 角色资产：4.31MB → 1.54MB，draw call 1112 → 8，20 条动画全保留

`npm run build:character` 一次跑完四步（顺序不能换）：

| 步骤 | 效果 |
|---|---|
| 1. 合并 139 个蒙皮网格 → 1 | **draw call 1112 → 8**（同屏 8 角色） |
| 2. 关键帧抽稀（tolerance 1e-2） | 动画 1036 KB → 180 KB |
| 3. 贴图 512px webp q75 | 755.2 KB → 242.0 KB |
| 4. 量化 NORMAL/TEXCOORD/WEIGHTS + meshopt | **POSITION 保持 float32** |

| 指标 | 原始 | 产出 |
|---|---|---|
| raw | 4,516,756 B (4.31 MB) | 1,612,500 B (1.54 MB) |
| **gzip** | 3.4 MB | **976,435 B (0.93 MB)** |
| brotli | — | **911 KB** |
| primitive | 139 | **1** |
| 动画 | 20 | **20（全部保留）** |
| 顶点 / 三角形 | 36893 / 30753 | 36893 / 30753（守恒） |
| 尺寸 | 0.3130×0.9995×0.6196 | 不变 |

> **反直觉结论：动画越多，体积越小。**
> | 动画条数 | raw | gzip |
> |---|---|---|
> | 8 条 | 1.69 MB | 1.24 MB |
> | 15 条 | 1.55 MB | 1.02 MB |
> | **20 条** | **1.54 MB** | **0.93 MB** |
>
> 原因是 `resample(tolerance 1e-2)` 对**短动画**抽稀效率更高（短动画关键帧密度大、
> 冗余多），而 20 条里多数是 2~4 秒的短动作。
> **教训：先抽稀再决定砍不砍，"砍动画省体积"这个假设在抽稀之后不成立。**

**四个必须记住的坑**：

1. **`join()` 跳过蒙皮节点**。`@gltf-transform/functions` 源码里 `if (node.getSkin()) continue;`，
   139 个共享 skin 的蒙皮网格它一个都不合并。必须自己拼顶点+索引（见 `build-character.mjs`）。
2. **绝不量化 POSITION**。实测会让尺寸翻倍（→ 0.6263×2.0000×1.2399），
   因为 quantize 的位移补偿要写进 node transform 或 skin 的 IBM，而本资产的蒙皮节点 transform 是单位值。
   管线末尾有「尺寸一致」断言兜住它。
3. **资产朝向不能照抄旧模型**。交接文档记过旧模型要 `rotation.y = -Math.PI/2`，
   但新资产实测是 **`+Math.PI/2`（方向相反）**。
   用 `?ry=` 逐角度截图确认：0 是侧脸、+π/2 是正脸、180° 是背对、-π/2 是另一侧脸。
   已写死在 `registry.ts` 的 `MODEL_FACING_OFFSET_Y`。物理侧约定 +Z 前方**不动**，两者职责分开。
4. **`transform.p[1]` 是胶囊中心，不是脚底**。模型脚底在局部 y=0，
   渲染时必须 `feetYFromCenter()` 减去 0.85m，否则**所有角色悬空半个人高**。
   这个 bug 曾经真实存在过（截图才发现），现在 hero 与 6 个 Agent 都走同一个换算。

**动画缺口**：资产没有 `run` 也没有 `fall`。`registry.ts` 的 `ANIM_CLIP_ALIAS`
显式映射 `run → walk`、`fall → jump_down`，并有单测保证别名目标真实存在。

**资产验收的可复跑脚本**：

| 命令 | 验证什么 | 能否在本机跑 |
|---|---|---|
| `npm run verify:asset` | three 能否加载、1 SkinnedMesh/1 几何/1 材质/41 骨骼/20 动画/归一化贴地 | ✅ node 内可跑 |
| `npm run build:character` | 压缩管线 + 尺寸/顶点/三角形/动画守恒断言 | ✅ |
| `npm run measure:assets` | 浏览器内加载耗时、`geometries` 变体计数 | 需浏览器 |
| `node tools/smoke-built.mjs dist` | 构建产物真能跑（0 pageError / 0 请求失败） | 需浏览器 |

### M2 浏览器实测（由 lead 在可起浏览器的会话中测得）

`window.__worldAssets.measure()` 的真实输出：

```json
{
  "bytes": 1771944,        "loadMs": 316,
  "heightM": 1.62,         "feetOnGround": true,
  "originalHeightM": 1,    "scaleApplied": 1.6208,
  "animations": ["jump_down","afraid","sit","idle","bow","agree","walk","jump"],
  "baselineGeometries": 3,
  "geometries1": 3, "geometries2": 3, "geometries3": 3,
  "geometriesLinear": false
}
```

- **加载 316ms**（桌面 ≤1.5s 目标）✓
- **3 个染色变体同屏，geometries 恒为 3、不增长** → M2「染色变体共享 geometry」验收**实测通过** ✓
  （3 是场景+资产本身的 geometry 基数，不是"1 变体 3 份"）
- 归一化 1.62m、脚底贴地 ✓

构建产物体积（完整 `npm run build`）：`index 27.57KB / three 486.40KB / rapier 4336.69KB`，
JS gzip 合计 **1.78MB** ≤ 3MB ✓。`node tools/smoke-built.mjs dist` → canvas 存在、**0 pageError、0 请求失败**。

> 本仓库作者（render-agent）的会话沙箱禁止 mojo 命名管道，Chromium 起不来，
> 所以上述浏览器内指标由 lead 代为实测。这一条如实记录，不是自我验证。


## 目录

```
src/
  core/      world.ts / types.ts / clock.ts   ← 纯逻辑，可在 node 单测；types.ts 是协议单一来源
  physics/   engine / layers / character / props / bake
  agents/    queue / executor / perceive / system（M9：队列·执行器·感知·接线）
  demo/      agents-demo（6 Agent 配置与相位）/ wire-demo（startAgentDemo 一行式接线）
  interact/  坐下·推动判定·看向（M10）
  render/    scene / camera / avatar / hud
  assets/    loader / registry
  net/       protocol（v0.2 才实现）
  main.ts
rooms/       demo-room.ts
tools/       verify-physics.mjs（P1–P12 驱动；判定在 src/verify/harness.ts，契约见 docs/world/verify-contract.md）
```

## 调试

dev 构建下 `window.__worldDebug` 可用（生产构建会被摇掉）：

```js
__worldDebug.read()        // fps / drawCalls / triangles / tier / dpr / tick / overruns
await __worldDebug.measureFps(1000)  // 1 秒平均 fps
```

## 验收（M1）

| 指标 | 目标 | 实测 / 怎么测 |
|---|---|---|
| 渲染循环 | 稳定运行 | headless SwiftShader 下已验证出帧（见下方口径说明） |
| 空场景帧率 | 60fps @1080p | **待人工在真机 GPU 确认**；工具见 `tools/measure-fps.mjs` |
| 每帧 CPU 逻辑 | p95 ≪ 16.67ms | p50 0.003ms / p95 0.021ms（10000 帧）= 预算的 **0.13%** |
| 物理单步 | ≤4ms | avg 0.955 / p95 2.738 / p99 3.431ms（200 箱 + 8 角色） |
| resize 不变形 | drawingBuffer 宽高比 == CSS 宽高比 | `npm run test:e2e`（`resize 后画面不变形` 用例） |
| 移动端降级 | 关阴影、DPR ≤ 1.6 | `npm run test:e2e`（mobile project）；代码在 `src/render/scene.ts` 的 `detectQualityTier` |
| 循环与物理解耦 | 掉帧时物理仍按 1/60 推进 | `npm run test:e2e` + `src/core/clock.test.ts` |
| 产物体积 | 见下方口径 | 首屏 gzip 1.74MB；业务 JS gzip 10.1kB |

### 关于 fps 的诚实表述（别把它当性能验收）

**"渲染循环在 headless SwiftShader 下稳定运行" ≠ "1080p 60fps 达标"。**

SwiftShader 是 CPU 软件光栅，它的帧率反映单核速度，不代表真机 GPU 性能。
所以本仓库的 fps 结论分两层：

1. **逻辑预算**（可信，与 GPU 无关）：`tools/measure-frame-budget.mjs` 测 Clock + World tick +
   相机弹簧 + 插值，10000 帧 p95 = 0.021ms，占 60fps 预算的 0.13%。这证明**我们的代码不拖后腿**。
2. **渲染帧率**（需真机）：必须在有 GPU 的机器上 `npm run dev` 后读 `__worldDebug.read().fps`，
   或用 `tools/measure-fps.mjs`（它会自己判断 `fpsTrustworthy`）。CI 里的数字不作数。

> 开发环境说明：render-agent 的 DSH 会话沙箱禁止 mojo 命名管道，Chromium 在该会话内
> 起不来（`--single-process` 能起主进程但 `Page.navigate` 超时）。lead 的会话权限更宽，
> 已实测能起来（`chromium-1217` + `--use-gl=swiftshader`，raf ≈ 62fps）。
> 这条差异是会话权限造成的，不是配置问题。

### 未验证项（只能人眼确认，别当成"已通过"）

技术性验收可信度高（P1–P12 跑真控制器、629 单测、生产产物实测），但下面四项
**自动化测不出来**，D7 录片是唯一机会：

| 项 | 为什么测不了 | 怎么验 |
|---|---|---|
| **真机 60fps @1080p** | SwiftShader 是 CPU 软光栅，帧率不代表 GPU | GPU 机器 `npm run dev`，读 `__worldDebug.read().fps`；或 `tools/measure-fps.mjs`（自带 `fpsTrustworthy` 判定） |
| **动画目视无跳变** | 单测锁住转移逻辑，但平滑度只能看 | 录片时看 idle↔walk↔run 切换、起跳/落地 |
| **贴图质量** | 512px webp q75 是否糊，人眼判断 | 近景截图看脸部/围裙细节 |
| **坐姿穿模** | 需要模型与椅子相对位置正确 | 走近椅子按 E，看是否穿模/悬空 |

另外两条已知限制（不是缺陷，是设计取舍）：

- **资产没有 `run` / `fall` clip**：`ANIM_CLIP_ALIAS` 回落 `run→walk`、`fall→jump_down`。
  奔跑时靠物理速度 4.6 m/s 区分观感，但播的还是 walk 动画（略快）。
- **物理胶囊 1.70m vs 视觉 1.62m**：8cm 差异是**有意保留**（胶囊略大于模型，
  避免手肘/头发穿墙，碰撞判定更宽容）。两者都脚底贴地，不会悬空。

## 本机沙箱的两个绕行（正常机器不需要）

本仓库在 DSH 沙箱里开发，该沙箱禁止**管道 stdio 的子进程**，而 esbuild 的 JS API 正是靠它通信。
于是 `vite` / `vitest` 一加载就 `spawn EPERM`。绕行只影响本机，不影响代码与产物语义：

| 命令 | 说明 |
|---|---|
| `npm run build` | 标准链路（esbuild）。正常机器/CI 用这个 |
| `npm run build:sandbox` | 进程内剥类型 + terser 压缩，绕开 esbuild |
| `npm run test` | 标准 Vitest。正常机器/CI 用这个 |
| `npm run test:sandbox` | 进程内跑同一批 `*.test.ts`，断言是同一批断言 |

沙箱专用的 `scripts/sandbox-*.mjs`、`scripts/ts-strip-plugin.mjs`、`scripts/run-tests-sandbox.mjs`、
`vite.config.sandbox.mjs` 都是**只为本机取数**存在，删掉不影响标准链路。

### 体积口径（重要，按决策文档执行）

决策记录：`docs/world/决策-Rapier与体积口径.md`。

> **首屏传输按 gzip 计量，目标 ≤3MB。WASM 计入首屏传输，但不计入「业务 JS」预算。**
> 业务 JS（three 之外的自研代码）单独记录，目标 ≤300KB gzip。

构建产物实测（`npm run measure:budget`，gzip 是真算的，不是估算）：

| 文件 | raw | gzip |
|---|---|---|
| `index-*.js`（**业务 JS**） | 26.6 kB | **9.9 kB** |
| `three-*.js` | 481.1 kB | 116.8 kB |
| `rapier-*.js`（含内联 wasm 2.94MB） | 4,237.5 kB | 1,606.7 kB |
| **首屏合计** | 4,745.2 kB | **1,733.4 kB ✅** |

- 首屏 gzip **1.73MB** ≤ 3MB ✓
- 业务 JS gzip **9.9kB** ≤ 300KB ✓

`rapier-*.js` 之所以 4.34MB raw，是因为 `@dimforge/rapier3d-compat` 把 2.94MB 的
`rapier_wasm3d_bg.wasm` **base64 内联**进 JS（base64 膨胀 4/3 → 3.9MB）。

**为什么保留 compat（而不是换非 compat 省 0.43MB）**——选它的理由不是体积，是**可测性**：

| 维度 | compat | 非 compat |
|---|---|---|
| 浏览器运行 | ✅ | ✅（需 `vite-plugin-wasm`，lead 已验证） |
| **Node/Vitest 里跑物理** | ✅ | ❌ 不可用（exports 在 node 里解析失败） |
| 首屏 gzip | 1.74MB | 1.31MB |

物理是本项目最大技术风险（spec §10 第一条），P11（200 箱堆 60s）/P12（60s 内存）
这类长时用例在 vitest 里跑几秒就能迭代，在浏览器里要几十秒且难调试。
**用 0.43MB gzip 换"物理可在 node 里快速迭代"是划算的。**

> ⚠️ 纠正一条曾写进本文件的错误结论：我曾写"非 compat 版在 Vite 下必然运行时崩溃"。
> **这个结论不完整**——不加 `vite-plugin-wasm` 时确实会崩（`__wbg_set_wasm(字符串)`），
> 但加上插件后能跑通（lead 实测：球从 5m 落下 180 步，`finalY=0.49993`）。
> 教训：**构建绿 ≠ 能跑**，涉及 WASM/Worker/动态导入的改动必须真的打开页面验证。

**D6 如果首屏 >2s**：第一优先动作是切非 compat（那时物理已稳定，不再需要 node 侧快速迭代，
切是纯收益）。已记入交接文档。

## 许可

本仓库代码 MIT（见 `LICENSE`）。依赖必须为宽松许可（MIT / Apache-2.0 / BSD / ISC / zlib / 0BSD / Unlicense），
`npm run license-check` 会拦住 GPL 依赖。资产只使用自有、AI 生成或 CC0，并在 `src/assets/registry.ts` 写明来源。
