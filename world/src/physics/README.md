# `physics/` — 物理层

## 这层管什么

Rapier 3D 的封装。**不自研求解器**，自研的是"怎么用 Rapier"。

| 文件 | 职责 |
|---|---|
| `engine.ts` | `PhysicsWorld`：create / step / dispose / spawnProp / 对象池 / 射线查询 / 统计 |
| `character.ts` | `CharacterController`：胶囊 + `KinematicCharacterController`，跳跃、坡度、贴地 |
| `layers.ts` | 碰撞层矩阵（`SOLID` / `EVENTS` 双表）与 `interactionGroups` |
| `bake.ts` | 把房间静态几何烘焙成 Rapier collider |
| `pool.ts` | 道具对象池（动态刚体 + cuboid），热路径零 WASM 分配 |
| `debug-draw.ts` | 碰撞体线框（`?debug=1`） |

## 对外暴露什么

```ts
import { PhysicsWorld } from './physics/engine';
import { CharacterController, DEFAULT_CHARACTER } from './physics/character';
import { LAYERS, interactionGroups } from './physics/layers';
```

## ⚠️ 谁不该碰这里

- 渲染层**不该** import 这里的任何东西（除了读 `stats()` 做调试面板）。
- 想改角色手感 → 改 `DEFAULT_CHARACTER` 的常量，不要改 `update()` 的结构。

## 硬约束（改这里之前必读）

1. **固定步长 1/60，`MAX_CATCHUP_STEPS=3`，超出丢弃**。不要改成变步长——
   跳跃高度、坡度判定、CCD 全都依赖定步。
2. **`physics.step()` → `demo.tick()` → `world.tick()` 的顺序是契约，不能改**。
   `demo.tick()` 里的 `writeTransform` 读 `body.translation()`，那是**本步已结算**的位置。
   放 step 之前会读到上一步的位置，实体表永远慢一帧（实测滞后 0.0367m = 2.2m/s × 1/60）。
3. **跳跃初速含半步修正**：`JUMP_VELOCITY_ANALYTIC + g·dt/2`。
   去掉修正会让 P6 从 1.1999m 掉到 1.1588m（不达标）。
4. **重力累积必须看"上一帧 grounded"**。看当前帧会让 P1/P2 出现 10cm 误差。
5. **射线查询用 CHARACTER 身份**，不是 WORLD_STATIC。
   静态几何的 filter 里没有 WORLD_STATIC 位（它不和自己碰撞），
   用它当成员位会**永远打不到**（实测踩过）。
6. **`maxSlopeClimbAngle = 40°`**，不是规格书的 50°。规格书自身矛盾（P3 要求 45° 不可上），
   见 `docs/world/决策-斜坡角与P3冲突.md`。

## 验收

```bash
node tools/verify-physics.mjs      # P1–P12 全部通过
npx vitest run src/physics/
```

P1–P12 覆盖：站立稳定 / 走 / 30° 可上 / 45° 不可上 / 跳跃高度 / 落地 / 冲刺撞墙 /
道具推动 / 斜坡滑落 / 对象池 / 内存 / 调试绘制。

**这 12 条是全绿才算物理层没坏。改任何常量都要重跑。**
