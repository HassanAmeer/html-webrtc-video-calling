package com.tokendeal.vremote;

import android.content.BroadcastReceiver;
import android.content.Context;
import android.content.Intent;
import android.util.Log;

/**
 * Ensures BackgroundKeepAliveService and KeepAliveScheduler start immediately
 * when device reboots, restarts, or app package is replaced/updated.
 */
public class BootReceiver extends BroadcastReceiver {
    private static final String TAG = "BootReceiver";

    @Override
    public void onReceive(Context context, Intent intent) {
        if (intent == null) return;
        String action = intent.getAction();
        Log.i(TAG, "BootReceiver triggered with action: " + action);

        try {
            BackgroundKeepAliveService.startService(context);
        } catch (Exception e) {
            Log.e(TAG, "Failed to start BackgroundKeepAliveService on boot", e);
        }

        try {
            KeepAliveScheduler.schedulePeriodicWork(context);
        } catch (Exception e) {
            Log.e(TAG, "Failed to schedule KeepAlive work on boot", e);
        }
    }
}
