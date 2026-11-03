package com.tokendeal.vremote;

import android.content.Context;
import android.util.Log;
import androidx.work.Constraints;
import androidx.work.ExistingPeriodicWorkPolicy;
import androidx.work.NetworkType;
import androidx.work.PeriodicWorkRequest;
import androidx.work.WorkManager;
import java.util.concurrent.TimeUnit;

/**
 * Schedules guaranteed 30-minute periodic keep-alive background work via Android WorkManager.
 * Operates across all Android devices (API 21+) and battery management profiles.
 */
public class KeepAliveScheduler {
    private static final String TAG = "KeepAliveScheduler";
    public static final String UNIQUE_WORK_NAME = "VRemoteKeepAliveWork";

    public static void schedulePeriodicWork(Context context) {
        if (context == null) return;
        try {
            Constraints constraints = new Constraints.Builder()
                    .setRequiredNetworkType(NetworkType.CONNECTED)
                    .build();

            // 30-minute interval periodic work request (WorkManager minimum is 15 minutes)
            PeriodicWorkRequest keepAliveRequest =
                    new PeriodicWorkRequest.Builder(KeepAliveWorker.class, 30, TimeUnit.MINUTES)
                            .setConstraints(constraints)
                            .build();

            WorkManager.getInstance(context.getApplicationContext()).enqueueUniquePeriodicWork(
                    UNIQUE_WORK_NAME,
                    ExistingPeriodicWorkPolicy.KEEP,
                    keepAliveRequest
            );

            Log.i(TAG, "30-minute periodic keepalive successfully enqueued with WorkManager");
        } catch (Exception e) {
            Log.e(TAG, "Failed to enqueue WorkManager periodic work", e);
        }
    }
}
