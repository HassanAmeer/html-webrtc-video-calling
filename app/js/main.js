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
remoteVideo.addEventListener("enterpictureinpicture", () => {
    if (togglePipBtn) togglePipBtn.classList.add("active");
});
remoteVideo.addEventListener("leavepictureinpicture", () => {
    if (togglePipBtn) togglePipBtn.classList.remove("active");
});

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

createUserBtn.addEventListener("click", handleJoinOrUpdate);
usernameInput.addEventListener("keypress", (e) => {
    if (e.key === "Enter") {
        handleJoinOrUpdate();
    }
});

// Render participant list
socket.on("joined", (allusers) => {
    console.log("Participants update:", allusers);
    allusersHtml.innerHTML = "";

    const userKeys = Object.keys(allusers);
    if (participantCount) {
        participantCount.textContent = `(${userKeys.length})`;
    }
    const badgeParticipantCount = document.getElementById("badge-participant-count");
    if (badgeParticipantCount) {
        badgeParticipantCount.textContent = userKeys.length;
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
    freezeOverlay.classList.add("active");
    console.log("App frozen: camera, mic and connection stopped.");
}

async function unfreezeApp() {
    isFrozen = false;
    freezeOverlay.classList.remove("active");

    // Restore camera and microphone
    await ensureLocalStream();

    // Re-join if user had already joined with a name
    if (hasJoined && myUsername) {
        socket.emit("join-user", myUsername);
    }
    console.log("App unfrozen: camera, mic and connection restored.");
}

toggleFreezeBtn.addEventListener("click", freezeApp);
unfreezeBtn.addEventListener("click", unfreezeApp);

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

endCallBtn.addEventListener("click", () => {
    endCall(true);
});

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

toggleCamera.addEventListener("click", () => {
    if (!localStream) return;
    const videoTrack = localStream.getVideoTracks()[0];
    if (videoTrack) {
        isCameraOn = !isCameraOn;
        videoTrack.enabled = isCameraOn;
        toggleCamera.classList.toggle("active", !isCameraOn);
        const icon = toggleCamera.querySelector("i");
        icon.className = isCameraOn ? "fas fa-video" : "fas fa-video-slash";
    }
});

toggleMic.addEventListener("click", () => {
    if (!localStream) return;
    const audioTrack = localStream.getAudioTracks()[0];
    if (audioTrack) {
        isMicOn = !isMicOn;
        audioTrack.enabled = isMicOn;
        toggleMic.classList.toggle("active", !isMicOn);
        const icon = toggleMic.querySelector("i");
        icon.className = isMicOn ? "fas fa-microphone" : "fas fa-microphone-slash";
    }
});

localVideoToggleIcon.addEventListener("click", () => {
    isLocalVideoVisible = !isLocalVideoVisible;
    localVideoDiv.style.display = isLocalVideoVisible ? "block" : "none";
    const icon = localVideoToggleIcon.querySelector("i");
    icon.className = isLocalVideoVisible ? "fas fa-eye" : "fas fa-eye-slash";
});

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

            screenTrack.onended = () => {
                revertToCameraTrack();
            };
        } catch (err) {
            console.error("Screen share error:", err);
        }
    } else {
        revertToCameraTrack();
    }
});

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

// Layout toggles
const toggleParticipantsBtn = document.getElementById("toggle-participants-btn");
const callerListWrapper = document.querySelector(".caller-list-wrapper");
const closeParticipantsBtn = document.getElementById("close-participants-btn");

if (toggleParticipantsBtn) {
    toggleParticipantsBtn.addEventListener("click", (e) => {
        e.stopPropagation();
        callerListWrapper.classList.toggle("expanded");
    });
}

if (closeParticipantsBtn) {
    closeParticipantsBtn.addEventListener("click", (e) => {
        e.stopPropagation();
        callerListWrapper.classList.remove("expanded");
    });
}

// Quick action buttons in Settings dialog
const btnQuickFreeze = document.getElementById("btn-quick-freeze");
const btnQuickPip = document.getElementById("btn-quick-pip");
const btnQuickFit = document.getElementById("btn-quick-fit");
const btnQuickScreen = document.getElementById("btn-quick-screen");

if (btnQuickFreeze) {
    btnQuickFreeze.addEventListener("click", () => {
        if (settingsModal) settingsModal.classList.remove("active");
        freezeApp();
    });
}

if (btnQuickPip) {
    btnQuickPip.addEventListener("click", () => {
        if (settingsModal) settingsModal.classList.remove("active");
        togglePictureInPicture();
    });
}

if (btnQuickFit) {
    btnQuickFit.addEventListener("click", () => {
        toggleFitMode();
    });
}

if (btnQuickScreen) {
    btnQuickScreen.addEventListener("click", () => {
        if (settingsModal) settingsModal.classList.remove("active");
        toggleScreen.click();
    });
}

// Close participant popup when clicking anywhere outside it
document.addEventListener("click", (e) => {
    if (callerListWrapper && callerListWrapper.classList.contains("expanded")) {
        if (!callerListWrapper.contains(e.target) && (!toggleParticipantsBtn || !toggleParticipantsBtn.contains(e.target))) {
            callerListWrapper.classList.remove("expanded");
        }
    }
});

// In-App PiP Window interaction:
// If strict PiP is ON: clicking blank screen or typing does NOT swap or hide!
document.querySelector(".local-video").addEventListener("click", function (e) {
    e.stopPropagation();
    if (isStrictPip) {
        return;
    }
    this.classList.toggle("active");
    document.querySelector(".remote-video").classList.toggle("active");
});
