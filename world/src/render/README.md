# `render/` — 渲染层

## 这层管什么

把 `World` 的数据画出来。**只读数据，不写数据**（位置由物理决定，这里只同步）。

| 文件 | 职责 |
|---|---|
| `scene.ts` | `WorldRenderer`：场景 + 渲染器 + 光照装配 + resize + 渲染循环 |
| `env.ts` | 房间视觉：几何合并 / 程序化贴图 / 假 AO / 接触阴影 / 网格线 |
| `camera.ts` | `ThirdPersonCamera`：球坐标环绕 + 弹簧跟随 + 焦点缓动 + **避障** |
| `avatar.ts` | `AvatarAnimator`：动画状态机 + crossfade + 一次性动作 |
| `agent-avatars.ts` | 多个 Agent 化身的批量管理 |
| `lighting.ts` | 时间/天气预设（白天/黄昏/夜晚/暴雨）+ 平滑过渡 |
| `rain.ts` | 雨系统（GPU 位移的 Points，一次 drawCall） |
| `hud.ts` | 血条/名牌 |
| `debug.ts` | 调试面板（`?debug=1`，生产构建已 tree-shake） |

## 对外暴露什么

```ts
import { WorldRenderer } from './render/scene';
import { ThirdPersonCamera, FACE_CAM } from './render/camera';
import { AvatarAnimator } from './render/avatar';
import { LIGHTING_PRESETS, resolvePresetKey } from './render/lighting';
```

## ⚠️ 谁不该碰这里

- **不要在这里写 `actor.transform`**。位置唯一来源是物理层，写这里会与物理打架。
- 动画只影响骨骼，不影响 `root.position`。

## 硬约束（改这里之前必读）

1. **`MODEL_FACING_OFFSET_Y` 与 `FACE_CAM.yaw` 必须一起改**。
   它们互相抵消，只改一个会让"特写看着对、走起来倒退"（实测踩过两次）。
   验证时必须**同时验"脸朝哪"和"走的方向"**，只验一个必然错。
2. **`clipAction()` 返回的 action 默认 `weight=1`**。建完必须立刻 `setEffectiveWeight(0)`，
   否则多个动画叠加抵消，表现为"角色完全不动"（实测踩过）。
3. **一次性动作不能只靠 mixer 'finished' 事件清除**。
   那个事件在被 crossFade 打断时不触发，会让状态永久卡死。
   必须同时有**时长兜底**（见 `avatar.ts` 的 `oneShotMaxDuration`）。
4. **PBR 没有 IBL 会渲染成灰黑塑料块**。`scene.environment` 必须设
   （用 `RoomEnvironment`，three 自带，无需下载 HDR）。
5. **`dispose()` 只 traverse `Mesh`**。`Points` / `LineSegments` / `InstancedMesh`
   必须单独 dispose，否则泄漏（实测踩过）。
6. **首屏预算 3 MB（brotli）**。改资产或加依赖后必须跑 `node tools/verify-perf.mjs`。

## 验收

```bash
node tools/verify-scene.mjs        # 17/17
node tools/verify-lighting.mjs     # 6/6（四预设亮度/暖度断言）
node tools/verify-camera-boom.mjs  # 4/4（射线能发现墙）
node tools/verify-jump-recovery.mjs # 5/5（跳完动画能恢复）
node tools/verify-perf.mjs         # 首屏预算
```

## 调试接口（`__worldDebug`，dev only）

排查"画面不对"时优先用这些，不要靠猜：

| 方法 | 用途 |
|---|---|
| `read()` | fps / drawCalls / triangles / camera |
| `cameraPosition()` | 相机**实际**世界坐标（避障验收用，不能用 `distance` 代替） |
| `boomFraction()` | 避障可见比例（1 = 无遮挡） |
| `raycast(from, to)` | 直接测物理射线 |
| `physState()` | 物理控制器内部 anim/grounded/vy |
| `animChain()` | **四层 anim 来源**：actor / phys / fromPhysics / animator |
| `oneShotState()` | animator 内部一次性动作状态 |
| `heroPlayingClips()` | 实际在播的 clip（权重 > 0） |
| `setTime()` / `setTimeImmediate()` | 切光照预设 |
| `setYaw()` / `setDistance()` | 相机绝对设置（`orbit()` 会累积误差，别用它设绝对值） |
