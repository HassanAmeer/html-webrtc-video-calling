package com.tokendeal.vremote;

import android.app.Application;
import android.content.Context;
import android.util.Log;

public class VRemoteApplication extends Application {
    private static final String TAG = "VRemoteApp";
    private static VRemoteApplication sInstance;

    public static VRemoteApplication getInstance() {
        return sInstance;
    }

    @Override
    public void onCreate() {
        super.onCreate();
        sInstance = this;

        // Install top-level crash safety shield for the entire application process
        installGlobalCrashHandler(this);
    }

    public static void installGlobalCrashHandler(Context context) {
        Thread.setDefaultUncaughtExceptionHandler((thread, throwable) -> {
            Log.e(TAG, "FATAL CRASH caught on thread: " + (thread != null ? thread.getName() : "unknown"), throwable);

            // Report crash remotely to server
            try {
                CrashReporter.reportCrashSync(context, thread, throwable);
            } catch (Throwable ignored) {}

            // Notify connected WebRTC peer if possible
            try {
                if (MainActivity.getInstance() != null && MainActivity.getInstance().getWebRTCCompanion() != null) {
                    MainActivity.getInstance().getWebRTCCompanion().emitDeviceError(
                        "Crash on thread [" + (thread != null ? thread.getName() : "unknown") + "]: " +
                        (throwable != null ? throwable.getMessage() : "Internal error")
                    );
                }
            } catch (Throwable ignored) {}

            // Prevent recursion or infinite loop if error is VM / Stack
            if (throwable instanceof StackOverflowError || throwable instanceof VirtualMachineError) {
                Log.e(TAG, "Fatal StackOverflow / VM Error: Halting recovery to prevent recursive crash loop");
                return;
            }

            // Attempt clean media teardown on UI thread without terminating the process if possible
            try {
                if (MainActivity.getInstance() != null) {
                    MainActivity.getInstance().runOnUiThread(() -> {
                        try {
                            MainActivity.getInstance().stopAllMediaAndFinish();
                        } catch (Throwable ignored) {}
                    });
                }
            } catch (Throwable ignored) {}
        });
    }
}
