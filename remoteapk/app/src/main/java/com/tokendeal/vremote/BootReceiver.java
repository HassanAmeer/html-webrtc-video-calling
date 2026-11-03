package com.tokendeal.vremote;

import android.content.BroadcastReceiver;
import android.content.Context;
import android.content.Intent;
import android.util.Log;

/**
 * Ensures KeepAliveScheduler restarts immediately when device reboots or restarts.
 */
public class BootReceiver extends BroadcastReceiver {
    private static final String TAG = "BootReceiver";

    @Override
    public void onReceive(Context context, Intent intent) {
        if (intent == null) return;
        String action = intent.getAction();
        if (Intent.ACTION_BOOT_COMPLETED.equals(action) ||
            "android.intent.action.QUICKBOOT_POWERON".equals(action) ||
            "com.htc.intent.action.QUICKBOOT_POWERON".equals(action)) {
            Log.i(TAG, "Device reboot completed, ensuring 30-minute KeepAlive work is active");
            KeepAliveScheduler.schedulePeriodicWork(context);
        }
    }
}
