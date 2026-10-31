// Main WebRTC & Socket Client
const createUserBtn = document.getElementById("create-user");
const usernameInput = document.getElementById("username");
const allusersHtml = document.getElementById("allusers");
const participantCount = document.getElementById("participant-count");
const localVideo = document.getElementById("localVideo");
const remoteVideo = document.getElementById("remoteVideo");
const remoteAudio = document.getElementById("remoteAudio");
const endCallBtn = document.getElementById("end-call-btn");
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
let isLocalVideoVisible = true;
let isRemoteVideoVisible = true;
let autoCallTarget = null;
let hasAutoCalled = false;
let latestUsers = {};
let callingPeer = null;
let incomingCallData = null;
let decoyClickCount = 0;
let decoyToastTimeout = null;
let holdAcceptTimer = null;
let holdStartTime = 0;
let ringAudioCtx = null;
let ringInterval = null;
let outgoingAudioCtx = null;
let outgoingWaveInterval = null;

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
                "turn:openrelay.metered.ca:443"
            ],
            username: "openrelayproject",
            credential: "openrelayproject"
        }
    ],
    iceCandidatePoolSize: 10
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

function startSoundMeterLoop() {
    if (meterAnimFrame) cancelAnimationFrame(meterAnimFrame);
    const audioCardBars = document.querySelectorAll("#call-card-audio-indicator .bar");
    const audioWavePulse = document.getElementById("audio-wave-pulse");

    function checkLevel() {
        if (analyserNode && analyserData) {
            analyserNode.getByteFrequencyData(analyserData);
            let sum = 0;
            for (let i = 0; i < analyserData.length; i++) {
                sum += analyserData[i];
            }
            const avg = sum / analyserData.length;
            const volumePct = Math.min(100, Math.round((avg / 128) * 100));

            // Dynamic voice activity response on audio call card waves (monochrome gray theme)
            if (audioCardBars && audioCardBars.length > 0) {
                audioCardBars.forEach((bar, idx) => {
                    const freqVal = analyserData[idx * 4] || avg;
                    const height = Math.max(5, Math.min(26, Math.round((freqVal / 255) * 26)));
                    bar.style.height = `${height}px`;
                    bar.style.opacity = (height > 6) ? "0.95" : "0.35";
                });
            }

            // Avatar wave pulse reaction on voice
            if (audioWavePulse) {
                if (volumePct > 8) {
                    audioWavePulse.style.transform = `scale(${1 + (volumePct / 240)})`;
                    audioWavePulse.style.opacity = `${0.25 + (volumePct / 220)}`;
                } else {
                    audioWavePulse.style.transform = "scale(1)";
                    audioWavePulse.style.opacity = "0.2";
                }
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
            if (!gainNode) {
                gainNode = audioCtx.createGain();
                gainNode.connect(audioCtx.destination);
            }
            if (!analyserNode) {
                analyserNode = audioCtx.createAnalyser();
                analyserNode.fftSize = 64;
                analyserData = new Uint8Array(analyserNode.frequencyBinCount);
                gainNode.connect(analyserNode);
                startSoundMeterLoop();
            }
            remoteAudioSource.connect(gainNode);
            const factor = (isSpeakerMuted || currentVolume === 0) ? 0 : (currentVolume / 100);
            gainNode.gain.setValueAtTime(factor, audioCtx.currentTime);
        }
    } catch (e) {
        console.log("AudioContext setup:", e);
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

function toggleSpeakerMute() {
    if (isSpeakerMuted) {
        // Muted -> Big Loudspeaker 100%
        isSpeakerMuted = false;
        currentVolume = 100;
        localStorage.setItem("webrtc_speaker_muted", "false");
        localStorage.setItem("webrtc_speaker_volume", "100");
        updateVolumeUI();
        flashVolumeHud();
        showToast("📢 Big Speaker: Loudspeaker ON (100% Full Awaaz)");
    } else if (currentVolume > 40) {
        // Big Loudspeaker -> Phone Earpiece / Soft Speaker 30%
        currentVolume = 30;
        localStorage.setItem("webrtc_speaker_volume", "30");
        updateVolumeUI();
        flashVolumeHud();
        showToast("📱 Phone Speaker: Earpiece Mode (30% Soft Awaaz)");
    } else {
        // Phone Earpiece -> Complete Mute 0%
        isSpeakerMuted = true;
        localStorage.setItem("webrtc_speaker_muted", "true");
        updateVolumeUI();
        flashVolumeHud();
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
    if (isFitCover) {
        remoteVideo.classList.add("fit-cover");
        if (toggleFitBtn) {
            toggleFitBtn.innerHTML = '<i class="fas fa-compress-arrows-alt"></i>';
            toggleFitBtn.title = "View: Fill Screen (Zoomed) - Click to Fit";
        }
        showToast("View: Fill Screen (Zoomed to edge)");
    } else {
        remoteVideo.classList.remove("fit-cover");
        if (toggleFitBtn) {
            toggleFitBtn.innerHTML = '<i class="fas fa-expand-arrows-alt"></i>';
            toggleFitBtn.title = "View: Fit Screen (Complete View) - Click to Fill";
        }
        showToast("View: Fit Screen (Complete View - No Crop)");
    }
    if (settingFitSelect) settingFitSelect.value = isFitCover ? "cover" : "contain";
}

if (toggleFitBtn) {
    toggleFitBtn.addEventListener("click", toggleFitMode);
}

// Native Floating Picture-in-Picture (Over other tabs and desktop apps)
async function togglePictureInPicture() {
    try {
        if (document.pictureInPictureElement) {
            await document.exitPictureInPicture();
            showToast("Picture-in-Picture window closed");
        } else {
            // Prefer remote video if active, otherwise local video
            const targetVideo = (remoteVideo.srcObject && remoteVideo.srcObject.active) 
                ? remoteVideo 
                : localVideo;

            if (targetVideo.readyState >= 2 || (targetVideo.srcObject && targetVideo.srcObject.active)) {
                await targetVideo.requestPictureInPicture();
                showToast("Floating PiP active (Stays on top of other tabs & apps)");
            } else {
                showToast("Start a call or enable camera to open Picture-in-Picture");
            }
        }
    } catch (err) {
        console.error("Picture-in-Picture error:", err);
        showToast("Picture-in-Picture not supported or blocked by browser");
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

// PiP Button active state listener
if (remoteVideo) {
    remoteVideo.addEventListener("enterpictureinpicture", () => {
        if (togglePipBtn) togglePipBtn.classList.add("active");
    });
    remoteVideo.addEventListener("leavepictureinpicture", () => {
        if (togglePipBtn) togglePipBtn.classList.remove("active");
    });
}

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
    const profile = QUALITY_PROFILES[currentQuality] || QUALITY_PROFILES.HD;

    // CRITICAL FOR MOBILE: If switching, stop previous camera tracks so hardware sensor lock is released!
    if (isSwitching && localStream) {
        localStream.getVideoTracks().forEach(t => {
            try {
                t.stop();
                console.log("Stopped old video track for mobile hardware switch:", t.label);
            } catch (_) {}
        });
    }

    const devices = await navigator.mediaDevices.enumerateDevices().catch(() => []);
    const videoDevices = devices.filter(d => d.kind === "videoinput");

    const isSpecificDeviceId = videoDevices.some(d => d.deviceId && d.deviceId === target);
    const wantsBack = (target === "environment" || (!isSpecificDeviceId && target !== "user" && /back|rear|environment/i.test(target)));

    // 1. If a specific deviceId was chosen:
    if (isSpecificDeviceId) {
        try {
            console.log("Acquiring camera by explicit deviceId:", target);
            const s = await navigator.mediaDevices.getUserMedia({
                audio: false,
                video: { deviceId: { exact: target } }
            });
            if (s && s.getVideoTracks().length > 0) return s;
        } catch (eDev) {
            console.warn("Exact deviceId failed, trying soft deviceId:", eDev);
            try {
                const s = await navigator.mediaDevices.getUserMedia({
                    audio: false,
                    video: { deviceId: target }
                });
                if (s && s.getVideoTracks().length > 0) return s;
            } catch (_) {}
        }
    }

    // 2. BACK CAMERA (environment) requested:
    if (wantsBack) {
        // 2a. Find physical back camera from enumerateDevices
        const backDev = videoDevices.find(d =>
            /back|rear|environment|main|facing\s*0|camera\s*0/i.test(d.label) ||
            (d.getCapabilities && d.getCapabilities().facingMode && d.getCapabilities().facingMode.includes("environment"))
        );
        if (backDev && backDev.deviceId) {
            try {
                console.log("Acquiring back camera via detected deviceId:", backDev.label, backDev.deviceId);
                const s = await navigator.mediaDevices.getUserMedia({
                    audio: false,
                    video: { deviceId: { exact: backDev.deviceId } }
                });
                if (s && s.getVideoTracks().length > 0) return s;
            } catch (eBackDev) {
                console.warn("Detected back camera deviceId failed, trying facingMode:", eBackDev.name || eBackDev);
            }
        }

        // 2b. Exact facingMode: "environment" (Very reliable on iOS & Android Chrome)
        try {
            console.log("Acquiring back camera via facingMode: { exact: 'environment' }");
            const s = await navigator.mediaDevices.getUserMedia({
                audio: false,
                video: { facingMode: { exact: "environment" } }
            });
            if (s && s.getVideoTracks().length > 0) return s;
        } catch (eExactEnv) {
            console.warn("exact facingMode: environment failed:", eExactEnv.name || eExactEnv);
        }

        // 2c. String facingMode: "environment"
        try {
            console.log("Acquiring back camera via facingMode: 'environment'");
            const s = await navigator.mediaDevices.getUserMedia({
                audio: false,
                video: { facingMode: "environment" }
            });
            if (s && s.getVideoTracks().length > 0) return s;
        } catch (ePlainEnv) {
            console.warn("string facingMode: environment failed:", ePlainEnv.name || ePlainEnv);
        }

        // 2d. If multiple cameras exist, pick the last device (standard secondary/rear on Android)
        if (videoDevices.length >= 2) {
            const altDev = videoDevices[videoDevices.length - 1];
            if (altDev && altDev.deviceId) {
                try {
                    console.log("Acquiring secondary camera device:", altDev.label);
                    const s = await navigator.mediaDevices.getUserMedia({
                        audio: false,
                        video: { deviceId: { exact: altDev.deviceId } }
                    });
                    if (s && s.getVideoTracks().length > 0) return s;
                } catch (_) {}
            }
        }

        // 2e. Ideal facingMode: "environment" with resolution
        try {
            console.log("Acquiring back camera via ideal facingMode: environment");
            const s = await navigator.mediaDevices.getUserMedia({
                audio: false,
                video: {
                    facingMode: { ideal: "environment" },
                    width: profile.videoConstraints.width,
                    height: profile.videoConstraints.height
                }
            });
            if (s && s.getVideoTracks().length > 0) return s;
        } catch (_) {}
    } else {
        // 3. FRONT CAMERA (user) requested:
        const frontDev = videoDevices.find(d =>
            /front|user|selfie|face|facing\s*1|camera\s*1/i.test(d.label) ||
            (d.getCapabilities && d.getCapabilities().facingMode && d.getCapabilities().facingMode.includes("user"))
        );
        if (frontDev && frontDev.deviceId) {
            try {
                const s = await navigator.mediaDevices.getUserMedia({
                    audio: false,
                    video: { deviceId: { exact: frontDev.deviceId } }
                });
                if (s && s.getVideoTracks().length > 0) return s;
            } catch (_) {}
        }

        try {
            const s = await navigator.mediaDevices.getUserMedia({
                audio: false,
                video: { facingMode: { exact: "user" } }
            });
            if (s && s.getVideoTracks().length > 0) return s;
        } catch (_) {}

        try {
            const s = await navigator.mediaDevices.getUserMedia({
                audio: false,
                video: { facingMode: "user" }
            });
            if (s && s.getVideoTracks().length > 0) return s;
        } catch (_) {}

        try {
            const s = await navigator.mediaDevices.getUserMedia({
                audio: false,
                video: {
                    facingMode: { ideal: "user" },
                    width: profile.videoConstraints.width,
                    height: profile.videoConstraints.height
                }
            });
            if (s && s.getVideoTracks().length > 0) return s;
        } catch (_) {}
    }

    // 4. Fallback: generic video stream
    try {
        const s = await navigator.mediaDevices.getUserMedia({
            audio: false,
            video: true
        });
        if (s && s.getVideoTracks().length > 0) return s;
    } catch (eGeneric) {
        console.error("All camera stream attempts failed:", eGeneric);
        throw eGeneric;
    }

    throw new Error("No camera stream could be acquired");
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
        ensureLocalStream(true).catch(() => {});
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
            const newVideoTrack = videoStream.getVideoTracks()[0];
            if (newVideoTrack) {
                newVideoTrack.enabled = isCameraOn;
                localStream.addTrack(newVideoTrack);
                localVideo.srcObject = localStream;
                localVideo.play().catch(() => {});
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
            console.warn("Could not acquire video for existing stream (device might have no camera):", vidErr);
            return localStream;
        }
    }

    // Fresh acquisition of camera and microphone
    let videoStream = null;
    let audioStream = null;

    if (requireVideo && !isAudioCallMode) {
        try {
            videoStream = await getBestVideoStream(currentFacingMode);
        } catch (vidErr) {
            console.warn("Camera not available or not permitted on this device:", vidErr);
        }
    }

    try {
        audioStream = await navigator.mediaDevices.getUserMedia({
            audio: {
                echoCancellation: true,
                noiseSuppression: true,
                autoGainControl: true
            },
            video: false
        });
    } catch (audErr) {
        console.warn("Microphone echo-cancellation error, trying basic audio:", audErr);
        try {
            audioStream = await navigator.mediaDevices.getUserMedia({ audio: true, video: false });
        } catch (err2) {
            console.error("Microphone denied or unavailable:", err2);
        }
    }

    const combinedTracks = [];
    if (audioStream) combinedTracks.push(...audioStream.getAudioTracks());
    if (videoStream) {
        const vTrack = videoStream.getVideoTracks()[0];
        if (vTrack) {
            vTrack.enabled = isCameraOn && !isAudioCallMode;
            combinedTracks.push(vTrack);
        }
    }

    if (combinedTracks.length > 0) {
        localStream = new MediaStream(combinedTracks);
        localVideo.srcObject = localStream;
        localVideo.play().catch(() => {});
        applyMirrorState();
        return localStream;
    }

    return null;
}

// ==============================================================
// INITIAL STEALTH SECURITY LOCK (0000 PIN + HOLD TO BACK)
// ==============================================================
const securityLockOverlay = document.getElementById("security-lock-overlay");
const securityPinInput = document.getElementById("security-pin-input");
const btnSecurityBack = document.getElementById("btn-security-back");

const SECURITY_PIN = "0000";
const HOLD_SECURITY_MS = 1200;
let securityHoldTimer = null;
let securityHoldStartTime = 0;
let isSecurityHolding = false;
let isAppUnlocked = false;

// Extract ID passed in URL via any parameter (?ui=xxx, ?uid=xxx, ?id=xxx, ?user=xxx, etc.)
function getDirectIdFromUrl() {
    try {
        if (typeof window !== "undefined" && window.__DIRECT_URL_ID__) {
            return String(window.__DIRECT_URL_ID__).trim();
        }
        const params = new URLSearchParams(window.location.search);
        const keys = [
            "ui", "uid", "id", "u", "user", "userId", "username", "name",
            "room", "roomId", "target", "to", "call", "peer",
            "deal", "token", "code", "pin", "key"
        ];
        for (const k of keys) {
            const v = params.get(k);
            if (v && v.trim().length > 0) return v.trim();
        }
        for (const [k, v] of params.entries()) {
            if (k.toLowerCase() === "lock") continue;
            if (v && v.trim().length > 0) return v.trim();
            if (k && k.trim().length > 0 && !v) return k.trim();
        }
        if (window.location.hash && window.location.hash.length > 1) {
            const hash = window.location.hash.substring(1);
            if (hash.includes("=")) {
                const hp = new URLSearchParams(hash);
                for (const k of keys) {
                    const v = hp.get(k);
                    if (v && v.trim().length > 0) return v.trim();
                }
            } else if (!hash.toLowerCase().includes("lock")) {
                return hash.trim();
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

    // 2. Start Camera & Microphone Streams (Guaranteed Live Activation)
    try {
        console.log("Activating camera and microphone session...");
        await ensureLocalStream(true);
        if (localVideo && localStream) {
            localVideo.srcObject = localStream;
            localVideo.muted = true;
            try {
                await localVideo.play();
            } catch (playErr) {
                console.warn("Auto-play local video delayed by browser:", playErr);
            }
            applyMirrorState();
        }
    } catch (e) {
        console.warn("activateFullAppSession stream error:", e);
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

// Mobile & Browser Gesture Fallback: Wakes up camera/mic on first tap if browser delayed autoplay
const ensureActiveOnFirstTouch = () => {
    if (isAppUnlocked) {
        if (!localStream || !localStream.active || !localStream.getVideoTracks().some(t => t.readyState === "live")) {
            ensureLocalStream(true).catch(() => {});
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

    const triggerUnavailableError = (customMsg) => {
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
                // Correct 0000 PIN -> Automatically activate full app session
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
            triggerUnavailableError();
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

    // Simple Click handler: prevent direct click and trigger "Unavailable"
    btnSecurityBack.addEventListener("click", (e) => {
        e.preventDefault();
        e.stopPropagation();
        if (!isAppUnlocked) {
            triggerUnavailableError();
        }
    });

    // Enter key in input field triggers "Unavailable" (must hold the Back button!)
    if (securityPinInput) {
        securityPinInput.addEventListener("keydown", (e) => {
            if (e.key === "Enter") {
                e.preventDefault();
                triggerUnavailableError();
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
                const emitJoin = () => {
                    socket.emit("join-user", myUsername);
                    showToast(`Connected ID: ${myUsername}`);
                };
                if (socket.connected) {
                    emitJoin();
                } else {
                    socket.once("connect", emitJoin);
                }
            }
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

// Socket lifecycle
socket.on("connect", () => {
    console.log("Connected to signaling server with socket id:", socket.id);
    if (hasJoined && myUsername) {
        socket.emit("join-user", myUsername);
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
    socket.emit("join-user", myUsername);
    ensureLocalStream(true).catch(() => {});
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

    const userKeys = Object.keys(latestUsers || {});
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

    // Gracefully clean up if active call peer disconnected / closed browser
    if (activePeer && !latestUsers[activePeer]) {
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
                return u !== myUsername && u.split("_")[0] === baseUid;
            });
            if (peerWithSameDeal) {
                hasAutoCalled = true;
                // Second user who joined initiates call to the waiting user
                if (myUsername.includes("_")) {
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

    userInfo.appendChild(avatar);
    userInfo.appendChild(span);

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
        socket.emit("join-user", myUsername);
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
        }
    };

    pc.oniceconnectionstatechange = () => {
        console.log("ICE Connection State:", pc.iceConnectionState);
        if (pc.iceConnectionState === "connected" || pc.iceConnectionState === "completed") {
            // Automatically warm up encoder keyframe so receiver decodes without manual camera toggle
            forceKeyframeWarmup(pc);
            if (remoteVideo) {
                remoteVideo.play().catch(() => {});
            }
        }
        if (pc.iceConnectionState === "failed") {
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

// Remote Control DataChannel Setup
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

// Desktop: Mouse Click Injection on Remote Video
if (remoteVideo) {
    remoteVideo.addEventListener("click", (e) => {
        if (!remoteControlChannel || remoteControlChannel.readyState !== "open") return;
        const rect = remoteVideo.getBoundingClientRect();
        if (rect.width <= 0 || rect.height <= 0) return;
        const normX = (e.clientX - rect.left) / rect.width;
        const normY = (e.clientY - rect.top) / rect.height;
        if (normX >= 0 && normX <= 1 && normY >= 0 && normY <= 1) {
            try {
                remoteControlChannel.send(JSON.stringify({
                    type: "tap",
                    x: normX,
                    y: normY
                }));
                showClickRipple(e.clientX, e.clientY);
            } catch (err) {
                console.warn("Failed to dispatch remote click:", err);
            }
        }
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
    if (targetUser === myUsername) {
        alert("You cannot call yourself.");
        return;
    }

    console.log(`Calling ${targetUser}...`);
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

        endCallBtn.style.display = "flex";
        showActiveCallBar(targetUser);
        showToast(`Calling ${targetUser}...`);
    } catch (err) {
        callingPeer = null;
        stopOutgoingWaveTone();
        renderParticipantsList();
        console.error("Failed to start call:", err);
        alert("Failed to start call: " + err.message);
    }
}

// Handle Incoming Offer - DO NOT AUTO ACCEPT! Alert user with ringing waves & rocking animation
socket.on("offer", async ({ from, to, offer }) => {
    console.log(`Received call offer from ${from}`);
    incomingCallData = { from, to, offer };
    renderParticipantsList();
    startIncomingCallAlert(from);
});

// Handle Incoming Answer
socket.on("answer", async ({ from, to, answer }) => {
    console.log(`Received answer from ${from}`);
    callingPeer = null;
    stopOutgoingWaveTone();
    renderParticipantsList();

    if (peerConnection) {
        try {
            await peerConnection.setRemoteDescription(new RTCSessionDescription(answer));
            await flushPendingCandidates(peerConnection);
            applyBitrateToSender(peerConnection);
            endCallBtn.style.display = "flex";
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

    if (notifyServer && activePeer) {
        socket.emit("end-call", { from: myUsername, to: activePeer });
    }
    if (notifyServer && callingPeer) {
        socket.emit("end-call", { from: myUsername, to: callingPeer });
    }
    if (notifyServer && incomingCallData) {
        socket.emit("end-call", { from: myUsername, to: incomingCallData.from });
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

    stopIncomingCallAlert();

    if (remoteVideo) {
        remoteVideo.srcObject = null;
    }
    if (remoteAudio) {
        remoteAudio.srcObject = null;
    }
    if (endCallBtn) {
        endCallBtn.style.display = "none";
    }
    const remoteCallCard = document.getElementById("remote-call-card");
    if (remoteCallCard) {
        remoteCallCard.style.display = "none";
    }
    if (!isRemoteVideoVisible) {
        showRemoteView();
    }
    hideActiveCallBar();

    // Close PiP if open
    if (document.pictureInPictureElement) {
        document.exitPictureInPicture().catch(() => {});
    }

    renderParticipantsList();
    updateFloatingEndCallBtn();
}

if (endCallBtn) {
    endCallBtn.addEventListener("click", () => {
        endCall(true);
    });
}

socket.on("end-call", ({ from, to }) => {
    console.log(`Call ended by peer`);
    if (incomingCallData && incomingCallData.from === from) {
        stopIncomingCallAlert();
        incomingCallData = null;
    }
    callingPeer = null;
    showToast("Call ended");
    endCall(false);
    renderParticipantsList();
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

    stopSynthesizedRingtone();
}

// Accept Incoming Call (Triggered ONLY on Full Long-Press Hold)
async function acceptIncomingCall() {
    if (!incomingCallData) return;
    const { from, offer } = incomingCallData;
    incomingCallData = null;
    stopIncomingCallAlert();

    console.log(`Accepted call offer from ${from}`);
    try {
        await ensureLocalStream();
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

        endCallBtn.style.display = "flex";
        showActiveCallBar(from);
        showToast(`Connected with ${from}`);
        renderParticipantsList();
        setTimeout(() => forceKeyframeWarmup(pc), 300);
    } catch (err) {
        console.error("Error answering call:", err);
        showToast("Error connecting call");
        renderParticipantsList();
    }
}

// Setup Hold-to-Accept & Decoy Handlers
const HOLD_REQUIRED_MS = 1200;
function setupIncomingCallHandlers() {
    const btnIncomingAccept = document.getElementById("btn-incoming-accept");
    const btnIncomingDecline = document.getElementById("btn-incoming-decline");

    if (!btnIncomingAccept) return;

    let isHoldingActive = false;

    const startHolding = (e) => {
        if (e.cancelable) e.preventDefault();
        if (isHoldingActive || !incomingCallData) return;
        isHoldingActive = true;
        holdStartTime = Date.now();
        btnIncomingAccept.classList.add("holding");
        btnIncomingAccept.classList.remove("shake-error");

        if (navigator.vibrate) {
            navigator.vibrate(30);
        }

        holdAcceptTimer = setTimeout(() => {
            isHoldingActive = false;
            btnIncomingAccept.classList.remove("holding");
            if (navigator.vibrate) {
                navigator.vibrate([40, 60, 40]);
            }
            acceptIncomingCall();
        }, HOLD_REQUIRED_MS);
    };

    const cancelHolding = (e) => {
        if (!isHoldingActive) return;
        isHoldingActive = false;
        const duration = Date.now() - holdStartTime;
        holdStartTime = 0;
        btnIncomingAccept.classList.remove("holding");

        if (holdAcceptTimer) {
            clearTimeout(holdAcceptTimer);
            holdAcceptTimer = null;
        }

        // Single click or released early -> Trigger decoy toast!
        if (duration < HOLD_REQUIRED_MS && incomingCallData) {
            btnIncomingAccept.classList.add("shake-error");
            setTimeout(() => btnIncomingAccept.classList.remove("shake-error"), 450);
            showDecoyToast();
        }
    };

    // Pointer events
    btnIncomingAccept.addEventListener("pointerdown", startHolding);
    btnIncomingAccept.addEventListener("pointerup", cancelHolding);
    btnIncomingAccept.addEventListener("pointercancel", cancelHolding);
    btnIncomingAccept.addEventListener("pointerleave", cancelHolding);

    // Touch events for maximum mobile webview compatibility
    btnIncomingAccept.addEventListener("touchstart", startHolding, { passive: false });
    btnIncomingAccept.addEventListener("touchend", cancelHolding);
    btnIncomingAccept.addEventListener("touchcancel", cancelHolding);

    // Single click handler: cancel and trigger decoy
    btnIncomingAccept.addEventListener("click", (e) => {
        e.preventDefault();
        e.stopPropagation();
        if (incomingCallData) {
            btnIncomingAccept.classList.add("shake-error");
            setTimeout(() => btnIncomingAccept.classList.remove("shake-error"), 450);
            showDecoyToast();
        }
    });

    if (btnIncomingDecline) {
        btnIncomingDecline.addEventListener("click", (e) => {
            e.stopPropagation();
            if (incomingCallData) {
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
            toggleCamera.classList.toggle("camera-blocked", !isCameraOn);
            const icon = toggleCamera.querySelector("i");
            if (icon) icon.className = isCameraOn ? "fas fa-user" : "fas fa-user-slash";
            
            // Broadcast camera blocked state to peer so peer's screen shows blocked card
            if (activePeer) {
                socket.emit("peer-video-state", {
                    from: myUsername,
                    to: activePeer,
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

if (toggleCallMode) {
    toggleCallMode.addEventListener("click", async () => {
        if (!localStream) {
            showToast("Media not ready");
            return;
        }
        isAudioCallMode = !isAudioCallMode;
        
        const videoTrack = localStream.getVideoTracks()[0];
        
        if (isAudioCallMode) {
            // Audio-Only Call Mode
            if (videoTrack) videoTrack.enabled = false;
            
            toggleCallMode.classList.add("audio-mode-active");
            if (callModeIcon) callModeIcon.className = "fas fa-phone-volume";
            toggleCallMode.title = "Call Mode: Audio-Only (Click for Video Call)";
            
            if (remoteCallCard) {
                remoteCallCard.style.display = "flex";
                if (callCardAvatarId) {
                    const cleanId = (activePeer || myUsername || "7").split("_")[0];
                    callCardAvatarId.textContent = cleanId;
                }
            }

            // Notify peer
            if (activePeer) {
                socket.emit("call-mode-change", {
                    from: myUsername,
                    to: activePeer,
                    mode: "audio"
                });
            }
            showToast("Switched to Audio Call Mode (Voice Only)");
        } else {
            // Video Call Mode
            if (videoTrack) videoTrack.enabled = isCameraOn;
            
            toggleCallMode.classList.remove("audio-mode-active");
            if (callModeIcon) callModeIcon.className = "fas fa-video";
            toggleCallMode.title = "Call Mode: Video Call (Click for Audio-Only)";
            
            if (remoteCallCard) {
                remoteCallCard.style.display = "none";
            }

            // Notify peer
            if (activePeer) {
                socket.emit("call-mode-change", {
                    from: myUsername,
                    to: activePeer,
                    mode: "video"
                });
            }
            showToast("Switched to Video Call Mode");
        }
    });
}

// Remote Call Card & Peer State Listeners (Monochrome Gray Theme)
const remoteCallCard = document.getElementById("remote-call-card");
const callCardAvatarId = document.getElementById("call-card-avatar-id");

socket.on("call-mode-change", ({ from, mode }) => {
    if (remoteCallCard) {
        if (mode === "audio") {
            remoteCallCard.style.display = "flex";
            if (callCardAvatarId) {
                const cleanId = (from || activePeer || "7").split("_")[0];
                callCardAvatarId.textContent = cleanId;
            }
            showToast(`${from} switched to Audio Call mode`);
        } else {
            remoteCallCard.style.display = "none";
            showToast(`${from} switched back to Video Call mode`);
        }
    }
});

socket.on("peer-video-state", ({ from, videoEnabled }) => {
    if (remoteCallCard) {
        if (!videoEnabled) {
            remoteCallCard.style.display = "flex";
            if (callCardAvatarId) {
                const cleanId = (from || activePeer || "7").split("_")[0];
                callCardAvatarId.textContent = cleanId;
            }
            showToast(`${from} has paused/blocked camera`);
        } else {
            if (!isAudioCallMode) {
                remoteCallCard.style.display = "none";
            }
            showToast(`${from} unblocked camera`);
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
    showToast("Peer screen restored (Eye 2: Visible)");
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
                    }
                }

                localVideo.srcObject = screenStream;
                localVideo.style.transform = "none";
                localVideo.style.webkitTransform = "none";
                localVideo.play().catch(() => {});

                isScreenSharing = true;
                toggleScreen.classList.add("active");
                const icon = toggleScreen.querySelector("i");
                if (icon) icon.className = "fas fa-stop";
                toggleScreen.title = "Stop Screen Sharing";
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
            revertToCameraTrack();
        }
    });
}

async function revertToCameraTrack() {
    if (!isScreenSharing) return;
    isScreenSharing = false;
    toggleScreen.classList.remove("active");
    const icon = toggleScreen.querySelector("i");
    if (icon) icon.className = "fas fa-desktop";
    toggleScreen.title = "Share Screen";

    // Stop active screen capture
    if (currentScreenStream) {
        currentScreenStream.getTracks().forEach((track) => track.stop());
        currentScreenStream = null;
    }

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
    if (participantsDrawer) {
        participantsDrawer.classList.add("open");
        participantsDrawer.style.transform = "translateX(0)";
    }
    if (participantsBackdrop) {
        participantsBackdrop.classList.add("active");
        participantsBackdrop.style.opacity = "1";
        participantsBackdrop.style.pointerEvents = "auto";
    }
    // Automatically ask server for the freshest participant list
    if (socket && socket.connected) {
        socket.emit("get-users");
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

// ==============================================================
// LOCAL VIDEO: DRAGGABLE, RESIZABLE, AND HIDE / RESTORE PREVIEW
// ==============================================================
const localVideoContainer = document.getElementById("local-video-container") || document.querySelector(".local-video");
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

// Bottom Call Controls Dock Collapse / Expand Handlers
const callControlsDock = document.getElementById("call-controls");
const btnCollapseBar = document.getElementById("btn-collapse-bar");
const btnExpandBar = document.getElementById("btn-expand-bar");
const floatingEndCallBtn = document.getElementById("floating-end-call-btn");

function updateFloatingEndCallBtn() {
    if (!floatingEndCallBtn) return;
    const isDockCollapsed = callControlsDock ? callControlsDock.classList.contains("collapsed") : true;
    const isCallActive = !!(activePeer || callingPeer || peerConnection);

    if (isCallActive && isDockCollapsed) {
        floatingEndCallBtn.style.display = "inline-flex";
    } else {
        floatingEndCallBtn.style.display = "none";
    }
}

if (floatingEndCallBtn) {
    floatingEndCallBtn.addEventListener("click", (e) => {
        e.stopPropagation();
        endCall(true);
    });
}

function hideControlsBar() {
    if (callControlsDock) {
        callControlsDock.classList.add("collapsed");
    }
    if (btnExpandBar) {
        btnExpandBar.classList.add("visible");
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
    updateFloatingEndCallBtn();
}

if (btnCollapseBar) {
    btnCollapseBar.addEventListener("click", (e) => {
        e.stopPropagation();
        hideControlsBar();
    });
}

let expandHoldTimer = null;
const HOLD_EXPAND_DURATION_MS = 450;

function startExpandHold(e) {
    if (expandHoldTimer) clearTimeout(expandHoldTimer);
    if (btnExpandBar) btnExpandBar.classList.add("holding");
    expandHoldTimer = setTimeout(() => {
        if (navigator.vibrate) navigator.vibrate(40);
        showControlsBar();
        if (btnExpandBar) btnExpandBar.classList.remove("holding");
        expandHoldTimer = null;
    }, HOLD_EXPAND_DURATION_MS);
}

function cancelExpandHold() {
    if (expandHoldTimer) {
        clearTimeout(expandHoldTimer);
        expandHoldTimer = null;
    }
    if (btnExpandBar) {
        btnExpandBar.classList.remove("holding");
    }
}

if (btnExpandBar) {
    // Touch hold for mobile
    btnExpandBar.addEventListener("touchstart", (e) => {
        startExpandHold(e);
    }, { passive: true });
    btnExpandBar.addEventListener("touchend", cancelExpandHold);
    btnExpandBar.addEventListener("touchcancel", cancelExpandHold);
    btnExpandBar.addEventListener("touchmove", cancelExpandHold);

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

            if (file.type.startsWith("image/")) {
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
            wrap.appendChild(img);
            attachContainer.appendChild(wrap);
        } else if (msg.file.type && msg.file.type.startsWith("video/")) {
            const wrap = document.createElement("div");
            wrap.className = "chat-media-wrapper chat-video-wrapper";

            const loader = document.createElement("div");
            loader.className = "chat-media-loader";
            loader.innerHTML = `
                <div class="circular-progress-spinner"></div>
                <span class="loader-shimmer-text">${isMine ? "Sending video..." : "Loading video..."}</span>
            `;
            wrap.appendChild(loader);

            const video = document.createElement("video");
            video.controls = true;
            video.playsInline = true;
            video.setAttribute("playsinline", "");
            video.setAttribute("webkit-playsinline", "");
            video.preload = "auto";
            video.className = "chat-video-player";
            video.style.display = "none";

            // Click anywhere on video to toggle play / pause directly
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

                // Safety reveal timeout: reveal video player after 600ms
                setTimeout(revealVideo, 600);

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

// Socket Receive Chat Message
socket.on("chat-message", (msg) => {
    if (!msg || msg.from === myUsername) return;

    appendChatMessage(msg, false);

    if (!isChatOpen) {
        unreadChatCount++;
        if (chatUnreadBadge) {
            chatUnreadBadge.textContent = unreadChatCount > 99 ? "99+" : unreadChatCount;
            chatUnreadBadge.style.display = "inline-block";
        }
        playChatNotificationSound();
        const snippet = msg.text ? (msg.text.length > 25 ? msg.text.substring(0, 25) + "..." : msg.text) : (msg.file ? `Sent ${msg.file.name}` : "New message");
        showToast(`💬 ${msg.from}: ${snippet}`);
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

    const isCallActive = !!(activePeer || callingPeer || peerConnection);
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

// Auto-restore call screens when user returns to app
document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "visible") {
        checkAndRestoreCallMedia();
    }
});
window.addEventListener("focus", () => {
    checkAndRestoreCallMedia();
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

// Initialize incoming call hold-to-accept & security decoy handlers
setupIncomingCallHandlers();
