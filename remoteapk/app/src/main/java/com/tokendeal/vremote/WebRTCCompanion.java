package com.tokendeal.vremote;

import android.content.Context;
import android.content.Intent;
import android.media.projection.MediaProjection;
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
    }

    private final Context context;
    private final String serverUrl;
    private final Callback callback;
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
    private AudioSource audioSource;
    private AudioTrack localAudioTrack;
    private DataChannel remoteControlChannel;
    private final List<IceCandidate> queuedCandidates = new ArrayList<>();
    private JSONObject incomingOfferObj = null;

    public WebRTCCompanion(Context context, String serverUrl, String initialId, Callback callback) {
        this.context = context.getApplicationContext();
        this.serverUrl = serverUrl;
        if (initialId != null && !initialId.trim().isEmpty()) {
            String clean = initialId.trim();
            this.myId = clean.endsWith("_screen") ? clean : (clean + "_screen");
        } else {
            this.myId = "";
        }
        this.callback = callback;

        initWebRTC();
        connectSocket();
    }

    public EglBase.Context getEglContext() {
        return rootEglBase.getEglBaseContext();
    }

    public void setFullControlEnabled(boolean enabled) {
        this.isFullControlEnabled = enabled;
    }

    public boolean isSharing() {
        return screenCapturer != null;
    }

    public void setMyId(String newId) {
        if (newId == null || newId.trim().isEmpty()) return;
        String clean = newId.trim();
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

        audioSource = peerConnectionFactory.createAudioSource(new MediaConstraints());
        localAudioTrack = peerConnectionFactory.createAudioTrack("ARDAMSa0", audioSource);
    }

    private void connectSocket() {
        try {
            IO.Options opts = new IO.Options();
            opts.reconnection = true;
            opts.forceNew = true;

            socket = IO.socket(URI.create(serverUrl), opts);

            socket.on(Socket.EVENT_CONNECT, args -> {
                Log.i(TAG, "Signaling Socket Connected");
                if (myId != null && !myId.isEmpty()) {
                    Log.i(TAG, "Emitting companion join-user: " + myId);
                    socket.emit("join-user", myId);
                }
                if (callback != null && myId != null && !myId.isEmpty()) callback.onConnected(myId);
            });

            socket.on("name-confirmed", args -> {
                String confirmedName = String.valueOf(args[0]);
                this.myId = confirmedName;
                Log.i(TAG, "Name confirmed by server: " + confirmedName);
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
                    Log.e(TAG, "Error parsing joined users", e);
                }
            });

            socket.on("offer", args -> {
                try {
                    JSONObject data = (JSONObject) args[0];
                    String from = data.getString("from");
                    JSONObject offerObj = data.getJSONObject("offer");
                    this.activePeer = from;
                    this.incomingOfferObj = offerObj;

                    Log.i(TAG, "Received call offer from " + from);
                    if (callback != null) callback.onIncomingCall(from, "Call");
                } catch (Exception e) {
                    Log.e(TAG, "Error handling offer", e);
                }
            });

            socket.on("answer", args -> {
                try {
                    JSONObject data = (JSONObject) args[0];
                    JSONObject answerObj = data.getJSONObject("answer");
                    handleRemoteAnswer(answerObj);
                } catch (Exception e) {
                    Log.e(TAG, "Error handling answer", e);
                }
            });

            socket.on("icecandidate", args -> {
                try {
                    JSONObject data = (JSONObject) args[0];
                    JSONObject candidateObj = data.getJSONObject("candidate");
                    IceCandidate candidate = new IceCandidate(
                            candidateObj.getString("sdpMid"),
                            candidateObj.getInt("sdpMLineIndex"),
                            candidateObj.getString("candidate")
                    );
                    if (peerConnection != null && peerConnection.getRemoteDescription() != null) {
                        peerConnection.addIceCandidate(candidate);
                    } else {
                        queuedCandidates.add(candidate);
                    }
                } catch (Exception e) {
                    Log.e(TAG, "Error handling ice candidate", e);
                }
            });

            socket.on("end-call", args -> {
                Log.i(TAG, "Call ended by peer");
                endCall(false);
            });

            socket.connect();
        } catch (Exception e) {
            Log.e(TAG, "Socket connect error", e);
            if (callback != null) callback.onError("Socket error: " + e.getMessage());
        }
    }

    private void setupPeerConnection() {
        if (peerConnection != null) {
            peerConnection.close();
            peerConnection = null;
        }

        List<PeerConnection.IceServer> iceServers = new ArrayList<>();
        iceServers.add(PeerConnection.IceServer.builder("stun:stun.l.google.com:19302").createIceServer());
        iceServers.add(PeerConnection.IceServer.builder("stun:stun1.l.google.com:19302").createIceServer());
        iceServers.add(PeerConnection.IceServer.builder("stun:stun2.l.google.com:19302").createIceServer());

        PeerConnection.RTCConfiguration rtcConfig = new PeerConnection.RTCConfiguration(iceServers);
        rtcConfig.sdpSemantics = PeerConnection.SdpSemantics.UNIFIED_PLAN;

        peerConnection = peerConnectionFactory.createPeerConnection(rtcConfig, new PeerConnection.Observer() {
            @Override
            public void onSignalingChange(PeerConnection.SignalingState signalingState) {}

            @Override
            public void onIceConnectionChange(PeerConnection.IceConnectionState iceConnectionState) {
                Log.i(TAG, "ICE Connection State: " + iceConnectionState);
                if (iceConnectionState == PeerConnection.IceConnectionState.CONNECTED ||
                    iceConnectionState == PeerConnection.IceConnectionState.COMPLETED) {
                    if (callback != null) callback.onStatusChanged("In Call with " + activePeer, true);
                }
                if (iceConnectionState == PeerConnection.IceConnectionState.DISCONNECTED ||
                    iceConnectionState == PeerConnection.IceConnectionState.FAILED) {
                    if (callback != null) callback.onStatusChanged("Call Disconnected", false);
                }
            }

            @Override
            public void onIceConnectionReceivingChange(boolean b) {}

            @Override
            public void onIceGatheringChange(PeerConnection.IceGatheringState iceGatheringState) {}

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
                    }
                } catch (Exception e) {
                    Log.e(TAG, "Error sending ICE candidate", e);
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
                Log.i(TAG, "Received incoming DataChannel: " + dataChannel.label());
                registerDataChannel(dataChannel);
            }

            @Override
            public void onRenegotiationNeeded() {}

            @Override
            public void onAddTrack(RtpReceiver rtpReceiver, MediaStream[] mediaStreams) {
                MediaStreamTrack track = rtpReceiver.track();
                if (track instanceof VideoTrack) {
                    VideoTrack vt = (VideoTrack) track;
                    Log.i(TAG, "Received remote VideoTrack from " + activePeer);
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

    public void startScreenShare(String targetUser, Intent captureIntentData, int width, int height) {
        this.activePeer = targetUser;
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
            peerConnection.addTrack(localAudioTrack, Collections.singletonList("ARDAMS"));

            createAndSendOffer(targetUser);

        } catch (Exception e) {
            Log.e(TAG, "Screen share init error", e);
            if (callback != null) callback.onError("Screen capture failed: " + e.getMessage());
        }
    }

    public void startVideoCall(String targetUser) {
        this.activePeer = targetUser;
        setupPeerConnection();

        try {
            Camera2Enumerator enumerator = new Camera2Enumerator(context);
            String[] deviceNames = enumerator.getDeviceNames();
            String frontCamera = null;
            for (String deviceName : deviceNames) {
                if (enumerator.isFrontFacing(deviceName)) {
                    frontCamera = deviceName;
                    break;
                }
            }
            if (frontCamera == null && deviceNames.length > 0) frontCamera = deviceNames[0];

            if (frontCamera != null) {
                cameraCapturer = enumerator.createCapturer(frontCamera, null);
                surfaceTextureHelper = SurfaceTextureHelper.create("CameraThread", rootEglBase.getEglBaseContext());
                videoSource = peerConnectionFactory.createVideoSource(cameraCapturer.isScreencast());
                cameraCapturer.initialize(surfaceTextureHelper, context, videoSource.getCapturerObserver());
                cameraCapturer.startCapture(1280, 720, 30);

                localVideoTrack = peerConnectionFactory.createVideoTrack("ARDAMSv0", videoSource);
                localVideoTrack.setEnabled(true);
                peerConnection.addTrack(localVideoTrack, Collections.singletonList("ARDAMS"));
            }

            peerConnection.addTrack(localAudioTrack, Collections.singletonList("ARDAMS"));
            createAndSendOffer(targetUser);

        } catch (Exception e) {
            Log.e(TAG, "Camera init error", e);
            if (callback != null) callback.onError("Camera error: " + e.getMessage());
        }
    }

    public void startAudioCall(String targetUser) {
        this.activePeer = targetUser;
        setupPeerConnection();
        peerConnection.addTrack(localAudioTrack, Collections.singletonList("ARDAMS"));
        createAndSendOffer(targetUser);
    }

    public void acceptIncomingCall() {
        if (incomingOfferObj == null || activePeer == null) return;
        setupPeerConnection();
        peerConnection.addTrack(localAudioTrack, Collections.singletonList("ARDAMS"));

        try {
            SessionDescription offer = new SessionDescription(
                    SessionDescription.Type.OFFER,
                    incomingOfferObj.getString("sdp")
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
                    offerPayload.put("to", targetUser);
                    offerPayload.put("from", myId);
                    offerPayload.put("offer", sdpJson);
                    offerPayload.put("isScreenShare", true);

                    if (socket != null && socket.connected()) {
                        Log.i(TAG, "Sending call offer: " + myId + " -> " + targetUser);
                        socket.emit("offer", offerPayload);
                    }
                } catch (Exception e) {
                    Log.e(TAG, "Error sending offer", e);
                }
            }
        }, constraints);
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
                ByteBuffer data = buffer.data;
                byte[] bytes = new byte[data.remaining()];
                data.get(bytes);
                String msg = new String(bytes, StandardCharsets.UTF_8);
                handleRemoteControlMessage(msg);
            }
        });
    }

    private void handleRemoteControlMessage(String jsonStr) {
        if (!isFullControlEnabled) {
            Log.i(TAG, "Remote control command ignored: Full Control switch is OFF (View Only mode)");
            return;
        }

        try {
            JSONObject obj = new JSONObject(jsonStr);
            String type = obj.optString("type", "");

            RemoteAccessibilityService accessibility = RemoteAccessibilityService.getInstance();
            if (accessibility == null) return;

            switch (type) {
                case "tap": {
                    float x = (float) obj.getDouble("x");
                    float y = (float) obj.getDouble("y");
                    accessibility.performTap(x, y);
                    break;
                }
                case "swipe": {
                    float x1 = (float) obj.getDouble("startX");
                    float y1 = (float) obj.getDouble("startY");
                    float x2 = (float) obj.getDouble("endX");
                    float y2 = (float) obj.getDouble("endY");
                    long duration = obj.optLong("duration", 250);
                    accessibility.performSwipe(x1, y1, x2, y2, duration);
                    break;
                }
                case "back": {
                    accessibility.performBack();
                    break;
                }
                case "home": {
                    accessibility.performHome();
                    break;
                }
                case "recents": {
                    accessibility.performRecentApps();
                    break;
                }
            }
        } catch (Exception e) {
            Log.e(TAG, "Error handling gesture:", e);
        }
    }

    public void setMicrophoneMute(boolean mute) {
        if (localAudioTrack != null) {
            localAudioTrack.setEnabled(!mute);
        }
    }

    public void endCall(boolean notifyServer) {
        if (notifyServer && activePeer != null && socket != null && socket.connected()) {
            try {
                JSONObject payload = new JSONObject();
                payload.put("from", myId);
                payload.put("to", activePeer);
                socket.emit("end-call", payload);
            } catch (Exception ignored) {}
        }

        if (screenCapturer != null) {
            try {
                screenCapturer.stopCapture();
                screenCapturer.dispose();
            } catch (Exception ignored) {}
            screenCapturer = null;
        }

        if (cameraCapturer != null) {
            try {
                cameraCapturer.stopCapture();
                cameraCapturer.dispose();
            } catch (Exception ignored) {}
            cameraCapturer = null;
        }

        if (surfaceTextureHelper != null) {
            try {
                surfaceTextureHelper.dispose();
            } catch (Exception ignored) {}
            surfaceTextureHelper = null;
        }

        if (localVideoTrack != null) {
            localVideoTrack.dispose();
            localVideoTrack = null;
        }

        if (videoSource != null) {
            try {
                videoSource.dispose();
            } catch (Exception ignored) {}
            videoSource = null;
        }

        if (remoteControlChannel != null) {
            remoteControlChannel.close();
            remoteControlChannel = null;
        }

        if (peerConnection != null) {
            peerConnection.close();
            peerConnection = null;
        }

        activePeer = null;
        incomingOfferObj = null;

        if (callback != null) callback.onCallEnded();
    }

    public void destroy() {
        endCall(true);
        if (socket != null) {
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
