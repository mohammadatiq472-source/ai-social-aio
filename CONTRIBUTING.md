# 贡献指南

> 这个仓库由**三个人 + 各自的 Agent** 共同维护。动手前花 5 分钟读完，能避免一次"两个人改同一个文件、后保存的把先保存的覆盖掉"的事故。
> 3D 世界的零件参数、材质、碰撞规则在 [`world/src/city/README.md`](world/src/city/README.md)；本文件只回答三件事：**谁能改哪里、怎么提、改完怎么证明**。

> **两个仓（2026-11-21 起）**
>
> | 仓 | 可见性 | 用途 |
> |---|---|---|
> | `ai-social-aio-dev` | 私有 | **开发与协作**：所有分支、Issue、PR 都在这里 |
> | `ai-social-aio` | 公开 | **只读镜像**：由 `scripts/build-public-snapshot.mjs` 生成，不要在这里提 PR |
>
> 公开镜像只收「代码 + 对外 README + 2 张截图 + 本文件 + `world/src/city/README.md`」。
> 内部文档（交接、维护手册、部署配置）只存在私有仓。
> 如果你之前 clone 的是旧地址：`git remote set-url origin https://github.com/mohammadatiq472-source/ai-social-aio-dev.git`，或直接重新 clone。

---

## 0. 仓库里有什么

| 子系统 | 目录 | 怎么跑 | 影响面 |
|---|---|---|---|
| AIO 群聊 | `src/` `web/` `sql/` | 根目录 `npm start`；前端在 `web/` 下 `npm run dev` | 有真实用户在用，**最高优先级是别弄坏** |
| 3D 世界 | `world/` | `cd world && npm run dev` | 独立构建、独立测试，**不 import AIO** |

两个子系统不互相 import：世界只能通过 HTTP / MCP 与 AIO 通信。改一边**不应该**让另一边变红；如果变了，先怀疑接口被改了。

---

## 1. 三条红线

1. **不提交密钥**：口令、token、私钥、内网地址、用户数据。日志里也不打消息正文。
2. **数据不进 git**：深圳原始 GeoJSON / 瓦片 / 纹理原图 / 截图 / 构建产物。放 Release、对象存储或本地 `tmp/`（已 gitignore）。
3. **不改线上业务**（`src/` `web/` `sql/` `deploy/`），除非任务明确指向它。3D 任务只碰 `world/` 和 `scripts/verify/`。

---

## 2. 工作流：分支 + PR，不要直接推 main

```bash
# 1) 认领：在 Issues 开一个（或领一个）issue，标题带 [3D] 或 [AIO]
#    正文写：要改哪些路径 / 打算怎么改 / 预计多久

# 2) 同步 main（保持线性，别 merge 出十字交叉）
git switch main
git pull --rebase

# 3) 开分支（一个任务一个分支）
git switch -c feat/world-nanshan

# 4) 只改你写域内的文件（见 §3）；跨域先开 issue 或在 PR 里说明

# 5) 本地跑验证（见 §5）
cd world && npx tsc --noEmit && npx vitest run

# 6) 提交并推送
git add -A && git commit -m "feat(world): 南山样区接入"
git push -u origin feat/world-nanshan

# 7) 在 GitHub 开 PR，按模板逐项勾选；等 CI 绿 + 对应负责人 review
```

规则：

- **不要直接 push main**；main 只接受 PR 合并（建议维护者在仓库设置里打开 branch protection：Require PR + Require review from Code Owners + Require status checks）。
- **不要 force-push 别人的分支**；自己的分支需要整理时用 `git rebase -i` + `--force-with-lease`，且只推自己的。
- PR 合并用 **Squash**，一条 PR 一个可回滚的提交。
- PR 超过 800 行改动就拆；拆不动说明任务定义太大。

---

## 3. 写域：同一目录同一时间只有一个人

| 工作位 | 负责 | 写域 |
|---|---|---|
| **L · 边界与合入** | 公共脊柱、文档、最终验证、合并 | `world/src/main.ts`、`world/src/render/scene.ts`、`world/index.html`、`world/vite.config.ts`、`world/package.json`、`world/README.md`、`README.md`、`CONTRIBUTING.md`、`.github/**`、`scripts/verify/**` |
| **A · 城市与数据** | 深圳数据、几何、材质、街道零件、city 运行时 | `world/src/city/**`、`world/assets/city/**`、`world/tools/build-city/**` |
| **B · 内核与性能** | 物理、控制器、相机、动画、资产、冷启动/首屏预算 | `world/src/physics/**`、`world/src/core/**`、`world/src/render/**`（`scene.ts` 除外）、`world/src/assets/**`、`world/src/interact/**`、`world/src/input/**`、`world/src/agents/**`、`world/tools/*.mjs|mts`（`build-city` 除外） |

- **公共脊柱**（L 列里的文件）三个人都会想改：请提 issue + 精确方案，由 L 改或 L 明确授权后再改。
- 同一目录已有别人在改（看 issue / PR / `docs/协作-认领板.md`）→ **停下先商量**，不要"我先改一下试试"。
- 看到陌生改动（`git status` / `git diff` 不是你写的）→ 先确认是谁，**禁止** `checkout` / `restore` / `stash` 别人的东西。

---

## 3.5 城市瓦片（一个区怎么接）

一个区 = 一个 `assets/city/<scene>/index.json` + 若干 1km compact JSON 片；运行时 3×3 流式 + LOD1。
格式、预算、验收命令见公开版 **[docs/city-tiles.md](https://github.com/mohammadatiq472-source/ai-social-aio/blob/main/docs/city-tiles.md)**。
切分命令：`python world/tools/build-city/split_tiles.py --scene <区>`；`?tiles=0` 可回退单 JSON。

## 4. 3D 世界的硬规则（摘要，全文在 `world/src/city/README.md`）

| # | 规则 | 违反的后果 |
|---|---|---|
| 1 | 地面碰撞块 **≤128m**，不许合回巨型薄地板 | 2km 宽的薄 cuboid 实测下沉约 22cm |
| 2 | 出生点 y 跟随铺装顶（0.12m），胶囊从 `spawn.y + capsuleCenter` 创建 | 抬高玩家"修好"下沉 = 掩盖 bug |
| 3 | 建筑/铺装/街道网格**同一份顶点**同时给渲染和碰撞 | 看得见的墙 ≠ 撞得到的墙 |
| 4 | 保留**凹轮廓/内院**，禁止用包围盒替代 | 出现隐形墙 |
| 5 | 相机与玩家位置分开；鸟瞰只改相机 | 切视角把人挪走 |
| 6 | 固定步长 1/60、KCC 参数、跳跃 4.85m/s、模型朝向、动画状态机**不归城市模块调** | P1–P12 全红，最难回滚 |
| 7 | 角色**不能**做成 dynamic rigid body | 被箱子顶飞、抖动 |
| 8 | 新零件必须进 `CityScene.dispose()` | 显存只涨不降 |
| 9 | 贴图本地打包；`envMap` 显式绑定 | 立面变灰黑塑料块 |
| 10 | 不读 GPL 世界的源码再照抄；不换 three/Rapier；不自研物理求解器 | 许可与稳定性双输 |

---

## 5. 验证：改什么跑什么（没跑就写"未验证"）

| 改了什么 | 必须跑 | 期望 |
|---|---|---|
| 任何 `world/**` | `cd world && npx tsc --noEmit && npx vitest run` | 0 错误；全量 734+ 通过 |
| `world/src/city/**` | 上面 + `npx vitest run src/city/` | 29+ 通过 |
| 物理 / 控制器 | `cd world && npm run build && npm run verify` | P1–P12 12/12 |
| 渲染 / 光照 / 房间 | `cd world && npm run verify:scene` | 17/17（原房间不回归） |
| 街区的浏览器行为 | `cd world && npm run dev -- --port 5199` + `python scripts/verify/verify-futian-city.py` | 全通过 |
| 真实步行 | 同上 + `python scripts/verify/verify-futian-street.py` | 13/13（需要真实 GPU，拒绝 SwiftShader） |
| 首屏 / 帧率 | `npm run preview -- --port 5200` + `node world/tools/verify-perf.mjs --hardware --url "http://127.0.0.1:5200/?scene=futian"` | 冷启动 <2,000ms、帧率不倒退 |
| 新增依赖 | `cd world && npm run license-check` | 0 copyleft |

CI 会自动跑：AIO 回归（协议/冒烟/验收/守卫/PWA）与 **3D 世界 tsc + vitest**。浏览器类验证需要 GPU，默认不在 CI 跑，PR 里要贴本地结果。

> **当前基线（2026-11-21）**：私有仓 `main` 的 `verify` 与 `world` job 是绿的；`ui` job 有 2 条已知红
> （`verify-chat-resilience-ui`、`verify-agent-switches-ui` —— 桌面端导航改成左侧 `.rail` 之后，
> 脚本还在等 `.topnav / .tabbar` 并点 `role=tab`）。PR 里如果只有这两条红，注明"与基线一致"；
> 不要把别的红混进这个解释。
>
> 另有一条 **公开快照守卫**（`public-guard` job）：每次 PR 都会重新生成公开白名单并扫描，
> 一旦把内网地址/密钥/内部文档带进快照就红。不要绕过它。

**"通过"只能写在你亲手跑过的命令上。** 没跑写"未验证"，比没测却写"通过"安全得多。

---

## 6. 数据与许可

- 建筑轮廓与估高：3D-GloBFP（Che et al. 2024，**CC BY 4.0**）；路网与地标轮廓：OpenStreetMap（**ODbL 1.0**）。
- 派生数据继续保留署名与 ODbL 义务，**不能因为渲染代码是 MIT 就改称数据也是 MIT**。
- 3D-GloBFP 走官方源，OSM 走 Geofabrik；**不从二手站点批量扒**。
- 素材优先 CC0（Poly Haven / ambientCG）；参考照片只做外观对照，**不打包进运行资产**。
- 新增材质/模型要留来源、作者、许可、SHA256 与重建脚本，不能只留一个文件。

---

## 7. 提交信息与 PR

```
type(scope): 一句话说清改了什么

- 为什么（约束/坑）
- 实测数字与命令
- 未做项
```

`type`：`feat` / `fix` / `perf` / `docs` / `test` / `chore`。`scope`：`world` / `city` / `physics` / `render` / `aio` / `ci`。

PR 描述里写：`Closes #N`、改动的写域、跑过的验证与结果、截图（UI 改动）、未验证项。

---

## 8. 出问题怎么办

| 情况 | 做法 |
|---|---|
| 合并冲突，冲突文件是公共脊柱 | 停手，找 L 决定谁改 |
| 发现别人覆盖了你的改动 | 在 issue 里写明提交号与文件，**不要静默修回去** |
| 需要回滚 | 用 `git revert <sha>` 发 PR，不要 `reset --hard` 推 main |
| 不确定某条规则是否还成立 | 先读 `world/src/city/README.md` 与 `docs/` 里的决策记录；冲突时**以代码与测试为准**，并在同一个 PR 里修文档 |
