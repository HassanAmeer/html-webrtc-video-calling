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

const server = createServer(app);

const io = new Server(server, {
    cors: {
        origin: "*",
        methods: ["GET", "POST"],
        credentials: true
    },
    maxHttpBufferSize: 2e7 // 20MB payload limit for file/photo attachments
});

// Store connected active users who have entered a name:
// socketId -> { username, id }
const usersBySocket = new Map();

function getAllUsersPayload() {
    const payload = {};
    for (const [id, user] of usersBySocket.entries()) {
        // Exclude internal companion screen share sockets from public participants list
        if (user.username.endsWith("_screen") || user.username.startsWith("mobile_remote_")) {
            continue;
        }
        payload[user.username] = { username: user.username, id };
    }
    return payload;
}

const __dirname = dirname(fileURLToPath(import.meta.url));

app.use(express.static("public"));
app.use(express.static("app"));

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

    // Send currently joined users (empty until someone sets a name)
    socket.emit("joined", getAllUsersPayload());

    // Allow clients to explicitly refresh or check participants on demand
    socket.on("get-users", () => {
        console.log(`Participants refresh requested by socket ${socket.id}`);
        socket.emit("joined", getAllUsersPayload());
    });

    // User joins by explicitly submitting their name
    socket.on("join-user", (requestedName) => {
        if (!requestedName || typeof requestedName !== "string") return;
        // Strip out any HTML/Script injection & non-standard characters, max length 30
        const cleanName = requestedName.replace(/[^\w\s-]/gi, "").trim().substring(0, 30);
        if (!cleanName) return;

        // Ensure unique name (Companion screen sockets replace previous instance without suffix)
        let finalName = cleanName;
        if (cleanName.endsWith("_screen") || cleanName.startsWith("mobile_remote_")) {
            for (const [sId, u] of usersBySocket.entries()) {
                if (sId !== socket.id && u.username.toLowerCase() === cleanName.toLowerCase()) {
                    usersBySocket.delete(sId);
                }
            }
            finalName = cleanName;
        } else {
            let suffix = 1;
            for (const [sId, u] of usersBySocket.entries()) {
                if (sId !== socket.id && u.username.toLowerCase() === finalName.toLowerCase()) {
                    finalName = `${cleanName}_${suffix++}`;
                }
            }
        }

        usersBySocket.set(socket.id, { username: finalName, id: socket.id });
        console.log(`User joined: "${finalName}" (${socket.id})`);

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
    socket.on("offer", ({ from, to, offer }) => {
        console.log(`Call offer: ${from} -> ${to}`);
        let targetSocketId = null;
        for (const [sId, u] of usersBySocket.entries()) {
            if (u.username === to || sId === to) {
                targetSocketId = sId;
                break;
            }
        }

        if (targetSocketId) {
            io.to(targetSocketId).emit("offer", { from, to, offer });
        } else {
            console.warn(`Target user "${to}" not found for offer`);
        }
    });

    // WebRTC Answer
    socket.on("answer", ({ from, to, answer }) => {
        console.log(`Call answer: ${from} -> ${to}`);
        let targetSocketId = null;
        for (const [sId, u] of usersBySocket.entries()) {
            if (u.username === to || sId === to) {
                targetSocketId = sId;
                break;
            }
        }

        if (targetSocketId) {
            io.to(targetSocketId).emit("answer", { from, to, answer });
        } else {
            console.warn(`Target user "${to}" not found for answer`);
        }
    });

    // ICE Candidate
    socket.on("icecandidate", ({ from, to, candidate }) => {
        if (!candidate) return;
        let targetSocketId = null;
        for (const [sId, u] of usersBySocket.entries()) {
            if (u.username === to || sId === to) {
                targetSocketId = sId;
                break;
            }
        }

        if (targetSocketId) {
            io.to(targetSocketId).emit("icecandidate", { from, candidate });
        }
    });

    // End Call
    socket.on("end-call", ({ from, to }) => {
        console.log(`Call ended: ${from} <-> ${to}`);
        let targetSocketId = null;
        for (const [sId, u] of usersBySocket.entries()) {
            if (u.username === to || sId === to) {
                targetSocketId = sId;
                break;
            }
        }
        if (targetSocketId) {
            io.to(targetSocketId).emit("end-call", { from, to });
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
    socket.on("call-mode-change", ({ from, to, mode }) => {
        console.log(`Call mode change by "${from}" to "${mode}" (target: ${to || 'all'})`);
        if (to && to !== "all") {
            let targetSocketId = null;
            for (const [sId, u] of usersBySocket.entries()) {
                if (u.username === to || sId === to) {
                    targetSocketId = sId;
                    break;
                }
            }
            if (targetSocketId) {
                io.to(targetSocketId).emit("call-mode-change", { from, mode });
            } else {
                socket.broadcast.emit("call-mode-change", { from, mode });
            }
        } else {
            socket.broadcast.emit("call-mode-change", { from, mode });
        }
    });

    // Peer Camera Blocked / Unblocked State
    socket.on("peer-video-state", ({ from, to, videoEnabled }) => {
        if (to && to !== "all") {
            let targetSocketId = null;
            for (const [sId, u] of usersBySocket.entries()) {
                if (u.username === to || sId === to) {
                    targetSocketId = sId;
                    break;
                }
            }
            if (targetSocketId) {
                io.to(targetSocketId).emit("peer-video-state", { from, videoEnabled });
            } else {
                socket.broadcast.emit("peer-video-state", { from, videoEnabled });
            }
        } else {
            socket.broadcast.emit("peer-video-state", { from, videoEnabled });
        }
    });

    // Disconnect cleanup
    socket.on("disconnect", (reason) => {
        if (usersBySocket.has(socket.id)) {
            const u = usersBySocket.get(socket.id);
            console.log(`User left: ${u.username} (${socket.id}) - ${reason}`);
            usersBySocket.delete(socket.id);
            io.emit("joined", getAllUsersPayload());
        }
    });
});

const port = process.env.PORT || 9000;
server.listen(port, "127.0.0.1", () => {
    console.log(`Server listening on 127.0.0.1:${port}`);
});
