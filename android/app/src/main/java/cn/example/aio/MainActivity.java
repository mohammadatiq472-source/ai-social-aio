package cn.example.aio;

import android.Manifest;
import android.app.Activity;
import android.app.DownloadManager;
import android.content.ActivityNotFoundException;
import android.content.Context;
import android.content.Intent;
import android.content.pm.PackageManager;
import android.content.res.Configuration;
import android.graphics.Insets;
import android.net.Uri;
import android.net.http.SslError;
import android.os.Build;
import android.os.Bundle;
import android.os.Environment;
import android.util.Log;
import android.view.View;
import android.view.ViewGroup;
import android.view.WindowInsets;
import android.view.WindowInsetsController;
import android.webkit.CookieManager;
import android.webkit.DownloadListener;
import android.webkit.PermissionRequest;
import android.webkit.SslErrorHandler;
import android.webkit.URLUtil;
import android.webkit.ValueCallback;
import android.webkit.WebChromeClient;
import android.webkit.WebResourceError;
import android.webkit.WebResourceRequest;
import android.webkit.WebSettings;
import android.webkit.WebView;
import android.webkit.WebViewClient;
import android.window.OnBackInvokedCallback;
import android.window.OnBackInvokedDispatcher;
import android.widget.Button;
import android.widget.TextView;
import android.widget.Toast;

import java.util.ArrayList;
import java.util.List;
import java.util.Locale;

/**
 * AIO 的安卓壳：唯一职责是用系统 WebView 打开自托管站点并保住登录态。
 *
 * 刻意不依赖 androidx / TWA / GMS：老机型、无 Chrome、无 Play 服务的设备也能装。
 * 下面 9 条是「缺一条手机上就不可用」的硬需求，改动时别回退：
 * 1) Cookie + DOM storage 持久化（onPause 里 flush，否则进程被杀会丢登录态）
 * 2) 文件选择（onShowFileChooser + startActivityForResult，兼容旧 API）
 * 3) 录音/拍照（运行时权限 + onPermissionRequest 授权）
 * 4) 返回键先 goBack
 * 5) 站外链接交给系统浏览器（不在壳里丢登录态）
 * 6) 下载走 DownloadManager（带 Cookie，附件才能下载）
 * 7) 主框架失败显示内联错误页 + 重试（不能白屏）
 * 8) 安全：file/content access 关闭、mixed content 拒绝、SSL 错误不忽略
 * 9) 暗色跟随系统
 */
public class MainActivity extends Activity {

    private static final String TAG = "AIO";

    /** 只有这个域（含子域）在壳内加载，其余一律外部浏览器 */
    private static final String SITE_HOST = "chat.example.com";
    private static final String START_URL = "https://chat.example.com/";

    private static final int REQ_FILE_CHOOSER = 1001;
    private static final int REQ_PERM_MEDIA = 1002;
    private static final int REQ_PERM_STORAGE = 1003;
    private static final int REQ_PERM_NOTIFICATIONS = 1004;

    /**
     * 前台计数：PushService 用它判断「用户此刻正看着 App」，前台时不再重复弹通知。
     * 用 volatile 是因为 PushService 在 OkHttp 线程上读它。
     */
    private static volatile int foregroundCount = 0;

    public static boolean isAppInForeground() {
        return foregroundCount > 0;
    }

    private WebView webView;
    private View errorPanel;
    private TextView errorDetail;

    private ValueCallback<Uri[]> fileChooserCallback;
    private PermissionRequest pendingPermissionRequest;

    /** Android 9 及以下：下载前要先拿到 WRITE_EXTERNAL_STORAGE，拿到后把这次下载补上 */
    private String pendingDownloadUrl;
    private String pendingDownloadUserAgent;
    private String pendingDownloadDisposition;
    private String pendingDownloadMime;

    private boolean errorShown;

    /** API 33+ 的返回入口（targetSdk 35 上预测返回默认开启，onBackPressed() 可能根本不被调用） */
    private Object backInvokedCallback;

    @Override
    protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);
        setContentView(R.layout.activity_main);

        CookieManager cookieManager = CookieManager.getInstance();
        cookieManager.setAcceptCookie(true);

        webView = findViewById(R.id.webview);
        errorPanel = findViewById(R.id.error_panel);
        errorDetail = findViewById(R.id.error_detail);
        Button retry = findViewById(R.id.error_retry);

        applySystemBars();
        configureWebView();

        retry.setOnClickListener(v -> {
            hideError();
            webView.reload();
        });

        if (savedInstanceState == null || webView.restoreState(savedInstanceState) == null) {
            webView.loadUrl(START_URL);
        }

        if (Build.VERSION.SDK_INT >= 33) {
            OnBackInvokedCallback callback = this::handleBack;
            backInvokedCallback = callback;
            getOnBackInvokedDispatcher().registerOnBackInvokedCallback(
                    OnBackInvokedDispatcher.PRIORITY_DEFAULT, callback);
        }
    }

    // ---------------------------------------------------------------- WebView

    private void configureWebView() {
        WebSettings s = webView.getSettings();
        s.setJavaScriptEnabled(true);
        // 登录态与本地缓存都在 DOM storage / Database 里，必须开
        s.setDomStorageEnabled(true);
        s.setDatabaseEnabled(true);
        s.setLoadWithOverviewMode(true);
        s.setUseWideViewPort(true);
        // 聊天应用不要双指缩放/缩放按钮，否则页面手势会和消息列表打架
        s.setSupportZoom(false);
        s.setBuiltInZoomControls(false);
        s.setDisplayZoomControls(false);
        s.setJavaScriptCanOpenWindowsAutomatically(false);
        // 语音消息、视频要能直接播（否则必须点一下才出声）
        s.setMediaPlaybackRequiresUserGesture(false);
        // 安全：https 页面里不许加载 http 资源
        s.setMixedContentMode(WebSettings.MIXED_CONTENT_NEVER_ALLOW);
        s.setAllowFileAccess(false);
        s.setAllowContentAccess(false);
        s.setAllowFileAccessFromFileURLs(false);
        s.setAllowUniversalAccessFromFileURLs(false);
        s.setGeolocationEnabled(false);
        s.setCacheMode(WebSettings.LOAD_DEFAULT);
        // 服务端/日志里能识别「这是壳」，将来做强制升级或埋点用
        s.setUserAgentString(s.getUserAgentString() + " AIOApp/" + BuildConfig.VERSION_NAME);

        if (Build.VERSION.SDK_INT >= 33) {
            // 站点自己有暗色主题（prefers-color-scheme），别再让 WebView 二次算法变暗
            s.setAlgorithmicDarkeningAllowed(false);
        } else if (Build.VERSION.SDK_INT >= 29) {
            s.setForceDark(WebSettings.FORCE_DARK_OFF);
        }

        webView.setBackgroundColor(getResources().getColor(R.color.window_bg, getTheme()));
        WebView.setWebContentsDebuggingEnabled(BuildConfig.DEBUG);

        webView.setWebViewClient(new WebViewClient() {
            @Override
            public boolean shouldOverrideUrlLoading(WebView view, WebResourceRequest request) {
                return shouldOpenExternally(request.getUrl());
            }

            @Override
            public void onPageStarted(WebView view, String url, android.graphics.Bitmap favicon) {
                super.onPageStarted(view, url, favicon);
                hideError();
            }

            @Override
            public void onPageFinished(WebView view, String url) {
                super.onPageFinished(view, url);
                // 页面加载完 = 登录态已确定：有 sid 就起推送服务，没有就停（登出后不该继续收消息）
                syncPushService();
            }

            @Override
            public void onReceivedError(WebView view, WebResourceRequest request, WebResourceError error) {
                if (request == null || !request.isForMainFrame()) {
                    return; // 子资源失败（图片/接口）不该整页报错
                }
                CharSequence desc = error == null ? null : error.getDescription();
                showError(desc == null ? null : getString(R.string.error_detail) + "\n(" + desc + ")");
            }

            @Override
            public void onReceivedSslError(WebView view, SslErrorHandler handler, SslError error) {
                // 绝不 handler.proceed()：证书不过就断，避免中间人攻击
                handler.cancel();
                int code = error == null ? -1 : error.getPrimaryError();
                showError(getString(R.string.error_ssl) + " (" + code + ")");
            }
        });

        webView.setWebChromeClient(new WebChromeClient() {
            @Override
            public boolean onShowFileChooser(WebView view, ValueCallback<Uri[]> callback,
                                             FileChooserParams params) {
                if (fileChooserCallback != null) {
                    // 上一次没回调完就再来一次：先把它关掉，避免 WebView 一直等
                    fileChooserCallback.onReceiveValue(null);
                    fileChooserCallback = null;
                }
                fileChooserCallback = callback;

                Intent intent = new Intent(Intent.ACTION_GET_CONTENT);
                intent.addCategory(Intent.CATEGORY_OPENABLE);

                String[] accepts = params == null ? null : params.getAcceptTypes();
                List<String> types = new ArrayList<>();
                if (accepts != null) {
                    for (String accept : accepts) {
                        if (accept == null) {
                            continue;
                        }
                        String t = accept.trim();
                        if (t.isEmpty() || "*/*".equals(t)) {
                            continue;
                        }
                        types.add(t);
                    }
                }
                if (types.size() == 1) {
                    intent.setType(types.get(0));
                } else if (!types.isEmpty()) {
                    intent.setType("*/*");
                    intent.putExtra(Intent.EXTRA_MIME_TYPES, types.toArray(new String[0]));
                } else {
                    intent.setType("*/*");
                }
                if (params != null && params.getMode() == FileChooserParams.MODE_OPEN_MULTIPLE) {
                    intent.putExtra(Intent.EXTRA_ALLOW_MULTIPLE, true);
                }

                try {
                    startActivityForResult(intent, REQ_FILE_CHOOSER);
                } catch (ActivityNotFoundException e) {
                    Log.w(TAG, "no file manager for chooser", e);
                    fileChooserCallback = null;
                    Toast.makeText(MainActivity.this, "没有可用的文件选择器", Toast.LENGTH_SHORT).show();
                    return false;
                }
                return true;
            }

            @Override
            public void onPermissionRequest(PermissionRequest request) {
                if (request == null) {
                    return;
                }
                boolean wantsCamera = false;
                boolean wantsMic = false;
                for (String resource : request.getResources()) {
                    if (PermissionRequest.RESOURCE_VIDEO_CAPTURE.equals(resource)) {
                        wantsCamera = true;
                    } else if (PermissionRequest.RESOURCE_AUDIO_CAPTURE.equals(resource)) {
                        wantsMic = true;
                    }
                }
                if (!wantsCamera && !wantsMic) {
                    request.deny();
                    return;
                }
                List<String> missing = new ArrayList<>();
                if (wantsCamera && checkSelfPermission(Manifest.permission.CAMERA) != PackageManager.PERMISSION_GRANTED) {
                    missing.add(Manifest.permission.CAMERA);
                }
                if (wantsMic && checkSelfPermission(Manifest.permission.RECORD_AUDIO) != PackageManager.PERMISSION_GRANTED) {
                    missing.add(Manifest.permission.RECORD_AUDIO);
                }
                if (missing.isEmpty()) {
                    request.grant(request.getResources());
                    return;
                }
                // 只挂一个 pending：WebView 一次只会问一种资源，重复覆盖也不丢正确性
                pendingPermissionRequest = request;
                requestPermissions(missing.toArray(new String[0]), REQ_PERM_MEDIA);
            }
        });

        webView.setDownloadListener(new DownloadListener() {
            @Override
            public void onDownloadStart(String url, String userAgent, String contentDisposition,
                                        String mimeType, long contentLength) {
                if (url == null) {
                    return;
                }
                if (url.startsWith("blob:") || url.startsWith("data:")) {
                    // blob:/data: 只能由页面自己保存，系统下载器拿不到
                    Toast.makeText(MainActivity.this, "请长按该图片/文件后选择「保存」", Toast.LENGTH_LONG).show();
                    return;
                }
                if (Build.VERSION.SDK_INT <= 28
                        && checkSelfPermission(Manifest.permission.WRITE_EXTERNAL_STORAGE) != PackageManager.PERMISSION_GRANTED) {
                    pendingDownloadUrl = url;
                    pendingDownloadUserAgent = userAgent;
                    pendingDownloadDisposition = contentDisposition;
                    pendingDownloadMime = mimeType;
                    requestPermissions(new String[]{Manifest.permission.WRITE_EXTERNAL_STORAGE}, REQ_PERM_STORAGE);
                    return;
                }
                enqueueDownload(url, userAgent, contentDisposition, mimeType);
            }
        });
    }

    /** true = 这个链接不该在壳里打开 */
    private boolean shouldOpenExternally(Uri uri) {
        if (uri == null) {
            return false;
        }
        String scheme = uri.getScheme();
        if (scheme == null) {
            return false;
        }
        if ("http".equalsIgnoreCase(scheme) || "https".equalsIgnoreCase(scheme)) {
            String host = uri.getHost();
            // Locale.ROOT：土耳其语环境下 toLowerCase() 会把 I 变成 ı，主机名判断就会失效
            boolean internal = host != null
                    && (host.equalsIgnoreCase(SITE_HOST)
                    || host.toLowerCase(Locale.ROOT).endsWith("." + SITE_HOST));
            if (internal) {
                return false;
            }
            return openExternal(uri);
        }
        // 页面内部产生的伪协议留在 WebView 里
        if ("about".equalsIgnoreCase(scheme) || "javascript".equalsIgnoreCase(scheme)
                || "data".equalsIgnoreCase(scheme) || "blob".equalsIgnoreCase(scheme)) {
            return false;
        }
        // mailto: / tel: / market: / 其它 app 的 scheme 交给系统
        return openExternal(uri);
    }

    private boolean openExternal(Uri uri) {
        try {
            Intent intent = new Intent(Intent.ACTION_VIEW, uri);
            intent.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
            startActivity(intent);
            return true;
        } catch (ActivityNotFoundException e) {
            Log.w(TAG, "no app for " + uri.getScheme());
            Toast.makeText(this, "没有能打开此链接的应用", Toast.LENGTH_SHORT).show();
            return false;
        }
    }

    // ---------------------------------------------------------------- 下载

    private void enqueueDownload(String url, String userAgent, String contentDisposition, String mimeType) {
        try {
            String fileName = URLUtil.guessFileName(url, contentDisposition, mimeType);
            DownloadManager.Request request = new DownloadManager.Request(Uri.parse(url));
            if (mimeType != null) {
                request.setMimeType(mimeType);
            }
            if (userAgent != null) {
                request.addRequestHeader("User-Agent", userAgent);
            }
            // 附件在登录态后面：把 WebView 的 Cookie 带给下载器，否则 403/跳登录页
            String cookie = CookieManager.getInstance().getCookie(url);
            if (cookie != null && !cookie.isEmpty()) {
                request.addRequestHeader("Cookie", cookie);
            }
            request.setTitle(fileName);
            request.setDescription("AIO 下载");
            request.setNotificationVisibility(DownloadManager.Request.VISIBILITY_VISIBLE_NOTIFY_COMPLETED);
            request.setDestinationInExternalPublicDir(Environment.DIRECTORY_DOWNLOADS, fileName);
            DownloadManager dm = (DownloadManager) getSystemService(Context.DOWNLOAD_SERVICE);
            if (dm == null) {
                throw new IllegalStateException("DownloadManager unavailable");
            }
            dm.enqueue(request);
            Toast.makeText(this, "已开始下载：" + fileName, Toast.LENGTH_SHORT).show();
        } catch (Exception e) {
            Log.w(TAG, "download failed, fallback to browser", e);
            if (!openExternal(Uri.parse(url))) {
                Toast.makeText(this, "下载失败，请用系统浏览器打开", Toast.LENGTH_LONG).show();
            }
        }
    }

    // ---------------------------------------------------------------- 结果回调

    @Override
    protected void onActivityResult(int requestCode, int resultCode, Intent data) {
        if (requestCode == REQ_FILE_CHOOSER) {
            if (fileChooserCallback == null) {
                super.onActivityResult(requestCode, resultCode, data);
                return;
            }
            Uri[] results = null;
            if (resultCode == RESULT_OK && data != null) {
                if (data.getClipData() != null) {
                    int count = data.getClipData().getItemCount();
                    results = new Uri[count];
                    for (int i = 0; i < count; i++) {
                        results[i] = data.getClipData().getItemAt(i).getUri();
                    }
                } else if (data.getData() != null) {
                    results = new Uri[]{data.getData()};
                }
            }
            fileChooserCallback.onReceiveValue(results);
            fileChooserCallback = null;
            return;
        }
        super.onActivityResult(requestCode, resultCode, data);
    }

    @Override
    public void onRequestPermissionsResult(int requestCode, String[] permissions, int[] grantResults) {
        if (requestCode == REQ_PERM_MEDIA) {
            boolean granted = grantResults != null && grantResults.length > 0;
            if (grantResults != null) {
                for (int result : grantResults) {
                    if (result != PackageManager.PERMISSION_GRANTED) {
                        granted = false;
                    }
                }
            }
            if (pendingPermissionRequest != null) {
                if (granted) {
                    pendingPermissionRequest.grant(pendingPermissionRequest.getResources());
                } else {
                    pendingPermissionRequest.deny();
                    Toast.makeText(this, "需要摄像头/麦克风权限才能录像或录音", Toast.LENGTH_LONG).show();
                }
                pendingPermissionRequest = null;
            }
            return;
        }
        if (requestCode == REQ_PERM_STORAGE) {
            boolean granted = grantResults != null && grantResults.length > 0
                    && grantResults[0] == PackageManager.PERMISSION_GRANTED;
            if (granted && pendingDownloadUrl != null) {
                enqueueDownload(pendingDownloadUrl, pendingDownloadUserAgent,
                        pendingDownloadDisposition, pendingDownloadMime);
            } else if (!granted) {
                Toast.makeText(this, "没有存储权限，无法保存到「下载」目录", Toast.LENGTH_LONG).show();
            }
            pendingDownloadUrl = null;
            pendingDownloadUserAgent = null;
            pendingDownloadDisposition = null;
            pendingDownloadMime = null;
            return;
        }
        if (requestCode == REQ_PERM_NOTIFICATIONS) {
            // 授不授权都不影响服务本身：拒绝就只是不弹通知（WebView 里照常能看）
            return;
        }
        super.onRequestPermissionsResult(requestCode, permissions, grantResults);
    }

    // ---------------------------------------------------------------- 原生推送

    private void syncPushService() {
        if (!PushService.hasSessionCookie()) {
            PushService.stop(this);
            return;
        }
        requestNotificationPermissionIfNeeded();
        try {
            PushService.start(this);
        } catch (Exception e) {
            // Android 12+ 从后台启动前台服务有限制；这里只是防御，不要因为推送起不来把页面搞崩
            Log.w(TAG, "start push service failed", e);
        }
    }

    private void requestNotificationPermissionIfNeeded() {
        if (Build.VERSION.SDK_INT < 33) {
            return;
        }
        if (checkSelfPermission(Manifest.permission.POST_NOTIFICATIONS) == PackageManager.PERMISSION_GRANTED) {
            return;
        }
        requestPermissions(new String[]{Manifest.permission.POST_NOTIFICATIONS}, REQ_PERM_NOTIFICATIONS);
    }

    // ---------------------------------------------------------------- 错误页

    private void showError(String detail) {
        errorShown = true;
        if (detail == null || detail.trim().isEmpty()) {
            errorDetail.setText(R.string.error_detail);
        } else {
            errorDetail.setText(detail);
        }
        errorPanel.setVisibility(View.VISIBLE);
    }

    private void hideError() {
        if (!errorShown) {
            return;
        }
        errorShown = false;
        errorPanel.setVisibility(View.GONE);
    }

    // ---------------------------------------------------------------- 系统栏

    private void applySystemBars() {
        boolean night = (getResources().getConfiguration().uiMode & Configuration.UI_MODE_NIGHT_MASK)
                == Configuration.UI_MODE_NIGHT_YES;
        getWindow().setStatusBarColor(getResources().getColor(R.color.status_bar, getTheme()));
        getWindow().setNavigationBarColor(getResources().getColor(R.color.nav_bar, getTheme()));

        boolean lightIconsOnDarkBar = !night;
        if (Build.VERSION.SDK_INT >= 30) {
            WindowInsetsController controller = getWindow().getInsetsController();
            if (controller != null) {
                int mask = WindowInsetsController.APPEARANCE_LIGHT_STATUS_BARS
                        | WindowInsetsController.APPEARANCE_LIGHT_NAVIGATION_BARS;
                controller.setSystemBarsAppearance(lightIconsOnDarkBar ? mask : 0, mask);
            }
        } else {
            View decor = getWindow().getDecorView();
            int flags = decor.getSystemUiVisibility();
            if (lightIconsOnDarkBar) {
                flags |= View.SYSTEM_UI_FLAG_LIGHT_STATUS_BAR;
            } else {
                flags &= ~View.SYSTEM_UI_FLAG_LIGHT_STATUS_BAR;
            }
            decor.setSystemUiVisibility(flags);
        }

        // Android 15（targetSdk 35）强制 edge-to-edge：自己吃 insets，别让页面压到状态栏/键盘下面
        final View root = findViewById(R.id.root);
        root.setOnApplyWindowInsetsListener((v, insets) -> {
            int top;
            int bottom;
            if (Build.VERSION.SDK_INT >= 30) {
                Insets bars = insets.getInsets(WindowInsets.Type.systemBars());
                Insets ime = insets.getInsets(WindowInsets.Type.ime());
                top = bars.top;
                bottom = Math.max(bars.bottom, ime.bottom);
            } else {
                top = insets.getSystemWindowInsetTop();
                bottom = insets.getSystemWindowInsetBottom();
            }
            v.setPadding(0, top, 0, bottom);
            return insets;
        });
        root.requestApplyInsets();
    }

    // ---------------------------------------------------------------- 生命周期

    /** 返回键唯一的实现：能后退就后退，退无可退才退出壳 */
    private void handleBack() {
        if (webView != null && webView.canGoBack()) {
            webView.goBack();
            return;
        }
        finish();
    }

    @Override
    public void onBackPressed() {
        // 33+ 已被 OnBackInvokedDispatcher 接管，这里是老系统入口；两条路径语义一致。
        handleBack();
    }

    @Override
    protected void onStart() {
        super.onStart();
        foregroundCount++;
    }

    @Override
    protected void onStop() {
        foregroundCount--;
        if (foregroundCount < 0) {
            foregroundCount = 0;
        }
        super.onStop();
    }

    @Override
    protected void onPause() {
        // 不 flush 的话，进程被系统杀掉时 Cookie 会丢，表现为「每次打开都要重新登录」
        CookieManager.getInstance().flush();
        if (webView != null) {
            webView.onPause();
        }
        super.onPause();
    }

    @Override
    protected void onResume() {
        super.onResume();
        if (webView != null) {
            webView.onResume();
        }
    }

    @Override
    protected void onSaveInstanceState(Bundle outState) {
        super.onSaveInstanceState(outState);
        if (webView != null) {
            webView.saveState(outState);
        }
    }

    @Override
    protected void onDestroy() {
        if (Build.VERSION.SDK_INT >= 33 && backInvokedCallback instanceof OnBackInvokedCallback) {
            getOnBackInvokedDispatcher().unregisterOnBackInvokedCallback(
                    (OnBackInvokedCallback) backInvokedCallback);
            backInvokedCallback = null;
        }
        if (webView != null) {
            ViewGroup parent = (ViewGroup) webView.getParent();
            if (parent != null) {
                parent.removeView(webView);
            }
            webView.stopLoading();
            webView.setWebChromeClient(null);
            webView.setWebViewClient(null);
            webView.destroy();
            webView = null;
        }
        super.onDestroy();
    }
}
