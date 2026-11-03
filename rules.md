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

- **Point 2: Strict Separation of Call vs. Screen Sharing:**
  - When initiating or receiving an Audio Call or Video Call from the website (or auto-calling a deal partner with matching UID):
    - Under NO circumstances should any "Sharing", "End Sharing", or screen sharing UI appear.
    - The floating button `#floating-end-stream-btn` ("End Sharing") MUST ONLY be displayed when actual screen sharing (`isScreenSharing || screenPeerConnection`) is active.
    - Regular audio and video calls MUST ONLY show "End Call" (`#floating-end-call-btn` or dock `#end-call-btn`).
    - Incoming call offers between website peers or matching UID partners must never be falsely classified as registered device calls (`from.length >= 8` check is strictly forbidden).

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
    - If the user releases or taps quickly before 450ms, the icon MUST trigger a shake animation (`.shake-error`), subtle vibration, and display toast *"Hold icon to accept call"*.
    - Reaching the full 450ms threshold vibrates with confirmation and accepts the call.
  - **Floating End Call Button Exclusion During Incoming Call:**
    - The floating red End Call button (`#floating-end-call-btn`) MUST NEVER appear while an incoming call alert is ringing (`incomingCallData`).
    - The incoming call alert bar (`#incoming-call-bar`) has its own dedicated minimal Accept and Decline icons. Showing the floating End Call button simultaneously causes it to overlap the incoming alert bar.
    - `#floating-end-call-btn` is ONLY shown during outgoing calls (`callingPeer`) or actively connected calls (`activePeer`).
