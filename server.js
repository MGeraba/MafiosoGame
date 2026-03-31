const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const { GoogleGenerativeAI } = require("@google/generative-ai");

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
    cors: { origin: "*", methods: ["GET", "POST"] }
});

async function getAIResponse(prompt) {
    // جرب جيميناي 2.5
    try {
        if (process.env.GEMINI_KEY) {
            const genAI = new GoogleGenerativeAI(process.env.GEMINI_KEY);
            const model = genAI.getGenerativeModel({ model: "gemini-2.5-flash" });
            const result = await model.generateContent(prompt);
            return result.response.text().replace(/```json|```/g, "").trim();
        }
    } catch (e) { console.error("Gemini Fail..."); }

    // جرب جروق كبديل
    try {
        if (process.env.GROQ_KEY) {
            const res = await fetch("https://api.groq.com/openai/v1/chat/completions", {
                method: "POST",
                headers: { "Authorization": `Bearer ${process.env.GROQ_KEY}`, "Content-Type": "application/json" },
                body: JSON.stringify({ model: "llama-3.3-70b-versatile", messages: [{ role: "user", content: prompt }] })
            });
            const data = await res.json();
            return data.choices[0].message.content.replace(/```json|```/g, "").trim();
        }
    } catch (e) { console.error("AI All Fail!"); }
    return null;
}

app.use(express.static('public'));
let rooms = {};

io.on('connection', (socket) => {
    // إنشاء غرفة
    socket.on('createRoom', () => {
        const roomCode = Math.random().toString(36).substring(2, 6).toUpperCase();
        rooms[roomCode] = { boss: socket.id, players: [], votes: {}, scenario: null, clues: [], round: 1 };
        socket.join(roomCode);
        socket.emit('roomCreated', roomCode);
    });

    // انضمام
    socket.on('joinRoom', (data) => {
        const room = rooms[data.roomCode];
        if (room) {
            const existing = room.players.find(p => p.name === data.playerName);
            if (!existing) room.players.push({ id: socket.id, name: data.playerName, role: 'مواطن', alive: true, charName: '' });
            else existing.id = socket.id;
            socket.join(data.roomCode);
            socket.emit('joinedSuccess');
            io.to(room.boss).emit('updatePlayers', room.players);
        }
    });

    // ابدأ الجيم
    socket.on('startGame', async (data) => {
        const room = rooms[data.roomCode];
        if (!room) return;
        const prompt = `لعبة مافيا، اللاعبون: [${room.players.map(p=>p.name).join(',')}]. الجريمة: ${data.crimeType}. الرد JSON فقط: {"story": "...", "assignments": [{"name": "...", "charName": "...", "secret": "..."}]}`;
        const res = await getAIResponse(prompt);
        if (!res) return;
        const scenario = JSON.parse(res);
        room.scenario = scenario;
        
        const mafiaCount = room.players.length > 4 ? 2 : 1;
        const shuffled = [...room.players].sort(() => Math.random() - 0.5);
        shuffled.forEach(p => p.role = 'بريء 😇');
        shuffled.slice(0, mafiaCount).forEach(p => p.role = 'مافيوسو 🔪');

        room.players.forEach(p => {
            const a = scenario.assignments.find(as => as.name === p.name);
            p.charName = a?.charName || "مجهول";
            p.secret = a?.secret || "لا سر";
            io.to(p.id).emit('gameData', { role: p.role, story: scenario.story, charName: p.charName, charSecret: p.secret, allChars: room.players.map(pl=>pl.charName) });
        });
        io.to(room.boss).emit('bossData', { story: scenario.story, players: room.players });
    });

    // طلب دليل (Hint)
    socket.on('requestPhysicalClue', async (roomCode) => {
        const room = rooms[roomCode];
        if (!room) return;
        const mafia = room.players.filter(p => p.role.includes('🔪')).map(p => p.charName).join(' و ');
        const prompt = `في قصة: ${room.scenario.story}. المافيا هم: ${mafia}. أعطني دليل مادي غامض يلمح لأحدهم في جملة واحدة.`;
        const clue = await getAIResponse(prompt);
        room.clues.push(clue);
        io.to(room.boss).emit('receiveClueBoss', room.clues); // يظهر للبوس بس
    });

    socket.on('triggerPanic', (roomCode) => io.to(roomCode).emit('panicAction'));

    socket.on('castVote', (data) => {
        const room = rooms[data.roomCode];
        if (room) {
            room.votes[socket.id] = data.votedFor;
            const counts = {};
            Object.values(room.votes).forEach(v => counts[v] = (counts[v] || 0) + 1);
            io.to(room.boss).emit('voteUpdate', counts);
        }
    });

    socket.on('executePlayer', (roomCode) => {
        const room = rooms[roomCode];
        if (!room) return;
        const counts = Object.entries(room.votes).reduce((acc, [id, char]) => { acc[char] = (acc[char] || 0) + 1; return acc; }, {});
        const kicked = Object.entries(counts).sort((a,b) => b[1]-a[1])[0]?.[0];
        const p = room.players.find(pl => pl.charName === kicked);
        if(p) p.alive = false;
        io.to(roomCode).emit('executionResult', { name: kicked, isMafia: p?.role.includes('🔪') });
        room.votes = {};
        io.to(roomCode).emit('nextRound', room.players.filter(pl=>pl.alive).map(pl=>pl.charName));
    });

    socket.on('closeRoom', (roomCode) => {
        io.to(roomCode).emit('forceReset', "تم إنهاء الجيم!");
        delete rooms[roomCode];
    });
});

server.listen(process.env.PORT || 3000);