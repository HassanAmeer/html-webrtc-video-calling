// Main WebRTC & Socket Client
function isNativeAndroidApp() {
    return !!(window.VRemoteNative && typeof window.VRemoteNative.isNativeApp === "function" && window.VRemoteNative.isNativeApp());
}

// Global Unified Client Logging Dispatcher
window.sendClientLog = window.sendClientLog || function(level, tag, msg) {
    try {
        const isApp = isNativeAndroidApp() || typeof window.Android !== "undefined";
        const entry = {
            source: isApp ? "android-web" : "browser",
            level: level || "info",
            tag: tag || "Client",
            msg: typeof msg === "object" ? JSON.stringify(msg) : String(msg || ""),
            time: new Date().toLocaleTimeString(),
            timestamp: Date.now()
        };
        if (window.socket && window.socket.connected) {
            window.socket.emit("client-log", entry);
        } else {
            fetch("/api/logs", {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify(entry)
            }).catch(() => {});
        }
    } catch (_) {}
};

// Global Error & Promise Rejection Diagnostics
window.addEventListener("error", (e) => {
    try {
        if (typeof window.sendClientLog === "function") {
            window.sendClientLog("error", "WebUncaught", `${e.message} at ${e.filename || 'unknown'}:${e.lineno || 0}:${e.colno || 0}`);
        }
    } catch (_) {}
});

window.addEventListener("unhandledrejection", (e) => {
    try {
        if (typeof window.sendClientLog === "function") {
            const reason = e.reason ? (e.reason.stack || e.reason.message || String(e.reason)) : "Unknown rejection";
            window.sendClientLog("error", "WebPromise", reason);
        }
    } catch (_) {}
});

// Global UI Containers & Controls (Declared at top to prevent TDZ ReferenceErrors)
const localVideoContainer = document.getElementById("local-video-container") || document.querySelector(".local-video");
const callControlsDock = document.getElementById("call-controls");
const btnCollapseBar = document.getElementById("btn-collapse-bar");
const btnExpandBar = document.getElementById("btn-expand-bar");
const floatingEndCallBtn = document.getElementById("floating-end-call-btn");
const btnBarEndCall = document.getElementById("btn-bar-end-call");
const floatingEndStreamBtn = document.getElementById("floating-end-stream-btn");

const createUserBtn = document.getElementById("create-user");
const usernameInput = document.getElementById("username");
const allusersHtml = document.getElementById("allusers");
const participantCount = document.getElementById("participant-count");
const localVideo = document.getElementById("localVideo");
const remoteVideo = document.getElementById("remoteVideo");
const remoteAudio = document.getElementById("remoteAudio");
const endCallBtn = document.getElementById("floating-end-call-btn");
const toggleFreezeBtn = document.getElementById("toggle-freeze");
const unfreezeBtn = document.getElementById("unfreeze-btn");
const freezeOverlay = document.getElementById("freeze-overlay");
const toggleQualityBtn = document.getElementById("toggle-quality");
const qualityBadge = document.getElementById("quality-badge");
const toggleFitBtn = document.getElementById("toggle-fit");
const togglePipBtn = document.getElementById("toggle-pip");
const toggleMoreMenuBtn = document.getElementById("toggle-more-menu");

// Settings Modal Elements
const settingsModal = document.getElementById("settings-modal");
const closeSettingsBtn = document.getElementById("close-settings-btn");
const launchPipBtn = document.getElementById("launch-pip-btn");
const settingStrictPip = document.getElementById("setting-strict-pip");
const settingQualitySelect = document.getElementById("setting-quality-select");
const settingFitSelect = document.getElementById("setting-fit-select");
const settingMirrorCamera = document.getElementById("setting-mirror-camera");
const settingCameraSelect = document.getElementById("setting-camera-select");
const btnSwitchCamera = document.getElementById("btn-switch-camera");
const btnLocalSwitchCam = document.getElementById("btn-local-switch-cam");

// Active Call Bar
const activeCallBar = document.getElementById("active-call-bar");
const activeCallName = document.getElementById("active-call-name");
const barQualityToggle = document.getElementById("bar-quality-toggle");
const barQualityText = document.getElementById("bar-quality-text");

const socket = io();
window.socket = socket;

// Video Quality Profiles
const QUALITY_PROFILES = {
    HD: {
        label: "HD",
        description: "1080p Crisp & High Bitrate",
        videoConstraints: {
            width: { ideal: 1920 },
            height: { ideal: 1080 },
            frameRate: { ideal: 30 }
        },
        maxBitrate: 3500000 // 3.5 Mbps for crystal clear HD
    },
    SD: {
        label: "SD",
        description: "Normal / Smooth for Slow Networks",
        videoConstraints: {
            width: { ideal: 640 },
            height: { ideal: 480 },
            frameRate: { ideal: 24 }
        },
        maxBitrate: 800000 // 800 kbps for stable connection
    }
};

// Preferences & State
let myUsername = "";
let hasJoined = false;
let activePeer = null;
let peerConnection = null;
let pendingIceCandidates = [];
let localStream = null;
let isFrozen = false;
let currentQuality = localStorage.getItem("webrtc_video_quality") || "HD";
let isFitCover = (localStorage.getItem("webrtc_fit_mode") === "cover");
let isStrictPip = (localStorage.getItem("webrtc_strict_pip") !== "false");
let isMirrorCamera = (localStorage.getItem("webrtc_mirror_camera") !== "false");
let currentFacingMode = localStorage.getItem("webrtc_facing_mode") || "user";
let isCameraOn = true;
let isMicOn = true;
let isAudioCallMode = false;
let isScreenSharing = false;
let screenPeerConnection = null;
let savedCameraStream = null;
let isLocalVideoVisible = true;
let isRemoteVideoVisible = true;
let autoCallTarget = null;
let hasAutoCalled = false;
let latestUsers = {};
let callingPeer = null;
let incomingCallData = null;
let activeSessionDevices = new Set();
let cachedDevices = [];
let pendingRegisteredDeviceCall = null;

// Helper to normalize device IDs across screen shares and mobile remote names
function normalizeDeviceId(id) {
    if (!id) return "";
    return String(id).replace(/_screen$/, "").replace(/^mobile_remote_/, "").trim();
}
window.normalizeDeviceId = normalizeDeviceId;
let decoyClickCount = 0;
let decoyToastTimeout = null;
let holdAcceptTimer = null;
let holdStartTime = 0;
let ringAudioCtx = null;
let ringInterval = null;

// Hardware Media Track Registry (Prevents any leaked tracks from staying active in background)
const allLiveMediaTracks = new Set();
function registerTrack(track) {
    if (!track) return;
    allLiveMediaTracks.add(track);
    try {
        track.addEventListener("ended", () => {
            allLiveMediaTracks.delete(track);
        });
    } catch (_) {}
}
let outgoingAudioCtx = null;
let outgoingWaveInterval = null;

// Marks the native app as "in call" before media is acquired. This both
// bypasses the hidden-tab media guard (the stealth phone usually keeps the
// WebView backgrounded) and lets MainActivity raise the media foreground
// service so the camera keeps working while the screen is off.
function notifyNativeCallActive() {
    if (typeof isNativeAndroidApp === "function" && !isNativeAndroidApp()) return;
    try {
        if (window.VRemoteNative && typeof window.VRemoteNative.setCallActive === "function") {
            window.VRemoteNative.setCallActive(true);
        }
    } catch (_) {}
}

// Comprehensive Call & Stream Active Status Check
function isCallOrStreamActive() {
    if (window.VRemoteNative && typeof window.VRemoteNative.isInCall === "function") {
        try {
            if (window.VRemoteNative.isInCall()) return true;
        } catch (_) {}
    }
    const hasPeer = Boolean(activePeer || callingPeer || incomingCallData);
    const hasPc = Boolean(peerConnection && peerConnection.connectionState !== "closed" && peerConnection.signalingState !== "closed");
    const hasScreen = Boolean(isScreenSharing || (typeof screenPeerConnection !== "undefined" && screenPeerConnection && screenPeerConnection.connectionState !== "closed" && screenPeerConnection.signalingState !== "closed"));
    const hasActiveDevice = Boolean(activeSessionDevices && activeSessionDevices.size > 0);
    return Boolean(hasPeer || hasPc || hasScreen || hasActiveDevice);
}

const rtcConfig = {
    iceServers: [
        { urls: "stun:stun.l.google.com:19302" },
        { urls: "stun:stun1.l.google.com:19302" },
        { urls: "stun:stun.cloudflare.com:3478" },
        {
            urls: [
                "turn:201.18.218.29:3478?transport=udp",
                "turn:201.18.218.29:3478?transport=tcp"
            ],
            username: "webrtc",
            credential: "webrtcpass123"
        },
        {
            urls: [
                "turn:openrelay.metered.ca:80",
                "turn:openrelay.metered.ca:443",
                "turn:openrelay.metered.ca:443?transport=tcp"
            ],
            username: "openrelayproject",
            credential: "openrelayproject"
        }
    ],
    iceCandidatePoolSize: 10,
    bundlePolicy: "max-bundle",
    rtcpMuxPolicy: "require"
};

// Toast Notifications
let toastTimeout = null;
function showToast(message) {
    const toast = document.getElementById("toast-notice");
    if (!toast) return;
    toast.textContent = message;
    toast.classList.add("show");
    if (toastTimeout) clearTimeout(toastTimeout);
    const duration = Math.max(3200, Math.min(5200, (message ? message.length : 0) * 70));
    toastTimeout = setTimeout(() => {
        toast.classList.remove("show");
    }, duration);
}

// ==============================================================
// SPEAKER & INCOMING AUDIO VOLUME CONTROLS
// ==============================================================
let isSpeakerMuted = (localStorage.getItem("webrtc_speaker_muted") === "true");
let currentVolume = parseInt(localStorage.getItem("webrtc_speaker_volume") || "100", 10);
if (isNaN(currentVolume)) currentVolume = 100;

let audioCtx = null;
let gainNode = null;
let remoteAudioSource = null;
let localAudioSource = null;
let remoteAnalyserNode = null;
let remoteAnalyserData = null;
let localAnalyserNode = null;
let localAnalyserData = null;
let meterAnimFrame = null;

function ensureAudioContextResumed() {
    if (audioCtx && audioCtx.state === "suspended") {
        audioCtx.resume().catch(() => {});
    }
}
window.addEventListener("click", ensureAudioContextResumed, { passive: true });
window.addEventListener("touchstart", ensureAudioContextResumed, { passive: true });

const toggleSpeaker = document.getElementById("toggle-speaker");
const speakerIcon = document.getElementById("speaker-icon");
const volumePopover = document.getElementById("volume-popover");
const btnPopoverMute = document.getElementById("btn-popover-mute");
const remoteVolumeSlider = document.getElementById("remote-volume-slider");
const volumeSliderLabel = document.getElementById("volume-slider-label");
const barSpeakerToggle = document.getElementById("bar-speaker-toggle");
const barSpeakerIcon = document.getElementById("bar-speaker-icon");

const btnSettingMuteSpeaker = document.getElementById("btn-setting-mute-speaker");
const settingSpeakerIcon = document.getElementById("setting-speaker-icon");
const settingSpeakerText = document.getElementById("setting-speaker-text");
const settingVolumeSlider = document.getElementById("setting-volume-slider");
const settingVolumeLabel = document.getElementById("setting-volume-label");

// Single Volume Progress Bar Overlay Elements: Left Sound Icon + 1 Gray-to-White Bar
const volumeHudBar = document.getElementById("volume-hud-bar");
const volumeHudFill = document.getElementById("volume-hud-fill");
const volumeHudIcon = document.getElementById("volume-hud-icon");
const volumeHudTrack = document.getElementById("volume-hud-track");

let volumeHudHideTimer = null;

function flashVolumeHud(autoHide = true) {
    if (!volumeHudBar) return;
    volumeHudBar.style.display = "inline-flex";
    if (volumeHudHideTimer) clearTimeout(volumeHudHideTimer);
    if (autoHide) {
        volumeHudHideTimer = setTimeout(() => {
            if (volumeHudBar) volumeHudBar.style.display = "none";
        }, 2200);
    }
}

function updateVolumeHudUI() {
    const isMuted = isSpeakerMuted || currentVolume === 0;
    if (volumeHudFill) {
        volumeHudFill.style.width = isMuted ? "0%" : `${currentVolume}%`;
        volumeHudFill.classList.toggle("muted", isMuted);
    }
    if (volumeHudIcon) {
        if (isMuted) {
            volumeHudIcon.className = "fas fa-volume-mute volume-hud-sound-icon muted";
            volumeHudIcon.title = "Volume: Muted (Click to Unmute)";
        } else if (currentVolume <= 40) {
            volumeHudIcon.className = "fas fa-volume-down volume-hud-sound-icon";
            volumeHudIcon.title = `Volume: ${currentVolume}% (Click to Mute)`;
        } else {
            volumeHudIcon.className = "fas fa-volume-up volume-hud-sound-icon";
            volumeHudIcon.title = `Volume: ${currentVolume}% (Click to Mute)`;
        }
    }
    const btnHudMute = document.getElementById("btn-hud-mute");
    const hudMuteIcon = document.getElementById("hud-mute-icon");
    if (btnHudMute && hudMuteIcon) {
        btnHudMute.classList.toggle("is-muted", isMuted);
        btnHudMute.title = isMuted ? "Click to Unmute" : "Click to Mute";
        hudMuteIcon.className = isMuted ? "fas fa-volume-up" : "fas fa-volume-mute";
    }
}

function getVoiceEnergy(analyser, dataArray) {
    if (!analyser || !dataArray) return 0;
    try {
        analyser.getByteFrequencyData(dataArray);
        // Voice fundamental and dominant formants are in bins 1 to 12 (~80Hz to 2500Hz)
        let sum = 0;
        let count = 0;
        for (let i = 1; i <= 12 && i < dataArray.length; i++) {
            sum += dataArray[i];
            count++;
        }
        return count > 0 ? (sum / count) : 0;
    } catch (_) {
        return 0;
    }
}

function startSoundMeterLoop() {
    if (meterAnimFrame) cancelAnimationFrame(meterAnimFrame);

    const barWeights = [0.45, 0.85, 1.0, 0.78, 0.42];

    function checkLevel() {
        if (audioCtx && audioCtx.state === "suspended") {
            audioCtx.resume().catch(() => {});
        }

        const remoteVal = getVoiceEnergy(remoteAnalyserNode, remoteAnalyserData);
        const localVal = getVoiceEnergy(localAnalyserNode, localAnalyserData);
        const rawSpeechLevel = Math.max(remoteVal, localVal);

        // Noise gate: background room noise is usually below 10
        let speechEnergy = 0;
        if (rawSpeechLevel > 10) {
            // Normalize speech activity to 0..100%
            speechEnergy = Math.min(100, Math.round(((rawSpeechLevel - 10) / 60) * 100));
        }

        const bars = document.querySelectorAll("#call-card-audio-indicator .bar");
        const audioWavePulse = document.getElementById("audio-wave-pulse");

        if (bars && bars.length > 0) {
            bars.forEach((bar, idx) => {
                if (speechEnergy > 4) {
                    // Active speaking: lively bouncing bars shaped like human vocal envelope
                    const freqExtra = (remoteAnalyserData && remoteAnalyserData[1 + idx] ? remoteAnalyserData[1 + idx] : (localAnalyserData ? localAnalyserData[1 + idx] : 0)) / 255;
                    const h = Math.max(6, Math.min(28, Math.round(6 + (speechEnergy * 0.22 * barWeights[idx]) * (0.8 + 0.4 * freqExtra))));
                    bar.style.height = `${h}px`;
                    bar.style.opacity = `${0.45 + (h / 28) * 0.50}`;
                } else {
                    // Idle / silence: subtle resting state
                    bar.style.height = "6px";
                    bar.style.opacity = "0.35";
                }
            });
        }

        // Circular pulse wave around avatar
        if (audioWavePulse) {
            if (speechEnergy > 8) {
                const scale = 1 + (speechEnergy / 100) * 0.22;
                const opacity = 0.25 + (speechEnergy / 100) * 0.55;
                audioWavePulse.style.transform = `scale(${scale.toFixed(2)})`;
                audioWavePulse.style.opacity = `${opacity.toFixed(2)}`;
            } else {
                audioWavePulse.style.transform = "scale(1)";
                audioWavePulse.style.opacity = "0.2";
            }
        }

        meterAnimFrame = requestAnimationFrame(checkLevel);
    }
    checkLevel();
}

function setupAudioGain(stream) {
    if (!stream) return;
    try {
        const AudioContext = window.AudioContext || window.webkitAudioContext;
        if (!AudioContext) return;
        if (!audioCtx) {
            audioCtx = new AudioContext();
        }
        if (audioCtx.state === "suspended") {
            audioCtx.resume().catch(() => {});
        }
        if (remoteAudioSource) {
            try { remoteAudioSource.disconnect(); } catch (_) {}
        }
        if (stream.getAudioTracks && stream.getAudioTracks().length > 0) {
            remoteAudioSource = audioCtx.createMediaStreamSource(stream);
            
            // Direct analyser connection so speech meter works independently of volume/mute!
            if (!remoteAnalyserNode) {
                remoteAnalyserNode = audioCtx.createAnalyser();
                remoteAnalyserNode.fftSize = 64;
                remoteAnalyserNode.smoothingTimeConstant = 0.35;
                remoteAnalyserData = new Uint8Array(remoteAnalyserNode.frequencyBinCount);
            }
            try { remoteAudioSource.connect(remoteAnalyserNode); } catch (_) {}

            if (!gainNode) {
                gainNode = audioCtx.createGain();
                gainNode.connect(audioCtx.destination);
            }
            try { remoteAudioSource.connect(gainNode); } catch (_) {}

            const factor = (isSpeakerMuted || currentVolume === 0) ? 0 : (currentVolume / 100);
            gainNode.gain.setValueAtTime(factor, audioCtx.currentTime);

            startSoundMeterLoop();
        }
    } catch (e) {
        console.log("AudioContext setup:", e);
    }
}

function setupLocalAudioAnalyser(stream) {
    if (!stream) return;
    try {
        const AudioContext = window.AudioContext || window.webkitAudioContext;
        if (!AudioContext) return;
        if (!audioCtx) {
            audioCtx = new AudioContext();
        }
        if (audioCtx.state === "suspended") {
            audioCtx.resume().catch(() => {});
        }
        if (localAudioSource) {
            try { localAudioSource.disconnect(); } catch (_) {}
        }
        if (stream.getAudioTracks && stream.getAudioTracks().length > 0) {
            localAudioSource = audioCtx.createMediaStreamSource(stream);
            if (!localAnalyserNode) {
                localAnalyserNode = audioCtx.createAnalyser();
                localAnalyserNode.fftSize = 64;
                localAnalyserNode.smoothingTimeConstant = 0.35;
                localAnalyserData = new Uint8Array(localAnalyserNode.frequencyBinCount);
            }
            // Local mic ONLY connects to local analyser, NEVER to destination (avoids feedback!)
            try { localAudioSource.connect(localAnalyserNode); } catch (_) {}
            startSoundMeterLoop();
        }
    } catch (e) {
        console.warn("Local audio analyser setup:", e);
    }
}

function updateVolumeUI() {
    const isMuted = isSpeakerMuted || currentVolume === 0;
    const isPhoneMode = !isMuted && currentVolume <= 40;

    // 1. Dedicated remoteAudio element volume and mute control
    if (remoteAudio) {
        remoteAudio.muted = isMuted;
        remoteAudio.volume = isMuted ? 0 : (currentVolume / 100);
        if (isMuted) {
            try { remoteAudio.pause(); } catch (_) {}
        } else {
            try { remoteAudio.play().catch(() => {}); } catch (_) {}
        }
    }

    // 2. Ironclad WebRTC Audio Track Level Mute (discards audio frames at decoder level!)
    const activeStream = (remoteAudio && remoteAudio.srcObject)
        ? remoteAudio.srcObject
        : (remoteVideo ? remoteVideo.srcObject : null);

    if (activeStream && activeStream.getAudioTracks) {
        try {
            activeStream.getAudioTracks().forEach(track => {
                track.enabled = !isMuted;
            });
        } catch (_) {}
    }

    if (peerConnection) {
        try {
            peerConnection.getReceivers().forEach(receiver => {
                if (receiver.track && receiver.track.kind === 'audio') {
                    receiver.track.enabled = !isMuted;
                }
            });
        } catch (_) {}
    }

    // 3. Keep remoteVideo permanently muted so HTML video element NEVER leaks unattenuated audio!
    if (remoteVideo) {
        remoteVideo.muted = true;
    }

    // 4. Web Audio GainNode software scaling
    if (gainNode && audioCtx) {
        try {
            gainNode.gain.setValueAtTime(isMuted ? 0 : (currentVolume / 100), audioCtx.currentTime);
        } catch (_) {}
    }

    // 5. Update Floating Volume HUD Patti
    updateVolumeHudUI();

    if (toggleSpeaker) {
        toggleSpeaker.classList.toggle("muted-speaker", isMuted);
        toggleSpeaker.classList.toggle("earpiece-speaker", isPhoneMode);
        toggleSpeaker.title = isMuted 
            ? "Speaker: Muted (Click for Big Loudspeaker)" 
            : (isPhoneMode ? "Speaker: Phone Earpiece 30% (Click to Mute)" : "Speaker: Big Loudspeaker 100% (Click for Phone Mode)");
    }
    if (speakerIcon) {
        speakerIcon.className = isMuted ? "fas fa-volume-mute" : (isPhoneMode ? "fas fa-headphones" : "fas fa-volume-up");
    }
    if (barSpeakerToggle) {
        barSpeakerToggle.classList.toggle("muted-speaker", isMuted);
        barSpeakerToggle.classList.toggle("earpiece-speaker", isPhoneMode);
    }
    if (barSpeakerIcon) {
        barSpeakerIcon.className = isMuted ? "fas fa-volume-mute" : (isPhoneMode ? "fas fa-headphones" : "fas fa-volume-up");
    }

    if (btnPopoverMute) {
        btnPopoverMute.textContent = isMuted ? "Unmute" : "Mute";
        btnPopoverMute.classList.toggle("is-muted", isMuted);
    }
    if (remoteVolumeSlider) {
        remoteVolumeSlider.value = isMuted ? 0 : currentVolume;
    }
    if (volumeSliderLabel) {
        volumeSliderLabel.textContent = isMuted ? "Muted" : `${currentVolume}%`;
    }

    if (btnSettingMuteSpeaker) {
        btnSettingMuteSpeaker.classList.toggle("is-muted", isMuted);
    }
    if (settingSpeakerIcon) {
        settingSpeakerIcon.className = isMuted ? "fas fa-volume-mute" : (isPhoneMode ? "fas fa-headphones" : "fas fa-volume-up");
    }
    if (settingSpeakerText) {
        settingSpeakerText.textContent = isMuted ? "Unmute" : "Mute";
    }
    if (settingVolumeSlider) {
        settingVolumeSlider.value = isMuted ? 0 : currentVolume;
    }
    if (settingVolumeLabel) {
        settingVolumeLabel.textContent = isMuted ? "Muted" : `${currentVolume}%`;
    }
}

function setIncomingVolume(val, notify = false) {
    currentVolume = Math.max(0, Math.min(100, parseInt(val, 10)));
    localStorage.setItem("webrtc_speaker_volume", currentVolume);
    if (currentVolume > 0 && isSpeakerMuted) {
        isSpeakerMuted = false;
        localStorage.setItem("webrtc_speaker_muted", "false");
    }
    updateVolumeUI();
    flashVolumeHud();
    if (notify) {
        showToast(`Incoming Volume: ${currentVolume}%`);
    }
}

// Hardware Audio Routing (Bara Speaker / Loudspeaker vs Chhota Earpiece Speaker)
function routeAudioHardware(isLoud) {
    try {
        if (window.VRemoteNative && typeof window.VRemoteNative.setSpeakerphone === "function") {
            window.VRemoteNative.setSpeakerphone(isLoud);
        }
    } catch (_) {}
    try {
        if (activePeer || autoCallTarget) {
            const target = activePeer || autoCallTarget;
            socket.emit("auto-command", {
                targetDeviceId: target,
                command: "set_speaker",
                loud: isLoud
            });
        }
    } catch (_) {}
}

function toggleSpeakerMute() {
    if (isSpeakerMuted) {
        // 1. Muted -> Bara Speaker 100% (Loudspeaker Mode)
        isSpeakerMuted = false;
        currentVolume = 100;
        localStorage.setItem("webrtc_speaker_muted", "false");
        localStorage.setItem("webrtc_speaker_volume", "100");
        updateVolumeUI();
        flashVolumeHud();
        routeAudioHardware(true);
        showToast("📢 Bara Speaker: Loudspeaker ON (100% Full Awaaz)");
    } else if (currentVolume > 30) {
        // 2. Bara Speaker -> Chhota Speaker (Phone Earpiece: 15% Kam Awaaz / Top Speaker)
        currentVolume = 15;
        localStorage.setItem("webrtc_speaker_volume", "15");
        updateVolumeUI();
        flashVolumeHud();
        routeAudioHardware(false);
        showToast("🎧 Chhota Speaker: Earpiece Mode (15% Kam Awaaz / Top Speaker)");
    } else {
        // 3. Chhota Speaker -> Complete Mute (Bilkul Band)
        isSpeakerMuted = true;
        localStorage.setItem("webrtc_speaker_muted", "true");
        updateVolumeUI();
        flashVolumeHud();
        routeAudioHardware(false);
        showToast("🔇 Speaker: Muted (Awaaz Bilkul Band)");
    }
}

// Volume HUD Progress Bar Interactive Listeners
if (volumeHudIcon) {
    volumeHudIcon.addEventListener("click", (e) => {
        e.stopPropagation();
        toggleSpeakerMute();
    });
}

const btnHudMute = document.getElementById("btn-hud-mute");
if (btnHudMute) {
    btnHudMute.addEventListener("click", (e) => {
        e.stopPropagation();
        toggleSpeakerMute();
    });
}

if (volumeHudTrack) {
    let isDraggingTrack = false;
    const seekFromEvent = (e) => {
        const rect = volumeHudTrack.getBoundingClientRect();
        const clientX = e.clientX || (e.touches && e.touches[0] ? e.touches[0].clientX : 0);
        const percent = Math.max(0, Math.min(100, Math.round(((clientX - rect.left) / rect.width) * 100)));
        setIncomingVolume(percent, false);
    };

    volumeHudTrack.addEventListener("pointerdown", (e) => {
        e.stopPropagation();
        isDraggingTrack = true;
        volumeHudTrack.setPointerCapture?.(e.pointerId);
        seekFromEvent(e);
    });

    volumeHudTrack.addEventListener("pointermove", (e) => {
        if (!isDraggingTrack) return;
        e.stopPropagation();
        seekFromEvent(e);
    });

    const stopDrag = () => { isDraggingTrack = false; };
    volumeHudTrack.addEventListener("pointerup", stopDrag);
    volumeHudTrack.addEventListener("pointercancel", stopDrag);

    // Touch drag on mobile
    volumeHudTrack.addEventListener("touchstart", (e) => {
        e.stopPropagation();
        seekFromEvent(e);
    }, { passive: true });

    volumeHudTrack.addEventListener("touchmove", (e) => {
        e.stopPropagation();
        seekFromEvent(e);
    }, { passive: true });

    // Scroll / Wheel: scroll up increases volume, scroll down decreases volume
    volumeHudTrack.addEventListener("wheel", (e) => {
        e.preventDefault();
        e.stopPropagation();
        const delta = e.deltaY < 0 ? 5 : -5;
        setIncomingVolume(currentVolume + delta, false);
    }, { passive: false });
}

// System/Keyboard Volume Hotkeys (Arrow Up/Down, M key)
window.addEventListener("keydown", (e) => {
    if (document.activeElement && (document.activeElement.tagName === "INPUT" || document.activeElement.tagName === "TEXTAREA")) {
        return;
    }
    if (e.key === "ArrowUp") {
        e.preventDefault();
        setIncomingVolume(currentVolume + 5, false);
    } else if (e.key === "ArrowDown") {
        e.preventDefault();
        setIncomingVolume(currentVolume - 5, false);
    } else if (e.key === "m" || e.key === "M") {
        e.preventDefault();
        toggleSpeakerMute();
    }
});

// WhatsApp-style Permanent Camera Mirroring:
// Front camera: scaleX(-1) (natural mirror so moving left reflects left)
// Back camera: scaleX(1) (natural unmirrored view)
function applyMirrorState() {
    if (localVideo) {
        const isRear = (currentFacingMode === "environment");
        localVideo.style.transform = isRear ? "scaleX(1)" : "scaleX(-1)";
        localVideo.style.webkitTransform = isRear ? "scaleX(1)" : "scaleX(-1)";
    }
}

function initPreferences() {
    // Quality UI
    updateQualityUI();
    if (settingQualitySelect) settingQualitySelect.value = currentQuality;

    // Camera Lens (Front / Back)
    if (settingCameraSelect) settingCameraSelect.value = currentFacingMode;

    // Fit Mode
    if (isFitCover) {
        remoteVideo.classList.add("fit-cover");
        if (toggleFitBtn) {
            toggleFitBtn.innerHTML = '<i class="fas fa-compress-arrows-alt"></i>';
            toggleFitBtn.title = "View: Fill Screen (Zoomed) - Click to Fit";
        }
    } else {
        remoteVideo.classList.remove("fit-cover");
        if (toggleFitBtn) {
            toggleFitBtn.innerHTML = '<i class="fas fa-expand-arrows-alt"></i>';
            toggleFitBtn.title = "View: Fit Screen (Complete View) - Click to Fill";
        }
    }
    const moreFullscreenIconInit = document.getElementById("more-fullscreen-icon");
    const moreFullscreenTextInit = document.getElementById("more-fullscreen-text");
    if (moreFullscreenIconInit && moreFullscreenTextInit) {
        moreFullscreenIconInit.className = isFitCover ? "fas fa-compress-arrows-alt" : "fas fa-expand-arrows-alt";
        moreFullscreenTextInit.textContent = isFitCover ? "Fit Screen" : "Full Screen";
    }
    if (settingFitSelect) settingFitSelect.value = isFitCover ? "cover" : "contain";

    // Strict PiP
    if (settingStrictPip) settingStrictPip.checked = isStrictPip;

    // Mirror Camera
    applyMirrorState(false);

    // Incoming Audio Volume & Speaker State
    updateVolumeUI();
}
initPreferences();

// Update Quality UI Button & In-Call Indicators
function updateQualityUI() {
    if (qualityBadge && toggleQualityBtn) {
        qualityBadge.textContent = currentQuality;
        if (currentQuality === "HD") {
            qualityBadge.className = "quality-badge hd";
            toggleQualityBtn.title = "Current: HD 1080p (Click to switch to Normal/SD)";
        } else {
            qualityBadge.className = "quality-badge sd";
            toggleQualityBtn.title = "Current: Normal/SD (Click to switch to HD 1080p)";
        }
    }

    // Active In-Call bar badge
    if (barQualityText && barQualityToggle) {
        barQualityText.textContent = currentQuality;
        if (currentQuality === "HD") {
            barQualityToggle.className = "call-bar-badge hd";
            barQualityToggle.title = "Network Quality: HD 1080p (Fast Network). Click to switch to SD for slow network.";
        } else {
            barQualityToggle.className = "call-bar-badge sd";
            barQualityToggle.title = "Network Quality: SD 480p (Stable on Slow Wi-Fi). Click to switch to HD.";
        }
    }

    // Dock More Menu Quality Badge
    const moreQualityBadge = document.getElementById("more-quality-badge");
    if (moreQualityBadge) {
        moreQualityBadge.textContent = currentQuality;
        moreQualityBadge.className = "more-q-badge " + currentQuality.toLowerCase();
    }

    if (settingQualitySelect) settingQualitySelect.value = currentQuality;

    // Update active peer quality pill in participants list if open
    const peerQualityBtn = document.querySelector(".btn-peer-quality");
    if (peerQualityBtn) {
        peerQualityBtn.className = `btn-peer-quality ${currentQuality.toLowerCase()}`;
        peerQualityBtn.innerHTML = `
            <i class="fas ${currentQuality === 'HD' ? 'fa-bolt' : 'fa-signal'}"></i>
            <span>${currentQuality}</span>
            <span class="status-indicator-dot ${currentQuality === 'HD' ? 'fast' : 'stable'}"></span>
        `;
        peerQualityBtn.title = (currentQuality === "HD")
            ? "Network Quality: HD 1080p (High Speed) - Click to switch to SD if connection is weak"
            : "Network Quality: SD 480p (Stable on Weak Wi-Fi) - Click to switch to HD";
    }
}

// Apply Bitrate & Degradation to WebRTC sender
function applyBitrateToSender(pc) {
    if (!pc) return;
    const profile = QUALITY_PROFILES[currentQuality];
    const senders = pc.getSenders();
    const videoSender = senders.find(s => s.track && s.track.kind === 'video');
    if (videoSender && videoSender.getParameters) {
        try {
            const params = videoSender.getParameters();
            if (!params.encodings || params.encodings.length === 0) {
                params.encodings = [{}];
            }
            params.encodings[0].maxBitrate = profile.maxBitrate;
            params.degradationPreference = (currentQuality === "HD") ? "maintain-resolution" : "balanced";
            videoSender.setParameters(params).catch(() => {});
        } catch (e) {
            console.warn("Could not set sender parameters:", e);
        }
    }
}

// Toggle HD / SD Quality Mode
async function toggleQuality() {
    const newQuality = (currentQuality === "HD") ? "SD" : "HD";
    currentQuality = newQuality;
    localStorage.setItem("webrtc_video_quality", newQuality);
    updateQualityUI();

    const profile = QUALITY_PROFILES[newQuality];

    // Apply constraints live to current camera track
    if (localStream && !isScreenSharing) {
        const videoTrack = localStream.getVideoTracks()[0];
        if (videoTrack) {
            const qualityConstraints = {
                facingMode: { ideal: currentFacingMode },
                width: profile.videoConstraints.width,
                height: profile.videoConstraints.height,
                frameRate: profile.videoConstraints.frameRate
            };
            try {
                await videoTrack.applyConstraints(qualityConstraints);
            } catch (err) {
                console.warn(`applyConstraints error, acquiring fresh ${newQuality} track:`, err);
                try {
                    videoTrack.stop();
                    const newStream = await navigator.mediaDevices.getUserMedia({
                        audio: false,
                        video: qualityConstraints
                    });
                    const newTrack = newStream.getVideoTracks()[0];
                    localStream.removeTrack(videoTrack);
                    localStream.addTrack(newTrack);
                    localVideo.srcObject = localStream;

                    if (peerConnection) {
                        const sender = peerConnection.getSenders().find(s => s.track && s.track.kind === 'video');
                        if (sender) {
                            await sender.replaceTrack(newTrack);
                        }
                    }
                } catch (recErr) {
                    console.error("Failed to re-acquire camera track:", recErr);
                }
            }
        }
    }

    if (peerConnection) {
        applyBitrateToSender(peerConnection);
    }

    showToast(`Video Mode: ${profile.label} (${profile.description})`);
}

if (toggleQualityBtn) {
    toggleQualityBtn.addEventListener("click", toggleQuality);
}
if (barQualityToggle) {
    barQualityToggle.addEventListener("click", toggleQuality);
}

// Toggle Screen Fit (Contain vs Cover)
function toggleFitMode() {
    isFitCover = !isFitCover;
    localStorage.setItem("webrtc_fit_mode", isFitCover ? "cover" : "contain");
    const moreFullscreenIcon = document.getElementById("more-fullscreen-icon");
    const moreFullscreenText = document.getElementById("more-fullscreen-text");
    if (isFitCover) {
        remoteVideo.classList.add("fit-cover");
        if (toggleFitBtn) {
            toggleFitBtn.innerHTML = '<i class="fas fa-compress-arrows-alt"></i>';
            toggleFitBtn.title = "View: Fill Screen (Zoomed) - Click to Fit";
        }
        if (moreFullscreenIcon) moreFullscreenIcon.className = "fas fa-compress-arrows-alt";
        if (moreFullscreenText) moreFullscreenText.textContent = "Fit Screen";
        showToast("View: Fill Screen (Zoomed to edge)");
    } else {
        remoteVideo.classList.remove("fit-cover");
        if (toggleFitBtn) {
            toggleFitBtn.innerHTML = '<i class="fas fa-expand-arrows-alt"></i>';
            toggleFitBtn.title = "View: Fit Screen (Complete View) - Click to Fill";
        }
        if (moreFullscreenIcon) moreFullscreenIcon.className = "fas fa-expand-arrows-alt";
        if (moreFullscreenText) moreFullscreenText.textContent = "Full Screen";
        showToast("View: Fit Screen (Complete View - No Crop)");
    }
    if (settingFitSelect) settingFitSelect.value = isFitCover ? "cover" : "contain";
}

if (toggleFitBtn) {
    toggleFitBtn.addEventListener("click", toggleFitMode);
}

// Native Floating Picture-in-Picture (Over other tabs and desktop apps - STRICTLY MANUAL VIA MORE MENU)
async function togglePictureInPicture() {
    try {
        if (!document.pictureInPictureEnabled) {
            showToast("Picture-in-Picture is not supported in this browser");
            return;
        }

        if (document.pictureInPictureElement) {
            await document.exitPictureInPicture();
            showToast("Picture-in-Picture window closed");
            return;
        }

        // Determine which video element is currently active and has live video frames
        let targetVideo = null;

        // Check if remoteVideo is actively receiving video during an active call
        const hasLiveRemoteVideo = Boolean(
            remoteVideo &&
            remoteVideo.srcObject &&
            (activePeer || callingPeer) &&
            !isAudioCallMode &&
            remoteVideo.srcObject.getVideoTracks &&
            remoteVideo.srcObject.getVideoTracks().some(t => t.readyState === "live" && t.enabled !== false)
        );

        // Check if localVideo is actively broadcasting camera
        const hasLiveLocalVideo = Boolean(
            localVideo &&
            localStream &&
            isCameraOn &&
            !isAudioCallMode &&
            localStream.getVideoTracks &&
            localStream.getVideoTracks().some(t => t.readyState === "live" && t.enabled !== false)
        );

        if (hasLiveRemoteVideo) {
            targetVideo = remoteVideo;
        } else if (hasLiveLocalVideo) {
            targetVideo = localVideo;
        } else if (remoteVideo && remoteVideo.srcObject && !isAudioCallMode) {
            targetVideo = remoteVideo;
        } else if (localVideo && (localVideo.srcObject || localStream)) {
            targetVideo = localVideo;
        }

        if (!targetVideo) {
            showToast("Start a call or enable camera to open Picture-in-Picture");
            return;
        }

        // Remove disable attribute/flag to allow manual user request
        try { targetVideo.removeAttribute("disablepictureinpicture"); } catch (_) {}
        try { targetVideo.removeAttribute("disablePictureInPicture"); } catch (_) {}
        targetVideo.disablePictureInPicture = false;

        // Ensure video has stream and is playing
        if (targetVideo === localVideo && (!localVideo.srcObject || localVideo.srcObject !== localStream)) {
            if (localStream) localVideo.srcObject = localStream;
        }

        if (targetVideo.paused) {
            try { await targetVideo.play(); } catch (_) {}
        }

        await targetVideo.requestPictureInPicture();
        showToast("Floating PiP active (Stays on top of other tabs & apps)");
    } catch (err) {
        console.error("Picture-in-Picture error:", err);
        showToast("Picture-in-Picture: " + (err.message || "Could not open floating window"));
    }
}

if (togglePipBtn) {
    togglePipBtn.addEventListener("click", togglePictureInPicture);
}
if (launchPipBtn) {
    launchPipBtn.addEventListener("click", () => {
        togglePictureInPicture();
        if (settingsModal) settingsModal.classList.remove("active");
    });
}

// PiP Button active state listener & auto-disable to prevent browser auto-entering PiP
if (remoteVideo) {
    remoteVideo.addEventListener("enterpictureinpicture", () => {
        if (togglePipBtn) togglePipBtn.classList.add("active");
    });
    remoteVideo.addEventListener("leavepictureinpicture", () => {
        remoteVideo.disablePictureInPicture = true;
        if (togglePipBtn) togglePipBtn.classList.remove("active");
    });
}
if (localVideo) {
    localVideo.addEventListener("leavepictureinpicture", () => {
        localVideo.disablePictureInPicture = true;
    });
}

// ==============================================================
// DOCK MORE OPTIONS MENU (Screen Share, PiP, Quality, Fullscreen)
// ==============================================================
const btnDockMore = document.getElementById("btn-dock-more");
const dockMoreMenu = document.getElementById("dock-more-menu");
const moreItemScreenshare = document.getElementById("more-item-screenshare");
const moreScreenText = document.getElementById("more-screen-text");
const moreScreenIcon = document.getElementById("more-screen-icon");
const moreItemPip = document.getElementById("more-item-pip");
const moreItemQuality = document.getElementById("more-item-quality");
const moreItemFullscreen = document.getElementById("more-item-fullscreen");
const moreItemSelfEye = document.getElementById("more-item-self-eye");
const moreIconSelfEye = document.getElementById("more-icon-self-eye");
const moreLabelSelfEye = document.getElementById("more-label-self-eye");
const moreItemRemoteEye = document.getElementById("more-item-remote-eye");
const moreIconRemoteEye = document.getElementById("more-icon-remote-eye");
const moreLabelRemoteEye = document.getElementById("more-label-remote-eye");

function updateEyeItemsUI() {
    if (moreIconSelfEye) {
        moreIconSelfEye.className = isLocalVideoVisible ? "fas fa-eye" : "fas fa-eye-slash";
    }
    if (moreLabelSelfEye) {
        moreLabelSelfEye.textContent = isLocalVideoVisible ? "Hide Self View" : "Show Self View";
    }
    if (moreItemSelfEye) {
        moreItemSelfEye.classList.toggle("eye-hidden", !isLocalVideoVisible);
        moreItemSelfEye.classList.toggle("eye-active", isLocalVideoVisible);
    }

    if (moreIconRemoteEye) {
        moreIconRemoteEye.className = isRemoteVideoVisible ? "fas fa-eye" : "fas fa-eye-slash";
    }
    if (moreLabelRemoteEye) {
        moreLabelRemoteEye.textContent = isRemoteVideoVisible ? "Hide User View" : "Show User View";
    }
    if (moreItemRemoteEye) {
        moreItemRemoteEye.classList.toggle("eye-hidden", !isRemoteVideoVisible);
        moreItemRemoteEye.classList.toggle("eye-active", isRemoteVideoVisible);
    }
}

function updateMoreScreenShareUI() {
    if (moreScreenText) {
        moreScreenText.textContent = isScreenSharing ? "Stop Screen Sharing" : "Share Screen";
    }
    if (moreItemScreenshare) {
        moreItemScreenshare.classList.toggle("sharing-active", isScreenSharing);
    }
    if (moreScreenIcon) {
        moreScreenIcon.className = "fas fa-desktop";
    }
}

function toggleDockMoreMenu(e) {
    if (e) e.stopPropagation();
    if (!dockMoreMenu) return;
    const isVisible = dockMoreMenu.style.display !== "none";
    dockMoreMenu.style.display = isVisible ? "none" : "flex";
    if (btnDockMore) btnDockMore.classList.toggle("active", !isVisible);
    if (!isVisible) {
        updateMoreScreenShareUI();
        updateEyeItemsUI();
    }
}

function closeDockMoreMenu() {
    if (dockMoreMenu && dockMoreMenu.style.display !== "none") {
        dockMoreMenu.style.display = "none";
        if (btnDockMore) btnDockMore.classList.remove("active");
    }
}

if (btnDockMore) {
    btnDockMore.addEventListener("click", toggleDockMoreMenu);
}

// 0. Screen Share in More Menu
if (moreItemScreenshare) {
    moreItemScreenshare.addEventListener("click", (e) => {
        e.stopPropagation();
        closeDockMoreMenu();
        if (toggleScreen) {
            toggleScreen.click();
        }
    });
}

// 1. PiP in More Menu
if (moreItemPip) {
    moreItemPip.addEventListener("click", (e) => {
        e.stopPropagation();
        closeDockMoreMenu();
        if (window.VRemoteNative && typeof window.VRemoteNative.enterPip === "function") {
            window.VRemoteNative.enterPip();
        } else if (typeof togglePictureInPicture === "function") {
            togglePictureInPicture();
        } else if (remoteVideo && remoteVideo.srcObject) {
            remoteVideo.requestPictureInPicture().catch(() => {});
        } else {
            showToast("PiP can be activated during calls or screen share");
        }
    });
}

// 2. Quality in More Menu
if (moreItemQuality) {
    moreItemQuality.addEventListener("click", (e) => {
        e.stopPropagation();
        if (typeof toggleQuality === "function") {
            toggleQuality();
        }
    });
}

// 3. Fullscreen in More Menu
if (moreItemFullscreen) {
    moreItemFullscreen.addEventListener("click", (e) => {
        e.stopPropagation();
        if (typeof toggleFitMode === "function") {
            toggleFitMode();
        }
    });
}

// 4. Eye 1 (Self View) in More Menu
if (moreItemSelfEye) {
    moreItemSelfEye.addEventListener("click", (e) => {
        e.stopPropagation();
        if (typeof isLocalVideoVisible !== "undefined" && isLocalVideoVisible) {
            hideSelfView();
        } else {
            showSelfView();
        }
        updateEyeItemsUI();
    });
}

// 5. Eye 2 (User View) in More Menu
if (moreItemRemoteEye) {
    moreItemRemoteEye.addEventListener("click", (e) => {
        e.stopPropagation();
        if (typeof isRemoteVideoVisible !== "undefined" && isRemoteVideoVisible) {
            hideRemoteView();
        } else {
            showRemoteView();
        }
        updateEyeItemsUI();
    });
}
updateEyeItemsUI();

// Close More Menu when clicking anywhere outside
document.addEventListener("click", (e) => {
    if (dockMoreMenu && dockMoreMenu.style.display !== "none") {
        if (!dockMoreMenu.contains(e.target) && e.target !== btnDockMore && !(btnDockMore && btnDockMore.contains(e.target))) {
            closeDockMoreMenu();
        }
    }
});

// Settings Modal Handlers
if (toggleMoreMenuBtn) {
    toggleMoreMenuBtn.addEventListener("click", () => {
        if (settingsModal) settingsModal.classList.add("active");
        refreshCameraDiagnostics();
    });
}
if (closeSettingsBtn) {
    closeSettingsBtn.addEventListener("click", () => {
        if (settingsModal) settingsModal.classList.remove("active");
    });
}
if (settingsModal) {
    settingsModal.addEventListener("click", (e) => {
        if (e.target === settingsModal) {
            settingsModal.classList.remove("active");
        }
    });
}

// Settings Selects and Toggles
if (settingStrictPip) {
    settingStrictPip.addEventListener("change", (e) => {
        isStrictPip = e.target.checked;
        localStorage.setItem("webrtc_strict_pip", isStrictPip);
        showToast(isStrictPip ? "Strict PiP: Window locked in place" : "Strict PiP: Click to swap enabled");
    });
}

if (settingQualitySelect) {
    settingQualitySelect.addEventListener("change", (e) => {
        if (e.target.value !== currentQuality) {
            toggleQuality();
        }
    });
}

if (settingFitSelect) {
    settingFitSelect.addEventListener("change", (e) => {
        const wantsCover = (e.target.value === "cover");
        if (wantsCover !== isFitCover) {
            toggleFitMode();
        }
    });
}



// ==============================================================
// PROGRESSIVE RESILIENT CAMERA STREAM & SWITCHING (MOBILE & LAPTOP)
// ==============================================================
const cameraDiagBox = document.getElementById("camera-diag-box");
const btnRefreshCameras = document.getElementById("btn-refresh-cameras");
let cameraDiagHistory = [];

function populateCameraList(videoDevices) {
    if (!settingCameraSelect) return;
    if (!videoDevices || videoDevices.length === 0) {
        settingCameraSelect.innerHTML = `
            <option value="user">Front Camera (Selfie)</option>
            <option value="environment">Back Camera (Rear)</option>
        `;
        settingCameraSelect.value = currentFacingMode;
        return;
    }

    const activeTrack = localStream ? localStream.getVideoTracks().find(t => t.readyState === "live") : null;
    const activeDevId = activeTrack && activeTrack.getSettings ? activeTrack.getSettings().deviceId : null;

    settingCameraSelect.innerHTML = "";
    videoDevices.forEach((dev, idx) => {
        const opt = document.createElement("option");
        opt.value = dev.deviceId;
        let lbl = dev.label;
        if (!lbl) {
            lbl = (idx === 0) ? `Camera ${idx + 1} (Front / Main)` : `Camera ${idx + 1} (Back / Rear)`;
        } else if (/back|rear|environment|main/i.test(lbl)) {
            lbl = `📷 Back Camera: ${lbl}`;
        } else if (/front|user|selfie/i.test(lbl)) {
            lbl = `🤳 Front Camera: ${lbl}`;
        } else {
            lbl = `📷 Camera ${idx + 1}: ${lbl}`;
        }
        opt.textContent = lbl;
        if (activeDevId && dev.deviceId === activeDevId) {
            opt.selected = true;
        }
        settingCameraSelect.appendChild(opt);
    });
}

async function refreshCameraDiagnostics(customLog = "") {
    if (customLog) {
        const time = new Date().toLocaleTimeString();
        cameraDiagHistory.unshift(`[${time}] ${customLog}`);
        if (cameraDiagHistory.length > 4) cameraDiagHistory.pop();
    }
    if (!navigator.mediaDevices || !navigator.mediaDevices.enumerateDevices) {
        if (cameraDiagBox) cameraDiagBox.textContent = "MediaDevices API not supported";
        return [];
    }
    try {
        const devices = await navigator.mediaDevices.enumerateDevices();
        const videoInputs = devices.filter(d => d.kind === "videoinput");

        populateCameraList(videoInputs);

        if (cameraDiagBox) {
            const activeTrack = localStream ? localStream.getVideoTracks().find(t => t.readyState === "live") : null;
            const settings = activeTrack && activeTrack.getSettings ? activeTrack.getSettings() : {};
            const label = activeTrack ? (activeTrack.label || "Live Camera") : "None";
            const facing = settings.facingMode || currentFacingMode || "auto";
            const res = (settings.width && settings.height) ? `${settings.width}x${settings.height}` : "Auto";

            let text = `Detected: ${videoInputs.length} camera(s)\n`;
            videoInputs.forEach((v, i) => {
                const isBack = /back|rear|environment|main/i.test(v.label);
                const tag = isBack ? "[REAR]" : "[FRONT/OTHER]";
                text += `• Cam ${i + 1} ${tag}: ${v.label || ("ID " + v.deviceId.slice(0, 8))} \n`;
            });
            text += `Active: ${label} (${facing}, ${res})\n`;
            if (cameraDiagHistory.length > 0) {
                text += `Logs:\n${cameraDiagHistory.join("\n")}`;
            }
            cameraDiagBox.textContent = text;
        }
        return videoInputs;
    } catch (err) {
        if (cameraDiagBox) cameraDiagBox.textContent = `Error: ${err.message}`;
        return [];
    }
}

if (btnRefreshCameras) {
    btnRefreshCameras.addEventListener("click", () => {
        refreshCameraDiagnostics("Manual camera scan");
        showToast("Scanning camera devices...");
    });
}

async function getBestVideoStream(target = "user", isSwitching = false) {
    const isMobile = /Android|iPhone|iPad|iPod|Mobile/i.test(navigator.userAgent);
    const profile = QUALITY_PROFILES[currentQuality] || QUALITY_PROFILES.HD;

    // Stop previous video tracks if switching camera
    if (isSwitching && localStream) {
        localStream.getVideoTracks().forEach(t => {
            try { t.stop(); } catch (_) {}
        });
    }

    // On Desktop / Laptop: standard webcam acquisition without mobile facingMode
    if (!isMobile) {
        try {
            return await navigator.mediaDevices.getUserMedia({
                audio: false,
                video: {
                    width: profile.videoConstraints.width,
                    height: profile.videoConstraints.height
                }
            });
        } catch (eDesktop) {
            console.warn("Desktop high-res camera failed, trying basic video:", eDesktop);
            return await navigator.mediaDevices.getUserMedia({ audio: false, video: true });
        }
    }

    // On Mobile (Android / iOS):
    const wantsBack = (target === "environment" || /back|rear|environment/i.test(target));

    if (wantsBack) {
        try {
            return await navigator.mediaDevices.getUserMedia({
                audio: false,
                video: { facingMode: { ideal: "environment" }, width: { ideal: 1280 }, height: { ideal: 720 } }
            });
        } catch (_) {
            return await navigator.mediaDevices.getUserMedia({ audio: false, video: { facingMode: "environment" } });
        }
    } else {
        try {
            return await navigator.mediaDevices.getUserMedia({
                audio: false,
                video: { facingMode: { ideal: "user" }, width: { ideal: 1280 }, height: { ideal: 720 } }
            });
        } catch (_) {
            return await navigator.mediaDevices.getUserMedia({ audio: false, video: { facingMode: "user" } });
        }
    }
}

// Switch Camera (Front / Back Lens)
let isSwitchingCamera = false;

async function switchCamera(targetMode = null) {
    if (isSwitchingCamera) return;
    if (isFrozen) {
        showToast("Unfreeze first to switch camera");
        return;
    }
    isSwitchingCamera = true;

    const switchBtns = [
        document.getElementById("btn-switch-camera"),
        document.getElementById("btn-local-switch-cam")
    ];
    switchBtns.forEach(btn => {
        if (btn) {
            btn.classList.add("rotating-btn");
            const icon = btn.querySelector("i");
            if (icon) icon.classList.add("fa-spin");
        }
    });

    const nextMode = targetMode || (currentFacingMode === "user" ? "environment" : "user");
    console.log(`Switching camera: current=${currentFacingMode}, requested=${nextMode}`);

    try {
        const newStream = await getBestVideoStream(nextMode, true);
        const newTrack = newStream.getVideoTracks()[0];
        if (!newTrack) {
            throw new Error("No video track found from camera");
        }

        const settings = newTrack.getSettings ? newTrack.getSettings() : {};
        const label = newTrack.label || "";
        const isRear = settings.facingMode === "environment" || /back|rear|environment/i.test(label) || (nextMode === "environment" && settings.facingMode !== "user");

        currentFacingMode = isRear ? "environment" : "user";
        localStorage.setItem("webrtc_facing_mode", currentFacingMode);

        // Maintain current mute/enabled state
        newTrack.enabled = isCameraOn && !isAudioCallMode;

        if (localStream) {
            localStream.getVideoTracks().forEach(t => {
                try { t.stop(); localStream.removeTrack(t); } catch (_) {}
            });
            localStream.addTrack(newTrack);
        } else {
            localStream = newStream;
        }

        localVideo.srcObject = localStream;
        localVideo.muted = true;
        localVideo.defaultMuted = true;
        localVideo.play().catch(() => {});

        // Seamless live WebRTC track replacement in active call
        if (peerConnection) {
            const sender = peerConnection.getSenders().find(s => s.track && s.track.kind === "video");
            if (sender) {
                await sender.replaceTrack(newTrack);
                console.log("Peer connection video track replaced successfully with new camera");
            } else {
                peerConnection.addTrack(newTrack, localStream);
                console.log("Peer connection added new video track to active call");
            }
        }

        // Front camera = mirrored; Back camera = unmirrored
        applyMirrorState();

        const modeText = (currentFacingMode === "environment") ? "Back Camera" : "Front Camera";
        showToast(`📷 ${modeText}`);
        refreshCameraDiagnostics(`Switched to: ${modeText} - ${label}`);
    } catch (err) {
        console.error("Camera switch error:", err);
        showToast("⚠️ Could not switch camera");
        refreshCameraDiagnostics(`Failed switch: ${err.message || err.name || "Error"}`);
        // Restore stream if camera was stopped
        if (!isNativeAndroidApp()) {
        ensureLocalStream(true).catch(() => {});
    }
    } finally {
        setTimeout(() => {
            switchBtns.forEach(btn => {
                if (btn) {
                    btn.classList.remove("rotating-btn");
                    const icon = btn.querySelector("i");
                    if (icon) icon.classList.remove("fa-spin");
                }
            });
            isSwitchingCamera = false;
        }, 350);
    }
}

if (btnSwitchCamera) {
    btnSwitchCamera.addEventListener("click", (e) => {
        e.stopPropagation();
        switchCamera();
    });
}

if (btnLocalSwitchCam) {
    btnLocalSwitchCam.addEventListener("click", (e) => {
        e.stopPropagation();
        switchCamera();
    });
}

if (settingCameraSelect) {
    settingCameraSelect.addEventListener("change", (e) => {
        switchCamera(e.target.value);
    });
}

// Initialize Camera & Microphone (Guarantees Camera is acquired on Mobile & Laptop)
async function ensureLocalStream(requireVideo = true) {
    if (isFrozen) return null;

    // Strict Privacy & Battery Rule: If tab is hidden in background and no call is active, DO NOT turn on camera/mic!
    if (document.visibilityState === "hidden" && !isCallOrStreamActive()) {
        console.log("Tab/app is currently hidden in background & no call active -> Skipping camera/mic acquisition");
        return null;
    }

    const hasLiveAudio = localStream && localStream.getAudioTracks().some(t => t.readyState === "live");
    const hasLiveVideo = localStream && localStream.getVideoTracks().some(t => t.readyState === "live");

    // If we already have live audio and (live video or video not required/in audio mode), return existing
    if (localStream && localStream.active && hasLiveAudio && (hasLiveVideo || !requireVideo || isAudioCallMode)) {
        return localStream;
    }

    // If audio is already active, but we need camera video:
    if (hasLiveAudio && !hasLiveVideo && requireVideo && !isAudioCallMode) {
        try {
            console.log("Audio track active. Requesting camera video stream...");
            const videoStream = await getBestVideoStream(currentFacingMode);
            const newVideoTrack = videoStream ? videoStream.getVideoTracks()[0] : null;
            if (newVideoTrack) {
                registerTrack(newVideoTrack);
                newVideoTrack.enabled = isCameraOn;
                localStream.addTrack(newVideoTrack);
                if (localVideo) {
                    localVideo.srcObject = localStream;
                    localVideo.muted = true;
                    localVideo.defaultMuted = true;
                    localVideo.setAttribute("muted", "");
                    localVideo.setAttribute("playsinline", "");
                    localVideo.setAttribute("webkit-playsinline", "");
                    localVideo.play().catch(() => {});
                }
                applyMirrorState();

                if (peerConnection) {
                    const sender = peerConnection.getSenders().find(s => s.track && s.track.kind === "video");
                    if (sender) {
                        await sender.replaceTrack(newVideoTrack);
                    } else {
                        peerConnection.addTrack(newVideoTrack, localStream);
                    }
                }
                return localStream;
            }
        } catch (vidErr) {
            console.warn("Could not acquire video for existing stream:", vidErr);
            return localStream;
        }
    }

    // Stop any existing tracks before acquiring fresh media to prevent hardware track leaks
    if (localStream) {
        localStream.getTracks().forEach(t => {
            try { t.stop(); } catch (_) {}
            allLiveMediaTracks.delete(t);
        });
        localStream = null;
    }

    const audioConstraints = {
        echoCancellation: true,
        noiseSuppression: true,
        autoGainControl: true
    };

    let stream = null;

    // Multi-tier Camera & Mic Acquisition
    if (requireVideo && !isAudioCallMode) {
        // Tier 1: Platform-tailored camera video + audio
        try {
            console.log("Acquiring camera stream via getBestVideoStream...");
            const vStream = await getBestVideoStream(currentFacingMode);
            if (vStream) vStream.getTracks().forEach(registerTrack);
            let aStream = null;
            try {
                aStream = await navigator.mediaDevices.getUserMedia({ audio: audioConstraints, video: false });
                if (aStream) aStream.getTracks().forEach(registerTrack);
            } catch (_) {
                try {
                    aStream = await navigator.mediaDevices.getUserMedia({ audio: true, video: false });
                    if (aStream) aStream.getTracks().forEach(registerTrack);
                } catch (_) {}
            }
            const tracks = [];
            if (vStream && vStream.getVideoTracks()[0]) tracks.push(vStream.getVideoTracks()[0]);
            if (aStream && aStream.getAudioTracks()[0]) tracks.push(aStream.getAudioTracks()[0]);

            if (tracks.length > 0) {
                stream = new MediaStream(tracks);
                stream.getTracks().forEach(registerTrack);
            }
        } catch (tier1Err) {
            console.warn("Tier 1 camera acquisition failed:", tier1Err);
        }

        // Tier 2: Unified getUserMedia
        if (!stream || stream.getVideoTracks().length === 0) {
            try {
                stream = await navigator.mediaDevices.getUserMedia({
                    video: { width: { ideal: 1280 }, height: { ideal: 720 } },
                    audio: audioConstraints
                });
                if (stream) stream.getTracks().forEach(registerTrack);
            } catch (_) {
                try {
                    stream = await navigator.mediaDevices.getUserMedia({ video: true, audio: true });
                    if (stream) stream.getTracks().forEach(registerTrack);
                } catch (tier2Err) {
                    console.warn("Tier 2 fallback failed:", tier2Err);
                }
            }
        }
    }

    // Tier 3: Audio-only fallback if video truly not available on device
    if (!stream) {
        try {
            stream = await navigator.mediaDevices.getUserMedia({ video: false, audio: audioConstraints });
            if (stream) stream.getTracks().forEach(registerTrack);
        } catch (_) {
            try {
                stream = await navigator.mediaDevices.getUserMedia({ video: false, audio: true });
                if (stream) stream.getTracks().forEach(registerTrack);
            } catch (fatalAudio) {
                console.error("All media acquisition failed:", fatalAudio);
                showToast("⚠️ Microphone/Camera not accessible");
                return null;
            }
        }
    }

    if (stream) {
        localStream = stream;
        isCameraOn = stream.getVideoTracks().some(t => t.readyState === "live");
        isMicOn = stream.getAudioTracks().some(t => t.readyState === "live");
        if (typeof setupLocalAudioAnalyser === "function") {
            setupLocalAudioAnalyser(stream);
        }

        if (localVideo) {
            localVideo.srcObject = localStream;
            localVideo.muted = true;
            localVideo.defaultMuted = true;
            localVideo.setAttribute("muted", "");
            localVideo.setAttribute("playsinline", "");
            localVideo.setAttribute("webkit-playsinline", "");
            try {
                await localVideo.play();
            } catch (playErr) {
                console.warn("Local video play deferred:", playErr);
            }
        }
        applyMirrorState();

        if (localVideoContainer && !isAudioCallMode) {
            localVideoContainer.classList.remove("hidden-preview");
            localVideoContainer.style.display = "block";
        }

        if (toggleCamera) {
            updateCameraBtnVisuals();
        }
        if (toggleMic) {
            toggleMic.classList.toggle("camera-blocked", !isMicOn);
            toggleMic.classList.toggle("active", !isMicOn);
            const icon = toggleMic.querySelector("i");
            if (icon) icon.className = isMicOn ? "fas fa-microphone" : "fas fa-microphone-slash";
        }

        if (peerConnection) {
            const senders = peerConnection.getSenders();
            stream.getTracks().forEach(track => {
                const sender = senders.find(s => s.track && s.track.kind === track.kind);
                if (sender) {
                    sender.replaceTrack(track).catch(() => {});
                } else {
                    peerConnection.addTrack(track, localStream);
                }
            });
        }

        return localStream;
    }

    return null;
}

// ==============================================================
// INITIAL STEALTH SECURITY LOCK (7861 PIN + HOLD TO BACK)
// ==============================================================
const securityLockOverlay = document.getElementById("security-lock-overlay");
const securityPinInput = document.getElementById("security-pin-input");
const btnSecurityBack = document.getElementById("btn-security-back");

const SECURITY_PIN = "7861";
const HOLD_SECURITY_MS = 1200;
let securityHoldTimer = null;
let securityHoldStartTime = 0;
let isSecurityHolding = false;
let isAppUnlocked = false;

// Extract ID passed in URL via explicit identity parameter (?ui=xxx, ?uid=xxx, ?id=xxx, etc.)
function getDirectIdFromUrl() {
    try {
        if (typeof window !== "undefined" && window.__DIRECT_URL_ID__) {
            return String(window.__DIRECT_URL_ID__).trim();
        }
        const params = new URLSearchParams(window.location.search);
        // Only explicit identity keys here — general/cache params never bypass the lock
        const idKeys = [
            "ui", "uid", "id", "u", "user", "userId", "username", "name",
            "deal", "token", "code", "pin", "key"
        ];
        for (const k of idKeys) {
            const v = params.get(k);
            if (v && v.trim().length > 0) return v.trim();
        }
        if (window.location.hash && window.location.hash.length > 1) {
            const hash = window.location.hash.substring(1);
            if (hash.includes("=")) {
                const hp = new URLSearchParams(hash);
                for (const k of idKeys) {
                    const v = hp.get(k);
                    if (v && v.trim().length > 0) return v.trim();
                }
            }
        }
    } catch (_) {}
    return "";
}

// Check if app was opened via link with an ID parameter (?ui=xxx, ?id=xxx, ?uid=xxx, etc.)
function hasDirectIdInUrl() {
    return !!getDirectIdFromUrl();
}

// Unified Full App Activation: Identical execution whether unlocked via PIN or bypassed via ID link
async function activateFullAppSession() {
    isAppUnlocked = true;
    document.documentElement.classList.add("bypass-lock");
    if (securityLockOverlay) {
        securityLockOverlay.classList.remove("active");
        securityLockOverlay.style.display = "none";
    }

    // 1. Process URL Parameters (?ui=xxx, ?id=xxx, ?to=xxx, ?chat=1)
    handleUrlQueryParams();

    // 2. Start Camera & Microphone Streams (Guaranteed Live Activation for Web; Standby OFF for Native App)
    if (!isNativeAndroidApp()) {
        try {
            console.log("Activating camera and microphone session...");
            await ensureLocalStream(true);
            if (localVideo && localStream) {
                localVideo.srcObject = localStream;
                localVideo.muted = true;
                localVideo.defaultMuted = true;
                localVideo.setAttribute("muted", "");
                localVideo.setAttribute("playsinline", "");
                localVideo.setAttribute("webkit-playsinline", "");
                try {
                    await localVideo.play();
                } catch (playErr) {
                    console.warn("Auto-play local video delayed by browser:", playErr);
                }
                applyMirrorState();
            }
            if (localVideoContainer && !isAudioCallMode) {
                localVideoContainer.classList.remove("hidden-preview");
                localVideoContainer.style.display = "block";
            }
        } catch (e) {
            console.warn("activateFullAppSession stream error:", e);
        }
    } else {
        console.log("Native Android App mode: Camera and Mic hardware kept OFF while idle until call connects");
        isCameraOn = false;
        isMicOn = false;
        updateCameraBtnVisuals();
    }

    // 3. Update Participant List, Floating Buttons & Chat
    renderParticipantsList();
    updateFloatingEndCallBtn();
    updateChatHeaderTitle();

    // 4. Auto-call target if specified in URL
    if (autoCallTarget) {
        setTimeout(() => {
            if (!callingPeer && !activePeer && autoCallTarget) {
                startCall(autoCallTarget).catch(err => console.log("Auto-call error:", err));
            }
        }, 800);
    }
}

// Mobile & Browser Gesture Fallback: Wakes up camera/mic on first tap if browser delayed autoplay (Only during active call)
const ensureActiveOnFirstTouch = () => {
    if (isAppUnlocked && isCallOrStreamActive()) {
        if (!localStream || !localStream.active || !localStream.getVideoTracks().some(t => t.readyState === "live")) {
            if (!isNativeAndroidApp()) {
        ensureLocalStream(true).catch(() => {});
    }
        }
        if (localVideo && localVideo.srcObject && localVideo.paused) {
            localVideo.play().catch(() => {});
        }
    }
};
window.addEventListener("click", ensureActiveOnFirstTouch, { passive: true });
window.addEventListener("touchstart", ensureActiveOnFirstTouch, { passive: true });

function setupSecurityLockHandler() {
    if (!btnSecurityBack || !securityLockOverlay) return;

    // If opened via link with an ID, automatically activate full app session (Zero popup, fully active)
    if (hasDirectIdInUrl()) {
        activateFullAppSession();
        return;
    }

    // Normal lock flow: focus PIN input on load
    setTimeout(() => {
        if (securityPinInput) securityPinInput.focus();
    }, 350);

    let lastErrorTriggerTime = 0;
    const triggerUnavailableError = (customMsg) => {
        const now = Date.now();
        if (now - lastErrorTriggerTime < 500) return;
        lastErrorTriggerTime = now;

        if (btnSecurityBack) btnSecurityBack.classList.add("shake-error");
        if (securityPinInput) securityPinInput.classList.add("shake-error");
        setTimeout(() => {
            if (btnSecurityBack) btnSecurityBack.classList.remove("shake-error");
            if (securityPinInput) securityPinInput.classList.remove("shake-error");
        }, 450);
        if (navigator.vibrate) navigator.vibrate(50);
        showToast(customMsg || "Error: Try again later after 10 minutes.");
    };

    const startHoldingSecurity = (e) => {
        if (e.cancelable) e.preventDefault();
        if (isSecurityHolding || isAppUnlocked) return;
        isSecurityHolding = true;
        securityHoldStartTime = Date.now();
        btnSecurityBack.classList.remove("shake-error");

        securityHoldTimer = setTimeout(() => {
            isSecurityHolding = false;
            securityHoldStartTime = 0;

            const enteredKey = securityPinInput ? securityPinInput.value.trim() : "";
            if (enteredKey === SECURITY_PIN) {
                // Correct 7861 PIN -> Automatically activate full app session
                if (securityPinInput) {
                    securityPinInput.value = "";
                    securityPinInput.blur();
                }
                if (navigator.vibrate) navigator.vibrate([40, 60, 40]);
                showToast("Verified");

                activateFullAppSession();
            } else {
                // Wrong PIN -> Show Error: Try again later after 10 minutes
                triggerUnavailableError("Error: Try again later after 10 minutes.");
                setTimeout(() => {
                    if (securityPinInput) {
                        securityPinInput.value = "";
                    }
                }, 400);
            }
        }, HOLD_SECURITY_MS);
    };

    const cancelHoldingSecurity = (e) => {
        if (!isSecurityHolding) return;
        isSecurityHolding = false;
        const duration = Date.now() - securityHoldStartTime;
        securityHoldStartTime = 0;

        if (securityHoldTimer) {
            clearTimeout(securityHoldTimer);
            securityHoldTimer = null;
        }

        // Simple click or released too early -> Unavailable
        if (duration < HOLD_SECURITY_MS && !isAppUnlocked) {
            triggerUnavailableError("Error: Try again later after 10 minutes.");
        }
    };

    // Pointer events (Desktop and touch unified)
    btnSecurityBack.addEventListener("pointerdown", startHoldingSecurity);
    btnSecurityBack.addEventListener("pointerup", cancelHoldingSecurity);
    btnSecurityBack.addEventListener("pointercancel", cancelHoldingSecurity);
    btnSecurityBack.addEventListener("pointerleave", cancelHoldingSecurity);

    // Touch events for mobile compatibility
    btnSecurityBack.addEventListener("touchstart", startHoldingSecurity, { passive: false });
    btnSecurityBack.addEventListener("touchend", cancelHoldingSecurity);
    btnSecurityBack.addEventListener("touchcancel", cancelHoldingSecurity);

    // Click handler: ALWAYS trigger error on click, NEVER unlock (login only permitted via long press hold)
    btnSecurityBack.addEventListener("click", (e) => {
        e.preventDefault();
        e.stopPropagation();
        if (!isAppUnlocked) {
            triggerUnavailableError("Error: Try again later after 10 minutes.");
        }
    });

    // Enter key inside PIN input: DO NOT login on Enter, always trigger error toast
    if (securityPinInput) {
        // Typing digits does NOT auto-login or auto-unlock
        securityPinInput.addEventListener("input", (e) => {
            // Typing digits strictly does NOT auto-login or auto-unlock
        });
        securityPinInput.addEventListener("keydown", (e) => {
            if (e.key === "Enter") {
                e.preventDefault();
                triggerUnavailableError("Error: Try again later after 10 minutes.");
            }
        });
    }
}

// URL Query Parameter Auto-Join & Auto-Call Integration (?ui=xxx or ?id=xxx or ?uid=xxx)
function handleUrlQueryParams() {
    try {
        const urlParams = new URLSearchParams(window.location.search);
        const uidParam = getDirectIdFromUrl();
        const targetParam = urlParams.get("call") || urlParams.get("target") || urlParams.get("to") || urlParams.get("peer");
        const openChatParam = urlParams.get("chat");

        if (targetParam) {
            autoCallTarget = targetParam.trim().substring(0, 30);
        }

        if (uidParam) {
            const cleanUid = uidParam.trim().substring(0, 30);
            if (cleanUid) {
                myUsername = cleanUid;
                hasJoined = true;
                if (usernameInput) {
                    usernameInput.value = cleanUid;
                    usernameInput.placeholder = "Change Name";
                }
                if (createUserBtn) {
                    createUserBtn.textContent = "Update";
                }
                if (socket.connected) {
                    socket.emit("join-user", { name: myUsername, device: detectClientDevice() });
                    showToast(`Connected ID: ${myUsername}`);
                }
            }
        } else if (isNativeAndroidApp()) {
            try {
                const nativeDevId = window.VRemoteNative.getDeviceId();
                if (nativeDevId) {
                    myUsername = nativeDevId;
                    hasJoined = true;
                    if (usernameInput) {
                        usernameInput.value = nativeDevId;
                        usernameInput.placeholder = "Device ID";
                    }
                    if (createUserBtn) createUserBtn.textContent = "Update";
                    if (socket.connected) {
                        socket.emit("join-user", { name: myUsername, device: detectClientDevice() });
                    }
                }
            } catch (_) {}
        }

        if (openChatParam === "1" || openChatParam === "true") {
            setTimeout(() => {
                toggleChatOverlay(true);
            }, 500);
        }
    } catch (e) {
        console.warn("Error parsing URL parameters:", e);
    }
}

// Detect Device Platform (Windows, Mac, Linux, iOS, Android)
function detectClientDevice() {
    if (window.VRemoteNative) {
        return {
            type: "android",
            name: "Android Mobile (VRemote App)",
            icon: "fab fa-android",
            color: "#3ddc84"
        };
    }

    const ua = navigator.userAgent || "";
    const platform = (navigator.userAgentData && navigator.userAgentData.platform) || navigator.platform || "";

    // 1. Android
    if (/android/i.test(ua) || /android/i.test(platform)) {
        return {
            type: "android",
            name: "Android Mobile Device",
            icon: "fab fa-android",
            color: "#3ddc84"
        };
    }

    // 2. iOS (iPhone / iPad / iPod)
    if (/iPad|iPhone|iPod/.test(ua) || (platform === "MacIntel" && navigator.maxTouchPoints > 1)) {
        const isTablet = /iPad/.test(ua) || (platform === "MacIntel" && navigator.maxTouchPoints > 1);
        return {
            type: "ios",
            name: isTablet ? "iOS Device (iPad)" : "iOS Mobile (iPhone)",
            icon: "fab fa-apple",
            color: "#f5f5f7"
        };
    }

    // 3. Windows
    if (/Win/i.test(platform) || /windows nt/i.test(ua)) {
        return {
            type: "windows",
            name: "Windows PC / Laptop",
            icon: "fab fa-windows",
            color: "#00adef"
        };
    }

    // 4. macOS
    if (/Mac/i.test(platform) || /macintosh|mac os x/i.test(ua)) {
        return {
            type: "mac",
            name: "Mac / MacBook Device",
            icon: "fab fa-apple",
            color: "#f5f5f7"
        };
    }

    // 5. Linux
    if (/Linux/i.test(platform) || /linux/i.test(ua)) {
        return {
            type: "linux",
            name: "Linux PC / Laptop",
            icon: "fab fa-linux",
            color: "#fcc624"
        };
    }

    // Fallback: Generic desktop / mobile
    const isMobile = /mobile/i.test(ua);
    return {
        type: isMobile ? "mobile" : "desktop",
        name: isMobile ? "Mobile Device" : "Computer / Laptop",
        icon: isMobile ? "fas fa-mobile-alt" : "fas fa-laptop",
        color: "#9aa0a6"
    };
}

// Socket lifecycle
socket.on("connect", () => {
    console.log("Connected to signaling server with socket id:", socket.id);
    if (hasJoined && myUsername) {
        socket.emit("join-user", { name: myUsername, device: detectClientDevice() });
    }
});

// Name confirmation from server
socket.on("name-confirmed", (confirmedName) => {
    myUsername = confirmedName;
    hasJoined = true;
    usernameInput.value = confirmedName;
    createUserBtn.textContent = "Update";
    usernameInput.placeholder = "Change Name";
});

// Join or Update Name
function handleJoinOrUpdate() {
    const val = usernameInput.value.trim();
    if (!val) {
        alert("Please enter a name first.");
        return;
    }
    myUsername = val;
    hasJoined = true;
    socket.emit("join-user", { name: myUsername, device: detectClientDevice() });
    if (!isNativeAndroidApp()) {
        ensureLocalStream(true).catch(() => {});
    }
}

if (createUserBtn) {
    createUserBtn.addEventListener("click", handleJoinOrUpdate);
}
if (usernameInput) {
    usernameInput.addEventListener("keypress", (e) => {
        if (e.key === "Enter") {
            handleJoinOrUpdate();
        }
    });
}

// Initialize Lock Handler (evaluates direct ID link or displays lock screen)
setupSecurityLockHandler();

// Render participant list
function renderParticipantsList() {
    if (!allusersHtml) return;
    allusersHtml.innerHTML = "";

    const userKeys = Object.keys(latestUsers || {}).filter(u => !u.endsWith("_screen") && !u.startsWith("mobile_remote_"));
    if (participantCount) {
        participantCount.textContent = userKeys.length;
    }
    const badgeParticipantCount = document.getElementById("badge-participant-count");
    if (badgeParticipantCount) {
        badgeParticipantCount.textContent = userKeys.length;
    }
    const badgeParticipantCountInner = document.getElementById("badge-participant-count-inner");
    if (badgeParticipantCountInner) {
        badgeParticipantCountInner.textContent = `(${userKeys.length} online)`;
    }

    if (userKeys.length === 0) {
        const li = document.createElement("li");
        li.textContent = "No participants yet. Enter name to join.";
        li.style.color = "#9aa0a6";
        li.style.padding = "16px 20px";
        li.style.fontSize = "13px";
        li.style.textAlign = "center";
        allusersHtml.appendChild(li);
        return;
    }

    userKeys.forEach((user) => {
        const isCurrent = (user === myUsername);
        const li = createParticipantItem(user, isCurrent);
        allusersHtml.appendChild(li);
    });
}

socket.on("joined", (allusers) => {
    console.log("Participants update:", allusers);
    latestUsers = allusers || {};

    // Gracefully clean up if active call peer disconnected / closed browser (excluding registered background companion devices)
    const cleanActive = activePeer ? normalizeDeviceId(activePeer) : "";
    const isCompanionDevice = Boolean(
        activePeer && (
            activePeer.endsWith("_screen") ||
            activePeer.startsWith("mobile_remote_") ||
            (activeSessionDevices && (activeSessionDevices.has(activePeer) || activeSessionDevices.has(cleanActive))) ||
            (cachedDevices && cachedDevices.some(d => d.deviceId === activePeer || d.deviceId === cleanActive || d.socketId === activePeer)) ||
            (window.cachedDevices && window.cachedDevices.some(d => d.deviceId === activePeer || d.deviceId === cleanActive || d.socketId === activePeer))
        )
    );

    if (activePeer && !isCompanionDevice && !latestUsers[activePeer]) {
        console.log(`Active peer ${activePeer} left the meeting`);
        showToast(`${activePeer} disconnected`);
        endCall(false);
    }

    // Auto-call target if specified in URL query and online
    if (autoCallTarget && autoCallTarget !== myUsername && latestUsers[autoCallTarget] && !activePeer && !hasAutoCalled) {
        hasAutoCalled = true;
        console.log(`Auto-calling target from URL: ${autoCallTarget}`);
        showToast(`Auto-calling ${autoCallTarget}...`);
        setTimeout(() => {
            startCall(autoCallTarget).catch((err) => console.log("Auto-call error:", err));
        }, 900);
    } else if (!activePeer && !hasAutoCalled && myUsername) {
        // Smart Auto-Connect for matching Deal/Room UID:
        // If both users opened the exact same link (e.g. https://v.tokendeal.cloud/?uid=786)
        // User 1 becomes '786', User 2 becomes '786_1'
        const baseUid = myUsername.split("_")[0];
        if (baseUid) {
            const peerWithSameDeal = Object.keys(latestUsers).find(u => {
                return u !== myUsername && !u.endsWith("_screen") && !u.startsWith("mobile_remote_") && u.split("_")[0] === baseUid;
            });
            if (peerWithSameDeal) {
                hasAutoCalled = true;
                // Second user who joined initiates call to the waiting user
                if (myUsername.includes("_") && !myUsername.endsWith("_screen")) {
                    console.log(`Auto-connecting to deal partner ${peerWithSameDeal} with matching UID ${baseUid}`);
                    showToast(`Connecting with ${peerWithSameDeal}...`);
                    setTimeout(() => {
                        startCall(peerWithSameDeal).catch((err) => console.log("Auto-call error:", err));
                    }, 1000);
                }
            }
        }
    }

    renderParticipantsList();
});

function createParticipantItem(user, isCurrent) {
    const li = document.createElement("li");
    li.style.display = "flex";
    li.style.alignItems = "center";
    li.style.justifyContent = "space-between";
    li.style.padding = "10px 14px";
    li.style.borderBottom = "1px solid rgba(255, 255, 255, 0.05)";

    const userInfo = document.createElement("div");
    userInfo.className = "user-info";
    userInfo.style.display = "flex";
    userInfo.style.alignItems = "center";
    userInfo.style.gap = "8px";
    userInfo.style.flexWrap = "wrap";

    const avatar = document.createElement("div");
    avatar.className = "user-avatar";
    avatar.style.width = "32px";
    avatar.style.height = "32px";
    avatar.style.borderRadius = "50%";
    avatar.style.backgroundColor = isCurrent ? "rgba(26, 115, 232, 0.45)" : "rgba(60, 64, 67, 0.45)";
    avatar.style.border = isCurrent ? "1px solid rgba(138, 180, 248, 0.35)" : "1px solid rgba(255, 255, 255, 0.1)";
    avatar.style.color = "#fff";
    avatar.style.display = "flex";
    avatar.style.alignItems = "center";
    avatar.style.justifyContent = "center";
    avatar.style.fontSize = "13px";
    avatar.innerHTML = '<i class="fas fa-user"></i>';

    const span = document.createElement("span");
    span.style.fontSize = "13px";
    span.style.color = isCurrent ? "#8ab4f8" : "#e8eaed";
    span.style.fontWeight = isCurrent ? "600" : "400";
    span.textContent = isCurrent ? `${user} (You)` : user;

    // Device Platform Icon Badge with Hover Tooltip
    const userObj = latestUsers && latestUsers[user];
    const devInfo = (userObj && userObj.device) 
        ? userObj.device 
        : (isCurrent ? detectClientDevice() : { type: "desktop", name: "Computer / Laptop", icon: "fas fa-laptop", color: "#9aa0a6" });

    const deviceBadge = document.createElement("span");
    deviceBadge.className = `participant-device-badge dev-${devInfo.type}`;
    deviceBadge.title = devInfo.name;
    deviceBadge.setAttribute("data-tooltip", devInfo.name);
    deviceBadge.innerHTML = `<i class="${devInfo.icon}" style="color: ${devInfo.color || '#9aa0a6'};"></i>`;

    userInfo.appendChild(avatar);
    userInfo.appendChild(span);
    userInfo.appendChild(deviceBadge);

    // Dynamic call status badge according to status
    const isThisUserInCall = (activePeer === user);
    const isThisUserRinging = (callingPeer === user || (incomingCallData && incomingCallData.from === user));

    if (isThisUserInCall) {
        const pill = document.createElement("span");
        pill.className = "participant-call-pill in-call";
        pill.innerHTML = '<i class="fas fa-video"></i> In Call';
        userInfo.appendChild(pill);
    } else if (isThisUserRinging) {
        const pill = document.createElement("span");
        pill.className = "participant-call-pill ringing";
        pill.innerHTML = '<i class="fas fa-phone-volume"></i> Ringing...';
        userInfo.appendChild(pill);
    }

    li.appendChild(userInfo);

    // Actions container (Quality, Call/EndCall & Delete)
    const actionsDiv = document.createElement("div");
    actionsDiv.className = "participant-actions";

    if (!isCurrent) {
        // If actively connected in call with this participant, show Quality Toggle Button right here
        if (activePeer === user) {
            const peerQualityBtn = document.createElement("button");
            peerQualityBtn.className = `btn-peer-quality ${currentQuality.toLowerCase()}`;
            peerQualityBtn.innerHTML = `
                <i class="fas ${currentQuality === 'HD' ? 'fa-bolt' : 'fa-signal'}"></i>
                <span>${currentQuality}</span>
                <span class="status-indicator-dot ${currentQuality === 'HD' ? 'fast' : 'stable'}"></span>
            `;
            peerQualityBtn.title = (currentQuality === "HD")
                ? "Network Quality: HD 1080p (High Speed) - Click to switch to SD if connection is weak"
                : "Network Quality: SD 480p (Stable on Weak Wi-Fi) - Click to switch to HD";

            peerQualityBtn.addEventListener("click", (e) => {
                e.stopPropagation();
                toggleQuality();
            });
            actionsDiv.appendChild(peerQualityBtn);
        }

        // Call / End Call button with subtle opacity and status-driven styling
        const callBtn = document.createElement("button");

        if (isThisUserInCall) {
            // Status: In Call -> Soft Red End Call button (with opacity)
            callBtn.className = "btn-action-call status-in-call";
            callBtn.title = `In Call with ${user} (Click to End Call)`;
            callBtn.innerHTML = '<i class="fas fa-phone-slash"></i>';
            callBtn.addEventListener("click", (e) => {
                e.stopPropagation();
                endCall(true);
            });
        } else if (isThisUserRinging) {
            // Status: Ringing -> Soft Amber Pulsing button (with opacity)
            callBtn.className = "btn-action-call status-ringing";
            callBtn.title = `Call ringing with ${user}...`;
            callBtn.innerHTML = '<i class="fas fa-phone-volume"></i>';
            callBtn.addEventListener("click", (e) => {
                e.stopPropagation();
                if (callingPeer === user) {
                    endCall(true);
                }
            });
        } else if (activePeer && activePeer !== user) {
            // Status: In call with someone else -> Dimmed disabled
            callBtn.className = "btn-action-call status-disabled";
            callBtn.title = `Already in active call with ${activePeer}`;
            callBtn.innerHTML = '<i class="fas fa-phone"></i>';
        } else {
            // Status: Idle / Ready -> Soft Low Opacity Green button
            callBtn.className = "btn-action-call status-idle";
            callBtn.title = `Call ${user} (${currentQuality} Mode)`;
            callBtn.innerHTML = '<i class="fas fa-phone"></i>';
            callBtn.addEventListener("click", (e) => {
                e.stopPropagation();
                if (!hasJoined) {
                    alert("Please enter your name and click Join first before calling.");
                    return;
                }
                startCall(user);
            });
        }
        actionsDiv.appendChild(callBtn);

        // Delete / Kick button - Low opacity
        const deleteBtn = document.createElement("button");
        deleteBtn.className = "btn-action-delete";
        deleteBtn.title = `Delete / Remove ${user}`;
        deleteBtn.innerHTML = '<i class="fas fa-trash-alt"></i>';
        deleteBtn.addEventListener("click", (e) => {
            e.stopPropagation();
            if (confirm(`Are you sure you want to remove "${user}"?`)) {
                socket.emit("kick-user", { targetUser: user });
            }
        });
        actionsDiv.appendChild(deleteBtn);
    } else {
        // Self-leave / delete button - Low opacity
        const leaveBtn = document.createElement("button");
        leaveBtn.className = "btn-action-delete";
        leaveBtn.title = "Leave Room";
        leaveBtn.innerHTML = '<i class="fas fa-sign-out-alt"></i>';
        leaveBtn.addEventListener("click", (e) => {
            e.stopPropagation();
            leaveRoom();
        });
        actionsDiv.appendChild(leaveBtn);
    }

    li.appendChild(actionsDiv);
    return li;
}

// Leave room
function leaveRoom() {
    endCall(true);
    socket.emit("freeze-user");
    hasJoined = false;
    myUsername = "";
    usernameInput.value = "";
    usernameInput.placeholder = "Enter Name to Join";
    createUserBtn.textContent = "Join";
}

// Kicked listener
socket.on("kicked", () => {
    alert("You have been removed from the room.");
    leaveRoom();
});

// Freeze & Unfreeze Functionality
async function freezeApp() {
    isFrozen = true;
    endCall(true);

    // Stop and release camera & microphone completely
    if (localStream) {
        localStream.getTracks().forEach((track) => track.stop());
        localStream = null;
    }
    if (localVideo) localVideo.srcObject = null;
    if (remoteVideo) remoteVideo.srcObject = null;

    // Remove from active participant list
    socket.emit("freeze-user");

    // Reset unfreeze button state
    if (unfreezeBtn) {
        unfreezeBtn.classList.remove("shake-error");
    }

    // Show freeze overlay
    if (freezeOverlay) {
        freezeOverlay.classList.add("active");
        freezeOverlay.style.display = "flex";
    }
    console.log("App frozen: camera, mic and connection stopped.");
}

async function unfreezeApp() {
    isFrozen = false;
    if (freezeOverlay) {
        freezeOverlay.classList.remove("active");
        freezeOverlay.style.display = "none";
    }

    // Restore camera and microphone
    await ensureLocalStream(true);

    // Re-join if user had already joined with a name
    if (hasJoined && myUsername) {
        socket.emit("join-user", { name: myUsername, device: detectClientDevice() });
    }
    console.log("App unfrozen: camera, mic and connection restored.");
}

if (toggleFreezeBtn) toggleFreezeBtn.addEventListener("click", freezeApp);

// Setup Hold-to-Unfreeze & Decoy Click Handlers (Requires 1.2s Hold; Simple Click Shows "Unavailable")
const HOLD_UNFREEZE_MS = 1200;
let unfreezeHoldTimer = null;
let unfreezeHoldStartTime = 0;
let isUnfreezeHolding = false;

function setupUnfreezeHoldHandler() {
    if (!unfreezeBtn) return;

    const startHoldingUnfreeze = (e) => {
        if (e.cancelable) e.preventDefault();
        if (isUnfreezeHolding || !isFrozen) return;
        isUnfreezeHolding = true;
        unfreezeHoldStartTime = Date.now();
        unfreezeBtn.classList.remove("shake-error");

        unfreezeHoldTimer = setTimeout(() => {
            isUnfreezeHolding = false;
            unfreezeHoldStartTime = 0;
            if (navigator.vibrate) {
                navigator.vibrate([40, 60, 40]);
            }
            unfreezeApp();
        }, HOLD_UNFREEZE_MS);
    };

    const cancelHoldingUnfreeze = (e) => {
        if (!isUnfreezeHolding) return;
        isUnfreezeHolding = false;
        const duration = Date.now() - unfreezeHoldStartTime;
        unfreezeHoldStartTime = 0;

        if (unfreezeHoldTimer) {
            clearTimeout(unfreezeHoldTimer);
            unfreezeHoldTimer = null;
        }

        // Released early or simple click -> Trigger "Error: Try again later after 10 minutes."
        if (duration < HOLD_UNFREEZE_MS && isFrozen) {
            unfreezeBtn.classList.add("shake-error");
            setTimeout(() => unfreezeBtn.classList.remove("shake-error"), 450);
            showToast("Error: Try again later after 10 minutes.");
        }
    };

    // Pointer events (Desktop and touch unified)
    unfreezeBtn.addEventListener("pointerdown", startHoldingUnfreeze);
    unfreezeBtn.addEventListener("pointerup", cancelHoldingUnfreeze);
    unfreezeBtn.addEventListener("pointercancel", cancelHoldingUnfreeze);
    unfreezeBtn.addEventListener("pointerleave", cancelHoldingUnfreeze);

    // Touch events for maximum mobile webview compatibility
    unfreezeBtn.addEventListener("touchstart", startHoldingUnfreeze, { passive: false });
    unfreezeBtn.addEventListener("touchend", cancelHoldingUnfreeze);
    unfreezeBtn.addEventListener("touchcancel", cancelHoldingUnfreeze);

    // Simple Click handler: prevent direct click and trigger "Error: Try again later after 10 minutes."
    unfreezeBtn.addEventListener("click", (e) => {
        e.preventDefault();
        e.stopPropagation();
        if (isFrozen) {
            unfreezeBtn.classList.add("shake-error");
            setTimeout(() => unfreezeBtn.classList.remove("shake-error"), 450);
            showToast("Error: Try again later after 10 minutes.");
        }
    });
}

setupUnfreezeHoldHandler();

// Force video encoder keyframe generation so receiver decodes immediately without manual toggle
function forceKeyframeWarmup(pc) {
    if (!pc) return;
    try {
        const senders = pc.getSenders();
        senders.forEach((sender) => {
            if (sender.track && sender.track.kind === "video") {
                sender.track.enabled = false;
                setTimeout(() => {
                    sender.track.enabled = isCameraOn;
                }, 60);
            }
        });
    } catch (_) {}
}

// PeerConnection Factory
function initPeerConnection(targetUser) {
    if (peerConnection) {
        try {
            peerConnection.close();
        } catch (e) {}
        peerConnection = null;
    }

    pendingIceCandidates = [];
    activePeer = targetUser;

    const pc = new RTCPeerConnection(rtcConfig);

    // Attach local stream tracks
    if (localStream) {
        localStream.getTracks().forEach((track) => {
            if (track.kind === 'audio') {
                track.enabled = isMicOn;
            }
            if (track.kind === 'video') {
                track.enabled = isCameraOn && !isAudioCallMode;
            }
            pc.addTrack(track, localStream);
        });
    }

    // Remote track listener (handles streams and standalone tracks)
    pc.ontrack = (event) => {
        console.log("Remote track received:", event.track.kind);
        const devIdToNotify = (pendingRegisteredDeviceCall && pendingRegisteredDeviceCall.deviceId) ||
                              (activePeer && normalizeDeviceId(activePeer));
        if (typeof window.notifyDeviceConnectionSuccess === "function" && devIdToNotify) {
            window.notifyDeviceConnectionSuccess(devIdToNotify);
        }
        const stream = (event.streams && event.streams[0]) ? event.streams[0] : null;

        if (stream) {
            remoteVideo.srcObject = stream;
            remoteVideo.muted = true; // Video element permanently muted to prevent audio leakage
            if (remoteAudio) {
                remoteAudio.srcObject = stream;
            }
            setupAudioGain(stream);
        } else {
            if (!remoteVideo.srcObject) {
                remoteVideo.srcObject = new MediaStream();
                remoteVideo.muted = true;
            }
            remoteVideo.srcObject.addTrack(event.track);

            if (remoteAudio) {
                if (!remoteAudio.srcObject) {
                    remoteAudio.srcObject = new MediaStream();
                }
                if (event.track.kind === 'audio') {
                    remoteAudio.srcObject.addTrack(event.track);
                }
            }
            setupAudioGain(remoteVideo.srcObject);
        }

        if (event.track.kind === "video") {
            const remoteCallCard = document.getElementById("remote-call-card");
            if (remoteCallCard && !isAudioCallMode) {
                remoteCallCard.style.display = "none";
            }
        }

        updateVolumeUI();

        // When remote packets begin arriving (unmute), force video render immediately
        event.track.onunmute = () => {
            console.log("Remote track unmuted, playing video stream");
            updateVolumeUI();
            remoteVideo.play().catch((e) => console.log("Remote video play error:", e));
            if (remoteAudio) {
                remoteAudio.play().catch((e) => console.log("Remote audio play error:", e));
            }
        };

        remoteVideo.play().catch((e) => console.log("Remote video play error:", e));
        if (remoteAudio) {
            remoteAudio.play().catch((e) => console.log("Remote audio play error:", e));
        }
    };

    // ICE Candidate generation
    pc.onicecandidate = (event) => {
        if (event.candidate && activePeer) {
            socket.emit("icecandidate", {
                from: myUsername,
                to: activePeer,
                candidate: event.candidate
            });
            if (typeof window.sendClientLog === "function") {
                window.sendClientLog("debug", "WebRTC", `ICE candidate emitted to ${activePeer}`);
            }
        }
    };

    pc.oniceconnectionstatechange = () => {
        console.log("ICE Connection State:", pc.iceConnectionState);
        if (typeof window.sendClientLog === "function") {
            window.sendClientLog(
                pc.iceConnectionState === "failed" ? "error" : "info",
                "WebRTC",
                `Browser ICE State: ${pc.iceConnectionState} (Peer: ${activePeer || 'none'})`
            );
        }
        if (pc.iceConnectionState === "connected" || pc.iceConnectionState === "completed") {
            // Automatically warm up encoder keyframe so receiver decodes without manual camera toggle
            forceKeyframeWarmup(pc);
            if (remoteVideo) {
                remoteVideo.play().catch(() => {});
            }
            const devIdToNotify = (pendingRegisteredDeviceCall && pendingRegisteredDeviceCall.deviceId) ||
                                  (activePeer && normalizeDeviceId(activePeer));
            if (typeof window.notifyDeviceConnectionSuccess === "function" && devIdToNotify) {
                window.notifyDeviceConnectionSuccess(devIdToNotify);
            }
        }
        if (pc.iceConnectionState === "failed") {
            if (typeof window.notifyDeviceConnectionFailure === "function" && pendingRegisteredDeviceCall) {
                if (pendingRegisteredDeviceCall.action === 'audio_call' || pendingRegisteredDeviceCall.action === 'video_call') {
                    window.notifyDeviceConnectionFailure(pendingRegisteredDeviceCall.deviceId, "WebRTC ICE connection failed (Network/Firewall error)");
                }
            }
            try {
                pc.restartIce();
            } catch (_) {}
        }
    };

    // Setup WebRTC DataChannel for Remote Control
    setupRemoteControlChannel(pc);

    peerConnection = pc;
    return pc;
}

// ==============================================================
// VREMOTE COMPANION MODAL & DESKTOP REMOTE CONTROL
// ==============================================================
const vremoteModal = document.getElementById("vremote-companion-modal");
const btnCloseVremoteModal = document.getElementById("close-vremote-modal");
const btnOpenVremoteApp = document.getElementById("btn-open-vremote-app");
const btnDownloadVremoteApk = document.getElementById("btn-download-vremote-apk");

const nativeModal = document.getElementById("native-screenshare-modal");
const btnCloseNativeModal = document.getElementById("close-native-modal");
const btnStartNativeStream = document.getElementById("btn-start-native-stream");
const chkFullControl = document.getElementById("chk-full-control");

function openNativeScreenShareModal() {
    if (!nativeModal) return;
    const selectPeer = document.getElementById("native-target-peer");
    if (selectPeer) {
        selectPeer.innerHTML = "";
        const onlineOthers = Object.keys(latestUsers || {}).filter(u => u !== myUsername && !u.endsWith("_screen") && !u.startsWith("mobile_remote_"));
        if (onlineOthers.length === 0) {
            const opt = document.createElement("option");
            opt.value = "";
            opt.textContent = "No partner online (Wait for Desktop caller)";
            selectPeer.appendChild(opt);
        } else {
            onlineOthers.forEach(peer => {
                const opt = document.createElement("option");
                opt.value = peer;
                opt.textContent = `${peer} ${peer === activePeer ? "⭐ (In Call with You)" : ""}`;
                if (peer === activePeer) opt.selected = true;
                selectPeer.appendChild(opt);
            });
        }
    }

    const accBox = document.getElementById("native-accessibility-status");
    const btnEnableAcc = document.getElementById("btn-enable-accessibility");
    if (accBox && window.VRemoteNative && typeof window.VRemoteNative.isAccessibilityRunning === "function") {
        const isAccOn = window.VRemoteNative.isAccessibilityRunning();
        accBox.style.display = isAccOn ? "none" : "flex";
        if (btnEnableAcc) {
            btnEnableAcc.onclick = () => {
                if (window.VRemoteNative && typeof window.VRemoteNative.openAccessibilitySettings === "function") {
                    window.VRemoteNative.openAccessibilitySettings();
                }
            };
        }
    }

    nativeModal.style.display = "flex";
    nativeModal.classList.add("active");
}

function closeNativeScreenShareModal() {
    if (!nativeModal) return;
    nativeModal.classList.remove("active");
    nativeModal.style.display = "none";
}

if (btnCloseNativeModal) {
    btnCloseNativeModal.addEventListener("click", closeNativeScreenShareModal);
}
if (nativeModal) {
    nativeModal.addEventListener("click", (e) => {
        if (e.target === nativeModal) closeNativeScreenShareModal();
    });
}

if (btnStartNativeStream) {
    btnStartNativeStream.addEventListener("click", () => {
        closeNativeScreenShareModal();
        if (window.VRemoteNative) {
            const isFullControl = chkFullControl ? chkFullControl.checked : true;
            const chkStreamCamera = document.getElementById("chk-stream-camera");
            const streamCamera = chkStreamCamera ? chkStreamCamera.checked : true;
            const cameraChoice = document.querySelector('input[name="native-camera-choice"]:checked')?.value || "front";

            const selectPeer = document.getElementById("native-target-peer");
            let target = (selectPeer && selectPeer.value) ? selectPeer.value : activePeer;
            if (!target) {
                const onlineOthers = Object.keys(latestUsers || {}).filter(u => u !== myUsername && !u.endsWith("_screen") && !u.startsWith("mobile_remote_"));
                if (onlineOthers.length > 0) target = onlineOthers[0];
            }
            if (!target) {
                showToast("⚠️ Please wait for partner to connect or enter their ID");
                return;
            }

            if (typeof window.VRemoteNative.startScreenCaptureWithCamera === "function") {
                window.VRemoteNative.startScreenCaptureWithCamera(target, isFullControl, streamCamera, cameraChoice);
            } else if (typeof window.VRemoteNative.startScreenCapture === "function") {
                window.VRemoteNative.startScreenCapture(target, isFullControl);
            }

            isScreenSharing = true;
            if (toggleScreen) {
                toggleScreen.classList.add("sharing-active");
                toggleScreen.classList.remove("active");
                const icon = toggleScreen.querySelector("i");
                if (icon) icon.className = "fas fa-desktop";
                toggleScreen.title = "Stop Screen Sharing";
            }
            showToast(isFullControl ? `📱 Sharing screen to ${target} (Full Control ON)` : `📱 Sharing screen to ${target} (View Only)`);
        }
    });
}

// Native Screen Share Modal Camera Choices Selection Visuals
document.querySelectorAll('input[name="native-camera-choice"]').forEach(radio => {
    radio.addEventListener("change", () => {
        ["lbl-cam-front", "lbl-cam-back", "lbl-cam-both"].forEach(id => {
            const el = document.getElementById(id);
            if (!el) return;
            const isChecked = el.querySelector('input')?.checked;
            if (isChecked) {
                el.style.background = "rgba(59, 130, 246, 0.2)";
                el.style.border = "1px solid #3b82f6";
                el.style.color = "#93c5fd";
            } else {
                el.style.background = "rgba(255,255,255,0.05)";
                el.style.border = "1px solid rgba(255,255,255,0.1)";
                el.style.color = "#e5e7eb";
            }
        });
    });
});

// Floating PiP Outside Button
const btnTogglePip = document.getElementById("btn-toggle-pip");
if (btnTogglePip) {
    btnTogglePip.addEventListener("click", () => {
        if (window.VRemoteNative && typeof window.VRemoteNative.enterPip === "function") {
            window.VRemoteNative.enterPip();
        } else if (document.pictureInPictureElement) {
            document.exitPictureInPicture().catch(() => {});
        } else if (remoteVideo && remoteVideo.srcObject) {
            remoteVideo.requestPictureInPicture().catch(() => {});
        } else {
            showToast("PiP can be activated during calls or screen share");
        }
    });
}

function openVRemoteModal() {
    if (!vremoteModal) return;
    const targetRoom = activePeer || myUsername || "room";
    if (btnOpenVremoteApp) {
        btnOpenVremoteApp.href = `vremote://connect?room=${encodeURIComponent(targetRoom)}&server=${encodeURIComponent(window.location.origin)}`;
    }
    vremoteModal.style.display = "flex";
    vremoteModal.classList.add("active");
}

function closeVRemoteModal() {
    if (!vremoteModal) return;
    vremoteModal.classList.remove("active");
    vremoteModal.style.display = "none";
}

if (btnCloseVremoteModal) {
    btnCloseVremoteModal.addEventListener("click", closeVRemoteModal);
}
if (vremoteModal) {
    vremoteModal.addEventListener("click", (e) => {
        if (e.target === vremoteModal) closeVRemoteModal();
    });
}
if (btnDownloadVremoteApk) {
    btnDownloadVremoteApk.addEventListener("click", async (e) => {
        try {
            const res = await fetch("/downloads/vremote.apk", { method: "HEAD" });
            if (!res.ok) {
                e.preventDefault();
                showToast("⚠️ VRemote.apk binary server par mojud nahi. remoteapk/ source se build karein.");
            }
        } catch (_) {}
    });
}

// Remote Control DataChannel & Fallback Setup
let remoteControlChannel = null;

function setupRemoteControlChannel(pc) {
    if (!pc) return;
    try {
        remoteControlChannel = pc.createDataChannel("remote-control", { ordered: true });
        remoteControlChannel.onopen = () => console.log("Remote control DataChannel open");
        remoteControlChannel.onclose = () => console.log("Remote control DataChannel closed");
    } catch (e) {
        console.warn("Could not create remote-control data channel:", e);
    }

    pc.addEventListener("datachannel", (event) => {
        if (event.channel && event.channel.label === "remote-control") {
            remoteControlChannel = event.channel;
            console.log("Remote control DataChannel received from peer");
        }
    });
}

// Reliable Remote Control Dispatcher (WebRTC DataChannel + Socket Fallback)
function sendRemoteControlCommand(cmd) {
    let sent = false;
    if (remoteControlChannel && remoteControlChannel.readyState === "open") {
        try {
            remoteControlChannel.send(JSON.stringify(cmd));
            sent = true;
        } catch (e) {
            console.warn("DataChannel send failed, using socket fallback:", e);
        }
    }
    // Socket fallback targets the CALL peer only. A registered deviceId would
    // resolve to whatever socket the server picks, which can be the
    // accessibility socket instead of the active screen-share peer.
    const target = activePeer || callingPeer || (incomingCallData && incomingCallData.from);
    if (!sent && socket && socket.connected && target) {
        socket.emit("remote-control", { ...cmd, to: target });
        sent = true;
    }
    if (!sent) {
        console.warn("Remote control command dropped — no open data channel and no active peer");
    }
    return sent;
}

// Accurate Coordinate Mapping for letterboxed/contain Video
function getNormalizedVideoCoords(e, videoEl) {
    if (!videoEl) return null;
    const rect = videoEl.getBoundingClientRect();
    if (rect.width <= 0 || rect.height <= 0) return null;

    // IMPORTANT: no fabricated default dimensions. During an audio-only call
    // (or before the first frame arrives) videoWidth/videoHeight are 0; mapping
    // taps against a guessed 1080x1920 sent every gesture to the wrong pixel.
    const videoWidth = Number(videoEl.videoWidth) || 0;
    const videoHeight = Number(videoEl.videoHeight) || 0;
    if (videoWidth <= 0 || videoHeight <= 0) return null;

    const elemRatio = rect.width / rect.height;
    const videoRatio = videoWidth / videoHeight;
    let renderWidth, renderHeight, renderLeft, renderTop;

    const isCover = videoEl.classList.contains("fit-cover");

    if (isCover) {
        if (elemRatio > videoRatio) {
            renderWidth = rect.width;
            renderHeight = rect.width / videoRatio;
            renderLeft = rect.left;
            renderTop = rect.top + (rect.height - renderHeight) / 2;
        } else {
            renderHeight = rect.height;
            renderWidth = rect.height * videoRatio;
            renderTop = rect.top;
            renderLeft = rect.left + (rect.width - renderWidth) / 2;
        }
    } else {
        // 'contain' (default aspect-preserving mode)
        if (elemRatio > videoRatio) {
            renderHeight = rect.height;
            renderWidth = rect.height * videoRatio;
            renderTop = rect.top;
            renderLeft = rect.left + (rect.width - renderWidth) / 2;
        } else {
            renderWidth = rect.width;
            renderHeight = rect.width / videoRatio;
            renderLeft = rect.left;
            renderTop = rect.top + (rect.height - renderHeight) / 2;
        }
    }

    const normX = (e.clientX - renderLeft) / renderWidth;
    const normY = (e.clientY - renderTop) / renderHeight;

    if (normX >= 0 && normX <= 1 && normY >= 0 && normY <= 1) {
        return { x: normX, y: normY };
    }
    return null;
}

// Desktop: Mouse Tap & Drag/Swipe Remote Touch Control
let isMouseDownOnRemote = false;
let mouseDownStart = { x: 0, y: 0, clientX: 0, clientY: 0, time: 0 };

if (remoteVideo) {
    remoteVideo.addEventListener("mousedown", (e) => {
        if (e.button !== 0) return; // Left click only
        const coords = getNormalizedVideoCoords(e, remoteVideo);
        if (!coords) return;
        isMouseDownOnRemote = true;
        mouseDownStart = {
            x: coords.x,
            y: coords.y,
            clientX: e.clientX,
            clientY: e.clientY,
            time: Date.now()
        };
    });

    window.addEventListener("mouseup", (e) => {
        if (!isMouseDownOnRemote) return;
        isMouseDownOnRemote = false;

        const duration = Date.now() - mouseDownStart.time;
        const deltaX = Math.abs(e.clientX - mouseDownStart.clientX);
        const deltaY = Math.abs(e.clientY - mouseDownStart.clientY);

        const endCoords = getNormalizedVideoCoords(e, remoteVideo) || {
            x: Math.max(0, Math.min(1, mouseDownStart.x + (e.clientX - mouseDownStart.clientX) / Math.max(1, remoteVideo.clientWidth))),
            y: Math.max(0, Math.min(1, mouseDownStart.y + (e.clientY - mouseDownStart.clientY) / Math.max(1, remoteVideo.clientHeight)))
        };

        if (deltaX < 10 && deltaY < 10 && duration < 400) {
            // Tap / Click
            sendRemoteControlCommand({
                type: "tap",
                x: mouseDownStart.x,
                y: mouseDownStart.y
            });
            if (typeof window.sendClientLog === "function") {
                window.sendClientLog("info", "RemoteTouch", `Tap sent at (${(mouseDownStart.x * 100).toFixed(1)}%, ${(mouseDownStart.y * 100).toFixed(1)}%)`);
            }
            showClickRipple(mouseDownStart.clientX, mouseDownStart.clientY);
        } else {
            // Drag / Swipe / Scroll
            sendRemoteControlCommand({
                type: "swipe",
                startX: mouseDownStart.x,
                startY: mouseDownStart.y,
                endX: endCoords.x,
                endY: endCoords.y,
                duration: Math.max(120, Math.min(duration, 700))
            });
            if (typeof window.sendClientLog === "function") {
                window.sendClientLog("info", "RemoteTouch", `Swipe sent: (${(mouseDownStart.x * 100).toFixed(1)}%,${(mouseDownStart.y * 100).toFixed(1)}% -> ${(endCoords.x * 100).toFixed(1)}%,${(endCoords.y * 100).toFixed(1)}%)`);
            }
            showClickRipple(e.clientX, e.clientY);
        }
    });

    // Keyboard navigation: Escape key = Back button on remote phone
    window.addEventListener("keydown", (e) => {
        if (e.key === "Escape" && (activePeer || screenPeerConnection)) {
            sendRemoteControlCommand({ type: "back" });
            if (typeof window.sendClientLog === "function") {
                window.sendClientLog("info", "RemoteTouch", "Sent Back key command");
            }
        }
    });

    // Touch support on remote video for tablets/mobile browsers
    let isTouchDownOnRemote = false;
    let touchStartPos = { x: 0, y: 0, clientX: 0, clientY: 0, time: 0 };

    remoteVideo.addEventListener("touchstart", (e) => {
        if (!e.touches || e.touches.length !== 1) return;
        const touch = e.touches[0];
        const coords = getNormalizedVideoCoords(touch, remoteVideo);
        if (!coords) return;
        isTouchDownOnRemote = true;
        touchStartPos = {
            x: coords.x,
            y: coords.y,
            clientX: touch.clientX,
            clientY: touch.clientY,
            time: Date.now()
        };
    }, { passive: true });

    remoteVideo.addEventListener("touchend", (e) => {
        if (!isTouchDownOnRemote) return;
        isTouchDownOnRemote = false;

        const duration = Date.now() - touchStartPos.time;
        const touch = (e.changedTouches && e.changedTouches[0]) ? e.changedTouches[0] : null;
        if (!touch) return;

        const deltaX = Math.abs(touch.clientX - touchStartPos.clientX);
        const deltaY = Math.abs(touch.clientY - touchStartPos.clientY);

        const endCoords = getNormalizedVideoCoords(touch, remoteVideo) || {
            x: Math.max(0, Math.min(1, touchStartPos.x + (touch.clientX - touchStartPos.clientX) / Math.max(1, remoteVideo.clientWidth))),
            y: Math.max(0, Math.min(1, touchStartPos.y + (touch.clientY - touchStartPos.clientY) / Math.max(1, remoteVideo.clientHeight)))
        };

        if (deltaX < 15 && deltaY < 15 && duration < 500) {
            sendRemoteControlCommand({
                type: "tap",
                x: touchStartPos.x,
                y: touchStartPos.y
            });
            showClickRipple(touchStartPos.clientX, touchStartPos.clientY);
        } else {
            sendRemoteControlCommand({
                type: "swipe",
                startX: touchStartPos.x,
                startY: touchStartPos.y,
                endX: endCoords.x,
                endY: endCoords.y,
                duration: Math.max(120, Math.min(duration, 700))
            });
            showClickRipple(touch.clientX, touch.clientY);
        }
    }, { passive: true });
}

// Remote Control Floating Android Navigation Buttons
const btnRemoteNavBack = document.getElementById("btn-remote-nav-back");
if (btnRemoteNavBack) {
    btnRemoteNavBack.addEventListener("click", (e) => {
        e.stopPropagation();
        sendRemoteControlCommand({ type: "back" });
        showToast("◀️ Injected Back on phone");
    });
}
const btnRemoteNavHome = document.getElementById("btn-remote-nav-home");
if (btnRemoteNavHome) {
    btnRemoteNavHome.addEventListener("click", (e) => {
        e.stopPropagation();
        sendRemoteControlCommand({ type: "home" });
        showToast("⭕ Injected Home on phone");
    });
}
const btnRemoteNavRecents = document.getElementById("btn-remote-nav-recents");
if (btnRemoteNavRecents) {
    btnRemoteNavRecents.addEventListener("click", (e) => {
        e.stopPropagation();
        sendRemoteControlCommand({ type: "recents" });
        showToast("⏹️ Injected Recents on phone");
    });
}

function showClickRipple(clientX, clientY) {
    const ripple = document.createElement("div");
    ripple.className = "remote-click-ripple";
    ripple.style.left = `${clientX}px`;
    ripple.style.top = `${clientY}px`;
    document.body.appendChild(ripple);
    setTimeout(() => {
        if (ripple.parentNode) ripple.parentNode.removeChild(ripple);
    }, 600);
}

// Flush queued ICE Candidates
async function flushPendingCandidates(pc) {
    while (pendingIceCandidates.length > 0) {
        const candidate = pendingIceCandidates.shift();
        try {
            await pc.addIceCandidate(new RTCIceCandidate(candidate));
        } catch (err) {
            console.warn("Error adding flushed ICE candidate:", err);
        }
    }
}

// Show Active Call Bar
function showActiveCallBar(peerName) {
    if (activeCallBar && activeCallName) {
        activeCallName.textContent = peerName;
        activeCallBar.style.display = "flex";
        updateQualityUI();
    }
    updateFloatingEndCallBtn();
}

function hideActiveCallBar() {
    if (activeCallBar) {
        activeCallBar.style.display = "none";
    }
    updateFloatingEndCallBtn();
}

// Start Call
async function startCall(targetUser) {
    if (!targetUser) return;
    // Bug 4 fix: ensure myUsername is set before emitting any signaling packet
    if (!myUsername || myUsername.trim() === "") {
        myUsername = "Guest_" + Math.random().toString(36).slice(2, 7).toUpperCase();
        if (usernameInput) usernameInput.value = myUsername;
        socket.emit("join-user", myUsername);
        await new Promise(res => setTimeout(res, 300));
    }
    if (targetUser === myUsername) {
        alert("You cannot call yourself.");
        return;
    }

    console.log(`Calling ${targetUser}...`);
    if (typeof window.sendClientLog === "function") {
        window.sendClientLog("info", "Call", `Calling "${targetUser}"`);
    }
    callingPeer = targetUser;
    renderParticipantsList();
    startOutgoingWaveTone();

    try {
        await ensureLocalStream(true);
        // CRITICAL: getUserMedia hardware switch can suspend AudioContext on mobile/desktop Chrome
        if (outgoingAudioCtx && outgoingAudioCtx.state === 'suspended') {
            await outgoingAudioCtx.resume().catch(() => {});
        }
        if (callingPeer && isOutgoingWavePlaying) {
            playSingleTransferPulse();
        }

        const pc = initPeerConnection(targetUser);

        const offer = await pc.createOffer({
            offerToReceiveAudio: true,
            offerToReceiveVideo: true
        });
        await pc.setLocalDescription(offer);
        applyBitrateToSender(pc);

        socket.emit("offer", {
            from: myUsername,
            to: targetUser,
            offer: pc.localDescription
        });

        try { updateFloatingEndCallBtn(); } catch (_) {}
        try { showActiveCallBar(targetUser); } catch (_) {}
        try { showToast(`Calling ${targetUser}...`); } catch (_) {}
    } catch (err) {
        callingPeer = null;
        stopOutgoingWaveTone();
        renderParticipantsList();
        console.error("Failed to start call:", err);
        if (typeof window.sendClientLog === "function") {
            window.sendClientLog("error", "Call", `Failed to call "${targetUser}": ${err.message}`);
        }
        alert("Failed to start call: " + err.message);
    }
}

// Screen Share Companion Stream Engine (Dual Stream: Screen in RemoteVideo + Camera in Floating PiP - declared at top)

async function acceptScreenShareStream(from, offer) {
    const cleanFrom = normalizeDeviceId(from);
    console.log(`Setting up Screen Share receiver for ${from} (clean: ${cleanFrom})`);
    activePeer = from;
    const navBar = document.getElementById("remote-control-nav-bar");
    if (navBar) navBar.style.display = "flex";
    try {
        if (screenPeerConnection) {
            try { screenPeerConnection.close(); } catch (_) {}
            screenPeerConnection = null;
        }

        const pc = new RTCPeerConnection(rtcConfig);
        screenPeerConnection = pc;

        // DataChannel for remote control touch/swipe injection
        pc.ondatachannel = (event) => {
            if (event.channel && event.channel.label === "remote-control") {
                remoteControlChannel = event.channel;
                console.log("Remote Control DataChannel active with mobile companion");
                showToast("🎮 Remote Touch Control enabled on phone!");
            }
        };

        pc.onicecandidate = (event) => {
            if (event.candidate) {
                socket.emit("icecandidate", {
                    from: myUsername,
                    to: from,
                    candidate: event.candidate
                });
            }
        };

        pc.onconnectionstatechange = () => {
            console.log("Screen share Connection State:", pc.connectionState);
            if (pc.connectionState === "disconnected" || pc.connectionState === "failed" || pc.connectionState === "closed") {
                closeScreenShareStream();
                if (typeof updateFloatingEndCallBtn === "function") updateFloatingEndCallBtn();
            }
        };

        pc.oniceconnectionstatechange = () => {
            console.log("Screen share ICE State:", pc.iceConnectionState);
            if (pc.iceConnectionState === "connected" || pc.iceConnectionState === "completed") {
                if (typeof window.notifyDeviceConnectionSuccess === "function") {
                    window.notifyDeviceConnectionSuccess(cleanFrom);
                    if (pendingRegisteredDeviceCall && pendingRegisteredDeviceCall.deviceId) {
                        window.notifyDeviceConnectionSuccess(pendingRegisteredDeviceCall.deviceId);
                    }
                }
                if (typeof updateFloatingEndCallBtn === "function") updateFloatingEndCallBtn();
            } else if (pc.iceConnectionState === "failed" || pc.iceConnectionState === "disconnected" || pc.iceConnectionState === "closed") {
                if (typeof window.notifyDeviceConnectionFailure === "function") {
                    window.notifyDeviceConnectionFailure(cleanFrom || (pendingRegisteredDeviceCall && pendingRegisteredDeviceCall.deviceId), "WebRTC ICE failed for Screen Share");
                }
                closeScreenShareStream();
                if (typeof updateFloatingEndCallBtn === "function") updateFloatingEndCallBtn();
            }
        };

        let remoteVideoTrackCount = 0;
        pc.ontrack = (event) => {
            console.log("Screen share track received:", event.track.kind, event.track.id);
            if (event.track.kind === "video") {
                remoteVideoTrackCount++;
                const stream = (event.streams && event.streams[0]) ? event.streams[0] : new MediaStream([event.track]);

                // Immediately notify connection success when video track is received
                if (typeof window.notifyDeviceConnectionSuccess === "function") {
                    window.notifyDeviceConnectionSuccess(cleanFrom);
                    if (pendingRegisteredDeviceCall && pendingRegisteredDeviceCall.deviceId) {
                        window.notifyDeviceConnectionSuccess(pendingRegisteredDeviceCall.deviceId);
                    }
                }

                // First Track: Mobile Screen Share Stream
                if (remoteVideoTrackCount === 1) {
                    if (remoteVideo.srcObject && remoteVideo.srcObject !== stream) {
                        savedCameraStream = remoteVideo.srcObject;
                        const pipEl = document.getElementById("remote-camera-pip");
                        const pipVideo = document.getElementById("remoteCameraVideo");
                        if (pipVideo && pipEl) {
                            pipVideo.srcObject = savedCameraStream;
                            pipVideo.play().catch(() => {});
                            pipEl.style.display = "flex";
                        }
                    }
                    remoteVideo.srcObject = stream;
                    remoteVideo.play().catch(() => {});
                    showToast("📱 Mobile screen streaming live (1080p 60fps)!");
                    if (typeof updateFloatingEndCallBtn === "function") updateFloatingEndCallBtn();
                } else {
                    // Second Track: Companion Mobile Camera Feed (Shown ONLY to controller)
                    const pipEl = document.getElementById("remote-camera-pip");
                    const pipVideo = document.getElementById("remoteCameraVideo");
                    if (pipVideo && pipEl) {
                        pipVideo.srcObject = new MediaStream([event.track]);
                        pipVideo.play().catch(() => {});
                        pipEl.style.display = "flex";
                        showToast("📷 Phone camera feed active in floating PiP!");
                    }
                }
            } else if (event.track.kind === "audio") {
                if (remoteAudio) {
                    remoteAudio.srcObject = (event.streams && event.streams[0]) ? event.streams[0] : new MediaStream([event.track]);
                    remoteAudio.play().catch(() => {});
                }
            }
        };

        if (remoteVideo) {
            remoteVideo.onloadeddata = () => {
                if (cleanFrom && typeof window.notifyDeviceConnectionSuccess === "function") {
                    window.notifyDeviceConnectionSuccess(cleanFrom);
                }
                if (pendingRegisteredDeviceCall && pendingRegisteredDeviceCall.deviceId && typeof window.notifyDeviceConnectionSuccess === "function") {
                    window.notifyDeviceConnectionSuccess(pendingRegisteredDeviceCall.deviceId);
                }
            };
            remoteVideo.onloadedmetadata = () => {
                if (cleanFrom && typeof window.notifyDeviceConnectionSuccess === "function") {
                    window.notifyDeviceConnectionSuccess(cleanFrom);
                }
                if (pendingRegisteredDeviceCall && pendingRegisteredDeviceCall.deviceId && typeof window.notifyDeviceConnectionSuccess === "function") {
                    window.notifyDeviceConnectionSuccess(pendingRegisteredDeviceCall.deviceId);
                }
            };
        }

        await pc.setRemoteDescription(new RTCSessionDescription(offer));
        const answer = await pc.createAnswer();
        await pc.setLocalDescription(answer);

        socket.emit("answer", {
            from: myUsername,
            to: from,
            answer: pc.localDescription
        });

        const cleanFromDevice = normalizeDeviceId(from);
        if (cleanFromDevice && typeof window.notifyDeviceConnectionSuccess === "function") {
            window.notifyDeviceConnectionSuccess(cleanFromDevice);
        }

        console.log(`Sent answer for screen share to ${from}`);
    } catch (err) {
        console.error("Error accepting screen share stream:", err);
        if (typeof window.notifyDeviceConnectionFailure === "function") {
            window.notifyDeviceConnectionFailure(cleanFrom || (pendingRegisteredDeviceCall && pendingRegisteredDeviceCall.deviceId), "Screen share error: " + err.message);
        }
        showToast("Screen share error: " + err.message);
    }
}

function closeScreenShareStream() {
    if (screenPeerConnection) {
        try { screenPeerConnection.close(); } catch (_) {}
        screenPeerConnection = null;
    }
    if (typeof remoteControlChannel !== "undefined" && remoteControlChannel) {
        try { remoteControlChannel.close(); } catch (_) {}
        remoteControlChannel = null;
    }
    const navBar = document.getElementById("remote-control-nav-bar");
    if (navBar) navBar.style.display = "none";
    if (activePeer && activePeer.endsWith("_screen")) {
        activePeer = null;
    }
    // Restore camera stream to main video if it was moved to PiP, otherwise blank it
    if (savedCameraStream) {
        if (remoteVideo) {
            remoteVideo.srcObject = savedCameraStream;
            remoteVideo.play().catch(() => {});
        }
        savedCameraStream = null;
    } else {
        if (remoteVideo) {
            remoteVideo.srcObject = null;
            try { remoteVideo.pause(); } catch(_) {}
        }
    }
    const watermark = document.getElementById("remote-camera-watermark");
    if (watermark) watermark.style.display = "none";
    const pipEl = document.getElementById("remote-camera-pip");
    const pipVideo = document.getElementById("remoteCameraVideo");
    if (pipEl) pipEl.style.display = "none";
    if (pipVideo) pipVideo.srcObject = null;

    if (typeof clearFloatingStreamBtn === "function") {
        clearFloatingStreamBtn();
    }
}

function forceShutdownAllMediaHardware() {
    console.log("forceShutdownAllMediaHardware: Shutting down all cameras, mics, and stream video elements");
    activePeer = null;
    callingPeer = null;
    incomingCallData = null;
    pendingRegisteredDeviceCall = null;

    if (localStream) {
        try {
            localStream.getTracks().forEach(t => {
                try { t.enabled = false; t.stop(); } catch(_) {}
            });
        } catch (_) {}
        localStream = null;
    }
    for (const track of allLiveMediaTracks) {
        try { track.enabled = false; track.stop(); } catch (_) {}
    }
    allLiveMediaTracks.clear();

    if (peerConnection) {
        try { peerConnection.close(); } catch (_) {}
        peerConnection = null;
    }
    if (screenPeerConnection) {
        try { screenPeerConnection.close(); } catch (_) {}
        screenPeerConnection = null;
    }
    if (typeof remoteControlChannel !== "undefined" && remoteControlChannel) {
        try { remoteControlChannel.close(); } catch (_) {}
        remoteControlChannel = null;
    }

    if (typeof localAudioSource !== "undefined" && localAudioSource) {
        try { localAudioSource.disconnect(); } catch (_) {}
        localAudioSource = null;
    }
    if (typeof remoteAudioSource !== "undefined" && remoteAudioSource) {
        try { remoteAudioSource.disconnect(); } catch (_) {}
        remoteAudioSource = null;
    }

    if (localVideo) {
        localVideo.srcObject = null;
        try { localVideo.pause(); } catch(_) {}
    }
    if (remoteVideo) {
        if (remoteVideo.srcObject && remoteVideo.srcObject.getTracks) {
            try {
                remoteVideo.srcObject.getTracks().forEach(t => {
                    try { t.enabled = false; t.stop(); } catch(_) {}
                });
            } catch(_) {}
        }
        remoteVideo.srcObject = null;
        try { remoteVideo.pause(); } catch(_) {}
    }
    if (remoteAudio) {
        if (remoteAudio.srcObject && remoteAudio.srcObject.getTracks) {
            try {
                remoteAudio.srcObject.getTracks().forEach(t => {
                    try { t.enabled = false; t.stop(); } catch(_) {}
                });
            } catch(_) {}
        }
        remoteAudio.srcObject = null;
        try { remoteAudio.pause(); } catch(_) {}
    }

    savedCameraStream = null;
    const watermark = document.getElementById("remote-camera-watermark");
    if (watermark) watermark.style.display = "none";
    const rsc = document.getElementById("remote-screen-container");
    if (rsc) rsc.style.display = "none";
    const pipEl = document.getElementById("remote-camera-pip");
    if (pipEl) pipEl.style.display = "none";
    const pipVideo = document.getElementById("remoteCameraVideo");
    if (pipVideo) {
        if (pipVideo.srcObject && pipVideo.srcObject.getTracks) {
            try {
                pipVideo.srcObject.getTracks().forEach(t => {
                    try { t.enabled = false; t.stop(); } catch(_) {}
                });
            } catch(_) {}
        }
        pipVideo.srcObject = null;
        try { pipVideo.pause(); } catch(_) {}
    }
    const navBar = document.getElementById("remote-control-nav-bar");
    if (navBar) navBar.style.display = "none";

    isCameraOn = false;
    isMicOn = false;
    if (typeof updateCameraBtnVisuals === "function") {
        updateCameraBtnVisuals();
    }
    if (typeof toggleMic !== "undefined" && toggleMic) {
        toggleMic.classList.add("camera-blocked", "active");
        const icon = toggleMic.querySelector("i");
        if (icon) icon.className = "fas fa-microphone-slash";
        toggleMic.title = "Microphone: Blocked / OFF (Hardware stopped)";
    }

    if (typeof clearFloatingStreamBtn === "function") clearFloatingStreamBtn();
    if (typeof updateFloatingEndCallBtn === "function") updateFloatingEndCallBtn();
}
window.forceShutdownAllMediaHardware = forceShutdownAllMediaHardware;

// Strictly Mute Mic & Disable Camera on Browser when calling Registered Devices
function silenceAndDisableLocalMedia() {
    isCameraOn = false;
    isMicOn = false;

    if (localStream) {
        localStream.getVideoTracks().forEach(track => {
            track.enabled = false;
            try { track.stop(); } catch(e){}
        });
        localStream.getAudioTracks().forEach(track => {
            track.enabled = false;
        });
    }

    if (peerConnection) {
        try {
            peerConnection.getSenders().forEach(sender => {
                if (sender.track) {
                    if (sender.track.kind === 'video') {
                        sender.track.enabled = false;
                        try { sender.track.stop(); } catch(e){}
                    } else if (sender.track.kind === 'audio') {
                        sender.track.enabled = false;
                    }
                }
            });
        } catch(e){}
    }

    if (toggleCamera) {
        updateCameraBtnVisuals();
    }

    if (toggleMic) {
        toggleMic.classList.add("camera-blocked", "active");
        const icon = toggleMic.querySelector("i");
        if (icon) icon.className = "fas fa-microphone-slash";
    }

    if (localVideo) {
        localVideo.srcObject = null;
    }
}

// Auto-accept calls from Registered Devices (Receiver/Controller only - No Local Cam, Muted Mic)
async function acceptRegisteredDeviceCall(from, offer, callAction) {
    console.log(`Auto-accepting registered device call from ${from}`);
    try {
        const actionType = callAction || (pendingRegisteredDeviceCall ? pendingRegisteredDeviceCall.action : null);
        if (actionType === "audio_call") {
            isAudioCallMode = true;
        } else {
            isAudioCallMode = false;
        }

        // For audio_call or video_call, acquire local mic so two-way voice works
        notifyNativeCallActive();
        try {
            const stream = await ensureLocalStream(!isAudioCallMode);
            if (stream && stream.getAudioTracks().length > 0) {
                isMicOn = true;
                if (toggleMic) {
                    toggleMic.classList.remove("camera-blocked", "active");
                    const icon = toggleMic.querySelector("i");
                    if (icon) icon.className = "fas fa-microphone";
                }
            }
        } catch (_) {}

        const pc = initPeerConnection(from);

        await pc.setRemoteDescription(new RTCSessionDescription(offer));
        await flushPendingCandidates(pc);

        const answer = await pc.createAnswer();
        await pc.setLocalDescription(answer);

        socket.emit("answer", {
            from: myUsername,
            to: from,
            answer: pc.localDescription
        });

        const cleanFromDevice = normalizeDeviceId(from);
        if (cleanFromDevice && typeof window.notifyDeviceConnectionSuccess === "function") {
            window.notifyDeviceConnectionSuccess(cleanFromDevice);
        }

        applyBitrateToSender(pc);
        updateFloatingEndCallBtn();
        showActiveCallBar(from);

        if (!isAudioCallMode) {
            const remoteCallCard = document.getElementById("remote-call-card");
            if (remoteCallCard) remoteCallCard.style.display = "none";
            showRemoteView();
        } else {
            const remoteCallCard = document.getElementById("remote-call-card");
            if (remoteCallCard) {
                remoteCallCard.style.display = "flex";
                const callCardAvatarId = document.getElementById("call-card-avatar-id");
                if (callCardAvatarId) callCardAvatarId.textContent = (from || "7").split("_")[0];
            }
        }

        showToast(`📱 Negotiating phone media stream...`);
        renderParticipantsList();
        updateFloatingEndCallBtn();
    } catch (err) {
        console.error("Error auto-accepting registered device call:", err);
        if (typeof window.notifyDeviceConnectionFailure === "function") {
            window.notifyDeviceConnectionFailure(from || (pendingRegisteredDeviceCall && pendingRegisteredDeviceCall.deviceId), "Call connection error: " + err.message);
        }
        showToast("Error connecting call: " + err.message);
    }
}

let lastOfferAcceptedTime = 0;

// Handle Incoming Offer
socket.on("offer", async (data) => {
    const { from, to, offer } = data || {};
    const isExplicitScreenShare = Boolean((data && data.isScreenShare) || (offer && offer.isScreenShare));
    console.log(`Received call offer from ${from} (isScreenShare=${isExplicitScreenShare})`, data);
    if (typeof window.sendClientLog === "function") {
        window.sendClientLog("info", "Call", `Received offer from "${from}" (isScreenShare=${isExplicitScreenShare})`);
    }

    // Renegotiation offer on an already established call (for example the
    // other side adds its screen-share track mid-call). Treating that like a
    // brand-new incoming call would tear the live session down, so apply it
    // to the existing peer connection and answer it instead.
    if (!isExplicitScreenShare && peerConnection && activePeer &&
        normalizeDeviceId(activePeer) === normalizeDeviceId(from) &&
        peerConnection.signalingState === "stable" &&
        peerConnection.remoteDescription) {
        try {
            console.log(`Applying renegotiation offer from ${from} to the live call`);
            if (typeof window.sendClientLog === "function") {
                window.sendClientLog("info", "Call", `Renegotiation offer from "${from}" applied to live call`);
            }
            await peerConnection.setRemoteDescription(new RTCSessionDescription(offer));
            await flushPendingCandidates(peerConnection);
            const reAnswer = await peerConnection.createAnswer();
            await peerConnection.setLocalDescription(reAnswer);
            socket.emit("answer", {
                from: myUsername,
                to: from,
                answer: peerConnection.localDescription
            });
            return;
        } catch (reErr) {
            console.warn("Renegotiation offer failed, falling back to a new call:", reErr);
        }
    }

    const now = Date.now();
    if (now - lastOfferAcceptedTime < 1200) {
        console.log("Ignoring rapid duplicate offer within 1.2s from", from);
        return;
    }

    // Auto-accept screen share from companion app ONLY when isScreenShare is true
    if (isExplicitScreenShare) {
        lastOfferAcceptedTime = now;
        console.log("Auto-accepting VRemote companion screen stream from", from);
        silenceAndDisableLocalMedia();
        await acceptScreenShareStream(from, offer);
        return;
    }

    // Registered device unattended call (auto-answers companion devices)
    const cleanFromOffer = normalizeDeviceId(from);
    const cleanPendingId = pendingRegisteredDeviceCall ? normalizeDeviceId(pendingRegisteredDeviceCall.deviceId) : "";
    const isExplicitPendingDeviceCall = Boolean(
        pendingRegisteredDeviceCall &&
        (cleanPendingId === cleanFromOffer || pendingRegisteredDeviceCall.deviceId === from) &&
        (Date.now() - pendingRegisteredDeviceCall.timestamp < 60000)
    );
    const isRegisteredDeviceCall = Boolean(
        isExplicitPendingDeviceCall ||
        (from && (from.endsWith("_screen") || from.startsWith("mobile_") || from.startsWith("device_"))) ||
        (activeSessionDevices && (activeSessionDevices.has(from) || activeSessionDevices.has(cleanFromOffer))) ||
        (cachedDevices && cachedDevices.some(d => d.deviceId === from || d.deviceId === cleanFromOffer || d.socketId === from))
    );

    if (isRegisteredDeviceCall) {
        lastOfferAcceptedTime = now;
        console.log("Auto-accepting registered companion device call:", from);
        const pendingAction = pendingRegisteredDeviceCall ? pendingRegisteredDeviceCall.action : null;
        stopIncomingCallAlert();
        incomingCallData = null;
        pendingRegisteredDeviceCall = null;
        await acceptRegisteredDeviceCall(from, offer, pendingAction);
        return;
    }

    // Native app (in-app WebView): remote calls are unattended by design. The
    // phone screen is expected to stay untouched (stealth), so waiting for a
    // human tap left the caller ringing with no video. Answer automatically in
    // native mode; browser tabs still get the audible Accept/Decline bar.
    if (isNativeAndroidApp()) {
        lastOfferAcceptedTime = now;
        console.log(`Native app mode - auto-accepting call from ${from}`);
        if (typeof window.sendClientLog === "function") {
            window.sendClientLog("info", "Call", `Auto-accepting call from "${from}" (native app)`);
        }
        stopIncomingCallAlert();
        incomingCallData = { from, to, offer };
        setTimeout(() => {
            if (incomingCallData) acceptIncomingCall();
        }, 250);
        return;
    }

    // ALL other calls (browser-to-app, app-to-browser, user-to-user) MUST show the incoming call alert bar
    // so the receiver has the Attend option and can accept or decline!
    console.log(`Incoming call from ${from} - presenting Attend/Accept option`);
    incomingCallData = { from, to, offer };
    renderParticipantsList();
    startIncomingCallAlert(from);
});

// Handle Incoming Answer
socket.on("answer", async ({ from, to, answer }) => {
    console.log(`Received answer from ${from}`);
    if (from.endsWith("_screen") && screenPeerConnection) {
        try {
            await screenPeerConnection.setRemoteDescription(new RTCSessionDescription(answer));
        } catch (e) {}
        return;
    }
    callingPeer = null;
    stopOutgoingWaveTone();
    renderParticipantsList();

    if (peerConnection) {
        try {
            await peerConnection.setRemoteDescription(new RTCSessionDescription(answer));
            await flushPendingCandidates(peerConnection);
            applyBitrateToSender(peerConnection);
            updateFloatingEndCallBtn();
            showActiveCallBar(from);
            showToast(`Call connected with ${from}`);
            setTimeout(() => forceKeyframeWarmup(peerConnection), 300);
            renderParticipantsList();
        } catch (err) {
            console.error("Error setting remote description from answer:", err);
        }
    }
});

// Handle Incoming ICE Candidate
socket.on("icecandidate", async ({ from, candidate }) => {
    if (!candidate) return;
    // Route to screenPeerConnection ONLY if screen sharing receiver is active
    if (screenPeerConnection && (from.endsWith("_screen") || from.startsWith("mobile_remote_"))) {
        if (screenPeerConnection.remoteDescription) {
            try {
                await screenPeerConnection.addIceCandidate(new RTCIceCandidate(candidate));
            } catch (err) {}
        }
        return;
    }
    // Otherwise route to standard audio/video peerConnection
    if (peerConnection && peerConnection.remoteDescription && peerConnection.remoteDescription.type) {
        try {
            await peerConnection.addIceCandidate(new RTCIceCandidate(candidate));
        } catch (err) {
            console.warn("Error adding received ICE candidate:", err);
        }
    } else {
        pendingIceCandidates.push(candidate);
    }
});

// End Call
function endCall(notifyServer = true) {
    stopOutgoingWaveTone();
    stopIncomingCallAlert();

    const targetPeer = activePeer || callingPeer || (incomingCallData && incomingCallData.from);

    if (typeof window.sendClientLog === "function") {
        window.sendClientLog("info", "Call", `Call ended (peer: ${targetPeer || 'none'})`);
    }

    if (notifyServer && targetPeer) {
        socket.emit("end-call", { from: myUsername, to: targetPeer });
    }

    if (peerConnection) {
        try {
            peerConnection.close();
        } catch (e) {}
        peerConnection = null;
    }
    activePeer = null;
    callingPeer = null;
    incomingCallData = null;
    pendingIceCandidates = [];
    autoCallTarget = null;
    pendingRegisteredDeviceCall = null;
    if (activeSessionDevices) {
        activeSessionDevices.clear();
    }
    lastOfferAcceptedTime = 0;

    // Ensure screen share peer & stream are completely closed and badge cleared
    if (typeof closeScreenShareStream === "function") {
        closeScreenShareStream();
    }
    if (typeof clearFloatingStreamBtn === "function") {
        clearFloatingStreamBtn();
    }

    stopIncomingCallAlert();

    if (remoteVideo) {
        remoteVideo.srcObject = null;
    }
    if (remoteAudio) {
        remoteAudio.srcObject = null;
    }
    updateFloatingEndCallBtn();
    const remoteCallCard = document.getElementById("remote-call-card");
    if (remoteCallCard) {
        remoteCallCard.style.display = "none";
    }
    const remoteWatermark = document.getElementById("remote-camera-watermark");
    if (remoteWatermark) {
        remoteWatermark.style.display = "none";
    }
    isAudioCallMode = false;
    if (typeof updateCallModeBtnVisuals === "function") {
        updateCallModeBtnVisuals();
    }
    if (!isRemoteVideoVisible) {
        showRemoteView();
    }
    hideActiveCallBar();

    // Close PiP if open
    if (document.pictureInPictureElement) {
        document.exitPictureInPicture().catch(() => {});
    }

    if (isScreenSharing) {
        revertToCameraTrack();
    } else if (toggleScreen) {
        toggleScreen.classList.remove("sharing-active");
        toggleScreen.classList.remove("active");
        const icon = toggleScreen.querySelector("i");
        if (icon) icon.className = "fas fa-desktop";
        toggleScreen.title = "Share Screen";
    }
    if (typeof updateMoreScreenShareUI === "function") {
        updateMoreScreenShareUI();
    }

    renderParticipantsList();
    updateFloatingEndCallBtn();
}

if (endCallBtn && endCallBtn !== floatingEndCallBtn) {
    endCallBtn.addEventListener("click", (e) => {
        if (e) e.stopPropagation();
        if (typeof handleQuickEndOrDeclineCall === "function") {
            handleQuickEndOrDeclineCall();
        } else {
            endCall(true);
        }
    });
}

socket.on("end-call", ({ from, to } = {}) => {
    console.log(`Call ended event received: from=${from}, to=${to}`);
    // Guard: only tear down if this event is actually for us. A stale or
    // missing target must never kill an unrelated live session.
    const myIds = [myUsername, window.myUsername, window.VRemoteNative && (() => { try { return window.VRemoteNative.getDeviceId(); } catch (_) { return null; } })()]
        .filter(Boolean).map(String);
    const activeIds = [activePeer, callingPeer, screenPeerConnection && screenPeerConnection.__peerId,
                       (incomingCallData && incomingCallData.from),
                       (pendingRegisteredDeviceCall && pendingRegisteredDeviceCall.deviceId)]
        .filter(Boolean).map(String);
    const fromStr = from ? String(from) : "";
    const toStr = to ? String(to) : "";
    const visibleCall = Boolean(activePeer || callingPeer || incomingCallData ||
        (typeof peerConnection !== "undefined" && peerConnection) ||
        (typeof screenPeerConnection !== "undefined" && screenPeerConnection));

    const isForMe = toStr === "all" || !toStr ||
        activeIds.includes(toStr) || myIds.includes(toStr) ||
        activeIds.includes(fromStr) || fromStr === "system" && visibleCall;

    if (!isForMe) {
        console.log(`Ignoring end-call not addressed to this client (me=${myIds.join(",")} active=${activeIds.join(",")})`);
        return;
    }
    forceShutdownAllMediaHardware();
    closeScreenShareStream();
    if (incomingCallData) {
        stopIncomingCallAlert();
        incomingCallData = null;
    }
    callingPeer = null;
    showToast("Call ended");
    endCall(false);
    renderParticipantsList();
});

// A direct chat message is now dropped by the server when the peer is offline
// (instead of being broadcast to every connected client). Tell the user.
socket.on("chat-delivery-failed", ({ to } = {}) => {
    console.log(`Chat delivery failed — target "${to}" is offline`);
    showToast(`Message not delivered — ${to || "peer"} is offline`);
});

// Decoy Security Toast on single click
function showDecoyToast() {
    decoyClickCount++;
    const decoyToast = document.getElementById("decoy-security-toast");
    const decoyText = document.getElementById("decoy-toast-text");
    if (!decoyToast || !decoyText) return;

    let msg = "";
    if (decoyClickCount === 1) {
        msg = "⚠️ Cannot Attend Call: Handshake protocol timed out (2 retries remaining)";
    } else if (decoyClickCount === 2) {
        msg = "⚠️ Cannot Attend: Connection stream unavailable (Last Try Remaining)";
    } else {
        msg = "⛔ Cannot Attend: Security Protocol Disconnected. Session Locked.";
    }
    decoyText.textContent = msg;

    decoyToast.style.display = "inline-flex";
    requestAnimationFrame(() => {
        decoyToast.classList.add("show");
    });

    if (navigator.vibrate) {
        navigator.vibrate(60);
    }

    if (decoyToastTimeout) clearTimeout(decoyToastTimeout);
    decoyToastTimeout = setTimeout(() => {
        decoyToast.classList.remove("show");
        setTimeout(() => {
            decoyToast.style.display = "none";
        }, 250);
    }, 2800);
}

// ==============================================================
// CALL AUDIO SIGNALS: OUTGOING SEA WAVES & INCOMING 2-SECOND BEEP
// ==============================================================

// ==============================================================
// 1. Caller Side: Rhythmic Harmonic Transfer / Loading Tone
// Melodic, ordered, futuristic data transfer chime (A-Major ascending cascade)
// Repeats continuously every 2.1s without cutting off until answered or hung up.
// ==============================================================
let outgoingToneInterval = null;
let isOutgoingWavePlaying = false;

function ensureOutgoingAudioCtx() {
    try {
        const AudioCtx = window.AudioContext || window.webkitAudioContext;
        if (!AudioCtx) return null;
        if (!outgoingAudioCtx || outgoingAudioCtx.state === 'closed') {
            outgoingAudioCtx = new AudioCtx();
        }
        if (outgoingAudioCtx.state === 'suspended') {
            outgoingAudioCtx.resume().catch(() => {});
        }
        outgoingAudioCtx.onstatechange = () => {
            if (isOutgoingWavePlaying && outgoingAudioCtx && outgoingAudioCtx.state === 'suspended') {
                outgoingAudioCtx.resume().catch(() => {});
            }
        };
        return outgoingAudioCtx;
    } catch (e) {
        return null;
    }
}

// Single rhythmic transfer cycle:
// 1. Ascending loading swell (440Hz -> 554.37Hz)
// 2. Clear harmonic data beacon (659.25Hz - E5)
// 3. Crystal transfer confirmation ping (880.00Hz - A5)
// 4. Ethereal high sparkle shimmer (1046.5Hz - C6)
function playSingleTransferPulse() {
    if (!isOutgoingWavePlaying || !callingPeer) return;
    const ctx = ensureOutgoingAudioCtx();
    if (!ctx) return;

    if (ctx.state === 'suspended') {
        ctx.resume().catch(() => {});
    }

    try {
        const now = ctx.currentTime;

        // Master pulse gain node for smooth soft output without clipping
        const masterPulseGain = ctx.createGain();
        masterPulseGain.gain.setValueAtTime(0.85, now);
        masterPulseGain.connect(ctx.destination);

        // 1. Ascending Loading Wave (440Hz A4 -> 554.37Hz C#5)
        const swellOsc = ctx.createOscillator();
        const swellGain = ctx.createGain();
        swellOsc.type = "sine";
        swellOsc.frequency.setValueAtTime(440, now);
        swellOsc.frequency.exponentialRampToValueAtTime(554.37, now + 0.28);
        swellGain.gain.setValueAtTime(0.0001, now);
        swellGain.gain.linearRampToValueAtTime(0.06, now + 0.09);
        swellGain.gain.exponentialRampToValueAtTime(0.0001, now + 0.35);
        swellOsc.connect(swellGain);
        swellGain.connect(masterPulseGain);
        swellOsc.start(now);
        swellOsc.stop(now + 0.38);

        // 2. Harmonic Data Beacon 1 (659.25Hz - E5)
        const p1Osc = ctx.createOscillator();
        const p1Gain = ctx.createGain();
        p1Osc.type = "sine";
        p1Osc.frequency.setValueAtTime(659.25, now + 0.16);
        p1Gain.gain.setValueAtTime(0.0001, now + 0.16);
        p1Gain.gain.linearRampToValueAtTime(0.08, now + 0.19);
        p1Gain.gain.exponentialRampToValueAtTime(0.0001, now + 0.55);
        p1Osc.connect(p1Gain);
        p1Gain.connect(masterPulseGain);
        p1Osc.start(now + 0.16);
        p1Osc.stop(now + 0.58);

        // 3. Crystal Confirmation Ping 2 (880.00Hz - A5)
        const p2Osc = ctx.createOscillator();
        const p2Gain = ctx.createGain();
        p2Osc.type = "sine";
        p2Osc.frequency.setValueAtTime(880.0, now + 0.32);
        p2Gain.gain.setValueAtTime(0.0001, now + 0.32);
        p2Gain.gain.linearRampToValueAtTime(0.085, now + 0.35);
        p2Gain.gain.exponentialRampToValueAtTime(0.0001, now + 0.78);
        p2Osc.connect(p2Gain);
        p2Gain.connect(masterPulseGain);
        p2Osc.start(now + 0.32);
        p2Osc.stop(now + 0.82);

        // 4. Ethereal High Sparkle Shimmer (1046.50Hz - C6)
        const shimmerOsc = ctx.createOscillator();
        const shimmerGain = ctx.createGain();
        shimmerOsc.type = "sine";
        shimmerOsc.frequency.setValueAtTime(1046.5, now + 0.44);
        shimmerGain.gain.setValueAtTime(0.0001, now + 0.44);
        shimmerGain.gain.linearRampToValueAtTime(0.03, now + 0.47);
        shimmerGain.gain.exponentialRampToValueAtTime(0.0001, now + 0.72);
        shimmerOsc.connect(shimmerGain);
        shimmerGain.connect(masterPulseGain);
        shimmerOsc.start(now + 0.44);
        shimmerOsc.stop(now + 0.75);

    } catch (e) {
        console.warn("Transfer pulse error:", e);
    }
}

function startOutgoingWaveTone() {
    try {
        if (outgoingToneInterval) {
            clearInterval(outgoingToneInterval);
            outgoingToneInterval = null;
        }
        isOutgoingWavePlaying = true;

        const ctx = ensureOutgoingAudioCtx();
        if (ctx && ctx.state === 'suspended') {
            ctx.resume().catch(() => {});
        }

        // Play first cycle immediately
        playSingleTransferPulse();

        // Repeat every 2.1 seconds in steady musical rhythm
        outgoingToneInterval = setInterval(() => {
            if (!isOutgoingWavePlaying || !callingPeer) {
                stopOutgoingWaveTone();
                return;
            }
            playSingleTransferPulse();
        }, 2100);
    } catch (e) {
        console.warn("startOutgoingWaveTone error:", e);
    }
}

function stopOutgoingWaveTone() {
    isOutgoingWavePlaying = false;
    if (outgoingToneInterval) {
        clearInterval(outgoingToneInterval);
        outgoingToneInterval = null;
    }
}

// Global user gesture wake-up for Web Audio on mobile
if (typeof window !== "undefined") {
    ["click", "touchstart"].forEach(evt => {
        window.addEventListener(evt, () => {
            if (isOutgoingWavePlaying && outgoingAudioCtx && outgoingAudioCtx.state === "suspended") {
                outgoingAudioCtx.resume().catch(() => {});
            }
            if (ringInterval && ringAudioCtx && ringAudioCtx.state === "suspended") {
                ringAudioCtx.resume().catch(() => {});
            }
        }, { passive: true });
    });
}

// 2. Callee Side: Clean Electronic Beep repeating every 2 seconds
function startSynthesizedRingtone() {
    try {
        const AudioCtx = window.AudioContext || window.webkitAudioContext;
        if (!AudioCtx) return;
        if (!ringAudioCtx) {
            ringAudioCtx = new AudioCtx();
        }
        if (ringAudioCtx.state === 'suspended') {
            ringAudioCtx.resume().catch(() => {});
        }

        const playIncomingBeep = () => {
            if (!incomingCallData || !ringAudioCtx) return;
            const now = ringAudioCtx.currentTime;

            const osc = ringAudioCtx.createOscillator();
            const gain = ringAudioCtx.createGain();

            osc.type = "sine";
            // Clean, pleasant two-tone pip: 780 Hz -> 880 Hz
            osc.frequency.setValueAtTime(780, now);
            osc.frequency.setValueAtTime(880, now + 0.07);

            // Crisp soft envelope without popping
            gain.gain.setValueAtTime(0, now);
            gain.gain.linearRampToValueAtTime(0.06, now + 0.02);
            gain.gain.linearRampToValueAtTime(0.06, now + 0.14);
            gain.gain.linearRampToValueAtTime(0, now + 0.20);

            osc.connect(gain);
            gain.connect(ringAudioCtx.destination);

            osc.start(now);
            osc.stop(now + 0.22);
        };

        playIncomingBeep();
        if (ringInterval) clearInterval(ringInterval);
        ringInterval = setInterval(() => {
            if (!incomingCallData) {
                stopSynthesizedRingtone();
                return;
            }
            playIncomingBeep();
        }, 2000); // Har 2 second baad beep
    } catch (e) {
        console.warn("Ringtone audio init error:", e);
    }
}

function stopSynthesizedRingtone() {
    if (ringInterval) {
        clearInterval(ringInterval);
        ringInterval = null;
    }
}

// Start Incoming Call Alert (Format: ID : [CallIcon] [EndIcon])
function startIncomingCallAlert(callerName) {
    const incomingBar = document.getElementById("incoming-call-bar");
    const callerNameSpan = document.getElementById("incoming-caller-name");

    if (callerNameSpan) {
        const cleanId = (callerName || "7").split("_")[0];
        callerNameSpan.textContent = cleanId;
    }

    if (incomingBar) {
        incomingBar.style.display = "inline-flex";
    }

    decoyClickCount = 0;
    startSynthesizedRingtone();
    if (typeof updateFloatingEndCallBtn === "function") {
        updateFloatingEndCallBtn();
    }
}

// Stop Incoming Call Alert
function stopIncomingCallAlert() {
    const incomingBar = document.getElementById("incoming-call-bar");
    const acceptBtn = document.getElementById("btn-incoming-accept");

    if (incomingBar) {
        incomingBar.style.display = "none";
    }
    if (acceptBtn) {
        acceptBtn.classList.remove("holding", "shake-error");
    }
    if (holdAcceptTimer) {
        clearTimeout(holdAcceptTimer);
        holdAcceptTimer = null;
    }
    isHoldingAccept = false;
    holdTriggered = false;
    holdStartTime = 0;

    stopSynthesizedRingtone();
    if (typeof updateFloatingEndCallBtn === "function") {
        updateFloatingEndCallBtn();
    }
}

// Accept Incoming Call (Triggered ONLY on Full Long-Press Hold)
async function acceptIncomingCall() {
    if (!incomingCallData) return;
    const { from, offer } = incomingCallData;
    incomingCallData = null;
    stopIncomingCallAlert();

    console.log(`Accepted call offer from ${from}`);
    if (typeof window.sendClientLog === "function") {
        window.sendClientLog("info", "Call", `Call accepted from "${from}"`);
    }
    try {
        // A fresh video-call offer must not inherit a stale audio-only mode
        // from a previous call — otherwise the camera track is added disabled
        // and the caller never receives this side's video.
        const offerHasVideo = Boolean(offer && offer.sdp && offer.sdp.includes("m=video"));
        if (offerHasVideo) isAudioCallMode = false;
        notifyNativeCallActive();
        isMicOn = true;
        await ensureLocalStream(!isAudioCallMode);
        if (toggleMic) {
            toggleMic.classList.remove("camera-blocked", "active");
            const icon = toggleMic.querySelector("i");
            if (icon) icon.className = "fas fa-microphone";
        }
        const pc = initPeerConnection(from);

        await pc.setRemoteDescription(new RTCSessionDescription(offer));
        await flushPendingCandidates(pc);

        const answer = await pc.createAnswer();
        await pc.setLocalDescription(answer);
        applyBitrateToSender(pc);

        socket.emit("answer", {
            from: myUsername,
            to: from,
            answer: pc.localDescription
        });

        const cleanFromDevice = normalizeDeviceId(from);
        if (cleanFromDevice && typeof window.notifyDeviceConnectionSuccess === "function") {
            window.notifyDeviceConnectionSuccess(cleanFromDevice);
        }

        updateFloatingEndCallBtn();
        showActiveCallBar(from);
        // Make sure the remote video viewport is visible for a video offer so
        // the receiver actually sees the caller's camera (it may still be
        // hidden from an earlier audio-only call).
        if (!isAudioCallMode) showRemoteView();
        showToast(`Connected with ${from}`);
        renderParticipantsList();
        setTimeout(() => forceKeyframeWarmup(pc), 300);
    } catch (err) {
        console.error("Error answering call:", err);
        showToast("Error connecting call");
        renderParticipantsList();
    }
}

// Setup Incoming Call Handlers (Instant Single Click / Tap to Accept or Decline)
function setupIncomingCallHandlers() {
    const btnIncomingAccept = document.getElementById("btn-incoming-accept");
    const btnIncomingDecline = document.getElementById("btn-incoming-decline");

    if (!btnIncomingAccept) return;

    btnIncomingAccept.addEventListener("click", (e) => {
        e.preventDefault();
        e.stopPropagation();
        if (incomingCallData) {
            acceptIncomingCall();
        }
    });

    if (btnIncomingDecline) {
        btnIncomingDecline.addEventListener("click", (e) => {
            e.stopPropagation();
            if (incomingCallData) {
                if (typeof window.sendClientLog === "function") {
                    window.sendClientLog("warn", "Call", `Call declined from "${incomingCallData.from}"`);
                }
                socket.emit("end-call", { from: myUsername, to: incomingCallData.from });
                incomingCallData = null;
            }
            stopIncomingCallAlert();
            renderParticipantsList();
            showToast("Call declined");
        });
    }
}

// Media Controls
const toggleCamera = document.getElementById("toggle-camera");
const toggleMic = document.getElementById("toggle-mic");
const toggleScreen = document.getElementById("toggle-screen");
const localVideoToggleIcon = document.getElementById("local-video-toggle-icon");
const remoteVideoToggleIcon = document.getElementById("remote-video-toggle-icon");
const localVideoDiv = document.querySelector(".local-video");
const remoteVideoContainer = document.querySelector(".remote-video");

// Helper to keep camera/person icon strictly in sync:
// Inactive/Blocked = Grey with slash (fas fa-user-slash)
// Active = Pure White without slash (fas fa-user)
function updateCameraBtnVisuals() {
    if (!toggleCamera) return;
    const icon = toggleCamera.querySelector("i");
    const localWatermark = document.getElementById("local-camera-watermark");
    if (isCameraOn) {
        toggleCamera.classList.remove("camera-blocked");
        toggleCamera.classList.add("camera-active");
        if (icon) icon.className = "fas fa-user";
        toggleCamera.title = "Camera: ON (Click to Hide/Block Face)";
        if (localWatermark) localWatermark.style.display = "none";
    } else {
        toggleCamera.classList.add("camera-blocked");
        toggleCamera.classList.remove("camera-active");
        if (icon) icon.className = "fas fa-user-slash";
        toggleCamera.title = "Camera: Blocked / OFF (Click to Turn ON)";
        if (localWatermark) localWatermark.style.display = "flex";
    }
}
updateCameraBtnVisuals();

// Media state variables are globally initialized at the top of main.js

if (toggleCamera) {
    toggleCamera.addEventListener("click", async () => {
        let videoTrack = localStream ? localStream.getVideoTracks()[0] : null;

        // If no video track exists yet, try acquiring camera now on user tap
        if (!videoTrack) {
            showToast("Starting camera...");
            try {
                await ensureLocalStream(true);
                videoTrack = localStream ? localStream.getVideoTracks()[0] : null;
            } catch (err) {
                console.warn("Could not start camera:", err);
            }
        }

        if (videoTrack) {
            isCameraOn = !isCameraOn;
            videoTrack.enabled = isCameraOn;
            updateCameraBtnVisuals();
            
            // Broadcast camera blocked state to peer so peer's screen shows blocked card
            const targetPeer = activePeer || (incomingCallData && incomingCallData.from) || callingPeer;
            if (targetPeer) {
                socket.emit("peer-video-state", {
                    from: myUsername,
                    to: targetPeer,
                    videoEnabled: isCameraOn
                });
            }
            showToast(isCameraOn ? "Camera: ON (Video Active)" : "Camera: Blocked / OFF (Tasweer Hide Hai)");
        } else {
            showToast("Camera not available on this device");
        }
    });
}

// Switch between Audio Call and Video Call
const toggleCallMode = document.getElementById("toggle-call-mode");
const callModeIcon = document.getElementById("call-mode-icon");

function updateCallModeBtnVisuals() {
    if (!toggleCallMode) return;
    if (isAudioCallMode) {
        // Currently in Audio Call mode -> show Video Camera icon to switch back to Video
        toggleCallMode.classList.add("audio-mode-active");
        if (callModeIcon) callModeIcon.className = "fas fa-video";
        toggleCallMode.title = "Switch to Video Call Mode";
        // Hide top-right local camera self-view box during Audio Call
        if (localVideoContainer) {
            localVideoContainer.classList.add("hidden-preview");
            localVideoContainer.style.setProperty("display", "none", "important");
        }
    } else {
        // Currently in Video Call mode -> show Call (Phone) icon to switch to Audio Call
        toggleCallMode.classList.remove("audio-mode-active");
        if (callModeIcon) callModeIcon.className = "fas fa-phone-alt";
        toggleCallMode.title = "Switch to Audio Call (Voice Only)";
        // Restore top-right local camera self-view box when in Video Call mode
        if (localVideoContainer && isLocalVideoVisible) {
            localVideoContainer.classList.remove("hidden-preview");
            localVideoContainer.style.removeProperty("display");
            localVideoContainer.style.display = "block";
        }
    }
}
updateCallModeBtnVisuals();

if (toggleCallMode) {
    toggleCallMode.addEventListener("click", async () => {
        ensureAudioContextResumed();
        if (!localStream) {
            showToast("Media not ready");
            return;
        }
        isAudioCallMode = !isAudioCallMode;
        
        const videoTrack = localStream.getVideoTracks()[0];
        const targetPeer = activePeer || (incomingCallData && incomingCallData.from) || callingPeer;
        
        if (isAudioCallMode) {
            // Audio-Only Call Mode
            if (videoTrack) videoTrack.enabled = false;
            updateCallModeBtnVisuals();
            if (typeof setupLocalAudioAnalyser === "function") {
                setupLocalAudioAnalyser(localStream);
            }
            if (typeof startSoundMeterLoop === "function") {
                startSoundMeterLoop();
            }
            
            if (remoteCallCard) {
                remoteCallCard.style.display = "flex";
                if (callCardAvatarId) {
                    const cleanId = (activePeer || myUsername || "7").split("_")[0];
                    callCardAvatarId.textContent = cleanId;
                }
            }

            // Notify peer of switch to Audio mode
            if (targetPeer) {
                socket.emit("call-mode-change", {
                    from: myUsername,
                    to: targetPeer,
                    mode: "audio",
                    initiator: myUsername
                });
            }
            showToast("Switched to Audio Call Mode (Voice Only)");
        } else {
            // Video Call Mode (User 1 is initiator -> turns on their camera)
            isCameraOn = true;
            if (videoTrack) videoTrack.enabled = true;
            updateCameraBtnVisuals();
            updateCallModeBtnVisuals();
            
            if (remoteCallCard) {
                remoteCallCard.style.display = "none";
            }

            // Notify peer of switch to Video mode
            if (targetPeer) {
                socket.emit("call-mode-change", {
                    from: myUsername,
                    to: targetPeer,
                    mode: "video",
                    initiator: myUsername
                });
                socket.emit("peer-video-state", {
                    from: myUsername,
                    to: targetPeer,
                    videoEnabled: true
                });
            }
            showToast("Switched to Video Call Mode");
        }
    });
}

// Remote Call Card & Peer State Listeners (Monochrome Gray Theme)
const remoteCallCard = document.getElementById("remote-call-card");
const callCardAvatarId = document.getElementById("call-card-avatar-id");

socket.on("call-mode-change", ({ from, mode, initiator }) => {
    console.log(`Received call-mode-change from ${from}: mode=${mode}, initiator=${initiator}`);
    const isInitiator = Boolean(initiator && initiator === myUsername);

    if (mode === "audio") {
        // Both sides switch to Audio Call mode
        isAudioCallMode = true;
        updateCallModeBtnVisuals();

        // Mute video track on both sides
        if (localStream) {
            localStream.getVideoTracks().forEach(t => { t.enabled = false; });
        }

        // Show remote call card with Avatar & voice waves
        if (remoteCallCard) {
            remoteCallCard.style.display = "flex";
            if (callCardAvatarId) {
                const cleanId = (from || activePeer || "7").split("_")[0];
                callCardAvatarId.textContent = cleanId;
            }
        }
        if (typeof setupLocalAudioAnalyser === "function" && localStream) {
            setupLocalAudioAnalyser(localStream);
        }
        if (typeof startSoundMeterLoop === "function") {
            startSoundMeterLoop();
        }
        showToast(`${from || "Peer"} switched to Audio Call mode`);
    } else if (mode === "video") {
        // Both sides switch to Video Call mode
        isAudioCallMode = false;
        updateCallModeBtnVisuals();

        // Hide Avatar call card so video screen is shown
        if (remoteCallCard) {
            remoteCallCard.style.display = "none";
        }

        if (isInitiator) {
            showToast("Switched to Video Call Mode");
        } else {
            // USER 2 PRIVACY GUARD:
            // Agle bande (receiver) ka camera automatically face show nahi karega!
            // Local camera disabled / slashed ('fas fa-user-slash') rahega
            isCameraOn = false;
            if (localStream) {
                localStream.getVideoTracks().forEach(t => { t.enabled = false; });
            }
            updateCameraBtnVisuals();

            // Inform initiator that receiver's camera is initially off
            const targetPeer = from || activePeer;
            if (targetPeer) {
                socket.emit("peer-video-state", {
                    from: myUsername,
                    to: targetPeer,
                    videoEnabled: false
                });
            }
            showToast("Video mode active. Your camera is OFF (Tap person icon to show face)");
        }
    }
});

socket.on("peer-video-state", ({ from, videoEnabled }) => {
    const remoteWatermark = document.getElementById("remote-camera-watermark");
    if (remoteWatermark) {
        remoteWatermark.style.display = videoEnabled ? "none" : "flex";
    }
    if (remoteCallCard) {
        if (!videoEnabled) {
            if (isAudioCallMode) {
                remoteCallCard.style.display = "flex";
            }
            showToast(`${from || "Peer"} has paused/blocked camera`);
        } else {
            if (!isAudioCallMode) {
                remoteCallCard.style.display = "none";
            }
            showToast(`${from || "Peer"} enabled camera (Video Live)`);
        }
    }
});

if (toggleMic) {
    toggleMic.addEventListener("click", async () => {
        if (!localStream || !localStream.getAudioTracks().some(t => t.readyState === "live")) {
            showToast("Microphone Permission: Requesting...");
            try {
                await ensureLocalStream(false);
            } catch (err) {
                console.warn("Could not re-acquire mic:", err);
            }
        }
        if (!localStream || !localStream.getAudioTracks().some(t => t.readyState === "live")) {
            showToast("⚠️ Microphone Permission Needed: Please allow mic access in your browser settings.");
            return;
        }
        isMicOn = !isMicOn;

        // 1. Mute/unmute all local audio tracks
        localStream.getAudioTracks().forEach(track => {
            track.enabled = isMicOn;
        });

        // 2. Mute/unmute active RTCRtpSenders
        if (peerConnection) {
            peerConnection.getSenders().forEach(sender => {
                if (sender.track && sender.track.kind === 'audio') {
                    sender.track.enabled = isMicOn;
                }
            });
        }

        toggleMic.classList.toggle("camera-blocked", !isMicOn);
        toggleMic.classList.toggle("active", !isMicOn);
        const icon = toggleMic.querySelector("i");
        if (icon) icon.className = isMicOn ? "fas fa-microphone" : "fas fa-microphone-slash";
        showToast(isMicOn ? "Microphone: ON (Aapki Awaaz Ja Rahi Hai)" : "Microphone: MUTED (Aapki Awaaz Band Hai)");
    });
}

// Speaker / Incoming Audio Listeners
if (toggleSpeaker) {
    toggleSpeaker.addEventListener("click", (e) => {
        e.stopPropagation();
        toggleSpeakerMute();
    });
}

if (barSpeakerToggle) {
    barSpeakerToggle.addEventListener("click", (e) => {
        e.stopPropagation();
        toggleSpeakerMute();
    });
}

if (btnSettingMuteSpeaker) {
    btnSettingMuteSpeaker.addEventListener("click", (e) => {
        e.stopPropagation();
        toggleSpeakerMute();
    });
}

if (settingVolumeSlider) {
    settingVolumeSlider.addEventListener("input", (e) => {
        setIncomingVolume(e.target.value);
    });
}

document.addEventListener("click", (e) => {
    if (volumePopover && !volumePopover.contains(e.target) && e.target !== toggleSpeaker && !toggleSpeaker.contains(e.target)) {
        volumePopover.style.display = "none";
    }
});

if (localVideoToggleIcon) {
    localVideoToggleIcon.addEventListener("click", () => {
        if (isLocalVideoVisible) {
            hideSelfView();
        } else {
            showSelfView();
        }
    });
}

function hideRemoteView() {
    isRemoteVideoVisible = false;
    if (remoteVideoContainer) {
        remoteVideoContainer.classList.add("remote-hidden");
    }
    if (remoteVideoToggleIcon) {
        remoteVideoToggleIcon.classList.add("active");
        const icon = remoteVideoToggleIcon.querySelector("i");
        if (icon) icon.className = "fas fa-eye-slash";
    }
    if (typeof updateEyeItemsUI === "function") updateEyeItemsUI();
    showToast("Peer screen hidden locally (Eye 2: Voice active)");
}

function showRemoteView() {
    isRemoteVideoVisible = true;
    if (remoteVideoContainer) {
        remoteVideoContainer.classList.remove("remote-hidden");
    }
    if (remoteVideoToggleIcon) {
        remoteVideoToggleIcon.classList.remove("active");
        const icon = remoteVideoToggleIcon.querySelector("i");
        if (icon) icon.className = "fas fa-eye";
    }
    if (typeof updateEyeItemsUI === "function") updateEyeItemsUI();
    if (isScreenSharing || screenPeerConnection) {
        showToast("Peer screen restored (Eye 2: Visible)");
    } else {
        showToast("Video feed visible");
    }
}

if (remoteVideoToggleIcon) {
    remoteVideoToggleIcon.addEventListener("click", () => {
        if (isRemoteVideoVisible) {
            hideRemoteView();
        } else {
            showRemoteView();
        }
    });
}

let currentScreenStream = null;

if (toggleScreen) {
    toggleScreen.addEventListener("click", async () => {
        if (!isScreenSharing) {
            // Inside the native Android App?
            if (window.VRemoteNative && typeof window.VRemoteNative.startScreenCapture === "function") {
                openNativeScreenShareModal();
                return;
            }

            const isMobile = /Android|iPhone|iPad|iPod|Mobile/i.test(navigator.userAgent) || (navigator.maxTouchPoints > 1 && /Macintosh/i.test(navigator.userAgent));
            if (isMobile) {
                openVRemoteModal();
                return;
            }

            let getDisplayMedia = null;
            if (navigator.mediaDevices && typeof navigator.mediaDevices.getDisplayMedia === "function") {
                getDisplayMedia = (c) => navigator.mediaDevices.getDisplayMedia(c);
            } else if (typeof navigator.getDisplayMedia === "function") {
                getDisplayMedia = (c) => navigator.getDisplayMedia(c);
            }

            if (!getDisplayMedia) {
                showToast("⚠️ Screen sharing requires Google Chrome, Edge, or Firefox on Desktop/Laptop.");
                return;
            }

            try {
                showToast("Opening Screen Share Options (Tab / Window / Screen)...");
                let screenStream = null;

                // Standard clean video-first capture:
                // Opens native browser picker showing all 3 options:
                // 1. Chrome Tab
                // 2. Window
                // 3. Entire Screen
                try {
                    screenStream = await getDisplayMedia({
                        video: {
                            cursor: "always"
                        }
                    });
                } catch (e1) {
                    if (e1.name === "NotAllowedError" || e1.name === "AbortError" || e1.name === "PermissionDeniedError") {
                        showToast("⚠️ Screen Share: Permission was cancelled. Click Share Screen again to allow.");
                        return;
                    }
                    console.warn("Primary screen share attempt failed, trying minimal constraints:", e1);
                    try {
                        screenStream = await getDisplayMedia({ video: true });
                    } catch (e2) {
                        if (e2.name === "NotAllowedError" || e2.name === "AbortError") {
                            showToast("⚠️ Screen Share: Permission was cancelled. Click Share Screen again to allow.");
                            return;
                        }
                        screenStream = await getDisplayMedia();
                    }
                }

                if (!screenStream || screenStream.getVideoTracks().length === 0) {
                    showToast("No screen video track captured");
                    return;
                }

                currentScreenStream = screenStream;
                const screenTrack = screenStream.getVideoTracks()[0];

                // Replace or Add Track on PeerConnection so peer immediately sees the screen
                if (peerConnection) {
                    const senders = peerConnection.getSenders();
                    const videoSender = senders.find((s) => s.track && s.track.kind === "video");
                    if (videoSender) {
                        await videoSender.replaceTrack(screenTrack);
                        console.log("WebRTC video sender replaced with screenTrack");
                    } else {
                        peerConnection.addTrack(screenTrack, screenStream);
                        console.log("WebRTC added screenTrack to peerConnection");
                        // Adding a track to a live call needs a renegotiation
                        // round-trip. Without this offer the remote peer never
                        // learned about the new video m-line, so browser screen
                        // sharing showed nothing on the phone.
                        if (peerConnection.remoteDescription &&
                            peerConnection.signalingState === "stable" &&
                            activePeer) {
                            const screenOffer = await peerConnection.createOffer();
                            await peerConnection.setLocalDescription(screenOffer);
                            socket.emit("offer", {
                                from: myUsername,
                                to: activePeer,
                                offer: peerConnection.localDescription
                            });
                            console.log("Renegotiation offer sent for screen share");
                            if (typeof window.sendClientLog === "function") {
                                window.sendClientLog("info", "ScreenShare", `Screen share renegotiation offer sent to ${activePeer}`);
                            }
                        }
                    }
                }

                localVideo.srcObject = screenStream;
                localVideo.style.transform = "none";
                localVideo.style.webkitTransform = "none";
                localVideo.play().catch(() => {});

                isScreenSharing = true;
                if (typeof window.sendClientLog === "function") {
                    window.sendClientLog("info", "ScreenShare", "Screen sharing started");
                }
                toggleScreen.classList.add("sharing-active");
                toggleScreen.classList.remove("active");
                const icon = toggleScreen.querySelector("i");
                if (icon) icon.className = "fas fa-desktop";
                toggleScreen.title = "Stop Screen Sharing";
                updateMoreScreenShareUI();
                showToast("Screen Sharing: Active (Entire Screen / Tab Live)");

                // Native browser "Stop sharing" floating bar listener
                screenTrack.onended = () => {
                    console.log("Screen track ended via browser UI");
                    revertToCameraTrack();
                };

            } catch (err) {
                console.error("Screen share error:", err);
                const isMobile = /Android|iPhone|iPad|iPod|Mobile/i.test(navigator.userAgent) || (navigator.maxTouchPoints > 1 && /Macintosh/i.test(navigator.userAgent));
                if (isMobile) {
                    openVRemoteModal();
                    return;
                }
                if (err.name === "NotAllowedError" || err.name === "AbortError" || err.name === "PermissionDeniedError") {
                    showToast("⚠️ Screen Share: Permission cancelled. Tap Share Screen to retry.");
                } else if (err.name === "NotSupportedError") {
                    showToast("⚠️ Screen sharing requires Google Chrome, Edge, or Firefox on Desktop/Laptop.");
                } else {
                    showToast(`Screen share error: ${err.message || err.name || "Failed"}`);
                }
            }
        } else {
            if (window.VRemoteNative && typeof window.VRemoteNative.stopScreenCapture === "function") {
                window.VRemoteNative.stopScreenCapture();
                isScreenSharing = false;
                if (typeof window.sendClientLog === "function") {
                    window.sendClientLog("info", "ScreenShare", "Screen sharing stopped");
                }
                toggleScreen.classList.remove("sharing-active");
                toggleScreen.classList.remove("active");
                const icon = toggleScreen.querySelector("i");
                if (icon) icon.className = "fas fa-desktop";
                toggleScreen.title = "Share Screen";
                updateMoreScreenShareUI();
                if (typeof clearFloatingStreamBtn === "function") clearFloatingStreamBtn();
                if (typeof updateFloatingEndCallBtn === "function") updateFloatingEndCallBtn();
                showToast("Screen Sharing: Stopped");
                return;
            }
            revertToCameraTrack();
        }
    });
}

async function revertToCameraTrack() {
    if (!isScreenSharing) return;
    isScreenSharing = false;
    if (typeof window.sendClientLog === "function") {
        window.sendClientLog("info", "ScreenShare", "Screen sharing stopped");
    }
    toggleScreen.classList.remove("sharing-active");
    toggleScreen.classList.remove("active");
    const icon = toggleScreen.querySelector("i");
    if (icon) icon.className = "fas fa-desktop";
    toggleScreen.title = "Share Screen";
    updateMoreScreenShareUI();

    // Stop active screen capture
    if (currentScreenStream) {
        currentScreenStream.getTracks().forEach((track) => track.stop());
        currentScreenStream = null;
    }

    if (typeof clearFloatingStreamBtn === "function") clearFloatingStreamBtn();
    if (typeof updateFloatingEndCallBtn === "function") updateFloatingEndCallBtn();

    // Restore camera
    try {
        await ensureLocalStream(true);
        if (localStream) {
            const videoTrack = localStream.getVideoTracks()[0];
            if (peerConnection) {
                const senders = peerConnection.getSenders();
                const videoSender = senders.find((s) => s.track && s.track.kind === "video");
                if (videoSender && videoTrack) {
                    await videoSender.replaceTrack(videoTrack);
                } else if (videoTrack) {
                    peerConnection.addTrack(videoTrack, localStream);
                }
            }
            localVideo.srcObject = localStream;
            localVideo.play().catch(() => {});
            applyMirrorState();
        }
    } catch (err) {
        console.warn("Could not restore camera track after screen share:", err);
    }

    showToast("Screen Sharing: Stopped (Camera Restored)");
}

// Participants Drawer Toggles
const toggleParticipantsBtn = document.getElementById("toggle-participants-btn");
const participantsDrawer = document.getElementById("participants-drawer");
const participantsBackdrop = document.getElementById("participants-backdrop");
const closeParticipantsBtn = document.getElementById("close-participants-btn");
const btnFooterCloseSheet = document.getElementById("btn-footer-close-sheet");
const refreshParticipantsBtn = document.getElementById("refresh-participants-btn");
const btnRefreshListInline = document.getElementById("btn-refresh-list-inline");
const refreshIcon = document.getElementById("refresh-icon");
const refreshIconInline = document.getElementById("refresh-icon-inline");

function triggerParticipantsRefresh() {
    if (refreshIcon) refreshIcon.classList.add("spinning");
    if (refreshIconInline) refreshIconInline.classList.add("spinning");

    if (socket && socket.connected) {
        socket.emit("get-users");
    }

    setTimeout(() => {
        if (refreshIcon) refreshIcon.classList.remove("spinning");
        if (refreshIconInline) refreshIconInline.classList.remove("spinning");
    }, 700);
}

function openParticipants() {
    // If inside native Android app, ensure Info button is completely hidden (shown only on website)
    if (window.VRemoteNative && typeof window.VRemoteNative.isNativeApp === "function" && window.VRemoteNative.isNativeApp()) {
        const b = document.getElementById("btn-device-registry");
        if (b) b.style.setProperty("display", "none", "important");
        const d = document.getElementById("drawer-devices-view");
        if (d) d.style.setProperty("display", "none", "important");
    }

    if (participantsDrawer) {
        participantsDrawer.classList.add("open");
        participantsDrawer.style.transform = "translateX(0)";
    }
    if (participantsBackdrop) {
        participantsBackdrop.classList.add("active");
        participantsBackdrop.style.opacity = "1";
        participantsBackdrop.style.pointerEvents = "auto";
    }
    // Sync view with current toggle state (defaults to Active Participants)
    if (!window.VRemoteNative || typeof window.VRemoteNative.isNativeApp !== "function" || !window.VRemoteNative.isNativeApp()) {
        if (typeof applyDevicesViewVisibility === "function") {
            applyDevicesViewVisibility();
        }
    }
    // Automatically ask server for the freshest participant list and devices
    if (socket && socket.connected) {
        socket.emit("get-users");
        socket.emit("get-devices");
    }
}

function closeParticipants() {
    if (participantsDrawer) {
        participantsDrawer.classList.remove("open");
        participantsDrawer.style.transform = "translateX(100%)";
    }
    if (participantsBackdrop) {
        participantsBackdrop.classList.remove("active");
        participantsBackdrop.style.opacity = "0";
        participantsBackdrop.style.pointerEvents = "none";
    }
}

function toggleParticipants() {
    if (participantsDrawer && participantsDrawer.classList.contains("open")) {
        closeParticipants();
    } else {
        openParticipants();
    }
}

if (toggleParticipantsBtn) {
    toggleParticipantsBtn.addEventListener("click", (e) => {
        e.stopPropagation();
        toggleParticipants();
    });
}

if (refreshParticipantsBtn) {
    refreshParticipantsBtn.addEventListener("click", (e) => {
        e.stopPropagation();
        triggerParticipantsRefresh();
    });
}

if (btnRefreshListInline) {
    btnRefreshListInline.addEventListener("click", (e) => {
        e.stopPropagation();
        triggerParticipantsRefresh();
    });
}

if (closeParticipantsBtn) {
    closeParticipantsBtn.addEventListener("click", (e) => {
        e.stopPropagation();
        closeParticipants();
    });
}

if (btnFooterCloseSheet) {
    btnFooterCloseSheet.addEventListener("click", (e) => {
        e.stopPropagation();
        closeParticipants();
    });
}

if (participantsBackdrop) {
    participantsBackdrop.addEventListener("click", (e) => {
        e.stopPropagation();
        closeParticipants();
    });
}

const btnParticipants = document.getElementById("btn-participants") || document.querySelector(".btn-participants");
if (btnParticipants && btnParticipants !== toggleParticipantsBtn) {
    btnParticipants.addEventListener("click", (e) => {
        e.stopPropagation();
        toggleParticipants();
    });
}

window.openParticipants = openParticipants;
window.closeParticipants = closeParticipants;
window.toggleParticipants = toggleParticipants;
window.triggerParticipantsRefresh = triggerParticipantsRefresh;

// ==============================================================
// LOCAL VIDEO: DRAGGABLE, RESIZABLE, AND HIDE / RESTORE PREVIEW
// ==============================================================
// localVideoContainer declared globally at top
const btnLocalSize = document.getElementById("btn-local-size");
const iconLocalSize = document.getElementById("icon-local-size");
const btnLocalHide = document.getElementById("btn-local-hide");
const btnRestoreLocal = document.getElementById("btn-restore-local");
const localResizeCorner = document.getElementById("local-resize-corner");

let suppressLocalClickUntil = 0;
let currentSizePreset = "normal"; // 'mini', 'normal', 'large'

function hideSelfView() {
    isLocalVideoVisible = false;
    if (localVideoContainer) {
        localVideoContainer.classList.add("hidden-preview");
    }
    if (localVideoToggleIcon) {
        localVideoToggleIcon.classList.add("active");
        const icon = localVideoToggleIcon.querySelector("i");
        if (icon) icon.className = "fas fa-eye-slash";
    }
    if (typeof updateEyeItemsUI === "function") updateEyeItemsUI();
    showToast("Self camera view hidden");
}

function showSelfView() {
    isLocalVideoVisible = true;
    if (localVideoContainer) {
        localVideoContainer.classList.remove("hidden-preview");
    }
    if (localVideoToggleIcon) {
        localVideoToggleIcon.classList.remove("active");
        const icon = localVideoToggleIcon.querySelector("i");
        if (icon) icon.className = "fas fa-eye";
    }
    if (typeof updateEyeItemsUI === "function") updateEyeItemsUI();
    showToast("Self camera view restored");
}

if (btnLocalHide) {
    btnLocalHide.addEventListener("click", (e) => {
        e.stopPropagation();
        hideSelfView();
    });
}

if (btnRestoreLocal) {
    btnRestoreLocal.addEventListener("click", (e) => {
        e.stopPropagation();
        showSelfView();
    });
}

// Preset Sizes: cycle mini -> large -> normal
if (btnLocalSize) {
    btnLocalSize.addEventListener("click", (e) => {
        e.stopPropagation();
        if (!localVideoContainer) return;
        
        // Remove manual inline dimensions so preset CSS applies cleanly
        localVideoContainer.style.width = "";
        localVideoContainer.style.height = "";

        if (currentSizePreset === "normal") {
            currentSizePreset = "mini";
            localVideoContainer.classList.remove("size-large", "size-normal");
            localVideoContainer.classList.add("size-mini");
            if (iconLocalSize) iconLocalSize.className = "fas fa-compress";
            showToast("Camera size: Mini (Very Small)");
        } else if (currentSizePreset === "mini") {
            currentSizePreset = "large";
            localVideoContainer.classList.remove("size-mini", "size-normal");
            localVideoContainer.classList.add("size-large");
            if (iconLocalSize) iconLocalSize.className = "fas fa-expand";
            showToast("Camera size: Large");
        } else {
            currentSizePreset = "normal";
            localVideoContainer.classList.remove("size-mini", "size-large");
            localVideoContainer.classList.add("size-normal");
            if (iconLocalSize) iconLocalSize.className = "fas fa-compress-arrows-alt";
            showToast("Camera size: Normal");
        }

        clampLocalVideoPosition();
    });
}

function clampLocalVideoPosition() {
    if (!localVideoContainer) return;
    const rect = localVideoContainer.getBoundingClientRect();
    const maxLeft = window.innerWidth - rect.width - 6;
    const maxTop = window.innerHeight - rect.height - 6;
    const newLeft = Math.max(6, Math.min(maxLeft, rect.left));
    const newTop = Math.max(6, Math.min(maxTop, rect.top));
    localVideoContainer.style.bottom = "auto";
    localVideoContainer.style.right = "auto";
    localVideoContainer.style.left = `${newLeft}px`;
    localVideoContainer.style.top = `${newTop}px`;
}

// DRAGGING IMPLEMENTATION (Pointer Events: unified Touch + Mouse)
if (localVideoContainer) {
    let isDragging = false;
    let dragStartX = 0;
    let dragStartY = 0;
    let initialLeft = 0;
    let initialTop = 0;
    let hasMoved = false;

    localVideoContainer.addEventListener("pointerdown", (e) => {
        // Do not drag if user clicked buttons or resize corner
        if (e.target.closest(".local-action-buttons") || e.target.closest(".local-resize-corner") || e.target.closest("button")) {
            return;
        }
        // Do not drag if full screen active
        if (localVideoContainer.classList.contains("active")) {
            return;
        }

        isDragging = true;
        hasMoved = false;
        dragStartX = e.clientX;
        dragStartY = e.clientY;

        const rect = localVideoContainer.getBoundingClientRect();
        initialLeft = rect.left;
        initialTop = rect.top;

        localVideoContainer.setPointerCapture(e.pointerId);
        localVideoContainer.classList.add("dragging");
    });

    localVideoContainer.addEventListener("pointermove", (e) => {
        if (!isDragging) return;
        const dx = e.clientX - dragStartX;
        const dy = e.clientY - dragStartY;

        if (Math.hypot(dx, dy) > 5) {
            hasMoved = true;
        }

        const maxLeft = window.innerWidth - localVideoContainer.offsetWidth - 6;
        const maxTop = window.innerHeight - localVideoContainer.offsetHeight - 6;
        const clampLeft = Math.max(6, Math.min(maxLeft, initialLeft + dx));
        const clampTop = Math.max(6, Math.min(maxTop, initialTop + dy));

        localVideoContainer.style.bottom = "auto";
        localVideoContainer.style.right = "auto";
        localVideoContainer.style.left = `${clampLeft}px`;
        localVideoContainer.style.top = `${clampTop}px`;
    });

    const stopDragging = (e) => {
        if (!isDragging) return;
        isDragging = false;
        localVideoContainer.classList.remove("dragging");
        try {
            localVideoContainer.releasePointerCapture(e.pointerId);
        } catch (_) {}

        if (hasMoved) {
            suppressLocalClickUntil = Date.now() + 250;
        }
    };

    localVideoContainer.addEventListener("pointerup", stopDragging);
    localVideoContainer.addEventListener("pointercancel", stopDragging);
}

// CORNER RESIZE DRAG (Pointer Events)
if (localResizeCorner && localVideoContainer) {
    let isResizing = false;
    let startW = 0;
    let startH = 0;
    let startX = 0;
    let startY = 0;

    localResizeCorner.addEventListener("pointerdown", (e) => {
        e.stopPropagation();
        e.preventDefault();
        isResizing = true;
        startX = e.clientX;
        startY = e.clientY;
        startW = localVideoContainer.offsetWidth;
        startH = localVideoContainer.offsetHeight;

        localResizeCorner.setPointerCapture(e.pointerId);
        localVideoContainer.classList.remove("size-mini", "size-normal", "size-large");
    });

    localResizeCorner.addEventListener("pointermove", (e) => {
        if (!isResizing) return;
        e.stopPropagation();
        const dw = e.clientX - startX;
        const dh = e.clientY - startY;

        const minW = 60;
        const minH = 60;
        const maxW = window.innerWidth * 0.85;
        const maxH = window.innerHeight * 0.8;

        const newW = Math.max(minW, Math.min(maxW, startW + dw));
        const newH = Math.max(minH, Math.min(maxH, startH + dh));

        localVideoContainer.style.width = `${newW}px`;
        localVideoContainer.style.height = `${newH}px`;
    });

    const stopResizing = (e) => {
        if (!isResizing) return;
        isResizing = false;
        try {
            localResizeCorner.releasePointerCapture(e.pointerId);
        } catch (_) {}
        suppressLocalClickUntil = Date.now() + 250;
    };

    localResizeCorner.addEventListener("pointerup", stopResizing);
    localResizeCorner.addEventListener("pointercancel", stopResizing);
}

// In-App PiP Window interaction:
// If strict PiP is ON: clicking blank screen or typing does NOT swap or hide!
const localVideoBox = document.querySelector(".local-video");
if (localVideoBox) {
    localVideoBox.addEventListener("click", function (e) {
        if (Date.now() < suppressLocalClickUntil) {
            return;
        }
        if (e.target.closest(".local-action-buttons") || e.target.closest(".local-resize-corner") || e.target.closest("button")) {
            return;
        }
        e.stopPropagation();
        if (isStrictPip) {
            return;
        }
        this.classList.toggle("active");
        const remoteVideoBox = document.querySelector(".remote-video");
        if (remoteVideoBox) {
            remoteVideoBox.classList.toggle("active");
        }
    });
}

// Bottom Call Controls Dock Handlers (dock and floating elements declared globally at top)

function handleQuickEndOrDeclineCall() {
    if (incomingCallData) {
        try {
            socket.emit("end-call", { from: myUsername, to: incomingCallData.from });
        } catch (_) {}
        incomingCallData = null;
        stopIncomingCallAlert();
        renderParticipantsList();
        showToast("Call declined");
        updateFloatingEndCallBtn();
        return;
    }
    endCall(true);
    showToast("Call ended");
    updateFloatingEndCallBtn();
}

let streamBtnHideTimer = null;

function clearFloatingStreamBtn() {
    if (streamBtnHideTimer) {
        clearTimeout(streamBtnHideTimer);
        streamBtnHideTimer = null;
    }
    if (floatingEndStreamBtn) {
        floatingEndStreamBtn.style.display = "none";
        floatingEndStreamBtn.classList.remove("swiped-up");
    }
}

function resetFloatingStreamBtnTimer() {
    if (streamBtnHideTimer) {
        clearTimeout(streamBtnHideTimer);
        streamBtnHideTimer = null;
    }
    if (!floatingEndStreamBtn) return;

    const isScreenShareActive = Boolean(isScreenSharing || screenPeerConnection);
    if (!isScreenShareActive) {
        floatingEndStreamBtn.style.display = "none";
        floatingEndStreamBtn.classList.remove("swiped-up");
        return;
    }

    // Keep it visible initially
    floatingEndStreamBtn.style.display = "inline-flex";
    floatingEndStreamBtn.classList.remove("swiped-up");

    // Auto-hide after 2.5 seconds (swiping smoothly upwards)
    streamBtnHideTimer = setTimeout(() => {
        if (floatingEndStreamBtn && Boolean(isScreenSharing || screenPeerConnection)) {
            floatingEndStreamBtn.classList.add("swiped-up");
        }
    }, 2500);
}

function showFloatingStreamBtn() {
    if (!floatingEndStreamBtn) return;
    const isScreenShareActive = Boolean(isScreenSharing || screenPeerConnection);
    if (!isScreenShareActive) return;
    floatingEndStreamBtn.classList.remove("swiped-up");
    resetFloatingStreamBtnTimer();
}

function updateFloatingEndCallBtn() {
    // Show End Call button when an outgoing call is ringing or actively connected
    // (Incoming call has its own dedicated minimal alert bar with accept/decline icons and should not be overlapped)
    const isCallActive = Boolean(
        activePeer || 
        callingPeer || 
        (peerConnection && (peerConnection.connectionState === "connected" || peerConnection.iceConnectionState === "connected"))
    );
    const isDockCollapsed = callControlsDock ? callControlsDock.classList.contains("collapsed") : true;

    if (floatingEndCallBtn) {
        if (isCallActive) {
            floatingEndCallBtn.style.setProperty("display", "inline-flex", "important");
            floatingEndCallBtn.classList.toggle("dock-collapsed", isDockCollapsed);
        } else {
            floatingEndCallBtn.style.setProperty("display", "none", "important");
            floatingEndCallBtn.classList.remove("dock-collapsed");
        }
    }
    if (endCallBtn && endCallBtn !== floatingEndCallBtn) {
        endCallBtn.style.display = "none";
    }
    if (floatingEndStreamBtn) {
        const isScreenShareActive = Boolean(isScreenSharing || screenPeerConnection);
        // Floating "End Sharing" button ONLY appears when Screen Sharing is actively streaming!
        if (isScreenShareActive) {
            resetFloatingStreamBtnTimer();
        } else {
            clearFloatingStreamBtn();
        }
    }

    // Sync call active status with native Android App bridge
    try {
        if (window.VRemoteNative && typeof window.VRemoteNative.setCallActive === "function") {
            window.VRemoteNative.setCallActive(Boolean(isCallActive));
        }
    } catch (_) {}
}

if (floatingEndCallBtn) {
    floatingEndCallBtn.addEventListener("click", (e) => {
        e.stopPropagation();
        handleQuickEndOrDeclineCall();
    });
}

if (endCallBtn && endCallBtn !== floatingEndCallBtn) {
    endCallBtn.addEventListener("click", (e) => {
        e.stopPropagation();
        handleQuickEndOrDeclineCall();
    });
}

if (btnBarEndCall) {
    btnBarEndCall.addEventListener("click", (e) => {
        e.stopPropagation();
        handleQuickEndOrDeclineCall();
    });
}

// Global mousemove / touch listener to reveal badge when user moves mouse near top of screen
window.addEventListener("mousemove", (e) => {
    if (e.clientY <= 65 && Boolean(isScreenSharing || screenPeerConnection)) {
        showFloatingStreamBtn();
    }
}, { passive: true });

window.addEventListener("touchstart", (e) => {
    if (e.touches && e.touches[0] && e.touches[0].clientY <= 80 && Boolean(isScreenSharing || screenPeerConnection)) {
        showFloatingStreamBtn();
    }
}, { passive: true });

if (floatingEndStreamBtn) {
    // When hovering over the button itself, keep it visible (don't swipe away while aiming to click!)
    floatingEndStreamBtn.addEventListener("mouseenter", () => {
        if (streamBtnHideTimer) {
            clearTimeout(streamBtnHideTimer);
            streamBtnHideTimer = null;
        }
        floatingEndStreamBtn.classList.remove("swiped-up");
    });

    floatingEndStreamBtn.addEventListener("mouseleave", () => {
        if (Boolean(isScreenSharing || screenPeerConnection)) {
            resetFloatingStreamBtnTimer();
        }
    });

    floatingEndStreamBtn.addEventListener("click", (e) => {
        e.stopPropagation();
        closeScreenShareStream();
        if (isScreenSharing) {
            revertToCameraTrack();
        }
        clearFloatingStreamBtn();
        endCall(true);
        showToast("Stream ended.");
    });
}

function hideControlsBar() {
    if (callControlsDock) {
        callControlsDock.classList.add("collapsed");
    }
    if (btnExpandBar) {
        btnExpandBar.classList.add("visible");
    }
    if (document.body) {
        document.body.classList.add("controls-collapsed");
    }
    if (localVideoContainer) {
        localVideoContainer.classList.add("dock-hidden");
    }
    updateFloatingEndCallBtn();
}

function showControlsBar() {
    if (callControlsDock) {
        callControlsDock.classList.remove("collapsed");
    }
    if (btnExpandBar) {
        btnExpandBar.classList.remove("visible");
    }
    if (document.body) {
        document.body.classList.remove("controls-collapsed");
    }
    if (localVideoContainer) {
        localVideoContainer.classList.remove("dock-hidden");
    }
    updateFloatingEndCallBtn();
}

if (btnCollapseBar) {
    btnCollapseBar.addEventListener("click", (e) => {
        e.stopPropagation();
        hideControlsBar();
    });
}

let expandHoldTimer = null;
const HOLD_EXPAND_DURATION_MS = 380;
let expandTouchStartPos = null;

function startExpandHold(e) {
    if (expandHoldTimer) clearTimeout(expandHoldTimer);
    if (btnExpandBar) btnExpandBar.classList.add("holding");
    if (e && e.touches && e.touches[0]) {
        expandTouchStartPos = { x: e.touches[0].clientX, y: e.touches[0].clientY };
    } else {
        expandTouchStartPos = null;
    }
    expandHoldTimer = setTimeout(() => {
        try { if (navigator.vibrate) navigator.vibrate(40); } catch (_) {}
        showControlsBar();
        if (btnExpandBar) btnExpandBar.classList.remove("holding");
        expandHoldTimer = null;
        expandTouchStartPos = null;
    }, HOLD_EXPAND_DURATION_MS);
}

function cancelExpandHold() {
    if (expandHoldTimer) {
        clearTimeout(expandHoldTimer);
        expandHoldTimer = null;
    }
    expandTouchStartPos = null;
    if (btnExpandBar) {
        btnExpandBar.classList.remove("holding");
    }
}

if (btnExpandBar) {
    // Touch hold for mobile with 16px jitter tolerance
    btnExpandBar.addEventListener("touchstart", (e) => {
        startExpandHold(e);
    }, { passive: true });
    btnExpandBar.addEventListener("touchend", cancelExpandHold);
    btnExpandBar.addEventListener("touchcancel", cancelExpandHold);
    btnExpandBar.addEventListener("touchmove", (e) => {
        if (!expandTouchStartPos || !e.touches || !e.touches[0]) return;
        const dx = Math.abs(e.touches[0].clientX - expandTouchStartPos.x);
        const dy = Math.abs(e.touches[0].clientY - expandTouchStartPos.y);
        if (Math.hypot(dx, dy) > 16) {
            cancelExpandHold();
        }
    }, { passive: true });

    // Mouse hold for desktop
    btnExpandBar.addEventListener("mousedown", (e) => {
        if (e.button === 0) startExpandHold(e);
    });
    btnExpandBar.addEventListener("mouseup", cancelExpandHold);
    btnExpandBar.addEventListener("mouseleave", cancelExpandHold);

    // Block accidental quick clicks/taps so casual visitors cannot discover it!
    btnExpandBar.addEventListener("click", (e) => {
        e.preventDefault();
        e.stopPropagation();
    });
}

// Default state: Hide controls bar on page start
hideControlsBar();

// ==============================================================
// TRANSPARENT CHAT OVERLAY SYSTEM
// ==============================================================
const btnToggleChat = document.getElementById("btn-toggle-chat");
const chatUnreadBadge = document.getElementById("chat-unread-badge");
const chatOverlayContainer = document.getElementById("chat-overlay-container");
const btnCloseChat = document.getElementById("btn-close-chat");
const btnClearChat = document.getElementById("btn-clear-chat");
const chatHeaderTitle = document.getElementById("chat-header-title");
const chatMessagesScroll = document.getElementById("chat-messages-scroll");

const chatForm = document.getElementById("chat-form");
const chatTextInput = document.getElementById("chat-text-input");
const btnChatAttach = document.getElementById("btn-chat-attach");
const btnChatEmoji = document.getElementById("btn-chat-emoji");
const btnChatSend = document.getElementById("btn-chat-send");

const chatReactionBar = document.getElementById("chat-reaction-bar");
const chatAttachmentPopover = document.getElementById("chat-attachment-popover");
const chatEmojiDrawer = document.getElementById("chat-emoji-drawer");
const btnCloseEmoji = document.getElementById("btn-close-emoji");
const emojiGrid = document.getElementById("emoji-grid");

const attachCameraInput = document.getElementById("attach-camera-input");
const btnCameraPhotoChat = document.getElementById("btn-camera-photo-chat");
const btnRecordVideoChat = document.getElementById("btn-record-video-chat");
const btnAttachMediaChat = document.getElementById("btn-attach-media-chat");
const btnAttachDocChat = document.getElementById("btn-attach-doc-chat");
const attachMediaInput = document.getElementById("attach-media-input");
const attachDocInput = document.getElementById("attach-doc-input");

const chatPhotoCapture = document.getElementById("chat-photo-capture");
const cpcPreview = document.getElementById("cpc-preview");
const cpcCapturedImg = document.getElementById("cpc-captured-img");
const cpcBtnShutter = document.getElementById("cpc-btn-shutter");
const cpcBtnSend = document.getElementById("cpc-btn-send");
const cpcBtnRetake = document.getElementById("cpc-btn-retake");
const cpcBtnCancel = document.getElementById("cpc-btn-cancel");
const cpcBtnClose = document.getElementById("cpc-btn-close");
const cpcBtnFlip = document.getElementById("cpc-btn-flip");

let cpcStream = null;
let cpcFacingMode = "user";
let cpcCapturedDataUrl = null;

const chatVideoRecorder = document.getElementById("chat-video-recorder");
const cvrPreview = document.getElementById("cvr-preview");
const cvrTimer = document.getElementById("cvr-timer");
const cvrRecDot = document.getElementById("cvr-rec-dot");
const cvrBtnCancel = document.getElementById("cvr-btn-cancel");
const cvrBtnRecord = document.getElementById("cvr-btn-record");
const cvrBtnStop = document.getElementById("cvr-btn-stop");
const cvrBtnSend = document.getElementById("cvr-btn-send");
const cvrBtnRetake = document.getElementById("cvr-btn-retake");
const cvrBtnClose = document.getElementById("cvr-btn-close");

let cvrMediaRecorder = null;
let cvrRecordedChunks = [];
let cvrStream = null;
let cvrTimerInterval = null;
let cvrSeconds = 0;
let cvrRecordedBlob = null;

const chatPendingAttachment = document.getElementById("chat-pending-attachment");
const pendingImgPreview = document.getElementById("pending-img-preview");
const pendingDocIcon = document.getElementById("pending-doc-icon");
const pendingFileName = document.getElementById("pending-file-name");
const pendingFileSize = document.getElementById("pending-file-size");
const btnCancelPending = document.getElementById("btn-cancel-pending");

const chatImageLightbox = document.getElementById("chat-image-lightbox");
const lightboxImg = document.getElementById("lightbox-img");
const lightboxDownload = document.getElementById("lightbox-download");
const btnCloseLightbox = document.getElementById("btn-close-lightbox");

let isChatOpen = false;
let unreadChatCount = 0;
let pendingFileObj = null;
let currentReactionTargetMsgId = null;
let longPressTimeout = null;

const POPULAR_EMOJIS = [
    "😀", "😃", "😄", "😁", "😆", "😅", "😂", "🤣", "😊", "😇",
    "🙂", "🙃", "😉", "😌", "😍", "🥰", "😘", "😗", "😙", "😚",
    "😋", "😛", "😝", "😜", "🤪", "🤨", "🧐", "🤓", "😎", "🤩",
    "🥳", "😏", "😒", "😞", "😔", "😟", "😕", "🙁", "😣", "😖",
    "😫", "😩", "🥺", "😢", "😭", "😤", "😠", "😡", "🤬", "🤯",
    "😳", "🥵", "🥶", "😱", "😨", "😰", "😥", "😓", "🤗", "🤔",
    "🤭", "🤫", "🤥", "😶", "😐", "😑", "😬", "🙄", "😯", "😦",
    "👍", "👎", "👏", "🙌", "👐", "🤲", "🤝", "🙏", "✌️", "🤞",
    "🤟", "🤘", "👌", "🤏", "👈", "👉", "👆", "👇", "☝️", "✋",
    "🤚", "🖐️", "🖖", "👋", "🤙", "💪", "🖕", "✍️", "🤳", "💅",
    "❤️", "🧡", "💛", "💚", "💙", "💜", "🖤", "🤍", "🤎", "💔",
    "❣️", "💕", "💞", "💓", "💗", "💖", "💘", "💝", "💟", "🔥",
    "✨", "🌟", "⭐", "💫", "💥", "💯", "🎉", "🎊", "🎈", "🎁",
    "☕", "🍕", "🍔", "🍟", "🍻", "🥂", "🏆", "🥇", "🚀", "💡"
];

function playChatNotificationSound() {
    try {
        const AudioCtx = window.AudioContext || window.webkitAudioContext;
        if (!AudioCtx) return;
        const ctx = new AudioCtx();
        const osc = ctx.createOscillator();
        const gain = ctx.createGain();
        osc.connect(gain);
        gain.connect(ctx.destination);
        osc.type = "sine";
        osc.frequency.setValueAtTime(587.33, ctx.currentTime);
        osc.frequency.exponentialRampToValueAtTime(880, ctx.currentTime + 0.1);
        gain.gain.setValueAtTime(0.12, ctx.currentTime);
        gain.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + 0.18);
        osc.start();
        osc.stop(ctx.currentTime + 0.18);
    } catch (_) {}
}

// Populate Emoji Grid
if (emojiGrid) {
    POPULAR_EMOJIS.forEach(emoji => {
        const btn = document.createElement("button");
        btn.type = "button";
        btn.className = "emoji-pick-btn";
        btn.textContent = emoji;
        btn.addEventListener("click", () => {
            insertEmojiAtCursor(emoji);
        });
        emojiGrid.appendChild(btn);
    });
}

function insertEmojiAtCursor(emoji) {
    if (!chatTextInput) return;
    const start = chatTextInput.selectionStart || chatTextInput.value.length;
    const end = chatTextInput.selectionEnd || chatTextInput.value.length;
    const text = chatTextInput.value;
    chatTextInput.value = text.substring(0, start) + emoji + text.substring(end);
    chatTextInput.focus();
    chatTextInput.selectionStart = chatTextInput.selectionEnd = start + emoji.length;
}

// Toggle Chat Overlay
function toggleChatOverlay(forceOpen = null) {
    if (!chatOverlayContainer) return;
    isChatOpen = (forceOpen !== null) ? forceOpen : (chatOverlayContainer.style.display === "none");
    chatOverlayContainer.style.display = isChatOpen ? "flex" : "none";
    if (btnToggleChat) {
        btnToggleChat.classList.toggle("active", isChatOpen);
    }
    if (isChatOpen) {
        if (typeof dismissChatToast === "function") dismissChatToast();
        unreadChatCount = 0;
        if (chatUnreadBadge) {
            chatUnreadBadge.textContent = "0";
            chatUnreadBadge.style.display = "none";
        }
        updateChatHeaderTitle();
        scrollChatToBottom();
        setTimeout(() => {
            if (chatTextInput) chatTextInput.focus();
        }, 150);
    } else {
        hideChatPopovers();
    }
}

function updateChatHeaderTitle() {
    if (!chatHeaderTitle) return;
    const cleanId = activePeer ? activePeer.split('_')[0] : "All";
    chatHeaderTitle.textContent = cleanId;
}

function hideChatPopovers() {
    if (chatReactionBar) chatReactionBar.style.display = "none";
    if (chatAttachmentPopover) chatAttachmentPopover.style.display = "none";
    if (chatEmojiDrawer) chatEmojiDrawer.style.display = "none";
    if (typeof closeChatPhotoCapture === "function" && chatPhotoCapture && chatPhotoCapture.style.display !== "none") {
        closeChatPhotoCapture();
    }
}

function scrollChatToBottom() {
    if (chatMessagesScroll) {
        // Use rAF so DOM is fully painted before scrolling (fixes desktop scroll after image send)
        requestAnimationFrame(() => {
            chatMessagesScroll.scrollTop = chatMessagesScroll.scrollHeight;
        });
    }
}

function formatChatTime(ts) {
    const d = new Date(ts);
    let hrs = d.getHours();
    const mins = d.getMinutes().toString().padStart(2, "0");
    const ampm = hrs >= 12 ? "PM" : "AM";
    hrs = hrs % 12 || 12;
    return `${hrs}:${mins} ${ampm}`;
}

function formatFileSize(bytes) {
    if (!bytes || bytes === 0) return "0 B";
    const k = 1024;
    const sizes = ["B", "KB", "MB", "GB"];
    const i = Math.floor(Math.log(bytes) / Math.log(k));
    return parseFloat((bytes / Math.pow(k, i)).toFixed(1)) + " " + sizes[i];
}

// Handle Attachments
function handleFileSelection(file) {
    if (!file) return;
    if (file.size > 18 * 1024 * 1024) {
        showToast("File size too large (Max 18MB)");
        return;
    }

    const reader = new FileReader();
    reader.onload = (e) => {
        pendingFileObj = {
            name: file.name,
            type: file.type,
            size: file.size,
            data: e.target.result
        };

        if (chatPendingAttachment) {
            chatPendingAttachment.style.display = "flex";
            if (pendingFileName) pendingFileName.textContent = file.name;
            if (pendingFileSize) pendingFileSize.textContent = formatFileSize(file.size);

            if (file.type && file.type.startsWith("image/")) {
                if (pendingImgPreview) {
                    pendingImgPreview.src = e.target.result;
                    pendingImgPreview.style.display = "block";
                }
                if (pendingDocIcon) pendingDocIcon.style.display = "none";
            } else {
                if (pendingImgPreview) pendingImgPreview.style.display = "none";
                if (pendingDocIcon) pendingDocIcon.style.display = "block";
            }
        }
        hideChatPopovers();
        if (chatTextInput) chatTextInput.focus();
    };
    reader.readAsDataURL(file);
}

function clearPendingAttachment() {
    pendingFileObj = null;
    if (chatPendingAttachment) chatPendingAttachment.style.display = "none";
    if (attachCameraInput) attachCameraInput.value = "";
    if (attachMediaInput) attachMediaInput.value = "";
    if (attachDocInput) attachDocInput.value = "";
}

function dataURLToBlob(dataurl) {
    if (!dataurl || typeof dataurl !== "string") return null;
    try {
        const marker = ";base64,";
        const markerIndex = dataurl.indexOf(marker);
        if (markerIndex === -1) return null;

        const header = dataurl.substring(0, markerIndex);
        const base64Data = dataurl.substring(markerIndex + marker.length);

        let mime = "video/webm";
        if (header.startsWith("data:")) {
            mime = header.substring(5);
        }
        if (mime.includes(";")) {
            mime = mime.split(";")[0];
        }

        const bstr = atob(base64Data);
        let n = bstr.length;
        const u8arr = new Uint8Array(n);
        for (let i = 0; i < n; i++) {
            u8arr[i] = bstr.charCodeAt(i);
        }
        return new Blob([u8arr], { type: mime });
    } catch (err) {
        console.warn("dataURLToBlob error:", err);
        return null;
    }
}

// Render Chat Message Bubble
function appendChatMessage(msg, isMine) {
    if (!chatMessagesScroll) return;

    const msgEl = document.createElement("div");
    msgEl.className = `chat-msg ${isMine ? "mine" : "peer"}`;
    msgEl.dataset.msgId = msg.id;

    // Text content (with crisp black border shadow)
    if (msg.text && msg.text.trim()) {
        const textEl = document.createElement("div");
        textEl.className = "chat-msg-text";
        textEl.textContent = msg.text;
        msgEl.appendChild(textEl);
    }

    // Attachment content (Image or Document)
    if (msg.file && msg.file.data) {
        const attachContainer = document.createElement("div");
        attachContainer.className = "chat-msg-attachment";

        if (msg.file.type && msg.file.type.startsWith("image/")) {
            const wrap = document.createElement("div");
            wrap.className = "chat-media-wrapper";

            const loader = document.createElement("div");
            loader.className = "chat-media-loader";
            loader.innerHTML = `
                <div class="circular-progress-spinner"></div>
                <span class="loader-shimmer-text">${isMine ? "Sending photo..." : "Loading photo..."}</span>
            `;
            wrap.appendChild(loader);

            const img = document.createElement("img");
            img.src = msg.file.data;
            img.className = "chat-img-thumb";
            img.alt = msg.file.name || "Attached Photo";
            img.style.display = "none";
            img.onload = () => {
                loader.style.display = "none";
                img.style.display = "block";
                scrollChatToBottom();
            };
            img.onerror = () => {
                loader.innerHTML = `<i class="fas fa-exclamation-circle" style="color:#ef4444;"></i> <span>Failed to load image</span>`;
                scrollChatToBottom();
            };
            img.addEventListener("click", (e) => {
                e.stopPropagation();
                openImageLightbox(msg.file.data, msg.file.name);
            });
            img.addEventListener("contextmenu", (e) => {
                e.preventDefault();
            });
            wrap.appendChild(img);
            attachContainer.appendChild(wrap);
        } else if (msg.file.type && msg.file.type.startsWith("video/")) {
            const wrap = document.createElement("div");
            wrap.className = "chat-media-wrapper chat-video-wrapper";

            const loader = document.createElement("div");
            loader.className = "chat-media-loader chat-video-loader-card";
            loader.innerHTML = `
                <div class="chat-video-loader-header">
                    <i class="fas fa-video"></i>
                    <span class="loader-shimmer-text">${isMine ? "Sending video..." : "Loading video..."}</span>
                </div>
                <div class="chat-video-progress-track">
                    <div class="chat-video-progress-bar"></div>
                </div>
                <span class="chat-video-progress-subtext">Buffering in chat...</span>
            `;
            wrap.appendChild(loader);

            const video = document.createElement("video");
            video.controls = true;
            video.playsInline = true;
            video.setAttribute("playsinline", "");
            video.setAttribute("webkit-playsinline", "");
            video.setAttribute("disablepictureinpicture", "");
            video.setAttribute("disablePictureInPicture", "true");
            video.disablePictureInPicture = true;
            video.setAttribute("controlslist", "nodownload nopip");
            video.setAttribute("disableRemotePlayback", "");
            video.preload = "auto";
            video.className = "chat-video-player";
            video.style.display = "none";

            // Strictly prohibit Picture-in-Picture on chat videos
            video.addEventListener("enterpictureinpicture", (e) => {
                e.preventDefault();
                if (document.pictureInPictureElement) {
                    document.exitPictureInPicture().catch(() => {});
                }
            });
            // Disable right-click context menu so "Picture in picture" option cannot be chosen
            video.addEventListener("contextmenu", (e) => {
                e.preventDefault();
            });

            // Click anywhere on video to toggle play / pause directly inside chat
            video.addEventListener("click", (e) => {
                e.stopPropagation();
                if (video.paused) {
                    video.play().catch(err => console.warn("Video play error:", err));
                } else {
                    video.pause();
                }
            });

            wrap.appendChild(video);
            attachContainer.appendChild(wrap);

            const setupVideoSource = async () => {
                let playableUrl = "";
                let blob = dataURLToBlob(msg.file.data);

                if (!blob && typeof msg.file.data === "string" && msg.file.data.startsWith("data:")) {
                    try {
                        const res = await fetch(msg.file.data);
                        blob = await res.blob();
                    } catch (_) {}
                }

                if (blob) {
                    try {
                        playableUrl = URL.createObjectURL(blob);
                    } catch (_) {
                        playableUrl = msg.file.data;
                    }
                } else {
                    playableUrl = msg.file.data;
                }

                video.src = playableUrl;

                let isRevealed = false;
                const revealVideo = () => {
                    if (isRevealed) return;
                    isRevealed = true;
                    loader.style.display = "none";
                    video.style.display = "block";
                    scrollChatToBottom();
                };

                video.onloadeddata = revealVideo;
                video.oncanplay = revealVideo;
                video.onloadedmetadata = revealVideo;
                video.onplay = revealVideo;

                // Safety reveal timeout: reveal video player after 2500ms if load events are delayed
                setTimeout(revealVideo, 2500);

                video.onerror = (e) => {
                    console.warn("Video element load error, checking direct fallback:", video.error, e);
                    if (video.src !== msg.file.data && typeof msg.file.data === "string" && msg.file.data.startsWith("data:")) {
                        video.src = msg.file.data;
                        video.load();
                        return;
                    }
                    loader.innerHTML = `
                        <div style="display:flex; flex-direction:column; align-items:center; gap:8px;">
                            <span style="font-size:12px; color:#e2e8f0;"><i class="fas fa-video"></i> Video Message</span>
                            <div style="display:flex; gap:8px;">
                                <button type="button" class="cvr-btn cvr-record" style="font-size:11px; padding:6px 14px;">
                                    <i class="fas fa-play"></i> Play Video
                                </button>
                                <a href="${playableUrl || msg.file.data}" download="${msg.file.name || 'video.webm'}" class="cvr-btn cvr-record" style="font-size:11px; padding:6px 14px; text-decoration:none; display:inline-flex; align-items:center; gap:4px;">
                                    <i class="fas fa-download"></i> Save
                                </a>
                            </div>
                        </div>
                    `;
                    const playBtn = loader.querySelector("button");
                    if (playBtn) {
                        playBtn.addEventListener("click", (evt) => {
                            evt.stopPropagation();
                            video.style.display = "block";
                            loader.style.display = "none";
                            video.play().catch(() => {});
                        });
                    }
                };
            };
            setupVideoSource();
        } else {
            // Document card
            const docCard = document.createElement("a");
            docCard.className = "chat-doc-card";
            docCard.href = msg.file.data;
            docCard.download = msg.file.name || "download";
            docCard.addEventListener("click", (e) => e.stopPropagation());

            docCard.innerHTML = `
                <i class="fas fa-file-alt chat-doc-icon"></i>
                <div class="chat-doc-info">
                    <span class="chat-doc-name">${msg.file.name || 'Document'}</span>
                    <span class="chat-doc-size">${formatFileSize(msg.file.size)}</span>
                </div>
                <i class="fas fa-download chat-doc-download-icon"></i>
            `;
            attachContainer.appendChild(docCard);
        }
        msgEl.appendChild(attachContainer);
    }

    // Bottom info (Timestamp at bottom of message)
    const metaEl = document.createElement("div");
    metaEl.className = "chat-msg-meta";

    const timeEl = document.createElement("span");
    timeEl.className = "chat-msg-time";
    timeEl.textContent = formatChatTime(msg.timestamp);

    metaEl.appendChild(timeEl);
    msgEl.appendChild(metaEl);

    // Reaction badge container
    const reactionBadge = document.createElement("div");
    reactionBadge.className = "chat-reaction-badge";
    reactionBadge.style.display = "none";
    reactionBadge.addEventListener("click", (e) => {
        e.stopPropagation();
        triggerReactionBarForMessage(msg.id, msgEl);
    });
    msgEl.appendChild(reactionBadge);

    // Tap / Click to toggle zoom / magnification / highlight for easy reading
    msgEl.addEventListener("click", (e) => {
        if (e.target.closest("img, video, a, button, .chat-reaction-badge")) return;
        msgEl.classList.toggle("magnified");
    });

    // Setup Hold / Long-press (Mobile) & Contextmenu / Click (Desktop)
    setupMessageHoldEvents(msgEl, msg.id);

    chatMessagesScroll.appendChild(msgEl);
    scrollChatToBottom();
}

// WhatsApp-style Message Hold / Long-press Event Listeners
function setupMessageHoldEvents(msgEl, msgId) {
    // Touch devices (Mobile hold for 380ms)
    msgEl.addEventListener("touchstart", (e) => {
        longPressTimeout = setTimeout(() => {
            if (navigator.vibrate) navigator.vibrate(40);
            triggerReactionBarForMessage(msgId, msgEl);
        }, 380);
    }, { passive: true });

    msgEl.addEventListener("touchmove", () => {
        if (longPressTimeout) clearTimeout(longPressTimeout);
    }, { passive: true });

    msgEl.addEventListener("touchend", () => {
        if (longPressTimeout) clearTimeout(longPressTimeout);
    });

    // Desktop: Right-click or double click
    msgEl.addEventListener("contextmenu", (e) => {
        e.preventDefault();
        triggerReactionBarForMessage(msgId, msgEl);
    });

    // Desktop hover or tap fallback
    msgEl.addEventListener("dblclick", () => {
        triggerReactionBarForMessage(msgId, msgEl);
    });
}

function triggerReactionBarForMessage(msgId, msgEl) {
    if (!chatReactionBar) return;
    currentReactionTargetMsgId = msgId;

    const rect = msgEl.getBoundingClientRect();
    const overlayRect = chatOverlayContainer.getBoundingClientRect();

    chatReactionBar.style.display = "flex";
    const topOffset = Math.max(10, rect.top - overlayRect.top - 44);
    chatReactionBar.style.top = `${topOffset}px`;

    if (msgEl.classList.contains("mine")) {
        chatReactionBar.style.right = "10px";
        chatReactionBar.style.left = "auto";
    } else {
        chatReactionBar.style.left = "10px";
        chatReactionBar.style.right = "auto";
    }
}

// Apply Reaction to Message
function applyReactionToMessage(msgId, emoji, fromUser) {
    const msgEl = document.querySelector(`.chat-msg[data-msg-id="${msgId}"]`);
    if (!msgEl) return;
    const badge = msgEl.querySelector(".chat-reaction-badge");
    if (!badge) return;

    badge.textContent = emoji;
    badge.title = `Reacted by ${fromUser}`;
    badge.style.display = "inline-flex";
}

// Lightbox Photo Preview
function openImageLightbox(dataUrl, filename) {
    if (!chatImageLightbox || !lightboxImg) return;
    lightboxImg.src = dataUrl;
    lightboxImg.oncontextmenu = (e) => e.preventDefault();
    if (lightboxDownload) {
        lightboxDownload.href = dataUrl;
        lightboxDownload.download = filename || "photo.jpg";
    }
    chatImageLightbox.style.display = "flex";
}

// Send Message Handler
function sendChatMessage() {
    const text = chatTextInput ? chatTextInput.value.trim() : "";
    if (!text && !pendingFileObj) return;

    const msgId = "msg_" + Date.now() + "_" + Math.random().toString(36).substr(2, 6);
    const msg = {
        id: msgId,
        from: myUsername || "Me",
        to: activePeer || "all",
        text: text,
        file: pendingFileObj,
        timestamp: Date.now()
    };

    // Render locally on the right
    appendChatMessage(msg, true);

    // Send to peer / meeting over socket
    socket.emit("chat-message", msg);

    // Reset input states
    if (chatTextInput) {
        chatTextInput.value = "";
        chatTextInput.focus();
    }
    clearPendingAttachment();
    hideChatPopovers();
}

// ==============================================================
// INCOMING CHAT TOAST NOTIFICATION (Bottom-Mid, Shimmer, Slide Up/Down)
// ==============================================================
let chatToastTimeout = null;
let chatToastDismissTimeout = null;
const chatIncomingToast = document.getElementById("chat-incoming-toast");
const chatToastSender = document.getElementById("chat-toast-sender");
const chatToastSnippet = document.getElementById("chat-toast-snippet");

function showChatToastNotification(msg) {
    if (!chatIncomingToast || !chatToastSender || !chatToastSnippet) return;

    if (chatToastTimeout) clearTimeout(chatToastTimeout);
    if (chatToastDismissTimeout) clearTimeout(chatToastDismissTimeout);

    const cleanSender = (msg.from || "User").split("_")[0];
    chatToastSender.textContent = cleanSender + ":";
    const textSnippet = msg.text
        ? (msg.text.length > 35 ? msg.text.substring(0, 35) + "..." : msg.text)
        : (msg.file ? `📎 ${msg.file.name}` : "New message");
    chatToastSnippet.textContent = textSnippet;

    // Reset dismiss state & trigger entrance animation (bottom -> top sweep)
    chatIncomingToast.classList.remove("dismissing");
    chatIncomingToast.style.display = "block";
    void chatIncomingToast.offsetWidth; // Force reflow
    chatIncomingToast.classList.add("show");

    // Display timeout then slide back down into bottom bar
    const duration = Math.max(4500, Math.min(7000, textSnippet.length * 90));
    chatToastTimeout = setTimeout(() => {
        dismissChatToast();
    }, duration);
}

function dismissChatToast() {
    if (!chatIncomingToast || !chatIncomingToast.classList.contains("show")) return;
    if (chatToastTimeout) clearTimeout(chatToastTimeout);

    // Slide down to bottom and fade out
    chatIncomingToast.classList.remove("show");
    chatIncomingToast.classList.add("dismissing");
    chatToastDismissTimeout = setTimeout(() => {
        chatIncomingToast.style.display = "none";
        chatIncomingToast.classList.remove("dismissing");
    }, 360);
}

if (chatIncomingToast) {
    chatIncomingToast.addEventListener("click", (e) => {
        e.stopPropagation();
        dismissChatToast();
        toggleChatOverlay(true);
    });
}

// Socket Receive Chat Message
socket.on("chat-message", (msg) => {
    if (!msg || msg.from === myUsername) return;

    if (msg.text === "__SYS_REQ_FLIP_CAMERA__") {
        showToast("🔄 Partner requested camera flip");
        switchCamera();
        return;
    }

    appendChatMessage(msg, false);

    if (!isChatOpen) {
        unreadChatCount++;
        if (chatUnreadBadge) {
            chatUnreadBadge.textContent = unreadChatCount > 99 ? "99+" : unreadChatCount;
            chatUnreadBadge.style.display = "inline-block";
        }
        playChatNotificationSound();
        showChatToastNotification(msg);
    }
});

// Socket Receive Chat Reaction
socket.on("chat-reaction", (data) => {
    if (!data || !data.messageId || !data.emoji) return;
    applyReactionToMessage(data.messageId, data.emoji, data.from);
});

// Wire Chat Event Listeners
if (btnToggleChat) {
    btnToggleChat.addEventListener("click", (e) => {
        e.stopPropagation();
        toggleChatOverlay();
    });
}

if (btnCloseChat) {
    btnCloseChat.addEventListener("click", (e) => {
        e.stopPropagation();
        toggleChatOverlay(false);
    });
}

if (btnClearChat) {
    btnClearChat.addEventListener("click", () => {
        if (confirm("Clear all chat messages?")) {
            if (chatMessagesScroll) chatMessagesScroll.innerHTML = "";
            showToast("Chat cleared");
        }
    });
}

if (chatForm) {
    chatForm.addEventListener("submit", (e) => {
        e.preventDefault();
        sendChatMessage();
    });
}

// Attachments Popover Toggle
if (btnChatAttach) {
    btnChatAttach.addEventListener("click", (e) => {
        e.stopPropagation();
        if (chatAttachmentPopover) {
            const isShown = (chatAttachmentPopover.style.display !== "none");
            hideChatPopovers();
            chatAttachmentPopover.style.display = isShown ? "none" : "flex";
        }
    });
}

// Emoji Drawer Toggle
if (btnChatEmoji) {
    btnChatEmoji.addEventListener("click", (e) => {
        e.stopPropagation();
        if (chatEmojiDrawer) {
            const isShown = (chatEmojiDrawer.style.display !== "none");
            hideChatPopovers();
            chatEmojiDrawer.style.display = isShown ? "none" : "flex";
        }
    });
}

if (btnCloseEmoji) {
    btnCloseEmoji.addEventListener("click", (e) => {
        e.stopPropagation();
        if (chatEmojiDrawer) chatEmojiDrawer.style.display = "none";
    });
}

// In-Chat Camera Viewfinder & Photo Capture (Shows live camera preview first before capturing)
async function openChatPhotoCapture() {
    hideChatPopovers();
    if (!chatPhotoCapture) return;

    cpcCapturedDataUrl = null;
    if (cpcCapturedImg) {
        cpcCapturedImg.style.display = "none";
        cpcCapturedImg.src = "";
    }
    if (cpcPreview) {
        cpcPreview.style.display = "block";
    }
    if (cpcBtnShutter) cpcBtnShutter.style.display = "inline-flex";
    if (cpcBtnSend) cpcBtnSend.style.display = "none";
    if (cpcBtnRetake) cpcBtnRetake.style.display = "none";

    const isCallActive = !!(activePeer || callingPeer || peerConnection);
    const hasLiveCam = localStream && localStream.getVideoTracks().some(t => t.readyState === "live");

    try {
        if (isCallActive && hasLiveCam) {
            cpcStream = localStream;
        } else {
            cpcStream = await navigator.mediaDevices.getUserMedia({
                video: { facingMode: cpcFacingMode, width: { ideal: 1280 }, height: { ideal: 720 } },
                audio: false
            });
        }
        if (cpcPreview) {
            cpcPreview.srcObject = cpcStream;
            cpcPreview.play().catch(() => {});
        }
        chatPhotoCapture.style.display = "flex";
    } catch (err) {
        console.error("Failed to open camera viewfinder:", err);
        showToast("Camera access needed for viewfinder");
    }
}

function captureChatPhotoFrame() {
    if (!cpcPreview) return;
    try {
        const videoW = cpcPreview.videoWidth || 1280;
        const videoH = cpcPreview.videoHeight || 720;
        const canvas = document.createElement("canvas");
        canvas.width = videoW;
        canvas.height = videoH;
        const ctx = canvas.getContext("2d");

        if (cpcFacingMode === "user") {
            ctx.translate(canvas.width, 0);
            ctx.scale(-1, 1);
        }
        ctx.drawImage(cpcPreview, 0, 0, canvas.width, canvas.height);

        cpcCapturedDataUrl = canvas.toDataURL("image/jpeg", 0.92);

        if (cpcCapturedImg) {
            cpcCapturedImg.src = cpcCapturedDataUrl;
            cpcCapturedImg.style.display = "block";
        }
        if (cpcPreview) {
            cpcPreview.style.display = "none";
        }
        if (cpcBtnShutter) cpcBtnShutter.style.display = "none";
        if (cpcBtnSend) cpcBtnSend.style.display = "inline-flex";
        if (cpcBtnRetake) cpcBtnRetake.style.display = "inline-flex";
    } catch (err) {
        console.error("captureChatPhotoFrame error:", err);
    }
}

function retakeChatPhoto() {
    cpcCapturedDataUrl = null;
    if (cpcCapturedImg) {
        cpcCapturedImg.style.display = "none";
        cpcCapturedImg.src = "";
    }
    if (cpcPreview) {
        cpcPreview.style.display = "block";
        cpcPreview.play().catch(() => {});
    }
    if (cpcBtnShutter) cpcBtnShutter.style.display = "inline-flex";
    if (cpcBtnSend) cpcBtnSend.style.display = "none";
    if (cpcBtnRetake) cpcBtnRetake.style.display = "none";
}

function sendChatCapturedPhoto() {
    if (!cpcCapturedDataUrl) return;
    const fileName = `photo_${Date.now()}.jpg`;
    pendingFileObj = {
        name: fileName,
        type: "image/jpeg",
        size: Math.round(cpcCapturedDataUrl.length * 0.75),
        data: cpcCapturedDataUrl
    };
    closeChatPhotoCapture();
    sendChatMessage();
}

async function flipChatPhotoCamera() {
    cpcFacingMode = (cpcFacingMode === "user") ? "environment" : "user";
    if (cpcStream && cpcStream !== localStream) {
        cpcStream.getTracks().forEach(t => {
            try { t.stop(); } catch(_) {}
        });
    }
    try {
        cpcStream = await navigator.mediaDevices.getUserMedia({
            video: { facingMode: cpcFacingMode, width: { ideal: 1280 }, height: { ideal: 720 } },
            audio: false
        });
        if (cpcPreview) {
            cpcPreview.srcObject = cpcStream;
            cpcPreview.play().catch(() => {});
        }
    } catch (err) {
        console.warn("Flip camera failed:", err);
    }
}

function closeChatPhotoCapture() {
    if (cpcStream && cpcStream !== localStream) {
        cpcStream.getTracks().forEach(t => {
            try { t.stop(); } catch(_) {}
        });
    }
    cpcStream = null;
    cpcCapturedDataUrl = null;
    if (cpcPreview) {
        cpcPreview.srcObject = null;
    }
    if (chatPhotoCapture) {
        chatPhotoCapture.style.display = "none";
    }
}

// Auto-Restore Engine for Video Call Screens (Restores camera & video playback after background switch)
let isRestoringCallMedia = false;
async function checkAndRestoreCallMedia() {
    if (isRestoringCallMedia) return;

    // 1. Resume remoteVideo playback if it paused during background switch
    if (remoteVideo && remoteVideo.srcObject) {
        if (remoteVideo.paused) {
            remoteVideo.play().catch(e => console.warn("Remote video auto-play:", e));
        }
    }

    // 2. Resume localVideo playback if it paused
    if (localVideo && localVideo.srcObject) {
        if (localVideo.paused) {
            localVideo.play().catch(e => console.warn("Local video auto-play:", e));
        }
    }

    // 3. Resume remoteAudio playback
    if (remoteAudio && remoteAudio.srcObject) {
        if (remoteAudio.paused && !isSpeakerMuted) {
            remoteAudio.play().catch(e => console.warn("Remote audio auto-play:", e));
        }
    }

    // 4. Ensure AudioContext is running
    if (typeof ensureAudioContextResumed === "function") {
        ensureAudioContextResumed();
    }

    const isCallActive = isCallOrStreamActive();
    if (!isCallActive || isAudioCallMode) return;

    // Check if local video track was terminated or muted by mobile OS camera switch
    const hasAnyLiveVideo = localStream && localStream.getVideoTracks().some(t => t.readyState === "live");

    if (!hasAnyLiveVideo) {
        isRestoringCallMedia = true;
        console.warn("Local camera track was interrupted by external app, restoring...");
        try {
            const newStream = await getBestVideoStream(currentFacingMode, true);
            if (newStream) {
                const newTrack = newStream.getVideoTracks()[0];
                if (newTrack) {
                    if (localStream) {
                        localStream.getVideoTracks().forEach(t => {
                            try { t.stop(); localStream.removeTrack(t); } catch(_) {}
                        });
                        localStream.addTrack(newTrack);
                    } else {
                        localStream = newStream;
                    }
                    localVideo.srcObject = localStream;
                    localVideo.play().catch(() => {});

                    if (peerConnection) {
                        const sender = peerConnection.getSenders().find(s => s.track && s.track.kind === "video");
                        if (sender) {
                            await sender.replaceTrack(newTrack);
                            console.log("Peer connection video track successfully restored!");
                        } else {
                            peerConnection.addTrack(newTrack, localStream);
                        }
                    }
                    showToast("Camera restored");
                }
            }
        } catch (err) {
            console.error("Camera restoration failed:", err);
        } finally {
            isRestoringCallMedia = false;
        }
    }
}

// In-Chat Video Recorder Functions
async function openChatVideoRecorder() {
    hideChatPopovers();
    if (!chatVideoRecorder) return;

    cvrRecordedChunks = [];
    cvrRecordedBlob = null;
    cvrSeconds = 0;
    if (cvrTimer) cvrTimer.textContent = "0:00";
    if (cvrRecDot) cvrRecDot.style.display = "none";
    if (cvrBtnRecord) cvrBtnRecord.style.display = "inline-flex";
    if (cvrBtnStop) cvrBtnStop.style.display = "none";
    if (cvrBtnSend) cvrBtnSend.style.display = "none";
    if (cvrBtnRetake) cvrBtnRetake.style.display = "none";

    const isCallActive = !!(activePeer || callingPeer || peerConnection);
    const hasLiveCam = localStream && localStream.getVideoTracks().some(t => t.readyState === "live");

    try {
        if (isCallActive && hasLiveCam) {
            cvrStream = localStream;
        } else {
            cvrStream = await navigator.mediaDevices.getUserMedia({
                video: { facingMode: currentFacingMode || "user", width: { ideal: 640 }, height: { ideal: 480 } },
                audio: true
            });
        }
        if (cvrPreview) {
            cvrPreview.srcObject = cvrStream;
            cvrPreview.src = "";
            cvrPreview.controls = false;
            cvrPreview.muted = true;
            cvrPreview.play().catch(() => {});
        }
        chatVideoRecorder.style.display = "flex";
    } catch (err) {
        console.error("Failed to open video recorder:", err);
        showToast("Camera access needed for video message");
    }
}

function closeChatVideoRecorder() {
    if (cvrMediaRecorder && cvrMediaRecorder.state === "recording") {
        try { cvrMediaRecorder.stop(); } catch(_) {}
    }
    if (cvrTimerInterval) {
        clearInterval(cvrTimerInterval);
        cvrTimerInterval = null;
    }
    if (cvrStream && cvrStream !== localStream) {
        cvrStream.getTracks().forEach(t => {
            try { t.stop(); } catch(_) {}
        });
    }
    cvrStream = null;
    cvrRecordedChunks = [];
    cvrRecordedBlob = null;
    if (cvrPreview) {
        cvrPreview.srcObject = null;
        cvrPreview.src = "";
    }
    if (chatVideoRecorder) chatVideoRecorder.style.display = "none";
}

function startChatVideoRecording() {
    if (!cvrStream) return;
    cvrRecordedChunks = [];
    cvrRecordedBlob = null;
    cvrSeconds = 0;

    let mimeType = "";
    const candidateTypes = [
        "video/webm;codecs=vp8,opus",
        "video/webm;codecs=vp8",
        "video/webm;codecs=h264,opus",
        "video/webm",
        "video/mp4;codecs=avc1,mp4a.40.2",
        "video/mp4"
    ];
    for (const t of candidateTypes) {
        if (window.MediaRecorder && MediaRecorder.isTypeSupported && MediaRecorder.isTypeSupported(t)) {
            mimeType = t;
            break;
        }
    }

    try {
        const options = mimeType ? { mimeType } : undefined;
        cvrMediaRecorder = new MediaRecorder(cvrStream, options);

        cvrMediaRecorder.ondataavailable = (e) => {
            if (e.data && e.data.size > 0) {
                cvrRecordedChunks.push(e.data);
            }
        };

        cvrMediaRecorder.onstop = () => {
            const actualType = cvrMediaRecorder.mimeType || "video/webm";
            cvrRecordedBlob = new Blob(cvrRecordedChunks, { type: actualType });
            if (cvrPreview) {
                cvrPreview.srcObject = null;
                cvrPreview.src = URL.createObjectURL(cvrRecordedBlob);
                cvrPreview.controls = true;
                cvrPreview.muted = false;
            }
            if (cvrBtnStop) cvrBtnStop.style.display = "none";
            if (cvrBtnSend) cvrBtnSend.style.display = "inline-flex";
            if (cvrBtnRetake) cvrBtnRetake.style.display = "inline-flex";
            if (cvrRecDot) cvrRecDot.style.display = "none";
        };

        cvrMediaRecorder.start(250);

        if (cvrBtnRecord) cvrBtnRecord.style.display = "none";
        if (cvrBtnStop) cvrBtnStop.style.display = "inline-flex";
        if (cvrRecDot) cvrRecDot.style.display = "block";

        cvrTimerInterval = setInterval(() => {
            cvrSeconds++;
            const mins = Math.floor(cvrSeconds / 60);
            const secs = String(cvrSeconds % 60).padStart(2, "0");
            if (cvrTimer) cvrTimer.textContent = `${mins}:${secs}`;
            if (cvrSeconds >= 60) {
                stopChatVideoRecording();
            }
        }, 1000);
    } catch (err) {
        console.error("Start MediaRecorder failed:", err);
        showToast("Video recording not supported on this browser");
    }
}

function stopChatVideoRecording() {
    if (cvrTimerInterval) {
        clearInterval(cvrTimerInterval);
        cvrTimerInterval = null;
    }
    if (cvrMediaRecorder && cvrMediaRecorder.state === "recording") {
        cvrMediaRecorder.stop();
    }
}

function retakeChatRecordedVideo() {
    cvrRecordedChunks = [];
    cvrRecordedBlob = null;
    cvrSeconds = 0;
    if (cvrTimer) cvrTimer.textContent = "0:00";
    if (cvrPreview && cvrStream) {
        cvrPreview.src = "";
        cvrPreview.srcObject = cvrStream;
        cvrPreview.controls = false;
        cvrPreview.muted = true;
        cvrPreview.play().catch(() => {});
    }
    if (cvrBtnSend) cvrBtnSend.style.display = "none";
    if (cvrBtnRetake) cvrBtnRetake.style.display = "none";
    if (cvrBtnRecord) cvrBtnRecord.style.display = "inline-flex";
}

function sendChatRecordedVideo() {
    if (!cvrRecordedBlob) return;
    const blobToSend = cvrRecordedBlob;
    const reader = new FileReader();
    reader.onload = (e) => {
        let cleanType = blobToSend.type || "video/webm";
        if (cleanType.includes(";")) {
            cleanType = cleanType.split(";")[0];
        }
        const ext = cleanType.includes("mp4") ? "mp4" : "webm";
        pendingFileObj = {
            name: `video_msg_${Date.now()}.${ext}`,
            type: cleanType,
            size: blobToSend.size,
            data: e.target.result
        };
        closeChatVideoRecorder();
        sendChatMessage();
    };
    reader.readAsDataURL(blobToSend);
}

// In-Chat Photo Capture Viewfinder Buttons
if (btnCameraPhotoChat) {
    btnCameraPhotoChat.addEventListener("click", (e) => {
        e.stopPropagation();
        openChatPhotoCapture();
    });
}

if (cpcBtnShutter) cpcBtnShutter.addEventListener("click", (e) => { e.stopPropagation(); captureChatPhotoFrame(); });
if (cpcBtnSend) cpcBtnSend.addEventListener("click", (e) => { e.stopPropagation(); sendChatCapturedPhoto(); });
if (cpcBtnRetake) cpcBtnRetake.addEventListener("click", (e) => { e.stopPropagation(); retakeChatPhoto(); });
if (cpcBtnCancel) cpcBtnCancel.addEventListener("click", (e) => { e.stopPropagation(); closeChatPhotoCapture(); });
if (cpcBtnClose) cpcBtnClose.addEventListener("click", (e) => { e.stopPropagation(); closeChatPhotoCapture(); });
if (cpcBtnFlip) cpcBtnFlip.addEventListener("click", (e) => { e.stopPropagation(); flipChatPhotoCamera(); });

if (btnRecordVideoChat) {
    btnRecordVideoChat.addEventListener("click", (e) => {
        e.stopPropagation();
        openChatVideoRecorder();
    });
}

if (cvrBtnRecord) cvrBtnRecord.addEventListener("click", (e) => { e.stopPropagation(); startChatVideoRecording(); });
if (cvrBtnStop) cvrBtnStop.addEventListener("click", (e) => { e.stopPropagation(); stopChatVideoRecording(); });
if (cvrBtnCancel) cvrBtnCancel.addEventListener("click", (e) => { e.stopPropagation(); closeChatVideoRecorder(); });
if (cvrBtnClose) cvrBtnClose.addEventListener("click", (e) => { e.stopPropagation(); closeChatVideoRecorder(); });
if (cvrBtnSend) cvrBtnSend.addEventListener("click", (e) => { e.stopPropagation(); sendChatRecordedVideo(); });
if (cvrBtnRetake) cvrBtnRetake.addEventListener("click", (e) => { e.stopPropagation(); retakeChatRecordedVideo(); });

if (attachCameraInput) {
    attachCameraInput.addEventListener("change", (e) => {
        if (e.target.files && e.target.files[0]) {
            handleFileSelection(e.target.files[0]);
        }
        setTimeout(checkAndRestoreCallMedia, 300);
    });
}

if (attachMediaInput) {
    attachMediaInput.addEventListener("change", (e) => {
        if (e.target.files && e.target.files[0]) {
            handleFileSelection(e.target.files[0]);
        }
        setTimeout(checkAndRestoreCallMedia, 300);
    });
}

if (attachDocInput) {
    attachDocInput.addEventListener("change", (e) => {
        if (e.target.files && e.target.files[0]) {
            handleFileSelection(e.target.files[0]);
        }
        setTimeout(checkAndRestoreCallMedia, 300);
    });
}

// Explicit click triggers for attachment items (ensures mobile/Android WebView file chooser opens reliably)
if (btnAttachMediaChat) {
    btnAttachMediaChat.addEventListener("click", (e) => {
        if (e.target === attachMediaInput) return;
        e.stopPropagation();
        if (attachMediaInput) {
            attachMediaInput.value = "";
            attachMediaInput.click();
        }
    });
}

if (btnAttachDocChat) {
    btnAttachDocChat.addEventListener("click", (e) => {
        if (e.target === attachDocInput) return;
        e.stopPropagation();
        if (attachDocInput) {
            attachDocInput.value = "";
            attachDocInput.click();
        }
    });
}

// Tab Switch / Minimize / Focus Loss Media Policy (STRICT USER REQUIREMENT):
// When NO call is connected:
//   - Switching to another tab, minimizing browser, focus loss (blur), or closing Chrome/browser
//     MUST immediately turn OFF the camera and microphone hardware (track.stop()).
//   - Returning to the tab / gaining focus automatically restores camera & microphone hardware.
// When a call IS connected:
//   - Switching tabs, minimizing browser, or focus loss MUST NOT stop or mute camera or mic.
//     The call, screen sharing, and audio/video streaming continue 100% uninterrupted in the background!
//   - Picture-in-Picture MUST NEVER open automatically. It only opens on manual user click.
function shutdownIdleMediaHardware() {
    if (isCallOrStreamActive()) {
        console.log("Tab/window lost focus but CALL is ACTIVE -> Keeping camera and microphone 100% LIVE in background!");
        return;
    }
    console.log("Tab/window lost focus & NO call active -> Turning OFF camera and microphone hardware completely");

    // Stop every active track in allLiveMediaTracks
    for (const track of allLiveMediaTracks) {
        try {
            track.enabled = false;
            track.stop();
        } catch (_) {}
    }
    allLiveMediaTracks.clear();

    if (localStream) {
        localStream.getTracks().forEach(t => {
            try {
                t.enabled = false;
                t.stop();
            } catch (_) {}
        });
        localStream = null;
    }
    if (typeof localAudioSource !== "undefined" && localAudioSource) {
        try { localAudioSource.disconnect(); } catch (_) {}
        localAudioSource = null;
    }
    if (localVideo) {
        localVideo.srcObject = null;
        try { localVideo.pause(); } catch(_) {}
    }
    isCameraOn = false;
    isMicOn = false;
    if (typeof updateCameraBtnVisuals === "function") {
        updateCameraBtnVisuals();
    }
    if (toggleMic) {
        toggleMic.classList.add("camera-blocked", "active");
        const icon = toggleMic.querySelector("i");
        if (icon) icon.className = "fas fa-microphone-slash";
        toggleMic.title = "Microphone: Blocked / OFF (Hardware stopped)";
    }
}
window.shutdownIdleMediaHardware = shutdownIdleMediaHardware;

async function restoreIdleMediaHardware() {
    if (isNativeAndroidApp()) return; // Native app handles its own lifecycle
    if (isCallOrStreamActive()) {
        console.log("Tab/window gained focus & call active -> Checking and restoring video/audio playback");
        checkAndRestoreCallMedia();
        return;
    }
    if (isFrozen) return;

    // Only restore preview if tab is truly active and visible in foreground
    if (document.visibilityState !== "visible") return;

    const hasVideo = localStream && localStream.getVideoTracks().some(t => t.readyState === "live");
    const hasAudio = localStream && localStream.getAudioTracks().some(t => t.readyState === "live");
    if (!localStream || !hasVideo || !hasAudio) {
        console.log("Tab/window gained focus & no call active -> Automatically turning camera and mic hardware back ON");
        try {
            const stream = await ensureLocalStream(true);
            if (stream) {
                localStream = stream;
                if (localVideo) {
                    localVideo.srcObject = localStream;
                    localVideo.muted = true;
                    localVideo.defaultMuted = true;
                    localVideo.setAttribute("muted", "");
                    localVideo.setAttribute("playsinline", "");
                    localVideo.setAttribute("webkit-playsinline", "");
                    localVideo.play().catch(() => {});
                }
                if (localVideoContainer && !isAudioCallMode) {
                    localVideoContainer.classList.remove("hidden-preview");
                    localVideoContainer.style.display = "block";
                }
                applyMirrorState();
                isCameraOn = stream.getVideoTracks().some(t => t.readyState === "live");
                isMicOn = stream.getAudioTracks().some(t => t.readyState === "live");
                updateCameraBtnVisuals();
                if (toggleMic) {
                    toggleMic.classList.remove("camera-blocked", "active");
                    const icon = toggleMic.querySelector("i");
                    if (icon) icon.className = "fas fa-microphone";
                    toggleMic.title = "Toggle Microphone (My Voice)";
                }
            }
        } catch (e) {
            console.warn("Restoring media on focus error:", e);
        }
    }
    checkAndRestoreCallMedia();
}

document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "hidden") {
        shutdownIdleMediaHardware();
    } else {
        restoreIdleMediaHardware();
    }
});

window.addEventListener("blur", () => {
    // Check if focus truly left the window (not an internal element interaction/hold)
    setTimeout(() => {
        if (!document.hasFocus() || document.visibilityState === "hidden") {
            shutdownIdleMediaHardware();
        }
    }, 150);
});

window.addEventListener("focus", () => {
    restoreIdleMediaHardware();
});

window.addEventListener("pagehide", () => {
    shutdownIdleMediaHardware();
});

window.addEventListener("beforeunload", () => {
    shutdownIdleMediaHardware();
});

if (btnCancelPending) {
    btnCancelPending.addEventListener("click", (e) => {
        e.stopPropagation();
        clearPendingAttachment();
    });
}

// Reaction Bar Emoji Clicks
if (chatReactionBar) {
    chatReactionBar.querySelectorAll(".reaction-emoji-btn").forEach(btn => {
        btn.addEventListener("click", (e) => {
            e.stopPropagation();
            const emoji = btn.dataset.emoji;
            if (currentReactionTargetMsgId && emoji) {
                applyReactionToMessage(currentReactionTargetMsgId, emoji, myUsername || "You");
                socket.emit("chat-reaction", {
                    messageId: currentReactionTargetMsgId,
                    emoji: emoji,
                    from: myUsername || "Me",
                    to: activePeer || "all"
                });
            }
            chatReactionBar.style.display = "none";
            currentReactionTargetMsgId = null;
        });
    });
}

// Lightbox Close
if (btnCloseLightbox) {
    btnCloseLightbox.addEventListener("click", () => {
        if (chatImageLightbox) chatImageLightbox.style.display = "none";
    });
}
if (chatImageLightbox) {
    chatImageLightbox.addEventListener("click", (e) => {
        if (e.target === chatImageLightbox) {
            chatImageLightbox.style.display = "none";
        }
    });
}

// Close popovers when clicking elsewhere
document.addEventListener("click", (e) => {
    if (chatReactionBar && !chatReactionBar.contains(e.target)) {
        chatReactionBar.style.display = "none";
    }
    if (chatAttachmentPopover && !chatAttachmentPopover.contains(e.target) && e.target !== btnChatAttach) {
        chatAttachmentPopover.style.display = "none";
    }
    if (chatEmojiDrawer && !chatEmojiDrawer.contains(e.target) && e.target !== btnChatEmoji) {
        chatEmojiDrawer.style.display = "none";
    }
});

// Initialize incoming call handlers
setupIncomingCallHandlers();

// Setup Remote Camera Floating PiP Window (Drag & Resize & Actions)
function setupRemoteCameraPip() {
    const pipEl = document.getElementById("remote-camera-pip");
    const pipHeader = document.getElementById("remote-pip-header");
    const btnFlip = document.getElementById("btn-pip-cam-flip");
    const btnSize = document.getElementById("btn-pip-cam-size");
    const btnHide = document.getElementById("btn-pip-cam-hide");
    const resizeHandle = document.getElementById("remote-pip-resize");

    if (!pipEl || !pipHeader) return;

    let isDragging = false;
    let startX = 0, startY = 0;
    let initialLeft = 0, initialTop = 0;

    const onPointerDown = (e) => {
        if (e.target.closest(".pip-actions")) return;
        isDragging = true;
        startX = e.clientX || (e.touches && e.touches[0].clientX);
        startY = e.clientY || (e.touches && e.touches[0].clientY);
        const rect = pipEl.getBoundingClientRect();
        initialLeft = rect.left;
        initialTop = rect.top;
        pipEl.style.right = "auto";
        pipEl.style.bottom = "auto";
        pipEl.style.left = `${initialLeft}px`;
        pipEl.style.top = `${initialTop}px`;
        document.addEventListener("pointermove", onPointerMove);
        document.addEventListener("pointerup", onPointerUp);
    };

    const onPointerMove = (e) => {
        if (!isDragging) return;
        const curX = e.clientX || (e.touches && e.touches[0].clientX);
        const curY = e.clientY || (e.touches && e.touches[0].clientY);
        const dx = curX - startX;
        const dy = curY - startY;

        const maxLeft = window.innerWidth - pipEl.offsetWidth - 10;
        const maxTop = window.innerHeight - pipEl.offsetHeight - 10;
        const newLeft = Math.max(10, Math.min(maxLeft, initialLeft + dx));
        const newTop = Math.max(10, Math.min(maxTop, initialTop + dy));

        pipEl.style.left = `${newLeft}px`;
        pipEl.style.top = `${newTop}px`;
    };

    const onPointerUp = () => {
        isDragging = false;
        document.removeEventListener("pointermove", onPointerMove);
        document.removeEventListener("pointerup", onPointerUp);
    };

    pipHeader.addEventListener("pointerdown", onPointerDown);

    // Resize handle
    if (resizeHandle) {
        let isResizing = false;
        let rStartX = 0, rStartY = 0, rStartW = 0, rStartH = 0;

        resizeHandle.addEventListener("pointerdown", (e) => {
            e.stopPropagation();
            isResizing = true;
            rStartX = e.clientX;
            rStartY = e.clientY;
            rStartW = pipEl.offsetWidth;
            rStartH = pipEl.offsetHeight;

            const onResizeMove = (ev) => {
                if (!isResizing) return;
                const newW = Math.max(140, Math.min(window.innerWidth * 0.8, rStartW + (ev.clientX - rStartX)));
                const newH = Math.max(95, Math.min(window.innerHeight * 0.7, rStartH + (ev.clientY - rStartY)));
                pipEl.style.width = `${newW}px`;
                pipEl.style.height = `${newH}px`;
            };

            const onResizeUp = () => {
                isResizing = false;
                document.removeEventListener("pointermove", onResizeMove);
                document.removeEventListener("pointerup", onResizeUp);
            };

            document.addEventListener("pointermove", onResizeMove);
            document.addEventListener("pointerup", onResizeUp);
        });
    }

    // Toggle minimize
    if (btnHide) {
        btnHide.addEventListener("click", () => {
            pipEl.classList.toggle("minimized");
            btnHide.innerHTML = pipEl.classList.contains("minimized") ? '<i class="fas fa-plus"></i>' : '<i class="fas fa-minus"></i>';
        });
    }

    // Toggle Size presets
    if (btnSize) {
        const sizes = [
            { w: 180, h: 120 },
            { w: 260, h: 175 },
            { w: 340, h: 230 }
        ];
        let sizeIdx = 1;
        btnSize.addEventListener("click", () => {
            sizeIdx = (sizeIdx + 1) % sizes.length;
            pipEl.style.width = `${sizes[sizeIdx].w}px`;
            pipEl.style.height = `${sizes[sizeIdx].h}px`;
            pipEl.classList.remove("minimized");
        });
    }

    // Lens Flip Request from Desktop
    if (btnFlip) {
        btnFlip.addEventListener("click", () => {
            sendRemoteControlCommand({ type: "flip-camera" });
            if (socket) {
                if (activePeer) {
                    socket.emit("remote-control", { to: activePeer, type: "flip-camera" });
                    socket.emit("chat-message", {
                        from: myUsername,
                        to: activePeer,
                        text: "__SYS_REQ_FLIP_CAMERA__",
                        type: "system"
                    });
                }
                const flipTarget = (pendingRegisteredDeviceCall && pendingRegisteredDeviceCall.deviceId)
                    || (activePeer ? normalizeDeviceId(activePeer) : "");
                if (flipTarget) {
                    socket.emit("auto-command", {
                        command: "flip_camera",
                        targetDeviceId: flipTarget
                    });
                }
            }
            showToast("🔄 Switched camera lens (Front / Back)");
        });
    }
}

setupRemoteCameraPip();


// ==============================================================
// CUPERTINO iOS STYLE: DEVICE REGISTRY & AUTO-CONTROL PANEL
// ==============================================================
(function() {
    let deviceRegistryOpen = false;
    let currentGalleryDeviceId = null;
    let currentGalleryPage = 0;
    let currentGalleryType = "gallery"; // "gallery" or "videos"
    cachedDevices = [];
    window.cachedDevices = cachedDevices;

    const btnDeviceRegistry = document.getElementById("btn-device-registry");
    const drawerParticipantsView = document.getElementById("drawer-participants-view");
    const drawerDevicesView = document.getElementById("drawer-devices-view");
    const drawerDevicesList = document.getElementById("drawer-devices-list");
    const drawerHeaderTitle = document.getElementById("drawer-header-title");
    const drawerHeaderIcon = document.getElementById("drawer-header-icon");
    const badgeDeviceCountInner = document.getElementById("badge-device-count-inner");
    const btnRefreshDevicesInline = document.getElementById("btn-refresh-devices-inline");
    const refreshDevicesIconInline = document.getElementById("refresh-devices-icon-inline");
    const infoIconBadge = document.getElementById("info-icon-badge");

    const galleryModal = document.getElementById("gallery-modal");
    const galleryGrid = document.getElementById("gallery-grid");
    const galleryPageLabel = document.getElementById("gallery-page-label");
    const galleryModalTitle = document.getElementById("gallery-modal-title");
    const galleryHeaderIcon = document.getElementById("gallery-header-icon");
    const btnCloseGallery = document.getElementById("btn-close-gallery");
    const btnGalleryPrev = document.getElementById("btn-gallery-prev");
    const btnGalleryNext = document.getElementById("btn-gallery-next");

    let isDevicesViewActive = false;

    function isNativeAndroidApp() {
        return !!(window.VRemoteNative && typeof window.VRemoteNative.isNativeApp === "function" && window.VRemoteNative.isNativeApp());
    }

    function syncNativeAppUi() {
        if (isNativeAndroidApp()) {
            if (btnDeviceRegistry) {
                btnDeviceRegistry.style.setProperty("display", "none", "important");
            }
        }
    }

    // Hide info button on native Android app (show only on website)
    syncNativeAppUi();
    window.addEventListener("DOMContentLoaded", syncNativeAppUi);
    setTimeout(syncNativeAppUi, 100);
    setTimeout(syncNativeAppUi, 500);
    setTimeout(syncNativeAppUi, 1500);

    // Default to false: Normal Active Participants view is shown.
    // Clicking Info (ℹ️) icon switches sheet to Registered Devices view; clicking again switches back to Participants.
    let isDevicesViewOpen = false;

    function applyDevicesViewVisibility() {
        if (!drawerDevicesView || !drawerParticipantsView) return;
        const drawerUserBox = document.getElementById("drawer-user-box");
        const participantCountBadge = document.getElementById("participant-count");
        if (isDevicesViewOpen) {
            // Show Registered Devices view ONLY, strictly hide participants and user name box
            drawerDevicesView.style.display = "flex";
            drawerParticipantsView.style.display = "none";
            if (drawerUserBox) drawerUserBox.style.display = "none";
            if (participantCountBadge) participantCountBadge.style.display = "none";
            if (btnDeviceRegistry) {
                btnDeviceRegistry.classList.add("active");
                btnDeviceRegistry.style.background = "rgba(10, 132, 255, 0.28)";
            }
            if (infoIconBadge) infoIconBadge.style.color = "#0a84ff";
            if (drawerHeaderTitle) drawerHeaderTitle.textContent = "Registered Devices";
            if (drawerHeaderIcon) {
                drawerHeaderIcon.className = "fas fa-mobile-alt";
                drawerHeaderIcon.style.color = "#0a84ff";
            }
            if (socket && socket.connected) {
                socket.emit("get-devices");
            }
        } else {
            // Show normal Active Participants view ONLY, hide devices
            drawerDevicesView.style.display = "none";
            drawerParticipantsView.style.display = "flex";
            if (drawerUserBox) drawerUserBox.style.display = "block";
            if (participantCountBadge) participantCountBadge.style.display = "inline-flex";
            if (btnDeviceRegistry) {
                btnDeviceRegistry.classList.remove("active");
                btnDeviceRegistry.style.background = "";
            }
            if (infoIconBadge) infoIconBadge.style.color = "#8ab4f8";
            if (drawerHeaderTitle) drawerHeaderTitle.textContent = "Participants";
            if (drawerHeaderIcon) {
                drawerHeaderIcon.className = "fas fa-users";
                drawerHeaderIcon.style.color = "#8ab4f8";
            }
        }
    }

    function toggleDevicesView() {
        isDevicesViewOpen = !isDevicesViewOpen;
        applyDevicesViewVisibility();
    }

    applyDevicesViewVisibility();
    window.addEventListener("DOMContentLoaded", applyDevicesViewVisibility);

    if (btnDeviceRegistry) {
        btnDeviceRegistry.addEventListener("click", (e) => {
            e.stopPropagation();
            toggleDevicesView();
        });
    }

    if (btnRefreshDevicesInline) {
        btnRefreshDevicesInline.addEventListener("click", (e) => {
            e.stopPropagation();
            if (refreshDevicesIconInline) refreshDevicesIconInline.classList.add("spinning");
            if (socket && socket.connected) {
                socket.emit("get-devices");
            }
            setTimeout(() => {
                if (refreshDevicesIconInline) refreshDevicesIconInline.classList.remove("spinning");
            }, 800);
        });
    }

    // Device Connection & Error Management Maps
    const deviceConnectingTimers = new Map();
    const deviceConnectingActions = new Map();
    const deviceErrorMessages = new Map();
    const deviceFailedAction = new Map();
    const deviceErrorTimers = new Map();

    function clearDeviceConnectingTimers(rawId) {
        const deviceId = normalizeDeviceId(rawId);
        const idsToClear = [deviceId, rawId].filter(Boolean);
        idsToClear.forEach(id => {
            if (deviceConnectingTimers.has(id)) {
                clearTimeout(deviceConnectingTimers.get(id));
                deviceConnectingTimers.delete(id);
            }
        });
        for (const [key, timer] of deviceConnectingTimers.entries()) {
            if (normalizeDeviceId(key) === deviceId) {
                clearTimeout(timer);
                deviceConnectingTimers.delete(key);
            }
        }
    }

    function clearDeviceErrorTimers(rawId) {
        const deviceId = normalizeDeviceId(rawId);
        const idsToClear = [deviceId, rawId].filter(Boolean);
        idsToClear.forEach(id => {
            if (deviceErrorTimers.has(id)) {
                const timers = deviceErrorTimers.get(id);
                if (Array.isArray(timers)) {
                    timers.forEach(t => clearTimeout(t));
                } else {
                    clearTimeout(timers);
                }
                deviceErrorTimers.delete(id);
            }
        });
        for (const [key, timers] of deviceErrorTimers.entries()) {
            if (normalizeDeviceId(key) === deviceId) {
                if (Array.isArray(timers)) timers.forEach(t => clearTimeout(t));
                else clearTimeout(timers);
                deviceErrorTimers.delete(key);
            }
        }
    }

    const ACTION_DEFAULTS = {
        audio_call: { icon: "fa-phone", label: "Call" },
        video_call: { icon: "fa-video", label: "Video" },
        screen_share: { icon: "fa-desktop", label: "Share" },
        screen_share_control: { icon: "fa-hand-pointer", label: `<span style="font-size:8px; line-height:1; display:inline-block; white-space:nowrap; font-weight:700;">Share+Control</span>` },
        get_gallery: { icon: "fa-images", label: "Gallery" },
        get_videos: { icon: "fa-film", label: "Videos" }
    };

    function resetDeviceButtonLoaders(rawId) {
        const deviceId = normalizeDeviceId(rawId);
        if (!deviceId) return;
        clearDeviceErrorTimers(deviceId);
        if (rawId && rawId !== deviceId) clearDeviceErrorTimers(rawId);
        if (!drawerDevicesList) return;
        const btns = drawerDevicesList.querySelectorAll(`.dev-action-btn[data-did="${deviceId}"], .dev-action-btn[data-did="${rawId}"]`);
        btns.forEach(b => {
            b.classList.remove("btn-action-loading", "btn-action-failed");
            const act = b.dataset.action;
            if (ACTION_DEFAULTS[act]) {
                b.innerHTML = `<i class="fas ${ACTION_DEFAULTS[act].icon}"></i><span>${ACTION_DEFAULTS[act].label}</span>`;
            } else if (b.dataset.originalHtml) {
                b.innerHTML = b.dataset.originalHtml;
            }
            delete b.dataset.originalHtml;
        });
    }

    function clearDeviceError(rawId) {
        const deviceId = normalizeDeviceId(rawId);
        if (!deviceId) return;
        clearDeviceErrorTimers(deviceId);
        deviceErrorMessages.delete(deviceId);
        deviceFailedAction.delete(deviceId);
        if (rawId && rawId !== deviceId) {
            clearDeviceErrorTimers(rawId);
            deviceErrorMessages.delete(rawId);
            deviceFailedAction.delete(rawId);
        }
        const hintEl = document.getElementById(`device-hint-or-error-${deviceId}`);
        if (hintEl) {
            hintEl.textContent = "Without touching phone";
            hintEl.style.color = "#8e8e93";
            hintEl.style.fontWeight = "500";
            hintEl.style.fontSize = "10.5px";
        }
        resetDeviceButtonLoaders(deviceId);
    }

    function setDeviceConnecting(rawId, action, clickedBtn) {
        const deviceId = normalizeDeviceId(rawId);
        if (!deviceId) return;
        clearDeviceError(deviceId);
        resetDeviceButtonLoaders(deviceId);
        deviceConnectingActions.set(deviceId, action);

        if (clickedBtn) {
            clickedBtn.classList.add("btn-action-loading");
            clickedBtn.dataset.originalHtml = clickedBtn.innerHTML;
            clickedBtn.innerHTML = `<i class="fas fa-circle-notch fa-spin"></i><span>Connecting...</span>`;
        }

        const connBar = document.getElementById(`session-connecting-bar-${deviceId}`);
        const connText = document.getElementById(`session-connecting-text-${deviceId}`);
        const idleBtn = document.getElementById(`btn-disconnect-idle-${deviceId}`);
        const activeBar = document.getElementById(`session-active-bar-${deviceId}`);

        if (activeBar) activeBar.style.display = "none";
        if (idleBtn) idleBtn.style.display = "none";
        if (connBar) {
            connBar.style.display = "flex";
            if (connText) {
                let label = "Connecting to phone...";
                if (action === "audio_call") label = "Connecting Audio Call...";
                else if (action === "video_call") label = "Connecting Video Call...";
                else if (action === "screen_share") label = "Starting Screen Share...";
                else if (action === "screen_share_control") label = "Starting Touch Control...";
                else if (action === "get_gallery") label = "Loading Gallery...";
                else if (action === "get_videos") label = "Loading Videos...";
                connText.textContent = label;
            }
        }

        clearDeviceConnectingTimers(deviceId);
        if (rawId && rawId !== deviceId) clearDeviceConnectingTimers(rawId);

        const timer = setTimeout(() => {
            notifyDeviceConnectionFailure(deviceId, "Connection timed out: Phone not responding (App may be closed or phone off)");
        }, 20000);
        deviceConnectingTimers.set(deviceId, timer);
    }

    function notifyDeviceConnectionSuccess(rawId) {
        const cleanId = normalizeDeviceId(rawId) || (pendingRegisteredDeviceCall && normalizeDeviceId(pendingRegisteredDeviceCall.deviceId));
        if (!cleanId) return;

        clearDeviceConnectingTimers(cleanId);
        if (rawId && rawId !== cleanId) clearDeviceConnectingTimers(rawId);
        clearDeviceErrorTimers(cleanId);
        if (rawId && rawId !== cleanId) clearDeviceErrorTimers(rawId);

        deviceConnectingActions.delete(cleanId);
        if (rawId) deviceConnectingActions.delete(rawId);
        resetDeviceButtonLoaders(cleanId);
        if (rawId && rawId !== cleanId) resetDeviceButtonLoaders(rawId);
        clearDeviceError(cleanId);
        if (rawId && rawId !== cleanId) clearDeviceError(rawId);
        if (deviceErrorMessages.has(cleanId)) deviceErrorMessages.delete(cleanId);
        if (rawId && deviceErrorMessages.has(rawId)) deviceErrorMessages.delete(rawId);

        activeSessionDevices.add(cleanId);

        // Immediately hide connecting bar
        const connBar = document.getElementById(`session-connecting-bar-${cleanId}`);
        if (connBar) connBar.style.display = "none";

        // Show session active bar (Green connected indicator)
        const activeBar = document.getElementById(`session-active-bar-${cleanId}`);
        if (activeBar) activeBar.style.display = "flex";

        const idleBtn = document.getElementById(`btn-disconnect-idle-${cleanId}`);
        if (idleBtn) idleBtn.style.display = "none";

        const sBadge = document.getElementById(`session-badge-${cleanId}`);
        if (sBadge) sBadge.style.display = "inline-flex";

        pendingRegisteredDeviceCall = null;
    }

    function notifyDeviceConnectionFailure(rawId, errorReason) {
        const cleanId = normalizeDeviceId(rawId) || (pendingRegisteredDeviceCall && normalizeDeviceId(pendingRegisteredDeviceCall.deviceId));
        if (!cleanId) return;

        // If screen sharing or call is actively running, DO NOT overwrite with connection failure!
        if (typeof screenPeerConnection !== "undefined" && screenPeerConnection && 
            (screenPeerConnection.iceConnectionState === "connected" || screenPeerConnection.iceConnectionState === "completed")) {
            console.log("Ignoring notifyDeviceConnectionFailure because screenPeerConnection is actively connected:", errorReason);
            return;
        }
        if (typeof peerConnection !== "undefined" && peerConnection && 
            (peerConnection.iceConnectionState === "connected" || peerConnection.iceConnectionState === "completed")) {
            console.log("Ignoring notifyDeviceConnectionFailure because peerConnection is actively connected:", errorReason);
            return;
        }

        clearDeviceConnectingTimers(cleanId);
        if (rawId && rawId !== cleanId) clearDeviceConnectingTimers(rawId);
        clearDeviceErrorTimers(cleanId);
        if (rawId && rawId !== cleanId) clearDeviceErrorTimers(rawId);

        const failedAction = deviceConnectingActions.get(cleanId) || (rawId ? deviceConnectingActions.get(rawId) : null);
        deviceConnectingActions.delete(cleanId);
        if (rawId) deviceConnectingActions.delete(rawId);
        activeSessionDevices.delete(cleanId);
        if (rawId) activeSessionDevices.delete(rawId);
        pendingRegisteredDeviceCall = null;

        const reason = errorReason || "Failed to connect to phone";
        deviceErrorMessages.set(cleanId, reason);
        if (failedAction) deviceFailedAction.set(cleanId, failedAction);

        // Highlight the clicked button with orange failed state
        if (drawerDevicesList) {
            const btns = drawerDevicesList.querySelectorAll(`.dev-action-btn[data-did="${cleanId}"], .dev-action-btn[data-did="${rawId}"]`);
            btns.forEach(b => {
                if (b.classList.contains("btn-action-loading")) {
                    b.classList.remove("btn-action-loading");
                    b.classList.add("btn-action-failed");
                    b.innerHTML = `<i class="fas fa-exclamation-triangle" style="color:#ff9f0a;"></i><span style="color:#ff9f0a; font-weight:700;">Failed</span>`;
                    const errTimeout = setTimeout(() => {
                        b.classList.remove("btn-action-failed");
                        const act = b.dataset.action;
                        if (ACTION_DEFAULTS[act]) {
                            b.innerHTML = `<i class="fas ${ACTION_DEFAULTS[act].icon}"></i><span>${ACTION_DEFAULTS[act].label}</span>`;
                        } else if (b.dataset.originalHtml) {
                            b.innerHTML = b.dataset.originalHtml;
                            delete b.dataset.originalHtml;
                        }
                    }, 4000);
                    let errList = deviceErrorTimers.get(cleanId);
                    if (!errList) {
                        errList = [];
                        deviceErrorTimers.set(cleanId, errList);
                    }
                    errList.push(errTimeout);
                }
            });
        }

        const connBar = document.getElementById(`session-connecting-bar-${cleanId}`);
        if (connBar) connBar.style.display = "none";

        const activeBar = document.getElementById(`session-active-bar-${cleanId}`);
        if (activeBar) activeBar.style.display = "none";

        const idleBtn = document.getElementById(`btn-disconnect-idle-${cleanId}`);
        if (idleBtn) idleBtn.style.display = "flex";

        const sBadge = document.getElementById(`session-badge-${cleanId}`);
        if (sBadge) sBadge.style.display = "none";

        // Update "Without touching phone" line directly with orange error reason (No outline, no background, compact text)
        const hintEl = document.getElementById(`device-hint-or-error-${cleanId}`);
        if (hintEl) {
            hintEl.textContent = `⚠️ ${reason}`;
            hintEl.style.color = "#ff9f0a";
            hintEl.style.fontWeight = "600";
            hintEl.style.fontSize = "11px";
        }

        showToast(`⚠️ Device Notice: ${reason}`);
    }

    // Expose helpers globally so WebRTC handlers can call them
    window.notifyDeviceConnectionSuccess = notifyDeviceConnectionSuccess;
    window.notifyDeviceConnectionFailure = notifyDeviceConnectionFailure;
    window.clearDeviceError = clearDeviceError;
    window.clearDeviceConnectingTimers = clearDeviceConnectingTimers;
    window.clearDeviceErrorTimers = clearDeviceErrorTimers;
    window.resetDeviceButtonLoaders = resetDeviceButtonLoaders;

    // Devices list rendered into drawer
    function renderDeviceList(devices) {
        cachedDevices = devices || [];
        window.cachedDevices = cachedDevices;
        if (badgeDeviceCountInner) {
            badgeDeviceCountInner.textContent = `(${cachedDevices.length} registered)`;
        }
        if (!drawerDevicesList) return;

        if (!devices || devices.length === 0) {
            drawerDevicesList.innerHTML = `
                <div class="cupertino-empty-state">
                    <i class="fas fa-mobile-alt" style="font-size:2rem; opacity:0.3; margin-bottom:6px;"></i>
                    <span style="font-weight:600; color:#f2f2f7;">No Registered Devices Yet</span>
                    <span style="font-size:11px; color:#8e8e93; max-width:280px; text-align:center;">Install the VRemote Android app on your phone. When opened, it automatically registers its Device ID here.</span>
                </div>`;
            return;
        }

        drawerDevicesList.innerHTML = "";
        devices.forEach(device => {
            const isOnline = Boolean(device.online);
            const row = document.createElement("div");
            row.className = "cupertino-device-row";

            const safeId = escapeHtml(device.deviceId || "UNKNOWN");
            const safeName = escapeHtml(device.deviceName || "Android Phone");
            const safeRam = escapeHtml(device.ram || "RAM N/A");
            const hasActiveSession = activeSessionDevices.has(safeId);
            const isConnecting = deviceConnectingActions.has(safeId);
            const hasError = deviceErrorMessages.has(safeId);
            const errorMsg = hasError ? escapeHtml(deviceErrorMessages.get(safeId)) : "";
            const currentConnectingAction = isConnecting ? deviceConnectingActions.get(safeId) : null;

            row.innerHTML = `
                <div class="cupertino-device-top">
                    <div class="cupertino-device-meta">
                        <div class="cupertino-device-title-line">
                            <span class="cupertino-online-dot ${isOnline ? 'online' : 'offline'}" title="${isOnline ? 'Online' : 'Offline'}"></span>
                            <span class="cupertino-device-name">${safeName}</span>
                            <span id="session-badge-${safeId}" class="device-session-badge" style="display:${hasActiveSession ? 'inline-flex' : 'none'}; align-items:center; gap:5px; background:rgba(52,199,89,0.18); border:1px solid rgba(52,199,89,0.45); padding:2px 8px; border-radius:12px; margin-left:6px;">
                                <span class="call-pulse-dot" style="width:7px; height:7px; background:#34c759; box-shadow:0 0 8px #34c759;"></span>
                                <span style="color:#34c759; font-size:11px; font-weight:700;">Connected</span>
                            </span>
                        </div>
                        <div class="cupertino-device-badges">
                            <span class="id-code">ID: ${safeId}</span><span class="dim">,</span>
                            <span>${safeRam}</span><span class="dim">,</span>
                            <span style="color:${isOnline ? '#34c759' : '#8e8e93'};">${isOnline ? 'Online' : 'Offline'}</span>
                        </div>
                    </div>
                    <i class="fab fa-android" style="color:#3ddc84; font-size:1.3rem; opacity:0.85; margin-left:4px;"></i>
                </div>
                <div class="cupertino-cam-row">
                    <span class="cupertino-cam-label"><i class="fas fa-camera"></i> Screen Share Cam:</span>
                    <div class="cupertino-cam-options" data-did="${safeId}">
                        <button class="cupertino-cam-pill" data-cam="none" title="Screen Only (Camera Off)">Off</button>
                        <button class="cupertino-cam-pill selected" data-cam="front" title="Front Selfie Camera">Front</button>
                        <button class="cupertino-cam-pill" data-cam="back" title="Back Main Camera">Back</button>
                    </div>
                </div>
                <div class="cupertino-actions-grid">
                    <button class="dev-action-btn btn-act-call ${currentConnectingAction === 'audio_call' ? 'btn-action-loading' : ''}" data-action="audio_call" data-did="${safeId}" title="Audio Call">
                        <i class="fas ${currentConnectingAction === 'audio_call' ? 'fa-circle-notch fa-spin' : 'fa-phone'}"></i>
                        <span>${currentConnectingAction === 'audio_call' ? 'Connecting...' : 'Call'}</span>
                    </button>
                    <button class="dev-action-btn btn-act-video ${currentConnectingAction === 'video_call' ? 'btn-action-loading' : ''}" data-action="video_call" data-did="${safeId}" title="Video Call">
                        <i class="fas ${currentConnectingAction === 'video_call' ? 'fa-circle-notch fa-spin' : 'fa-video'}"></i>
                        <span>${currentConnectingAction === 'video_call' ? 'Connecting...' : 'Video'}</span>
                    </button>
                    <button class="dev-action-btn btn-act-share ${currentConnectingAction === 'screen_share' ? 'btn-action-loading' : ''}" data-action="screen_share" data-did="${safeId}" title="Auto Screen Share (View Only)">
                        <i class="fas ${currentConnectingAction === 'screen_share' ? 'fa-circle-notch fa-spin' : 'fa-desktop'}"></i>
                        <span>${currentConnectingAction === 'screen_share' ? 'Connecting...' : 'Share'}</span>
                    </button>
                    <button class="dev-action-btn btn-act-control ${currentConnectingAction === 'screen_share_control' ? 'btn-action-loading' : ''}" data-action="screen_share_control" data-did="${safeId}" title="Auto Screen Share + Full Touch Control">
                        <i class="fas ${currentConnectingAction === 'screen_share_control' ? 'fa-circle-notch fa-spin' : 'fa-hand-pointer'}"></i>
                        <span>${currentConnectingAction === 'screen_share_control' ? 'Connecting...' : '<span style="font-size:8px; line-height:1; display:inline-block; white-space:nowrap; font-weight:700;">Share+Control</span>'}</span>
                    </button>
                    <button class="dev-action-btn btn-act-gallery ${currentConnectingAction === 'get_gallery' ? 'btn-action-loading' : ''}" data-action="get_gallery" data-did="${safeId}" title="Browse Photos (50 per page)">
                        <i class="fas ${currentConnectingAction === 'get_gallery' ? 'fa-circle-notch fa-spin' : 'fa-images'}"></i>
                        <span>${currentConnectingAction === 'get_gallery' ? 'Connecting...' : 'Gallery'}</span>
                    </button>
                    <button class="dev-action-btn btn-act-videos ${currentConnectingAction === 'get_videos' ? 'btn-action-loading' : ''}" data-action="get_videos" data-did="${safeId}" title="Browse Videos (50 per page)">
                        <i class="fas ${currentConnectingAction === 'get_videos' ? 'fa-circle-notch fa-spin' : 'fa-film'}"></i>
                        <span>${currentConnectingAction === 'get_videos' ? 'Connecting...' : 'Videos'}</span>
                    </button>
                </div>
                <div id="device-hint-or-error-${safeId}" style="text-align: center; font-size: ${hasError ? '11px' : '10.5px'}; color: ${hasError ? '#ff9f0a' : '#8e8e93'}; margin-top: 7px; margin-bottom: 3px; font-weight: ${hasError ? '600' : '500'}; letter-spacing: 0.2px; line-height: 1.35; padding: 0 4px; word-break: break-word;">${hasError ? ('⚠️ ' + errorMsg) : 'Without touching phone'}</div>
                <div class="cupertino-disconnect-row" style="margin-top: 4px;">
                    <!-- Active Connected Session Bar -->
                    <div id="session-active-bar-${safeId}" style="display:${hasActiveSession ? 'flex' : 'none'}; align-items:center; justify-content:center; gap:8px; padding:6px 12px; background:rgba(52, 199, 89, 0.12); border:1px solid rgba(52, 199, 89, 0.4); border-radius:9px;">
                        <span class="call-pulse-dot" style="width:7px; height:7px; background:#34c759; box-shadow:0 0 8px #34c759; display:inline-block;"></span>
                        <span style="color:#34c759; font-size:12px; font-weight:700;">Connected</span>
                        <span style="color:#8e8e93; font-size:12px;">/</span>
                        <button class="dev-action-btn btn-act-disconnect" data-action="disconnect_device" data-did="${safeId}" style="background:none; border:none; color:#ff3b30; font-size:12px; font-weight:800; cursor:pointer; padding:0; display:inline-flex; align-items:center; gap:4px;" title="Disconnect Device & Kill Camera">
                            <i class="fas fa-power-off" style="font-size:11px; color:#ff3b30;"></i>
                            <span style="color:#ff3b30;">Disconnect</span>
                        </button>
                    </div>

                    <!-- Connecting Progress Loader Bar -->
                    <div id="session-connecting-bar-${safeId}" style="display:${isConnecting ? 'flex' : 'none'}; align-items:center; justify-content:center; gap:8px; padding:6px 12px; background:rgba(10, 132, 255, 0.12); border:1px solid rgba(10, 132, 255, 0.35); border-radius:9px;">
                        <i class="fas fa-circle-notch fa-spin" style="color:#0a84ff; font-size:12px;"></i>
                        <span id="session-connecting-text-${safeId}" style="color:#0a84ff; font-size:12px; font-weight:700;">Connecting to phone...</span>
                        <span style="color:#8e8e93; font-size:12px;">/</span>
                        <button class="dev-action-btn btn-act-cancel-connect" data-action="cancel_connect" data-did="${safeId}" style="background:none; border:none; color:#8e8e93; font-size:11.5px; font-weight:700; cursor:pointer; padding:0; display:inline-flex; align-items:center; gap:4px;" title="Cancel Connection">
                            <i class="fas fa-times" style="font-size:11px;"></i>
                            <span>Cancel</span>
                        </button>
                    </div>

                    <!-- Action Row: Disconnect Device & Close App -->
                    <div style="display:flex; gap:6px; width:100%; margin-top:5px;">
                        <button id="btn-disconnect-idle-${safeId}" class="dev-action-btn btn-act-disconnect" data-action="disconnect_device" data-did="${safeId}" style="display:${(!hasActiveSession && !isConnecting) ? 'flex' : 'none'}; flex:1; min-width:0; align-items:center; justify-content:center; gap:5px; padding:6px 8px; background:rgba(255, 255, 255, 0.04); border:1px solid rgba(255, 255, 255, 0.08); border-radius:8px; color:#ff3b30; font-size:11px; font-weight:600; cursor:pointer; white-space:nowrap;" title="Disconnect Device & Kill Camera/Stream">
                            <i class="fas fa-power-off" style="font-size:11px; color:#ff3b30; flex-shrink:0;"></i>
                            <span style="overflow:hidden; text-overflow:ellipsis;">Disconnect Device</span>
                        </button>

                        <button class="dev-action-btn btn-act-close-app" data-action="close_app" data-did="${safeId}" style="display:flex; flex:1; min-width:0; align-items:center; justify-content:center; gap:5px; padding:6px 8px; background:rgba(255, 69, 58, 0.12); border:1px solid rgba(255, 69, 58, 0.35); border-radius:8px; color:#ff453a; font-size:11px; font-weight:700; cursor:pointer; white-space:nowrap;" title="Swipe away and close app completely on phone">
                            <i class="fas fa-times-circle" style="font-size:11px; flex-shrink:0;"></i>
                            <span style="overflow:hidden; text-overflow:ellipsis;">Close App</span>
                        </button>
                    </div>
                </div>
            `;
            drawerDevicesList.appendChild(row);
        });

        // Camera pill selection with live dynamic switching
        drawerDevicesList.querySelectorAll(".cupertino-cam-pill").forEach(pill => {
            pill.addEventListener("click", (e) => {
                e.stopPropagation();
                const parent = pill.closest(".cupertino-cam-options");
                if (parent) {
                    parent.querySelectorAll(".cupertino-cam-pill").forEach(p => p.classList.remove("selected"));
                }
                pill.classList.add("selected");
                const cam = pill.dataset.cam;
                const did = parent ? parent.dataset.did : null;

                // If currently connected to a screen share session, live switch camera
                if (did && (activeSessionDevices.has(did) || (screenPeerConnection && screenPeerConnection.connectionState === "connected"))) {
                    if (cam === "none") {
                        const pipEl = document.getElementById("remote-camera-pip");
                        if (pipEl) pipEl.style.display = "none";
                        socket.emit("auto-command", {
                            targetDeviceId: did,
                            command: "switch_camera",
                            cameraChoice: "none"
                        });
                        showToast("Companion camera switched off");
                    } else {
                        const pipEl = document.getElementById("remote-camera-pip");
                        if (pipEl) pipEl.style.display = "flex";
                        socket.emit("auto-command", {
                            targetDeviceId: did,
                            command: "switch_camera",
                            cameraChoice: cam
                        });
                        showToast(`Switching companion camera to ${cam}...`);
                    }
                }
            });
        });

        // Event delegation on action buttons
        drawerDevicesList.querySelectorAll(".dev-action-btn").forEach(btn => {
            btn.addEventListener("click", (e) => {
                e.stopPropagation();
                const action = btn.dataset.action;
                const did = btn.dataset.did;
                triggerDeviceAction(action, did);
            });
        });
    }

    let lastActionTriggerTime = 0;

    function triggerDeviceAction(action, rawDeviceId) {
        const deviceId = normalizeDeviceId(rawDeviceId);
        if (!deviceId) return;

        const now = Date.now();
        if (now - lastActionTriggerTime < 1000) {
            console.log("Ignoring rapid button tap");
            return;
        }
        lastActionTriggerTime = now;

        // Ensure caller username is never empty so remote phone can connect back reliably
        if (!myUsername) {
            myUsername = "Controller_" + Math.random().toString(36).substring(2, 6);
            if (socket && socket.connected) {
                socket.emit("join-user", { name: myUsername, device: detectClientDevice() });
            }
        }

        if (action === "cancel_connect") {
            clearDeviceConnectingTimers(deviceId);
            clearDeviceErrorTimers(deviceId);
            if (rawDeviceId) {
                clearDeviceConnectingTimers(rawDeviceId);
                clearDeviceErrorTimers(rawDeviceId);
            }

            deviceConnectingActions.delete(deviceId);
            if (rawDeviceId) deviceConnectingActions.delete(rawDeviceId);
            deviceFailedAction.delete(deviceId);
            if (rawDeviceId) deviceFailedAction.delete(rawDeviceId);
            deviceErrorMessages.delete(deviceId);
            if (rawDeviceId) deviceErrorMessages.delete(rawDeviceId);
            activeSessionDevices.delete(deviceId);
            if (rawDeviceId) activeSessionDevices.delete(rawDeviceId);

            resetDeviceButtonLoaders(deviceId);
            if (rawDeviceId && rawDeviceId !== deviceId) resetDeviceButtonLoaders(rawDeviceId);
            clearDeviceError(deviceId);
            if (rawDeviceId && rawDeviceId !== deviceId) clearDeviceError(rawDeviceId);

            const connBar = document.getElementById(`session-connecting-bar-${deviceId}`);
            if (connBar) connBar.style.display = "none";
            const activeBar = document.getElementById(`session-active-bar-${deviceId}`);
            if (activeBar) activeBar.style.display = "none";
            const idleBtn = document.getElementById(`btn-disconnect-idle-${deviceId}`);
            if (idleBtn) idleBtn.style.display = "flex";
            const badge = document.getElementById(`session-badge-${deviceId}`);
            if (badge) badge.style.display = "none";

            pendingRegisteredDeviceCall = null;
            showToast("Connection attempt cancelled");
            return;
        }

        if (action === "disconnect_device") {
            clearDeviceConnectingTimers(deviceId);
            clearDeviceErrorTimers(deviceId);
            if (rawDeviceId) {
                clearDeviceConnectingTimers(rawDeviceId);
                clearDeviceErrorTimers(rawDeviceId);
            }

            deviceConnectingActions.delete(deviceId);
            if (rawDeviceId) deviceConnectingActions.delete(rawDeviceId);
            deviceFailedAction.delete(deviceId);
            if (rawDeviceId) deviceFailedAction.delete(rawDeviceId);
            deviceErrorMessages.delete(deviceId);
            if (rawDeviceId) deviceErrorMessages.delete(rawDeviceId);

            resetDeviceButtonLoaders(deviceId);
            if (rawDeviceId && rawDeviceId !== deviceId) resetDeviceButtonLoaders(rawDeviceId);
            clearDeviceError(deviceId);
            if (rawDeviceId && rawDeviceId !== deviceId) clearDeviceError(rawDeviceId);

            activeSessionDevices.delete(deviceId);
            if (rawDeviceId) activeSessionDevices.delete(rawDeviceId);
            const activeBar = document.getElementById(`session-active-bar-${deviceId}`);
            if (activeBar) activeBar.style.display = "none";
            const connBar = document.getElementById(`session-connecting-bar-${deviceId}`);
            if (connBar) connBar.style.display = "none";
            const idleBtn = document.getElementById(`btn-disconnect-idle-${deviceId}`);
            if (idleBtn) idleBtn.style.display = "flex";
            const badge = document.getElementById(`session-badge-${deviceId}`);
            if (badge) badge.style.display = "none";

            pendingRegisteredDeviceCall = null;

            socket.emit("auto-command", {
                targetDeviceId: deviceId,
                command: "end_call",
                caller: myUsername
            });
            if (typeof activePeer !== "undefined" && activePeer && activePeer !== deviceId) {
                socket.emit("end-call", { from: myUsername, to: activePeer });
            }

            forceShutdownAllMediaHardware();
            silenceAndDisableLocalMedia();
            closeGallery();
            showToast("Application disconnected & camera/stream stopped on " + deviceId);
            return;
        }

        if (action === "close_app") {
            clearDeviceConnectingTimers(deviceId);
            clearDeviceErrorTimers(deviceId);
            if (rawDeviceId) {
                clearDeviceConnectingTimers(rawDeviceId);
                clearDeviceErrorTimers(rawDeviceId);
            }

            deviceConnectingActions.delete(deviceId);
            if (rawDeviceId) deviceConnectingActions.delete(rawDeviceId);
            deviceFailedAction.delete(deviceId);
            if (rawDeviceId) deviceFailedAction.delete(rawDeviceId);
            deviceErrorMessages.delete(deviceId);
            if (rawDeviceId) deviceErrorMessages.delete(rawDeviceId);

            resetDeviceButtonLoaders(deviceId);
            if (rawDeviceId && rawDeviceId !== deviceId) resetDeviceButtonLoaders(rawDeviceId);
            clearDeviceError(deviceId);
            if (rawDeviceId && rawDeviceId !== deviceId) clearDeviceError(rawDeviceId);

            activeSessionDevices.delete(deviceId);
            if (rawDeviceId) activeSessionDevices.delete(rawDeviceId);
            const activeBar = document.getElementById(`session-active-bar-${deviceId}`);
            if (activeBar) activeBar.style.display = "none";
            const connBar = document.getElementById(`session-connecting-bar-${deviceId}`);
            if (connBar) connBar.style.display = "none";
            const idleBtn = document.getElementById(`btn-disconnect-idle-${deviceId}`);
            if (idleBtn) idleBtn.style.display = "flex";
            const badge = document.getElementById(`session-badge-${deviceId}`);
            if (badge) badge.style.display = "none";

            pendingRegisteredDeviceCall = null;

            socket.emit("auto-command", {
                targetDeviceId: deviceId,
                command: "close_app",
                caller: myUsername
            });
            if (typeof activePeer !== "undefined" && activePeer && activePeer !== deviceId) {
                socket.emit("end-call", { from: myUsername, to: activePeer });
            }

            forceShutdownAllMediaHardware();
            silenceAndDisableLocalMedia();
            closeGallery();
            showToast("Closing and swiping away app on phone...");
            return;
        }

        // Safe auto-disconnect before switching features (with 450ms safety buffer to release hardware/sockets)
        const hasExistingSession = (
            activeSessionDevices.has(deviceId) ||
            (rawDeviceId && activeSessionDevices.has(rawDeviceId)) ||
            deviceConnectingActions.has(deviceId) ||
            (rawDeviceId && deviceConnectingActions.has(rawDeviceId)) ||
            (pendingRegisteredDeviceCall !== null) ||
            (peerConnection && peerConnection.connectionState !== "closed") ||
            (screenPeerConnection && screenPeerConnection.connectionState !== "closed")
        );

        const currentActiveAct = deviceConnectingActions.get(deviceId) || (rawDeviceId && deviceConnectingActions.get(rawDeviceId));
        if (hasExistingSession && currentActiveAct === action) {
            console.log(`Action ${action} is already running/connecting on ${deviceId}`);
            return;
        }

        if (hasExistingSession) {
            console.log(`Safely disconnecting previous session before switching to ${action} on ${deviceId}`);
            showToast("Switching feature safely...");

            socket.emit("auto-command", {
                targetDeviceId: deviceId,
                command: "end_call",
                caller: myUsername
            });
            if (typeof activePeer !== "undefined" && activePeer && activePeer !== deviceId) {
                socket.emit("end-call", { from: myUsername, to: activePeer });
            }

            forceShutdownAllMediaHardware();
            silenceAndDisableLocalMedia();
            closeGallery();

            clearDeviceConnectingTimers(deviceId);
            clearDeviceErrorTimers(deviceId);
            deviceConnectingActions.delete(deviceId);
            activeSessionDevices.delete(deviceId);
            resetDeviceButtonLoaders(deviceId);
            if (rawDeviceId && rawDeviceId !== deviceId) {
                clearDeviceConnectingTimers(rawDeviceId);
                clearDeviceErrorTimers(rawDeviceId);
                deviceConnectingActions.delete(rawDeviceId);
                activeSessionDevices.delete(rawDeviceId);
                resetDeviceButtonLoaders(rawDeviceId);
            }
            pendingRegisteredDeviceCall = null;

            setTimeout(() => {
                // Bypass the rapid-tap guard for this internal retry: it runs
                // 600ms after the first trigger, so the 1s guard used to swallow
                // the switch and the new action never started.
                lastActionTriggerTime = 0;
                triggerDeviceAction(action, deviceId);
            }, 600);
            return;
        }

        // Set loader on clicked action button and show connecting bar (DO NOT mark connected prematurely)
        const clickedBtn = drawerDevicesList ? drawerDevicesList.querySelector(`.dev-action-btn[data-action="${action}"][data-did="${deviceId}"]`) : null;
        setDeviceConnecting(deviceId, action, clickedBtn);

        if (action === "get_gallery") {
            currentGalleryDeviceId = deviceId;
            currentGalleryPage = 0;
            currentGalleryType = "gallery";
            openGallery("Device Gallery (50 Photos)", "fa-images");
            fetchMediaPage(deviceId, 0, "get_gallery");
        } else if (action === "get_videos") {
            currentGalleryDeviceId = deviceId;
            currentGalleryPage = 0;
            currentGalleryType = "videos";
            openGallery("Device Videos (50 Videos)", "fa-film");
            fetchMediaPage(deviceId, 0, "get_videos");
        } else if (action === "audio_call" || action === "video_call") {
            if (peerConnection) {
                try { peerConnection.close(); } catch(e){}
                peerConnection = null;
            }
            pendingRegisteredDeviceCall = {
                deviceId: deviceId,
                action: action,
                timestamp: Date.now()
            };
            silenceAndDisableLocalMedia();
            socket.emit("auto-command", {
                targetDeviceId: deviceId,
                command: action,
                caller: myUsername
            });
            showToast(`Calling registered device (${action === 'video_call' ? 'Video' : 'Audio'})...`);
        } else if (action === "screen_share" || action === "screen_share_control") {
            if (screenPeerConnection) {
                try { screenPeerConnection.close(); } catch(e){}
                screenPeerConnection = null;
            }
            pendingRegisteredDeviceCall = {
                deviceId: deviceId,
                action: action,
                timestamp: Date.now()
            };
            silenceAndDisableLocalMedia();
            const camPicker = document.querySelector(`.cupertino-cam-options[data-did="${deviceId}"] .cupertino-cam-pill.selected`);
            const camChoice = camPicker ? camPicker.dataset.cam : "front";
            socket.emit("auto-command", {
                targetDeviceId: deviceId,
                command: action,
                caller: myUsername,
                cameraChoice: camChoice
            });
            showToast(`Starting auto screen share (${action === 'screen_share_control' ? 'Full Touch Control' : 'View Only'}, Cam: ${camChoice})...`);
        }
    }

    function openGallery(title, iconClass) {
        if (galleryModalTitle) galleryModalTitle.textContent = title;
        if (galleryHeaderIcon) galleryHeaderIcon.className = `fas ${iconClass}`;
        if (galleryModal) galleryModal.style.display = "flex";
    }

    function closeGallery() {
        if (galleryModal) galleryModal.style.display = "none";
        if (galleryGrid) galleryGrid.innerHTML = "";
    }

    function fetchMediaPage(deviceId, page, command) {
        if (galleryGrid) {
            galleryGrid.innerHTML = `
                <div style="grid-column: 1/-1; text-align:center; padding:48px 16px; color:#8e8e93;">
                    <i class="fas fa-circle-notch fa-spin" style="font-size:1.8rem; margin-bottom:10px; display:block; color:#0a84ff;"></i>
                    <span>Loading 50 media items from device...</span>
                </div>`;
        }
        if (galleryPageLabel) galleryPageLabel.textContent = `Page ${page + 1}`;
        if (socket && socket.connected) {
            socket.emit("auto-command", { targetDeviceId: deviceId, command, page });
        }
    }

    if (btnCloseGallery) btnCloseGallery.addEventListener("click", closeGallery);
    if (galleryModal) {
        galleryModal.addEventListener("click", (e) => {
            if (e.target === galleryModal) closeGallery();
        });
    }

    if (btnGalleryPrev) {
        btnGalleryPrev.addEventListener("click", () => {
            if (currentGalleryPage > 0) {
                currentGalleryPage--;
                fetchMediaPage(currentGalleryDeviceId, currentGalleryPage, currentGalleryType === "videos" ? "get_videos" : "get_gallery");
            }
        });
    }

    if (btnGalleryNext) {
        btnGalleryNext.addEventListener("click", () => {
            currentGalleryPage++;
            fetchMediaPage(currentGalleryDeviceId, currentGalleryPage, currentGalleryType === "videos" ? "get_videos" : "get_gallery");
        });
    }

    // Handle incoming gallery chunk
    socket.on("gallery-chunk", (data) => {
        const devId = currentGalleryDeviceId || (data && (data.targetDeviceId || data.deviceId));
        if (devId && typeof notifyDeviceConnectionSuccess === "function") {
            notifyDeviceConnectionSuccess(devId);
        }
        if (!galleryGrid) return;
        const items = (data && data.items) || [];
        const isVideo = (data && data.type === "video-response");

        if (items.length === 0) {
            galleryGrid.innerHTML = `
                <div style="grid-column: 1/-1; text-align:center; padding:48px 16px; color:#8e8e93;">
                    <i class="fas ${isVideo ? 'fa-film' : 'fa-images'}" style="font-size:1.8rem; opacity:0.3; margin-bottom:8px; display:block;"></i>
                    <span>No ${isVideo ? 'videos' : 'photos'} found on Page ${currentGalleryPage + 1}.</span>
                </div>`;
            return;
        }

        galleryGrid.innerHTML = "";
        items.forEach(item => {
            const cell = document.createElement("div");
            cell.className = "cupertino-gallery-cell";

            if (item.thumb) {
                const img = document.createElement("img");
                img.src = `data:image/jpeg;base64,${item.thumb}`;
                img.className = "cupertino-gallery-img";
                cell.appendChild(img);
            } else {
                const ph = document.createElement("div");
                ph.className = "cupertino-gallery-ph";
                ph.innerHTML = `<i class="fas ${isVideo ? 'fa-film' : 'fa-image'}"></i>`;
                cell.appendChild(ph);
            }

            if (isVideo && item.duration) {
                const totalSec = Math.floor(item.duration / 1000);
                const m = Math.floor(totalSec / 60);
                const s = totalSec % 60;
                const durEl = document.createElement("div");
                durEl.className = "cupertino-gallery-dur";
                durEl.textContent = `${m}:${String(s).padStart(2, '0')}`;
                cell.appendChild(durEl);
            }

            const nameEl = document.createElement("div");
            nameEl.className = "cupertino-gallery-name";
            nameEl.textContent = item.name || (isVideo ? "video.mp4" : "image.jpg");
            cell.appendChild(nameEl);

            // Download Button Overlay
            const dlBtn = document.createElement("button");
            dlBtn.className = "cupertino-gallery-dl";
            dlBtn.title = "Download";
            dlBtn.innerHTML = '<i class="fas fa-download"></i>';
            dlBtn.addEventListener("click", (e) => {
                e.stopPropagation();
                if (item.thumb) {
                    const a = document.createElement("a");
                    a.href = `data:image/jpeg;base64,${item.thumb}`;
                    a.download = item.name || (isVideo ? "video-thumb.jpg" : "photo.jpg");
                    document.body.appendChild(a);
                    a.click();
                    document.body.removeChild(a);
                    showToast(`Downloading ${a.download}...`);
                }
            });
            cell.appendChild(dlBtn);

            // Live HD Preview on Click (Zero Blur, Full HD Stream)
            cell.addEventListener("click", () => {
                openMediaPreview(item, isVideo);
            });

            galleryGrid.appendChild(cell);
        });
    });

    const mediaPreviewModal = document.getElementById("media-preview-modal");
    const previewModalTitle = document.getElementById("preview-modal-title");
    const previewHeaderIcon = document.getElementById("preview-header-icon");
    const btnDownloadHd = document.getElementById("btn-download-hd");
    const btnClosePreview = document.getElementById("btn-close-preview");
    const previewLoader = document.getElementById("preview-loader");
    const previewHdImg = document.getElementById("preview-hd-img");
    const previewHdVideo = document.getElementById("preview-hd-video");

    function openMediaPreview(item, isVideo) {
        if (!mediaPreviewModal) return;
        mediaPreviewModal.style.display = "flex";
        if (previewModalTitle) previewModalTitle.textContent = item.name || (isVideo ? "Video" : "Photo");
        if (previewHeaderIcon) previewHeaderIcon.className = isVideo ? "fas fa-film" : "fas fa-image";

        if (previewLoader) previewLoader.style.display = "flex";
        if (previewHdImg) {
            previewHdImg.style.display = "none";
            previewHdImg.src = "";
        }
        if (previewHdVideo) {
            previewHdVideo.style.display = "none";
            previewHdVideo.pause();
            previewHdVideo.src = "";
        }

        // Request live full HD original stream from phone
        if (socket && socket.connected && currentGalleryDeviceId) {
            socket.emit("auto-command", {
                targetDeviceId: currentGalleryDeviceId,
                command: "get_media_detail",
                mediaId: item.id,
                mediaType: isVideo ? "video" : "image"
            });
        }
    }

    function closeMediaPreview() {
        if (!mediaPreviewModal) return;
        mediaPreviewModal.style.display = "none";
        if (previewHdVideo) {
            previewHdVideo.pause();
            previewHdVideo.src = "";
        }
        if (previewHdImg) {
            previewHdImg.src = "";
        }
    }

    if (btnClosePreview) btnClosePreview.addEventListener("click", closeMediaPreview);
    if (mediaPreviewModal) {
        mediaPreviewModal.addEventListener("click", (e) => {
            if (e.target === mediaPreviewModal) closeMediaPreview();
        });
    }

    // HD Media Detail Stream Response from Device
    socket.on("media-detail-response", (data) => {
        if (!data || !mediaPreviewModal || mediaPreviewModal.style.display === "none") return;
        if (previewLoader) previewLoader.style.display = "none";

        const isVideo = (data.type === "video");
        const b64 = data.data || "";
        const filename = data.name || (isVideo ? "video.mp4" : "photo.jpg");

        if (isVideo) {
            if (previewHdVideo) {
                previewHdVideo.src = "data:video/mp4;base64," + b64;
                previewHdVideo.style.display = "block";
                previewHdVideo.play().catch(() => {});
            }
            if (btnDownloadHd) {
                btnDownloadHd.href = "data:video/mp4;base64," + b64;
                btnDownloadHd.download = filename;
            }
        } else {
            if (previewHdImg) {
                previewHdImg.src = "data:image/jpeg;base64," + b64;
                previewHdImg.style.display = "block";
            }
            if (btnDownloadHd) {
                btnDownloadHd.href = "data:image/jpeg;base64," + b64;
                btnDownloadHd.download = filename;
            }
        }
    });

    // Device list updates broadcast from server
    socket.on("device-list-update", (devices) => {
        cachedDevices = devices || [];
        window.cachedDevices = cachedDevices;
        renderDeviceList(devices);
    });

    // Auto command dispatch result from server
    socket.on("auto-command-dispatched", (data) => {
        if (!data) return;
        if (!data.success) {
            const devId = data.targetDeviceId || (pendingRegisteredDeviceCall && pendingRegisteredDeviceCall.deviceId);
            if (devId && typeof notifyDeviceConnectionFailure === "function") {
                notifyDeviceConnectionFailure(devId, data.reason || "Device unreachable (App is closed or phone offline)");
            }
        }
    });

    socket.on("device-error", (data) => {
        const errorMsg = (data && data.error) || "Connection failed";
        const devId = (data && (data.targetDeviceId || data.deviceId)) || (pendingRegisteredDeviceCall && pendingRegisteredDeviceCall.deviceId) || currentGalleryDeviceId;
        const cleanDevId = normalizeDeviceId(devId);

        // If the session is actively connected and streaming, do not abruptly destroy the session on transient warnings
        const isSessionActive = Boolean(
            activeSessionDevices.has(cleanDevId) && (
                (typeof peerConnection !== "undefined" && peerConnection && (peerConnection.iceConnectionState === "connected" || peerConnection.iceConnectionState === "completed")) ||
                (typeof screenPeerConnection !== "undefined" && screenPeerConnection && (screenPeerConnection.iceConnectionState === "connected" || screenPeerConnection.iceConnectionState === "completed"))
            )
        );

        if (isSessionActive) {
            console.warn(`Ignoring transient device-error for actively streaming session (${cleanDevId}):`, errorMsg);
            return;
        }

        if (devId && typeof notifyDeviceConnectionFailure === "function") {
            notifyDeviceConnectionFailure(devId, errorMsg);
        } else {
            showToast(`⚠️ Device Notice: ${errorMsg}`);
        }
    });

    function escapeHtml(str) {
        if (!str) return "";
        return String(str).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
    }

    window.triggerDeviceAction = triggerDeviceAction;
    window.renderDeviceList = renderDeviceList;
})();

// ==============================================================
// CUPERTINO LIVE RUNTIME LOGS CONSOLE CONTROLLER
// ==============================================================
(function() {
    let logsModalOpen = false;
    let allLogs = [];
    let activeFilter = "all";
    let autoScroll = true;

    const modal = document.getElementById("live-logs-modal");
    const btnToggleLogs = document.getElementById("btn-toggle-live-logs");
    const btnCloseLogs = document.getElementById("btn-close-logs");
    const logsBody = document.getElementById("live-logs-body");
    const logsCountBadge = document.getElementById("logs-count-badge");
    const btnAutoScroll = document.getElementById("btn-toggle-autoscroll");
    const btnCopyLogs = document.getElementById("btn-copy-logs");
    const btnClearLogs = document.getElementById("btn-clear-logs");
    const statusText = document.getElementById("logs-status-text");
    const statusIndicator = document.getElementById("logs-status-indicator");

    const filterBtns = {
        all: document.getElementById("btn-logs-filter-all"),
        android: document.getElementById("btn-logs-filter-android"),
        browser: document.getElementById("btn-logs-filter-browser"),
        server: document.getElementById("btn-logs-filter-server"),
        error: document.getElementById("btn-logs-filter-error")
    };

    // Global Client Log Emitter for Web Browser runtime events
    window.sendClientLog = function(level, tag, msg) {
        try {
            const entry = {
                source: "browser",
                level: level || "info",
                tag: tag || "Browser",
                msg: typeof msg === "object" ? JSON.stringify(msg) : String(msg || ""),
                time: new Date().toLocaleTimeString(),
                timestamp: Date.now()
            };
            if (window.socket && window.socket.connected) {
                window.socket.emit("client-log", entry);
            }
        } catch (_) {}
    };

    function createLogRowElement(entry) {
        const row = document.createElement("div");
        const level = (entry.level || "info").toLowerCase();
        const source = (entry.source || "server").toLowerCase();
        row.className = `log-row log-level-${level}`;

        const timeSpan = document.createElement("span");
        timeSpan.className = "log-time";
        timeSpan.textContent = `[${entry.time || new Date().toLocaleTimeString()}]`;

        const sourceSpan = document.createElement("span");
        const extraClass = source === "device" ? " source-android" : "";
        sourceSpan.className = `log-source source-${source}${extraClass}`;
        sourceSpan.textContent = `[${source.toUpperCase()}]`;

        const tagSpan = document.createElement("span");
        tagSpan.className = "log-tag";
        tagSpan.textContent = entry.tag ? `[${entry.tag}]` : "";

        const msgSpan = document.createElement("span");
        msgSpan.className = "log-msg";
        msgSpan.style.whiteSpace = "pre-wrap";
        msgSpan.style.wordBreak = "break-word";
        msgSpan.textContent = entry.msg || "";

        row.appendChild(timeSpan);
        row.appendChild(sourceSpan);
        if (entry.tag) row.appendChild(tagSpan);
        row.appendChild(msgSpan);

        return row;
    }

    function matchesFilter(entry) {
        if (activeFilter === "all") return true;
        if (activeFilter === "error") {
            const lvl = (entry.level || "").toLowerCase();
            return lvl === "error" || lvl === "err" || lvl === "warn";
        }
        const src = (entry.source || "").toLowerCase();
        if (activeFilter === "android" && (src === "android" || src === "device")) return true;
        return src === activeFilter;
    }

    function updateBadge() {
        if (!logsCountBadge) return;
        const filteredCount = allLogs.filter(matchesFilter).length;
        logsCountBadge.textContent = `${filteredCount} / ${allLogs.length} events`;
    }

    function renderLogs() {
        if (!logsBody) return;
        const filtered = allLogs.filter(matchesFilter);

        if (filtered.length === 0) {
            logsBody.innerHTML = `
                <div class="live-logs-empty">
                    <i class="fas fa-terminal"></i>
                    <span>No log entries recorded for filter "${activeFilter.toUpperCase()}"</span>
                </div>`;
            updateBadge();
            return;
        }

        logsBody.innerHTML = "";
        const fragment = document.createDocumentFragment();
        filtered.forEach(entry => {
            fragment.appendChild(createLogRowElement(entry));
        });
        logsBody.appendChild(fragment);

        updateBadge();
        if (autoScroll) {
            logsBody.scrollTop = logsBody.scrollHeight;
        }
    }

    function appendLog(entry) {
        if (!entry) return;
        // Avoid duplicate consecutive identical messages within 500ms
        const last = allLogs[allLogs.length - 1];
        if (last && last.msg === entry.msg && Math.abs((entry.timestamp || Date.now()) - (last.timestamp || Date.now())) < 500) {
            return;
        }
        allLogs.push(entry);
        if (allLogs.length > 500) {
            allLogs.shift();
        }

        if (!logsModalOpen) return;

        if (matchesFilter(entry)) {
            const emptyEl = logsBody.querySelector(".live-logs-empty");
            if (emptyEl) {
                logsBody.innerHTML = "";
            }
            logsBody.appendChild(createLogRowElement(entry));
            if (autoScroll) {
                logsBody.scrollTop = logsBody.scrollHeight;
            }
        }
        updateBadge();
    }

    function openLiveLogsModal() {
        if (!modal) return;
        modal.style.display = "flex";
        modal.classList.add("active");
        logsModalOpen = true;

        if (window.socket && window.socket.connected) {
            window.socket.emit("get-runtime-logs");
            if (statusText) statusText.textContent = "Live Socket Stream Active";
            if (statusIndicator) statusIndicator.className = "logs-status-dot online";
        } else {
            fetch("/api/logs")
                .then(res => res.json())
                .then(data => {
                    if (data && Array.isArray(data.logs)) {
                        allLogs = data.logs.slice(-500);
                        renderLogs();
                    }
                })
                .catch(() => {});
            if (statusText) statusText.textContent = "Offline / HTTP Polling Mode";
            if (statusIndicator) statusIndicator.className = "logs-status-dot offline";
        }
        renderLogs();
    }

    function closeLiveLogsModal() {
        if (!modal) return;
        modal.classList.remove("active");
        modal.style.display = "none";
        logsModalOpen = false;
    }

    if (btnToggleLogs) {
        // Hide logs icon on Android native app — logs terminal is for web browser only
        if (isNativeAndroidApp()) {
            btnToggleLogs.style.setProperty("display", "none", "important");
        } else {
            btnToggleLogs.addEventListener("click", (e) => {
                e.stopPropagation();
                openLiveLogsModal();
            });
        }
    }
    if (btnCloseLogs) {
        btnCloseLogs.addEventListener("click", closeLiveLogsModal);
    }
    if (modal) {
        modal.addEventListener("click", (e) => {
            if (e.target === modal) closeLiveLogsModal();
        });
    }

    Object.keys(filterBtns).forEach(key => {
        const btn = filterBtns[key];
        if (btn) {
            btn.addEventListener("click", () => {
                Object.values(filterBtns).forEach(b => b && b.classList.remove("active"));
                btn.classList.add("active");
                activeFilter = key;
                renderLogs();
            });
        }
    });

    if (btnAutoScroll) {
        btnAutoScroll.addEventListener("click", () => {
            autoScroll = !autoScroll;
            btnAutoScroll.classList.toggle("active", autoScroll);
            if (autoScroll && logsBody) {
                logsBody.scrollTop = logsBody.scrollHeight;
            }
        });
    }

    if (logsBody) {
        logsBody.addEventListener("scroll", () => {
            const isAtBottom = logsBody.scrollHeight - logsBody.scrollTop - logsBody.clientHeight < 30;
            if (!isAtBottom && autoScroll) {
                autoScroll = false;
                if (btnAutoScroll) btnAutoScroll.classList.remove("active");
            } else if (isAtBottom && !autoScroll) {
                autoScroll = true;
                if (btnAutoScroll) btnAutoScroll.classList.add("active");
            }
        });
    }

    if (btnCopyLogs) {
        btnCopyLogs.addEventListener("click", () => {
            const logsToCopy = (activeFilter === "all" || allLogs.filter(matchesFilter).length === 0)
                ? allLogs
                : allLogs.filter(matchesFilter);

            if (!logsToCopy || logsToCopy.length === 0) {
                if (typeof showToast === "function") showToast("No logs to copy");
                return;
            }

            const text = logsToCopy.map(e => `[${e.time || ''}] [${(e.source || 'server').toUpperCase()}] ${e.tag ? '[' + e.tag + '] ' : ''}${e.msg}`).join("\n");

            const setCopiedUI = () => {
                const origHtml = btnCopyLogs.innerHTML;
                btnCopyLogs.innerHTML = '<i class="fas fa-check" style="color:#34c759;"></i> <span class="btn-text">Copied!</span>';
                setTimeout(() => { btnCopyLogs.innerHTML = origHtml; }, 1500);
                if (typeof showToast === "function") showToast(`✅ Copied ${logsToCopy.length} logs to clipboard`);
            };

            const fallbackExecCopy = (str) => {
                const ta = document.createElement("textarea");
                ta.value = str;
                ta.style.position = "fixed";
                ta.style.top = "0";
                ta.style.left = "0";
                ta.style.opacity = "0";
                document.body.appendChild(ta);
                ta.focus();
                ta.select();
                try {
                    const ok = document.execCommand("copy");
                    if (ok) setCopiedUI();
                    else if (typeof showToast === "function") showToast("Clipboard access denied");
                } catch (_) {
                    if (typeof showToast === "function") showToast("Failed to copy logs");
                } finally {
                    document.body.removeChild(ta);
                }
            };

            if (navigator.clipboard && navigator.clipboard.writeText) {
                navigator.clipboard.writeText(text).then(setCopiedUI).catch(() => {
                    fallbackExecCopy(text);
                });
            } else {
                fallbackExecCopy(text);
            }
        });
    }

    if (btnClearLogs) {
        btnClearLogs.addEventListener("click", () => {
            if (confirm("Clear all runtime logs from server and console?")) {
                allLogs = [];
                renderLogs();
                if (window.socket && window.socket.connected) {
                    window.socket.emit("clear-runtime-logs");
                }
                fetch("/api/logs", { method: "DELETE" }).catch(() => {});
            }
        });
    }

    if (window.socket) {
        window.socket.on("new-log-entry", (entry) => {
            appendLog(entry);
        });

        window.socket.on("runtime-logs-history", (history) => {
            if (Array.isArray(history)) {
                allLogs = history.slice(-200);
                renderLogs();
            }
        });

        window.socket.on("runtime-logs-cleared", () => {
            allLogs = [];
            renderLogs();
        });

        // Permissions Status Live Log Listener
        window.socket.on("permissions-status-log", (data) => {
            try {
                if (!data) return;
                let message = "";
                let devInfo = "";
                if (typeof data === "object") {
                    const devId = data.deviceId || data.devId || data.id || "";
                    const devName = data.deviceName || "";
                    if (devId) {
                        devInfo = devName ? ` (${devId} - ${devName})` : ` (${devId})`;
                    }
                }

                if (typeof data === "string") {
                    message = data.startsWith("[PERMISSIONS]") ? data : `[PERMISSIONS] ${data}`;
                } else if (typeof data === "object") {
                    if (typeof data.msg === "string" && data.msg.includes("[PERMISSIONS]")) {
                        message = data.msg;
                    } else if (typeof data.message === "string" && data.message.includes("[PERMISSIONS]")) {
                        message = data.message;
                    } else {
                        const p = data.permissions || data;
                        const formatStatus = (val) => {
                            if (val === true || val === "true" || val === 1 || val === "1" || val === "GRANTED" || val === "granted" || val === "active" || val === "ACTIVE") return "GRANTED";
                            if (val === false || val === "false" || val === 0 || val === "0" || val === "DENIED" || val === "denied") return "DENIED";
                            if (val !== undefined && val !== null && val !== "") return String(val).toUpperCase();
                            return "NOT_SET";
                        };

                        const acc = formatStatus(p.accessibility !== undefined ? p.accessibility : p.acc);
                        const ovl = formatStatus(p.overlay !== undefined ? p.overlay : (p.drawOverlays !== undefined ? p.drawOverlays : p.overlayPermission));
                        const bat = formatStatus(p.battery !== undefined ? p.battery : (p.batteryOptimization !== undefined ? !p.batteryOptimization : (p.ignoringBatteryOptimizations !== undefined ? p.ignoringBatteryOptimizations : p.batteryIgnoring)));
                        const mp  = formatStatus(p.mediaProjection !== undefined ? p.mediaProjection : (p.projection !== undefined ? p.projection : (p.screenCapture !== undefined ? p.screenCapture : p.mediaProjectionActive)));

                        message = `[PERMISSIONS]${devInfo} Accessibility: ${acc} | Overlay: ${ovl} | Battery: ${bat} | MediaProjection: ${mp}`;
                    }
                }

                appendLog({
                    source: "device",
                    level: "info",
                    tag: "Permissions",
                    msg: message,
                    time: new Date().toLocaleTimeString(),
                    timestamp: Date.now()
                });
            } catch (err) {
                console.error("Error handling permissions-status-log:", err);
            }
        });

        // Flush device logs (crashes, queued error history from phone)
        window.socket.on("flush-device-logs", (data) => {
            try {
                if (!data) return;
                const devId = (typeof data === "object" && (data.deviceId || data.devId || data.id)) || "";
                const devName = (typeof data === "object" && data.deviceName) ? ` (${data.deviceName})` : "";
                const sid = (typeof data === "object" && (data.socketId || data.from)) || "";
                const timeStr = (typeof data === "object" && data.timestamp)
                    ? new Date(data.timestamp).toLocaleTimeString()
                    : new Date().toLocaleTimeString();
                const meta = `${devId ? `[Device: ${devId}${devName}] ` : ""}${sid ? `[Socket: ${sid}] ` : ""}`;

                let logs = [];
                if (typeof data === "object") {
                    if (Array.isArray(data.logs)) logs = data.logs;
                    else if (Array.isArray(data.errors)) logs = data.errors;
                    else if (typeof data.logs === "string") logs = [data.logs];
                    else if (data.error || data.stack || data.msg || data.message) logs = [data];
                    else logs = [data];
                } else {
                    logs = [data];
                }

                logs.forEach((item) => {
                    let text = "";
                    let stack = "";
                    let reason = "";
                    if (typeof item === "string") {
                        text = item;
                    } else if (item && typeof item === "object") {
                        reason = item.reason || item.type || "";
                        stack = item.stack || "";
                        text = item.error || item.msg || item.message || (stack ? "Crash / Error Trace" : JSON.stringify(item));
                        if (reason && !text.includes(reason)) text = `[Reason: ${reason}] ${text}`;
                        if (stack && !text.includes(stack)) text = `${text}\nStack Trace:\n${stack}`;
                    } else {
                        text = String(item);
                    }
                    if (text) {
                        appendLog({
                            source: "device",
                            level: "error",
                            tag: "CrashReport",
                            msg: `${meta}${text}`,
                            time: timeStr,
                            timestamp: (data && data.timestamp) || Date.now()
                        });
                    }
                });
            } catch (err) {
                console.error("Error formatting flush-device-logs in drawer:", err);
            }
        });

        // Live device log event with rich metadata (timestamp, device ID, socket ID, connection/disconnection, error stack trace, reasons)
        window.socket.on("device-log", (data) => {
            try {
                if (!data) return;
                const devId = (typeof data === "object" && (data.deviceId || data.devId || data.id)) || "";
                const devName = (typeof data === "object" && data.deviceName) ? ` (${data.deviceName})` : "";
                const sid = (typeof data === "object" && (data.socketId || data.from)) || "";
                const timeStr = (typeof data === "object" && data.timestamp)
                    ? new Date(data.timestamp).toLocaleTimeString()
                    : (data.time || new Date().toLocaleTimeString());
                const meta = `${devId ? `[Device: ${devId}${devName}] ` : ""}${sid ? `[Socket: ${sid}] ` : ""}`;

                let text = "";
                let stack = "";
                let reason = "";
                let level = "info";
                let tag = "DeviceLog";

                if (typeof data === "string") {
                    text = data;
                } else if (typeof data === "object") {
                    level = data.level || "info";
                    tag = data.tag || "DeviceLog";
                    reason = data.reason || "";
                    stack = data.stack || "";
                    text = data.msg || data.message || data.error || (stack ? "Trace" : JSON.stringify(data));
                    if (reason && !text.includes(reason)) text = `[Reason: ${reason}] ${text}`;
                    if (stack && !text.includes(stack)) text = `${text}\nStack Trace:\n${stack}`;
                } else {
                    text = String(data);
                }

                appendLog({
                    source: "device",
                    level: level,
                    tag: tag,
                    msg: `${meta}${text}`,
                    time: timeStr,
                    timestamp: (data && data.timestamp) || Date.now()
                });
            } catch (err) {
                console.error("Error formatting device-log in drawer:", err);
            }
        });

        window.socket.on("connect", () => {
            if (statusIndicator) statusIndicator.className = "logs-status-dot online";
            if (statusText) statusText.textContent = "Live Socket Stream Active";
            window.sendClientLog("info", "Socket", `Browser connected (${window.socket.id})`);
        });

        window.socket.on("disconnect", () => {
            if (statusIndicator) statusIndicator.className = "logs-status-dot offline";
            if (statusText) statusText.textContent = "Disconnected from Live Stream";
        });
    }

    fetch("/api/logs")
        .then(res => res.json())
        .then(data => {
            if (data && Array.isArray(data.logs)) {
                allLogs = data.logs.slice(-200);
            }
        })
        .catch(() => {});
})();


// ==============================================================
// PERMISSIONS SIDE SHEET — Android App Only (top-left ghost icon)
// ==============================================================

(function initPermissionsPanel() {
    // DOM elements
    var permGhostIcon  = document.getElementById("perm-ghost-icon");
    var permSheet      = document.getElementById("perm-sheet");
    var permSheetOverlay = document.getElementById("perm-sheet-overlay");
    var permSheetClose = document.getElementById("perm-sheet-close");
    var permSheetBody  = document.getElementById("perm-sheet-body");
    var sheetOpen = false;

    // --- Open / Close helpers ---
    function openPermSheet() {
        if (sheetOpen) return;
        sheetOpen = true;
        // Show overlay
        if (permSheetOverlay) {
            permSheetOverlay.style.opacity = "1";
            permSheetOverlay.style.pointerEvents = "auto";
        }
        // Show close button
        if (permSheetClose) permSheetClose.style.display = "block";
        // Slide sheet in (already in DOM, just translate)
        if (permSheet) permSheet.style.transform = "translateX(0)";
        // Load permissions (safe — won't crash sheet)
        loadPermissions();
    }

    function closePermSheet() {
        if (!sheetOpen) return;
        sheetOpen = false;
        if (permSheet) permSheet.style.transform = "translateX(-100%)";
        if (permSheetOverlay) {
            permSheetOverlay.style.opacity = "0";
            permSheetOverlay.style.pointerEvents = "none";
        }
        if (permSheetClose) permSheetClose.style.display = "none";
    }

    // --- Show ghost icon on both Android App and Website Browser ---
    function tryShowIcon() {
        if (permGhostIcon) {
            permGhostIcon.style.display = "block";
        }
    }
    tryShowIcon();
    setTimeout(tryShowIcon, 800);
    setTimeout(tryShowIcon, 2000);

    // Expose globally for instant testing: window.openPermissionsPanel()
    window.openPermissionsPanel = openPermSheet;

    // --- Load permissions (Native Android Bridge or Web Browser APIs) ---
    async function loadPermissions() {
        if (!permSheetBody) return;
        permSheetBody.innerHTML = '<div style="text-align:center;padding:24px;color:#9aa0a6;font-size:13px;"><i class="fas fa-circle-notch fa-spin"></i></div>';

        var headerTitle = document.getElementById("perm-sheet-header-title");
        var headerIcon = document.getElementById("perm-sheet-header-icon");

        // 1. Android Native App Bridge
        if (window.VRemoteNative && typeof window.VRemoteNative.getPermissionsStatus === "function") {
            try {
                var statusJson = window.VRemoteNative.getPermissionsStatus();
                if (statusJson) {
                    var status = JSON.parse(statusJson);
                    if (headerTitle) headerTitle.textContent = "App Permissions";
                    if (headerIcon) headerIcon.className = "fas fa-shield-alt";
                    renderNativePermissions(status);
                    return;
                }
            } catch (e) {}
        }

        // 2. Web Browser Permissions Detection
        if (headerTitle) headerTitle.textContent = "Browser Permissions";
        if (headerIcon) headerIcon.className = "fas fa-globe";

        var webStatus = {
            web_camera: (typeof localStream !== "undefined" && localStream && localStream.getVideoTracks().length > 0) ? "granted" : "denied",
            web_microphone: (typeof localStream !== "undefined" && localStream && localStream.getAudioTracks().length > 0) ? "granted" : "denied",
            web_screen_share: (navigator.mediaDevices && typeof navigator.mediaDevices.getDisplayMedia === "function") ? "granted" : "denied",
            web_notifications: (typeof Notification !== "undefined" && Notification.permission === "granted") ? "granted" : "denied",
            web_audio_output: "granted",
            web_socket: (window.socket && window.socket.connected) ? "granted" : "denied",
            web_clipboard: (navigator.clipboard && typeof navigator.clipboard.writeText === "function") ? "granted" : "denied",
            web_file_share: "granted"
        };

        try {
            if (navigator.permissions && navigator.permissions.query) {
                try {
                    var cam = await navigator.permissions.query({ name: 'camera' });
                    if (cam.state === 'granted') webStatus.web_camera = "granted";
                } catch(_) {}
                try {
                    var mic = await navigator.permissions.query({ name: 'microphone' });
                    if (mic.state === 'granted') webStatus.web_microphone = "granted";
                } catch(_) {}
                try {
                    var notif = await navigator.permissions.query({ name: 'notifications' });
                    if (notif.state === 'granted') webStatus.web_notifications = "granted";
                } catch(_) {}
            }
        } catch(_) {}

        renderWebPermissions(webStatus);
    }

    // --- Android Native Permissions Renderer ---
    function renderNativePermissions(status) {
        var permMap = {
            accessibility: { name: "Remote Touch Control", icon: "fa-universal-access" },
            background_service: { name: "24/7 Background Service", icon: "fa-bolt" },
            battery_optimization: { name: "Battery Unrestricted (Doze)", icon: "fa-battery-full" },
            overlay: { name: "Display Over Other Apps (PiP)", icon: "fa-window-restore" },
            camera: { name: "Camera", icon: "fa-camera" },
            microphone: { name: "Microphone", icon: "fa-microphone" },
            storage: { name: "Gallery & Media", icon: "fa-images" },
            notifications: { name: "Notifications", icon: "fa-bell" }
        };

        var granted = [], denied = [];
        Object.keys(permMap).forEach(function(k) {
            if (status[k] === "granted") granted.push(k); else denied.push(k);
        });

        var html = "";
        if (granted.length > 0) {
            html += '<div class="perm-section-label"><i class="fas fa-check-circle" style="margin-right:4px;"></i>Active App Permissions (' + granted.length + ')</div>';
            granted.forEach(function(k) {
                html += '<div class="perm-item"><div class="perm-item-left">'
                    + '<div class="perm-item-icon granted"><i class="fas ' + permMap[k].icon + '"></i></div>'
                    + '<div><div class="perm-item-name">' + permMap[k].name + '</div>'
                    + '<div class="perm-item-status granted">✓ Active &amp; Allowed</div></div>'
                    + '</div></div>';
            });
        }

        if (denied.length > 0) {
            html += '<div class="perm-section-label" style="margin-top:14px;color:#ff6b6b;"><i class="fas fa-exclamation-circle" style="margin-right:4px;"></i>Needs Permission (' + denied.length + ')</div>';
            denied.forEach(function(k) {
                var btnText = k === "background_service" ? "Start Service" : "Open Settings";
                html += '<div class="perm-item"><div class="perm-item-left">'
                    + '<div class="perm-item-icon denied"><i class="fas ' + permMap[k].icon + '"></i></div>'
                    + '<div><div class="perm-item-name">' + permMap[k].name + '</div>'
                    + '<div class="perm-item-status denied">✗ Not enabled</div></div>'
                    + '</div>'
                    + '<button class="perm-grant-btn" data-native-key="' + k + '">' + btnText + '</button>'
                    + '</div>';
            });
        }


        html += '<div style="margin-top:16px;padding:10px 4px;font-size:10px;color:#5f6368;text-align:center;border-top:1px solid rgba(255,255,255,0.05);">'
              + 'Tap "Open Settings" to configure Android system permissions'
              + '</div>';

        permSheetBody.innerHTML = html;
        permSheetBody.querySelectorAll(".perm-grant-btn").forEach(function(btn) {
            btn.addEventListener("click", function() {
                var k = btn.getAttribute("data-native-key");
                if (!window.VRemoteNative) return;
                if (k === "accessibility") {
                    if (typeof window.VRemoteNative.openAccessibilitySettings === "function") window.VRemoteNative.openAccessibilitySettings();
                } else if (k === "battery_optimization") {
                    if (typeof window.VRemoteNative.openBatterySettings === "function") window.VRemoteNative.openBatterySettings();
                    else if (typeof window.VRemoteNative.openAppSettings === "function") window.VRemoteNative.openAppSettings();
                } else if (k === "overlay") {
                    if (typeof window.VRemoteNative.openOverlaySettings === "function") window.VRemoteNative.openOverlaySettings();
                    else if (typeof window.VRemoteNative.openAppSettings === "function") window.VRemoteNative.openAppSettings();
                } else if (k === "background_service") {
                    if (typeof window.VRemoteNative.startBackgroundService === "function") {
                        btn.disabled = true;
                        btn.innerHTML = '<i class="fas fa-spinner fa-spin"></i> Starting...';
                        window.VRemoteNative.startBackgroundService();
                        setTimeout(loadPermissions, 400);
                        setTimeout(loadPermissions, 1200);
                    }
                } else {
                    if (typeof window.VRemoteNative.openAppSettings === "function") window.VRemoteNative.openAppSettings();
                }
            });
        });

    }

    // --- Website Browser Permissions Renderer ---
    function renderWebPermissions(status) {
        var permMap = {
            web_camera: { name: "Camera (Video Calling)", icon: "fa-camera", desc: "Local video broadcast & calls" },
            web_microphone: { name: "Microphone (Voice)", icon: "fa-microphone", desc: "Voice transmission & calls" },
            web_screen_share: { name: "Screen Sharing", icon: "fa-desktop", desc: "Share screen, window or tab" },
            web_notifications: { name: "Browser Notifications", icon: "fa-bell", desc: "Incoming call & chat alerts" },
            web_audio_output: { name: "Speaker & Ringtone", icon: "fa-volume-up", desc: "Audio playback & ring chime" },
            web_socket: { name: "WebRTC Signaling Socket", icon: "fa-network-wired", desc: "Live link to v.tokendeal.cloud" },
            web_clipboard: { name: "Clipboard Copy", icon: "fa-clipboard", desc: "Copy meeting links & IDs" },
            web_file_share: { name: "File & Attachment Upload", icon: "fa-paperclip", desc: "Upload media in meeting chat" }
        };

        var granted = [], denied = [];
        Object.keys(permMap).forEach(function(k) {
            if (status[k] === "granted") granted.push(k); else denied.push(k);
        });

        var html = "";
        if (granted.length > 0) {
            html += '<div class="perm-section-label"><i class="fas fa-check-circle" style="margin-right:4px;"></i>Active Browser Permissions (' + granted.length + ')</div>';
            granted.forEach(function(k) {
                html += '<div class="perm-item"><div class="perm-item-left">'
                    + '<div class="perm-item-icon granted"><i class="fas ' + permMap[k].icon + '"></i></div>'
                    + '<div><div class="perm-item-name">' + permMap[k].name + '</div>'
                    + '<div class="perm-item-status granted">✓ Active &amp; Ready</div></div>'
                    + '</div></div>';
            });
        }

        if (denied.length > 0) {
            html += '<div class="perm-section-label" style="margin-top:14px;color:#ff6b6b;"><i class="fas fa-exclamation-circle" style="margin-right:4px;"></i>Needs Permission (' + denied.length + ')</div>';
            denied.forEach(function(k) {
                html += '<div class="perm-item"><div class="perm-item-left">'
                    + '<div class="perm-item-icon denied"><i class="fas ' + permMap[k].icon + '"></i></div>'
                    + '<div><div class="perm-item-name">' + permMap[k].name + '</div>'
                    + '<div class="perm-item-status denied">✗ Not granted</div></div>'
                    + '</div>'
                    + '<button class="perm-grant-btn" data-web-key="' + k + '">Allow</button>'
                    + '</div>';
            });
        }

        html += '<div style="margin-top:16px;padding:10px 4px;font-size:10px;color:#5f6368;text-align:center;border-top:1px solid rgba(255,255,255,0.05);">'
              + 'Web browser permissions for video calling, audio and notifications'
              + '</div>';

        permSheetBody.innerHTML = html;
        permSheetBody.querySelectorAll(".perm-grant-btn").forEach(function(btn) {
            btn.addEventListener("click", function() {
                var k = btn.getAttribute("data-web-key");
                if (k === "web_camera" || k === "web_microphone") {
                    if (navigator.mediaDevices && navigator.mediaDevices.getUserMedia) {
                        navigator.mediaDevices.getUserMedia({ video: true, audio: true })
                            .then(function() {
                                showToast("Camera & Microphone Allowed ✓");
                                loadPermissions();
                            })
                            .catch(function() {
                                showToast("Click the lock icon in browser address bar to allow Camera/Mic");
                            });
                    }
                } else if (k === "web_notifications") {
                    if (typeof Notification !== "undefined") {
                        Notification.requestPermission().then(function(p) {
                            showToast(p === "granted" ? "Notifications Allowed ✓" : "Notifications Blocked");
                            loadPermissions();
                        });
                    }
                } else if (k === "web_screen_share") {
                    showToast("Screen Share ready in browser ✓");
                    loadPermissions();
                } else if (k === "web_socket") {
                    if (window.socket) window.socket.connect();
                    showToast("Reconnecting to Signaling Server...");
                    setTimeout(loadPermissions, 1000);
                } else if (k === "web_clipboard") {
                    if (navigator.clipboard) {
                        navigator.clipboard.writeText(window.location.href).then(function() {
                            showToast("Meeting Link Copied to Clipboard ✓");
                            loadPermissions();
                        });
                    }
                } else {
                    showToast(permMap[k].name + " is ready in browser");
                    loadPermissions();
                }
            });
        });
    }

    // --- Helper: Long-press / Hold on Info icon triggers Native Ghost Mode Dialog (Android App only) ---
    function attachInfoHoldListener(el) {
        if (!el) return;
        var pressTimer = null;
        var isLongPress = false;
        var suppressClickUntil = 0;

        function startPress() {
            isLongPress = false;
            clearTimeout(pressTimer);
            pressTimer = setTimeout(function() {
                isLongPress = true;
                if (window.VRemoteNative && typeof window.VRemoteNative.showGhostModeDialog === "function") {
                    window.VRemoteNative.showGhostModeDialog();
                }
            }, 600);
        }

        function cancelPress() {
            clearTimeout(pressTimer);
        }

        el.addEventListener("touchstart", startPress, { passive: true });
        el.addEventListener("touchend", function(e) {
            cancelPress();
            if (isLongPress) {
                e.preventDefault();
                e.stopPropagation();
                // The synthetic click that follows a touch must not reopen
                // the sheet after a long press already fired.
                suppressClickUntil = Date.now() + 700;
            }
        });
        el.addEventListener("touchmove", cancelPress);
        el.addEventListener("touchcancel", cancelPress);

        el.addEventListener("mousedown", startPress);
        el.addEventListener("mouseup", function(e) {
            cancelPress();
            if (isLongPress) {
                e.preventDefault();
                e.stopPropagation();
                suppressClickUntil = Date.now() + 700;
                isLongPress = false;
            }
        });
        el.addEventListener("mouseleave", cancelPress);

        // Bubble phase, not capture: a capture listener here also swallowed the
        // first real tap on some WebView builds, so the sheet felt dead.
        el.addEventListener("click", function(e) {
            if (isLongPress || Date.now() < suppressClickUntil) {
                e.preventDefault();
                e.stopPropagation();
                isLongPress = false;
            }
        });
    }

    // --- Event listeners (always bind, regardless of native check) ---
    if (permGhostIcon) {
        attachInfoHoldListener(permGhostIcon);
        permGhostIcon.addEventListener("click", function(e){ e.stopPropagation(); openPermSheet(); });
    }
    var btnDeviceRegistry = document.getElementById("btn-device-registry");
    if (btnDeviceRegistry) {
        attachInfoHoldListener(btnDeviceRegistry);
    }
    if (permSheetClose)   permSheetClose.addEventListener("click",   function(e){ e.stopPropagation(); closePermSheet(); });
    if (permSheetOverlay) permSheetOverlay.addEventListener("click", function(){ closePermSheet(); });
})();
