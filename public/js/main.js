



// from public fodler
// 2.
const createUserBtn = document.getElementById("create-user");
const username = document.getElementById("username");
const allusersHtml = document.getElementById("allusers");
const localVideo = document.getElementById("localVideo");
const remoteVideo = document.getElementById("remoteVideo");
const endCallBtn = document.getElementById("end-call-btn");


const socket = io();

// const socket = io("https://any-get.web.app");
// const socket = io("https://us-central1-any-get.cloudfunctions.net/app", {
//     path: "/socket.io",
// });

// const socket = io('https://any-get.onrender.com', {
//     transports: ['websocket', 'polling'],
//     path: '/socket.io'
// });

let localStream;
let caller = [];

// Single Method for peer connection
const PeerConnection = (function(){
    let peerConnection;

    const createPeerConnection = () => {
        const config = {
            iceServers: [
                {
                    urls: 'stun:stun.l.google.com:19302'
                }
            ]
        };
        peerConnection = new RTCPeerConnection(config);

        // add local stream to peer connection
        localStream.getTracks().forEach(track => {
            peerConnection.addTrack(track, localStream);
        })
        // listen to remote stream and add to peer connection
        peerConnection.ontrack = function(event) {
            remoteVideo.srcObject = event.streams[0];
        }
        // listen for ice candidate
        peerConnection.onicecandidate = function(event) {
            if(event.candidate) {
                socket.emit("icecandidate", event.candidate);
            }
        }

        return peerConnection;
    }

    return {
        getInstance: () => {
            if(!peerConnection){
                peerConnection = createPeerConnection();
            }
            return peerConnection;
        }
    }
})();

// handle browser events
createUserBtn.addEventListener("click", (e) => {
    if(username.value !== "") {
        const usernameContainer = document.querySelector(".username-input");
        socket.emit("join-user", username.value);
        usernameContainer.style.display = 'none';
    }
});
endCallBtn.addEventListener("click", (e) => {
    socket.emit("call-ended", caller)
})

// handle socket events
socket.on("joined", allusers => {
    console.log({ allusers });
    const createUsersHtml = () => {
        allusersHtml.innerHTML = "";

        for(const user in allusers) {
            const li = document.createElement("li");
            li.textContent = `${user} ${user === username.value ? "(You)" : ""}`;

            if(user !== username.value) {
                const button = document.createElement("button");
                button.classList.add("call-btn");
                button.addEventListener("click", (e) => {
                    startCall(user);
                });
                const img = document.createElement("img");
                img.setAttribute("src", "/images/phone.png");
                img.setAttribute("width", 20);

                button.appendChild(img);

                li.appendChild(button);
            }

            allusersHtml.appendChild(li);
        }
    }

    createUsersHtml();

})
socket.on("offer", async ({from, to, offer}) => {
    const pc = PeerConnection.getInstance();
    // set remote description
    await pc.setRemoteDescription(offer);
    const answer = await pc.createAnswer();
    await pc.setLocalDescription(answer);
    socket.emit("answer", {from, to, answer: pc.localDescription});
    caller = [from, to];
});
socket.on("answer", async ({from, to, answer}) => {
    const pc = PeerConnection.getInstance();
    await pc.setRemoteDescription(answer);
    // show end call button
    endCallBtn.style.display = 'block';
    socket.emit("end-call", {from, to});
    caller = [from, to];
});
socket.on("icecandidate", async candidate => {
    console.log({ candidate });
    const pc = PeerConnection.getInstance();
    await pc.addIceCandidate(new RTCIceCandidate(candidate));
});
socket.on("end-call", ({from, to}) => {
    endCallBtn.style.display = "block";
});
socket.on("call-ended", (caller) => {
    endCall();
})


// start call method
const startCall = async (user) => {
    console.log({ user })
    const pc = PeerConnection.getInstance();
    const offer = await pc.createOffer();
    console.log({ offer })
    await pc.setLocalDescription(offer);
    socket.emit("offer", {from: username.value, to: user, offer: pc.localDescription});
}

const endCall = () => {
    const pc = PeerConnection.getInstance();
    if(pc) {
        pc.close();
        endCallBtn.style.display = 'none';
    }
}

// initialize app
const startMyVideo = async () => {
    try {
        const stream = await navigator.mediaDevices.getUserMedia({ audio: true, video: true });
        console.log({ stream });
        localStream = stream;
        localVideo.srcObject = stream;
    } catch(error) {}
}

startMyVideo();

// Video switching functionality
document.querySelector('.local-video').addEventListener('click', function() {
    this.classList.toggle('active');
    document.querySelector('.remote-video').classList.toggle('active');
});

document.querySelector('.remote-video').addEventListener('click', function() {
    this.classList.toggle('active');
    document.querySelector('.local-video').classList.toggle('active');
});

// Bottom sheet toggle
const bottomSheetToggle = document.querySelector('.bottom-sheet-toggle');
const callControlsToggle = document.querySelector('.call-controls-toggle');
const callerListWrapper = document.querySelector('.caller-list-wrapper');
const callControls = document.querySelector('.call-controls');
bottomSheetToggle.addEventListener('click', () => {
    callerListWrapper.classList.toggle('expanded');
    if(callerListWrapper.classList.contains('expanded')) {
        // close call controls
        callControls.classList.remove('expanded');
    }
});

callControlsToggle.addEventListener('click', () => {
    callControls.classList.toggle('expanded');
    // if(callControls.classList.contains('expanded')) {
    //     // close caller list
    //     callerListWrapper.classList.toggle('expanded');
    // }
});

// Camera and mic controls
const toggleCamera = document.getElementById('toggle-camera');
const toggleMic = document.getElementById('toggle-mic');
const toggleScreen = document.getElementById('toggle-screen');
const localVideoToggleIcon = document.getElementById('local-video-toggle-icon');
const localVideoDiv = document.querySelector('.local-video');



let isCameraOn = true;
let isMicOn = true;
let isScreenSharing = false;

toggleCamera.addEventListener('click', async () => {
    isCameraOn = !isCameraOn;
    const videoTrack = localStream.getVideoTracks()[0];
    videoTrack.enabled = isCameraOn;
    toggleCamera.classList.toggle('active', !isCameraOn);
    
    // Update icon
    const icon = toggleCamera.querySelector('i');
    icon.className = isCameraOn ? 'fas fa-video' : 'fas fa-video-slash';
    
    // Show/hide user avatar
    const localAvatar = localVideo.parentElement.querySelector('.user-avatar');
    localAvatar.classList.toggle('d-none', isCameraOn);
});

// Local video toggle functionality
let isLocalVideoVisible = true;

localVideoToggleIcon.addEventListener('click', () => {
    isLocalVideoVisible = !isLocalVideoVisible;
    
    // Toggle visibility
    if (isLocalVideoVisible) {
        localVideoDiv.classList.remove('d-none');
        localVideoDiv.style.display = 'block';
    } else {
        localVideoDiv.classList.add('d-none');
        localVideoDiv.style.display = 'none';
    }
    
    // Update icon
    const icon = localVideoToggleIcon.querySelector('i');
    icon.className = isLocalVideoVisible ? 'fas fa-eye' : 'fas fa-eye-slash';
    
    // Update title
    localVideoToggleIcon.title = isLocalVideoVisible ? 'Hide Local Video' : 'Show Local Video';
});

toggleMic.addEventListener('click', () => {
    isMicOn = !isMicOn;
    const audioTrack = localStream.getAudioTracks()[0];
    audioTrack.enabled = isMicOn;
    toggleMic.classList.toggle('active', !isMicOn);
    
    // Update icon
    const icon = toggleMic.querySelector('i');
    icon.className = isMicOn ? 'fas fa-microphone' : 'fas fa-microphone-slash';
});

toggleScreen.addEventListener('click', async () => {
    if (!isScreenSharing) {
        try {
            const screenStream = await navigator.mediaDevices.getDisplayMedia({ video: true });
            const screenTrack = screenStream.getVideoTracks()[0];
            const sender = peerConnection.getSenders().find(s => s.track.kind === 'video');
            sender.replaceTrack(screenTrack);
            isScreenSharing = true;
            toggleScreen.classList.add('active');
            
            // Update icon
            const icon = toggleScreen.querySelector('i');
            icon.className = 'fas fa-stop';
            
            screenTrack.onended = () => {
                isScreenSharing = false;
                toggleScreen.classList.remove('active');
                const videoTrack = localStream.getVideoTracks()[0];
                const sender = peerConnection.getSenders().find(s => s.track.kind === 'video');
                sender.replaceTrack(videoTrack);
                
                // Reset icon
                icon.className = 'fas fa-desktop';
            };
        } catch (err) {
            console.error('Error sharing screen:', err);
        }
    }
});

// Side panel toggle
const sidePanel = document.querySelector('.side-panel');
// const togglePanel = document.querySelector('.toggle-panel');

// togglePanel.addEventListener('click', () => {
//     sidePanel.classList.toggle('expanded');
// });

// Update user list item creation with icons
function createUserListItem(username, isCurrentUser = false) {
    const li = document.createElement('li');
    const userInfo = document.createElement('div');
    userInfo.className = 'user-info';
    
    const avatar = document.createElement('div');
    avatar.className = 'user-avatar';
    avatar.innerHTML = '<i class="fas fa-user"></i>';
    
    const span = document.createElement('span');
    span.textContent = isCurrentUser ? `${username} (You)` : username;
    
    userInfo.appendChild(avatar);
    userInfo.appendChild(span);
    
    const callBtn = document.createElement('button');
    callBtn.className = 'control-btn';
    callBtn.innerHTML = '<i class="fas fa-phone"></i>';
    callBtn.title = 'Call User';
    
    if (!isCurrentUser) {
        callBtn.addEventListener('click', () => {
            startCall(username);
        });
    }
    
    li.appendChild(userInfo);
    li.appendChild(callBtn);
    return li;
}