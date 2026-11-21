# `interact/` — 交互层（M10）

## 这层管什么

玩家与世界的交互：坐下/起身、推箱子、点角色切焦点。

| 文件 | 职责 |
|---|---|
| `player.ts` | `PlayerController`：把键盘输入 + 座位状态 + 物理控制器粘起来，**唯一**写玩家 transform 的地方 |
| `scene.ts` | 座位标记、道具网格的渲染同步 |
| `bind.ts` | 键盘/鼠标事件绑定 |
| `probe.ts` | 验收探针（`__interactDebug`） |
| `index.ts` | 对外导出 |

## 对外暴露什么

```ts
import { PlayerController } from './interact/player';
```

## ⚠️ 谁不该碰这里

- **不要绕过 `PlayerController.step()` 直接调 `controller.update()`**。
  它内部做了"坐着时方向位清零、但仍然喂物理"的门控，
  跳过它会导致"坐着时角色失去贴地/坡度校正"。

## 硬约束（改这里之前必读）

1. **`teleport()` 必须同时设 `setTranslation` 与 `setNextKinematicTranslation`**。
   只设一个会让物理与实体表脱节，表现为"坐下瞬间弹回原地"（实测踩过）。
2. **坐下/起身的吸附在物理步里做，不在事件里做**。
   事件里做会让"坐着"状态与物理位置错开一帧。
3. **`CAPSULE_CENTER_HEIGHT = 0.85`**（= halfHeight 0.55 + radius 0.30）。
   座位高度换算依赖它，改胶囊尺寸必须同步改。
4. **`standFromSeatId` 要在清 `state.seatId` 之前存**。顺序反了会导致
   `step()` 里找不到座位、人原地站起来（实测踩过）。
5. **起身要吸附到座位前方**，不能原地起身 —— 否则人还在座位 1.2m 内，按 E 会立刻又坐下。

## 验收

```bash
node tools/verify-interact.mjs    # 17/17（需 dev server）
```

覆盖：E 坐下/起身 / 重复按 E / 推箱子 / 点角色切焦点 / 焦点缓动 / 座位高亮。
