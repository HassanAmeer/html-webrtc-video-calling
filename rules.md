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
- On Android, `MainActivity.stopAllMediaAndFinish()` MUST forcefully stop camera capturers, stop `ScreenCaptureService`, dispose texture helpers, and terminate the activity via `finishAndRemoveTask()`, instantly removing Android's green camera privacy indicator.

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
