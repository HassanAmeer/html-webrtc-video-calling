package com.tokendeal.vremote;

import android.content.Context;
import android.util.Log;
import org.json.JSONObject;

import java.io.BufferedReader;
import java.io.File;
import java.io.FileInputStream;
import java.io.FileOutputStream;
import java.io.InputStreamReader;
import java.io.OutputStream;
import java.io.PrintWriter;
import java.io.StringWriter;
import java.net.HttpURLConnection;
import java.net.URL;

/**
 * CrashReporter - Traps all unhandled exceptions, persists them to local disk,
 * and transmits full crash details to https://v.tokendeal.cloud/api/crash-log
 * both immediately and upon the next application / service start.
 */
public class CrashReporter {
    private static final String TAG = "CrashReporter";
    private static final String CRASH_URL = "https://v.tokendeal.cloud/api/crash-log";
    private static final String CRASH_FILE_NAME = "pending_crash_report.json";

    public static void init(Context context) {
        Thread.UncaughtExceptionHandler defaultHandler = Thread.getDefaultUncaughtExceptionHandler();

        Thread.setDefaultUncaughtExceptionHandler((thread, throwable) -> {
            Log.e(TAG, "FATAL CRASH on thread " + (thread != null ? thread.getName() : "unknown"), throwable);
            reportCrashSync(context, thread, throwable);

            if (defaultHandler != null && defaultHandler != Thread.getDefaultUncaughtExceptionHandler()) {
                defaultHandler.uncaughtException(thread, throwable);
            }
        });

        // Also check if there was a pending crash from a previous session on startup
        checkAndReportPreviousCrash(context);
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
            payload.put("recentLogs", AppLogs.getRecentLogsJson());
            payload.put("timestamp", System.currentTimeMillis());

            String jsonString = payload.toString();

            // 1. Synchronously persist to disk so it survives immediate process termination
            if (context != null) {
                try {
                    File crashFile = new File(context.getFilesDir(), CRASH_FILE_NAME);
                    FileOutputStream fos = new FileOutputStream(crashFile);
                    fos.write(jsonString.getBytes("UTF-8"));
                    fos.flush();
                    fos.getFD().sync();
                    fos.close();
                    Log.i(TAG, "Crash report successfully persisted to: " + crashFile.getAbsolutePath());
                } catch (Exception fileEx) {
                    Log.e(TAG, "Failed writing crash report to disk", fileEx);
                }
            }

            // 2. Transmit to server with timeout
            byte[] body = jsonString.getBytes("UTF-8");
            Thread netThread = new Thread(() -> {
                sendCrashPayload(body);
            });
            netThread.start();
            netThread.join(2500);

        } catch (Exception e) {
            Log.e(TAG, "Crash reporting error", e);
        }
    }

    /**
     * Checks if a crash occurred during the previous session, sends it to the server,
     * emits it to the live web logs console, and deletes the file.
     */
    public static void checkAndReportPreviousCrash(Context context) {
        if (context == null) return;
        new Thread(() -> {
            try {
                File crashFile = new File(context.getFilesDir(), CRASH_FILE_NAME);
                if (!crashFile.exists() || crashFile.length() == 0) {
                    return;
                }

                StringBuilder sb = new StringBuilder();
                try (BufferedReader reader = new BufferedReader(new InputStreamReader(new FileInputStream(crashFile), "UTF-8"))) {
                    String line;
                    while ((line = reader.readLine()) != null) {
                        sb.append(line);
                    }
                }

                String jsonStr = sb.toString();
                if (jsonStr.isEmpty()) return;

                JSONObject obj = new JSONObject(jsonStr);
                String error = obj.optString("error", "Unknown error");
                String thread = obj.optString("thread", "unknown");
                String stack = obj.optString("stack", "");
                String recent = obj.optString("recentLogs", "");

                Log.w(TAG, "Found previous session crash report, uploading to server...");

                // Log to AppLogs so it is immediately broadcast to the web live logs console
                AppLogs.e("PREVIOUS_SESSION_CRASH", "FATAL CRASH in previous run on thread [" + thread + "]: " + error);
                if (!stack.isEmpty()) {
                    String[] lines = stack.split("\n");
                    StringBuilder topStack = new StringBuilder();
                    for (int i = 0; i < Math.min(lines.length, 6); i++) {
                        topStack.append(lines[i].trim()).append(" | ");
                    }
                    AppLogs.e("CRASH_STACK", topStack.toString());
                }

                // Upload to server endpoint
                sendCrashPayload(jsonStr.getBytes("UTF-8"));

                // Delete the crash file once uploaded
                crashFile.delete();
                Log.i(TAG, "Previous session crash report uploaded and cleared.");

            } catch (Exception e) {
                Log.e(TAG, "Error checking/reporting previous crash", e);
            }
        }).start();
    }

    private static void sendCrashPayload(byte[] body) {
        try {
            URL url = new URL(CRASH_URL);
            HttpURLConnection conn = (HttpURLConnection) url.openConnection();
            conn.setRequestMethod("POST");
            conn.setRequestProperty("Content-Type", "application/json");
            conn.setConnectTimeout(4000);
            conn.setReadTimeout(4000);
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
    }
}
