# `core/` — 世界内核

## 这层管什么

世界的**数据结构与时间**，不含任何渲染/物理/网络实现。

| 文件 | 职责 |
|---|---|
| `types.ts` | **冻结协议**。`EntityId` / `Transform` / `ActorState` / `Intent` / `PHYSICS_DT`。所有层共享这一份类型 |
| `clock.ts` | 固定步长累加器。`advance()` / `runSteps()` / `alpha` / `overruns` |
| `world.ts` | 实体表 + tick 调度 + 事件总线。`spawn` / `updateActor` / `despawn` 是**唯一**的写入口 |
| `room.ts` | 房间 schema 校验 + `roomSolids()` / `roomPropSolids()`（渲染与物理读同一份） |

## 对外暴露什么

```ts
import { World, Clock, parseRoom } from './core';
import type { EntityId, Transform, ActorState, Intent } from './core';
```

## ⚠️ 谁不该碰这里

- **改 `types.ts` 需要所有人同意**。它是冻结协议，改字段会同时影响 physics / render / net / agents 四层。
- 不要在这里 import `three` 或 `@dimforge/rapier3d-compat`。这层必须能在 node 里裸跑（单测依赖这一点）。

## 硬约束（改这里之前必读）

1. **`updateActor()` 是唯一写入口**。直接改 `actor.transform` 不会发 `actor:update` 事件，
   渲染层不会更新，表现为"数据变了但画面不动"。
2. **`expireBubbles()` 必须在 `this.time += dt` 之后调**。顺序反了会有一步的偏差（实测踩过）。
3. **`roomSolids()` 的输出同时喂渲染和物理**。改它的语义会让两边不一致，
   表现为"看得见的墙撞不进去"或"撞得进去但看不见"。

## 测试

```bash
npx vitest run src/core/
```

覆盖：固定步长累加、超时丢弃、实体增删、房间 schema 校验、气泡过期。
