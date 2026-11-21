# `demo/` — 演示与接线

## 这层管什么

把各层粘起来跑起来的"应用层"。**这里是唯一允许同时 import 多层的地方。**

| 文件 | 职责 |
|---|---|
| `agents-demo.ts` | `startAgentDemo({world, RAPIER, physics, room, count})`：创建 N 个 Agent 化身 |
| `wire-demo.ts` | 各层接线（实体表 ↔ 物理 ↔ 渲染） |
| `phase-schedule.ts` | 相位调度（每个角色的动画相位偏移） |

## ⚠️ 谁不该碰这里

- 这层是**应用层**，不是库。其他层不该 import 它（会造成循环依赖）。

## 硬约束（改这里之前必读）

1. **tick 顺序是契约**：`physics.step()` → `demo.tick()` → `world.tick()`。
   理由见 `src/physics/README.md` 第 2 条。

2. **Agent 默认 0 个**。`?agents=N` 才创建。理由：首屏只加载玩家一个角色，
   7 角色会让 drawCall 从 8 涨到 20、三角形从 6.2 万涨到 43 万。

3. **动画相位偏移是确定性的**（按 id 哈希，不是 `Math.random()`）。
   同一个 id 每次进房拿到同样的相位，截图/录片可复现。

## 验收

```bash
node tools/verify-agents-wiring.mjs
npx vitest run src/demo/
```
