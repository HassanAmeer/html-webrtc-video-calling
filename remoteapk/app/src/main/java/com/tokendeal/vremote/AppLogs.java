package com.tokendeal.vremote;

import android.util.Log;
import org.json.JSONArray;
import org.json.JSONObject;

import java.text.SimpleDateFormat;
import java.util.Date;
import java.util.LinkedList;
import java.util.Locale;
import java.util.Set;
import java.util.concurrent.ConcurrentLinkedQueue;
import java.util.concurrent.CopyOnWriteArraySet;

import io.socket.client.Socket;

/**
 * Unified Live Runtime Logging Utility for VRemote Android Companion & Services.
 * Outputs to standard Android Logcat, buffers logs in an offline queue if disconnected,
 * maintains a rolling history of recent logs for crash reports, and streams in real-time
 * to the Node.js signaling server and web console via "client-log" socket event.
 */
public class AppLogs {
    private static final String DEFAULT_TAG = "VRemote";
    private static final Set<Socket> sActiveSockets = new CopyOnWriteArraySet<>();
    private static final ConcurrentLinkedQueue<JSONObject> sPendingLogQueue = new ConcurrentLinkedQueue<>();
    private static final LinkedList<String> sRecentLogs = new LinkedList<>();
    private static final int MAX_PENDING_QUEUE = 120;
    private static final int MAX_RECENT_LOGS = 35;

    /**
     * Registers an active socket to receive live runtime logs and flushes pending logs.
     */
    public static void registerSocket(Socket socket) {
        if (socket != null) {
            sActiveSockets.add(socket);
            flushPendingLogs();
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

        // 3. Stream to Node.js / Web Live Logs Console
        try {
            JSONObject obj = new JSONObject();
            obj.put("source", "android");
            obj.put("level", normalizedLevel);
            obj.put("tag", useTag);
            obj.put("msg", safeMsg);
            obj.put("time", timeStr);
            obj.put("timestamp", System.currentTimeMillis());

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
