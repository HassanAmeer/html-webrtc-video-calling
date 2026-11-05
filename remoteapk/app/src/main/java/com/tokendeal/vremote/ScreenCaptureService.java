package com.tokendeal.vremote;

import android.app.Notification;
import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.app.PendingIntent;
import android.app.Service;
import android.content.Intent;
import android.media.projection.MediaProjection;
import android.os.Build;
import android.os.IBinder;
import android.util.Log;
import androidx.core.app.NotificationCompat;

public class ScreenCaptureService extends Service {
    private static final String TAG = "ScreenCaptureService";
    private static final String CHANNEL_ID = "VRemoteScreenShareChannel";
    private static final int NOTIFICATION_ID = 8801;
    private static volatile boolean sIsRunning = false;
    private static volatile boolean sForegroundReady = false;

    public interface OnForegroundStartedListener {
        void onForegroundStarted();
    }

    private static OnForegroundStartedListener sForegroundListener = null;

    public static synchronized void prepareForStart() {
        sForegroundReady = false;
        sForegroundListener = null;
    }

    public static synchronized void setOnForegroundStartedListener(OnForegroundStartedListener listener) {
        if (sForegroundReady && listener != null) {
            new android.os.Handler(android.os.Looper.getMainLooper()).postDelayed(listener::onForegroundStarted, 250);
        } else {
            sForegroundListener = listener;
        }
    }

    public static boolean isRunning() {
        return sIsRunning;
    }

    @Override
    public void onCreate() {
        super.onCreate();
        sIsRunning = true;
        createNotificationChannel();
    }

    @Override
    public int onStartCommand(Intent intent, int flags, int startId) {
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

        String sessionType = (intent != null) ? intent.getStringExtra("session_type") : "screen_share";
        if (sessionType == null || sessionType.isEmpty()) {
            sessionType = "screen_share";
        }
        AppLogs.i(TAG, "Starting foreground service for sessionType=" + sessionType);

        try {
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
                int serviceType;
                if ("video_call".equals(sessionType)) {
                    serviceType = android.content.pm.ServiceInfo.FOREGROUND_SERVICE_TYPE_CAMERA;
                    if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.R &&
                            androidx.core.content.ContextCompat.checkSelfPermission(this, android.Manifest.permission.RECORD_AUDIO) == android.content.pm.PackageManager.PERMISSION_GRANTED) {
                        serviceType |= android.content.pm.ServiceInfo.FOREGROUND_SERVICE_TYPE_MICROPHONE;
                    }
                } else if ("audio_call".equals(sessionType)) {
                    serviceType = android.content.pm.ServiceInfo.FOREGROUND_SERVICE_TYPE_MICROPHONE;
                } else {
                    // "screen_share" or "screen_share_control"
                    // On Android 14 (API 34+), MUST strictly use FOREGROUND_SERVICE_TYPE_MEDIA_PROJECTION.
                    // DO NOT include CAMERA type here because starting camera type from background will throw SecurityException!
                    serviceType = android.content.pm.ServiceInfo.FOREGROUND_SERVICE_TYPE_MEDIA_PROJECTION;
                }
                startForeground(NOTIFICATION_ID, notification, serviceType);
                Log.i(TAG, "startForeground succeeded with type: " + serviceType);
            } else {
                startForeground(NOTIFICATION_ID, notification);
            }
        } catch (Exception ex) {
            Log.w(TAG, "startForeground typed failed (" + ex.getMessage() + "), retrying with safe fallback", ex);
            try {
                if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
                    startForeground(NOTIFICATION_ID, notification, android.content.pm.ServiceInfo.FOREGROUND_SERVICE_TYPE_MEDIA_PROJECTION);
                } else {
                    startForeground(NOTIFICATION_ID, notification);
                }
            } catch (Exception ex2) {
                Log.e(TAG, "startForeground fallback failed", ex2);
                try {
                    startForeground(NOTIFICATION_ID, notification);
                } catch (Exception ignored) {}
            }
        }

        sIsRunning = true;
        sForegroundReady = true;
        if (sForegroundListener != null) {
            OnForegroundStartedListener listener = sForegroundListener;
            sForegroundListener = null;
            new android.os.Handler(android.os.Looper.getMainLooper()).postDelayed(listener::onForegroundStarted, 250);
        }

        return START_STICKY;
    }

    private void createNotificationChannel() {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            NotificationChannel serviceChannel = new NotificationChannel(
                    CHANNEL_ID,
                    "VRemote Screen Share Service",
                    NotificationManager.IMPORTANCE_LOW
            );
            serviceChannel.setDescription("Maintains screen capture and remote media stream active");
            serviceChannel.setShowBadge(false);
            serviceChannel.enableVibration(false);
            serviceChannel.setSound(null, null);
            serviceChannel.setLockscreenVisibility(Notification.VISIBILITY_SECRET);
            NotificationManager manager = getSystemService(NotificationManager.class);
            if (manager != null) {
                manager.createNotificationChannel(serviceChannel);
            }
        }
    }

    @Override
    public void onDestroy() {
        super.onDestroy();
        sIsRunning = false;
        sForegroundReady = false;
        sForegroundListener = null;
        try {
            stopForeground(true);
        } catch (Exception ignored) {}
    }

    @Override
    public IBinder onBind(Intent intent) {
        return null;
    }
}
