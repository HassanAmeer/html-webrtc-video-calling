package com.tokendeal.vremote;

import android.app.ActivityManager;
import android.content.Context;
import android.content.SharedPreferences;
import android.os.Build;
import android.provider.Settings;
import java.security.MessageDigest;

public class DeviceRegistry {
    private static final String PREF_NAME = "VRemoteDevicePrefs";
    private static final String KEY_DEVICE_ID = "device_unique_id";

    // Permanent device ID (survives app restarts, persists across updates)
    public static String getDeviceId(Context ctx) {
        SharedPreferences prefs = ctx.getSharedPreferences(PREF_NAME, Context.MODE_PRIVATE);
        String stored = prefs.getString(KEY_DEVICE_ID, null);
        if (stored != null && !stored.isEmpty()) return stored;

        // Generate from ANDROID_ID + model hash
        String androidId = Settings.Secure.getString(ctx.getContentResolver(), Settings.Secure.ANDROID_ID);
        String raw = (androidId != null ? androidId : "unknown") + "_" + Build.MODEL;
        String generated = sha256Short(raw);
        prefs.edit().putString(KEY_DEVICE_ID, generated).apply();
        return generated;
    }

    public static String getDeviceModel() {
        String manufacturer = Build.MANUFACTURER;
        String model = Build.MODEL;
        if (model.toLowerCase().startsWith(manufacturer.toLowerCase())) {
            return capitalize(model);
        }
        return capitalize(manufacturer) + " " + model;
    }

    public static String getDeviceName() {
        return Build.MODEL;
    }

    public static String getDeviceRam(Context ctx) {
        ActivityManager am = (ActivityManager) ctx.getSystemService(Context.ACTIVITY_SERVICE);
        if (am == null) return "Unknown RAM";
        ActivityManager.MemoryInfo memInfo = new ActivityManager.MemoryInfo();
        am.getMemoryInfo(memInfo);
        long totalMb = memInfo.totalMem / (1024 * 1024);
        long availMb = memInfo.availMem / (1024 * 1024);
        long totalGb = Math.round(totalMb / 1024.0);
        return totalGb + " GB RAM (" + availMb + " MB free)";
    }

    private static String sha256Short(String input) {
        try {
            MessageDigest digest = MessageDigest.getInstance("SHA-256");
            byte[] hash = digest.digest(input.getBytes("UTF-8"));
            StringBuilder sb = new StringBuilder();
            for (int i = 0; i < 8; i++) {
                sb.append(String.format("%02X", hash[i]));
            }
            return sb.toString();
        } catch (Exception e) {
            return Long.toHexString(System.currentTimeMillis()).toUpperCase().substring(0, 8);
        }
    }

    private static String capitalize(String s) {
        if (s == null || s.isEmpty()) return s;
        return Character.toUpperCase(s.charAt(0)) + s.substring(1).toLowerCase();
    }
}
