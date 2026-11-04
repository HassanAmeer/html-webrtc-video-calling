# Project: VRemote WebRTC Unattended Background, Permissions & Security Hardening

## Architecture
- **Web Client**: Vanilla JavaScript, HTML5, CSS3 served statically from `/public` and `/app` (strict 1:1 directory parity). Interfaces with WebSocket (Socket.io) and WebRTC PeerConnection APIs.
- **Server**: Node.js Express server (`server.js`) with Socket.io signaling, device registry (`devices.json`), and live runtime log collector (`/api/logs`).
- **Android App**: Java-based native Android app (`remoteapk/app/src/main/java/com/tokendeal/vremote/`) targeting SDK 34, using Android Accessibility Service (`RemoteAccessibilityService`), Foreground Service (`ScreenCaptureService`, `BackgroundKeepAliveService`), WebRTC (`WebRTCCompanion`), and WebView bridge (`MainActivity`).
- **Data & Signaling Flow**: Web client initiates registered device actions via `auto-command` over Socket.io -> Server routes to target Android device's persistent background accessibility socket -> Android executes headless commands or establishes reverse WebRTC connection -> Logs emitted via `client-log` / `AppLog` to Server runtime log buffer.

## Feature Inventory
| # | Feature | Description | Milestone | Source |
|---|---------|-------------|-----------|--------|
| F1 | Accessibility Status Check | Check `Settings.Secure.ENABLED_ACCESSIBILITY_SERVICES` and `RemoteAccessibilityService.isServiceRunning()` | M1 | ORIGINAL_REQUEST R1 |
| F2 | Accessibility Dialog Permanent Suppression | Store `has_prompted_accessibility` in `SharedPreferences` ("VRemoteDevicePrefs") so dialog never reappears once acknowledged or if service is enabled | M1 | ORIGINAL_REQUEST R1 |
| F3 | Android 8 Permissions Detection | Real ContextCompat/Settings checks (`Settings.Secure`, `PowerManager`, `Settings.canDrawOverlays`, `NotificationManagerCompat`, `POST_NOTIFICATIONS` manifest) | M2 | ORIGINAL_REQUEST R2 |
| F4 | Web 8 Permissions Detection | Web Permissions API queries (`camera`, `microphone`, `notifications`, `getDisplayMedia`, enumerateDevices label checks, socket attachment) | M2 | ORIGINAL_REQUEST R2 |
| F5 | Real-Time Active Permissions UI | Immediate UI update moving granted permissions to Active Permissions with green checkmark without reload glitch or DOM flicker | M2 | ORIGINAL_REQUEST R2 |
| F6 | Unattended Background Command Handling | Background execution for Audio Call, Video Call, Screen Sharing, Remote Touch Control, Media & Gallery browsing without foreground UI lock | M3 | ORIGINAL_REQUEST R3 |
| F7 | Suppression of Force-Launch Phone UI | Prevent `wakeUpAndLaunch` from turning screen on / force-launching `MainActivity` when already in memory; immediate backgrounding via `moveTaskToBack(true)` | M3 | ORIGINAL_REQUEST R3 |
| F8 | Live Runtime Logging Across Full Stack | Unify logging (`AppLog`, `window.sendClientLog`, `addRuntimeLog`) across Android, Server, and Web for all commands, sockets, and WebRTC states | M3 | ORIGINAL_REQUEST R3 |
| F9 | Security PIN Auto-Unlock Prevention | Prevent auto-login or auto-dismiss in `securityPinInput` on typing digits (including 7861) or pressing Enter | M4 | ORIGINAL_REQUEST R4 |
| F10 | Strict 1200ms Hold-To-Unlock Flow | Require holding `btnSecurityBack` for full 1200ms (`HOLD_SECURITY_MS`) with PIN 7861; wrong PIN or quick tap shows "Error: Try again later after 10 minutes." with shake | M4 | ORIGINAL_REQUEST R4 |
| F11 | Comprehensive E2E Verification & Adversarial Hardening | Automated test harness covering Tiers 1-4 tests for R1-R4 and Tier 5 adversarial stress testing | M5 | ORIGINAL_REQUEST R1-R4 |

## Milestones
| # | Name | Scope | Dependencies | Status |
|---|------|-------|-------------|--------|
| M1 | Accessibility Prompt Permanent Suppression & Accurate Detection | `MainActivity.java`, `RemoteAccessibilityService.java`, `SharedPreferences` | none | DONE |
| M2 | Permissions Sheet Real-Time Detection & Updates (Android + Web) | `MainActivity.java`, `AndroidManifest.xml`, `public/js/main.js`, `app/js/main.js` | none | IN_PROGRESS |
| M3 | Unattended Background Execution & Live Runtime Logging | `RemoteAccessibilityService.java`, `BackgroundKeepAliveService.java`, `MainActivity.java`, `server.js`, `AppLogs.java`, `public/js/main.js`, `app/js/main.js` | M1 | PLANNED |
| M4 | Strict Hold-To-Unlock Security Flow | `public/js/main.js`, `app/js/main.js`, `public/css/style.css`, `app/css/style.css`, `public/index.html`, `app/index.html` | none | PLANNED |
| M5 | E2E Testing Suite & Adversarial Coverage Hardening | Test runner, Tiers 1-4 test cases, `TEST_READY.md`, Tier 5 adversarial verification | M1, M2, M3, M4 | PLANNED |

## Interface Contracts
### Web Client ↔ Server
- Socket events:
  - `auto-command`: `{ targetDeviceId, command, caller, cameraChoice }`
  - `auto-command-dispatched`: `{ command, targetDeviceId, success }`
  - `client-log`: `{ source: "browser", level, tag, msg, timestamp }`
  - `register-device`: `{ role, deviceId, platform, ... }`
- HTTP endpoints:
  - `GET /api/logs`: Returns `{ logs: [...], total: N }`
  - `DELETE /api/logs`: Clears logs

### Android App ↔ Server
- Socket events:
  - `register-device`: `role: "accessibility_service"` or `"background_service"`, `deviceId`
  - `auto-command`: Received on background socket, processed asynchronously
  - `client-log`: Dispatched from `AppLogs.java` to active server sockets
  - WebRTC signaling: `offer`, `answer`, `candidate`

### Android App ↔ WebView Bridge
- `window.VRemoteNative.getPermissionsStatus()`: returns JSON string with all 8 permission statuses (`granted` | `denied`)
- `window.VRemoteNative.requestPermission(key)`: launches system intent or requests runtime permission
- WebView reload hook: `window.loadPermissions()` callable on Activity resume

## Code Layout
- Android App: `remoteapk/app/src/main/java/com/tokendeal/vremote/`
  - `MainActivity.java`: UI container, WebView bridge, permission queries, auto-command router
  - `RemoteAccessibilityService.java`: Accessibility service, 24/7 background socket, auto-accept dialogs, remote touch
  - `BackgroundKeepAliveService.java`: Foreground keep-alive service
  - `WebRTCCompanion.java`: WebRTC peer connection, media streaming, data channels
  - `AppLogs.java`: Unified logging
  - `remoteapk/app/src/main/AndroidManifest.xml`: Permissions and service declarations
- Web Client (Strict mirror: `public/` and `app/`):
  - `index.html`: UI structure, permissions sheet, security lock screen
  - `css/style.css`: Styles, shake animations, permission badges
  - `js/main.js`: Client application logic, Web Permissions API, Security PIN hold-to-unlock, WebRTC client
- Server:
  - `server.js`: Express server, Socket.io signaling, device registry, log buffer
  - `devices.json`: Device registration store
- Tests:
  - `tests/`: Automated test suite for server, web client, permissions, and security flow
