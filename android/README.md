# AIO 安卓壳（WebView + 原生推送）

把自托管站点 <https://chat.example.com> 装进一个原生壳里，给**老机型 / 无 GMS / 无 Chrome** 的手机用。

- 不做 TWA（那要 Chrome + Play 服务），不接支付/应用商店。
- 壳本体无 androidx；唯一第三方依赖是 OkHttp（原生推送要 WebSocket，Android 没内置 WS 客户端）。
- **推送不走 FCM**：自建一条常驻 WebSocket 前台服务（见「原生推送」一节）。
- 包名 `cn.example.aio`，App 名 `AIO`，versionCode 2 / versionName 0.1.1，minSdk 24 / targetSdk 35。

## 目录

```
android/
├─ settings.gradle / build.gradle / gradle.properties   仅 AGP 8.7.3，无其它插件
├─ build.cmd / build.ps1  一键构建（自动设 JDK / SDK / Gradle 缓存，跑完把 APK 拷进 dist）
├─ local.properties        ← 本机 SDK 路径（gitignore）
├─ keystore.properties     ← release 签名口令（gitignore，绝不入库）
├─ aio-release.jks         ← release keystore（gitignore，丢了就不能覆盖升级）
├─ app/src/main/java/cn/example/aio/
│  ├─ MainActivity.java    壳：WebView、文件选择、下载、错误页、返回键、拉起推送服务
│  ├─ PushService.java     原生推送：WebSocket 前台服务 + 通知
│  └─ BootReceiver.java    开机 / 覆盖安装后拉起推送服务
├─ app/src/main/res/…      主题/颜色/图标（mipmap 由 web/public/icons 生成；通知小图标 drawable-*dpi/ic_stat_aio）
└─ dist/                   ← 构建产物拷贝（gitignore）
```

## 构建环境（本机已装）

| 组件 | 位置 |
| --- | --- |
| JDK 21 | `C:\Program Files\Eclipse Adoptium\jdk-21.0.12.101-hotspot` |
| Android SDK | `D:\Android\Sdk`（commandline-tools + platform-tools + platforms;android-35 + build-tools;35.0.0）|
| Gradle 8.9 | `D:\gradle\gradle-8.9` |
| Gradle 缓存 | `D:\gradle\home`（故意指到 D 盘，别把 C 盘塞满）|

`android/local.properties` 里 `sdk.dir=D:/Android/Sdk`；仓库里不放 SDK。

## 构建命令

最省事（自动设好 JDK / SDK / Gradle 缓存，构建完把 APK 拷进 `android/dist/` 并打印 sha256）：

```bat
android\build.cmd              :: debug + release
android\build.cmd -Task debug
android\build.cmd -Task lint
```

> 直接 `.\build.ps1` 在本机会被执行策略拦（RemoteSigned 对同步目录里的 .ps1 还要签名）。
> 要么用上面的 `build.cmd`，要么 `powershell -NoProfile -ExecutionPolicy Bypass -File android\build.ps1`。

等价的手工命令（PowerShell）：

```powershell
$env:JAVA_HOME      = "C:\Program Files\Eclipse Adoptium\jdk-21.0.12.101-hotspot"
$env:ANDROID_HOME   = "D:\Android\Sdk"
$env:GRADLE_USER_HOME = "D:\gradle\home"

# debug（未签名调试包，可直接装）
& D:\gradle\gradle-8.9\bin\gradle.bat -p android --console=plain assembleDebug

# release（用 keystore.properties 里的签名，AGP 自动签名）
& D:\gradle\gradle-8.9\bin\gradle.bat -p android --console=plain assembleRelease
```

产物：`android/app/build/outputs/apk/debug/app-debug.apk`、`android/app/build/outputs/apk/release/app-release.apk`；
交付用的副本在 `android/dist/`。

## 签名

- `keystore.properties`（gitignore）字段：`storeFile` / `storePassword` / `keyAlias` / `keyPassword`，别名 `aio`。
- **口令只存在这个文件里**，不要贴到聊天、日志、issue 里。
- **keystore 丢了就再也无法覆盖升级**（新签名的 APK 和新应用一样，用户只能卸载重装，聊天本地缓存会没）。
  请把 `aio-release.jks` + `keystore.properties` 一起离线备份。

验签：

```powershell
& D:\Android\Sdk\build-tools\35.0.0\apksigner.bat verify --print-certs android\dist\AIO-0.1.1-release.apk
```

## 壳里实现了什么（少一项手机上就不可用）

1. Cookie / DOM storage / Database 开启，`onPause` 里 `CookieManager.flush()`——否则进程被杀后每次都要重新登录；
2. 文件选择：`WebChromeClient.onShowFileChooser` + `startActivityForResult`（`ACTION_GET_CONTENT`，兼容旧 API），支持多选与 `accept` 类型；
3. 录音/拍照：`onPermissionRequest` 授权 + CAMERA / RECORD_AUDIO 运行时权限，`setMediaPlaybackRequiresUserGesture(false)`（语音、视频能直接播）；
4. 返回键：WebView 能后退就 `goBack`，否则退出；
5. 站外链接（非 `chat.example.com` 及其子域）交给系统浏览器，壳内不丢登录态；
6. 下载：`DownloadListener` → `DownloadManager`，并把 WebView 的 Cookie 一起带给下载器（附件在登录态后面）；
   Android 9 及以下先申请 `WRITE_EXTERNAL_STORAGE`；`blob:`/`data:` 提示长按保存；
7. 主框架加载失败/证书错误：内联错误页 + 「重试」，不白屏；
8. 安全：`allowFileAccess` / `allowContentAccess` / `allowFileAccessFromFileURLs` 全关，
   mixed content 永不加载，SSL 错误一律 `handler.cancel()`（不提供「继续访问」）；
9. 主题 `Theme.Material.*.NoActionBar`（无 androidx），暗色跟随系统；Android 15 强制 edge-to-edge，
   自己吃 window insets，页面不会被状态栏/键盘压住。

## 原生推送（0.1.1 新增）

WebView 里的 Web Push 在这类机器上不可用（要么没有 Chrome/Play 服务，要么用户根本没装成 PWA），
所以推送自己实现：**App 侧挂一条常驻 WebSocket 前台服务**，服务端已有的 `/ws` 直接复用。

### 怎么工作

1. `MainActivity.onPageFinished` 发现 WebView 里已经有 `sid` cookie（登录态）→ 申请 `POST_NOTIFICATIONS`（Android 13+）→ `startForegroundService(PushService)`；
   如果 cookie 里**没有** `sid`（用户登出）→ 顺手 `stopService`，避免退出登录后还继续收通知。
2. `PushService`：前台常驻通知「AIO 正在接收消息」（channel `service`，IMPORTANCE_LOW，不响不震）→
   先 `GET /api/me`（带 `Cookie: sid=…`）确认登录态并拿到自己的 `principalId`；**401 直接 `stopSelf()`**（会话已失效）。
3. 再连 `wss://chat.example.com/ws`，握手只带 `Cookie: sid=…`；服务端每 30s 发协议 ping，OkHttp 自动回 pong
   （客户端也 `pingInterval(30s)`，半开连接能更快被发现）。
4. `t=event` 且 `senderId != 自己` 且 **App 不在前台** → 发系统通知；前台时页面自己会渲染，不重复打扰。
   前台判定用 `MainActivity` 的 `onStart/onStop` 静态计数（`PushService` 在 OkHttp 线程上读 `volatile` 计数）。
5. 通知：channel `messages`（IMPORTANCE_HIGH），标题 `senderName`，正文 `body` 截断 80 字
   （**compact 帧的 `parts` 是空的但 `body` 还在，所以只读 body**），按 `conversationId` `setGroup` 归组，
   点击 `PendingIntent` 回首页（v1 不做会话深链），`autoCancel`。
6. 断线重连：指数退避 2s → 60s；`ConnectivityManager.registerDefaultNetworkCallback` 网络恢复立即重试；
   `START_STICKY` + `stopWithTask=false`，被系统杀掉后会自己回来。
7. 收到 `close(4401)` / 握手 401 → `stopSelf()`（重连也会被踢，没必要拖）；`onDestroy` 里 `stopForeground`。

### 为什么前台服务类型写 `remoteMessaging|dataSync`

- Android 14+ 用 `remoteMessaging`：它是消息类专用类型，**不受 Android 15 对 `dataSync` 的 6h/24h 超时限制**。
- API 29~33 的系统**不认识** `remoteMessaging` 这个枚举，`startForeground(id, n, type)` 的类型校验会拒绝；
  所以清单里同时声明 `dataSync`，29~33 上退用它（运行期分支见 `PushService.startForegroundCompat()`）。
- 两条类型对应的权限都声明了（`FOREGROUND_SERVICE_REMOTE_MESSAGING` / `FOREGROUND_SERVICE_DATA_SYNC`），
  侧载不需要额外审核；如果以后上 Google Play，`remoteMessaging` 需要说明用途，`dataSync` 的 6h 限制也要处理。

### 限制（务必让用户知道）

- **必须留着常驻通知**：Android 8+ 前台服务的硬要求，通知栏会一直有「AIO 正在接收消息」，不能关掉这条 channel 而不影响服务可见性。
- **国产 ROM 可能杀后台**：小米/华为/OPPO/vivo 等需要在「自启动管理」「后台运行」「省电策略」里把 AIO 设为允许/无限制；
  否则服务会被清理，表现就是「App 关掉一会儿就收不到消息」。
- **Doze 下网络可能被掐**：没申请忽略电池优化（按需求不做），息屏深度休眠时 WebSocket 可能断，
  重连会在网络恢复/唤醒后进行，消息通知因此可能延迟。
- 无 FCM、无 GMS 依赖；也不做应用商店上架。
- 通知权限被拒绝时服务照常跑（WebView 里还能看到消息），只是不弹通知。
- 服务只在**有登录态**时运行：登出后页面一加载就会把服务停掉；会话过期（401 / 4401）也会自己退出。

### 如何关闭推送

- 只想安静：系统设置 → 应用 → AIO → 通知 → 关掉「新消息」channel（常驻通知还在，但不响不弹）。
- 完全停掉：系统设置 → 应用 → AIO → 强行停止（下次打开 App 会重新拉起），或卸载。
- 想省电又保留：设置 → 应用 → AIO → 电池 → 选「不受限制/允许后台活动」。

## Manifest 权限

| 权限 | 用途 |
| --- | --- |
| `INTERNET` | 必须 |
| `ACCESS_NETWORK_STATE` | 断网判断 |
| `CAMERA` | 拍照/录像（运行时申请，`required=false`）|
| `RECORD_AUDIO` | 语音消息（运行时申请，`required=false`）|
| `MODIFY_AUDIO_SETTINGS` | 语音播放/录音音频路由 |
| `WRITE_EXTERNAL_STORAGE`（`maxSdkVersion=28`）| 仅 Android 9 及以下下载落盘 |
| `POST_NOTIFICATIONS` | Android 13+ 弹通知要运行时授权（拒绝则只不弹通知）|
| `FOREGROUND_SERVICE` | 常驻 WebSocket 前台服务 |
| `FOREGROUND_SERVICE_REMOTE_MESSAGING` | Android 14+ 的 `remoteMessaging` 前台服务类型 |
| `FOREGROUND_SERVICE_DATA_SYNC` | 仅 API 29~33 用它顶替（那些系统不认识 `remoteMessaging`）|
| `RECEIVE_BOOT_COMPLETED` | 开机 / 覆盖安装后把推送服务拉起来 |

## 首装提醒

APK 不是从应用商店装的，手机第一次会拦：设置里打开「允许本次安装/未知来源」再装。
debug 包和 release 包同包名（没有 applicationIdSuffix），所以装过 debug 的可以直接覆盖成 release。

## 已知边界

- **没有真机/模拟器验证过**（本机无 adb 设备）。首次真机安装时重点看：文件选择、录音、下载、返回键、暗色，
  以及推送的这四项——① 通知权限弹窗与通知是否出现 ② App 退后台/划掉后是否还能收到 ③ 杀后台后是否被 ROM 清理
  ④ 开机后服务是否被拉起。
- 推送的「送达」只做了静态/编译层验证（APK 里有 `PushService`/`BootReceiver`、清单类型与权限正确、`wss://…/ws` 与 `/api/me` 在 dex 里），
  **没有实机跑过 WebSocket 连接与通知**，上面限制里的 ROM 行为都是经验判断。
- 站点的 PWA Service Worker 在 WebView 里同样生效；但壳未实现离线首屏，断网时是错误页而不是缓存页。
- 壳 `User-Agent` 追加了 `AIOApp/0.1.1`，服务端可据此区分「壳」与浏览器（目前服务端未使用）。
- 通知只按 `conversationId` 归组，没有做「同一会话合并成一条摘要」，也没有未读数角标（`setNumber` 未用）。
