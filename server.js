const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const { GoogleGenerativeAI } = require("@google/generative-ai");

const app = express();
const server = http.createServer(app);
const io = new Server(server);

app.use(express.static('public'));

const genAI = new GoogleGenerativeAI(process.env.GEMINI_KEY);

async function getAIResponse(prompt) {
    const model = genAI.getGenerativeModel({ model: "gemini-2.5-flash" });
    const result = await model.generateContent(prompt);
    return result.response.text().replace(/```json|```/g, "").trim();
}

let rooms = {};

io.on('connection', (socket) => {

socket.on('createRoom', () => {
    const roomCode = Math.random().toString(36).substring(2, 6).toUpperCase();

    rooms[roomCode] = { 
        boss: socket.id, 
        players: [], 
        votes: {}, 
        scenario: null, 
        round: 1, 
        started: false,
        hints: []
    };

    socket.join(roomCode);
    socket.emit('roomCreated', roomCode);
});

socket.on('joinRoom', (data) => {
    const room = rooms[data.roomCode];
    if (room) {
        room.players.push({ id: socket.id, name: data.playerName, role: 'مواطن', alive: true });
        socket.join(data.roomCode);
        socket.emit('joinedSuccess');
        io.to(room.boss).emit('updatePlayers', room.players);
    }
});

socket.on('startGame', async (data) => {
    const room = rooms[data.roomCode];

    const prompt = `
    اكتب قصة مافيا + 6 hints + شخصيات
    JSON فقط:
    {
    "story": "...",
    "hints": ["...", "...", "...", "...", "...", "..."],
    "assignments": [{"name":"...", "charName":"...", "secret":"..."}]
    }`;

    const response = await getAIResponse(prompt);
    const scenario = JSON.parse(response);

    room.scenario = scenario;
    room.hints = scenario.hints || [];

    const shuffled = [...room.players].sort(() => Math.random() - 0.5);
    shuffled[0].role = 'مافيوسو 🔪';
    shuffled[1].role = 'مافيوسو 🔪';

    room.players.forEach(p => {
        const assign = scenario.assignments.find(a => a.name === p.name);

        p.charName = assign?.charName || p.name;
        p.secret = assign?.secret || "لا يوجد";

        io.to(p.id).emit('gameData', { 
            role: p.role, 
            story: scenario.story, 
            charName: p.charName, 
            charSecret: p.secret
        });
    });

    io.to(room.boss).emit('bossData', { story: scenario.story, players: room.players });

    io.to(room.boss).emit('newHint', {
        hint: room.hints[0],
        round: 1
    });
});

socket.on('startVoting', (roomCode) => {
    const room = rooms[roomCode];
    room.votes = {};
    io.to(roomCode).emit('startVoting', room.players);
});

socket.on('vote', ({ roomCode, target }) => {
    const room = rooms[roomCode];
    if (!room.votes[target]) room.votes[target] = 0;
    room.votes[target]++;
});

socket.on('executeKill', (roomCode) => {
    const room = rooms[roomCode];

    let max = 0, killed = null;

    for (let p in room.votes) {
        if (room.votes[p] > max) {
            max = room.votes[p];
            killed = p;
        }
    }

    const player = room.players.find(p => p.name === killed);
    if (player) player.alive = false;

    io.to(roomCode).emit('playerKilled', killed);
});

socket.on('nextRound', (roomCode) => {
    const room = rooms[roomCode];

    room.round++;
    room.votes = {};

    io.to(room.boss).emit('newHint', {
        hint: room.hints[room.round - 1],
        round: room.round
    });
});

socket.on('getHint', async (roomCode) => {
    const hint = await getAIResponse(`اعطيني هنت غامض لجريمة مافيا`);
    io.to(rooms[roomCode].boss).emit('extraHint', hint);
});

});

server.listen(3000, () => console.log("🔥 Server Running"));