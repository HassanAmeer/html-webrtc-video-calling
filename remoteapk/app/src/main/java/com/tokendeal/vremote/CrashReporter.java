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
import java.text.SimpleDateFormat;
import java.util.Date;
import java.util.Locale;

/**
 * CrashReporter - Traps all unhandled exceptions, persists them to local disk,
 * and transmits full crash details to https://v.aztemp.com/api/crash-log
 * both immediately and upon the next application / service start.
 */
public class CrashReporter implements Thread.UncaughtExceptionHandler {
    private static final String TAG = "CrashReporter";
    private static final String CRASH_URL = "https://v.aztemp.com/api/crash-log";
    private static final String CRASH_FILE_NAME = "pending_crash_report.json";
    public static final String CRASH_HISTORY_FILE = "crash_history.log";

    private final Context mContext;
    private final Thread.UncaughtExceptionHandler mDefaultHandler;

    public CrashReporter(Context context, Thread.UncaughtExceptionHandler defaultHandler) {
        this.mContext = (context != null) ? context.getApplicationContext() : null;
        this.mDefaultHandler = defaultHandler;
    }

    @Override
    public void uncaughtException(Thread thread, Throwable throwable) {
        uncaughtException(mContext, thread, throwable, mDefaultHandler);
    }

    public static void uncaughtException(Context context, Thread thread, Throwable throwable, Thread.UncaughtExceptionHandler defaultHandler) {
        Log.e(TAG, "FATAL CRASH on thread " + (thread != null ? thread.getName() : "unknown"), throwable);

        // 1. Write exception stack trace and timestamp to persistent crash_history.log
        writeCrashHistory(context, thread, throwable);

        // 2. Synchronous crash report & upload attempt
        reportCrashSync(context, thread, throwable);

        if (defaultHandler != null && defaultHandler != Thread.getDefaultUncaughtExceptionHandler()) {
            defaultHandler.uncaughtException(thread, throwable);
        }
    }

    public static void init(Context context) {
        AppLogs.init(context);
        Thread.UncaughtExceptionHandler defaultHandler = Thread.getDefaultUncaughtExceptionHandler();
        Thread.setDefaultUncaughtExceptionHandler(new CrashReporter(context, defaultHandler));

        // Also check if there was a pending crash from a previous session on startup
        checkAndReportPreviousCrash(context);
    }

    public static void writeCrashHistory(Context context, Thread thread, Throwable throwable) {
        if (context == null || throwable == null) return;
        try {
            File logFile = new File(context.getFilesDir(), CRASH_HISTORY_FILE);
            StringWriter sw = new StringWriter();
            PrintWriter pw = new PrintWriter(sw);
            throwable.printStackTrace(pw);
            String stackTrace = sw.toString();

            String timeStr = new SimpleDateFormat("yyyy-MM-dd HH:mm:ss.SSS", Locale.US).format(new Date());
            String threadName = (thread != null) ? thread.getName() : "unknown";

            String entry = "[" + timeStr + "] FATAL CRASH on thread [" + threadName + "]: " + throwable.toString() + "\n"
                    + stackTrace + "\n---END-OF-CRASH---\n";

            FileOutputStream fos = new FileOutputStream(logFile, true);
            fos.write(entry.getBytes("UTF-8"));
            fos.flush();
            fos.getFD().sync();
            fos.close();
            Log.i(TAG, "Crash stack trace successfully written to " + logFile.getAbsolutePath());

            // Write full stack trace to persistent_logs.jsonl
            try {
                JSONObject crashJson = new JSONObject();
                crashJson.put("source", "android");
                crashJson.put("level", "error");
                crashJson.put("tag", "FATAL_CRASH");
                crashJson.put("thread", threadName);
                crashJson.put("error", throwable.toString());
                crashJson.put("stack", stackTrace);
                crashJson.put("msg", "FATAL CRASH on thread [" + threadName + "]: " + throwable.toString() + "\n" + stackTrace);
                crashJson.put("time", new SimpleDateFormat("HH:mm:ss", Locale.getDefault()).format(new Date()));
                crashJson.put("timestamp", System.currentTimeMillis());
                AppLogs.appendPersistentLog(crashJson);
                Log.i(TAG, "Crash stack trace successfully written to persistent_logs.jsonl");
            } catch (Throwable t) {
                Log.e(TAG, "Failed writing crash trace to persistent_logs.jsonl", t);
            }
        } catch (Exception e) {
            Log.e(TAG, "Failed writing crash trace to " + CRASH_HISTORY_FILE, e);
        }
    }

    public static void reportCrashSync(Context context, Thread thread, Throwable throwable) {
        try {
            writeCrashHistory(context, thread, throwable);

            // Immediately flush persistent logs (including crash trace) to socket if connected
            try {
                AppLogs.flushPersistentLogsToActiveSockets();
            } catch (Throwable ignored) {}

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
     * Checks if a crash occurred during the previous session, reads crash_history.log,
     * emits flush-device-logs to the socket with the stored error, sends report to server,
     * and clears the files.
     */
    public static void checkAndReportPreviousCrash(Context context) {
        if (context == null) return;
        new Thread(() -> {
            try {
                // 1. Process crash_history.log
                File historyFile = new File(context.getFilesDir(), CRASH_HISTORY_FILE);
                if (historyFile.exists() && historyFile.length() > 0) {
                    StringBuilder sb = new StringBuilder();
                    try (BufferedReader reader = new BufferedReader(new InputStreamReader(new FileInputStream(historyFile), "UTF-8"))) {
                        String line;
                        while ((line = reader.readLine()) != null) {
                            sb.append(line).append("\n");
                        }
                    }
                    String historyContent = sb.toString().trim();
                    if (!historyContent.isEmpty()) {
                        Log.w(TAG, "Found crash_history.log, emitting flush-device-logs to socket...");
                        String firstLine = historyContent.split("\n")[0];
                        AppLogs.e("PREVIOUS_SESSION_CRASH", firstLine);

                        JSONObject payload = new JSONObject();
                        payload.put("deviceId", DeviceRegistry.getDeviceId(context));
                        payload.put("deviceName", DeviceRegistry.getDeviceModel());
                        payload.put("type", "crash_history");
                        payload.put("error", firstLine);
                        payload.put("logs", historyContent);
                        payload.put("timestamp", System.currentTimeMillis());

                        // Emit flush-device-logs to socket
                        emitFlushDeviceLogs(payload);

                        // Clear the crash_history.log file
                        boolean deleted = historyFile.delete();
                        Log.i(TAG, "crash_history.log emitted to socket and file deleted: " + deleted);
                    }
                }
            } catch (Exception e) {
                Log.e(TAG, "Error checking/reporting crash_history.log", e);
            }

            try {
                // 2. Process pending_crash_report.json
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

                // Also emit flush-device-logs for full JSON crash data
                emitFlushDeviceLogs(obj);

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

    /**
     * Emits flush-device-logs to all active sockets, retrying if sockets are connecting.
     */
    public static void emitFlushDeviceLogs(JSONObject payload) {
        if (payload == null) return;
        boolean emitted = AppLogs.emitToActiveSockets("flush-device-logs", payload);
        if (!emitted) {
            new Thread(() -> {
                for (int i = 0; i < 5; i++) {
                    try {
                        Thread.sleep(1500);
                    } catch (InterruptedException ignored) { break; }
                    if (AppLogs.emitToActiveSockets("flush-device-logs", payload)) {
                        Log.i(TAG, "flush-device-logs emitted after socket connection on attempt " + (i + 1));
                        break;
                    }
                }
            }).start();
        }
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
