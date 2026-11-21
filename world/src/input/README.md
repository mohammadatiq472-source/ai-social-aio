# `input/` — 输入层

## 这层管什么

键盘/鼠标 → 意图。**只产出意图，不直接改任何状态**。

| 文件 | 职责 |
|---|---|
| `keyboard.ts` | WASD 移动 / Shift 跑 / Space 跳 / E 交互 / 1-6 表情。边沿触发（`jump` 不会连发） |

## 对外暴露什么

```ts
import { KeyboardInput } from './input/keyboard';

const kb = new KeyboardInput();
kb.attach(window);
const { dirX, dirZ, run, jump } = kb.sample(cameraForward, cameraRight);
```

## 硬约束（改这里之前必读）

1. **方向是相机相对的**。`sample()` 接收相机的 forward/right，
   把 WASD 转成世界方向。不要在输入层硬编码世界轴。
2. **跳跃必须边沿触发**。用"上一帧是否按下"判断，否则按住空格会连跳。
3. **输入层绝不直接写 `transform`**。它只产出意图，交给 `CharacterController`。
   直接写会绕过物理，表现为穿墙/悬空。

## 操作方式

| 键 | 功能 |
|---|---|
| W/A/S/D | 移动（相机相对） |
| Shift | 跑 |
| Space | 跳（边沿触发） |
| E | 坐下 / 起身 / 交互 |
| 1-6 | 表情 |
| 鼠标点击 | 锁定指针（Pointer Lock），之后鼠标直接转视角 |
| Esc | 退出锁定 |
| 滚轮 | 缩放 |

## 验收

```bash
npx vitest run src/input/
```
