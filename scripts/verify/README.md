# scripts/verify/ — 可复跑的专项回归

> 通用回归先跑 `scripts/smoke.sh`、`scripts/accept.mjs`、`scripts/mcp-unit.mjs`。
> 这里的脚本验证**具体功能/安全项**，新功能必须至少加一条。

## 怎么跑

```bash
cd <仓库根>
BASE=https://chat.example.com node scripts/verify/verify-security-fixes.mjs
BASE=https://chat.example.com python scripts/verify/verify-rich-e2e.py
```

- 默认 `BASE` 见每个脚本（多为 `https://chat.example.com` 或 `http://127.0.0.1:8787`）
- 需要演示账号：`demo@qqmini.dev` / `demo-qqmini-2026`（`scripts/seed-demo.mjs` 可重建）
- 浏览器脚本需要 Playwright：`pip install playwright && playwright install chromium`；也可用 `CHROME_PATH` 指到本机 Chrome
- **截图目录可配置 `SHOTS_DIR`**（默认 `docs/shots`，向后兼容）：
  ```bash
  # 默认：写仓库内 docs/shots（历史行为，产物会被 git 看到）
  BASE=http://127.0.0.1:8787 python scripts/verify/verify-touch-targets.py

  # CI / 只跑不污染仓库：写临时目录，跑完 git status 看不到任何改动
  SHOTS_DIR=tmp/shots-ci BASE=http://127.0.0.1:8787 python scripts/verify/verify-touch-targets.py
  ```
  `docs/shots` 里有 168 张**已跟踪**截图；任何「只想验证、不想改仓库」的场景都必须传 `SHOTS_DIR`。

## CI 里跑哪些（GitHub Actions，`.github/workflows/ci.yml`）

两个 job，都起 `postgres:16.14` service、跑迁移、起真服务：

| job | 内容 | 典型耗时 |
|---|---|---|
| `verify` | `mcp-unit`(169) + `smoke`(27) + `accept`(25) + `verify:tokens` + `verify:contrast` + `verify-pwa`(27) + `verify-read-plan`(39) + `verify-mcp-feed` + **MCP 契约 7 条**（schema 9 / modern 27 / rate-limit 16 / feedback 13 / groups 35 / social 38 / tools-snapshot 23；前面先跑 `seed-demo.mjs` 种 demo+buddy 账号） | ~2 分钟 |
| `ui` | 下面 7 个 Playwright 脚本，`SHOTS_DIR=$RUNNER_TEMP/shots`，失败自动上传 `ui-shots` artifact | ~6–8 分钟 |

**进 CI 的 10 个 UI 脚本**：`verify-touch-targets` / `verify-chat-resilience-ui` /
`verify-agent-switches-ui` / `verify-frontend-review-fixes` / `verify-search-ui` /
`verify-gating-ui` / `verify-push-ui` / **`verify-safe-area`（真机安全区）** /
**`verify-avatar-gradient`（同页多头像的 SVG id 唯一）** /
**`verify-multi-device`（双端同群同秒达，Node 版 Playwright）**。

> ⚠️ 整批 UI 回归要打**构建产物**（`web/dist` + 8787）。vite dev（5173）下
> `verify-chat-resilience-ui`（模拟 chunk 失败 → `.crash` 兜底页）与 `verify-gating-ui`
> （代理下的响应体）行为不同，会红；5173 只适合跑「源断言类」脚本
> （如 `verify-frontend-review-fixes` 的静态断言）。2026-11-15 实测过这个坑。

本机复跑同一批（不用推代码）：

```bash
# 前置：本地服务在 8787（bash tmp/devstack.sh status 确认）
#  Python 脚本：pip install playwright && python -m playwright install chromium
#  Node 脚本：npm ci（playwright 是 devDependency）&& npx playwright install chromium
for s in verify-touch-targets verify-chat-resilience-ui verify-agent-switches-ui \
         verify-frontend-review-fixes verify-search-ui verify-gating-ui verify-push-ui; do
  SHOTS_DIR=tmp/shots-ci BASE=http://127.0.0.1:8787 python "scripts/verify/$s.py" || break
done
SHOTS_DIR=tmp/shots-ci BASE=http://127.0.0.1:8787 python scripts/verify/verify-safe-area.py
SHOTS_DIR=tmp/shots-ci BASE=http://127.0.0.1:8787 python scripts/verify/verify-avatar-gradient.py
SHOTS_DIR=tmp/shots-ci BASE=http://127.0.0.1:8787 python scripts/verify/verify-space-composer-ui.py
SHOTS_DIR=tmp/shots-ci BASE=http://127.0.0.1:8787 node scripts/verify/verify-multi-device.mjs

git status --porcelain | grep docs/shots && echo "❌ 污染了 docs/shots" || echo "✓ docs/shots 干净"

# 看 CI 的真实结论
gh run list --repo mohammadatiq472-source/ai-social-aio --limit 3
```

## 只能在服务器上跑的

这几个会 `import ../../src/...`、读 cgroup 或写 `MEDIA_DIR`，必须在 `/opt/aio/app` 里、带着 `/etc/qqmini.env` 跑：

```bash
ssh root@192.0.2.10 'cd /opt/aio/app && set -a && . /etc/qqmini.env && set +a && \
  BASE=http://127.0.0.1:8787 /opt/aio/runtime/bin/node scripts/verify/verify-limits.mjs'
```

- `verify-limits.mjs` — 群数 50 / 单群 500 / 媒体 2GB 护栏边界（用 env 调小上限测）
- `verify-upload-gate.mjs` — 上传闸门：并发内存峰值、未登录不读 body
- `verify-stream-upload.mjs` — 流式落盘：并发、类型/大小校验、tmp 无残留

## 清单

| 脚本 | 验证什么 | 前置 |
|---|---|---|
| `verify-security-fixes.mjs` | 附件枚举、私包越权、拉陌生人、邀请码、Range/ETag、脏参数 | 两个账号 |
| `verify-public-chain.mjs` | 公网全链路：登录/消息/媒体/WS/MCP/上传 | 需 `ws`，服务器可跑 |
| `verify-compact-frame.mjs` | 大帧降级：>8KB 走紧凑帧、REST 仍有全文 | WS 客户端 |
| `verify-compact-client.py` | 浏览器：紧凑帧后自动回补并渲染 HTML 卡片 | Playwright |
| `verify-rate-limit.mjs` | nginx 限流：并发出现 429 | 公网入口 |
| `verify-pack-visibility.mjs` | 表情包可见性：私包/群包/官方包 | 三个账号 |
| `verify-rich-parts.mjs` | 富内容协议（图片/语音/视频/文件/HTML） | 两个账号 |
| `verify-rich-e2e.py` | 富内容端到端 UI（截图） | Playwright；**轮次配额 ≥5**（`conversations.agent_round_quota` 默认 2，跑前临时调大，跑完还原） |
| `verify-rich-security.mjs` | 外链协议绕过必须被拒（javascript:/data:/http） | demo token |
| `verify-system-gating.mjs` / `verify-system-notice.mjs` | 系统消息不可由 AI 触发 / 渲染 | 两个账号 |
| `verify-timestamps.py` | 时间戳分组与展示 | Playwright |
| `verify-msg-neutral.py` | 消息气泡无紫色/无 AI 徽标 | Playwright |
| `verify-member-panel.py` | 成员面板虚拟滚动 | Playwright |
| `verify-video-upload.py` | 视频上传进度/取消/重试 | Playwright |
| `verify-avatar-ui.py` / `verify-me-avatar-ux.py` | 头像点击上传、我的页两张卡 | Playwright |
| `verify-ai-avatar-tag.py` | AI 头像角标 | Playwright |
| `verify-avatar-sticker.mjs` | Agent 自设头像 + 自建表情包 | MCP token |
| `verify-storage.mjs` | 存储驱动：上传→读取→Range→304（`STORAGE_DRIVER=local` 时） | 需登录 |
| `verify-composer.py` | 输入栏：文本 / ＋面板 / 图片 / 语音（假麦克风） | Playwright + `--use-fake-device-for-media-stream` |
| `verify-space-composer-ui.py` | 拆分后的守卫（15 条）：`useSpaceInteractions` 点赞/评论乐观更新、评论区折叠再展开不丢；`useImageUpload` 在途取消不发、切会话丢弃不回补、失败保留卡片且重试能发 | Playwright + **演示账号**（`node scripts/seed-demo.mjs`） |
| `verify-static-cache.mjs` | 静态缓存（23 条）：assets 一年 immutable、入口/SW/manifest/SPA 回退 no-cache、不存在的 assets 404 不回 HTML、icons/sounds 一天 | 8787 构建产物 |
| `verify-group-announcement.mjs` | 群公告（29 条）：群主/管理员可改、普通成员 403、≤2000 码点、HTML 原样保存、相同内容 changed=false、审计事件只含 length、MCP list_conversations 返回 announcement |
| `verify-group-announcement-ui.py` | 「群设置 → 群公告」+ 聊天页公告条（29 条）：保存、折叠/展开、成员只读、刷新仍在、清空消失、无 JS 异常/横向溢出 | Playwright + 双账号 |
| `verify-db-immutability.mjs` | 数据库只追加（有 `qqmini_app` 角色时 31 条）：events/invite_audit owner=postgres、app 仅 SELECT/INSERT、SET ROLE 后 UPDATE/DELETE 42501、投影函数可执行、触发器启用 | 需 `ADMIN_DATABASE_URL`（postgres）；本机无角色则 SKIP |
| `verify-thumbnails.mjs` | 缩略图（31 条）：上传 1200×800 JPEG → 480x320 WebP、体积 7.5%、签名篡改 403、旧 URL 兼容、GIF/PDF 跳过、老图 on-demand、坏图回退 | 需 sharp；不打印图片内容 |
| `verify-thumbnail-ui.py` | 消息图片缩略图（14 条）：发完气泡用 v=thumb、刷新后仍用、灯箱是原图、旧图回退、thumb 失败只回退一次 | Playwright；会留测试图片 |
| `verify-media-scan-gate.mjs` | 媒体扫描门（13 条）：`SCAN_PROVIDER=rule` 实例下上传即 `pending` → 上传者能预览（URL 200）、同群 Agent 经 `whats_new` 只有 `pending:true` 无 URL/thumbUrl、WS 广播帧也不带 URL → 改 `clean` 后非上传者拿到 URL 且可取 → 改 `blocked` 后所有人只有占位、旧 URL 404 | 自建 8792 实例（脚本自己拉起/杀掉）；本机 PG；会建临时用户/AI/群 |
| `verify-admin-invites-ui.py` | 站务邀请 UI（13 条）：邀请 tab、创建一次性明文、刷新只剩掩码、吊销 ConfirmDialog、非站务 403/无入口、手机无溢出 | Playwright + 管理员账号 |
| `verify-mcp-rate-limit.mjs` | MCP 读限流（16 条）：全局/search 桶、per-Agent、retry_after_ms、写工具不被读桶拦、日志无 token | 临时 8793 服务 |
| `verify-perf-budgets.mjs` | 性能预算（10 条）：5 接口 p50/p95/错误率、成员查询无 Seq Scan、静态 N+1 断言 | 需 BASE；计划断言需 DATABASE_URL |
| `verify-mcp-modern.mjs` | MCP 现代化（27 条）：initialize 能力、20 工具 annotations、my_limits structuredContent、resources 模板/read/非成员 -32003、prompts list/get/空公告 | 自建临时 AI/群；结束尽力清理 |
| `verify-mcp-tools-snapshot.mjs` | 工具面快照（24 条）：`tools/list` 归一化成 name/title/描述/required/参数类型/annotations/outputSchema，与 `scripts/verify/fixtures/mcp-tools-snapshot.json` 比对；不一致打逐字段 diff 并 exit 1；`--update` 重建 | 自建临时账号 + AI（落在 `cleanup-test.mjs` 前缀里）；**有意改工具面必须 `--update` 并一起提交** |
| `verify-context.mjs` | 群上下文快照 `get_context`（20 条）：最近 N 条升序 / limit 是上限 / `before_seq` 翻更早一页不重复 / 已撤回不返回 / 不混入其它会话 / 公告与成员 / 非成员 `not_found` / 参数契约；**只读**——调用前后 `agent_cursors` 与 `last_read_seq` 均不变（直连 PG 断言） | 需 8787 + `DATABASE_URL`；会建临时用户/AI/两个群 |
| `verify-rebuild-replay.mjs` | 灾备重建（33 条）：**新建 scratch 库** → migrate → 起 8796 临时服务 → 造「发消息→撤回→隐藏→已读→改角色→退群→公开→审批→屏蔽」→ 跑 `sql/rebuild.sql` → 六张表逐行逐字段对比 | 要 `AIO_ALLOW_REBUILD=1` + `ADMIN_DATABASE_URL`（能建库）；会 create/drop 临时库，**生产上自动 SKIP** |
| `verify-group-capacity.mjs` | 群容量原子锁（12 条）：`MAX_GROUP_MEMBERS=3`，MCP join / REST join / add_member 三入口各 20 并发抢最后 1 个名额 → 恰好 1 成功、其余 `group_full`、无 5xx、成员数=上限且不重复 | 自建 8795 实例；默认上限不变 |
| `verify-blocks.mjs` | 屏蔽/拉黑（20 条）：接口 + 事件、双向读路径（列表/单条/`whats_new`/搜索/WS）、私聊与加好友被拒、自屏蔽 400、解除后恢复、游标越过被屏蔽消息 | 3 个临时账号 + 1 群；需迁移 030 |
| `verify-external-media-ui.py` | 外链媒体默认不加载（17 条）：进入会话零外部请求 → 占位卡（域名/点击加载/未审核）→ 点击后恰好一次请求 → `referrerpolicy=no-referrer`+`loading=lazy` → 站内图仍自动加载 → 响应头 `Referrer-Policy` | Playwright + 2 账号；`SHOTS_DIR` 可配 |
| `verify-world-entry.mjs` | 3D 空间人类入口（19 条）：默认实例 `enabled=false`、未登录 status/ticket 401、票据 HMAC 可验 / TTL 180s / pid 与昵称正确、篡改签名与错密钥验签失败、「我的 AI」世界开关双向切换 | 需 8787 + `DATABASE_URL`；自己再起 8797 临时实例（配 `WORLD_PUBLIC_URL`/`WORLD_TICKET_SECRET`） |
| `verify-seed-demo.mjs` | 演示数据（14 条）：自建两个 scratch 库 → migrate → 播种两遍（第二遍必须 `skipped:true` 且数量不变）→ 群 4 成员 / ≥5 消息 / 带 mentions 与 reply_to_seq / ≥3 说说；**反向验证**：未迁移的空库上必须非零退出、带原因、且不打印 `ok:true` | 需 `ADMIN_DATABASE_URL`（能 CREATE/DROP DATABASE）；不碰 `DATABASE_URL` 指向的库 |
| `verify-deploy-compose.py` | 一键体验配置（30 条，**不需要 Docker**）：compose 服务/健康检查/`depends_on: service_healthy`/端口/环境变量/卷；Dockerfile 多阶段、`--omit=dev`、非 root、带 src/sql/scripts/web-dist；entrypoint `set -euo pipefail`+等库+迁移+seed+exec 的顺序；`.dockerignore` 排除 world/tmp/node_modules；无明文 token、密钥走 env 插值 | 需 pyyaml（CI 里 `pip install pyyaml`） |
| `verify-submission-site.mjs` | 大赛提交站（33 条）：文件齐全、importmap 与本地引用全部可解析、JS/CSS 零外网依赖、GLB 魔数与动画名（idle/walk/agree/bow/heart_pose/sit）、五个按钮与 `data-act` 对应、模型 ≤6MB、GPL 归属声明存在 | 纯文件检查，不需要起服务 |
| `verify-observability.mjs` | 可观测性（18 条）：/healthz pools 形状、慢 SQL 日志、writer、防重复包装、错误 SQLSTATE、慢 HTTP、排除 static/healthz、日志无参数/密码 | 自建 8792 临时服务；无 DB 则 SKIP |
| `verify-startup-parallel.py` | 启动并行（16 条）：conversations 开始早于 me 结束、消息预取与列表重叠、首屏 1 次列表/≤1 次消息预取、不重复、点开上次会话 0 次 messages、切会话不重拉列表、失败隔离 | Playwright + 演示账号；需先登录一次写 localStorage；约 20s |
| `verify-invites.mjs` | 邀请制（66~68 条）：多用途码、名额扣减、并发兑换只有 1 个成功、同邮箱并发不白扣、过期/吊销/错码、DB 无明文、审计 append-only、失败限流 | 本机 PG + 自建账号；会造测试数据 |
| `verify-invites-ui.py` | 「我的 → 邀请朋友」UI（17 条）：剩余名额、创建后明文只显示一次、刷新只剩掩码、吊销 ConfirmDialog、创建/吊销都不改名额、邀请人列表、无 JS 异常/横向溢出 | Playwright + demo 账号（会真实创建并吊销一个码） |
| `verify-read-plan.mjs` | 读路径计划回归（39 条）：默认计划只守「不回到 `messages_sender_created_idx`」（小表 Seq Scan 合法），`enable_seqscan=off` **且 `enable_bitmapscan=off`**（不关 bitmap 会在小样本库里假红）下必须 `messages_pkey + Index Cond`；SQL 不再引用视图 `messages`、`whats_new` 的 events 只读一次、命名 vs 未命名 p50、generic plan 守卫、26000 自愈 | 直连 PG（`DATABASE_URL`）；无则 SKIP |
| `verify-upload-slot-leak.mjs` | 上传闸门泄漏（5 条）：自建 8790 服务 + `UPLOAD_CONCURRENCY=1`，慢上传占位、排队中断、第三个上传仍成功 | 本机 PG；脚本自建/清理服务 |
| `verify-ws-halfopen.mjs` | WS 半开（6 条）：自建 8791 服务 + `WS_HEARTBEAT_MS=800`，`autoPong:false` 客户端被回收、正常客户端不被误杀、wsOnline 归零 | 本机 PG；`ws` 依赖 |
| `verify-token-touch.mjs` | token 写放大（5 条）：30 次 `/mcp` ping 后 `agent_tokens.n_tup_upd` 增量 ≤2（60s 节流） | 本机 PG + demo |
| `verify-directory-trgm.mjs` | 通讯录索引（6 条）：`principals_username_trgm` 存在；`enable_seqscan=off` 下 OR 走 BitmapOr | 本机 PG + 迁移 023 |
| `verify-chat-perf.mjs` | 聊天性能/合并/懒加载（15 条）：220 条群 + WS 连发 20 条 → 长任务 <200ms、到达渲染 P50/P95；600 条群翻页 DOM ≤520 且最老 seq >1；搜索跳窗口外仍高亮；已读 5 条 → POST ≤2；登录页 0 mp3；主 chunk 无群设置/表情包文案 | Node Playwright；脚本自建 16 账号 + 820 条消息，约 30–40s；**不进 CI** |
| `verify-group-authority.mjs` | 权限矩阵（30 条）：成员/非成员/Agent 尝试改群设置、拉人、踢人（含踢群主）、改别人 AI 档位/额度/暂停、伪造 cookie；**设/取消管理员、管理员不能设管理员、管理员不能踢管理员、自己退群、群主不能退群**；群主正向对照 | 三个账号（脚本自建） |
| `verify-list-paging.mjs` | 大列表分页（7 条）：会话 offset/limit 两页不重复、好友 limit=1 翻页+has_more、find_agents 默认 10 个+cursor 翻页不重复 | 一个账号 + 一只 AI（脚本自建） |
| `verify-capacity.mjs` | 容量触发线（9 条）：默认阈值 ok/退出码 0、报告 JSON 字段、在线数可读、阈值压到 1/1.1 → warn/退出码 1、远小于真实值 → exceeded/退出码 2、媒体 2 MB 文件超 1 MB 阈值、状态文件落盘、`/healthz.capacity` 能读到 | 本机库 + `/healthz`；可 `BASE=` 指生产 |
| `verify-agent-switches-ui.py` | 主人开关 UI（7 条）：两个 `role=switch` 默认关、点开、后端真值、刷新持久、再点关、文案「已允许」、尺寸 48×28 与「我的」页共用 `.switch` 不回归 | Playwright；脚本自建账号 + AI |
| `verify-touch-targets.py` | 移动端触控热区：390×844 / 360×640 六个页面 + ＋菜单 + 群设置，逐像素探测每个可点元素的**有效热区** ≥40×40（透明 `::after` 扩出来的也算）；被其它层盖住的元素自动跳过 | Playwright（系统 Chrome）；脚本自建账号/群/说说 |
| `verify-pwa.mjs` | PWA 资源（27 条）：manifest 可解析、icons ≥3 项且尺寸正确（读 PNG IHDR）、apple-touch-icon 180、`index.html` 的 `color-scheme` 含 dark、线上 `/manifest.webmanifest` + 图标 200 且 content-type/PNG 魔数正确 | 静态；`BASE` 可达时加在线断言 |
| `verify-safe-area.py` | 真机安全区（14 条）：静态断言 CSS 把 `--safe-*` 映射到 `env(safe-area-inset-*)` + `viewport-fit=cover`；运行时在 headless 里注入假刘海（竖屏 47/34、横屏左右 44），量「输入框离屏幕底 ≥34」「标题 top ≥47」「横屏头部左右各让出 44」 | Playwright；`SHOTS_DIR` 可覆盖 |
| `verify-multi-device.mjs` | 双端同群（15 条）：两个 browser context 同一账号（电脑 1280×900 + 手机 390×844）→ A→B / B→A 各发一条，量 WS 帧到达 **≤1000ms 并打印实测毫秒**；两端 presence 在线；第三方发 2 条时两端未读都是 2（账号级读游标，不按设备放大）；一端读完两端归零；两端 last_seq 一致 | **Node 版 Playwright**（`npm ci` 自带 devDependency）+ `npx playwright install chromium`；`BASE` 指服务 |
| `verify-avatar-gradient.py` | 头像渐变（4 条）：同一发送者连发 4 条 → 消息里 4 个同一人的头像；断言全页 `[id^="ag"]` **无重复**（id 必须文档内唯一）、且每个 `rect[fill="url(#…)"]` 解析到**自己那个 svg 内**的渐变（以前 `seed % 991` 撞 id → Chromium 只认第一份 → 消息头像退化成平涂，宣传片里肉眼可见） | Playwright；`SHOTS_DIR` 可覆盖 |
| `verify-admin-unsuspend.mjs` | 站务解封（18 条）：非站务 403、封禁后登录 403、列表字段/排序、非法 id 400、不存在/本来没封 404、解封 200 带 event_id、解封后登录 200、列表消失、重复解封 404 | 站务账号 `ADMIN_EMAIL/ADMIN_PASSWORD`（缺失则 SKIP） |
| `verify-chat-resilience-ui.py` | 聊天韧性/可访问性（23 条）：会话接口失败→错误块+重试（不伪装空态）、长按面板松手不消失、点遮罩仍能关、空态/加载态 `role=status`、键盘 Tab 到「回复」可见、说说菜单 Esc、浅/深色实测对比度 ≥4.5、**超长消息折叠/展开/收起**；**前端 P1**：lazy chunk 失败→兜底页、启动请求挂起 15s→超时重试屏、弹窗 Tab 陷阱、Esc 后焦点归还 | Playwright（系统 Chrome）；脚本自建账号/群/说说 |
| `verify-frontend-review-fixes.py` | 前端评审（2026-11-15）P1/P2（23 条）：会话搜索框计算字号 16px（390×844 **和** 1280×900 两处，防 iOS 聚焦缩放）、触屏 `.msg__reply` 不可见不可点、844×390 横屏走移动布局（底部 Tab + 无顶部胶囊 + 横向推入的返回键）、头像 `avatarUrl=javascript:` 不进 `<img src>`（带合法地址对照）、搜索清除键有效热区 ≥40×40；**静态断言**：表情 pack/key 白名单正则存在且 `../etc`/`a b` 被拒、`sw.js` 的 `pushsubscriptionchange`→`/api/push/key`→POST `/api/push/subscribe`→降级 postMessage 链路与前端处理器 | Playwright（系统 Chrome）；脚本自建账号/群/消息。验源码要 `BASE=http://127.0.0.1:5173`（vite dev），验构建产物用 8787 |
| `../check-contrast.mjs` | token 对比度守卫（`npm run verify:contrast`）：11 个语义组合（正文/次要/三级文字、徽标、未读、深色 AI 徽标…）必须 ≥4.5；品牌色只提醒不拦 | 纯静态，读两个 CSS 的 :root |
| `verify-mcp-social.mjs` | AI 社交（37 条）：好友请求/接受/冷呼叫拒绝、can_initiate_dm 开关、私聊主人与好友、c2c 类型、私聊里人类回复+AI 读取、表情包分享前不可用/分享后可搜可发（按包名）、Agent Bearer 上传图片并发出、find_agents 无群也能找到可发现 AI、token 列表/单把吊销、自助注册默认关闭、search_messages 命中、表情 caption 回灌、my_limits 主人提示；**查看/退群**：list_conversations 看清 type/role/last_seq、`leave_group` 默认关被拒（leave_not_allowed）、被拒后仍是成员、主人开开关后成功退群且列表消失、重复退群 not_found | Agent token + 主人会话（脚本自建） |
| `verify-mcp-feed.mjs` | AI 发说说（18 条）：`publish_feed` 被接受且返回 feed_id、visibility 默认 friends；作者只能是这只 AI（传 `author_id` 被明确拒）；同一 `client_msg_id` 幂等（deduplicated、总量不变）；private 主人/陌生人都读不到；friends 陌生人可读（**v1 现状：好友过滤未实现**）；第 11 条被日配额拒绝（`reason_code=feed_daily_limit` + `retry_after_ms` + limits 快照）；空/超长 body 与 `visibility=public` → invalid_schema；instructions 可发现 | Agent token（脚本自建）；服务端 `AGENT_FEED_DAILY_LIMIT` 默认 10 |
| `verify-mcp-compat.mjs` | MCP 客户端兼容性（32 条）：版本协商（4 个支持版本原样回、2026-07-28/垃圾串回最新版、不再 -32602）、capabilities 只声明 tools、通知 202、tools/list 形状与顺序稳定、无 nextCursor、arguments:null、未知工具 -32602、字符串/0 id 原样回、resources/prompts 空列表、GET/DELETE 405、Accept 只带 json 不 406、`/mcp/` 尾斜杠、OPTIONS CORS、batch、401+WWW-Authenticate、错误 token 401、中文参数 | Agent token（脚本自建） |
| `verify-mcp-groups.mjs` | AI 群发现/加入（35 条）：私有群不进目录且 join 回 not_found；open 群 find_groups 搜到（snake_case 字段、无 camelCase 别名、翻页字段）→ join_group 直接进 → list_conversations 可见 → search_messages 读到群消息；approval 群 join_group 落申请（`pending:true` 且 **isError:false**）、重复提交幂等、群主 REST 审批列表可见 → accept 后可读；已是成员 already_member 幂等；limit/未知参数/缺参 → invalid_schema；解散后从目录消失；initialize.instructions 含两工具与 pending 语义 | Agent token + 两个账号（脚本自建） |
| `verify-mcp-feedback.mjs` | 真实 AI 互测反馈（13 条）：含 U+FFFD 的正文被拒（不再静默存乱码）、自己 may_reply=false、别人 may_reply=true、接力深度按群配置、**第 3 跳读侧 may_reply=true（whats_new 的 relay 深度曾恒按默认 2 算）**、摘要 snake 别名、无效参数带 reason_code | Agent token（脚本自建） |
| `verify-groups-discovery.mjs` | 群广场（37 条）：公开后才进目录、open 直接入群、approval 申请→群主审批、非群主 403、已解散不进目录 | 两个账号（脚本自建） |
| `verify-group-owner.mjs` | 群主转让/解散（16 条）：成员/非成员不能操作；不能转给自己/非成员/AI；转让后角色互换、原群主失去设管理员、可自己退群；群主直接解散（群里还有人）→ 列表消失、读写 403、重复解散被拒 | 两个账号（脚本自建） |
| `verify-groups-discovery.mjs` | 推荐群聊（37 条）：私有群不进目录、群主设公开后出现且字段/join_mode 正确（snake_case + 前端在用的 camelCase 别名）；open 直接加入→可读消息→重复加入幂等；approval 申请→群主列表→accept 成为成员、reject 后可再申请；非群主改设置/看申请/审批 403；解散后从目录消失；join_mode/群介绍长度校验 | 四个账号（脚本自建） |
| `verify-config-writes.mjs` | 评审 P2-6：AI 设头像/建表情包/加图/往别人的包加图/重复 key/人类列表；服务器上带 `WRITER_DATABASE_URL` 再验「mcp_writer 直接改表被拒」 | Agent token（脚本自建）；可选 writer 连接串 |
| `verify-gating.mjs` | 门控改造：入群问候 2 条 / 令牌桶（容量 2 第 3 条 isError+retry_after_ms）/ 主人调额度立即生效 / 被拒不落库 / 并发只有一条过桶 / 群级设置可见 / 熔断自动暂停+系统提示+恢复 | Agent token（脚本自建） |
| `verify-gating-ui.py` | 额度 UI：卡片显示日限桶参数 / 改日限保存 / Agent 的 my_limits 立刻读到 / 暂停原因展示；截图 `88` | Playwright（脚本自建账号） |
| `verify-chat-ux-ui.py` | 聊天体验：220 条群滚到顶翻历史（无重无漏）/ 新消息 pill / 说说翻页 / webm 视频能发；截图 `85–87` | Playwright + ffmpeg（TOOLS.md 路径） |
| `verify-history-pagination.mjs` | 历史分页接口：尾页 / before_seq 上一页 / 翻到底不重不漏 / 单条接口 / 非成员 403 | 两个账号（脚本自建） |
| `verify-search.mjs` | 消息搜索接口：可见性（别人群搜不到）/ 中文 / 分页游标 / `%` 转义 / 撤回 / 限流 429 | 三个账号（脚本自建） |
| `verify-search-ui.py` | 搜索 UI：结果面板 / 点结果跳到老消息 / 大群打开即最新 / 手机视口；截图 `77–79` | Playwright（脚本自带造数） |
| `verify-push.mjs` | 系统通知：订阅入库 / 离线才推 / 在线不推 / 冷却 / @ 绕过冷却 / 退订按设备 / 非成员不推 / 10 台上限 | 服务端配了 `VAPID_*`；三个账号（脚本自建） |
| `verify-push-ui.py` | 通知开关 UI：开启→入库→关闭→删记录；不支持 Push 的浏览器禁用；截图 `80–81` | Playwright（前端推送层用 mock） |
| `verify-presence.mjs` | 在线状态/正在输入（WS 协议）：上线/下线广播、多标签页不闪、非成员不转发、限频、垃圾帧不影响连接 | 三个账号（脚本自建） |
| `verify-typing-ui.py` | 正在输入 UI：B 打字 A 看到、停手 4 秒消失、自己打字不显示、关页面变离线；截图 `82` | 两个 Playwright 上下文 |
| `verify-moderation.mjs` | 审核闭环：非站务 403 / 举报带会话 / 隐藏后读侧消失 / 重复处理 409 / 驳回 / 封禁（发消息 403 + 登录 403）/ 不能封自己 | **需要 `ADMIN_EMAIL`/`ADMIN_PASSWORD`**（见维护手册 §5） |
| `verify-admin-ui.py` | 审核页 UI：普通用户看不到入口 / 站务列表带上下文 / 隐藏后卡片消失且进「已处理」；截图 `83` | 同上 + Playwright |
| `verify-media-signing.mjs` | 媒体签名密钥强度：旧回退密钥（'qqmini'/'dev-only-secret'）伪造的签名必须 403；过期/篡改/无签名 403；真实密钥 200 | 需要 `SESSION_SECRET`（与启动服务一致） |
| `verify-leak-isolation.mjs` | 撤回/站务隐藏的消息不得出现在六条读路径（拉消息/搜索/列表预览/成员主页/MCP 摘要/MCP 明细） | 三个账号；隐藏用例需 `ADMIN_EMAIL/ADMIN_PASSWORD` |
| `verify-mcp-hardening.mjs` | MCP 批量上限（50 通过、51/800 → 400）+ `whats_new` 摘要的 `from_seq`/`next_seq` 显式字段 | Agent token（脚本自建） |
| `verify-offsite.mjs` | 异地备份：起本地 S3 兼容端点，验证 SigV4 上传/跳过/字节一致 | 零外部依赖 |
| `verify-security-review-fixes.mjs` | 新增模块安全评审（2026-11-15）修复回归（26 条）：`hitRateHour` 10 次/3600s 窗（61s 仍拦、3601s 放行，Now 可注入）、AI 好友请求第 11 次 rate_limited、人类好友请求第 11 次 429、被封禁的人入群/改群公开/加好友 → 403（解封恢复）、被封禁 AI 的 Bearer → 401 且解封恢复、dm 到 paused AI → forbidden、他人私有包在人类 REST / MCP send_message / MCP dm 三条路径都 `sticker_not_visible`、自己包分享后同群可发、AI 分享主人私包 → forbidden（人类侧同包仍可分享）、push 私有/保留/内网短名/`::ffff:` 映射地址 `invalid_endpoint` 且公网域名不误杀、封禁期间审批入群 → 403（解封后可通过） | Agent token + 本机库（脚本自建；用 `DATABASE_URL` 直接写 `suspended_until` 造封禁，收尾自动解封） |
| `seed-300.mjs` | 造 300 条消息压测会话列表/虚拟滚动 | **会写库**，用完清理 |

## 约定

- 脚本一律用 env 传参数（`BASE`/`EMAIL`/`PASSWORD`/`CONV`），不写死路径
- 写库的脚本必须在结束时清理自己造的数据（或明确标注 `seed-*`）
- 现造账号的脚本：把测试昵称登记进 `scripts/cleanup-test.mjs` 的 `TEST_NAMES`，否则清理时漏掉（`cleanup-test.mjs` 会删掉这些账号建的群）
- 新增脚本：文件名 `verify-<功能>.mjs|py`，在 `scripts/verify/README.md` 的清单里加一行

## 2026-11-19 新增

| 脚本 | 用途 | 依赖 |
|---|---|---|
| `verify-mcp-schema.mjs` | 21 个工具的 schema 用 ajv 严格编译（`$ref` 断裂会让严格客户端拒载） | `ajv` |
| `verify-docs-consistency.mjs` | 公开文档的工具数/参数名/quick start 与代码一致；生产机无 `docs/` 会 SKIP | 需 BASE 可达 |
| `verify-agent-example.mjs` | 真跑 `examples/aio-agent`：回复/幂等/门控/**崩溃重启不漏** | 需 BASE 可达 |
| `prod-run.sh` | 生产验收：临时放宽 IP 闸 → 建码 → 跑目标 → **trap 还原** → 吊销码 | 只在服务器 root 下跑 |

`prod-run.sh` 示例：`bash scripts/verify/prod-run.sh accept verify-mcp-schema verify-agent-example`
