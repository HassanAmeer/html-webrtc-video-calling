package com.tokendeal.vremote;

import android.content.Context;
import android.util.Log;
import org.json.JSONObject;
import org.webrtc.*;

import java.net.URI;
import java.nio.ByteBuffer;
import java.nio.charset.StandardCharsets;
import java.util.ArrayList;
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
    private final String roomId;
    private final String myId;
    private final ConnectionListener listener;

    private Socket socket;
    private PeerConnectionFactory peerConnectionFactory;
    private PeerConnection peerConnection;
    private DataChannel remoteControlChannel;
    private VideoTrack screenVideoTrack;

    public WebRTCCompanion(Context context, String serverUrl, String roomId, ConnectionListener listener) {
        this.context = context.getApplicationContext();
        this.serverUrl = serverUrl;
        this.roomId = roomId;
        this.myId = "mobile_remote_" + (int)(Math.random() * 9000 + 1000);
        this.listener = listener;

        initWebRTC();
    }

    private void initWebRTC() {
        PeerConnectionFactory.InitializationOptions initializationOptions =
                PeerConnectionFactory.InitializationOptions.builder(context)
                        .setEnableInternalTracer(false)
                        .createInitializationOptions();
        PeerConnectionFactory.initialize(initializationOptions);

        PeerConnectionFactory.Options options = new PeerConnectionFactory.Options();
        DefaultVideoEncoderFactory defaultVideoEncoderFactory =
                new DefaultVideoEncoderFactory(EglBase.create().getEglBaseContext(), true, true);
        DefaultVideoDecoderFactory defaultVideoDecoderFactory =
                new DefaultVideoDecoderFactory(EglBase.create().getEglBaseContext());

        peerConnectionFactory = PeerConnectionFactory.builder()
                .setOptions(options)
                .setVideoEncoderFactory(defaultVideoEncoderFactory)
                .setVideoDecoderFactory(defaultVideoDecoderFactory)
                .createPeerConnectionFactory();
    }

    public void setScreenVideoTrack(VideoTrack track) {
        this.screenVideoTrack = track;
    }

    public void start() {
        try {
            IO.Options opts = new IO.Options();
            opts.reconnection = true;
            opts.forceNew = true;

            socket = IO.socket(URI.create(serverUrl), opts);

            socket.on(Socket.EVENT_CONNECT, args -> {
                Log.i(TAG, "Signaling Socket Connected!");
                if (listener != null) listener.onStatusChanged("Connected to Signaling Server", true);
                socket.emit("join-user", myId);
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
                    if (peerConnection != null) {
                        peerConnection.addIceCandidate(candidate);
                    }
                } catch (Exception e) {
                    Log.e(TAG, "Error handling ice candidate", e);
                }
            });

            socket.connect();

            setupPeerConnection();

        } catch (Exception e) {
            Log.e(TAG, "Socket init error", e);
            if (listener != null) listener.onError("Connection failed: " + e.getMessage());
        }
    }

    private void setupPeerConnection() {
        List<PeerConnection.IceServer> iceServers = new ArrayList<>();
        iceServers.add(PeerConnection.IceServer.builder("stun:stun.l.google.com:19302").createIceServer());
        iceServers.add(PeerConnection.IceServer.builder("stun:stun1.l.google.com:19302").createIceServer());

        PeerConnection.RTCConfiguration rtcConfig = new PeerConnection.RTCConfiguration(iceServers);
        rtcConfig.sdpSemantics = PeerConnection.SdpSemantics.UNIFIED_PLAN;

        peerConnection = peerConnectionFactory.createPeerConnection(rtcConfig, new PeerConnection.Observer() {
            @Override
            public void onSignalingChange(PeerConnection.SignalingState signalingState) {}

            @Override
            public void onIceConnectionChange(PeerConnection.IceConnectionState iceConnectionState) {
                Log.i(TAG, "ICE Connection State: " + iceConnectionState);
                if (iceConnectionState == PeerConnection.IceConnectionState.CONNECTED) {
                    if (listener != null) listener.onStatusChanged("Live Streaming Screen & Remote Ready", true);
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
                    payload.put("to", roomId);
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

        // Add Screen Video Track to WebRTC
        if (screenVideoTrack != null && peerConnection != null) {
            peerConnection.addTrack(screenVideoTrack, java.util.Collections.singletonList("screen_stream"));
        }

        // Create Remote Control DataChannel
        DataChannel.Init init = new DataChannel.Init();
        init.ordered = true;
        remoteControlChannel = peerConnection.createDataChannel("remote-control", init);
        registerDataChannel(remoteControlChannel);
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

    /**
     * Executes touches / gestures injected by the desktop caller
     */
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

    private void handleRemoteOffer(String from, JSONObject offerObj) throws Exception {
        SessionDescription offer = new SessionDescription(
                SessionDescription.Type.OFFER,
                offerObj.getString("sdp")
        );
        peerConnection.setRemoteDescription(new SimpleSdpObserver() {
            @Override
            public void onSetSuccess() {
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
                            socket.emit("answer", ansPayload);
                        } catch (Exception e) {
                            Log.e(TAG, "Error sending answer", e);
                        }
                    }
                }, new MediaConstraints());
            }
        }, offer);
    }

    private void handleRemoteAnswer(JSONObject answerObj) throws Exception {
        SessionDescription answer = new SessionDescription(
                SessionDescription.Type.ANSWER,
                answerObj.getString("sdp")
        );
        peerConnection.setRemoteDescription(new SimpleSdpObserver(), answer);
    }

    public void stop() {
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
        @Override public void onCreateFailure(String s) {}
        @Override public void onSetFailure(String s) {}
    }
}
