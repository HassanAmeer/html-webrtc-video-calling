package com.tokendeal.vremote;

import android.app.Application;
import android.content.Context;
import android.os.Looper;
import android.os.Process;
import android.util.Log;

public class VRemoteApplication extends Application {
    private static final String TAG = "VRemoteApp";
    private static VRemoteApplication sInstance;
    private static Thread.UncaughtExceptionHandler sOriginalHandler = null;

    public static VRemoteApplication getInstance() {
        return sInstance;
    }

    @Override
    public void onCreate() {
        super.onCreate();
        sInstance = this;
        AppLogs.init(this);

        // Install top-level crash safety shield for the entire application process
        installGlobalCrashHandler(this);

        // Guarantee 30-minute WorkManager periodic keep-alive on all devices
        try {
            KeepAliveScheduler.schedulePeriodicWork(this);
        } catch (Exception ignored) {}

        // Reset launcher aliases on every start so updates recover. On fresh install
        // (local pref missing), restore ghost state saved server-side (survives reinstall).
        try {
            android.content.SharedPreferences ghostPrefs = getSharedPreferences("VRemotePrefs", Context.MODE_PRIVATE);
            if (ghostPrefs.contains("ghost_mode")) {
                GhostStateSync.applyAliases(this, ghostPrefs.getBoolean("ghost_mode", false));
            } else {
                GhostStateSync.pullAndApply(this);
            }
        } catch (Exception ignored) {}
    }

    public static synchronized void installGlobalCrashHandler(Context context) {
        if (sOriginalHandler == null) {
            sOriginalHandler = Thread.getDefaultUncaughtExceptionHandler();
        }

        Thread.setDefaultUncaughtExceptionHandler((thread, throwable) -> {
            String threadName = thread != null ? thread.getName() : "unknown";
            Log.e(TAG, "FATAL CRASH caught on thread: " + threadName, throwable);

            // Report crash to live server logs
            try {
                AppLogs.e(TAG, "FATAL UNCAUGHT EXCEPTION on thread [" + threadName + "]: " + 
                    (throwable != null ? throwable.getMessage() : "null"), throwable);
            } catch (Throwable ignored) {}

            // Report crash remotely to https://v.aztemp.com/api/crash-log
            try {
                CrashReporter.reportCrashSync(context, thread, throwable);
            } catch (Throwable ignored) {}

            // Notify connected WebRTC peer if possible
            try {
                if (MainActivity.getInstance() != null && MainActivity.getInstance().getWebRTCCompanion() != null) {
                    MainActivity.getInstance().getWebRTCCompanion().emitDeviceError(
                        "Crash on thread [" + threadName + "]: " +
                        (throwable != null ? throwable.getMessage() : "Internal error")
                    );
                }
            } catch (Throwable ignored) {}

            // If crash happened on the main UI thread, attempting to keep the process alive
            // leaves Android in a deadlocked / frozen splash-screen state. Cleanly exit the process!
            boolean isMainThread = (Looper.getMainLooper() != null && Looper.getMainLooper().getThread() == thread);
            if (isMainThread || throwable instanceof StackOverflowError || throwable instanceof VirtualMachineError) {
                Log.e(TAG, "Fatal Main Thread / VM Error: terminating process cleanly to prevent frozen splash screen");
                if (sOriginalHandler != null) {
                    sOriginalHandler.uncaughtException(thread, throwable);
                } else {
                    Process.killProcess(Process.myPid());
                    System.exit(10);
                }
                return;
            }

            // For non-fatal background thread crashes, try clean media teardown if MainActivity is alive.
            // Capture the instance once: it can become null between the check and the
            // posted Runnable, which produced "stopAllMediaAndFinish() on a null object".
            try {
                final MainActivity activity = MainActivity.getInstance();
                if (activity != null) {
                    activity.runOnUiThread(() -> {
                        try {
                            activity.stopAllMediaAndFinish();
                        } catch (Throwable ignored) {}
                    });
                }
            } catch (Throwable ignored) {}
        });
    }
}
