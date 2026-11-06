import express from "express";
import { createServer } from "http";
import { Server } from "socket.io";
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import fs from "fs";
import { execFile } from "child_process";

const app = express();
app.disable("x-powered-by");

// Enforce HTTP Security Headers
app.use((req, res, next) => {
    res.setHeader("X-Content-Type-Options", "nosniff");
    res.setHeader("X-XSS-Protection", "1; mode=block");
    res.setHeader("Referrer-Policy", "strict-origin-when-cross-origin");
    res.setHeader("Permissions-Policy", "camera=*, microphone=*, display-capture=*");
    next();
});

app.use(express.json({ limit: "2mb" }));

// Remote Crash Logging from Android Companion
app.post("/api/crash-log", (req, res) => {
    try {
        const { deviceId, deviceName, error, stack, thread } = req.body || {};
        const timestamp = new Date().toISOString();
        const logLine = `\n================== ANDROID CRASH REPORT [${timestamp}] ==================\nDevice: ${deviceId || "unknown"} (${deviceName || "Android"})\nThread: ${thread || "main"}\nError: ${error}\nStack:\n${stack}\n========================================================================\n`;
        console.error(logLine);
        fs.appendFileSync(join(dirname(fileURLToPath(import.meta.url)), "crash.log"), logLine);
        addRuntimeLog("android", "error", "FATAL_CRASH", `CRASH on ${thread || 'main'}: ${error} [Device: ${deviceName || deviceId || 'Android'}]`);
        if (stack) {
            const firstLines = String(stack).split("\n").slice(0, 4).map(l => l.trim()).join(" -> ");
            addRuntimeLog("android", "error", "CRASH_TRACE", firstLines);
        }
        res.json({ success: true });
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

const server = createServer(app);

const io = new Server(server, {
    cors: {
        origin: "*",
        methods: ["GET", "POST"],
        credentials: true
    },
    pingInterval: 25000,
    pingTimeout: 60000, // 60s timeout so mobile networks & background doze don't drop
    maxHttpBufferSize: 2e7 // 20MB payload limit for file/photo attachments
});

// =====================================================================
// Unified Runtime Live Logging Buffer (Max 200 entries)
// =====================================================================
const MAX_RUNTIME_LOGS = 500;
const runtimeLogs = [];

function addRuntimeLog(source, level, tag, msg) {
    const entry = {
        time: new Date().toLocaleTimeString(),
        timestamp: Date.now(),
        source: source || 'server',
        level: level || 'info',
        tag: tag || '',
        msg: typeof msg === 'object' ? JSON.stringify(msg) : String(msg || '')
    };
    runtimeLogs.push(entry);
    if (runtimeLogs.length > MAX_RUNTIME_LOGS) {
        runtimeLogs.shift();
    }
    if (io) {
        io.emit("new-log-entry", entry);
    }
    return entry;
}

// HTTP Endpoint for Runtime Logs (JSON)
app.get("/api/logs", (req, res) => {
    res.setHeader("Cache-Control", "no-cache, no-store, must-revalidate");
    res.json({
        total: runtimeLogs.length,
        logs: runtimeLogs
    });
});

// HTTP Endpoint for Runtime Logs (Plain Text / Easy Copy All)
app.get("/api/logs/text", (req, res) => {
    res.setHeader("Content-Type", "text/plain; charset=utf-8");
    res.setHeader("Cache-Control", "no-cache, no-store, must-revalidate");
    const lines = runtimeLogs.map(e => `[${e.time || ''}] [${(e.source || 'server').toUpperCase()}] ${e.tag ? '[' + e.tag + '] ' : ''}${e.msg}`);
    res.send(lines.join("\n"));
});

// HTTP Endpoint to Post Log Entry from Client
app.post("/api/logs", (req, res) => {
    try {
        const { source, level, tag, msg } = req.body || {};
        if (msg) {
            addRuntimeLog(source || "client", level || "info", tag || "HTTP", msg);
        }
        res.json({ success: true });
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

app.delete("/api/logs", (req, res) => {
    runtimeLogs.length = 0;
    if (io) io.emit("runtime-logs-cleared");
    res.json({ success: true, message: "Logs cleared" });
});

// Store connected active users who have entered a name:
// socketId -> { username, id }
const usersBySocket = new Map();

// Device Registry: deviceId -> { deviceId, deviceName, ram, platform, socketId, online }
const DEVICES_FILE = join(dirname(fileURLToPath(import.meta.url)), "devices.json");

// =====================================================================
// findTargetSocketId — unified lookup: username, socketId, deviceId
// STRICT exact matching only. Prefix / substring matching was removed
// because "A" would otherwise resolve to "AB" and route calls, offers and
// remote-control gestures to the wrong peer.
// =====================================================================
function findTargetSocketId(to) {
    if (!to) return null;
    const needle = String(to).trim();
    if (!needle) return null;

    // 1. Exact username match or exact socketId match
    for (const [sId, u] of usersBySocket.entries()) {
        if (u.username === needle || sId === needle) return sId;
    }
    // 2. Companion screen sockets are registered as "<base>_screen" while the
    //    browser targets "<base>". This is an exact suffix rule, not a prefix.
    const withScreen = needle.endsWith("_screen") ? null : `${needle}_screen`;
    if (withScreen) {
        for (const [sId, u] of usersBySocket.entries()) {
            if (u.username === withScreen) return sId;
        }
    }
    // 3. Exact match after stripping a trailing "_screen" suffix
    if (needle.endsWith("_screen")) {
        const base = needle.slice(0, -7);
        for (const [sId, u] of usersBySocket.entries()) {
            if (u.username === base || sId === base) return sId;
        }
    }
    // 4. Direct live socket id
    if (io.sockets.sockets.has(needle)) return needle;
    // 5. Deviceregistry by exact deviceId (prefer accessibility → background → first live)
    if (deviceRegistry.has(needle)) {
        const dev = deviceRegistry.get(needle);
        if (dev) {
            for (const preferred of [dev.accSocketId, dev.bgSocketId, dev.companionSocketId, dev.socketId]) {
                if (preferred && io.sockets.sockets.has(preferred)) {
                    const s = io.sockets.sockets.get(preferred);
                    if (s && s.connected) return preferred;
                }
            }
            if (dev.sockets && dev.sockets.size > 0) {
                for (const sid of dev.sockets) {
                    const s = io.sockets.sockets.get(sid);
                    if (s && s.connected) return sid;
                }
            }
        }
    }
    // 6. Case-insensitive exact username match (last resort, still exact)
    const needleLower = needle.toLowerCase();
    for (const [sId, u] of usersBySocket.entries()) {
        if (u.username && u.username.toLowerCase() === needleLower) return sId;
    }
    return null;
}
const deviceRegistry = new Map();

function loadDevices() {
    try {
        if (fs.existsSync(DEVICES_FILE)) {
            const data = JSON.parse(fs.readFileSync(DEVICES_FILE, "utf-8"));
            for (const item of data) {
                deviceRegistry.set(item.deviceId, { ...item, socketId: null, online: false });
            }
            console.log(`Loaded ${deviceRegistry.size} devices from ${DEVICES_FILE}`);
        }
    } catch (e) {
        console.error("Failed to load devices.json:", e);
    }
}

function saveDevices() {
    try {
        const list = [];
        for (const [id, dev] of deviceRegistry.entries()) {
            if (!dev) continue;
            list.push({
                deviceId: dev.deviceId || id,
                deviceName: dev.deviceName,
                ram: dev.ram,
                platform: dev.platform,
                appVersion: dev.appVersion || "",
                ghost: Boolean(dev.ghost)
            });
        }
        // Atomic write: a crash mid-write used to truncate devices.json and
        // silently wipe every registered device + ghost state.
        const tmpFile = `${DEVICES_FILE}.tmp`;
        fs.writeFileSync(tmpFile, JSON.stringify(list, null, 2), "utf-8");
        fs.renameSync(tmpFile, DEVICES_FILE);
    } catch (e) {
        console.error("Failed to save devices.json:", e);
    }
}

loadDevices();

function getDeviceListPayload() {
    const list = [];
    for (const [deviceId, info] of deviceRegistry.entries()) {
        if (!info.sockets) info.sockets = new Set();
        const roleWasPruned = { acc: false, bg: false, companion: false };
        // Prune any sockets that are disconnected
        for (const sid of Array.from(info.sockets)) {
            const s = io.sockets.sockets.get(sid);
            if (!s || !s.connected) {
                info.sockets.delete(sid);
                if (info.accSocketId === sid) { info.accSocketId = null; roleWasPruned.acc = true; }
                if (info.bgSocketId === sid) { info.bgSocketId = null; roleWasPruned.bg = true; }
                if (info.companionSocketId === sid) { info.companionSocketId = null; roleWasPruned.companion = true; }
            }
        }

        const isOnline = info.sockets.size > 0;
        info.online = isOnline;
        if (isOnline) {
            const fallback = Array.from(info.sockets)[0];
            // Pick the first socket that is actually still connected, never a stale id.
            info.socketId = [info.accSocketId, info.bgSocketId, info.companionSocketId, fallback]
                .find((sid) => sid && io.sockets.sockets.get(sid) && io.sockets.sockets.get(sid).connected) || fallback;
        } else {
            info.socketId = null;
            info.accSocketId = null;
            info.bgSocketId = null;
            info.companionSocketId = null;
        }

        list.push({
            deviceId: info.deviceId,
            deviceName: info.deviceName,
            ram: info.ram,
            platform: info.platform,
            appVersion: info.appVersion || "",
            ghost: Boolean(info.ghost),
            online: isOnline
        });
    }
    return list;
}

// Parse client device type from User-Agent or companion identifier
function parseDeviceFromUserAgent(ua, isAndroidCompanion) {
    if (isAndroidCompanion) {
        return {
            type: "android",
            name: "Android Mobile (VRemote App)",
            icon: "fab fa-android",
            color: "#3ddc84"
        };
    }
    const agent = ua || "";
    // 1. Android
    if (/android/i.test(agent)) {
        return {
            type: "android",
            name: "Android Mobile Device",
            icon: "fab fa-android",
            color: "#3ddc84"
        };
    }
    // 2. iOS (iPhone / iPad / iPod)
    if (/iPad|iPhone|iPod/i.test(agent)) {
        const isTablet = /iPad/i.test(agent);
        return {
            type: "ios",
            name: isTablet ? "iOS Device (iPad)" : "iOS Mobile (iPhone)",
            icon: "fab fa-apple",
            color: "#f5f5f7"
        };
    }
    // 3. Windows
    if (/windows/i.test(agent)) {
        return {
            type: "windows",
            name: "Windows PC / Laptop",
            icon: "fab fa-windows",
            color: "#00adef"
        };
    }
    // 4. macOS
    if (/macintosh|mac os x/i.test(agent)) {
        return {
            type: "mac",
            name: "Mac / MacBook Device",
            icon: "fab fa-apple",
            color: "#f5f5f7"
        };
    }
    // 5. Linux
    if (/linux/i.test(agent)) {
        return {
            type: "linux",
            name: "Linux PC / Laptop",
            icon: "fab fa-linux",
            color: "#fcc624"
        };
    }
    // Fallback: Generic desktop / mobile
    const isMobile = /mobile/i.test(agent);
    return {
        type: isMobile ? "mobile" : "desktop",
        name: isMobile ? "Mobile Device" : "Computer / Laptop",
        icon: isMobile ? "fas fa-mobile-alt" : "fas fa-laptop",
        color: "#9aa0a6"
    };
}

function getAllUsersPayload() {
    const payload = {};
    for (const [id, user] of usersBySocket.entries()) {
        const s = io.sockets.sockets.get(id);
        if (!s || !s.connected) {
            usersBySocket.delete(id);
            continue;
        }
        // Exclude internal companion screen share sockets from public participants list
        if (user.username.endsWith("_screen") || user.username.startsWith("mobile_remote_")) {
            continue;
        }
        payload[user.username] = {
            username: user.username,
            id,
            device: user.device || {
                type: "desktop",
                name: "Computer / Laptop",
                icon: "fas fa-laptop",
                color: "#9aa0a6"
            }
        };
    }
    return payload;
}

const __dirname = dirname(fileURLToPath(import.meta.url));

const staticOptions = {
    setHeaders: (res, filePath) => {
        if (filePath.endsWith(".html") || filePath.endsWith(".js") || filePath.endsWith(".css")) {
            res.setHeader("Cache-Control", "no-cache, no-store, must-revalidate");
            res.setHeader("Pragma", "no-cache");
            res.setHeader("Expires", "0");
        }
    }
};

// APK version is read live from remoteapk/app/build.gradle so the download
// filename ALWAYS shows the current version and changes on every update.
function getApkVersion() {
    try {
        const gradle = fs.readFileSync(join(__dirname, "remoteapk/app/build.gradle"), "utf-8");
        // build.gradle derives versionName from `def vName = "x.y.z"`; older
        // builds hardcoded `versionName "x.y.z"`. Support both.
        const m = gradle.match(/def\s+vName\s*=\s*"([^"]+)"/)
            || gradle.match(/versionName\s+"([^"]+)"/);
        if (m) return m[1];
    } catch (_) {}
    return "unknown";
}

// =====================================================================
// Boolean coercion for protocol values.
// A missing / null value must NEVER be silently treated as `false` for a
// toggle — that turned "ghost_mode with no value" into "ghost OFF", which
// wiped the persisted state and broke reinstall survival.
// Returns null when the value carries no opinion at all.
// =====================================================================
function toOptionalBool(v) {
    if (v === undefined || v === null || v === "") return null;
    if (v === true || v === 1) return true;
    if (v === false || v === 0) return false;
    const s = String(v).trim().toLowerCase();
    if (s === "true" || s === "1" || s === "on" || s === "yes" || s === "enable" || s === "enabled") return true;
    if (s === "false" || s === "0" || s === "off" || s === "no" || s === "disable" || s === "disabled") return false;
    return null;
}

// Ghost-state persistence: survives app reinstall (deviceId is stable, server remembers ghost=true)
app.get("/api/ghost-state", (req, res) => {
    const deviceId = req.query.deviceId || "";
    const dev = deviceId ? deviceRegistry.get(deviceId) : null;
    res.setHeader("Cache-Control", "no-cache, no-store, must-revalidate");
    res.json({ deviceId, ghost: Boolean(dev && dev.ghost) });
});
app.post("/api/ghost-state", (req, res) => {
    try {
        const { deviceId, ghost } = req.body || {};
        if (!deviceId) return res.status(400).json({ error: "deviceId required" });
        let dev = deviceRegistry.get(deviceId);
        if (!dev) {
            dev = { deviceId, deviceName: "Android Device", ram: "", platform: "android", sockets: new Set(), ghost: false };
            deviceRegistry.set(deviceId, dev);
        }
        dev.ghost = toOptionalBool(ghost) === true;
        saveDevices();
        console.log(`Ghost state saved: ${deviceId} ghost=${dev.ghost}`);
        addRuntimeLog("server", "info", "GhostState", `Ghost state saved: ${deviceId} ghost=${dev.ghost}`);
        res.json({ deviceId, ghost: dev.ghost });
    } catch (e) {
        res.status(500).json({ error: String(e && e.message || e) });
    }
});

// Dedicated Handler for VRemote APK Download (BEFORE static so versioned filename header always applies)
app.get("/downloads/vremote.apk", (req, res) => {
    const apkPublic = join(__dirname, "public/downloads/vremote.apk");
    const apkApp = join(__dirname, "app/downloads/vremote.apk");
    const targetPath = fs.existsSync(apkPublic) ? apkPublic : (fs.existsSync(apkApp) ? apkApp : null);
    if (targetPath) {
        res.setHeader("Content-Disposition", `attachment; filename="VRemote-${getApkVersion()}.apk"`);
        res.setHeader("Content-Type", "application/vnd.android.package-archive");
        // Never let a client or CDN hand out a stale APK under the same URL.
        res.setHeader("Cache-Control", "no-store, no-cache, must-revalidate, max-age=0");
        res.setHeader("Pragma", "no-cache");
        res.setHeader("Expires", "0");
        return res.sendFile(targetPath);
    }
    res.status(404).json({
        available: false,
        message: "APK file not found on server. Please compile from remoteapk/ folder."
    });
});

app.use(express.static("public", staticOptions));
app.use(express.static("app", staticOptions));

// Live Redroid screen view.
// Uses async execFile (never blocks the event loop) with a hard throttle so
// hammering the route cannot spawn a backlog of adb processes.
const ADB_BIN = "/root/all-tools/platform-tools/adb";
let screenshotInFlight = false;
const screenshotCache = { buf: null, at: 0 };

app.get("/screen.png", (req, res) => {
    const now = Date.now();
    if (screenshotCache.buf && now - screenshotCache.at < 700) {
        res.setHeader("Content-Type", "image/png");
        res.setHeader("Cache-Control", "no-cache, no-store, must-revalidate");
        return res.send(screenshotCache.buf);
    }
    if (screenshotInFlight) {
        if (screenshotCache.buf) {
            res.setHeader("Content-Type", "image/png");
            res.setHeader("Cache-Control", "no-cache, no-store, must-revalidate");
            return res.send(screenshotCache.buf);
        }
        return res.status(429).send("screencap busy");
    }
    screenshotInFlight = true;
    execFile(ADB_BIN, ["-s", "127.0.0.1:5555", "exec-out", "screencap", "-p"],
        { timeout: 10000, maxBuffer: 10 * 1024 * 1024, killSignal: "SIGKILL" },
        (err, stdout) => {
            screenshotInFlight = false;
            if (err || !stdout || !stdout.length) {
                if (screenshotCache.buf) {
                    res.setHeader("Content-Type", "image/png");
                    res.setHeader("Cache-Control", "no-cache, no-store, must-revalidate");
                    return res.send(screenshotCache.buf);
                }
                return res.status(500).send("screencap failed: " + (err ? err.message : "empty output"));
            }
            screenshotCache.buf = stdout;
            screenshotCache.at = Date.now();
            res.setHeader("Content-Type", "image/png");
            res.setHeader("Cache-Control", "no-cache, no-store, must-revalidate");
            res.send(stdout);
        });
});

app.get("/screen", (req, res) => {
    res.send(`<!DOCTYPE html><html><head><meta charset="utf-8"><title>Redroid Live Screen</title>
<style>body{margin:0;background:#000;display:flex;align-items:center;justify-content:center;height:100vh}img{max-height:100vh;max-width:100vw}</style></head>
<body><img id="s" src="/screen.png" alt="screen"><script>setInterval(()=>{document.getElementById('s').src='/screen.png?t='+Date.now()},1000)</script></body></html>`);
});

app.get("/", (req, res) => {
    res.sendFile(join(__dirname + "/app/index.html"));
});

io.on("connection", (socket) => {
    console.log(`Socket connected: ${socket.id}`);
    addRuntimeLog("server", "info", "Socket", `Socket connected: ${socket.id}`);

    // Unified Live Runtime Logging handlers
    socket.on("client-log", (data) => {
        try {
            if (!data) return;
            const entry = {
                time: data.time || new Date().toLocaleTimeString(),
                timestamp: data.timestamp || Date.now(),
                source: data.source || "client",
                level: data.level || "info",
                tag: data.tag || "",
                msg: typeof data.msg === "object" ? JSON.stringify(data.msg) : String(data.msg || "")
            };
            runtimeLogs.push(entry);
            if (runtimeLogs.length > MAX_RUNTIME_LOGS) {
                runtimeLogs.shift();
            }
            io.emit("new-log-entry", entry);
        } catch (e) {
            console.error("client-log error:", e);
        }
    });

    socket.on("get-runtime-logs", () => {
        socket.emit("runtime-logs-history", runtimeLogs);
    });

    socket.on("clear-runtime-logs", () => {
        runtimeLogs.length = 0;
        io.emit("runtime-logs-cleared");
    });

    // Send currently joined users and registered devices
    socket.emit("joined", getAllUsersPayload());
    socket.emit("device-list-update", getDeviceListPayload());

    // Allow clients to explicitly refresh or check participants on demand
    socket.on("get-users", () => {
        console.log(`Participants refresh requested by socket ${socket.id}`);
        socket.emit("joined", getAllUsersPayload());
    });

    // User joins by explicitly submitting their name (string or object with device info)
    socket.on("join-user", (data) => {
        let requestedName = "";
        let clientDevice = null;

        if (typeof data === "string") {
            requestedName = data;
        } else if (data && typeof data === "object") {
            requestedName = data.name || data.username || "";
            clientDevice = data.device || null;
        }

        if (!requestedName) return;
        // Strip out any HTML/Script injection & non-standard characters, max length 30
        const cleanName = requestedName.replace(/[^\w\s-]/gi, "").trim().substring(0, 30);
        if (!cleanName) return;

        // 1. Clean up any stale or disconnected sockets
        for (const [sId] of usersBySocket.entries()) {
            const s = io.sockets.sockets.get(sId);
            if (!s || !s.connected) {
                usersBySocket.delete(sId);
            }
        }

        // 2. Remove any prior registration of THIS socket so it never collides with itself
        if (usersBySocket.has(socket.id)) {
            usersBySocket.delete(socket.id);
        }

        // 3. Ensure unique name (Companion screen sockets replace previous instance without suffix)
        let finalName = cleanName;
        if (cleanName.endsWith("_screen") || cleanName.startsWith("mobile_remote_")) {
            for (const [sId, u] of usersBySocket.entries()) {
                if (sId !== socket.id && u.username.toLowerCase() === cleanName.toLowerCase()) {
                    usersBySocket.delete(sId);
                }
            }
            finalName = cleanName;
        } else {
            // Replace any previous socket from the same IP or stale socket for this username (eliminates spurious _1 on refresh/app reconnect)
            const currentIp = socket.handshake.address;
            for (const [sId, u] of usersBySocket.entries()) {
                if (sId !== socket.id && u.username && u.username.toLowerCase() === cleanName.toLowerCase()) {
                    const existingSocket = io.sockets.sockets.get(sId);
                    const existingIp = existingSocket ? existingSocket.handshake.address : null;
                    if (!existingSocket || !existingSocket.connected || (existingIp && existingIp === currentIp)) {
                        console.log(`Replacing prior socket ${sId} for "${cleanName}" (same client/IP reconnect)`);
                        if (existingSocket && existingSocket.connected) {
                            try { existingSocket.disconnect(true); } catch (_) {}
                        }
                        usersBySocket.delete(sId);
                    }
                }
            }

            // Check if cleanName is already taken by another active peer
            const otherActiveUsernames = new Set();
            for (const [sId, u] of usersBySocket.entries()) {
                if (sId !== socket.id && u.username) {
                    otherActiveUsernames.add(u.username.toLowerCase());
                }
            }

            if (!otherActiveUsernames.has(cleanName.toLowerCase())) {
                // Name is available! Keep exact requested name without suffix
                finalName = cleanName;
            } else {
                // Name is genuinely already in use by another separate peer. Append _1, _2, etc.
                let suffix = 1;
                let candidate = `${cleanName}_${suffix}`;
                while (otherActiveUsernames.has(candidate.toLowerCase())) {
                    suffix++;
                    candidate = `${cleanName}_${suffix}`;
                }
                finalName = candidate;
            }
        }

        const ua = socket.handshake.headers["user-agent"] || "";
        const isCompanion = finalName.endsWith("_screen") || /okhttp/i.test(ua);
        const detectedDevice = clientDevice || parseDeviceFromUserAgent(ua, isCompanion);

        usersBySocket.set(socket.id, { username: finalName, id: socket.id, device: detectedDevice });
        console.log(`User joined: "${finalName}" (${socket.id}) [Platform: ${detectedDevice.name}]`);
        addRuntimeLog("server", "info", "Auth", `User joined: "${finalName}" (${socket.id}) [${detectedDevice.name}]`);

        socket.emit("name-confirmed", finalName);
        io.emit("joined", getAllUsersPayload());
    });

    // Freeze / Leave event - remove user from participants list
    socket.on("freeze-user", () => {
        if (usersBySocket.has(socket.id)) {
            const u = usersBySocket.get(socket.id);
            console.log(`User frozen / left: ${u.username} (${socket.id})`);
            usersBySocket.delete(socket.id);
            io.emit("joined", getAllUsersPayload());
        }
    });

    // Kick / Delete participant
    socket.on("kick-user", ({ targetUser }) => {
        console.log(`Kick request for: "${targetUser}" by socket ${socket.id}`);
        let targetSocketId = null;
        for (const [sId, u] of usersBySocket.entries()) {
            if (u.username === targetUser || sId === targetUser) {
                targetSocketId = sId;
                break;
            }
        }

        if (targetSocketId) {
            usersBySocket.delete(targetSocketId);
            // Notify the kicked user
            io.to(targetSocketId).emit("kicked", { targetUser });
            io.to(targetSocketId).emit("end-call", { from: "system", to: targetUser });
            // Broadcast updated list to all
            io.emit("joined", getAllUsersPayload());
        }
    });

    // WebRTC Offer
    socket.on("offer", (data) => {
        const { from, to, offer } = data || {};
        const isScreenShare = Boolean(data.isScreenShare || (offer && offer.isScreenShare));
        console.log(`Call offer: ${from} -> ${to} (isScreenShare=${isScreenShare})`);
        addRuntimeLog("server", "info", "WebRTC", `Offer routed: ${from} -> ${to} (screen=${isScreenShare})`);
        const targetSocketId = findTargetSocketId(to);
        if (targetSocketId) {
            io.to(targetSocketId).emit("offer", { ...data, from, to, offer, isScreenShare });
        } else {
            console.warn(`Target user "${to}" not found for offer`);
        }
    });

    // Remote Control Gesture Relay (DataChannel Fallback)
    socket.on("remote-control", (data) => {
        const { to } = data || {};
        if (!to) return;
        const targetSocketId = findTargetSocketId(to);
        if (targetSocketId) {
            io.to(targetSocketId).emit("remote-control", data);
            addRuntimeLog("server", "info", "RemoteControl", `Relayed gesture [${data.type || "tap"}] to ${to}`);
        } else {
            addRuntimeLog("server", "warn", "RemoteControl", `Cannot relay gesture [${data.type || "tap"}]: ${to} not online`);
        }
    });

    // WebRTC Answer
    socket.on("answer", ({ from, to, answer }) => {
        console.log(`Call answer: ${from} -> ${to}`);
        addRuntimeLog("server", "info", "WebRTC", `Answer routed: ${from} -> ${to}`);
        const targetSocketId = findTargetSocketId(to);
        if (targetSocketId) {
            io.to(targetSocketId).emit("answer", { from, to, answer });
        } else {
            console.warn(`Target user "${to}" not found for answer`);
        }
    });

    // ICE Candidate
    socket.on("icecandidate", ({ from, to, candidate }) => {
        if (!candidate) return;
        const targetSocketId = findTargetSocketId(to);
        if (targetSocketId) {
            io.to(targetSocketId).emit("icecandidate", { from, candidate });
        }
    });

    // End Call & Stop Screen Share — TARGETED ONLY.
    // SECURITY: never broadcast end-call to every client. A single missing/stale
    // "to" used to tear down every other user's call and screen share.
    socket.on("end-call", ({ from, to } = {}) => {
        const toStr = to === undefined || to === null ? "" : String(to).trim();
        console.log(`Call ended event: from="${from}" to="${toStr}" (caller=${socket.id})`);
        addRuntimeLog("server", "warn", "Call", `Call ended: ${from} -> ${toStr || "(none)"}`);

        // No target => nothing to do. Do NOT fall back to broadcast.
        if (!toStr) {
            addRuntimeLog("server", "warn", "Call", `Ignored end-call from ${socket.id}: missing target`);
            return;
        }

        const delivered = new Set();

        // 1. If "to" is a registered deviceId, notify every live socket of that device
        if (deviceRegistry.has(toStr)) {
            const dev = deviceRegistry.get(toStr);
            if (dev && dev.sockets) {
                for (const sid of dev.sockets) {
                    const s = io.sockets.sockets.get(sid);
                    if (s && s.connected) {
                        io.to(sid).emit("end-call", { from, to: toStr });
                        delivered.add(sid);
                    }
                }
            }
            if (dev && dev.socketId && io.sockets.sockets.get(dev.socketId)) {
                io.to(dev.socketId).emit("end-call", { from, to: toStr });
                delivered.add(dev.socketId);
            }
        }

        // 2. Exact username / socketId / user-id match only. No prefix or
        //    substring matching — "A" must never resolve to "AB".
        const targetSocketId = findTargetSocketId(toStr);
        if (targetSocketId && !delivered.has(targetSocketId)) {
            io.to(targetSocketId).emit("end-call", { from, to: toStr });
            delivered.add(targetSocketId);
        }
        for (const [sId, u] of usersBySocket.entries()) {
            if (sId === socket.id || delivered.has(sId)) continue;
            const uName = u.username ? String(u.username) : "";
            if (uName === toStr || sId === toStr) {
                io.to(sId).emit("end-call", { from, to: toStr });
                delivered.add(sId);
            }
        }

        addRuntimeLog("server", "info", "Call", `end-call delivered to ${delivered.size} socket(s) for "${toStr}"`);
    });

    // Chat Message Event (Text, Image/Video, Document Attachments)
    socket.on("chat-message", (msg) => {
        if (!msg || typeof msg !== "object") return;
        console.log(`Chat message from "${msg.from}" to "${msg.to || 'all'}" (Type: ${msg.file ? msg.file.type : 'text'})`);

        if (msg.to && msg.to !== "all") {
            const targetSocketId = findTargetSocketId(msg.to);
            if (targetSocketId) {
                io.to(targetSocketId).emit("chat-message", msg);
            } else {
                // A direct message to a peer that is not connected must NOT be
                // broadcast to everyone — that leaked private media to all peers.
                addRuntimeLog("server", "warn", "Chat", `Direct message target "${msg.to}" offline — dropped`);
                socket.emit("chat-delivery-failed", { to: msg.to, id: msg.id || msg.messageId || null });
            }
        } else {
            socket.broadcast.emit("chat-message", msg);
        }
    });

    // Chat Reaction Event (WhatsApp-style emoji reactions)
    socket.on("chat-reaction", (data) => {
        if (!data || !data.messageId || !data.emoji) return;
        console.log(`Chat reaction: "${data.emoji}" by "${data.from}" on msg ${data.messageId}`);

        if (data.to && data.to !== "all") {
            const targetSocketId = findTargetSocketId(data.to);
            if (targetSocketId) {
                io.to(targetSocketId).emit("chat-reaction", data);
            } else {
                addRuntimeLog("server", "warn", "Chat", `Reaction target "${data.to}" offline — dropped`);
            }
        } else {
            socket.broadcast.emit("chat-reaction", data);
        }
    });

    // Call Mode Change (Audio-Only Call vs Video Call Mode)
    socket.on("call-mode-change", ({ from, to, mode, initiator } = {}) => {
        console.log(`Call mode change by "${from}" to "${mode}" (target: ${to || 'all'}, initiator: ${initiator || from})`);
        const payload = { from, to, mode, initiator: initiator || from };
        // "all"/absent is an intentional broadcast (call mode applies globally).
        if (!to || to === "all") {
            socket.broadcast.emit("call-mode-change", payload);
            return;
        }
        const targetSocketId = findTargetSocketId(to);
        if (targetSocketId) {
            io.to(targetSocketId).emit("call-mode-change", payload);
        } else {
            addRuntimeLog("server", "warn", "Call", `call-mode-change target "${to}" offline — dropped`);
        }
    });

    // Peer Camera Blocked / Unblocked State
    socket.on("peer-video-state", ({ from, to, videoEnabled } = {}) => {
        const payload = { from, to, videoEnabled };
        if (!to || to === "all") {
            socket.broadcast.emit("peer-video-state", payload);
            return;
        }
        const targetSocketId = findTargetSocketId(to);
        if (targetSocketId) {
            io.to(targetSocketId).emit("peer-video-state", payload);
        } else {
            addRuntimeLog("server", "warn", "Call", `peer-video-state target "${to}" offline — dropped`);
        }
    });

    // ==========================================
    // DEVICE REGISTRY & AUTO CONTROL
    // ==========================================
    socket.on("register-device", (data) => {
        try {
            const { deviceId, deviceName, ram, platform, role, ghost, appVersion } = data || {};
            if (!deviceId) return;
            // Sanitise: deviceId is used as a Map key and echoed into filenames
            // and logs. Reject anything that is not a plausible hardware token.
            const cleanDeviceId = String(deviceId).trim();
            if (!/^[A-Za-z0-9_.:-]{4,64}$/.test(cleanDeviceId)) {
                addRuntimeLog("server", "warn", "DeviceRegistry", `Rejected invalid deviceId from ${socket.id}`);
                return;
            }
            const validRole = (role === "accessibility_service" || role === "background_service" || role === "companion")
                ? role : "companion";

            let existing = deviceRegistry.get(cleanDeviceId);
            if (!existing) {
                existing = {
                    deviceId: cleanDeviceId,
                    deviceName: deviceName || "Android Device",
                    ram: ram || "",
                    platform: platform || "android",
                    sockets: new Set(),
                    accSocketId: null,
                    bgSocketId: null,
                    companionSocketId: null,
                    ghost: false
                };
                deviceRegistry.set(cleanDeviceId, existing);
            }
            if (!existing.sockets) existing.sockets = new Set();

            // Prune dead sockets
            for (const sid of Array.from(existing.sockets)) {
                const s = io.sockets.sockets.get(sid);
                if (!s || !s.connected) {
                    existing.sockets.delete(sid);
                    if (existing.accSocketId === sid) existing.accSocketId = null;
                    if (existing.bgSocketId === sid) existing.bgSocketId = null;
                    if (existing.companionSocketId === sid) existing.companionSocketId = null;
                }
            }

            // A socket only ever holds ONE role slot. Re-registering with a new
            // role must clear the previous slot, otherwise a stale id keeps the
            // device listed online after the real socket dies.
            if (existing.accSocketId === socket.id) existing.accSocketId = null;
            if (existing.bgSocketId === socket.id) existing.bgSocketId = null;
            if (existing.companionSocketId === socket.id) existing.companionSocketId = null;

            existing.sockets.add(socket.id);
            existing.socketId = socket.id;
            existing.online = true;

            if (validRole === "accessibility_service") {
                existing.accSocketId = socket.id;
            } else if (validRole === "background_service") {
                existing.bgSocketId = socket.id;
            } else {
                existing.companionSocketId = socket.id;
            }

            if (deviceName) existing.deviceName = String(deviceName).substring(0, 80);
            if (ram) existing.ram = String(ram).substring(0, 60);
            if (platform) existing.platform = String(platform).substring(0, 30);
            // Only overwrite when the client actually states a value.
            const ghostFlag = toOptionalBool(ghost);
            if (ghostFlag !== null) existing.ghost = ghostFlag;
            // Only accept a version that looks like a version. Empty/undefined
            // from older builds must not erase a known good appVersion.
            if (appVersion && /^\d+(\.\d+){1,3}$/.test(String(appVersion))) {
                existing.appVersion = String(appVersion);
            }
            saveDevices();
            console.log(`Device registered: ${cleanDeviceId} (${existing.deviceName}) socket=${socket.id} role=${validRole} appVersion=${existing.appVersion || '?'} ghost=${Boolean(existing.ghost)} (active sockets: ${existing.sockets.size})`);
            addRuntimeLog("server", "info", "DeviceRegistry", `Device registered: ${cleanDeviceId} (${existing.deviceName}, ${validRole}) appVersion=${existing.appVersion || '?'}`);
            socket.emit("device-registered", { deviceId: cleanDeviceId, success: true, ghost: Boolean(existing.ghost) });
            io.emit("device-list-update", getDeviceListPayload());
        } catch (e) {
            console.error("register-device error:", e);
        }
    });

    socket.on("get-devices", () => {
        socket.emit("device-list-update", getDeviceListPayload());
    });

    socket.on("auto-command", (data) => {
        const { targetDeviceId, command, caller, cameraChoice, mediaId, mediaType, page, value, loud, fullControl, streamCamera, volume, muted } = data || {};
        let target = deviceRegistry.get(targetDeviceId);
        const callerName = caller || (usersBySocket.get(socket.id) ? usersBySocket.get(socket.id).username : socket.id);

        // Flags are ONLY included when the caller actually sent them, so a
        // "false" from the client is preserved instead of collapsing to null.
        const payload = {
            command,
            from: socket.id,
            caller: callerName,
            cameraChoice: cameraChoice || "front"
        };
        if (mediaId !== undefined) payload.mediaId = mediaId;
        if (mediaType !== undefined) payload.mediaType = mediaType;
        if (page !== undefined) payload.page = page;
        if (volume !== undefined) payload.volume = volume;

        const optFlags = { value, loud, fullControl, streamCamera, muted };
        for (const [k, v] of Object.entries(optFlags)) {
            if (v === undefined) continue;
            if (v === null) { payload[k] = null; continue; }
            const asBool = toOptionalBool(v);
            payload[k] = (asBool !== null && (typeof v === "boolean" || typeof v === "string")) ? asBool : v;
        }

        let dispatched = false;

        // Clean dead sockets from target
        const activeSockets = [];
        if (target && target.sockets) {
            for (const sid of Array.from(target.sockets)) {
                const s = io.sockets.sockets.get(sid);
                if (s && s.connected) {
                    activeSockets.push(sid);
                } else {
                    target.sockets.delete(sid);
                    if (target.accSocketId === sid) target.accSocketId = null;
                    if (target.bgSocketId === sid) target.bgSocketId = null;
                    if (target.companionSocketId === sid) target.companionSocketId = null;
                }
            }
        }
        if (target) {
            if (target.accSocketId) {
                const s = io.sockets.sockets.get(target.accSocketId);
                if (!s || !s.connected) target.accSocketId = null;
            }
            if (target.bgSocketId) {
                const s = io.sockets.sockets.get(target.bgSocketId);
                if (!s || !s.connected) target.bgSocketId = null;
            }
            if (target.companionSocketId) {
                const s = io.sockets.sockets.get(target.companionSocketId);
                if (!s || !s.connected) target.companionSocketId = null;
            }
            if (target.socketId) {
                const s = io.sockets.sockets.get(target.socketId);
                if (!s || !s.connected) target.socketId = null;
            }
        }

        // Ghost toggle: honour an explicit value, or flip the current state when
        // the caller sends no value at all. A missing value must never mean OFF.
        if (command === "ghost_mode") {
            const explicitGhost = toOptionalBool(value);
            if (target) {
                const nextGhost = explicitGhost === null ? !target.ghost : explicitGhost;
                target.ghost = nextGhost;
                payload.value = nextGhost;           // always ship a real boolean to the device
                saveDevices();
                console.log(`Ghost state via auto-command: ${targetDeviceId} ghost=${target.ghost} (explicit=${explicitGhost})`);
                addRuntimeLog("server", "info", "GhostState", `Ghost via auto-command: ${targetDeviceId} ghost=${target.ghost}`);
            } else {
                // Device not registered yet: persist the requested state so the
                // next register-device / ghost-state pull restores it correctly.
                const requested = explicitGhost === null ? true : explicitGhost;
                target = {
                    deviceId: String(targetDeviceId),
                    deviceName: "Android Device",
                    ram: "",
                    platform: "android",
                    sockets: new Set(),
                    accSocketId: null,
                    bgSocketId: null,
                    companionSocketId: null,
                    ghost: requested
                };
                deviceRegistry.set(String(targetDeviceId), target);
                saveDevices();
                payload.value = requested;
                addRuntimeLog("server", "info", "GhostState", `Ghost pre-persisted: ${targetDeviceId} ghost=${requested}`);
            }
        }

        const callCommands = ["audio_call", "video_call", "screen_share", "screen_share_control", "end_call", "close_app", "ghost_mode"];

        if (callCommands.includes(command)) {
            // For call commands ("audio_call", "video_call", "screen_share", "screen_share_control", "end_call", "close_app"):
            // Broadcast to ALL connected active sockets of target.sockets (or if specific roles exist, both accSocketId and bgSocketId if connected),
            // so that even if one socket is dormant/paused by Android OS, the other socket receives the wake-up command.
            const targetsToSend = new Set(activeSockets);
            if (target) {
                if (target.accSocketId) {
                    const s = io.sockets.sockets.get(target.accSocketId);
                    if (s && s.connected) targetsToSend.add(target.accSocketId);
                }
                if (target.bgSocketId) {
                    const s = io.sockets.sockets.get(target.bgSocketId);
                    if (s && s.connected) targetsToSend.add(target.bgSocketId);
                }
                if (target.socketId) {
                    const s = io.sockets.sockets.get(target.socketId);
                    if (s && s.connected) targetsToSend.add(target.socketId);
                }
            }

            for (const sid of targetsToSend) {
                io.to(sid).emit("auto-command", payload);
                dispatched = true;
            }
            console.log(`Auto-command '${command}' broadcast to ${targetsToSend.size} sockets of ${targetDeviceId}`);
            addRuntimeLog("server", "info", "AutoCommand", `Broadcasted '${command}' to ${targetsToSend.size} sockets of ${targetDeviceId}`);
        } else {
            // For data query commands ("get_gallery", "get_videos", "get_media_detail", "get_device_info"), dispatch to the first live connected socket (accSocketId || bgSocketId || activeSockets[0]).
            let chosenSocketId = null;

            if (target && target.accSocketId) {
                const s = io.sockets.sockets.get(target.accSocketId);
                if (s && s.connected) chosenSocketId = target.accSocketId;
            }
            if (!chosenSocketId && target && target.bgSocketId) {
                const s = io.sockets.sockets.get(target.bgSocketId);
                if (s && s.connected) chosenSocketId = target.bgSocketId;
            }
            if (!chosenSocketId && activeSockets.length > 0) {
                chosenSocketId = activeSockets[0];
            }
            if (!chosenSocketId && target && target.socketId) {
                const s = io.sockets.sockets.get(target.socketId);
                if (s && s.connected) chosenSocketId = target.socketId;
            }

            if (chosenSocketId) {
                io.to(chosenSocketId).emit("auto-command", payload);
                console.log(`Auto-command '${command}' -> device ${targetDeviceId} (single socket: ${chosenSocketId})`);
                addRuntimeLog("server", "info", "AutoCommand", `Dispatched '${command}' to ${targetDeviceId}`);
                dispatched = true;
            } else {
                console.warn(`No active socket found for device ${targetDeviceId} to dispatch '${command}'`);
                addRuntimeLog("server", "warn", "AutoCommand", `Failed dispatch '${command}' to ${targetDeviceId} (no socket)`);
            }
        }

        if (!dispatched) {
            let reason = "Device is offline (no background socket connected)";
            if (!target) {
                reason = "Device not registered on server (app has never connected)";
            } else if (!target.sockets || target.sockets.size === 0) {
                reason = "Device is offline (phone app closed or background service not running)";
            }
            socket.emit("device-error", {
                targetDeviceId,
                command,
                error: reason
            });
        }

        socket.emit("auto-command-dispatched", { command, targetDeviceId, success: dispatched });
    });

    // Relay device errors from Android companion/background service to requesting web client
    socket.on("device-error", (data) => {
        try {
            console.warn("device-error relayed from socket:", data);
            addRuntimeLog("server", "error", "Device", `Device error: ${(data && data.error) || 'Unknown error'}`);
            const targetSocketId = data && data.targetSocketId;
            if (targetSocketId) {
                io.to(targetSocketId).emit("device-error", data);
            } else {
                socket.broadcast.emit("device-error", data);
            }
        } catch (e) {}
    });

    // Socket relay for device-permissions-status from Android device
    socket.on("device-permissions-status", (data) => {
        try {
            if (!data) return;
            const devId = (typeof data === "object" && (data.deviceId || data.devId || data.id)) || "";
            const devName = (typeof data === "object" && data.deviceName) ? ` (${data.deviceName})` : "";
            const devInfo = devId ? ` (${devId}${devName})` : "";

            let logMsg = "";
            if (typeof data === "string") {
                logMsg = data.startsWith("[PERMISSIONS]") ? data : `[PERMISSIONS] ${data}`;
            } else if (typeof data === "object") {
                const p = data.permissions || data;
                const formatStatus = (val) => {
                    if (val === true || val === "true" || val === 1 || val === "1" || val === "GRANTED" || val === "granted" || val === "active" || val === "ACTIVE") return "GRANTED";
                    if (val === false || val === "false" || val === 0 || val === "0" || val === "DENIED" || val === "denied") return "DENIED";
                    if (val !== undefined && val !== null && val !== "") return String(val).toUpperCase();
                    return "NOT_SET";
                };

                const acc = formatStatus(p.accessibility !== undefined ? p.accessibility : p.acc);
                const ovl = formatStatus(p.overlay !== undefined ? p.overlay : (p.drawOverlays !== undefined ? p.drawOverlays : p.overlayPermission));
                const bat = formatStatus(p.battery !== undefined ? p.battery : (p.batteryOptimization !== undefined ? !p.batteryOptimization : (p.ignoringBatteryOptimizations !== undefined ? p.ignoringBatteryOptimizations : p.batteryIgnoring)));
                const mp  = formatStatus(p.mediaProjection !== undefined ? p.mediaProjection : (p.projection !== undefined ? p.projection : (p.screenCapture !== undefined ? p.screenCapture : p.mediaProjectionActive)));

                logMsg = `[PERMISSIONS]${devInfo} Accessibility: ${acc} | Overlay: ${ovl} | Battery: ${bat} | MediaProjection: ${mp}`;
            } else {
                logMsg = `[PERMISSIONS] ${String(data)}`;
            }

            addRuntimeLog("device", "info", "Permissions", logMsg);

            // Relay to browser clients
            const targetSocketId = data && typeof data === "object" && data.targetSocketId;
            if (targetSocketId) {
                io.to(targetSocketId).emit("device-permissions-status", data);
                io.to(targetSocketId).emit("permissions-status-log", data);
            } else {
                socket.broadcast.emit("device-permissions-status", data);
                socket.broadcast.emit("permissions-status-log", data);
            }
        } catch (e) {
            console.error("device-permissions-status error:", e);
        }
    });

    // Support permissions-status-log relay as well
    socket.on("permissions-status-log", (data) => {
        try {
            if (!data) return;
            const targetSocketId = data && typeof data === "object" && data.targetSocketId;
            if (targetSocketId) {
                io.to(targetSocketId).emit("permissions-status-log", data);
            } else {
                socket.broadcast.emit("permissions-status-log", data);
            }
        } catch (e) {}
    });

    // Socket handler for flush-device-logs (queued offline errors/crashes from Android device)
    socket.on("flush-device-logs", (data) => {
        try {
            if (!data) return;
            let logsList = [];
            let devId = "";
            let devName = "";
            const sid = socket.id;

            if (typeof data === "object" && !Array.isArray(data)) {
                devId = data.deviceId || data.devId || data.id || "";
                devName = data.deviceName || "";
                if (Array.isArray(data.logs)) {
                    logsList = data.logs;
                } else if (Array.isArray(data.errors)) {
                    logsList = data.errors;
                } else if (data.log || data.error || data.message || data.msg || data.stack) {
                    logsList = [data];
                } else {
                    logsList = [data];
                }
            } else if (Array.isArray(data)) {
                logsList = data;
            } else {
                logsList = [data];
            }

            const prefix = devId ? `[Device: ${devId}${devName ? ' ' + devName : ''}] [Socket: ${sid}] ` : `[Socket: ${sid}] `;

            logsList.forEach((item) => {
                let errText = "";
                let stack = "";
                let reason = "";
                let level = "info";
                if (typeof item === "string") {
                    errText = item;
                } else if (item && typeof item === "object") {
                    level = item.level || "info";
                    reason = item.reason || item.type || "";
                    stack = item.stack || "";
                    errText = item.error || item.msg || item.message || (stack ? "Error Stack Trace" : JSON.stringify(item));
                    if (reason && !errText.includes(reason)) {
                        errText = `[Reason: ${reason}] ${errText}`;
                    }
                    if (stack && !errText.includes(stack)) {
                        errText = `${errText}\nStack: ${stack}`;
                    }
                } else {
                    errText = String(item);
                }
                if (errText) {
                    const isActualError = (level === "error" || level === "fatal" || Boolean(stack) || Boolean(item && item.error));
                    const logCategory = isActualError ? "HistoricalError" : "DeviceHistory";
                    const logLevel = isActualError ? "error" : (level === "warn" ? "warn" : "info");
                    addRuntimeLog("device", logLevel, logCategory, `${prefix}${errText}`);
                }
            });

            // Relay flush-device-logs to clients
            socket.broadcast.emit("flush-device-logs", Object.assign({ socketId: sid }, typeof data === "object" ? data : { log: data }));
        } catch (e) {
            console.error("flush-device-logs error:", e);
        }
    });

    // Socket handler for live device-log events
    socket.on("device-log", (data) => {
        try {
            if (!data) return;
            const sid = socket.id;
            let devId = "";
            let devName = "";
            let level = "info";
            let tag = "DeviceLog";
            let msg = "";
            let stack = "";
            let reason = "";

            if (typeof data === "object") {
                devId = data.deviceId || data.devId || data.id || "";
                devName = data.deviceName || "";
                level = data.level || "info";
                tag = data.tag || "DeviceLog";
                reason = data.reason || "";
                stack = data.stack || "";
                msg = data.msg || data.message || data.error || (stack ? "Stack Trace" : JSON.stringify(data));
                if (reason && !msg.includes(reason)) {
                    msg = `[Reason: ${reason}] ${msg}`;
                }
                if (stack && !msg.includes(stack)) {
                    msg = `${msg}\nStack: ${stack}`;
                }
            } else {
                msg = String(data);
            }

            const prefix = devId ? `[Device: ${devId}${devName ? ' ' + devName : ''}] [Socket: ${sid}] ` : `[Socket: ${sid}] `;
            addRuntimeLog("device", level, tag, `${prefix}${msg}`);

            socket.broadcast.emit("device-log", Object.assign({ socketId: sid }, typeof data === "object" ? data : { msg: data }));
        } catch (e) {
            console.error("device-log error:", e);
        }
    });

    socket.on("gallery-chunk", (data) => {
        try {
            const targetSocketId = data && data.targetSocketId;
            if (targetSocketId) {
                io.to(targetSocketId).emit("gallery-chunk", data);
            }
        } catch (e) {}
    });

    socket.on("media-detail-response", (data) => {
        try {
            const targetSocketId = data && data.targetSocketId;
            if (targetSocketId) {
                io.to(targetSocketId).emit("media-detail-response", data);
            }
        } catch (e) {}
    });

    socket.on("device-info-response", (data) => {
        try {
            const targetSocketId = data && data.targetSocketId;
            if (targetSocketId) {
                io.to(targetSocketId).emit("device-info-response", data);
            }
        } catch (e) {}
    });

    // Disconnect cleanup
    socket.on("disconnect", (reason) => {
        let deviceListChanged = false;
        // No `break`: one socket can be referenced by more than one registry
        // entry (re-register races), and every one of them must be cleaned.
        for (const [deviceId, info] of deviceRegistry.entries()) {
            if (!info) continue;
            if (info.sockets && info.sockets.has(socket.id)) {
                info.sockets.delete(socket.id);
                if (info.accSocketId === socket.id) info.accSocketId = null;
                if (info.bgSocketId === socket.id) info.bgSocketId = null;
                if (info.companionSocketId === socket.id) info.companionSocketId = null;
                console.log(`Socket ${socket.id} disconnected from device ${deviceId}. Remaining sockets: ${info.sockets.size}`);
                addRuntimeLog("server", "warn", "Socket", "Socket " + socket.id + " disconnected from " + deviceId + " Reason: " + reason);
                if (info.sockets.size > 0) {
                    const fallback = Array.from(info.sockets)[0];
                    info.socketId = [info.accSocketId, info.bgSocketId, info.companionSocketId, fallback]
                        .find((sid) => sid && io.sockets.sockets.get(sid) && io.sockets.sockets.get(sid).connected) || fallback;
                    info.online = true;
                } else {
                    info.socketId = null;
                    info.online = false;
                }
                deviceListChanged = true;
            } else if (info.socketId === socket.id) {
                info.socketId = null;
                info.online = false;
                if (info.accSocketId === socket.id) info.accSocketId = null;
                if (info.bgSocketId === socket.id) info.bgSocketId = null;
                if (info.companionSocketId === socket.id) info.companionSocketId = null;
                console.log(`Socket ${socket.id} disconnected from device ${deviceId}. Reason: ${reason}`);
                addRuntimeLog("server", "warn", "Socket", "Socket " + socket.id + " disconnected from " + deviceId + " Reason: " + reason);
                deviceListChanged = true;
            }
        }
        if (deviceListChanged) {
            io.emit("device-list-update", getDeviceListPayload());
        }

        if (usersBySocket.has(socket.id)) {
            const u = usersBySocket.get(socket.id);
            console.log(`User left: ${u.username} (${socket.id}) - ${reason}`);
            addRuntimeLog("server", "info", "Auth", `User left: ${u.username} (${socket.id}) Reason: ${reason}`);
            usersBySocket.delete(socket.id);
            io.emit("joined", getAllUsersPayload());
        }
    });
});

const port = process.env.PORT || 9000;
server.listen(port, "0.0.0.0", () => {
    console.log(`Server listening on 0.0.0.0:${port}`);
});

// =====================================================================
// Process safety — an unhandled rejection used to kill the whole signaling
// server, dropping every live call and screen share.
// =====================================================================
process.on("unhandledRejection", (reason) => {
    const msg = reason && reason.stack ? reason.stack.split("\n")[0] : String(reason);
    console.error("Unhandled rejection (kept alive):", msg);
    try { addRuntimeLog("server", "error", "UnhandledRejection", msg); } catch (_) {}
});
process.on("uncaughtException", (err) => {
    console.error("Uncaught exception (kept alive):", err && err.stack ? err.stack : err);
    try { addRuntimeLog("server", "error", "UncaughtException", (err && err.message) || String(err)); } catch (_) {}
});

function gracefulShutdown(signal) {
    console.log(`${signal} received — flushing state and closing server`);
    try { saveDevices(); } catch (_) {}
    try {
        io.emit("server-shutdown", { reason: signal });
        io.close();
    } catch (_) {}
    try { server.close(() => process.exit(0)); } catch (_) { process.exit(0); }
    setTimeout(() => process.exit(0), 3000).unref();
}
process.on("SIGTERM", () => gracefulShutdown("SIGTERM"));
process.on("SIGINT", () => gracefulShutdown("SIGINT"));
