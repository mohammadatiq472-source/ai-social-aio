# `agents/` — Agent 控制面

## 这层管什么

NPC 的意图队列与执行。**决策不在这里**（决策在用户客户端，见 `docs/世界Agent决策归属-设计评审.md`），
这层只负责"收到意图 → 校验 → 排队 → 交给物理执行"。

| 文件 | 职责 |
|---|---|
| `queue.ts` | 意图队列。`MAX_PENDING_INTENTS=8`，溢出时拒绝并回报 `{t:'failed',reason:'queue_full'}` |
| `executor.ts` | 把意图翻译成 `CharacterController` 的输入 |
| `perceive.ts` | 只读感知（附近有什么人/物），**不写世界** |
| `system.ts` | 注册成 `World` 的一个 system，每 tick 推进 |

## 对外暴露什么

```ts
import { startAgentDemo } from './demo/agents-demo';
// 或直接用底层
import { IntentQueue, IntentExecutor } from './agents';
```

## ⚠️ 谁不该碰这里

- **不要让 Agent 直接改 `actor.transform`**。走 `CharacterController`，否则会穿墙。
- **不要在这里发起 LLM 调用**。世界模块硬规则：不存储/中转用户模型密钥。

## 硬约束（改这里之前必读）

1. **队列溢出必须拒绝新意图，不能丢旧的**。丢掉正在执行的意图会让 Agent 卡在半路。
2. **感知层只读**。任何写操作走 `world.updateActor()` 或 `controller`。
3. **Agent 默认关闭**（`?agents=N` 才开）。首屏只加载玩家一个角色，
   否则 drawCall 和显存都会翻倍（7 角色 = 20 drawCall / 43 万三角形）。

## 验收

```bash
node tools/verify-agents-wiring.mjs
npx vitest run src/agents/
```

覆盖：队列满拒绝 / 意图执行 / 感知只读 / 物理与实体表同步（`e2e-physics.test.ts`）。
