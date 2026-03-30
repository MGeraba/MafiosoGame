const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const { GoogleGenerativeAI } = require("@google/generative-ai");

const app = express();
const server = http.createServer(app);
const io = new Server(server, { cors: { origin: "*" } });

const GEMINI_KEY = process.env.GEMINI_KEY;
const genAI = new GoogleGenerativeAI(GEMINI_KEY);

app.use(express.static('public'));
let rooms = {};

async function getAIResponse(prompt) {
    try {
        const model = genAI.getGenerativeModel({ model: "gemini-2.5-flash" });
        const result = await model.generateContent(prompt);
        return result.response.text().replace(/```json|```/g, "").trim();
    } catch (e) { return null; }
}

io.on('connection', (socket) => {
    socket.on('createRoom', () => {
        const roomCode = Math.random().toString(36).substring(2, 6).toUpperCase();
        rooms[roomCode] = { boss: socket.id, players: [], votes: {}, scenario: null, round: 1 };
        socket.join(roomCode);
        socket.emit('roomCreated', roomCode);
    });

    socket.on('joinRoom', (data) => {
        const room = rooms[data.roomCode];
        if (room) {
            room.players.push({ id: socket.id, name: data.playerName, role: 'مواطن', alive: true, charName: '' });
            socket.join(data.roomCode);
            socket.emit('joinedSuccess');
            io.to(room.boss).emit('updatePlayers', room.players);
        }
    });

    socket.on('startGame', async (data) => {
        const room = rooms[data.roomCode];
        if (!room) return;

        const prompt = `أنت مؤلف لعبة مافيا. اللاعبون: [${room.players.map(p=>p.name).join(',')}]. الجريمة: ${data.crimeType}. اكتب قصة وأسماء مستعارة وأسرار. الرد JSON: {"story": "...", "assignments": [{"name": "..", "charName": "..", "secret": ".."}]}`;
        const response = await getAIResponse(prompt);
        const scenario = JSON.parse(response);
        room.scenario = scenario;

        // توزيع الأدوار والأسماء
        const mafiaCount = room.players.length > 4 ? 2 : 1;
        const shuffled = [...room.players].sort(() => Math.random() - 0.5);
        shuffled.slice(0, mafiaCount).forEach(p => p.role = 'مافيوسو 🔪');
        
        room.players.forEach(p => {
            const assign = scenario.assignments.find(a => a.name === p.name);
            p.charName = assign ? assign.charName : "مجهول";
            p.secret = assign ? assign.secret : "لا سر";
        });

        const allChars = room.players.map(p => p.charName);

        // إرسال البيانات للكل في نفس اللحظة
        room.players.forEach(p => {
            io.to(p.id).emit('gameData', { 
                role: p.role, story: scenario.story, charName: p.charName, 
                charSecret: p.secret, allCharNames: allChars 
            });
        });

        io.to(room.boss).emit('bossData', { story: scenario.story, players: room.players });
        sendClue(data.roomCode);
    });

    async function sendClue(roomCode) {
        const room = rooms[roomCode];
        const prompt = `في قصة المافيا: ${room.scenario.story}, المافيا هم: ${room.players.filter(p=>p.role.includes('🔪')).map(p=>p.charName)}. اعطني دليل مادي واحد ظهر في الجولة ${room.round} يلمح للقاتل.`;
        const clue = await getAIResponse(prompt);
        io.to(roomCode).emit('receiveClue', clue);
    }

    socket.on('requestPhysicalClue', (roomCode) => sendClue(roomCode));
    
    socket.on('triggerPanic', (roomCode) => io.to(roomCode).emit('panicAction'));

    socket.on('castVote', (data) => {
        const room = rooms[data.roomCode];
        if (room) {
            room.votes[socket.id] = data.votedForChar;
            const counts = {};
            Object.values(room.votes).forEach(c => counts[c] = (counts[c] || 0) + 1);
            io.to(room.boss).emit('voteResultUpdate', { totalVotes: Object.keys(room.votes).length, details: counts });
        }
    });

    socket.on('executePlayer', (roomCode) => {
        const room = rooms[roomCode];
        if (!room) return;
        const counts = {};
        Object.values(room.votes).forEach(c => counts[c] = (counts[c] || 0) + 1);
        const sorted = Object.entries(counts).sort((a,b) => b[1]-a[1]);

        if (sorted.length > 0) {
            const kickedChar = sorted[0][0];
            const p = room.players.find(pl => pl.charName === kickedChar);
            if (p) p.alive = false;
            const remaining = room.players.filter(pl => pl.alive && pl.role.includes('🔪')).length;
            
            io.to(roomCode).emit('executionResult', { charName: kickedChar, isMafia: p.role.includes('🔪'), remaining });
            
            if (remaining === 0) {
                io.to(roomCode).emit('gameOver', "المدينة انتصرت! 🎉");
                delete rooms[roomCode];
            } else {
                room.round++;
                room.votes = {};
                const aliveChars = room.players.filter(pl => pl.alive).map(pl => pl.charName);
                io.to(roomCode).emit('nextRound', aliveChars);
                sendClue(roomCode);
            }
        }
    });

    socket.on('closeRoom', (roomCode) => {
        io.to(roomCode).emit('gameOver', "البوس أغلق الغرفة.");
        delete rooms[roomCode];
    });
});

server.listen(process.env.PORT || 3000);