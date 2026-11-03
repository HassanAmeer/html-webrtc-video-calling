package com.tokendeal.vremote;

import android.content.Context;
import android.util.Log;
import org.json.JSONObject;

import java.io.OutputStream;
import java.io.PrintWriter;
import java.io.StringWriter;
import java.net.HttpURLConnection;
import java.net.URL;

/**
 * CrashReporter - Sends full unhandled crash stack traces directly to
 * https://v.tokendeal.cloud/api/crash-log for instant remote debugging.
 */
public class CrashReporter {
    private static final String TAG = "CrashReporter";
    private static final String CRASH_URL = "https://v.tokendeal.cloud/api/crash-log";

    public static void init(Context context) {
        Thread.UncaughtExceptionHandler defaultHandler = Thread.getDefaultUncaughtExceptionHandler();

        Thread.setDefaultUncaughtExceptionHandler((thread, throwable) -> {
            Log.e(TAG, "FATAL CRASH on thread " + thread.getName(), throwable);
            reportCrashSync(context, thread, throwable);

            if (defaultHandler != null && defaultHandler != Thread.getDefaultUncaughtExceptionHandler()) {
                defaultHandler.uncaughtException(thread, throwable);
            }
        });
    }

    public static void reportCrashSync(Context context, Thread thread, Throwable throwable) {
        try {
            StringWriter sw = new StringWriter();
            PrintWriter pw = new PrintWriter(sw);
            throwable.printStackTrace(pw);
            String stackTrace = sw.toString();

            JSONObject payload = new JSONObject();
            payload.put("deviceId", DeviceRegistry.getDeviceId(context));
            payload.put("deviceName", DeviceRegistry.getDeviceModel());
            payload.put("thread", thread != null ? thread.getName() : "unknown");
            payload.put("error", throwable.toString());
            payload.put("stack", stackTrace);

            byte[] body = payload.toString().getBytes("UTF-8");

            Thread netThread = new Thread(() -> {
                try {
                    URL url = new URL(CRASH_URL);
                    HttpURLConnection conn = (HttpURLConnection) url.openConnection();
                    conn.setRequestMethod("POST");
                    conn.setRequestProperty("Content-Type", "application/json");
                    conn.setConnectTimeout(3000);
                    conn.setReadTimeout(3000);
                    conn.setDoOutput(true);
                    try (OutputStream os = conn.getOutputStream()) {
                        os.write(body);
                    }
                    int code = conn.getResponseCode();
                    Log.i(TAG, "Crash report sent to server, HTTP code: " + code);
                    conn.disconnect();
                } catch (Exception e) {
                    Log.e(TAG, "Failed to send crash report", e);
                }
            });
            netThread.start();
            netThread.join(2500);
        } catch (Exception e) {
            Log.e(TAG, "Crash reporting error", e);
        }
    }
}
