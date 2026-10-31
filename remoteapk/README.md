# VRemote Companion — Android Screen Share & Live Remote Control

A dedicated, lightweight (~3 MB) native Android application that bridges seamlessly with **https://v.tokendeal.cloud** WebRTC video calling.

## 🌟 Key Capabilities
1. **Full Android OS Screen Sharing**:
   - Uses Android's official `MediaProjection` API.
   - Bypasses mobile browser sandbox restrictions (which block Chrome Android from capturing OS screens).
   - High-definition 1080p/720p hardware-accelerated WebRTC VP8/H.264 video encoding.
2. **True Remote Touch & Gesture Control**:
   - Built-in `AccessibilityService` with `dispatchGesture`.
   - Desktop user can tap, click, swipe, and interact directly with the phone screen over WebRTC DataChannel (`remote-control`).
3. **1-Click Deep Linking**:
   - Launched directly from web browser: `vremote://connect?room=<ROOM_ID>&server=https://v.tokendeal.cloud`
   - Auto-fills room details and starts in 1 tap.

---

## 📁 Project Structure
```
remoteapk/
├── app/
│   ├── build.gradle
│   └── src/
│       └── main/
│           ├── AndroidManifest.xml
│           ├── java/com/tokendeal/vremote/
│           │   ├── MainActivity.java                 // UI, permissions & deep-link handler
│           │   ├── RemoteAccessibilityService.java   // Injects taps & gestures from desktop
│           │   ├── ScreenCaptureService.java         // Foreground MediaProjection service
│           │   └── WebRTCCompanion.java              // Socket.io signaling & WebRTC DataChannel
│           └── res/
│               ├── layout/activity_main.xml          // Dark sleek native UI
│               ├── values/                           // Colors, strings, themes
│               └── xml/accessibility_service_config.xml
├── build.gradle
├── settings.gradle
└── README.md
```

---

## 🛠️ How to Build APK

### Option 1: Android Studio
1. Open Android Studio.
2. Select **Open** and choose the `remoteapk/` directory.
3. Click **Build** -> **Build Bundle(s) / APK(s)** -> **Build APK(s)**.
4. The generated `.apk` will be in:
   `app/build/outputs/apk/release/app-release-unsigned.apk`

### Option 2: Command Line (Gradle)
```bash
cd remoteapk
./gradlew assembleRelease
# Or debug build:
./gradlew assembleDebug
```

### Option 3: Automated GitHub Actions
Pushing to GitHub triggers `.github/workflows/build-apk.yml`, automatically compiling `vremote.apk` and placing it in releases and `public/downloads/vremote.apk`.

---

## 📱 How It Connects to Web Calls

1. **User on Mobile Chrome**:
   - In a video call, taps **Share Screen**.
   - A modal appears offering:
     - **"Open VRemote App"** (via `vremote://connect?room=...`)
     - **"Download APK"** (from `https://v.tokendeal.cloud/downloads/vremote.apk`)
2. **On Desktop Caller's Screen**:
   - Desktop user sees the phone's live screen.
   - When the desktop user clicks on the video, the web app calculates normalized coordinates:
     ```json
     { "type": "tap", "x": 0.52, "y": 0.41 }
     ```
   - Sends it over the WebRTC `remote-control` DataChannel.
   - The Android app dispatches a real touch gesture onto the phone at that exact point.
