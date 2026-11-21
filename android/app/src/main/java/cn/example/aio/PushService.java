package cn.example.aio;

import android.Manifest;
import android.app.Notification;
import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.app.PendingIntent;
import android.app.Service;
import android.content.Context;
import android.content.Intent;
import android.content.pm.PackageManager;
import android.content.pm.ServiceInfo;
import android.graphics.BitmapFactory;
import android.net.ConnectivityManager;
import android.net.Network;
import android.os.Build;
import android.os.Handler;
import android.os.IBinder;
import android.os.Looper;
import android.util.Log;
import android.webkit.CookieManager;

import org.json.JSONObject;

import java.io.IOException;
import java.util.Locale;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.AtomicInteger;

import okhttp3.Call;
import okhttp3.Callback;
import okhttp3.OkHttpClient;
import okhttp3.Request;
import okhttp3.Response;
import okhttp3.ResponseBody;
import okhttp3.WebSocket;
import okhttp3.WebSocketListener;

/**
 * 原生推送：一条常驻的 WebSocket 前台服务，不依赖 FCM / Google Play 服务。
 *
 * 为什么不用 FCM：目标是老机型 / 无 GMS / 国产 ROM，FCM 在这类机器上基本不可用。
 * 代价是必须挂一个常驻通知（Android 8+ 前台服务的硬要求），并且后台被 ROM 杀就需要
 * 用户手动开「自启动 / 允许后台运行」——见 android/README.md。
 *
 * 服务端约定（src/ws/hub.mjs）：
 * - 握手鉴权只读 Cookie: sid=...，未授权直接 close(4401)；
 * - 每 30s 发协议 ping，连着 2 个周期没 pong 就 terminate（OkHttp 自动回 pong）；
 * - 新消息帧 {t:'event', conversationId, senderId, senderName, body, ...}，>8KB 时 compact:true 且 parts 为空，
 *   但 body 仍在，所以通知正文只读 body，不碰 parts。
 */
public class PushService extends Service {

    private static final String TAG = "AIOPush";

    static final String BASE_URL = "https://chat.example.com";
    static final String WS_URL = "wss://chat.example.com/ws";

    private static final String CHANNEL_SERVICE = "service";
    private static final String CHANNEL_MESSAGES = "messages";
    private static final int NOTIFICATION_SERVICE_ID = 1001;

    private static final long BACKOFF_MIN_MS = 2_000L;
    private static final long BACKOFF_MAX_MS = 60_000L;
    private static final int WS_UNAUTHORIZED = 4401;
    private static final int MAX_PREVIEW_CHARS = 80;

    private final Handler main = new Handler(Looper.getMainLooper());
    private final AtomicInteger messageSeq = new AtomicInteger(1);

    private OkHttpClient http;
    private WebSocket socket;
    private String sid;
    /** 自己的 principalId（/api/me 的 id）；用字符串比较，帧里的 senderId 可能是 number 也可能是 string */
    private String myPrincipalId;
    private long backoffMs = BACKOFF_MIN_MS;
    private boolean connecting;
    private boolean stopped;
    private ConnectivityManager.NetworkCallback networkCallback;

    // ------------------------------------------------------------------ 生命周期

    @Override
    public void onCreate() {
        super.onCreate();
        createChannels();
        http = new OkHttpClient.Builder()
                .connectTimeout(15, TimeUnit.SECONDS)
                // WebSocket 读永远不超时；靠 pingInterval 发现半开连接
                .readTimeout(0, TimeUnit.MILLISECONDS)
                .writeTimeout(15, TimeUnit.SECONDS)
                // 服务端每 30s ping 一次；客户端也 ping，半开连接能更快被判定
                .pingInterval(30, TimeUnit.SECONDS)
                .retryOnConnectionFailure(true)
                .build();
    }

    @Override
    public int onStartCommand(Intent intent, int flags, int startId) {
        // 前台服务必须尽快进入前台态，先举牌（常驻通知）再联网。
        // startForeground 在 Android 12+ 可能抛 ForegroundServiceStartNotAllowedException
        // （从后台被拉起时），这里必须兜住，否则就是服务进程崩溃 + 系统无限重启。
        try {
            startForegroundCompat();
        } catch (Exception e) {
            Log.w(TAG, "startForeground failed, giving up", e);
            stopSelfAndRelease();
            return START_NOT_STICKY;
        }
        stopped = false;
        registerNetworkCallback();
        startWorker();
        return START_STICKY;
    }

    @Override
    public IBinder onBind(Intent intent) {
        return null;
    }

    @Override
    public void onDestroy() {
        stopped = true;
        main.removeCallbacks(reconnectTask);
        unregisterNetworkCallback();
        WebSocket ws = socket;
        socket = null;
        if (ws != null) {
            try {
                ws.close(1000, "service destroyed");
            } catch (Exception ignored) {
                // 连接已经断了，无所谓
            }
        }
        if (http != null) {
            try {
                http.dispatcher().executorService().shutdown();
                http.connectionPool().evictAll();
            } catch (Exception ignored) {
                // 关闭期的异常不影响退出
            }
        }
        stopForegroundCompat();
        super.onDestroy();
    }

    // ------------------------------------------------------------------ 对外小工具

    /** MainActivity / BootReceiver 用：有会话 cookie 才值得起服务 */
    static boolean hasSessionCookie() {
        try {
            CookieManager manager = CookieManager.getInstance();
            manager.flush();
            String cookie = manager.getCookie(BASE_URL);
            return cookie != null && cookie.contains("sid=");
        } catch (Exception e) {
            Log.w(TAG, "read cookie failed", e);
            return false;
        }
    }

    static void start(Context context) {
        Intent intent = new Intent(context, PushService.class);
        if (Build.VERSION.SDK_INT >= 26) {
            context.startForegroundService(intent);
        } else {
            context.startService(intent);
        }
    }

    static void stop(Context context) {
        context.stopService(new Intent(context, PushService.class));
    }

    // ------------------------------------------------------------------ 连接流程

    private void startWorker() {
        if (stopped || connecting || socket != null) {
            return;
        }
        connecting = true;
        sid = readSid();
        if (sid == null) {
            // 没登录就没有推送可做；直接退出，别留一个空转的前台服务
            connecting = false;
            Log.i(TAG, "no sid cookie, stopping");
            stopSelfAndRelease();
            return;
        }
        fetchMe();
    }

    private String readSid() {
        try {
            CookieManager manager = CookieManager.getInstance();
            // 不 flush 的话 WebView 可能还没把 cookie 落盘/同步
            manager.flush();
            String cookie = manager.getCookie(BASE_URL);
            if (cookie == null) {
                return null;
            }
            for (String part : cookie.split(";")) {
                String item = part.trim();
                if (item.startsWith("sid=")) {
                    String value = item.substring(4);
                    return value.isEmpty() ? null : value;
                }
            }
        } catch (Exception e) {
            Log.w(TAG, "read sid failed", e);
        }
        return null;
    }

    private Request.Builder authorized(String url) {
        return new Request.Builder()
                .url(url)
                .header("Cookie", "sid=" + sid)
                .header("User-Agent", "AIOApp/" + BuildConfig.VERSION_NAME)
                .header("Accept", "application/json");
    }

    /** 先确认登录态还活着：401 说明会话已失效（用户登出/过期），服务该退出 */
    private void fetchMe() {
        http.newCall(authorized(BASE_URL + "/api/me").get().build()).enqueue(new Callback() {
            @Override
            public void onFailure(Call call, IOException e) {
                connecting = false;
                scheduleReconnect("me request failed: " + e.getClass().getSimpleName());
            }

            @Override
            public void onResponse(Call call, Response response) {
                try (ResponseBody body = response.body()) {
                    if (response.code() == 401) {
                        connecting = false;
                        Log.i(TAG, "session unauthorized (401), stopping");
                        stopSelfAndRelease();
                        return;
                    }
                    if (!response.isSuccessful() || body == null) {
                        connecting = false;
                        scheduleReconnect("me http " + response.code());
                        return;
                    }
                    JSONObject me = new JSONObject(body.string());
                    Object id = me.opt("id");
                    myPrincipalId = id == null ? null : String.valueOf(id);
                    connectWebSocket();
                } catch (Exception e) {
                    connecting = false;
                    scheduleReconnect("me parse failed: " + e.getClass().getSimpleName());
                }
            }
        });
    }

    private void connectWebSocket() {
        if (stopped) {
            connecting = false;
            return;
        }
        Request request = authorized(WS_URL).build();
        socket = http.newWebSocket(request, new SocketListener());
    }

    private final class SocketListener extends WebSocketListener {
        @Override
        public void onOpen(WebSocket webSocket, Response response) {
            connecting = false;
            backoffMs = BACKOFF_MIN_MS;
            Log.i(TAG, "ws open");
        }

        @Override
        public void onMessage(WebSocket webSocket, String text) {
            handleFrame(text);
        }

        @Override
        public void onClosing(WebSocket webSocket, int code, String reason) {
            webSocket.close(1000, null);
        }

        @Override
        public void onClosed(WebSocket webSocket, int code, String reason) {
            socket = null;
            connecting = false;
            if (stopped) {
                return;
            }
            if (code == WS_UNAUTHORIZED || "unauthorized".equals(reason)) {
                // 会话失效：重连只会被立刻踢掉，直接收摊
                Log.i(TAG, "ws unauthorized (4401), stopping");
                stopSelfAndRelease();
                return;
            }
            scheduleReconnect("ws closed " + code);
        }

        @Override
        public void onFailure(WebSocket webSocket, Throwable t, Response response) {
            socket = null;
            connecting = false;
            if (stopped) {
                return;
            }
            int code = response == null ? 0 : response.code();
            if (code == 401) {
                Log.i(TAG, "ws handshake 401, stopping");
                stopSelfAndRelease();
                return;
            }
            scheduleReconnect("ws failure " + t.getClass().getSimpleName());
        }
    }

    // ------------------------------------------------------------------ 收帧

    private void handleFrame(String text) {
        if (text == null || text.isEmpty()) {
            return;
        }
        try {
            JSONObject frame = new JSONObject(text);
            String type = frame.optString("t", "");
            if ("hello".equals(type)) {
                // 服务端 hello 里也带 me.id，作为 /api/me 的兜底
                JSONObject me = frame.optJSONObject("me");
                if (me != null) {
                    Object id = me.opt("id");
                    if (id != null) {
                        myPrincipalId = String.valueOf(id);
                    }
                }
                return;
            }
            if (!"event".equals(type)) {
                return; // read / presence / typing / pong 一律忽略
            }
            String senderId = frame.optString("senderId", "");
            if (myPrincipalId != null && myPrincipalId.equals(senderId)) {
                return; // 自己发的不提醒
            }
            if (MainActivity.isAppInForeground()) {
                return; // App 在前台：页面自己会渲染，不重复弹通知
            }
            String senderName = frame.optString("senderName", "");
            if (senderName.isEmpty()) {
                senderName = getString(R.string.push_fallback_sender);
            }
            // compact 帧的 parts 是空的，但 body 还在——通知只依赖 body
            String body = frame.optString("body", "");
            if (body.trim().isEmpty()) {
                body = getString(R.string.push_fallback_body);
            }
            String conversationId = frame.optString("conversationId", "");
            postMessageNotification(conversationId, senderName, body);
        } catch (Exception e) {
            Log.w(TAG, "bad frame", e);
        }
    }

    // ------------------------------------------------------------------ 通知

    private void createChannels() {
        if (Build.VERSION.SDK_INT < 26) {
            return;
        }
        NotificationManager manager = (NotificationManager) getSystemService(Context.NOTIFICATION_SERVICE);
        if (manager == null) {
            return;
        }
        NotificationChannel service = new NotificationChannel(
                CHANNEL_SERVICE,
                getString(R.string.push_service_channel),
                NotificationManager.IMPORTANCE_LOW);
        service.setDescription(getString(R.string.push_service_channel_desc));
        service.setShowBadge(false);
        service.setSound(null, null);
        service.enableVibration(false);

        NotificationChannel messages = new NotificationChannel(
                CHANNEL_MESSAGES,
                getString(R.string.push_messages_channel),
                NotificationManager.IMPORTANCE_HIGH);
        messages.setDescription(getString(R.string.push_messages_channel_desc));

        manager.createNotificationChannel(service);
        manager.createNotificationChannel(messages);
    }

    private Notification.Builder builder(String channelId) {
        if (Build.VERSION.SDK_INT >= 26) {
            return new Notification.Builder(this, channelId);
        }
        return new Notification.Builder(this);
    }

    private PendingIntent openAppIntent(int requestCode) {
        Intent intent = new Intent(this, MainActivity.class)
                .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK | Intent.FLAG_ACTIVITY_CLEAR_TOP);
        int flags = PendingIntent.FLAG_UPDATE_CURRENT | PendingIntent.FLAG_IMMUTABLE;
        return PendingIntent.getActivity(this, requestCode, intent, flags);
    }

    private Notification buildServiceNotification() {
        Notification.Builder b = builder(CHANNEL_SERVICE);
        b.setSmallIcon(R.drawable.ic_stat_aio)
                .setContentTitle(getString(R.string.push_service_title))
                .setContentText(getString(R.string.push_service_text))
                .setContentIntent(openAppIntent(0))
                .setOngoing(true)
                .setShowWhen(false)
                .setPriority(Notification.PRIORITY_LOW);
        return b.build();
    }

    private void startForegroundCompat() {
        Notification notification = buildServiceNotification();
        if (Build.VERSION.SDK_INT >= 34) {
            startForeground(NOTIFICATION_SERVICE_ID, notification,
                    ServiceInfo.FOREGROUND_SERVICE_TYPE_REMOTE_MESSAGING);
        } else if (Build.VERSION.SDK_INT >= 29) {
            // Android 10~13 不认识 remoteMessaging，用清单里同时声明的 dataSync 才能通过类型校验
            startForeground(NOTIFICATION_SERVICE_ID, notification,
                    ServiceInfo.FOREGROUND_SERVICE_TYPE_DATA_SYNC);
        } else {
            startForeground(NOTIFICATION_SERVICE_ID, notification);
        }
    }

    private void stopForegroundCompat() {
        try {
            stopForeground(STOP_FOREGROUND_REMOVE);
        } catch (Exception ignored) {
            // 已经不在前台态
        }
    }

    private void postMessageNotification(String conversationId, String senderName, String body) {
        NotificationManager manager = (NotificationManager) getSystemService(Context.NOTIFICATION_SERVICE);
        if (manager == null) {
            return;
        }
        if (Build.VERSION.SDK_INT >= 33
                && checkSelfPermission(Manifest.permission.POST_NOTIFICATIONS) != PackageManager.PERMISSION_GRANTED) {
            // 用户没给通知权限：服务照常跑（WebView 里还能看到），但这里不弹
            Log.i(TAG, "POST_NOTIFICATIONS not granted, skip notification");
            return;
        }
        String preview = body.length() > MAX_PREVIEW_CHARS
                ? body.substring(0, MAX_PREVIEW_CHARS) + "…"
                : body;

        Notification.Builder b = builder(CHANNEL_MESSAGES);
        b.setSmallIcon(R.drawable.ic_stat_aio)
                .setContentTitle(senderName)
                .setContentText(preview)
                .setStyle(new Notification.BigTextStyle().bigText(preview))
                .setLargeIcon(BitmapFactory.decodeResource(getResources(), R.mipmap.ic_launcher))
                .setContentIntent(openAppIntent(conversationId.hashCode()))
                .setAutoCancel(true)
                // 同一会话归一组，避免一个群刷屏式堆一列
                .setGroup("conv:" + conversationId)
                .setWhen(System.currentTimeMillis())
                .setShowWhen(true);
        if (Build.VERSION.SDK_INT < 26) {
            b.setPriority(Notification.PRIORITY_HIGH);
            b.setDefaults(Notification.DEFAULT_ALL);
        }
        try {
            manager.notify("conv:" + conversationId, messageSeq.incrementAndGet(), b.build());
        } catch (Exception e) {
            Log.w(TAG, "notify failed", e);
        }
    }

    // ------------------------------------------------------------------ 重连

    private final Runnable reconnectTask = new Runnable() {
        @Override
        public void run() {
            if (!stopped) {
                startWorker();
            }
        }
    };

    private void scheduleReconnect(String reason) {
        if (stopped) {
            return;
        }
        long delay = backoffMs;
        backoffMs = Math.min(backoffMs * 2, BACKOFF_MAX_MS);
        Log.i(TAG, String.format(Locale.ROOT, "reconnect in %dms (%s)", delay, reason));
        main.removeCallbacks(reconnectTask);
        main.postDelayed(reconnectTask, delay);
    }

    private void registerNetworkCallback() {
        if (networkCallback != null) {
            return;
        }
        ConnectivityManager manager = (ConnectivityManager) getSystemService(Context.CONNECTIVITY_SERVICE);
        if (manager == null) {
            return;
        }
        networkCallback = new ConnectivityManager.NetworkCallback() {
            @Override
            public void onAvailable(Network network) {
                if (stopped) {
                    return;
                }
                // 网络回来就立刻重试，别让用户等 60s 退避
                backoffMs = BACKOFF_MIN_MS;
                main.removeCallbacks(reconnectTask);
                main.post(reconnectTask);
            }
        };
        try {
            manager.registerDefaultNetworkCallback(networkCallback);
        } catch (Exception e) {
            Log.w(TAG, "register network callback failed", e);
            networkCallback = null;
        }
    }

    private void unregisterNetworkCallback() {
        if (networkCallback == null) {
            return;
        }
        ConnectivityManager manager = (ConnectivityManager) getSystemService(Context.CONNECTIVITY_SERVICE);
        if (manager != null) {
            try {
                manager.unregisterNetworkCallback(networkCallback);
            } catch (Exception ignored) {
                // 没注册成功或已注销
            }
        }
        networkCallback = null;
    }

    private void stopSelfAndRelease() {
        stopped = true;
        main.removeCallbacks(reconnectTask);
        unregisterNetworkCallback();
        WebSocket ws = socket;
        socket = null;
        if (ws != null) {
            try {
                ws.close(1000, "client stop");
            } catch (Exception ignored) {
                // 已经断了
            }
        }
        stopForegroundCompat();
        stopSelf();
    }
}
