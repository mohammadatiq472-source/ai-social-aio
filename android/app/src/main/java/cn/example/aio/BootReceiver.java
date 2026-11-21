package cn.example.aio;

import android.content.BroadcastReceiver;
import android.content.Context;
import android.content.Intent;
import android.util.Log;

/**
 * 开机 / 覆盖安装后把推送服务拉起来。
 *
 * 只在「本地还留着会话 cookie」时才启动：没登录的机器不该白白多一个前台服务。
 * 注意国产 ROM 默认会拦截自启动，需要在系统设置里允许（见 android/README.md）。
 */
public class BootReceiver extends BroadcastReceiver {

    private static final String TAG = "AIOPush";

    @Override
    public void onReceive(Context context, Intent intent) {
        String action = intent == null ? null : intent.getAction();
        boolean boot = Intent.ACTION_BOOT_COMPLETED.equals(action);
        boolean updated = Intent.ACTION_MY_PACKAGE_REPLACED.equals(action);
        if (!boot && !updated) {
            return;
        }
        if (!PushService.hasSessionCookie()) {
            Log.i(TAG, "boot: no session cookie, skip push service");
            return;
        }
        try {
            PushService.start(context);
        } catch (Exception e) {
            // Android 12+ 后台启动前台服务有白名单限制；BOOT_COMPLETED 属于豁免，但某些 ROM 仍会抛
            Log.w(TAG, "boot: start push service failed", e);
        }
    }
}
