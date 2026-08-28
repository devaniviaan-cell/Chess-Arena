// server.js
// Multiplayer Chess Server
// Node.js + Express + Socket.IO

const express = require("express");
const http = require("http");
const { Server } = require("socket.io");
const path = require("path");
const crypto = require("crypto");

const app = express();
const server = http.createServer(app);

const io = new Server(server, {
    cors: {
        origin: "*",
        methods: ["GET", "POST"]
    }
});

const PORT = process.env.PORT || 3000;

// --------------------------------------------------
// Serve the chess game's index.html
// --------------------------------------------------

app.use(express.static(path.join(__dirname)));

app.get("/", (req, res) => {
    res.sendFile(path.join(__dirname, "index.html"));
});

// --------------------------------------------------
// Room storage
// --------------------------------------------------

const rooms = new Map();

/*
Room structure:

{
    code: "ABC123",

    players: {
        white: socketId,
        black: socketId
    },

    spectators: [],

    gameStarted: false,

    gameState: {
        fen: "...",
        moves: [],
        turn: "w"
    }
}
*/

// --------------------------------------------------
// Generate 6-character invite code
// --------------------------------------------------

function generateInviteCode() {

    const characters =
        "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";

    let code = "";

    for (let i = 0; i < 6; i++) {

        const randomIndex =
            crypto.randomInt(0, characters.length);

        code += characters[randomIndex];
    }

    return code;
}

// --------------------------------------------------
// Generate a unique code
// --------------------------------------------------

function createUniqueRoomCode() {

    let code;

    do {
        code = generateInviteCode();
    } while (rooms.has(code));

    return code;
}

// --------------------------------------------------
// Basic room cleanup
// --------------------------------------------------

function deleteRoomIfEmpty(code) {

    const room = rooms.get(code);

    if (!room) {
        return;
    }

    const playerCount =
        Object.values(room.players).filter(Boolean).length;

    if (playerCount === 0 && room.spectators.length === 0) {

        rooms.delete(code);

        console.log("Deleted empty room:", code);
    }
}

// --------------------------------------------------
// Socket connection
// --------------------------------------------------

io.on("connection", (socket) => {

    console.log("Player connected:", socket.id);

    // ------------------------------------------------
    // Create a new game
    // ------------------------------------------------

    socket.on("createGame", (callback) => {

        try {

            const code = createUniqueRoomCode();

            const room = {

                code,

                players: {
                    white: socket.id,
                    black: null
                },

                spectators: [],

                gameStarted: false,

                gameState: {
                    fen: "start",
                    moves: [],
                    turn: "w"
                }

            };

            rooms.set(code, room);

            socket.join(code);

            socket.data.roomCode = code;
            socket.data.color = "white";

            console.log(
                "Created room:",
                code,
                "White:",
                socket.id
            );

            callback({
                success: true,
                code,
                color: "white"
            });

        } catch (error) {

            console.error(error);

            callback({
                success: false,
                error: "Could not create game."
            });
        }
    });

    // ------------------------------------------------
    // Join existing game
    // ------------------------------------------------

    socket.on("joinGame", (rawCode, callback) => {

        try {

            const code =
                String(rawCode || "")
                    .trim()
                    .toUpperCase();

            if (!/^[A-Z0-9]{6}$/.test(code)) {

                callback({
                    success: false,
                    error: "Invite code must contain 6 characters."
                });

                return;
            }

            const room = rooms.get(code);

            if (!room) {

                callback({
                    success: false,
                    error: "Game not found."
                });

                return;
            }

            if (room.players.black) {

                callback({
                    success: false,
                    error: "This game already has two players."
                });

                return;
            }

            socket.join(code);

            room.players.black = socket.id;

            socket.data.roomCode = code;
            socket.data.color = "black";

            room.gameStarted = true;

            console.log(
                "Joined room:",
                code,
                "Black:",
                socket.id
            );

            callback({
                success: true,
                code,
                color: "black"
            });

            // Tell everyone the game has two players
            io.to(code).emit("gameReady", {

                code,

                players: {
                    white: room.players.white,
                    black: room.players.black
                }

            });

            // Tell the first player that somebody joined
            io.to(room.players.white).emit("opponentJoined", {
                color: "black"
            });

        } catch (error) {

            console.error(error);

            callback({
                success: false,
                error: "Could not join game."
            });
        }
    });

    // ------------------------------------------------
    // Rejoin a room
    // ------------------------------------------------

    socket.on("rejoinGame", (data, callback) => {

        const code =
            String(data?.code || "")
                .trim()
                .toUpperCase();

        const color = data?.color;

        const room = rooms.get(code);

        if (!room) {

            callback({
                success: false,
                error: "Game no longer exists."
            });

            return;
        }

        if (color !== "white" && color !== "black") {

            callback({
                success: false,
                error: "Invalid player color."
            });

            return;
        }

        const currentPlayer = room.players[color];

        if (currentPlayer && currentPlayer !== socket.id) {

            const oldSocket = io.sockets.sockets.get(currentPlayer);

            if (oldSocket) {

                callback({
                    success: false,
                    error: "That player slot is currently occupied."
                });

                return;
            }
        }

        room.players[color] = socket.id;

        socket.join(code);

        socket.data.roomCode = code;
        socket.data.color = color;

        callback({
            success: true,
            code,
            color,
            gameState: room.gameState
        });

        io.to(code).emit("playerReconnected", {
            color
        });
    });

    // ------------------------------------------------
    // Chess move
    // ------------------------------------------------

    socket.on("makeMove", (move) => {

        const code = socket.data.roomCode;
        const color = socket.data.color;

        if (!code || !color) {
            return;
        }

        const room = rooms.get(code);

        if (!room) {
            return;
        }

        // Only actual players can move
        if (
            room.players.white !== socket.id &&
            room.players.black !== socket.id
        ) {
            return;
        }

        // Game needs two players
        if (!room.gameStarted) {
            return;
        }

        // Validate basic move structure
        if (!move || typeof move !== "object") {
            return;
        }

        /*
        IMPORTANT:

        Your index.html should perform complete chess legality
        checking.

        The server forwards the move to the opponent.

        For a production chess server, you should ALSO validate
        the move on the server using a chess rules library.
        */

        room.gameState.moves.push({
            ...move,
            player: color,
            timestamp: Date.now()
        });

        room.gameState.turn =
            room.gameState.turn === "w"
                ? "b"
                : "w";

        socket.to(code).emit("opponentMove", {
            move,
            color
        });

        // Send updated state to both players
        io.to(code).emit("gameStateUpdate", {
            moves: room.gameState.moves,
            turn: room.gameState.turn
        });
    });

    // ------------------------------------------------
    // Update FEN
    // ------------------------------------------------

    socket.on("updatePosition", (data) => {

        const code = socket.data.roomCode;

        if (!code) {
            return;
        }

        const room = rooms.get(code);

        if (!room) {
            return;
        }

        if (typeof data?.fen === "string") {

            room.gameState.fen = data.fen;
        }

        io.to(code).emit("positionUpdated", {
            fen: room.gameState.fen
        });
    });

    // ------------------------------------------------
    // Resign
    // ------------------------------------------------

    socket.on("resign", () => {

        const code = socket.data.roomCode;
        const color = socket.data.color;

        if (!code || !color) {
            return;
        }

        const room = rooms.get(code);

        if (!room) {
            return;
        }

        io.to(code).emit("gameOver", {

            reason: "resignation",

            winner:
                color === "white"
                    ? "black"
                    : "white"

        });
    });

    // ------------------------------------------------
    // Offer draw
    // ------------------------------------------------

    socket.on("offerDraw", () => {

        const code = socket.data.roomCode;

        if (!code) {
            return;
        }

        socket.to(code).emit("drawOffered");
    });

    // ------------------------------------------------
    // Accept draw
    // ------------------------------------------------

    socket.on("acceptDraw", () => {

        const code = socket.data.roomCode;

        if (!code) {
            return;
        }

        io.to(code).emit("gameOver", {
            reason: "draw",
            winner: null
        });
    });

    // ------------------------------------------------
    // Decline draw
    // ------------------------------------------------

    socket.on("declineDraw", () => {

        const code = socket.data.roomCode;

        if (!code) {
            return;
        }

        socket.to(code).emit("drawDeclined");
    });

    // ------------------------------------------------
    // Request rematch
    // ------------------------------------------------

    socket.on("rematchRequest", () => {

        const code = socket.data.roomCode;

        if (!code) {
            return;
        }

        socket.to(code).emit("rematchRequested");
    });

    // ------------------------------------------------
    // Accept rematch
    // ------------------------------------------------

    socket.on("acceptRematch", () => {

        const code = socket.data.roomCode;

        if (!code) {
            return;
        }

        const room = rooms.get(code);

        if (!room) {
            return;
        }

        room.gameState = {
            fen: "start",
            moves: [],
            turn: "w"
        };

        io.to(code).emit("rematchStarted", {
            fen: "start"
        });
    });

    // ------------------------------------------------
    // Chat
    // ------------------------------------------------

    socket.on("chatMessage", (message) => {

        const code = socket.data.roomCode;

        if (!code) {
            return;
        }

        if (typeof message !== "string") {
            return;
        }

        message = message.trim();

        if (!message) {
            return;
        }

        // Keep messages reasonably short
        if (message.length > 250) {
            message = message.substring(0, 250);
        }

        io.to(code).emit("chatMessage", {

            message,

            color:
                socket.data.color || "spectator",

            timestamp: Date.now()

        });
    });

    // ------------------------------------------------
    // Time synchronization
    // ------------------------------------------------

    socket.on("clockUpdate", (data) => {

        const code = socket.data.roomCode;

        if (!code) {
            return;
        }

        if (!data || typeof data !== "object") {
            return;
        }

        socket.to(code).emit("clockUpdate", {

            whiteTime:
                Number(data.whiteTime) || 0,

            blackTime:
                Number(data.blackTime) || 0,

            turn:
                data.turn === "b" ? "b" : "w"

        });
    });

    // ------------------------------------------------
    // Ping
    // ------------------------------------------------

    socket.on("pingGame", () => {

        socket.emit("pongGame", {
            time: Date.now()
        });
    });

    // ------------------------------------------------
    // Player disconnect
    // ------------------------------------------------

    socket.on("disconnect", () => {

        console.log(
            "Player disconnected:",
            socket.id
        );

        const code = socket.data.roomCode;

        if (!code) {
            return;
        }

        const room = rooms.get(code);

        if (!room) {
            return;
        }

        let disconnectedColor = null;

        if (room.players.white === socket.id) {

            disconnectedColor = "white";

        } else if (room.players.black === socket.id) {

            disconnectedColor = "black";
        }

        if (disconnectedColor) {

            room.players[disconnectedColor] = null;

            io.to(code).emit("opponentDisconnected", {

                color: disconnectedColor,

                reconnectAllowed: true

            });
        }

        deleteRoomIfEmpty(code);
    });
});

// --------------------------------------------------
// REST API - room information
// --------------------------------------------------

app.get("/api/room/:code", (req, res) => {

    const code =
        String(req.params.code || "")
            .trim()
            .toUpperCase();

    const room = rooms.get(code);

    if (!room) {

        return res.status(404).json({
            exists: false
        });
    }

    res.json({

        exists: true,

        code,

        players: {
            white: Boolean(room.players.white),
            black: Boolean(room.players.black)
        },

        gameStarted: room.gameStarted,

        playerCount:
            Object.values(room.players)
                .filter(Boolean)
                .length

    });
});

// --------------------------------------------------
// Health check
// --------------------------------------------------

app.get("/health", (req, res) => {

    res.json({
        status: "online",
        rooms: rooms.size,
        time: Date.now()
    });
});

// --------------------------------------------------
// Start server
// --------------------------------------------------

server.listen(PORT, () => {

    console.log("");
    console.log("=================================");
    console.log("       CHESS SERVER ONLINE");
    console.log("=================================");
    console.log("");
    console.log(`Local: http://localhost:${PORT}`);
    console.log("");
});
