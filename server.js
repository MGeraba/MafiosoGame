const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const { GoogleGenerativeAI } = require("@google/generative-ai");

const app = express();
const server = http.createServer(app);
const io = new Server(server);

// تأكد من وضع مفتاحك هنا
const GEMINI_KEY = "AIzaSyCN3PWSKK9ylCVC_keVkKMUhJ3EbYrVDK4"; 
const genAI = new GoogleGenerativeAI(GEMINI_KEY);

app.use(express.static('public'));
const rooms = {};

// دالة توليد القصة الأصلية بناءً على طلبات البوس
async function getInitialScenario(players, crimeType, tricks) {
    try {
        const model = genAI.getGenerativeModel({ model: "gemini-2.5-flash" });
        const names = players.map(p => p.name).join(', ');
        const prompt = `أنت مؤلف لعبة مافيا محترف (على ستايل برنامج بيس كيك). اللاعبون هم: [${names}]. 
        نوع الجريمة المطلوب: ${crimeType || "غموض"}. تريكات إضافية: ${tricks || "لا يوجد"}.
        اكتب قصة جريمة ساخرة مصرية قصيرة جداً ووزع أسامي شخصيات مستعارة وأسرار.
        الرد JSON فقط: {"story": "...", "assignments": [{"name": "الاسم الحقيقي", "charName": "الشخصية", "secret": "السر"}]}`;
        const result = await model.generateContent(prompt);
        return JSON.parse(result.response.text().replace(/```json|```/g, "").trim());
    } catch (e) {
        return { story: "خناقة في الحارة على ركنة توك توك!", assignments: players.map((p, i) => ({ name: p.name, charName: "مشتبه به " + (i+1), secret: "مخبي حاجة" })) };
    }
}

io.on('connection', (socket) => {
    socket.on('createRoom', () => {
        const roomCode = Math.random().toString(36).substring(2, 6).toUpperCase();
        rooms[roomCode] = { boss: socket.id, players: [], votes: {}, scenario: null, round: 1 };
        socket.join(roomCode);
        socket.emit('roomCreated', roomCode);
    });

    socket.on('joinRoom', (data) => {
        if (rooms[data.roomCode]) {
            rooms[data.roomCode].players.push({ id: socket.id, name: data.playerName, role: 'مواطن', alive: true });
            socket.join(data.roomCode);
            socket.emit('joinedSuccess');
            io.to(rooms[data.roomCode].boss).emit('updatePlayers', rooms[data.roomCode].players);
        }
    });

    socket.on('startGame', async (data) => {
        const room = rooms[data.roomCode];
        if (room) {
            const scenario = await getInitialScenario(room.players, data.crimeType, data.tricks);
            room.scenario = scenario;
            const mafiaCount = room.players.length > 4 ? 2 : 1;
            const shuffled = [...room.players].sort(() => Math.random() - 0.5);
            shuffled.slice(0, mafiaCount).forEach(p => p.role = 'مافيوسو 🔪');
            shuffled.slice(mafiaCount).forEach(p => p.role = 'مواطن 👤');

            room.players.forEach(p => {
                const det = scenario.assignments.find(a => a.name === p.name);
                p.charName = det ? det.charName : "مجهول";
                p.secret = det ? det.secret : "لا يوجد";
                io.to(p.id).emit('gameData', { role: p.role, story: scenario.story, charName: p.charName, charSecret: p.secret, allCharNames: room.players.filter(pl => pl.alive).map(pl => pl.charName) });
            });
            io.to(room.boss).emit('bossData', { story: scenario.story, players: room.players });
        }
    });

    // طلب دليل مادي (Clue) بستايل بيس كيك
    socket.on('requestPhysicalClue', async (roomCode) => {
        const room = rooms[roomCode];
        try {
            const model = genAI.getGenerativeModel({ model: "gemini-2.0-flash-exp" });
            const mafia = room.players.filter(p => p.role.includes('🔪')).map(p => p.charName).join(' و ');
            const prompt = `القصة: ${room.scenario.story}. الشخصيات: ${room.players.filter(p=>p.alive).map(p=>p.charName).join(',')}. المافيا الحقيقي: ${mafia}. 
            قل دليل مادي وجده المذيع في مكان الجريمة يلمح للمافيا أو يورط شخص بريء بستايل برنامج مافيوسو بيس كيك. سطر واحد ساخر.`;
            const result = await model.generateContent(prompt);
            io.to(room.boss).emit('receiveClue', result.response.text());
        } catch (e) { io.to(room.boss).emit('receiveClue', "وجدنا خصلة شعر في مسرح الجريمة!"); }
    });

    // تشغيل العداد (Timer)
    socket.on('startTimer', (roomCode) => {
        let timeLeft = 60; // 60 ثانية للمناقشة
        const timerInterval = setInterval(() => {
            io.to(roomCode).emit('timerUpdate', timeLeft);
            if (timeLeft <= 0) {
                clearInterval(timerInterval);
                io.to(roomCode).emit('timerEnd');
            }
            timeLeft--;
        }, 1000);
    });

    socket.on('triggerPanic', (roomCode) => { io.to(roomCode).emit('panicAction'); });

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
        const counts = {};
        Object.values(room.votes).forEach(c => counts[c] = (counts[c] || 0) + 1);
        const sorted = Object.entries(counts).sort((a,b) => b[1]-a[1]);

        if (sorted.length > 0) {
            const kickedChar = sorted[0][0];
            const kickedP = room.players.find(p => p.charName === kickedChar);
            kickedP.alive = false;
            const remainingMafia = room.players.filter(p => p.alive && p.role.includes('مافيوسو')).length;

            io.to(roomCode).emit('executionResult', { charName: kickedChar, isMafia: kickedP.role.includes('مافيوسو'), remaining: remainingMafia });

            if (remainingMafia === 0) {
                io.to(roomCode).emit('gameOver', "🎉 انتصار ساحق! تم القضاء على المافيا!");
            } else {
                room.round++; room.votes = {};
                room.players.filter(p => p.alive).forEach(p => io.to(p.id).emit('nextRound', room.players.filter(pl => pl.alive).map(pl => pl.charName)));
            }
        }
    });
});

server.listen(3000, () => console.log('🚀 Gemini 2.0 Flash (2.5) Mafia Server Active!'));