package com.tokendeal.vremote;

import android.accessibilityservice.AccessibilityService;
import android.accessibilityservice.GestureDescription;
import android.content.Context;
import android.graphics.Path;
import android.os.Build;
import android.util.DisplayMetrics;
import android.util.Log;
import android.view.WindowManager;
import android.view.accessibility.AccessibilityEvent;

public class RemoteAccessibilityService extends AccessibilityService {

    private static final String TAG = "VRemoteAccessibility";
    private static RemoteAccessibilityService sInstance = null;

    public static RemoteAccessibilityService getInstance() {
        return sInstance;
    }

    public static boolean isServiceRunning() {
        return sInstance != null;
    }

    @Override
    public void onServiceConnected() {
        super.onServiceConnected();
        sInstance = this;
        Log.i(TAG, "Remote Accessibility Service Connected and Ready.");
    }

    @Override
    public void onAccessibilityEvent(AccessibilityEvent event) {
        // Not used - service is used for gesture dispatching
    }

    @Override
    public void onInterrupt() {
        Log.w(TAG, "Remote Accessibility Service Interrupted.");
    }

    @Override
    public boolean onUnbind(android.content.Intent intent) {
        sInstance = null;
        return super.onUnbind(intent);
    }

    private DisplayMetrics getRealScreenMetrics() {
        DisplayMetrics metrics = new DisplayMetrics();
        try {
            WindowManager wm = (WindowManager) getSystemService(Context.WINDOW_SERVICE);
            if (wm != null && wm.getDefaultDisplay() != null) {
                wm.getDefaultDisplay().getRealMetrics(metrics);
                return metrics;
            }
        } catch (Exception ignored) {}
        return getResources().getDisplayMetrics();
    }

    /**
     * Dispatches a tap gesture on the screen using normalized coordinates (0.0 to 1.0)
     */
    public boolean performTap(float normX, float normY) {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.N) return false;

        DisplayMetrics metrics = getRealScreenMetrics();
        float x = Math.max(0, Math.min(metrics.widthPixels, normX * metrics.widthPixels));
        float y = Math.max(0, Math.min(metrics.heightPixels, normY * metrics.heightPixels));

        Path path = new Path();
        path.moveTo(x, y);
        // Important: lineTo 1-pixel offset ensures the Path is non-empty so Android GestureDescription dispatches it reliably
        path.lineTo(x, y + 1f);

        GestureDescription.StrokeDescription stroke =
                new GestureDescription.StrokeDescription(path, 0, 60);

        GestureDescription.Builder builder = new GestureDescription.Builder();
        builder.addStroke(stroke);

        return dispatchGesture(builder.build(), new GestureResultCallback() {
            @Override
            public void onCompleted(GestureDescription gestureDescription) {
                Log.d(TAG, "Tap completed at: (" + x + ", " + y + ")");
            }

            @Override
            public void onCancelled(GestureDescription gestureDescription) {
                Log.w(TAG, "Tap cancelled at: (" + x + ", " + y + ")");
            }
        }, null);
    }

    /**
     * Dispatches a swipe / scroll gesture from start to end coordinates
     */
    public boolean performSwipe(float startNormX, float startNormY, float endNormX, float endNormY, long durationMs) {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.N) return false;

        DisplayMetrics metrics = getRealScreenMetrics();
        float x1 = Math.max(0, Math.min(metrics.widthPixels, startNormX * metrics.widthPixels));
        float y1 = Math.max(0, Math.min(metrics.heightPixels, startNormY * metrics.heightPixels));
        float x2 = Math.max(0, Math.min(metrics.widthPixels, endNormX * metrics.widthPixels));
        float y2 = Math.max(0, Math.min(metrics.heightPixels, endNormY * metrics.heightPixels));

        Path path = new Path();
        path.moveTo(x1, y1);
        path.lineTo(x2, y2);

        long duration = durationMs > 0 ? durationMs : 250;
        GestureDescription.StrokeDescription stroke =
                new GestureDescription.StrokeDescription(path, 0, duration);

        GestureDescription.Builder builder = new GestureDescription.Builder();
        builder.addStroke(stroke);

        return dispatchGesture(builder.build(), null, null);
    }

    public boolean performBack() {
        return performGlobalAction(GLOBAL_ACTION_BACK);
    }

    public boolean performHome() {
        return performGlobalAction(GLOBAL_ACTION_HOME);
    }

    public boolean performRecentApps() {
        return performGlobalAction(GLOBAL_ACTION_RECENTS);
    }
}
