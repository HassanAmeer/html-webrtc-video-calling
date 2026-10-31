// Main WebRTC & Socket Client
const createUserBtn = document.getElementById("create-user");
const usernameInput = document.getElementById("username");
const allusersHtml = document.getElementById("allusers");
const participantCount = document.getElementById("participant-count");
const localVideo = document.getElementById("localVideo");
const remoteVideo = document.getElementById("remoteVideo");
const endCallBtn = document.getElementById("end-call-btn");

const socket = io();

// State
let myUsername = localStorage.getItem("webrtc_username") || "";
let activePeer = null;
let peerConnection = null;
let pendingIceCandidates = [];
let localStream = null;

const rtcConfig = {
    iceServers: [
        { urls: "stun:stun.l.google.com:19302" },
        { urls: "stun:stun1.l.google.com:19302" },
        { urls: "stun:stun2.l.google.com:19302" },
        { urls: "stun:stun3.l.google.com:19302" },
        { urls: "stun:stun.cloudflare.com:3478" }
    ]
};

// Initialize Media
async function ensureLocalStream() {
    if (localStream && localStream.active && localStream.getTracks().length > 0) {
        return localStream;
    }
    try {
        const stream = await navigator.mediaDevices.getUserMedia({ audio: true, video: true });
        localStream = stream;
        localVideo.srcObject = stream;
        return stream;
    } catch (err) {
        console.warn("Could not get audio+video, falling back to audio only:", err);
        try {
            const stream = await navigator.mediaDevices.getUserMedia({ audio: true, video: false });
            localStream = stream;
            localVideo.srcObject = stream;
            return stream;
        } catch (audioErr) {
            console.error("Microphone/Camera permission denied:", audioErr);
            alert("Camera or microphone permission is needed for video calls.");
            throw audioErr;
        }
    }
}

// Start local video immediately on page load
ensureLocalStream().catch(() => {});

// Socket lifecycle
socket.on("connect", () => {
    console.log("Connected to signaling server with socket id:", socket.id);
    if (myUsername) {
        usernameInput.value = myUsername;
        socket.emit("join-user", myUsername);
    }
});

socket.on("assigned-username", (autoName) => {
    if (!myUsername) {
        myUsername = autoName;
        usernameInput.value = autoName;
        localStorage.setItem("webrtc_username", autoName);
    }
});

socket.on("name-confirmed", (confirmedName) => {
    myUsername = confirmedName;
    usernameInput.value = confirmedName;
    localStorage.setItem("webrtc_username", confirmedName);
});

// Update username on button click or Enter key
function updateUsername() {
    const val = usernameInput.value.trim();
    if (val && val !== myUsername) {
        myUsername = val;
        localStorage.setItem("webrtc_username", myUsername);
        socket.emit("join-user", myUsername);
    }
}

createUserBtn.addEventListener("click", updateUsername);
usernameInput.addEventListener("keypress", (e) => {
    if (e.key === "Enter") {
        updateUsername();
    }
});

// Render participant list
socket.on("joined", (allusers) => {
    console.log("Participants list update:", allusers);
    allusersHtml.innerHTML = "";

    const userKeys = Object.keys(allusers);
    if (participantCount) {
        participantCount.textContent = `(${userKeys.length})`;
    }

    if (userKeys.length === 0) {
        const li = document.createElement("li");
        li.textContent = "No participants online";
        li.style.color = "#9aa0a6";
        li.style.padding = "12px 20px";
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
    li.style.padding = "10px 16px";
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

    // Call Button for any other participant
    if (!isCurrent) {
        const callBtn = document.createElement("button");
        callBtn.className = "control-btn call-participant-btn";
        callBtn.title = `Call ${user}`;
        callBtn.innerHTML = '<i class="fas fa-phone"></i>';
        callBtn.style.width = "36px";
        callBtn.style.height = "36px";
        callBtn.style.borderRadius = "50%";
        callBtn.style.border = "none";
        callBtn.style.backgroundColor = "#34a853";
        callBtn.style.color = "#ffffff";
        callBtn.style.cursor = "pointer";
        callBtn.style.display = "flex";
        callBtn.style.alignItems = "center";
        callBtn.style.justifyContent = "center";
        callBtn.style.fontSize = "14px";
        callBtn.style.transition = "transform 0.15s, background-color 0.2s";

        callBtn.addEventListener("mouseenter", () => {
            callBtn.style.backgroundColor = "#2d9249";
            callBtn.style.transform = "scale(1.08)";
        });
        callBtn.addEventListener("mouseleave", () => {
            callBtn.style.backgroundColor = "#34a853";
            callBtn.style.transform = "scale(1)";
        });

        callBtn.addEventListener("click", (e) => {
            e.stopPropagation();
            startCall(user);
        });

        li.appendChild(callBtn);
    }

    return li;
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
            console.log("Call disconnected");
            endCall(false);
        }
    };

    peerConnection = pc;
    return pc;
}

// Flush queued ICE Candidates after setRemoteDescription
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

// Start Call (Caller side)
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

        socket.emit("offer", {
            from: myUsername,
            to: targetUser,
            offer: pc.localDescription
        });

        endCallBtn.style.display = "flex";
    } catch (err) {
        console.error("Failed to start call:", err);
        alert("Failed to start call: " + err.message);
    }
}

// Handle Incoming Offer (Receiver side)
socket.on("offer", async ({ from, to, offer }) => {
    console.log(`Received call offer from ${from}`);
    try {
        await ensureLocalStream();
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

        endCallBtn.style.display = "flex";
    } catch (err) {
        console.error("Error answering call:", err);
    }
});

// Handle Incoming Answer (Caller receives answer)
socket.on("answer", async ({ from, to, answer }) => {
    console.log(`Received answer from ${from}`);
    if (peerConnection) {
        try {
            await peerConnection.setRemoteDescription(new RTCSessionDescription(answer));
            await flushPendingCandidates(peerConnection);
            endCallBtn.style.display = "flex";
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
}

endCallBtn.addEventListener("click", () => {
    endCall(true);
});

socket.on("end-call", ({ from, to }) => {
    console.log(`Call ended by remote peer`);
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
const bottomSheetToggle = document.querySelector(".bottom-sheet-toggle");
const callerListWrapper = document.querySelector(".caller-list-wrapper");
const callControlsToggle = document.querySelector(".call-controls-toggle");
const callControls = document.querySelector(".call-controls");

bottomSheetToggle.addEventListener("click", () => {
    callerListWrapper.classList.toggle("expanded");
});

callControlsToggle.addEventListener("click", () => {
    callControls.classList.toggle("expanded");
});

// Click local/remote video swap
document.querySelector(".local-video").addEventListener("click", function () {
    this.classList.toggle("active");
    document.querySelector(".remote-video").classList.toggle("active");
});
document.querySelector(".remote-video").addEventListener("click", function () {
    this.classList.toggle("active");
    document.querySelector(".local-video").classList.toggle("active");
});
