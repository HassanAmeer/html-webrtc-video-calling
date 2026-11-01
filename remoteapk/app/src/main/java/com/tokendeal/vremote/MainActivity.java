package com.tokendeal.vremote;

import android.Manifest;
import android.app.Activity;
import android.app.PictureInPictureParams;
import android.content.Context;
import android.content.Intent;
import android.content.pm.PackageManager;
import android.content.res.Configuration;
import android.graphics.Bitmap;
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
import androidx.appcompat.app.AppCompatActivity;
import androidx.core.app.ActivityCompat;
import androidx.core.content.ContextCompat;

import org.webrtc.VideoTrack;

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

    private String pendingTargetPeer = "";
    private boolean isFullControlEnabled = true;

    @Override
    protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);
        setContentView(R.layout.activity_main);

        projectionManager = (MediaProjectionManager) getSystemService(Context.MEDIA_PROJECTION_SERVICE);

        requestAppPermissions();
        initWebView();
        initWebRTC();
    }

    private void requestAppPermissions() {
        String[] permissions = new String[]{
                Manifest.permission.CAMERA,
                Manifest.permission.RECORD_AUDIO,
                Manifest.permission.MODIFY_AUDIO_SETTINGS
        };

        boolean needsRequest = false;
        for (String perm : permissions) {
            if (ContextCompat.checkSelfPermission(this, perm) != PackageManager.PERMISSION_GRANTED) {
                needsRequest = true;
                break;
            }
        }

        if (needsRequest) {
            ActivityCompat.requestPermissions(this, permissions, REQUEST_PERMISSIONS);
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
    }

    private void initWebRTC() {
        webRTCCompanion = new WebRTCCompanion(this, APP_URL, "", this);
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
        public void startScreenCapture(String targetPeer, boolean fullControl) {
            pendingTargetPeer = (targetPeer != null && !targetPeer.isEmpty()) ? targetPeer : "";
            isFullControlEnabled = fullControl;

            if (webRTCCompanion != null) {
                webRTCCompanion.setFullControlEnabled(fullControl);
            }

            runOnUiThread(() -> {
                if (projectionManager != null) {
                    startActivityForResult(projectionManager.createScreenCaptureIntent(), REQUEST_SCREEN_CAPTURE);
                }
            });
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
                webRTCCompanion.startScreenShare(pendingTargetPeer, captureIntentData, displayMetrics.widthPixels, displayMetrics.heightPixels);
            }

            Toast.makeText(MainActivity.this, "Screen sharing started to " + pendingTargetPeer, Toast.LENGTH_SHORT).show();

            // Give WebRTC negotiation a moment to establish, then switch to floating WhatsApp-style PiP window
            if (webView != null) {
                webView.postDelayed(MainActivity.this::enterWhatsAppStylePipOrBack, 1000);
            } else {
                enterWhatsAppStylePipOrBack();
            }
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
        // Float like WhatsApp when home button is pressed during active share
        if (ScreenCaptureService.isRunning() || (webRTCCompanion != null && webRTCCompanion.isSharing())) {
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
        if (webRTCCompanion != null) {
            webRTCCompanion.destroy();
            webRTCCompanion = null;
        }
        if (webView != null) {
            webView.destroy();
        }
    }
}
