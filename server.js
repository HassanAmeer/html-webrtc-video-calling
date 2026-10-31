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

// Store all connected users: socketId -> { username, id }
// And username -> { username, id }
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
    // Generate an automatic distinct guest name immediately on connection
    const autoUsername = `Guest_${socket.id.slice(0, 5)}`;
    usersBySocket.set(socket.id, { username: autoUsername, id: socket.id });
    console.log(`User connected: ${autoUsername} (${socket.id})`);

    // Send assigned name to client
    socket.emit("assigned-username", autoUsername);

    // Broadcast updated participant list to everyone immediately
    io.emit("joined", getAllUsersPayload());

    // User sets/updates their custom name
    socket.on("join-user", (requestedName) => {
        if (!requestedName || typeof requestedName !== "string") return;
        const cleanName = requestedName.trim();
        if (!cleanName) return;

        // Check if name is already taken by someone else
        let finalName = cleanName;
        let suffix = 1;
        for (const [sId, u] of usersBySocket.entries()) {
            if (sId !== socket.id && u.username.toLowerCase() === finalName.toLowerCase()) {
                finalName = `${cleanName}_${suffix++}`;
            }
        }

        const userObj = { username: finalName, id: socket.id };
        usersBySocket.set(socket.id, userObj);
        console.log(`Socket ${socket.id} renamed to "${finalName}"`);

        socket.emit("name-confirmed", finalName);
        io.emit("joined", getAllUsersPayload());
    });

    // WebRTC Offer
    socket.on("offer", ({ from, to, offer }) => {
        console.log(`Call offer: ${from} -> ${to}`);
        // Find target socket
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
            console.warn(`Offer target "${to}" not found`);
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
            console.warn(`Answer target "${to}" not found`);
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

    // End call
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
        const u = usersBySocket.get(socket.id);
        const name = u ? u.username : socket.id;
        console.log(`User disconnected: ${name} (${socket.id}) - ${reason}`);
        usersBySocket.delete(socket.id);
        io.emit("joined", getAllUsersPayload());
    });
});

const port = process.env.PORT || 9000;
server.listen(port, () => {
    console.log(`Server listening on port ${port}`);
});
