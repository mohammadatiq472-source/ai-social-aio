# 音效素材来源与许可

全部素材来自 [Freesound](https://freesound.org/)，许可证均为 **Creative Commons 0（CC0，公共领域）**，
可商用、无需署名。下表仍保留出处，便于追溯与二次替换。

| 文件 | 用途 | Freesound | 原始标题 / 上传者 | 下载量 / 评分 | 许可 |
| --- | --- | --- | --- | --- | --- |
| `recv.mp3` | 收到消息 | [fs:588718](https://freesound.org/s/588718/) | Elevator Ding / collierhs_colinlib | ↓3301 ★4.8(39) | CC0 |
| `send.mp3` | 发送成功 | [fs:171697](https://freesound.org/s/171697/) | Menu Selection Click / NenadSimic | ↓22080 ★4.8(170) | CC0 |
| `mention.mp3` | 被 @ 提醒 | [fs:624598](https://freesound.org/s/624598/) | High-Pitched Two-Note Notification / eqylizer | ↓2823 ★4.7(43) | CC0 |
| `error.mp3` | 发送失败 | [fs:249300](https://freesound.org/s/249300/) | Access Denied / suntemple | ↓9056 ★4.7(103) | CC0 |

## 处理流程

原始文件（Freesound 高质量预览，mp3）→ 解码为单声道 44.1kHz →
`silenceremove` 等效的首尾静音裁剪（5ms RMS 窗、-55dB 门限、留 10ms 前导 / 30ms 尾巴）→
按时长上限硬截 + 12%（20–60ms）淡出防止截断爆音 →
EBU R128 积分响度归一化到 -16 LUFS（峰值上限 -1.5 dBFS，`send` 单独压到 -6 dBFS 峰值）→
libmp3lame 96kbps 单声道。

最终参数（ffprobe）：

| 文件 | 时长 | 码率 | 大小 | 积分响度 | 峰值 |
| --- | --- | --- | --- | --- | --- |
| `recv.mp3` | 0.60s | 96 kb/s | 7.2 KB | -16.0 LUFS | -6.8 dBFS |
| `send.mp3` | 0.13s | 96 kb/s | 1.6 KB | -27.4 LUFS | -6.1 dBFS |
| `mention.mp3` | 0.89s | 96 kb/s | 10.7 KB | -17.9 LUFS | -2.0 dBFS |
| `error.mp3` | 0.26s | 96 kb/s | 3.1 KB | -16.0 LUFS | -2.1 dBFS |

> `send` 是一条 95ms 的点击声（峰值因数约 21dB），硬拉到 -16 LUFS 峰值会超过 0 dBFS，
> 所以它按峰值 -6 dBFS 定格——它本来就是整套里最轻的一档。
> `mention` 是双音 + 长衰减，峰值已顶到 -1.5 dBFS 上限，-17.9 LUFS 是它不失真的最大响度。
