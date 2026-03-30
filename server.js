const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const { GoogleGenerativeAI } = require("@google/generative-ai");

const app = express();
const server = http.createServer(app);

// إعدادات الـ Socket مع السماح بالاتصال من أي مكان (CORS)
const io = new Server(server, {
    cors: {
        origin: "*",
        methods: ["GET", "POST"]
    }
});

const GEMINI_KEY = process.env.GEMINI_KEY;
const genAI = new GoogleGenerativeAI(GEMINI_KEY);

app.use(express.static('public'));

let rooms = {};

// دالة توليد الردود من AI
async function getAIResponse(prompt) {
    try {
        const model = genAI.getGenerativeModel({ model: "gemini-2.0-flash-exp" });
        const result = await model.generateContent(prompt);
        return result.response.text().replace(/```json|```/g, "").trim();
    } catch (e) {
        console.error("AI Error:", e);
        return null;
    }
}

io.on('connection', (socket) => {
    console.log('اتصال جديد:', socket.id);

    // إنشاء الغرفة (البوس)
    socket.on('createRoom', () => {
        const roomCode = Math.random().toString(36).substring(2, 6).toUpperCase();
        rooms[roomCode] = { 
            boss: socket.id, 
            players: [], 
            votes: {}, 
            scenario: null, 
            round: 1 
        };
        socket.join(roomCode);
        socket.emit('roomCreated', roomCode);
        console.log('غرفة جديدة:', roomCode);
    });

    // انضمام لاعب
    socket.on('joinRoom', (data) => {
        const room = rooms[data.roomCode];
        if (room) {
            // نأكد إن اللاعب مش موجود قبل كدة بنفس الـ ID
            const existing = room.players.find(p => p.id === socket.id);
            if(!existing) {
                room.players.push({ 
                    id: socket.id, 
                    name: data.playerName, 
                    role: 'مواطن', 
                    alive: true, 
                    charName: '' 
                });
            }
            socket.join(data.roomCode);
            socket.emit('joinedSuccess');
            // تحديث القائمة للكل (عشان موبايل البوس يحس)
            io.to(data.roomCode).emit('updatePlayers', room.players);
        } else {
            socket.emit('error', 'الغرفة مش موجودة!');
        }
    });

    // بدء الجيم وتوليد القصة
    socket.on('startGame', async (data) => {
        const room = rooms[data.roomCode];
        if (!room || room.players.length === 0) return;

        const names = room.players.map(p => p.name).join(', ');
        const prompt = `أنت مؤلف لعبة مافيا محترف. اللاعبون هم: [${names}]. 
        الجريمة: ${data.crimeType || "غموض"}. تريكات: ${data.tricks || "لا يوجد"}.
        اكتب قصة جريمة مصرية مشوقة ووزع أسامي شخصيات وأسرار لكل لاعب.
        الرد JSON فقط: {"story": "...", "assignments": [{"name": "الاسم الحقيقي", "charName": "اسم الشخصية", "secret": "السر"}]}`;

        const response = await getAIResponse(prompt);
        if (!response) return;

        const scenario = JSON.parse(response);
        room.scenario = scenario;

        // توزيع الأدوار (مافيا vs مواطنين)
        const mafiaCount = room.players.length > 4 ? 2 : 1;
        const shuffled = [...room.players].sort(() => Math.random() - 0.5);
        shuffled.slice(0, mafiaCount).forEach(p => p.role = 'مافيوسو 🔪');

        room.players.forEach(p => {
            const assign = scenario.assignments.find(a => a.name === p.name);
            p.charName = assign ? assign.charName : "مجهول";
            p.secret = assign ? assign.secret : "لا يوجد سر حالياً";
        });

        const allChars = room.players.map(p => p.charName);

        // إرسال البيانات لكل لاعب
        room.players.forEach(p => {
            io.to(p.id).emit('gameData', { 
                role: p.role, 
                story: scenario.story, 
                charName: p.charName, 
                charSecret: p.secret, 
                allCharNames: allChars 
            });
        });

        // إرسال البيانات للبوس (بما فيها القصة والأسرار)
        io.to(room.boss).emit('bossData', { 
            story: scenario.story, 
            players: room.players 
        });

        // إرسال أول دليل
        sendClue(data.roomCode);
    });

    // إرسال دليل (Hint)
    async function sendClue(roomCode) {
        const room = rooms[roomCode];
        if (!room || !room.scenario) return;
        const mafiaChars = room.players.filter(p => p.role.includes('🔪')).map(p => p.charName).join(' و ');
        const prompt = `في قصة المافيا هذه: ${room.scenario.story}. المافيا هم: ${mafiaChars}. اعطني دليل مادي غامض يلمح لأحدهم في الجولة ${room.round}.`;
        const clue = await getAIResponse(prompt);
        io.to(roomCode).emit('receiveClue', clue);
    }

    socket.on('requestPhysicalClue', (roomCode) => sendClue(roomCode));

    // Panic Mode
    socket.on('triggerPanic', (roomCode) => {
        io.to(roomCode).emit('panicAction');
    });

    // التصويت
    socket.on('castVote', (data) => {
        const room = rooms[data.roomCode];
        if (room) {
            room.votes[socket.id] = data.votedForChar;
            const counts = {};
            Object.values(room.votes).forEach(val => counts[val] = (counts[val] || 0) + 1);
            io.to(room.boss).emit('voteResultUpdate', { 
                totalVotes: Object.keys(room.votes).length, 
                details: counts 
            });
        }
    });

    // تنفيذ الإعدام
    socket.on('executePlayer', (roomCode) => {
        const room = rooms[roomCode];
        if (!room) return;
        
        const counts = {};
        Object.values(room.votes).forEach(val => counts[val] = (counts[val] || 0) + 1);
        const sorted = Object.entries(counts).sort((a, b) => b[1] - a[1]);

        if (sorted.length > 0) {
            const kickedChar = sorted[0][0];
            const p = room.players.find(pl => pl.charName === kickedChar);
            if (p) p.alive = false;

            const remainingMafia = room.players.filter(pl => pl.alive && pl.role.includes('🔪')).length;
            
            io.to(roomCode).emit('executionResult', { 
                charName: kickedChar, 
                isMafia: p ? p.role.includes('🔪') : false, 
                remaining: remainingMafia 
            });

            if (remainingMafia === 0) {
                io.to(roomCode).emit('gameOver', "المدينة انتصرت! 🎉 المافيا اتمسكوا.");
                delete rooms[roomCode];
            } else {
                room.round++;
                room.votes = {};
                const aliveChars = room.players.filter(pl => pl.alive).map(pl => pl.charName);
                io.to(roomCode).emit('nextRound', aliveChars);
            }
        }
    });

    // إغلاق الغرفة
    socket.on('closeRoom', (roomCode) => {
        io.to(roomCode).emit('gameOver', "تم إغلاق الغرفة من قبل البوس.");
        delete rooms[roomCode];
    });

    socket.on('disconnect', () => {
        console.log('لاعب فصل الاتصال');
    });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`Server running on port ${PORT}`));