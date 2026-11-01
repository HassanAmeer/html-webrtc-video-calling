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
import java.util.List;

import io.socket.client.IO;
import io.socket.client.Socket;

public class WebRTCCompanion {
    private static final String TAG = "WebRTCCompanion";

    public interface ConnectionListener {
        void onStatusChanged(String status, boolean isConnected);
        void onError(String error);
    }

    private final Context context;
    private final String serverUrl;
    private final String targetRoom;
    private final String myId;
    private final ConnectionListener listener;

    private Socket socket;
    private EglBase rootEglBase;
    private PeerConnectionFactory peerConnectionFactory;
    private PeerConnection peerConnection;
    private ScreenCapturerAndroid screenCapturer;
    private SurfaceTextureHelper surfaceTextureHelper;
    private VideoSource videoSource;
    private VideoTrack screenVideoTrack;
    private DataChannel remoteControlChannel;
    private final List<IceCandidate> queuedRemoteCandidates = new ArrayList<>();
    private boolean isDestroyed = false;

    public WebRTCCompanion(Context context, String serverUrl, String targetRoom, ConnectionListener listener) {
        this.context = context.getApplicationContext();
        this.serverUrl = serverUrl;
        this.targetRoom = targetRoom;
        this.myId = "mobile_remote_" + (int)(Math.random() * 9000 + 1000);
        this.listener = listener;

        initWebRTC();
    }

    private void initWebRTC() {
        rootEglBase = EglBase.create();

        PeerConnectionFactory.InitializationOptions initializationOptions =
                PeerConnectionFactory.InitializationOptions.builder(context)
                        .setEnableInternalTracer(false)
                        .createInitializationOptions();
        PeerConnectionFactory.initialize(initializationOptions);

        PeerConnectionFactory.Options options = new PeerConnectionFactory.Options();
        DefaultVideoEncoderFactory defaultVideoEncoderFactory =
                new DefaultVideoEncoderFactory(rootEglBase.getEglBaseContext(), true, true);
        DefaultVideoDecoderFactory defaultVideoDecoderFactory =
                new DefaultVideoDecoderFactory(rootEglBase.getEglBaseContext());

        peerConnectionFactory = PeerConnectionFactory.builder()
                .setOptions(options)
                .setVideoEncoderFactory(defaultVideoEncoderFactory)
                .setVideoDecoderFactory(defaultVideoDecoderFactory)
                .createPeerConnectionFactory();
    }

    public void start(Intent captureIntentData, int width, int height) {
        try {
            // 1. Initialize Screen Capturer with Shared EGL Context
            surfaceTextureHelper = SurfaceTextureHelper.create("ScreenCaptureThread", rootEglBase.getEglBaseContext());
            screenCapturer = new ScreenCapturerAndroid(captureIntentData, new MediaProjection.Callback() {
                @Override
                public void onStop() {
                    Log.i(TAG, "Screen capture ended via Android OS");
                    stop();
                }
            });

            videoSource = peerConnectionFactory.createVideoSource(screenCapturer.isScreencast());
            screenCapturer.initialize(surfaceTextureHelper, context, videoSource.getCapturerObserver());

            // Limit capture width to max 1080p, ensure even numbers for hardware encoders
            int capWidth = Math.min(width, 1080);
            int capHeight = (int) ((float) height * capWidth / width);
            capWidth = (capWidth / 2) * 2;
            capHeight = (capHeight / 2) * 2;

            Log.i(TAG, "Starting screen capturer at " + capWidth + "x" + capHeight + " @ 30fps");
            screenCapturer.startCapture(capWidth, capHeight, 30);

            screenVideoTrack = peerConnectionFactory.createVideoTrack("ARDAMSv0", videoSource);
            screenVideoTrack.setEnabled(true);

            // 2. Setup PeerConnection with Screen Video Track Attached
            setupPeerConnection();

            // 3. Connect Signaling Socket
            connectSocket();

        } catch (Exception e) {
            Log.e(TAG, "Failed to start WebRTC screen capturer:", e);
            if (listener != null) listener.onError("Capture failed: " + e.getMessage());
        }
    }

    private void connectSocket() {
        try {
            IO.Options opts = new IO.Options();
            opts.reconnection = true;
            opts.forceNew = true;

            socket = IO.socket(URI.create(serverUrl), opts);

            socket.on(Socket.EVENT_CONNECT, args -> {
                Log.i(TAG, "Signaling Socket Connected as: " + myId);
                if (listener != null) listener.onStatusChanged("Connected as " + myId, true);
                socket.emit("join-user", myId);

                // If targetRoom is provided, send initial call offer
                if (targetRoom != null && !targetRoom.isEmpty()) {
                    createAndSendOffer();
                }
            });

            socket.on("offer", args -> {
                try {
                    JSONObject data = (JSONObject) args[0];
                    String from = data.getString("from");
                    JSONObject offerObj = data.getJSONObject("offer");
                    handleRemoteOffer(from, offerObj);
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
                        queuedRemoteCandidates.add(candidate);
                    }
                } catch (Exception e) {
                    Log.e(TAG, "Error handling ice candidate", e);
                }
            });

            socket.connect();

        } catch (Exception e) {
            Log.e(TAG, "Socket init error", e);
            if (listener != null) listener.onError("Connection failed: " + e.getMessage());
        }
    }

    private void setupPeerConnection() {
        List<PeerConnection.IceServer> iceServers = new ArrayList<>();
        iceServers.add(PeerConnection.IceServer.builder("stun:stun.l.google.com:19302").createIceServer());
        iceServers.add(PeerConnection.IceServer.builder("stun:stun1.l.google.com:19302").createIceServer());
        iceServers.add(PeerConnection.IceServer.builder("stun:stun2.l.google.com:19302").createIceServer());

        PeerConnection.RTCConfiguration rtcConfig = new PeerConnection.RTCConfiguration(iceServers);
        rtcConfig.sdpSemantics = PeerConnection.SdpSemantics.UNIFIED_PLAN;

        peerConnection = peerConnectionFactory.createPeerConnection(rtcConfig, new PeerConnection.Observer() {
            @Override
            public void onSignalingChange(PeerConnection.SignalingState signalingState) {
                Log.d(TAG, "SignalingState: " + signalingState);
            }

            @Override
            public void onIceConnectionChange(PeerConnection.IceConnectionState iceConnectionState) {
                Log.i(TAG, "ICE Connection State: " + iceConnectionState);
                if (iceConnectionState == PeerConnection.IceConnectionState.CONNECTED ||
                    iceConnectionState == PeerConnection.IceConnectionState.COMPLETED) {
                    if (listener != null) listener.onStatusChanged("Live Streaming Screen & Remote Ready", true);
                }
                if (iceConnectionState == PeerConnection.IceConnectionState.DISCONNECTED ||
                    iceConnectionState == PeerConnection.IceConnectionState.FAILED) {
                    if (listener != null) listener.onStatusChanged("Call Disconnected", false);
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
                    payload.put("to", targetRoom);
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
            public void onAddTrack(RtpReceiver rtpReceiver, MediaStream[] mediaStreams) {}
        });

        // Add Screen Video Track to WebRTC PeerConnection
        if (screenVideoTrack != null && peerConnection != null) {
            peerConnection.addTrack(screenVideoTrack, Collections.singletonList("ARDAMS"));
            Log.i(TAG, "WebRTC Screen VideoTrack successfully added to PeerConnection!");
        }

        // Create Remote Control DataChannel
        DataChannel.Init init = new DataChannel.Init();
        init.ordered = true;
        remoteControlChannel = peerConnection.createDataChannel("remote-control", init);
        registerDataChannel(remoteControlChannel);
    }

    private void createAndSendOffer() {
        if (peerConnection == null) return;
        MediaConstraints constraints = new MediaConstraints();
        constraints.mandatory.add(new MediaConstraints.KeyValuePair("OfferToReceiveAudio", "false"));
        constraints.mandatory.add(new MediaConstraints.KeyValuePair("OfferToReceiveVideo", "false"));

        peerConnection.createOffer(new SimpleSdpObserver() {
            @Override
            public void onCreateSuccess(SessionDescription sessionDescription) {
                peerConnection.setLocalDescription(new SimpleSdpObserver(), sessionDescription);
                try {
                    JSONObject offerPayload = new JSONObject();
                    JSONObject sdpJson = new JSONObject();
                    sdpJson.put("type", "offer");
                    sdpJson.put("sdp", sessionDescription.description);
                    offerPayload.put("to", targetRoom);
                    offerPayload.put("from", myId);
                    offerPayload.put("offer", sdpJson);

                    if (socket != null && socket.connected()) {
                        Log.i(TAG, "Sending screen share offer: " + myId + " -> " + targetRoom);
                        socket.emit("offer", offerPayload);
                    }
                } catch (Exception e) {
                    Log.e(TAG, "Error sending offer", e);
                }
            }
        }, constraints);
    }

    private void handleRemoteOffer(String from, JSONObject offerObj) throws Exception {
        SessionDescription offer = new SessionDescription(
                SessionDescription.Type.OFFER,
                offerObj.getString("sdp")
        );
        peerConnection.setRemoteDescription(new SimpleSdpObserver() {
            @Override
            public void onSetSuccess() {
                drainRemoteCandidates();
                MediaConstraints sdpConstraints = new MediaConstraints();
                peerConnection.createAnswer(new SimpleSdpObserver() {
                    @Override
                    public void onCreateSuccess(SessionDescription sessionDescription) {
                        peerConnection.setLocalDescription(new SimpleSdpObserver(), sessionDescription);
                        try {
                            JSONObject ansPayload = new JSONObject();
                            JSONObject sdpJson = new JSONObject();
                            sdpJson.put("type", "answer");
                            sdpJson.put("sdp", sessionDescription.description);
                            ansPayload.put("to", from);
                            ansPayload.put("from", myId);
                            ansPayload.put("answer", sdpJson);
                            Log.i(TAG, "Sending screen share answer: " + myId + " -> " + from);
                            socket.emit("answer", ansPayload);
                        } catch (Exception e) {
                            Log.e(TAG, "Error sending answer", e);
                        }
                    }
                }, sdpConstraints);
            }
        }, offer);
    }

    private void handleRemoteAnswer(JSONObject answerObj) throws Exception {
        SessionDescription answer = new SessionDescription(
                SessionDescription.Type.ANSWER,
                answerObj.getString("sdp")
        );
        peerConnection.setRemoteDescription(new SimpleSdpObserver() {
            @Override
            public void onSetSuccess() {
                drainRemoteCandidates();
                Log.i(TAG, "Remote answer set successfully, screen video stream streaming live!");
                if (listener != null) listener.onStatusChanged("Live Streaming Screen & Remote Ready", true);
            }
        }, answer);
    }

    private void drainRemoteCandidates() {
        for (IceCandidate cand : queuedRemoteCandidates) {
            peerConnection.addIceCandidate(cand);
        }
        queuedRemoteCandidates.clear();
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
        try {
            JSONObject obj = new JSONObject(jsonStr);
            String type = obj.optString("type", "");

            RemoteAccessibilityService accessibility = RemoteAccessibilityService.getInstance();
            if (accessibility == null) {
                Log.w(TAG, "Accessibility service not running - cannot dispatch gesture");
                return;
            }

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
            Log.e(TAG, "Error handling remote control payload: " + jsonStr, e);
        }
    }

    public void stop() {
        if (isDestroyed) return;
        isDestroyed = true;

        if (screenCapturer != null) {
            try {
                screenCapturer.stopCapture();
                screenCapturer.dispose();
            } catch (Exception ignored) {}
            screenCapturer = null;
        }

        if (surfaceTextureHelper != null) {
            try {
                surfaceTextureHelper.dispose();
            } catch (Exception ignored) {}
            surfaceTextureHelper = null;
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
