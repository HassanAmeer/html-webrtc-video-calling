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
import androidx.core.app.NotificationCompat;

public class ScreenCaptureService extends Service {
    private static final String CHANNEL_ID = "VRemoteScreenShareChannel";
    private static final int NOTIFICATION_ID = 8801;
    private static volatile boolean sIsRunning = false;
    private static volatile boolean sForegroundReady = false;

    public interface OnForegroundStartedListener {
        void onForegroundStarted();
    }

    private static OnForegroundStartedListener sForegroundListener = null;

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

        try {
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
                // On Android 14 (API 34+), always ensure MEDIA_PROJECTION type is active for ScreenCaptureService
                int serviceType = android.content.pm.ServiceInfo.FOREGROUND_SERVICE_TYPE_MEDIA_PROJECTION;
                if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.R) {
                    if (androidx.core.content.ContextCompat.checkSelfPermission(this, android.Manifest.permission.CAMERA) == android.content.pm.PackageManager.PERMISSION_GRANTED) {
                        serviceType |= android.content.pm.ServiceInfo.FOREGROUND_SERVICE_TYPE_CAMERA;
                    }
                    if (androidx.core.content.ContextCompat.checkSelfPermission(this, android.Manifest.permission.RECORD_AUDIO) == android.content.pm.PackageManager.PERMISSION_GRANTED) {
                        serviceType |= android.content.pm.ServiceInfo.FOREGROUND_SERVICE_TYPE_MICROPHONE;
                    }
                }
                startForeground(NOTIFICATION_ID, notification, serviceType);
            } else {
                startForeground(NOTIFICATION_ID, notification);
            }
        } catch (Exception ex) {
            android.util.Log.w("ScreenCaptureService", "startForeground typed failed, falling back to basic foreground", ex);
            try {
                startForeground(NOTIFICATION_ID, notification);
            } catch (Exception ignored) {}
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
                    "Live Screen Share",
                    NotificationManager.IMPORTANCE_MIN
            );
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
        stopForeground(true);
    }

    @Override
    public IBinder onBind(Intent intent) {
        return null;
    }
}
