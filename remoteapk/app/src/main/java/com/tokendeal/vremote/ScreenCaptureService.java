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
    private static boolean sIsRunning = false;

    public interface OnForegroundStartedListener {
        void onForegroundStarted();
    }

    private static OnForegroundStartedListener sForegroundListener = null;

    public static void setOnForegroundStartedListener(OnForegroundStartedListener listener) {
        sForegroundListener = listener;
        if (sIsRunning && listener != null) {
            listener.onForegroundStarted();
            sForegroundListener = null;
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

        String sessionType = intent != null ? intent.getStringExtra("session_type") : "";
        boolean isCall = "video_call".equals(sessionType) || "audio_call".equals(sessionType);

        String notifTitle = isCall ? "VRemote Call Active" : "VRemote Screen Sharing Active";
        String notifText = isCall ? "Remote call is streaming in background" : "Live screen is streaming with Remote Control enabled";

        Notification notification = new NotificationCompat.Builder(this, CHANNEL_ID)
                .setContentTitle(notifTitle)
                .setContentText(notifText)
                .setSmallIcon(R.drawable.app_icon)
                .setContentIntent(pendingIntent)
                .setOngoing(true)
                .setPriority(NotificationCompat.PRIORITY_LOW)
                .build();

        try {
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
                int serviceType = 0;
                if (!isCall) {
                    serviceType |= android.content.pm.ServiceInfo.FOREGROUND_SERVICE_TYPE_MEDIA_PROJECTION;
                }
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
        if (sForegroundListener != null) {
            OnForegroundStartedListener listener = sForegroundListener;
            sForegroundListener = null;
            new android.os.Handler(android.os.Looper.getMainLooper()).post(listener::onForegroundStarted);
        }

        return START_STICKY;
    }

    private void createNotificationChannel() {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            NotificationChannel serviceChannel = new NotificationChannel(
                    CHANNEL_ID,
                    "VRemote Live Screen Share",
                    NotificationManager.IMPORTANCE_LOW
            );
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
        sForegroundListener = null;
        stopForeground(true);
    }

    @Override
    public IBinder onBind(Intent intent) {
        return null;
    }
}
