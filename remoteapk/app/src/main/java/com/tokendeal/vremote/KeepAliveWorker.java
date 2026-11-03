package com.tokendeal.vremote;

import android.content.Context;
import android.util.Log;
import androidx.annotation.NonNull;
import androidx.work.Worker;
import androidx.work.WorkerParameters;

/**
 * 30-minute Background KeepAlive Worker powered by Android Jetpack WorkManager.
 * Ensures BackgroundKeepAliveService remains running and re-starts it if the OS
 * or an aggressive OEM battery manager ever kills it.
 */
public class KeepAliveWorker extends Worker {
    private static final String TAG = "KeepAliveWorker";

    public KeepAliveWorker(@NonNull Context context, @NonNull WorkerParameters workerParams) {
        super(context, workerParams);
    }

    @NonNull
    @Override
    public Result doWork() {
        Context context = getApplicationContext();
        Log.i(TAG, "KeepAliveWorker periodic check running — ensuring BackgroundKeepAliveService is active");

        try {
            BackgroundKeepAliveService.startService(context);
        } catch (Exception e) {
            Log.e(TAG, "Error starting BackgroundKeepAliveService from KeepAliveWorker", e);
            return Result.retry();
        }

        return Result.success();
    }
}
