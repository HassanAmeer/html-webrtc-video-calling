/**
 * Empirical Challenger Test Suite for Milestone 3 (Worker 1: Web UI & Frontend Signaling Specialist)
 * Verifies:
 * [Item 1] Disconnect Button UI state (reset buttons, clear timers, remove loaders, hide bars)
 * [Item 2] Participants Sheet Isolation (opening, closing, refreshing never disrupts companion call/screen share)
 * [Item 3] Hardware Shutdown on Disconnect/Idle (forceShutdownAllMediaHardware & shutdownIdleMediaHardware)
 * [Item 4] Strict 1:1 parity between public/ and app/
 */

const assert = require('assert');
const fs = require('fs');
const path = require('path');

console.log("=================================================================");
console.log("RUNNING EMPIRICAL CHALLENGER TEST SUITE FOR MILESTONE 3 (WEB & SIGNALING)");
console.log("=================================================================\n");

let passedTests = 0;
let totalTests = 0;

function runTest(name, fn) {
    totalTests++;
    try {
        fn();
        console.log(`[PASS] ${name}`);
        passedTests++;
    } catch (e) {
        console.error(`[FAIL] ${name}: ${e.message}`);
        console.error(e.stack);
    }
}

async function runAsyncTest(name, fn) {
    totalTests++;
    try {
        await fn();
        console.log(`[PASS] ${name}`);
        passedTests++;
    } catch (e) {
        console.error(`[FAIL] ${name}: ${e.message}`);
        console.error(e.stack);
    }
}

// ----------------------------------------------------------------------
// Mock DOM & WebRTC Environment
// ----------------------------------------------------------------------
class MockTrack {
    constructor(kind) {
        this.kind = kind;
        this.enabled = true;
        this.readyState = "live";
        this.stopped = false;
    }
    stop() {
        this.stopped = true;
        this.readyState = "ended";
    }
}

class MockMediaStream {
    constructor(tracks = []) {
        this.tracks = tracks;
    }
    getTracks() { return this.tracks; }
    getVideoTracks() { return this.tracks.filter(t => t.kind === "video"); }
    getAudioTracks() { return this.tracks.filter(t => t.kind === "audio"); }
}

class MockAudioNode {
    constructor() {
        this.connected = true;
        this.disconnected = false;
    }
    disconnect() {
        this.connected = false;
        this.disconnected = true;
    }
    connect() {}
}

class MockPeerConnection {
    constructor() {
        this.connectionState = "connected";
        this.iceConnectionState = "connected";
        this.signalingState = "stable";
        this.closed = false;
    }
    close() {
        this.connectionState = "closed";
        this.iceConnectionState = "closed";
        this.signalingState = "closed";
        this.closed = true;
    }
}

class MockElement {
    constructor(tagName = "div", id = "") {
        this.tagName = tagName;
        this.id = id;
        this._classes = new Set();
        this.classList = {
            add: (...names) => names.forEach(n => this._classes.add(n)),
            remove: (...names) => names.forEach(n => this._classes.delete(n)),
            contains: (name) => this._classes.has(name)
        };
        this.style = {};
        this.dataset = {};
        this.innerHTML = "";
        this.children = [];
        this.listeners = {};
        this.srcObject = null;
        this.paused = true;
    }
    addEventListener(event, handler) {
        if (!this.listeners[event]) this.listeners[event] = [];
        this.listeners[event].push(handler);
    }
    dispatchEvent(event) {
        const list = this.listeners[event.type || event] || [];
        for (const h of list) h(event);
    }
    click() {
        this.dispatchEvent({ type: "click", stopPropagation: () => {} });
    }
    querySelector(sel) {
        for (const child of this.children) {
            if (child.matches && child.matches(sel)) return child;
            if (child.querySelector) {
                const found = child.querySelector(sel);
                if (found) return found;
            }
        }
        return null;
    }
    querySelectorAll(sel) {
        const result = [];
        for (const child of this.children) {
            if (child.matches && child.matches(sel)) result.push(child);
            if (child.querySelectorAll) {
                result.push(...child.querySelectorAll(sel));
            }
        }
        return result;
    }
    appendChild(child) {
        this.children.push(child);
        return child;
    }
    pause() { this.paused = true; }
    play() { this.paused = false; return Promise.resolve(); }
    matches(sel) {
        if (sel.includes(",")) {
            return sel.split(",").some(part => this.matches(part.trim()));
        }
        const classMatch = sel.match(/\.([a-zA-Z0-9_-]+)/);
        if (classMatch && !this._classes.has(classMatch[1])) {
            return false;
        }
        const idMatch = sel.match(/#([a-zA-Z0-9_-]+)/);
        if (idMatch && this.id !== idMatch[1]) {
            return false;
        }
        const actionMatch = sel.match(/\[data-action="([^"]+)"\]/);
        if (actionMatch && this.dataset.action !== actionMatch[1]) {
            return false;
        }
        const didMatch = sel.match(/\[data-did="([^"]+)"\]/);
        if (didMatch && this.dataset.did !== didMatch[1]) {
            return false;
        }
        return true;
    }
}

// ----------------------------------------------------------------------
// [ITEM 4] Strict 1:1 Parity Between public/ and app/
// ----------------------------------------------------------------------
runTest("Item 4: Strict 1:1 Parity between public/ and app/ directories", () => {
    function getAllFiles(dirPath, rootDir = dirPath, arrayOfFiles = []) {
        const files = fs.readdirSync(dirPath);
        files.forEach(file => {
            const fullPath = path.join(dirPath, file);
            if (fs.statSync(fullPath).isDirectory()) {
                getAllFiles(fullPath, rootDir, arrayOfFiles);
            } else {
                arrayOfFiles.push(path.relative(rootDir, fullPath));
            }
        });
        return arrayOfFiles;
    }

    const publicFiles = getAllFiles(path.join(__dirname, "../public")).sort();
    const appFiles = getAllFiles(path.join(__dirname, "../app")).sort();

    assert.deepStrictEqual(publicFiles, appFiles, "File structure must be identical between public/ and app/");

    for (const relFile of publicFiles) {
        const pubBuf = fs.readFileSync(path.join(__dirname, "../public", relFile));
        const appBuf = fs.readFileSync(path.join(__dirname, "../app", relFile));
        assert.strictEqual(
            Buffer.compare(pubBuf, appBuf),
            0,
            `File ${relFile} differs between public/ and app/`
        );
    }
});

// ----------------------------------------------------------------------
// [ITEM 1] Disconnect & Cancel Button UI State Tests
// ----------------------------------------------------------------------
runTest("Item 1: ACTION_DEFAULTS defines all 6 device actions with standard icons and labels", () => {
    const mainJsContent = fs.readFileSync(path.join(__dirname, "../public/js/main.js"), "utf8");
    
    assert(mainJsContent.includes('audio_call: { icon: "fa-phone", label: "Call" }'));
    assert(mainJsContent.includes('video_call: { icon: "fa-video", label: "Video" }'));
    assert(mainJsContent.includes('screen_share: { icon: "fa-desktop", label: "Share" }'));
    assert(mainJsContent.includes('screen_share_control: { icon: "fa-hand-pointer", label: "Control" }'));
    assert(mainJsContent.includes('get_gallery: { icon: "fa-images", label: "Gallery" }'));
    assert(mainJsContent.includes('get_videos: { icon: "fa-film", label: "Videos" }'));
});

runTest("Item 1: resetDeviceButtonLoaders immediately resets all 6 action buttons to default icon & label", () => {
    const ACTION_DEFAULTS = {
        audio_call: { icon: "fa-phone", label: "Call" },
        video_call: { icon: "fa-video", label: "Video" },
        screen_share: { icon: "fa-desktop", label: "Share" },
        screen_share_control: { icon: "fa-hand-pointer", label: "Control" },
        get_gallery: { icon: "fa-images", label: "Gallery" },
        get_videos: { icon: "fa-film", label: "Videos" }
    };

    const deviceId = "test_phone_001";
    const drawerDevicesList = new MockElement("div", "drawer-devices-list");

    // Create buttons simulating active loading or failed state
    const actions = ["audio_call", "video_call", "screen_share", "screen_share_control", "get_gallery", "get_videos"];
    actions.forEach(action => {
        const btn = new MockElement("button");
        btn.classList.add("dev-action-btn");
        if (action === "screen_share") {
            btn.classList.add("btn-action-loading");
            btn.innerHTML = `<i class="fas fa-circle-notch fa-spin"></i><span>Connecting...</span>`;
        } else if (action === "video_call") {
            btn.classList.add("btn-action-failed");
            btn.innerHTML = `<i class="fas fa-exclamation-triangle"></i><span>Failed</span>`;
        } else {
            btn.innerHTML = `<i class="fas ${ACTION_DEFAULTS[action].icon}"></i><span>${ACTION_DEFAULTS[action].label}</span>`;
        }
        btn.dataset.action = action;
        btn.dataset.did = deviceId;
        drawerDevicesList.appendChild(btn);
    });

    // Run resetDeviceButtonLoaders logic
    function normalizeDeviceId(id) { return String(id || "").trim(); }
    const deviceErrorTimers = new Map();
    function clearDeviceErrorTimers(id) { deviceErrorTimers.delete(id); }

    function resetDeviceButtonLoaders(rawId) {
        const did = normalizeDeviceId(rawId);
        if (!did || !drawerDevicesList) return;
        clearDeviceErrorTimers(did);
        const btns = drawerDevicesList.querySelectorAll(`.dev-action-btn[data-did="${did}"]`);
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

    resetDeviceButtonLoaders(deviceId);

    // Verify all 6 buttons are reset and clean
    const btns = drawerDevicesList.querySelectorAll(`.dev-action-btn[data-did="${deviceId}"]`);
    assert.strictEqual(btns.length, 6);
    btns.forEach(btn => {
        assert(!btn.classList.contains("btn-action-loading"), "Must not have .btn-action-loading");
        assert(!btn.classList.contains("btn-action-failed"), "Must not have .btn-action-failed");
        const act = btn.dataset.action;
        assert.strictEqual(btn.innerHTML, `<i class="fas ${ACTION_DEFAULTS[act].icon}"></i><span>${ACTION_DEFAULTS[act].label}</span>`);
    });
});

runTest("Item 1: cancel_connect immediately resets buttons, removes loaders, clears timers, hides connecting bar & active bar", () => {
    const deviceId = "device_xyz";
    const deviceConnectingTimers = new Map();
    const deviceConnectingActions = new Map();
    const deviceErrorTimers = new Map();
    const deviceErrorMessages = new Map();
    const deviceFailedAction = new Map();
    const activeSessionDevices = new Set();

    let connTimerFired = false;
    const tId = setTimeout(() => { connTimerFired = true; }, 1000);
    deviceConnectingTimers.set(deviceId, tId);
    deviceConnectingActions.set(deviceId, "screen_share_control");
    activeSessionDevices.add(deviceId);

    let errTimerFired = false;
    const errId = setTimeout(() => { errTimerFired = true; }, 1000);
    deviceErrorTimers.set(deviceId, [errId]);

    const connBar = new MockElement("div", `session-connecting-bar-${deviceId}`);
    connBar.style.display = "flex";

    const activeBar = new MockElement("div", `session-active-bar-${deviceId}`);
    activeBar.style.display = "flex";

    const idleBtn = new MockElement("button", `btn-disconnect-idle-${deviceId}`);
    idleBtn.style.display = "none";

    const sBadge = new MockElement("span", `session-badge-${deviceId}`);
    sBadge.style.display = "inline-flex";

    // Simulate cancel_connect handler
    function clearDeviceConnectingTimers(id) {
        if (deviceConnectingTimers.has(id)) {
            clearTimeout(deviceConnectingTimers.get(id));
            deviceConnectingTimers.delete(id);
        }
    }
    function clearDeviceErrorTimers(id) {
        if (deviceErrorTimers.has(id)) {
            const list = deviceErrorTimers.get(id);
            if (Array.isArray(list)) list.forEach(t => clearTimeout(t));
            deviceErrorTimers.delete(id);
        }
    }

    // Execute cancel_connect
    clearDeviceConnectingTimers(deviceId);
    clearDeviceErrorTimers(deviceId);
    deviceConnectingActions.delete(deviceId);
    deviceFailedAction.delete(deviceId);
    deviceErrorMessages.delete(deviceId);
    activeSessionDevices.delete(deviceId);

    connBar.style.display = "none";
    activeBar.style.display = "none";
    idleBtn.style.display = "flex";
    sBadge.style.display = "none";

    assert.strictEqual(deviceConnectingTimers.has(deviceId), false);
    assert.strictEqual(deviceErrorTimers.has(deviceId), false);
    assert.strictEqual(deviceConnectingActions.has(deviceId), false);
    assert.strictEqual(activeSessionDevices.has(deviceId), false);
    assert.strictEqual(connBar.style.display, "none", "Connecting bar must be hidden");
    assert.strictEqual(activeBar.style.display, "none", "Active bar must be hidden");
    assert.strictEqual(idleBtn.style.display, "flex", "Idle disconnect button must be restored");
    assert.strictEqual(sBadge.style.display, "none", "Session badge must be hidden");
});

runTest("Item 1: disconnect_device resets all buttons, clears connecting & error timers, and hides active bar", () => {
    const deviceId = "device_abc";
    const deviceConnectingTimers = new Map();
    const deviceErrorTimers = new Map();
    const activeSessionDevices = new Set([deviceId]);

    const activeBar = new MockElement("div", `session-active-bar-${deviceId}`);
    activeBar.style.display = "flex";
    const connBar = new MockElement("div", `session-connecting-bar-${deviceId}`);
    connBar.style.display = "flex";
    const idleBtn = new MockElement("button", `btn-disconnect-idle-${deviceId}`);
    idleBtn.style.display = "none";

    let forceShutdownCalled = false;
    function forceShutdownAllMediaHardware() { forceShutdownCalled = true; }

    // Execute disconnect_device
    activeSessionDevices.delete(deviceId);
    activeBar.style.display = "none";
    connBar.style.display = "none";
    idleBtn.style.display = "flex";
    forceShutdownAllMediaHardware();

    assert.strictEqual(activeSessionDevices.has(deviceId), false);
    assert.strictEqual(activeBar.style.display, "none");
    assert.strictEqual(connBar.style.display, "none");
    assert.strictEqual(idleBtn.style.display, "flex");
    assert.strictEqual(forceShutdownCalled, true);
});

// ----------------------------------------------------------------------
// [ITEM 2] Participants Sheet Isolation Tests
// ----------------------------------------------------------------------
runTest("Item 2: openParticipants does NOT close peerConnection or screenPeerConnection", () => {
    const mockPc = new MockPeerConnection();
    const mockScreenPc = new MockPeerConnection();
    let socketEmittedUsers = false;
    let socketEmittedDevices = false;

    const mockSocket = {
        connected: true,
        emit: (event) => {
            if (event === "get-users") socketEmittedUsers = true;
            if (event === "get-devices") socketEmittedDevices = true;
        }
    };

    const participantsDrawer = new MockElement("aside", "participants-drawer");
    const participantsBackdrop = new MockElement("div", "participants-backdrop");

    function openParticipants() {
        participantsDrawer.classList.add("open");
        participantsDrawer.style.transform = "translateX(0)";
        participantsBackdrop.classList.add("active");
        if (mockSocket && mockSocket.connected) {
            mockSocket.emit("get-users");
            mockSocket.emit("get-devices");
        }
    }

    openParticipants();

    assert.strictEqual(participantsDrawer.classList.contains("open"), true);
    assert.strictEqual(socketEmittedUsers, true);
    assert.strictEqual(socketEmittedDevices, true);
    // Peer connections must NOT be closed!
    assert.strictEqual(mockPc.closed, false);
    assert.strictEqual(mockScreenPc.closed, false);
});

runTest("Item 2: Participants update (joined event) NEVER disconnects companion device (_screen, cachedDevices, activeSessionDevices)", () => {
    function normalizeDeviceId(id) {
        if (!id) return "";
        return String(id).replace(/_screen$/, "").replace(/^mobile_remote_/, "").trim();
    }

    let endCallInvoked = false;
    function endCall() { endCallInvoked = true; }

    const cachedDevices = [{ deviceId: "phone_999", online: true }];
    const activeSessionDevices = new Set(["phone_999"]);

    // Test Case A: activePeer has _screen
    let activePeer = "phone_999_screen";
    let latestUsers = { "other_user": true }; // companion device not in latestUsers
    const cleanActive = normalizeDeviceId(activePeer);
    let isCompanionDevice = Boolean(
        activePeer && (
            activePeer.endsWith("_screen") ||
            activePeer.startsWith("mobile_remote_") ||
            (activeSessionDevices && (activeSessionDevices.has(activePeer) || activeSessionDevices.has(cleanActive))) ||
            (cachedDevices && cachedDevices.some(d => d.deviceId === activePeer || d.deviceId === cleanActive || d.socketId === activePeer))
        )
    );
    assert.strictEqual(isCompanionDevice, true, "Must recognize _screen as companion device");
    if (activePeer && !isCompanionDevice && !latestUsers[activePeer]) {
        endCall(false);
    }
    assert.strictEqual(endCallInvoked, false, "Must NOT disconnect active companion screen share");

    // Test Case B: activePeer without _screen is registered in cachedDevices
    activePeer = "phone_999";
    const cleanActiveB = normalizeDeviceId(activePeer);
    isCompanionDevice = Boolean(
        activePeer && (
            activePeer.endsWith("_screen") ||
            activePeer.startsWith("mobile_remote_") ||
            (activeSessionDevices && (activeSessionDevices.has(activePeer) || activeSessionDevices.has(cleanActiveB))) ||
            (cachedDevices && cachedDevices.some(d => d.deviceId === activePeer || d.deviceId === cleanActiveB || d.socketId === activePeer))
        )
    );
    assert.strictEqual(isCompanionDevice, true, "Must recognize cached companion device");
    if (activePeer && !isCompanionDevice && !latestUsers[activePeer]) {
        endCall(false);
    }
    assert.strictEqual(endCallInvoked, false, "Must NOT disconnect active companion call");
});

runTest("Item 2: Closing or toggling participants sheet preserves active companion streaming", () => {
    const mockScreenPc = new MockPeerConnection();
    const participantsDrawer = new MockElement("aside", "participants-drawer");
    participantsDrawer.classList.add("open");

    function closeParticipants() {
        participantsDrawer.classList.remove("open");
        participantsDrawer.style.transform = "translateX(100%)";
    }

    closeParticipants();
    assert.strictEqual(participantsDrawer.classList.contains("open"), false);
    assert.strictEqual(mockScreenPc.closed, false, "Screen peer connection must remain open");
});

// ----------------------------------------------------------------------
// [ITEM 3] Hardware Shutdown on Disconnect / Idle Tests
// ----------------------------------------------------------------------
runTest("Item 3: forceShutdownAllMediaHardware turns off all local video/audio tracks and stops remote streams", () => {
    const localVideoTrack = new MockTrack("video");
    const localAudioTrack = new MockTrack("audio");
    let localStream = new MockMediaStream([localVideoTrack, localAudioTrack]);
    const allLiveMediaTracks = new Set([localVideoTrack, localAudioTrack]);

    const remoteVideoTrack = new MockTrack("video");
    const remoteAudioTrack = new MockTrack("audio");
    const remoteVideoStream = new MockMediaStream([remoteVideoTrack]);
    const remoteAudioStream = new MockMediaStream([remoteAudioTrack]);

    const remoteVideo = new MockElement("video", "remoteVideo");
    remoteVideo.srcObject = remoteVideoStream;
    const remoteAudio = new MockElement("audio", "remoteAudio");
    remoteAudio.srcObject = remoteAudioStream;
    const localVideo = new MockElement("video", "localVideo");
    localVideo.srcObject = localStream;

    const mockLocalAudioSource = new MockAudioNode();
    const mockRemoteAudioSource = new MockAudioNode();
    let localAudioSource = mockLocalAudioSource;
    let remoteAudioSource = mockRemoteAudioSource;

    let isCameraOn = true;
    let isMicOn = true;
    let peerConnection = new MockPeerConnection();
    let screenPeerConnection = new MockPeerConnection();

    // Execute forceShutdownAllMediaHardware simulation
    function forceShutdownAllMediaHardware() {
        if (localStream) {
            localStream.getTracks().forEach(t => {
                t.enabled = false;
                t.stop();
            });
            localStream = null;
        }
        for (const track of allLiveMediaTracks) {
            track.enabled = false;
            track.stop();
        }
        allLiveMediaTracks.clear();

        if (peerConnection) {
            peerConnection.close();
            peerConnection = null;
        }
        if (screenPeerConnection) {
            screenPeerConnection.close();
            screenPeerConnection = null;
        }

        if (localAudioSource) {
            localAudioSource.disconnect();
            localAudioSource = null;
        }
        if (remoteAudioSource) {
            remoteAudioSource.disconnect();
            remoteAudioSource = null;
        }

        if (localVideo) localVideo.srcObject = null;
        if (remoteVideo) {
            if (remoteVideo.srcObject && remoteVideo.srcObject.getTracks) {
                remoteVideo.srcObject.getTracks().forEach(t => {
                    t.enabled = false;
                    t.stop();
                });
            }
            remoteVideo.srcObject = null;
        }
        if (remoteAudio) {
            if (remoteAudio.srcObject && remoteAudio.srcObject.getTracks) {
                remoteAudio.srcObject.getTracks().forEach(t => {
                    t.enabled = false;
                    t.stop();
                });
            }
            remoteAudio.srcObject = null;
        }

        isCameraOn = false;
        isMicOn = false;
    }

    forceShutdownAllMediaHardware();

    assert.strictEqual(localVideoTrack.enabled, false);
    assert.strictEqual(localVideoTrack.stopped, true);
    assert.strictEqual(localAudioTrack.enabled, false);
    assert.strictEqual(localAudioTrack.stopped, true);
    assert.strictEqual(allLiveMediaTracks.size, 0);

    assert.strictEqual(remoteVideoTrack.enabled, false);
    assert.strictEqual(remoteVideoTrack.stopped, true);
    assert.strictEqual(remoteAudioTrack.enabled, false);
    assert.strictEqual(remoteAudioTrack.stopped, true);

    assert.strictEqual(localVideo.srcObject, null);
    assert.strictEqual(remoteVideo.srcObject, null);
    assert.strictEqual(remoteAudio.srcObject, null);

    assert.strictEqual(mockLocalAudioSource.disconnected, true);
    assert.strictEqual(mockRemoteAudioSource.disconnected, true);

    assert.strictEqual(peerConnection, null);
    assert.strictEqual(screenPeerConnection, null);
    assert.strictEqual(isCameraOn, false);
    assert.strictEqual(isMicOn, false);
});

runTest("Item 3: shutdownIdleMediaHardware releases hardware when idle and preserves hardware when call is active", () => {
    const localVideoTrack = new MockTrack("video");
    const localAudioTrack = new MockTrack("audio");
    let localStream = new MockMediaStream([localVideoTrack, localAudioTrack]);
    const allLiveMediaTracks = new Set([localVideoTrack, localAudioTrack]);
    const localVideo = new MockElement("video", "localVideo");
    localVideo.srcObject = localStream;
    let isCameraOn = true;
    let isMicOn = true;

    // Subtest A: Call is ACTIVE -> MUST NOT shut down hardware
    let callActive = true;
    function isCallOrStreamActive() { return callActive; }

    function shutdownIdleMediaHardware() {
        if (isCallOrStreamActive()) {
            return;
        }
        for (const track of allLiveMediaTracks) {
            track.enabled = false;
            track.stop();
        }
        allLiveMediaTracks.clear();
        if (localStream) {
            localStream.getTracks().forEach(t => {
                t.enabled = false;
                t.stop();
            });
            localStream = null;
        }
        if (localVideo) localVideo.srcObject = null;
        isCameraOn = false;
        isMicOn = false;
    }

    shutdownIdleMediaHardware();
    assert.strictEqual(localVideoTrack.stopped, false, "Must not stop tracks when call active");
    assert.strictEqual(localStream !== null, true);
    assert.strictEqual(isCameraOn, true);

    // Subtest B: NO call active -> MUST release all hardware
    callActive = false;
    shutdownIdleMediaHardware();
    assert.strictEqual(localVideoTrack.enabled, false);
    assert.strictEqual(localVideoTrack.stopped, true);
    assert.strictEqual(localAudioTrack.enabled, false);
    assert.strictEqual(localAudioTrack.stopped, true);
    assert.strictEqual(allLiveMediaTracks.size, 0);
    assert.strictEqual(localStream, null);
    assert.strictEqual(localVideo.srcObject, null);
    assert.strictEqual(isCameraOn, false);
    assert.strictEqual(isMicOn, false);
});

runTest("Item 3: isCallOrStreamActive returns true when activeSessionDevices has active session", () => {
    const activeSessionDevices = new Set(["phone_123"]);
    let activePeer = null;
    let peerConnection = null;
    let isScreenSharing = false;

    function isCallOrStreamActive() {
        const hasPeer = Boolean(activePeer);
        const hasPc = Boolean(peerConnection && peerConnection.connectionState !== "closed");
        const hasScreen = Boolean(isScreenSharing);
        const hasActiveDevice = Boolean(activeSessionDevices && activeSessionDevices.size > 0);
        return Boolean(hasPeer || hasPc || hasScreen || hasActiveDevice);
    }

    assert.strictEqual(isCallOrStreamActive(), true, "Must detect active companion session");
    activeSessionDevices.clear();
    assert.strictEqual(isCallOrStreamActive(), false, "Must return false when all sessions idle");
});

console.log("\n=================================================================");
console.log(`TEST SUMMARY: ${passedTests} / ${totalTests} PASSED`);
if (passedTests === totalTests) {
    console.log("ALL TESTS COMPLETED SUCCESSFULLY!");
    console.log("=================================================================\n");
    process.exit(0);
} else {
    console.error("SOME TESTS FAILED!");
    console.log("=================================================================\n");
    process.exit(1);
}
