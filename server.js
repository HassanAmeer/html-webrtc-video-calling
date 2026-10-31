import express from "express";
import { createServer } from "http";
import { Server } from "socket.io";
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

const app = express();
const server = createServer(app);

const io = new Server(server, {
    cors: {
        origin: "*",
        methods: ["GET", "POST"],
        credentials: true
    }
});

// Store connected active users who have entered a name:
// socketId -> { username, id }
const usersBySocket = new Map();

function getAllUsersPayload() {
    const payload = {};
    for (const [id, user] of usersBySocket.entries()) {
        payload[user.username] = { username: user.username, id };
    }
    return payload;
}

const __dirname = dirname(fileURLToPath(import.meta.url));

app.use(express.static("public"));
app.use(express.static("app"));

app.get("/", (req, res) => {
    res.sendFile(join(__dirname + "/app/index.html"));
});

io.on("connection", (socket) => {
    console.log(`Socket connected: ${socket.id}`);

    // Send currently joined users (empty until someone sets a name)
    socket.emit("joined", getAllUsersPayload());

    // User joins by explicitly submitting their name
    socket.on("join-user", (requestedName) => {
        if (!requestedName || typeof requestedName !== "string") return;
        const cleanName = requestedName.trim();
        if (!cleanName) return;

        // Ensure unique name
        let finalName = cleanName;
        let suffix = 1;
        for (const [sId, u] of usersBySocket.entries()) {
            if (sId !== socket.id && u.username.toLowerCase() === finalName.toLowerCase()) {
                finalName = `${cleanName}_${suffix++}`;
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
server.listen(port, () => {
    console.log(`Server listening on port ${port}`);
});
