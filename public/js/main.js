// Main WebRTC & Socket Client
const createUserBtn = document.getElementById("create-user");
const usernameInput = document.getElementById("username");
const allusersHtml = document.getElementById("allusers");
const participantCount = document.getElementById("participant-count");
const localVideo = document.getElementById("localVideo");
const remoteVideo = document.getElementById("remoteVideo");
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

const rtcConfig = {
    iceServers: [
        { urls: "stun:stun.l.google.com:19302" },
        { urls: "stun:stun1.l.google.com:19302" },
        { urls: "stun:stun2.l.google.com:19302" },
        { urls: "stun:stun3.l.google.com:19302" },
        { urls: "stun:stun.cloudflare.com:3478" }
    ]
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

// Initialize Preferences in UI
function initPreferences() {
    // Quality UI
    updateQualityUI();
    if (settingQualitySelect) settingQualitySelect.value = currentQuality;

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
    if (settingMirrorCamera) settingMirrorCamera.checked = isMirrorCamera;
    localVideo.style.transform = isMirrorCamera ? "scaleX(-1)" : "scaleX(1)";
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
            try {
                await videoTrack.applyConstraints(profile.videoConstraints);
            } catch (err) {
                console.warn(`applyConstraints error, acquiring fresh ${newQuality} track:`, err);
                try {
                    videoTrack.stop();
                    const newStream = await navigator.mediaDevices.getUserMedia({
                        audio: false,
                        video: profile.videoConstraints
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

if (settingMirrorCamera) {
    settingMirrorCamera.addEventListener("change", (e) => {
        isMirrorCamera = e.target.checked;
        localStorage.setItem("webrtc_mirror_camera", isMirrorCamera);
        localVideo.style.transform = isMirrorCamera ? "scaleX(-1)" : "scaleX(1)";
        showToast(isMirrorCamera ? "Self Camera Mirrored" : "Self Camera Standard");
    });
}

// Initialize Camera & Microphone
async function ensureLocalStream() {
    if (isFrozen) return null;
    if (localStream && localStream.active && localStream.getTracks().length > 0) {
        return localStream;
    }
    const profile = QUALITY_PROFILES[currentQuality];
    try {
        const stream = await navigator.mediaDevices.getUserMedia({
            audio: true,
            video: profile.videoConstraints
        });
        localStream = stream;
        localVideo.srcObject = stream;
        return stream;
    } catch (err) {
        console.warn(`Could not get audio+video at ${currentQuality}, trying default video:`, err);
        try {
            const stream = await navigator.mediaDevices.getUserMedia({ audio: true, video: true });
            localStream = stream;
            localVideo.srcObject = stream;
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

// Render participant list
socket.on("joined", (allusers) => {
    console.log("Participants update:", allusers);
    allusersHtml.innerHTML = "";

    const userKeys = Object.keys(allusers);
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
    userInfo.style.gap = "10px";

    const avatar = document.createElement("div");
    avatar.className = "user-avatar";
    avatar.style.width = "34px";
    avatar.style.height = "34px";
    avatar.style.borderRadius = "50%";
    avatar.style.backgroundColor = isCurrent ? "#1a73e8" : "#3c4043";
    avatar.style.color = "#fff";
    avatar.style.display = "flex";
    avatar.style.alignItems = "center";
    avatar.style.justifyContent = "center";
    avatar.style.fontSize = "14px";
    avatar.innerHTML = '<i class="fas fa-user"></i>';

    const span = document.createElement("span");
    span.style.fontSize = "14px";
    span.style.color = isCurrent ? "#8ab4f8" : "#e8eaed";
    span.style.fontWeight = isCurrent ? "600" : "400";
    span.textContent = isCurrent ? `${user} (You)` : user;

    userInfo.appendChild(avatar);
    userInfo.appendChild(span);
    li.appendChild(userInfo);

    // Actions container (Quality, Call & Delete)
    const actionsDiv = document.createElement("div");
    actionsDiv.className = "participant-actions";

    if (!isCurrent) {
        // If actively connected in call with this participant, show Quality Toggle Button right here!
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

        // Call button
        const callBtn = document.createElement("button");
        callBtn.className = "btn-action-call";
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
        actionsDiv.appendChild(callBtn);

        // Delete / Kick button
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
        // Self-leave / delete button
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
            pc.addTrack(track, localStream);
        });
    }

    // Remote track listener
    pc.ontrack = (event) => {
        console.log("Remote track received:", event.streams[0]);
        if (event.streams && event.streams[0]) {
            remoteVideo.srcObject = event.streams[0];
            remoteVideo.play().catch((e) => console.log("Remote play:", e));
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
        if (pc.iceConnectionState === "disconnected" || pc.iceConnectionState === "failed") {
            endCall(false);
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
        activeCallName.textContent = `Connected: ${peerName}`;
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
        console.error("Failed to start call:", err);
        alert("Failed to start call: " + err.message);
    }
}

// Handle Incoming Offer
socket.on("offer", async ({ from, to, offer }) => {
    console.log(`Received call offer from ${from}`);
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
    } catch (err) {
        console.error("Error answering call:", err);
    }
});

// Handle Incoming Answer
socket.on("answer", async ({ from, to, answer }) => {
    console.log(`Received answer from ${from}`);
    if (peerConnection) {
        try {
            await peerConnection.setRemoteDescription(new RTCSessionDescription(answer));
            await flushPendingCandidates(peerConnection);
            applyBitrateToSender(peerConnection);
            endCallBtn.style.display = "flex";
            showActiveCallBar(from);
            showToast(`Call connected with ${from}`);
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
    if (peerConnection) {
        try {
            peerConnection.close();
        } catch (e) {}
        peerConnection = null;
    }
    activePeer = null;
    pendingIceCandidates = [];
    if (remoteVideo) {
        remoteVideo.srcObject = null;
    }
    if (endCallBtn) {
        endCallBtn.style.display = "none";
    }
    hideActiveCallBar();

    // Close PiP if open
    if (document.pictureInPictureElement) {
        document.exitPictureInPicture().catch(() => {});
    }
}

if (endCallBtn) {
    endCallBtn.addEventListener("click", () => {
        endCall(true);
    });
}

socket.on("end-call", ({ from, to }) => {
    console.log(`Call ended by peer`);
    showToast("Call ended");
    endCall(false);
});

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
            toggleCamera.classList.toggle("active", !isCameraOn);
            const icon = toggleCamera.querySelector("i");
            if (icon) icon.className = isCameraOn ? "fas fa-video" : "fas fa-video-slash";
            showToast(isCameraOn ? "Camera: ON" : "Camera: OFF");
        }
    });
}

if (toggleMic) {
    toggleMic.addEventListener("click", () => {
        if (!localStream) {
            showToast("Microphone not ready or not permitted");
            return;
        }
        const audioTrack = localStream.getAudioTracks()[0];
        if (audioTrack) {
            isMicOn = !isMicOn;
            audioTrack.enabled = isMicOn;
            toggleMic.classList.toggle("active", !isMicOn);
            const icon = toggleMic.querySelector("i");
            if (icon) icon.className = isMicOn ? "fas fa-microphone" : "fas fa-microphone-slash";
            showToast(isMicOn ? "Microphone: ON" : "Microphone: MUTED");
        }
    });
}

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
    if (btnRestoreLocal) {
        btnRestoreLocal.style.display = "inline-flex";
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
    if (btnRestoreLocal) {
        btnRestoreLocal.style.display = "none";
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

if (btnExpandBar) {
    btnExpandBar.addEventListener("click", (e) => {
        e.stopPropagation();
        showControlsBar();
    });
}
