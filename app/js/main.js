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
            facingMode: "user",
            width: { ideal: 1920, min: 1280 },
            height: { ideal: 1080, min: 720 },
            frameRate: { ideal: 30, max: 60 }
        },
        maxBitrate: 3500000 // 3.5 Mbps for crystal clear HD
    },
    SD: {
        label: "SD",
        description: "Normal / Smooth for Slow Networks",
        videoConstraints: {
            facingMode: "user",
            width: { ideal: 640, max: 854 },
            height: { ideal: 480, max: 480 },
            frameRate: { ideal: 24, max: 30 }
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
    toastTimeout = setTimeout(() => {
        toast.classList.remove("show");
    }, 2800);
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
        const profile = QUALITY_PROFILES[currentQuality] || QUALITY_PROFILES.HD;
        let newStream = null;

        // Try exact facingMode first (mobile browsers honor this)
        try {
            newStream = await navigator.mediaDevices.getUserMedia({
                audio: false,
                video: {
                    facingMode: { exact: nextMode },
                    width: profile.videoConstraints.width,
                    height: profile.videoConstraints.height
                }
            });
        } catch (exactErr) {
            console.warn(`Exact facingMode ${nextMode} failed, trying ideal:`, exactErr);
            try {
                newStream = await navigator.mediaDevices.getUserMedia({
                    audio: false,
                    video: {
                        facingMode: { ideal: nextMode },
                        width: profile.videoConstraints.width,
                        height: profile.videoConstraints.height
                    }
                });
            } catch (idealErr) {
                // If device enumerate supports other video cameras
                const devices = await navigator.mediaDevices.enumerateDevices();
                const videoDevices = devices.filter(d => d.kind === "videoinput");
                if (videoDevices.length > 1) {
                    const currentTrack = localStream ? localStream.getVideoTracks()[0] : null;
                    const currentDeviceId = currentTrack && currentTrack.getSettings ? currentTrack.getSettings().deviceId : null;
                    const altDevice = videoDevices.find(d => d.deviceId !== currentDeviceId) || videoDevices[0];
                    newStream = await navigator.mediaDevices.getUserMedia({
                        audio: false,
                        video: {
                            deviceId: { exact: altDevice.deviceId },
                            width: profile.videoConstraints.width,
                            height: profile.videoConstraints.height
                        }
                    });
                } else {
                    throw idealErr;
                }
            }
        }

        const newTrack = newStream.getVideoTracks()[0];
        if (!newTrack) {
            throw new Error("No video track found from new camera");
        }

        currentFacingMode = nextMode;
        localStorage.setItem("webrtc_facing_mode", currentFacingMode);
        if (settingCameraSelect) {
            settingCameraSelect.value = currentFacingMode;
        }

        // Maintain current mute/enabled state
        newTrack.enabled = isCameraOn;

        if (localStream) {
            const oldTrack = localStream.getVideoTracks()[0];
            if (oldTrack) {
                oldTrack.stop();
                localStream.removeTrack(oldTrack);
            }
            localStream.addTrack(newTrack);
        } else {
            localStream = newStream;
        }

        localVideo.srcObject = localStream;

        // Seamless live WebRTC track replacement without interrupting call
        if (peerConnection) {
            const sender = peerConnection.getSenders().find(s => s.track && s.track.kind === "video");
            if (sender) {
                await sender.replaceTrack(newTrack);
                console.log("Peer connection video track replaced successfully");
            }
        }

        // Update mirror styling: Front camera = mirrored; Back camera = unmirrored
        applyMirrorState(false);

        const modeText = (currentFacingMode === "environment") ? "Back Camera (Rear Lens)" : "Front Camera (Selfie Lens)";
        showToast(`Camera: ${modeText}`);
    } catch (err) {
        console.error("Camera switch error:", err);
        const isUnavailable = err.name === "OverconstrainedError" || err.name === "NotFoundError";
        showToast(isUnavailable ? "Back camera not available on this device" : `Camera switch failed: ${err.message || "Error"}`);
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

// Initialize Camera & Microphone
async function ensureLocalStream() {
    if (isFrozen) return null;
    if (localStream && localStream.active && localStream.getTracks().length > 0) {
        return localStream;
    }
    const profile = QUALITY_PROFILES[currentQuality];
    const videoConstraint = {
        facingMode: { ideal: currentFacingMode },
        width: profile.videoConstraints.width,
        height: profile.videoConstraints.height,
        frameRate: profile.videoConstraints.frameRate
    };
    try {
        const stream = await navigator.mediaDevices.getUserMedia({
            audio: true,
            video: videoConstraint
        });
        localStream = stream;
        localVideo.srcObject = stream;
        applyMirrorState(false);
        return stream;
    } catch (err) {
        console.warn(`Could not get audio+video at ${currentQuality}, trying default video:`, err);
        try {
            const stream = await navigator.mediaDevices.getUserMedia({
                audio: true,
                video: { facingMode: { ideal: currentFacingMode } }
            });
            localStream = stream;
            localVideo.srcObject = stream;
            applyMirrorState(false);
            return stream;
        } catch (vidErr) {
            console.warn("Could not get video, falling back to audio only:", vidErr);
            try {
                const stream = await navigator.mediaDevices.getUserMedia({ audio: true, video: false });
                localStream = stream;
                localVideo.srcObject = stream;
                return stream;
            } catch (audioErr) {
                console.error("Camera/Microphone permission denied:", audioErr);
                return null;
            }
        }
    }
}

// Start local camera on page load
ensureLocalStream().catch(() => {});

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
    socket.emit("join-user", myUsername);
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

// URL Query Parameter Auto-Join & Auto-Call Integration (?uid=xxx or ?user=xxx)
function handleUrlQueryParams() {
    try {
        const urlParams = new URLSearchParams(window.location.search);
        const uidParam = urlParams.get("uid") || urlParams.get("user") || urlParams.get("username") || urlParams.get("name");
        const targetParam = urlParams.get("call") || urlParams.get("target") || urlParams.get("to") || urlParams.get("peer");

        if (targetParam) {
            autoCallTarget = targetParam.trim().substring(0, 30);
        }

        if (uidParam) {
            const cleanUid = uidParam.trim().substring(0, 30);
            if (cleanUid) {
                myUsername = cleanUid;
                if (usernameInput) {
                    usernameInput.value = cleanUid;
                }
                const emitJoin = () => {
                    socket.emit("join-user", myUsername);
                    showToast(`Auto-joined as: ${myUsername}`);
                };
                if (socket.connected) {
                    emitJoin();
                } else {
                    socket.once("connect", emitJoin);
                }
            }
        }
    } catch (e) {
        console.warn("Error parsing URL parameters:", e);
    }
}
handleUrlQueryParams();

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

    // Show freeze overlay
    if (freezeOverlay) {
        freezeOverlay.classList.add("active");
        freezeOverlay.style.display = "flex";
    }
    showToast("App Frozen: Sleep mode activated");
    console.log("App frozen: camera, mic and connection stopped.");
}

async function unfreezeApp() {
    isFrozen = false;
    if (freezeOverlay) {
        freezeOverlay.classList.remove("active");
        freezeOverlay.style.display = "none";
    }

    // Restore camera and microphone
    await ensureLocalStream();

    // Re-join if user had already joined with a name
    if (hasJoined && myUsername) {
        socket.emit("join-user", myUsername);
    }
    showToast("App Resumed: Active");
    console.log("App unfrozen: camera, mic and connection restored.");
}

if (toggleFreezeBtn) toggleFreezeBtn.addEventListener("click", freezeApp);
if (unfreezeBtn) unfreezeBtn.addEventListener("click", unfreezeApp);

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

    peerConnection = pc;
    return pc;
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
}

function hideActiveCallBar() {
    if (activeCallBar) {
        activeCallBar.style.display = "none";
    }
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

    try {
        await ensureLocalStream();
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
    hideActiveCallBar();

    // Close PiP if open
    if (document.pictureInPictureElement) {
        document.exitPictureInPicture().catch(() => {});
    }

    renderParticipantsList();
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

// Synthesized Dual-Tone Telephone Ring Cadence
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

        const playRingPulse = () => {
            if (!incomingCallData || !ringAudioCtx) return;
            const now = ringAudioCtx.currentTime;
            const osc1 = ringAudioCtx.createOscillator();
            const osc2 = ringAudioCtx.createOscillator();
            const gain = ringAudioCtx.createGain();

            osc1.type = "sine";
            osc1.frequency.setValueAtTime(440, now);
            osc2.type = "sine";
            osc2.frequency.setValueAtTime(480, now);

            gain.gain.setValueAtTime(0, now);
            gain.gain.linearRampToValueAtTime(0.04, now + 0.05);
            gain.gain.setValueAtTime(0.04, now + 0.85);
            gain.gain.linearRampToValueAtTime(0, now + 0.95);

            osc1.connect(gain);
            osc2.connect(gain);
            gain.connect(ringAudioCtx.destination);

            osc1.start(now);
            osc2.start(now);
            osc1.stop(now + 0.95);
            osc2.stop(now + 0.95);
        };

        playRingPulse();
        if (ringInterval) clearInterval(ringInterval);
        ringInterval = setInterval(() => {
            if (!incomingCallData) {
                stopSynthesizedRingtone();
                return;
            }
            playRingPulse();
        }, 2500);
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
const localVideoDiv = document.querySelector(".local-video");

let isCameraOn = true;
let isMicOn = true;
let isScreenSharing = false;
let isLocalVideoVisible = true;

if (toggleCamera) {
    toggleCamera.addEventListener("click", () => {
        if (!localStream) {
            showToast("Camera not ready or not permitted");
            return;
        }
        const videoTrack = localStream.getVideoTracks()[0];
        if (videoTrack) {
            isCameraOn = !isCameraOn;
            videoTrack.enabled = isCameraOn;
            toggleCamera.classList.toggle("camera-blocked", !isCameraOn);
            const icon = toggleCamera.querySelector("i");
            if (icon) icon.className = isCameraOn ? "fas fa-video" : "fas fa-video-slash";
            
            // Broadcast camera blocked state to peer so peer's screen shows blocked card
            if (activePeer) {
                socket.emit("peer-video-state", {
                    from: myUsername,
                    to: activePeer,
                    videoEnabled: isCameraOn
                });
            }
            showToast(isCameraOn ? "Camera: ON (Video Active)" : "Camera: Blocked / OFF (Tasweer Hide Hai)");
        }
    });
}

// Switch between Audio Call and Video Call
const toggleCallMode = document.getElementById("toggle-call-mode");
const callModeIcon = document.getElementById("call-mode-icon");
let isAudioCallMode = false;

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
    toggleMic.addEventListener("click", () => {
        if (!localStream) {
            showToast("Microphone not ready or not permitted");
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

if (toggleScreen) {
    toggleScreen.addEventListener("click", async () => {
        if (!isScreenSharing) {
            try {
                const screenStream = await navigator.mediaDevices.getDisplayMedia({ video: true });
                const screenTrack = screenStream.getVideoTracks()[0];

                if (peerConnection) {
                    const sender = peerConnection.getSenders().find((s) => s.track && s.track.kind === "video");
                    if (sender) {
                        sender.replaceTrack(screenTrack);
                    }
                }

                localVideo.srcObject = screenStream;
                isScreenSharing = true;
                toggleScreen.classList.add("active");
                toggleScreen.querySelector("i").className = "fas fa-stop";
                showToast("Screen Sharing: Active");

                screenTrack.onended = () => {
                    revertToCameraTrack();
                };
            } catch (err) {
                console.error("Screen share error:", err);
                showToast("Screen share cancelled or not supported");
            }
        } else {
            revertToCameraTrack();
        }
    });
}

function revertToCameraTrack() {
    isScreenSharing = false;
    toggleScreen.classList.remove("active");
    toggleScreen.querySelector("i").className = "fas fa-desktop";

    if (localStream) {
        const videoTrack = localStream.getVideoTracks()[0];
        if (peerConnection && videoTrack) {
            const sender = peerConnection.getSenders().find((s) => s.track && s.track.kind === "video");
            if (sender) {
                sender.replaceTrack(videoTrack);
            }
        }
        localVideo.srcObject = localStream;
    }
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

function hideControlsBar() {
    if (callControlsDock) {
        callControlsDock.classList.add("collapsed");
    }
    if (btnExpandBar) {
        btnExpandBar.classList.add("visible");
    }
}

function showControlsBar() {
    if (callControlsDock) {
        callControlsDock.classList.remove("collapsed");
    }
    if (btnExpandBar) {
        btnExpandBar.classList.remove("visible");
    }
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
const attachMediaInput = document.getElementById("attach-media-input");
const attachDocInput = document.getElementById("attach-doc-input");

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
}

function scrollChatToBottom() {
    if (chatMessagesScroll) {
        chatMessagesScroll.scrollTop = chatMessagesScroll.scrollHeight;
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
            const img = document.createElement("img");
            img.src = msg.file.data;
            img.className = "chat-img-thumb";
            img.alt = msg.file.name || "Attached Photo";
            img.loading = "lazy";
            img.addEventListener("click", (e) => {
                e.stopPropagation();
                openImageLightbox(msg.file.data, msg.file.name);
            });
            attachContainer.appendChild(img);
        } else if (msg.file.type && msg.file.type.startsWith("video/")) {
            const video = document.createElement("video");
            video.src = msg.file.data;
            video.controls = true;
            video.className = "chat-video-player";
            attachContainer.appendChild(video);
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

// File Inputs
if (attachCameraInput) {
    attachCameraInput.addEventListener("change", (e) => {
        if (e.target.files && e.target.files[0]) {
            handleFileSelection(e.target.files[0]);
        }
    });
}

if (attachMediaInput) {
    attachMediaInput.addEventListener("change", (e) => {
        if (e.target.files && e.target.files[0]) {
            handleFileSelection(e.target.files[0]);
        }
    });
}

if (attachDocInput) {
    attachDocInput.addEventListener("change", (e) => {
        if (e.target.files && e.target.files[0]) {
            handleFileSelection(e.target.files[0]);
        }
    });
}

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
