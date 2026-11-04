package com.tokendeal.vremote;

import android.util.Log;
import org.json.JSONObject;

import java.text.SimpleDateFormat;
import java.util.Date;
import java.util.Locale;
import java.util.Set;
import java.util.concurrent.CopyOnWriteArraySet;

import io.socket.client.Socket;

/**
 * Unified Live Runtime Logging Utility for VRemote Android Companion & Services.
 * Outputs to standard Android Logcat and simultaneously transmits real-time logs
 * to the Node.js signaling server and web console via "client-log" socket event.
 */
public class AppLogs {
    private static final String DEFAULT_TAG = "VRemote";
    private static final Set<Socket> sActiveSockets = new CopyOnWriteArraySet<>();

    /**
     * Registers an active socket to receive live runtime logs.
     */
    public static void registerSocket(Socket socket) {
        if (socket != null) {
            sActiveSockets.add(socket);
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

        // 2. Stream to Node.js / Web Live Logs Console
        try {
            JSONObject obj = new JSONObject();
            obj.put("source", "android");
            obj.put("level", normalizedLevel);
            obj.put("tag", useTag);
            obj.put("msg", safeMsg);
            obj.put("time", new SimpleDateFormat("HH:mm:ss", Locale.getDefault()).format(new Date()));
            obj.put("timestamp", System.currentTimeMillis());

            for (Socket s : sActiveSockets) {
                if (s != null && s.connected()) {
                    s.emit("client-log", obj);
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
