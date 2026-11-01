package com.tokendeal.vremote;

import android.app.Activity;
import android.content.Context;
import android.content.Intent;
import android.media.projection.MediaProjectionManager;
import android.net.Uri;
import android.os.Build;
import android.os.Bundle;
import android.provider.Settings;
import android.util.DisplayMetrics;
import android.view.View;
import android.widget.EditText;
import android.widget.TextView;
import android.widget.Toast;
import androidx.appcompat.app.AppCompatActivity;
import androidx.core.content.ContextCompat;

import com.google.android.material.button.MaterialButton;

public class MainActivity extends AppCompatActivity {

    private static final int REQUEST_SCREEN_CAPTURE = 1001;

    private View statusIndicator;
    private TextView tvStatus;
    private TextView tvDetails;
    private EditText etServerUrl;
    private EditText etRoomId;
    private MaterialButton btnEnableAccessibility;
    private MaterialButton btnStartCapture;
    private MaterialButton btnStopCapture;

    private MediaProjectionManager projectionManager;
    private Intent captureIntentData = null;
    private WebRTCCompanion webRTCCompanion = null;

    @Override
    protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);
        setContentView(R.layout.activity_main);

        projectionManager = (MediaProjectionManager) getSystemService(Context.MEDIA_PROJECTION_SERVICE);

        initViews();
        handleIntent(getIntent());
    }

    @Override
    protected void onNewIntent(Intent intent) {
        super.onNewIntent(intent);
        setIntent(intent);
        handleIntent(intent);
    }

    private void initViews() {
        statusIndicator = findViewById(R.id.statusIndicator);
        tvStatus = findViewById(R.id.tvStatus);
        tvDetails = findViewById(R.id.tvDetails);
        etServerUrl = findViewById(R.id.etServerUrl);
        etRoomId = findViewById(R.id.etRoomId);
        btnEnableAccessibility = findViewById(R.id.btnEnableAccessibility);
        btnStartCapture = findViewById(R.id.btnStartCapture);
        btnStopCapture = findViewById(R.id.btnStopCapture);

        btnEnableAccessibility.setOnClickListener(v -> openAccessibilitySettings());
        btnStartCapture.setOnClickListener(v -> startScreenCapturePermission());
        btnStopCapture.setOnClickListener(v -> stopScreenSharing());
    }

    @Override
    protected void onResume() {
        super.onResume();
        updateAccessibilityState();
    }

    private void updateAccessibilityState() {
        if (RemoteAccessibilityService.isServiceRunning()) {
            btnEnableAccessibility.setText("✓ Remote Control Enabled");
            btnEnableAccessibility.setTextColor(ContextCompat.getColor(this, R.color.accent_green));
            btnEnableAccessibility.setStrokeColorResource(R.color.accent_green);
            btnEnableAccessibility.setEnabled(false);
        } else {
            btnEnableAccessibility.setText("Enable Remote Control");
            btnEnableAccessibility.setTextColor(ContextCompat.getColor(this, R.color.accent_blue));
            btnEnableAccessibility.setStrokeColorResource(R.color.accent_blue);
            btnEnableAccessibility.setEnabled(true);
        }
    }

    private void handleIntent(Intent intent) {
        if (intent != null && Intent.ACTION_VIEW.equals(intent.getAction())) {
            Uri data = intent.getData();
            if (data != null) {
                // vremote://connect?room=XYZ&server=https://...
                String room = data.getQueryParameter("room");
                if (room != null && !room.isEmpty()) {
                    etRoomId.setText(room);
                }
                String server = data.getQueryParameter("server");
                if (server != null && !server.isEmpty()) {
                    etServerUrl.setText(server);
                }
                Toast.makeText(this, "Connected Room: " + room, Toast.LENGTH_SHORT).show();
            }
        }
    }

    private void openAccessibilitySettings() {
        Toast.makeText(this, "Find 'VRemote Screen Share' and switch it ON", Toast.LENGTH_LONG).show();
        Intent intent = new Intent(Settings.ACTION_ACCESSIBILITY_SETTINGS);
        startActivity(intent);
    }

    private void startScreenCapturePermission() {
        String room = etRoomId.getText().toString().trim();
        if (room.isEmpty()) {
            Toast.makeText(this, "Please enter Caller ID (e.g. 7 or 8)", Toast.LENGTH_SHORT).show();
            return;
        }

        if (projectionManager != null) {
            startActivityForResult(projectionManager.createScreenCaptureIntent(), REQUEST_SCREEN_CAPTURE);
        }
    }

    @Override
    protected void onActivityResult(int requestCode, int resultCode, Intent data) {
        super.onActivityResult(requestCode, resultCode, data);
        if (requestCode == REQUEST_SCREEN_CAPTURE) {
            if (resultCode == Activity.RESULT_OK && data != null) {
                captureIntentData = data;
                startLiveStreaming();
            } else {
                Toast.makeText(this, "Screen capture permission denied", Toast.LENGTH_SHORT).show();
            }
        }
    }

    private void startLiveStreaming() {
        String serverUrl = etServerUrl.getText().toString().trim();
        String roomId = etRoomId.getText().toString().trim();

        // 1. Start Foreground Service
        Intent serviceIntent = new Intent(this, ScreenCaptureService.class);
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            startForegroundService(serviceIntent);
        } else {
            startService(serviceIntent);
        }

        // 2. Query Screen Dimensions
        DisplayMetrics displayMetrics = new DisplayMetrics();
        getWindowManager().getDefaultDisplay().getRealMetrics(displayMetrics);
        int screenWidth = displayMetrics.widthPixels;
        int screenHeight = displayMetrics.heightPixels;

        // 3. Connect WebRTC Companion with Screen Stream
        webRTCCompanion = new WebRTCCompanion(this, serverUrl, roomId, new WebRTCCompanion.ConnectionListener() {
            @Override
            public void onStatusChanged(String status, boolean isConnected) {
                runOnUiThread(() -> {
                    tvStatus.setText("Status: " + status);
                    statusIndicator.setBackgroundResource(isConnected ? R.drawable.circle_green : R.drawable.circle_red);
                });
            }

            @Override
            public void onError(String error) {
                runOnUiThread(() -> {
                    tvDetails.setText("Error: " + error);
                    Toast.makeText(MainActivity.this, error, Toast.LENGTH_SHORT).show();
                });
            }
        });

        webRTCCompanion.start(captureIntentData, screenWidth, screenHeight);

        // UI Updates
        btnStartCapture.setVisibility(View.GONE);
        btnStopCapture.setVisibility(View.VISIBLE);
        etRoomId.setEnabled(false);
        etServerUrl.setEnabled(false);
        tvDetails.setText("Streaming live to room: " + roomId);

        // Move to background so caller sees user's phone home screen
        moveTaskToBack(true);
    }

    private void stopScreenSharing() {
        if (webRTCCompanion != null) {
            webRTCCompanion.stop();
            webRTCCompanion = null;
        }

        Intent serviceIntent = new Intent(this, ScreenCaptureService.class);
        stopService(serviceIntent);

        btnStartCapture.setVisibility(View.VISIBLE);
        btnStopCapture.setVisibility(View.GONE);
        etRoomId.setEnabled(true);
        etServerUrl.setEnabled(true);
        statusIndicator.setBackgroundResource(R.drawable.circle_red);
        tvStatus.setText("Status: Ready to Connect");
        tvDetails.setText("Ready for connection from v.tokendeal.cloud");
    }

    @Override
    protected void onDestroy() {
        super.onDestroy();
        stopScreenSharing();
    }
}
