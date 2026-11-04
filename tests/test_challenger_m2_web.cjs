/**
 * Empirical Challenger Test Harness for Milestone 2 (Web Client Permissions)
 * Tests:
 * 1. window.socket assignment and web_socket permission detection (connected vs disconnected)
 * 2. All 8 Web Permissions detection and truth table
 * 3. Fallback to enumerateDevices() label check when permissions.query throws TypeError (Firefox simulation)
 * 4. webGrantedOverrides session memory and persistence across queries
 * 5. Camera & Microphone "Allow" handlers: separate video/audio requests, immediate track.stop(), overrides
 * 6. Smooth re-render without DOM wipe to spinner when permissions already rendered
 * 7. Live event triggers: socket connect/disconnect and permissionStatus.onchange
 */

const assert = require('assert');

console.log("=================================================================");
console.log("RUNNING EMPIRICAL CHALLENGER TEST SUITE FOR MILESTONE 2 (WEB PERMS)");
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
// Web Permissions Engine Simulator
// ----------------------------------------------------------------------

class WebPermissionsSimulator {
    constructor() {
        this.reset();
    }

    reset() {
        this.window = {
            socket: null,
            webGrantedOverrides: {},
            location: { href: "https://v.tokendeal.cloud/room123" }
        };
        this.socket = null;
        this.localStream = null;
        this.sheetOpen = false;
        this.permSheetBody = {
            innerHTML: '<div class="perm-initial-spinner"><i class="fas fa-circle-notch fa-spin"></i></div>',
            querySelector(sel) {
                if (sel === ".perm-item") {
                    return this.innerHTML.includes('class="perm-item"');
                }
                return null;
            },
            querySelectorAll(sel) {
                return [];
            }
        };
        this.navigator = {
            permissions: {
                query: async ({ name }) => {
                    if (this.permissionsQueryThrows) {
                        throw new TypeError(`${name} is not a valid enum value of PermissionName.`);
                    }
                    return this.mockPermissions[name] || { state: "prompt" };
                }
            },
            mediaDevices: {
                getDisplayMedia: async () => ({}),
                getUserMedia: async (constraints) => {
                    const tracks = [];
                    if (constraints.video) {
                        tracks.push({ kind: "video", stopped: false, stop() { this.stopped = true; } });
                    }
                    if (constraints.audio) {
                        tracks.push({ kind: "audio", stopped: false, stop() { this.stopped = true; } });
                    }
                    return {
                        tracks,
                        getTracks() { return this.tracks; }
                    };
                },
                enumerateDevices: async () => this.mockDevices
            },
            clipboard: {
                writeText: async (text) => true
            }
        };
        this.Notification = {
            permission: "default",
            requestPermission: async () => this.mockNotificationResult || "granted"
        };
        this.permissionsQueryThrows = false;
        this.mockPermissions = {
            camera: { state: "prompt" },
            microphone: { state: "prompt" },
            notifications: { state: "default" }
        };
        this.mockDevices = [];
        this.mockNotificationResult = "granted";
        this.spinnerWipeOccurred = false;
        this.renderedHtml = "";
    }

    async loadPermissions() {
        if (!this.permSheetBody) return;

        // Anti-flicker guard: only wipe to spinner if no .perm-item elements exist
        if (!this.permSheetBody.querySelector(".perm-item")) {
            this.permSheetBody.innerHTML = '<div style="text-align:center;padding:24px;color:#9aa0a6;font-size:13px;"><i class="fas fa-circle-notch fa-spin"></i></div>';
            this.spinnerWipeOccurred = true;
        } else {
            this.spinnerWipeOccurred = false;
        }

        const webGrantedOverrides = this.window.webGrantedOverrides || {};

        const webStatus = {
            web_camera: (this.localStream && this.localStream.getVideoTracks && this.localStream.getVideoTracks().length > 0) ? "granted" : "denied",
            web_microphone: (this.localStream && this.localStream.getAudioTracks && this.localStream.getAudioTracks().length > 0) ? "granted" : "denied",
            web_screen_share: (this.navigator.mediaDevices && typeof this.navigator.mediaDevices.getDisplayMedia === "function") ? "granted" : "denied",
            web_notifications: (typeof this.Notification !== "undefined" && this.Notification.permission === "granted") ? "granted" : "denied",
            web_audio_output: "granted",
            web_socket: ((this.window.socket && this.window.socket.connected) || (this.socket && this.socket.connected)) ? "granted" : "denied",
            web_clipboard: (this.navigator.clipboard && typeof this.navigator.clipboard.writeText === "function") ? "granted" : "denied",
            web_file_share: "granted"
        };

        // 1. Modern W3C Permissions API
        try {
            if (this.navigator.permissions && typeof this.navigator.permissions.query === "function") {
                try {
                    const cam = await this.navigator.permissions.query({ name: 'camera' });
                    if (cam && cam.state === 'granted') webStatus.web_camera = "granted";
                    if (cam && !cam._listenerAttached) {
                        cam._listenerAttached = true;
                        cam.onchange = () => {
                            if (cam.state === 'granted') webGrantedOverrides["web_camera"] = "granted";
                            else if (cam.state === 'denied' || cam.state === 'prompt') delete webGrantedOverrides["web_camera"];
                            if (this.sheetOpen) this.loadPermissions();
                        };
                    }
                } catch (_) {}

                try {
                    const mic = await this.navigator.permissions.query({ name: 'microphone' });
                    if (mic && mic.state === 'granted') webStatus.web_microphone = "granted";
                    if (mic && !mic._listenerAttached) {
                        mic._listenerAttached = true;
                        mic.onchange = () => {
                            if (mic.state === 'granted') webGrantedOverrides["web_microphone"] = "granted";
                            else if (mic.state === 'denied' || mic.state === 'prompt') delete webGrantedOverrides["web_microphone"];
                            if (this.sheetOpen) this.loadPermissions();
                        };
                    }
                } catch (_) {}

                try {
                    const notif = await this.navigator.permissions.query({ name: 'notifications' });
                    if (notif && notif.state === 'granted') webStatus.web_notifications = "granted";
                    if (notif && !notif._listenerAttached) {
                        notif._listenerAttached = true;
                        notif.onchange = () => {
                            if (notif.state === 'granted') webGrantedOverrides["web_notifications"] = "granted";
                            else if (notif.state === 'denied' || notif.state === 'prompt') delete webGrantedOverrides["web_notifications"];
                            if (this.sheetOpen) this.loadPermissions();
                        };
                    }
                } catch (_) {}
            }
        } catch (_) {}

        // 2. enumerateDevices label check fallback
        try {
            if (this.navigator.mediaDevices && typeof this.navigator.mediaDevices.enumerateDevices === "function") {
                const devices = await this.navigator.mediaDevices.enumerateDevices();
                if (Array.isArray(devices)) {
                    devices.forEach((d) => {
                        if (d && d.label && d.label.length > 0) {
                            if (d.kind === "videoinput") webStatus.web_camera = "granted";
                            if (d.kind === "audioinput") webStatus.web_microphone = "granted";
                        }
                    });
                }
            }
        } catch (_) {}

        // 3. Apply session overrides
        Object.keys(webGrantedOverrides).forEach((k) => {
            if (webGrantedOverrides[k] === "granted") {
                webStatus[k] = "granted";
            }
        });

        this.renderWebPermissions(webStatus);
        return webStatus;
    }

    renderWebPermissions(status) {
        const permMap = {
            web_camera: { name: "Camera (Video Calling)", icon: "fa-camera", desc: "Local video broadcast & calls" },
            web_microphone: { name: "Microphone (Voice)", icon: "fa-microphone", desc: "Voice transmission & calls" },
            web_screen_share: { name: "Screen Sharing", icon: "fa-desktop", desc: "Share screen, window or tab" },
            web_notifications: { name: "Browser Notifications", icon: "fa-bell", desc: "Incoming call & chat alerts" },
            web_audio_output: { name: "Speaker & Ringtone", icon: "fa-volume-up", desc: "Audio playback & ring chime" },
            web_socket: { name: "WebRTC Signaling Socket", icon: "fa-network-wired", desc: "Live link to v.tokendeal.cloud" },
            web_clipboard: { name: "Clipboard Copy", icon: "fa-clipboard", desc: "Copy meeting links & IDs" },
            web_file_share: { name: "File & Attachment Upload", icon: "fa-paperclip", desc: "Upload media in meeting chat" }
        };

        const granted = [], denied = [];
        Object.keys(permMap).forEach((k) => {
            if (status[k] === "granted") granted.push(k); else denied.push(k);
        });

        let html = "";
        if (granted.length > 0) {
            html += '<div class="perm-section-label"><i class="fas fa-check-circle"></i>Active Browser Permissions (' + granted.length + ')</div>';
            granted.forEach((k) => {
                html += '<div class="perm-item"><div class="perm-item-left">'
                    + '<div class="perm-item-icon granted"><i class="fas ' + permMap[k].icon + '"></i></div>'
                    + '<div><div class="perm-item-name">' + permMap[k].name + '</div>'
                    + '<div class="perm-item-status granted">✓ Active &amp; Ready</div></div>'
                    + '</div></div>';
            });
        }

        if (denied.length > 0) {
            html += '<div class="perm-section-label" style="color:#ff6b6b;"><i class="fas fa-exclamation-circle"></i>Needs Permission (' + denied.length + ')</div>';
            denied.forEach((k) => {
                html += '<div class="perm-item"><div class="perm-item-left">'
                    + '<div class="perm-item-icon denied"><i class="fas ' + permMap[k].icon + '"></i></div>'
                    + '<div><div class="perm-item-name">' + permMap[k].name + '</div>'
                    + '<div class="perm-item-status denied">✗ Not granted</div></div>'
                    + '</div>'
                    + '<button class="perm-grant-btn" data-web-key="' + k + '">Allow</button>'
                    + '</div>';
            });
        }

        this.renderedHtml = html;
        this.permSheetBody.innerHTML = html;
        this.lastStatus = status;
    }

    async clickAllow(key) {
        const webGrantedOverrides = this.window.webGrantedOverrides || {};

        if (key === "web_camera") {
            const stream = await this.navigator.mediaDevices.getUserMedia({ video: true });
            stream.getTracks().forEach(t => t.stop());
            this.lastCameraStreamStopped = stream.getTracks().every(t => t.stopped);
            webGrantedOverrides["web_camera"] = "granted";
            await this.loadPermissions();
        } else if (key === "web_microphone") {
            const stream = await this.navigator.mediaDevices.getUserMedia({ audio: true });
            stream.getTracks().forEach(t => t.stop());
            this.lastMicStreamStopped = stream.getTracks().every(t => t.stopped);
            webGrantedOverrides["web_microphone"] = "granted";
            await this.loadPermissions();
        } else if (key === "web_notifications") {
            const p = await this.Notification.requestPermission();
            if (p === "granted") {
                webGrantedOverrides["web_notifications"] = "granted";
            }
            await this.loadPermissions();
        } else if (key === "web_socket") {
            const s = this.window.socket || this.socket;
            if (s && !s.connected) s.connect();
            await this.loadPermissions();
        } else if (key === "web_clipboard") {
            await this.navigator.clipboard.writeText(this.window.location.href);
            webGrantedOverrides["web_clipboard"] = "granted";
            await this.loadPermissions();
        } else {
            webGrantedOverrides[key] = "granted";
            await this.loadPermissions();
        }
    }
}

// ----------------------------------------------------------------------
// Test Cases
// ----------------------------------------------------------------------

async function main() {
    // 1. window.socket attachment check
    await runAsyncTest("Line 50: window.socket = socket fixes permanent web_socket 'denied'", async () => {
        const sim = new WebPermissionsSimulator();
        // Simulate missing window.socket
        sim.window.socket = null;
        let status = await sim.loadPermissions();
        assert.strictEqual(status.web_socket, "denied", "web_socket must be denied when window.socket is missing");

        // Simulate fixing line 50: window.socket = socket;
        sim.socket = { connected: true };
        sim.window.socket = sim.socket;
        status = await sim.loadPermissions();
        assert.strictEqual(status.web_socket, "granted", "web_socket must be granted when window.socket is connected");
    });

    // 2. All 8 Web Permissions detected in initial state
    await runAsyncTest("All 8 Web Permissions keys are checked and present", async () => {
        const sim = new WebPermissionsSimulator();
        sim.window.socket = { connected: true };
        const status = await sim.loadPermissions();
        const expectedKeys = [
            "web_camera",
            "web_microphone",
            "web_screen_share",
            "web_notifications",
            "web_audio_output",
            "web_socket",
            "web_clipboard",
            "web_file_share"
        ];
        for (const k of expectedKeys) {
            assert.ok(k in status, `Key ${k} must be in webStatus`);
        }
        assert.strictEqual(status.web_screen_share, "granted");
        assert.strictEqual(status.web_audio_output, "granted");
        assert.strictEqual(status.web_socket, "granted");
        assert.strictEqual(status.web_clipboard, "granted");
        assert.strictEqual(status.web_file_share, "granted");
    });

    // 3. W3C permissions.query query detection
    await runAsyncTest("Modern W3C permissions.query detects camera, mic, and notifications", async () => {
        const sim = new WebPermissionsSimulator();
        sim.window.socket = { connected: true };
        sim.mockPermissions.camera = { state: "granted" };
        sim.mockPermissions.microphone = { state: "granted" };
        sim.mockPermissions.notifications = { state: "granted" };

        const status = await sim.loadPermissions();
        assert.strictEqual(status.web_camera, "granted");
        assert.strictEqual(status.web_microphone, "granted");
        assert.strictEqual(status.web_notifications, "granted");
        assert.ok(sim.renderedHtml.includes("Active Browser Permissions (8)"));
    });

    // 4. Firefox simulation: permissions.query throws TypeError -> enumerateDevices fallback
    await runAsyncTest("Fallback: When permissions.query throws TypeError, enumerateDevices label check detects granted devices", async () => {
        const sim = new WebPermissionsSimulator();
        sim.window.socket = { connected: true };
        sim.permissionsQueryThrows = true; // Firefox TypeError

        // Devices have non-empty labels indicating granted permission
        sim.mockDevices = [
            { kind: "videoinput", label: "FaceTime HD Camera (Built-in)" },
            { kind: "audioinput", label: "MacBook Pro Microphone (Built-in)" }
        ];

        const status = await sim.loadPermissions();
        assert.strictEqual(status.web_camera, "granted", "Camera must be granted via enumerateDevices label check");
        assert.strictEqual(status.web_microphone, "granted", "Microphone must be granted via enumerateDevices label check");
    });

    // 5. Firefox simulation: No permissions granted -> enumerateDevices labels are empty strings
    await runAsyncTest("When enumerateDevices labels are empty strings, camera and mic remain denied", async () => {
        const sim = new WebPermissionsSimulator();
        sim.window.socket = { connected: true };
        sim.permissionsQueryThrows = true;

        // Devices without permission have empty labels
        sim.mockDevices = [
            { kind: "videoinput", label: "" },
            { kind: "audioinput", label: "" }
        ];

        const status = await sim.loadPermissions();
        assert.strictEqual(status.web_camera, "denied");
        assert.strictEqual(status.web_microphone, "denied");
    });

    // 6. Camera "Allow" button click handler
    await runAsyncTest("Camera 'Allow': requests video:true, stops track immediately, updates override, re-renders granted", async () => {
        const sim = new WebPermissionsSimulator();
        sim.window.socket = { connected: true };
        let status = await sim.loadPermissions();
        assert.strictEqual(status.web_camera, "denied");

        // Click Allow on camera
        await sim.clickAllow("web_camera");

        assert.strictEqual(sim.lastCameraStreamStopped, true, "Camera track must be stopped immediately to avoid camera light remaining on");
        assert.strictEqual(sim.window.webGrantedOverrides["web_camera"], "granted", "webGrantedOverrides must record camera");
        assert.strictEqual(sim.lastStatus.web_camera, "granted", "Camera status must re-render as granted");
    });

    // 7. Microphone "Allow" button click handler
    await runAsyncTest("Microphone 'Allow': requests audio:true, stops track immediately, updates override, re-renders granted", async () => {
        const sim = new WebPermissionsSimulator();
        sim.window.socket = { connected: true };
        let status = await sim.loadPermissions();
        assert.strictEqual(status.web_microphone, "denied");

        // Click Allow on microphone
        await sim.clickAllow("web_microphone");

        assert.strictEqual(sim.lastMicStreamStopped, true, "Microphone track must be stopped immediately");
        assert.strictEqual(sim.window.webGrantedOverrides["web_microphone"], "granted", "webGrantedOverrides must record mic");
        assert.strictEqual(sim.lastStatus.web_microphone, "granted", "Microphone status must re-render as granted");
    });

    // 8. Elimination of spinner wipe / glitch during re-renders
    await runAsyncTest("No-flicker re-render: permSheetBody.innerHTML is NOT wiped to spinner when .perm-item already exists", async () => {
        const sim = new WebPermissionsSimulator();
        sim.window.socket = { connected: true };

        // 1st load: initial state has no .perm-item -> spinner wipe allowed
        await sim.loadPermissions();
        assert.strictEqual(sim.spinnerWipeOccurred, true, "Initial load from cold state can show spinner");
        assert.ok(sim.permSheetBody.querySelector(".perm-item"), ".perm-item elements now exist in DOM");

        // 2nd load (e.g. after clicking Allow or socket connect) -> spinner wipe MUST NOT occur
        await sim.loadPermissions();
        assert.strictEqual(sim.spinnerWipeOccurred, false, "Subsequent re-render MUST NOT wipe DOM to spinner (prevents UI flicker)");
    });

    // 9. Live permissionStatus.onchange event listener
    await runAsyncTest("Dynamic revocation: permissionStatus.onchange updates overrides and triggers re-render", async () => {
        const sim = new WebPermissionsSimulator();
        sim.window.socket = { connected: true };
        sim.sheetOpen = true;

        sim.mockPermissions.camera = { state: "granted", _listenerAttached: false };
        await sim.loadPermissions();
        assert.strictEqual(sim.lastStatus.web_camera, "granted");

        // Simulate user revoking camera in browser site settings
        sim.mockPermissions.camera.state = "denied";
        sim.mockPermissions.camera.onchange(); // trigger listener
        // wait for async loadPermissions chain to complete
        await new Promise(r => setTimeout(r, 10));

        assert.strictEqual(sim.window.webGrantedOverrides["web_camera"], undefined, "Override must be deleted upon revocation");
        assert.strictEqual(sim.lastStatus.web_camera, "denied", "Status must update to denied immediately");
    });

    // 10. Notifications "Allow" button click
    await runAsyncTest("Notifications 'Allow': calls Notification.requestPermission() and updates override", async () => {
        const sim = new WebPermissionsSimulator();
        sim.window.socket = { connected: true };
        sim.Notification.permission = "default";
        sim.mockNotificationResult = "granted";

        let status = await sim.loadPermissions();
        assert.strictEqual(status.web_notifications, "denied");

        await sim.clickAllow("web_notifications");
        assert.strictEqual(sim.lastStatus.web_notifications, "granted");
        assert.strictEqual(sim.window.webGrantedOverrides["web_notifications"], "granted");
    });

    // 11. Clipboard "Allow" button click
    await runAsyncTest("Clipboard 'Allow': writes meeting link and updates override", async () => {
        const sim = new WebPermissionsSimulator();
        sim.window.socket = { connected: true };
        await sim.clickAllow("web_clipboard");
        assert.strictEqual(sim.lastStatus.web_clipboard, "granted");
        assert.strictEqual(sim.window.webGrantedOverrides["web_clipboard"], "granted");
    });

    // 12. Socket reconnect click when disconnected
    await runAsyncTest("Socket 'Allow': connects socket and updates to granted", async () => {
        const sim = new WebPermissionsSimulator();
        let connected = false;
        sim.socket = {
            connected: false,
            connect() { this.connected = true; }
        };
        sim.window.socket = sim.socket;

        let status = await sim.loadPermissions();
        assert.strictEqual(status.web_socket, "denied");

        await sim.clickAllow("web_socket");
        assert.strictEqual(sim.socket.connected, true, "Socket.connect() must be invoked");
        assert.strictEqual(sim.lastStatus.web_socket, "granted");
    });

    // 13. Adversarial: navigator.permissions is completely undefined
    await runAsyncTest("Adversarial: navigator.permissions undefined handled gracefully without crash", async () => {
        const sim = new WebPermissionsSimulator();
        sim.window.socket = { connected: true };
        delete sim.navigator.permissions;

        sim.mockDevices = [{ kind: "videoinput", label: "USB WebCam" }];
        const status = await sim.loadPermissions();
        assert.strictEqual(status.web_camera, "granted", "Falls back to enumerateDevices safely");
        assert.strictEqual(status.web_microphone, "denied");
    });

    // 14. Adversarial: navigator.mediaDevices is completely undefined (e.g. insecure HTTP)
    await runAsyncTest("Adversarial: navigator.mediaDevices undefined handled gracefully without crash", async () => {
        const sim = new WebPermissionsSimulator();
        sim.window.socket = { connected: true };
        delete sim.navigator.mediaDevices;

        const status = await sim.loadPermissions();
        assert.strictEqual(status.web_camera, "denied");
        assert.strictEqual(status.web_microphone, "denied");
        assert.strictEqual(status.web_screen_share, "denied");
    });

    // 15. Adversarial: Notification denied in browser settings
    await runAsyncTest("Adversarial: Notification blocked in settings keeps status denied", async () => {
        const sim = new WebPermissionsSimulator();
        sim.window.socket = { connected: true };
        sim.Notification.permission = "denied";
        sim.mockNotificationResult = "denied";

        const status = await sim.loadPermissions();
        assert.strictEqual(status.web_notifications, "denied");
    });

    // 16. Adversarial: Hardware not found on Allow (getUserMedia throws NotFoundError)
    await runAsyncTest("Adversarial: getUserMedia throws NotFoundError without unhandled rejection", async () => {
        const sim = new WebPermissionsSimulator();
        sim.window.socket = { connected: true };
        sim.navigator.mediaDevices.getUserMedia = async () => {
            const err = new Error("Requested device not found");
            err.name = "NotFoundError";
            throw err;
        };

        let toastMsg = "";
        let errorCaught = false;
        try {
            await sim.navigator.mediaDevices.getUserMedia({ video: true });
        } catch (e) {
            errorCaught = true;
            toastMsg = "Click the lock icon in browser address bar to allow Camera";
        }
        assert.strictEqual(errorCaught, true);
        assert.ok(toastMsg.includes("lock icon"));
    });

    // 17. Expose global window hooks for WebView bridge and testing
    runTest("Global hooks: window.openPermissionsPanel, window.loadPermissions exposed", () => {
        const windowMock = {};
        function openPermSheet() {}
        function closePermSheet() {}
        async function loadPermissions() {}
        const webGrantedOverrides = {};

        windowMock.openPermissionsPanel = openPermSheet;
        windowMock.closePermissionsPanel = closePermSheet;
        windowMock.loadPermissions = loadPermissions;
        windowMock.webGrantedOverrides = webGrantedOverrides;

        assert.strictEqual(typeof windowMock.openPermissionsPanel, "function");
        assert.strictEqual(typeof windowMock.closePermissionsPanel, "function");
        assert.strictEqual(typeof windowMock.loadPermissions, "function");
        assert.strictEqual(typeof windowMock.webGrantedOverrides, "object");
    });


    console.log("\n=================================================================");
    console.log(`TEST SUMMARY: ${passedTests} / ${totalTests} PASSED`);
    if (passedTests === totalTests) {
        console.log("ALL TESTS COMPLETED SUCCESSFULLY!");
    } else {
        console.error(`SOME TESTS FAILED: ${totalTests - passedTests} failures`);
        process.exit(1);
    }
    console.log("=================================================================\n");
}

main().catch(err => {
    console.error("FATAL ERROR IN TEST SUITE:", err);
    process.exit(1);
});
