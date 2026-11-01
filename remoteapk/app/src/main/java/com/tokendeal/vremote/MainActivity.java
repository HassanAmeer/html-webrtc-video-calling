package com.tokendeal.vremote;

import android.app.Activity;
import android.content.Context;
import android.content.DialogInterface;
import android.content.Intent;
import android.content.SharedPreferences;
import android.media.projection.MediaProjectionManager;
import android.net.Uri;
import android.os.Build;
import android.os.Bundle;
import android.provider.Settings;
import android.util.DisplayMetrics;
import android.view.Gravity;
import android.view.View;
import android.widget.EditText;
import android.widget.LinearLayout;
import android.widget.TextView;
import android.widget.Toast;
import androidx.appcompat.app.AlertDialog;
import androidx.appcompat.app.AppCompatActivity;
import androidx.core.content.ContextCompat;

import com.google.android.material.button.MaterialButton;
import com.google.android.material.card.MaterialCardView;
import com.google.android.material.switchmaterial.SwitchMaterial;

import org.webrtc.RendererCommon;
import org.webrtc.SurfaceViewRenderer;
import org.webrtc.VideoTrack;

import java.util.List;

public class MainActivity extends AppCompatActivity implements WebRTCCompanion.Callback {

    private static final int REQUEST_SCREEN_CAPTURE = 1001;
    private static final String PREF_NAME = "vremote_prefs";
    private static final String KEY_MY_ID = "my_user_id";

    private View statusIndicator;
    private TextView tvStatus;
    private TextView tvServerInfo;
    private EditText etMyId;
    private MaterialButton btnJoin;

    private SwitchMaterial switchFullControl;
    private TextView tvControlModeDesc;
    private MaterialButton btnEnableAccessibility;

    private EditText etTargetPeerId;
    private MaterialButton btnStartScreenShare;
    private MaterialButton btnStartVideoCall;
    private MaterialButton btnStartAudioCall;
    private MaterialButton btnStopSharing;

    private LinearLayout containerParticipants;
    private TextView tvEmptyParticipants;

    private MaterialCardView cardActiveCall;
    private TextView tvCallPartner;
    private SurfaceViewRenderer remoteSurfaceView;
    private MaterialButton btnInCallMute;
    private MaterialButton btnInCallEnd;

    private MediaProjectionManager projectionManager;
    private Intent captureIntentData = null;
    private WebRTCCompanion webRTCCompanion = null;
    private SharedPreferences prefs;

    private String targetCallUser = "";
    private boolean isMuted = false;

    @Override
    protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);
        setContentView(R.layout.activity_main);

        prefs = getSharedPreferences(PREF_NAME, MODE_PRIVATE);
        projectionManager = (MediaProjectionManager) getSystemService(Context.MEDIA_PROJECTION_SERVICE);

        initViews();
        setupWebRTC();
        handleIntent(getIntent());
    }

    private void initViews() {
        statusIndicator = findViewById(R.id.statusIndicator);
        tvStatus = findViewById(R.id.tvStatus);
        tvServerInfo = findViewById(R.id.tvServerInfo);
        etMyId = findViewById(R.id.etMyId);
        btnJoin = findViewById(R.id.btnJoin);

        switchFullControl = findViewById(R.id.switchFullControl);
        tvControlModeDesc = findViewById(R.id.tvControlModeDesc);
        btnEnableAccessibility = findViewById(R.id.btnEnableAccessibility);

        etTargetPeerId = findViewById(R.id.etTargetPeerId);
        btnStartScreenShare = findViewById(R.id.btnStartScreenShare);
        btnStartVideoCall = findViewById(R.id.btnStartVideoCall);
        btnStartAudioCall = findViewById(R.id.btnStartAudioCall);
        btnStopSharing = findViewById(R.id.btnStopSharing);

        containerParticipants = findViewById(R.id.containerParticipants);
        tvEmptyParticipants = findViewById(R.id.tvEmptyParticipants);

        cardActiveCall = findViewById(R.id.cardActiveCall);
        tvCallPartner = findViewById(R.id.tvCallPartner);
        remoteSurfaceView = findViewById(R.id.remoteSurfaceView);
        btnInCallMute = findViewById(R.id.btnInCallMute);
        btnInCallEnd = findViewById(R.id.btnInCallEnd);

        // Load saved ID or default to 10
        String savedId = prefs.getString(KEY_MY_ID, "10");
        etMyId.setText(savedId);

        btnJoin.setOnClickListener(v -> {
            String newId = etMyId.getText().toString().trim();
            if (newId.isEmpty()) {
                Toast.makeText(this, "Please enter your ID", Toast.LENGTH_SHORT).show();
                return;
            }
            prefs.edit().putString(KEY_MY_ID, newId).apply();
            if (webRTCCompanion != null) {
                webRTCCompanion.setMyId(newId);
                Toast.makeText(this, "Joined as: " + newId, Toast.LENGTH_SHORT).show();
            }
        });

        switchFullControl.setOnCheckedChangeListener((buttonView, isChecked) -> {
            if (webRTCCompanion != null) {
                webRTCCompanion.setFullControlEnabled(isChecked);
            }
            if (isChecked) {
                tvControlModeDesc.setText("Full Control: Partner can touch & click your phone screen");
            } else {
                tvControlModeDesc.setText("View Only: Partner can only view the screen (Taps disabled)");
            }
        });

        btnEnableAccessibility.setOnClickListener(v -> openAccessibilitySettings());

        btnStartScreenShare.setOnClickListener(v -> {
            String peer = etTargetPeerId.getText().toString().trim();
            if (peer.isEmpty()) {
                Toast.makeText(this, "Enter Partner ID to share screen", Toast.LENGTH_SHORT).show();
                return;
            }
            targetCallUser = peer;
            startScreenCapturePermission();
        });

        btnStartVideoCall.setOnClickListener(v -> {
            String peer = etTargetPeerId.getText().toString().trim();
            if (peer.isEmpty()) {
                Toast.makeText(this, "Enter Partner ID to video call", Toast.LENGTH_SHORT).show();
                return;
            }
            targetCallUser = peer;
            if (webRTCCompanion != null) {
                webRTCCompanion.startVideoCall(peer);
                onStatusChanged("Calling " + peer + " (Video)...", true);
            }
        });

        btnStartAudioCall.setOnClickListener(v -> {
            String peer = etTargetPeerId.getText().toString().trim();
            if (peer.isEmpty()) {
                Toast.makeText(this, "Enter Partner ID to audio call", Toast.LENGTH_SHORT).show();
                return;
            }
            targetCallUser = peer;
            if (webRTCCompanion != null) {
                webRTCCompanion.startAudioCall(peer);
                onStatusChanged("Calling " + peer + " (Audio)...", true);
            }
        });

        btnStopSharing.setOnClickListener(v -> {
            if (webRTCCompanion != null) {
                webRTCCompanion.endCall(true);
            }
        });

        btnInCallEnd.setOnClickListener(v -> {
            if (webRTCCompanion != null) {
                webRTCCompanion.endCall(true);
            }
        });

        btnInCallMute.setOnClickListener(v -> {
            isMuted = !isMuted;
            if (webRTCCompanion != null) {
                webRTCCompanion.setMicrophoneMute(isMuted);
            }
            btnInCallMute.setText(isMuted ? "Mic: MUTED" : "Mic: ON");
            btnInCallMute.setTextColor(isMuted ? ContextCompat.getColor(this, R.color.accent_red) : ContextCompat.getColor(this, R.color.text_white));
        });
    }

    private void setupWebRTC() {
        String savedId = prefs.getString(KEY_MY_ID, "10");
        webRTCCompanion = new WebRTCCompanion(this, "https://v.tokendeal.cloud", savedId, this);
        webRTCCompanion.setFullControlEnabled(switchFullControl.isChecked());

        // Initialize Remote Video Renderer
        remoteSurfaceView.init(webRTCCompanion.getEglContext(), null);
        remoteSurfaceView.setScalingType(RendererCommon.ScalingType.SCALE_ASPECT_FIT);
        remoteSurfaceView.setEnableHardwareScaler(true);
    }

    @Override
    protected void onResume() {
        super.onResume();
        updateAccessibilityState();
        if (webRTCCompanion != null) {
            webRTCCompanion.refreshUsers();
        }
    }

    private void updateAccessibilityState() {
        if (RemoteAccessibilityService.isServiceRunning()) {
            btnEnableAccessibility.setText("✓ Remote Control Service Active");
            btnEnableAccessibility.setTextColor(ContextCompat.getColor(this, R.color.accent_green));
            btnEnableAccessibility.setStrokeColorResource(R.color.accent_green);
            btnEnableAccessibility.setEnabled(false);
        } else {
            btnEnableAccessibility.setText("Grant Remote Control Permission");
            btnEnableAccessibility.setTextColor(ContextCompat.getColor(this, R.color.accent_blue));
            btnEnableAccessibility.setStrokeColorResource(R.color.accent_blue);
            btnEnableAccessibility.setEnabled(true);
        }
    }

    private void handleIntent(Intent intent) {
        if (intent != null && Intent.ACTION_VIEW.equals(intent.getAction())) {
            Uri data = intent.getData();
            if (data != null) {
                String room = data.getQueryParameter("room");
                if (room != null && !room.isEmpty()) {
                    etTargetPeerId.setText(room);
                    Toast.makeText(this, "Partner Room: " + room, Toast.LENGTH_SHORT).show();
                }
            }
        }
    }

    private void openAccessibilitySettings() {
        Toast.makeText(this, "Find 'VRemote Screen Share' and toggle it ON", Toast.LENGTH_LONG).show();
        Intent intent = new Intent(Settings.ACTION_ACCESSIBILITY_SETTINGS);
        startActivity(intent);
    }

    private void startScreenCapturePermission() {
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
                startLiveScreenStream();
            } else {
                Toast.makeText(this, "Screen capture permission was cancelled", Toast.LENGTH_SHORT).show();
            }
        }
    }

    private void startLiveScreenStream() {
        // Start Foreground Service
        Intent serviceIntent = new Intent(this, ScreenCaptureService.class);
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            startForegroundService(serviceIntent);
        } else {
            startService(serviceIntent);
        }

        DisplayMetrics displayMetrics = new DisplayMetrics();
        getWindowManager().getDefaultDisplay().getRealMetrics(displayMetrics);

        if (webRTCCompanion != null) {
            webRTCCompanion.startScreenShare(targetCallUser, captureIntentData, displayMetrics.widthPixels, displayMetrics.heightPixels);
        }

        btnStopSharing.setVisibility(View.VISIBLE);
        btnStartScreenShare.setEnabled(false);
        btnStartVideoCall.setEnabled(false);
        btnStartAudioCall.setEnabled(false);

        // Move to background so partner sees full phone screen
        moveTaskToBack(true);
    }

    // ==============================================================
    // WebRTCCompanion.Callback Implementation
    // ==============================================================

    @Override
    public void onConnected(String myId) {
        runOnUiThread(() -> {
            statusIndicator.setBackgroundResource(R.drawable.circle_green);
            tvStatus.setText("Online: " + myId);
            etMyId.setText(myId);
        });
    }

    @Override
    public void onStatusChanged(String status, boolean isLive) {
        runOnUiThread(() -> {
            tvStatus.setText(status);
            if (isLive) {
                cardActiveCall.setVisibility(View.VISIBLE);
                tvCallPartner.setText("Connected: " + (webRTCCompanion != null ? webRTCCompanion.getActivePeer() : ""));
            }
        });
    }

    @Override
    public void onParticipantsList(List<String> users) {
        runOnUiThread(() -> {
            containerParticipants.removeAllViews();
            if (users == null || users.isEmpty()) {
                tvEmptyParticipants.setVisibility(View.VISIBLE);
                containerParticipants.addView(tvEmptyParticipants);
                return;
            }

            tvEmptyParticipants.setVisibility(View.GONE);

            for (String user : users) {
                LinearLayout row = new LinearLayout(this);
                row.setOrientation(LinearLayout.HORIZONTAL);
                row.setGravity(Gravity.CENTER_VERTICAL);
                row.setPadding(0, 10, 0, 10);

                TextView tvName = new TextView(this);
                tvName.setText("👤 " + user);
                tvName.setTextColor(ContextCompat.getColor(this, R.color.text_white));
                tvName.setTextSize(14f);
                LinearLayout.LayoutParams nameParams = new LinearLayout.LayoutParams(0, LinearLayout.LayoutParams.WRAP_CONTENT, 1f);
                tvName.setLayoutParams(nameParams);
                row.addView(tvName);

                // Call / Share Button
                MaterialButton btnCall = new MaterialButton(this);
                btnCall.setText("Connect");
                btnCall.setTextSize(12f);
                btnCall.setPadding(20, 0, 20, 0);
                btnCall.setBackgroundColor(ContextCompat.getColor(this, R.color.accent_blue));
                btnCall.setOnClickListener(v -> {
                    etTargetPeerId.setText(user);
                    targetCallUser = user;
                    startScreenCapturePermission();
                });
                row.addView(btnCall);

                containerParticipants.addView(row);
            }
        });
    }

    @Override
    public void onIncomingCall(String fromUser, String callType) {
        runOnUiThread(() -> {
            new AlertDialog.Builder(this)
                    .setTitle("Incoming " + callType)
                    .setMessage(fromUser + " is calling you. Accept call?")
                    .setCancelable(false)
                    .setPositiveButton("Accept", (dialog, which) -> {
                        if (webRTCCompanion != null) {
                            webRTCCompanion.acceptIncomingCall();
                            cardActiveCall.setVisibility(View.VISIBLE);
                            tvCallPartner.setText("Connected: " + fromUser);
                        }
                    })
                    .setNegativeButton("Decline", (dialog, which) -> {
                        if (webRTCCompanion != null) {
                            webRTCCompanion.declineIncomingCall();
                        }
                    })
                    .show();
        });
    }

    @Override
    public void onRemoteVideoTrack(VideoTrack track) {
        runOnUiThread(() -> {
            remoteSurfaceView.setVisibility(View.VISIBLE);
            track.addSink(remoteSurfaceView);
        });
    }

    @Override
    public void onCallEnded() {
        runOnUiThread(() -> {
            cardActiveCall.setVisibility(View.GONE);
            remoteSurfaceView.setVisibility(View.GONE);
            btnStopSharing.setVisibility(View.GONE);
            btnStartScreenShare.setEnabled(true);
            btnStartVideoCall.setEnabled(true);
            btnStartAudioCall.setEnabled(true);

            Intent serviceIntent = new Intent(this, ScreenCaptureService.class);
            stopService(serviceIntent);

            tvStatus.setText("Call Ended");
        });
    }

    @Override
    public void onError(String error) {
        runOnUiThread(() -> {
            Toast.makeText(this, error, Toast.LENGTH_LONG).show();
            tvStatus.setText("Error: " + error);
        });
    }

    @Override
    protected void onDestroy() {
        super.onDestroy();
        if (webRTCCompanion != null) {
            webRTCCompanion.destroy();
            webRTCCompanion = null;
        }
        if (remoteSurfaceView != null) {
            remoteSurfaceView.release();
        }
    }
}
