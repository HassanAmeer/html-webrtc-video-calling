package com.tokendeal.vremote;

import android.content.Context;
import android.util.Log;
import org.json.JSONArray;
import org.json.JSONObject;

import java.io.BufferedReader;
import java.io.BufferedWriter;
import java.io.File;
import java.io.FileInputStream;
import java.io.FileOutputStream;
import java.io.InputStreamReader;
import java.io.OutputStreamWriter;
import java.text.SimpleDateFormat;
import java.util.ArrayList;
import java.util.Date;
import java.util.LinkedList;
import java.util.List;
import java.util.Locale;
import java.util.Set;
import java.util.concurrent.ConcurrentLinkedQueue;
import java.util.concurrent.CopyOnWriteArraySet;

import io.socket.client.Socket;

/**
 * Unified Live Runtime Logging Utility for VRemote Android Companion & Services.
 * Outputs to standard Android Logcat, appends to persistent storage (persistent_logs.jsonl),
 * buffers logs in an offline queue if disconnected, maintains a rolling history of recent
 * logs for crash reports, and streams in real-time to the Node.js signaling server and web
 * console via "client-log" socket event.
 */
public class AppLogs {
    private static final String DEFAULT_TAG = "VRemote";
    private static final String PERSISTENT_LOGS_FILE = "persistent_logs.jsonl";
    private static final int MAX_PERSISTENT_LINES = 1000;
    private static final Object FILE_LOCK = new Object();
    private static volatile Context sContext;
    private static int sPersistentLineCount = -1;

    private static final Set<Socket> sActiveSockets = new CopyOnWriteArraySet<>();
    private static final ConcurrentLinkedQueue<JSONObject> sPendingLogQueue = new ConcurrentLinkedQueue<>();
    private static final LinkedList<String> sRecentLogs = new LinkedList<>();
    private static final int MAX_PENDING_QUEUE = 120;
    private static final int MAX_RECENT_LOGS = 35;

    /**
     * Initializes the application context for persistent file logging.
     */
    public static void init(Context context) {
        if (context != null) {
            sContext = context.getApplicationContext();
        }
    }

    /**
     * Obtains the application context, falling back to VRemoteApplication if available.
     */
    public static Context getContext() {
        if (sContext != null) {
            return sContext;
        }
        VRemoteApplication app = VRemoteApplication.getInstance();
        if (app != null) {
            sContext = app.getApplicationContext();
            return sContext;
        }
        return null;
    }

    /**
     * Registers an active socket to receive live runtime logs and flushes pending logs.
     */
    public static void registerSocket(Socket socket) {
        if (socket != null) {
            sActiveSockets.add(socket);
            flushPendingLogs();
            if (socket.connected()) {
                flushPersistentLogs(socket);
            }
        }
    }

    /**
     * Unregisters a disconnected or closed socket.
     */
    public static void unregisterSocket(Socket socket) {
        if (socket != null) {
            sActiveSockets.remove(socket);
        }
    }

    /**
     * Emits a socket event and payload to all connected active sockets.
     * Returns true if emitted to at least one active socket.
     */
    public static boolean emitToActiveSockets(String event, JSONObject payload) {
        if (event == null || payload == null) return false;
        boolean emitted = false;
        for (Socket s : sActiveSockets) {
            if (s != null && s.connected()) {
                try {
                    s.emit(event, payload);
                    emitted = true;
                } catch (Exception ignored) {}
            }
        }
        return emitted;
    }

    /**
     * Flushes queued offline logs once a socket connects.
     */
    public static synchronized void flushPendingLogs() {
        Socket active = null;
        for (Socket s : sActiveSockets) {
            if (s != null && s.connected()) {
                active = s;
                break;
            }
        }
        if (active == null) return;

        while (!sPendingLogQueue.isEmpty()) {
            JSONObject entry = sPendingLogQueue.poll();
            if (entry != null) {
                try {
                    active.emit("client-log", entry);
                } catch (Exception ignored) {}
            }
        }
    }

    /**
     * Appends a log entry JSONObject to persistent_logs.jsonl in thread-safe manner,
     * maintaining a maximum rotation limit of 1000 lines.
     */
    public static void appendPersistentLog(JSONObject obj) {
        if (obj == null) return;
        Context ctx = getContext();
        if (ctx == null) return;

        synchronized (FILE_LOCK) {
            try {
                File logFile = new File(ctx.getFilesDir(), PERSISTENT_LOGS_FILE);
                if (sPersistentLineCount < 0) {
                    sPersistentLineCount = 0;
                    if (logFile.exists()) {
                        try (BufferedReader reader = new BufferedReader(new InputStreamReader(new FileInputStream(logFile), "UTF-8"))) {
                            while (reader.readLine() != null) {
                                sPersistentLineCount++;
                            }
                        }
                    }
                }

                if (sPersistentLineCount >= MAX_PERSISTENT_LINES) {
                    trimPersistentLogs(logFile, 800);
                }

                String line = obj.toString() + "\n";
                try (FileOutputStream fos = new FileOutputStream(logFile, true)) {
                    fos.write(line.getBytes("UTF-8"));
                    fos.flush();
                }
                sPersistentLineCount++;
            } catch (Throwable t) {
                Log.e(DEFAULT_TAG, "Error writing to " + PERSISTENT_LOGS_FILE, t);
            }
        }
    }

    private static void trimPersistentLogs(File logFile, int keepLines) {
        try {
            if (!logFile.exists()) return;
            List<String> lines = new ArrayList<>();
            try (BufferedReader reader = new BufferedReader(new InputStreamReader(new FileInputStream(logFile), "UTF-8"))) {
                String l;
                while ((l = reader.readLine()) != null) {
                    lines.add(l);
                }
            }
            int total = lines.size();
            int from = Math.max(0, total - keepLines);
            List<String> retained = lines.subList(from, total);
            try (BufferedWriter bw = new BufferedWriter(new OutputStreamWriter(new FileOutputStream(logFile, false), "UTF-8"))) {
                for (String line : retained) {
                    bw.write(line);
                    bw.newLine();
                }
                bw.flush();
            }
            sPersistentLineCount = retained.size();
        } catch (Throwable t) {
            Log.e(DEFAULT_TAG, "Error trimming " + PERSISTENT_LOGS_FILE, t);
        }
    }

    /**
     * Reads all lines from persistent_logs.jsonl, emits them in batch to socket.emit("flush-device-logs", jsonArray),
     * and clears or truncates the file.
     */
    public static void flushPersistentLogs(Socket socket) {
        if (socket == null || !socket.connected()) return;
        Context ctx = getContext();
        if (ctx == null) return;

        synchronized (FILE_LOCK) {
            File logFile = new File(ctx.getFilesDir(), PERSISTENT_LOGS_FILE);
            if (!logFile.exists() || logFile.length() == 0) return;

            JSONArray jsonArray = new JSONArray();
            try (BufferedReader reader = new BufferedReader(new InputStreamReader(new FileInputStream(logFile), "UTF-8"))) {
                String line;
                while ((line = reader.readLine()) != null) {
                    line = line.trim();
                    if (!line.isEmpty()) {
                        try {
                            jsonArray.put(new JSONObject(line));
                        } catch (Exception parseEx) {
                            JSONObject rawObj = new JSONObject();
                            rawObj.put("msg", line);
                            jsonArray.put(rawObj);
                        }
                    }
                }
            } catch (Throwable t) {
                Log.e(DEFAULT_TAG, "Error reading " + PERSISTENT_LOGS_FILE + " for flush", t);
            }

            if (jsonArray.length() > 0) {
                try {
                    socket.emit("flush-device-logs", jsonArray);
                    Log.i(DEFAULT_TAG, "Flushed " + jsonArray.length() + " persistent logs to socket");
                } catch (Throwable t) {
                    Log.e(DEFAULT_TAG, "Error emitting flush-device-logs to socket", t);
                }
            }

            try {
                new FileOutputStream(logFile, false).close();
                sPersistentLineCount = 0;
                Log.i(DEFAULT_TAG, PERSISTENT_LOGS_FILE + " cleared after live flush");
            } catch (Throwable t) {
                Log.e(DEFAULT_TAG, "Error truncating " + PERSISTENT_LOGS_FILE, t);
            }
        }
    }

    /**
     * Flushes persistent logs to the first available connected socket.
     */
    public static void flushPersistentLogsToActiveSockets() {
        for (Socket s : sActiveSockets) {
            if (s != null && s.connected()) {
                flushPersistentLogs(s);
                break;
            }
        }
    }

    /**
     * Returns the last 30 log lines as a JSON array string for embedding in crash reports.
     */
    public static synchronized String getRecentLogsJson() {
        JSONArray arr = new JSONArray();
        for (String line : sRecentLogs) {
            arr.put(line);
        }
        return arr.toString();
    }

    /**
     * Main dispatch method for all log levels.
     */
    public static void log(String level, String tag, String msg) {
        String useTag = (tag != null && !tag.isEmpty()) ? tag : DEFAULT_TAG;
        String safeMsg = msg != null ? msg : "";

        // 1. Android Logcat output
        String normalizedLevel = "info";
        if ("error".equalsIgnoreCase(level) || "e".equalsIgnoreCase(level)) {
            Log.e(useTag, safeMsg);
            normalizedLevel = "error";
        } else if ("warn".equalsIgnoreCase(level) || "w".equalsIgnoreCase(level)) {
            Log.w(useTag, safeMsg);
            normalizedLevel = "warn";
        } else if ("debug".equalsIgnoreCase(level) || "d".equalsIgnoreCase(level)) {
            Log.d(useTag, safeMsg);
            normalizedLevel = "debug";
        } else {
            Log.i(useTag, safeMsg);
            normalizedLevel = "info";
        }

        String timeStr = new SimpleDateFormat("HH:mm:ss", Locale.getDefault()).format(new Date());

        // 2. Add to rolling history for crash context
        synchronized (sRecentLogs) {
            sRecentLogs.add("[" + timeStr + "] [" + normalizedLevel.toUpperCase() + "] [" + useTag + "] " + safeMsg);
            if (sRecentLogs.size() > MAX_RECENT_LOGS) {
                sRecentLogs.removeFirst();
            }
        }

        // 3. Stream to Node.js / Web Live Logs Console & save to persistent storage
        try {
            JSONObject obj = new JSONObject();
            obj.put("source", "android");
            obj.put("level", normalizedLevel);
            obj.put("tag", useTag);
            obj.put("msg", safeMsg);
            obj.put("time", timeStr);
            obj.put("timestamp", System.currentTimeMillis());

            // Always append to persistent_logs.jsonl
            appendPersistentLog(obj);

            boolean sent = false;
            for (Socket s : sActiveSockets) {
                if (s != null && s.connected()) {
                    s.emit("client-log", obj);
                    sent = true;
                    break;
                }
            }

            // If no active socket is connected, buffer the log in offline queue
            if (!sent) {
                sPendingLogQueue.add(obj);
                while (sPendingLogQueue.size() > MAX_PENDING_QUEUE) {
                    sPendingLogQueue.poll();
                }
            }
        } catch (Exception ignored) {}
    }

    public static void i(String tag, String msg) {
        log("info", tag, msg);
    }

    public static void w(String tag, String msg) {
        log("warn", tag, msg);
    }

    public static void e(String tag, String msg) {
        log("error", tag, msg);
    }

    public static void e(String tag, String msg, Throwable tr) {
        String detail = safeDetail(msg, tr);
        log("error", tag, detail);
    }

    public static void d(String tag, String msg) {
        log("debug", tag, msg);
    }

    private static String safeDetail(String msg, Throwable tr) {
        if (tr == null) return msg != null ? msg : "";
        String trMsg = tr.getMessage();
        if (trMsg == null || trMsg.isEmpty()) {
            trMsg = tr.getClass().getSimpleName();
        }
        return (msg != null ? msg + " | " : "") + trMsg;
    }
}