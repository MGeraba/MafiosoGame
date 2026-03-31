const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const { GoogleGenerativeAI } = require("@google/generative-ai");

const app = express();
const server = http.createServer(app);

const io = new Server(server, {
    cors: { origin: "*", methods: ["GET", "POST"] },
    // ✅ إعدادات مهمة للموبايل
    pingTimeout: 60000,
    pingInterval: 25000,
    transports: ['websocket', 'polling']
});

const GEMINI_KEY = process.env.GEMINI_KEY;
const genAI = new GoogleGenerativeAI(GEMINI_KEY);

app.use(express.static('public'));

let rooms = {};

// ─── AI Helper ───────────────────────────────────────────────────────────────
async function getAIResponse(prompt) {
    try {
        const model = genAI.getGenerativeModel({ model: "gemini-2.5-flash" });
        const result = await model.generateContent(prompt);
        return result.response.text().replace(/```json|```/g, "").trim();
    } catch (e) {
        console.error("AI Error:", e);
        return null;
    }
}

// ─── Socket Events ────────────────────────────────────────────────────────────
io.on('connection', (socket) => {
    console.log('اتصال جديد:', socket.id);

    // ── إنشاء غرفة (البوس) ──────────────────────────────────────────────────
    socket.on('createRoom', () => {
        const roomCode = Math.random().toString(36).substring(2, 6).toUpperCase();
        rooms[roomCode] = {
            boss: socket.id,
            bossName: null,
            // ✅ نحفظ sessionToken للبوس عشان نعرفه لو reconnect
            bossToken: socket.id,
            players: [],
            votes: {},
            scenario: null,
            round: 1,
            started: false
        };
        socket.join(roomCode);
        socket.emit('roomCreated', roomCode);
        console.log('غرفة جديدة:', roomCode);
    });

    // ── Reconnect البوس ──────────────────────────────────────────────────────
    // ✅ لو البوس فتح الموبايل تاني ورجع بـ socket ID جديد
    socket.on('bossReconnect', ({ roomCode, bossToken }) => {
        const room = rooms[roomCode];
        if (!room) { socket.emit('error', 'الغرفة انتهت'); return; }

        if (room.bossToken === bossToken) {
            // نحدث الـ socket ID الجديد
            room.boss = socket.id;
            socket.join(roomCode);
            socket.emit('bossReconnected', {
                players: room.players,
                started: room.started,
                scenario: room.scenario
            });
            console.log(`البوس رجع للغرفة ${roomCode}`);
        } else {
            socket.emit('error', 'غير مصرح');
        }
    });

    // ── انضمام لاعب ─────────────────────────────────────────────────────────
    socket.on('joinRoom', (data) => {
        const room = rooms[data.roomCode];
        if (!room) { socket.emit('error', 'الغرفة مش موجودة!'); return; }

        // ✅ نتحقق لو اللاعب موجود بنفس الاسم (reconnect بـ socket جديد)
        const existing = room.players.find(p => p.name === data.playerName);

        if (existing) {
            // اللاعب ده reconnect — نحدث الـ ID بتاعه بس
            existing.id = socket.id;
            existing.alive = true;
            socket.join(data.roomCode);
            socket.emit('joinedSuccess', { reconnected: true });

            // لو اللعبة بدأت، ابعتله بياناته تاني
            if (room.started && existing.charName) {
                const allChars = room.players.map(p => p.charName);
                socket.emit('gameData', {
                    role: existing.role,
                    story: room.scenario.story,
                    charName: existing.charName,
                    charSecret: existing.secret,
                    allCharNames: allChars
                });
            }
        } else {
            // لاعب جديد
            if (room.started) { socket.emit('error', 'اللعبة بدأت خلاص!'); return; }

            room.players.push({
                id: socket.id,
                name: data.playerName,
                role: 'مواطن',
                alive: true,
                charName: '',
                secret: ''
            });
            socket.join(data.roomCode);
            socket.emit('joinedSuccess', { reconnected: false });
        }

        // ✅ نبعت قائمة اللاعبين للبوس دايمًا
        io.to(room.boss).emit('updatePlayers', room.players);
        console.log(`لاعب ${data.playerName} في الغرفة ${data.roomCode}`);
    });

    // ── بدء اللعبة ──────────────────────────────────────────────────────────
    socket.on('startGame', async (data) => {
        const room = rooms[data.roomCode];
        if (!room || room.players.length === 0) return;

        room.started = true;

        const names = room.players.map(p => p.name).join(', ');
        const prompt = `أنت مؤلف لعبة مافيا محترف. اللاعبون هم: [${names}]. 
        الجريمة: ${data.crimeType || "غموض"}. تريكات: ${data.tricks || "لا يوجد"}.
        اكتب قصة جريمة مصرية مشوقة ووزع أسامي شخصيات وأسرار لكل لاعب.
        الرد JSON فقط: {"story": "...", "assignments": [{"name": "الاسم الحقيقي", "charName": "اسم الشخصية", "secret": "السر"}]}`;

        const response = await getAIResponse(prompt);
        if (!response) { room.started = false; return; }

        let scenario;
        try { scenario = JSON.parse(response); }
        catch (e) { console.error('JSON parse error', e); room.started = false; return; }

        room.scenario = scenario;

        // توزيع الأدوار
        const mafiaCount = room.players.length > 4 ? 2 : 1;
        const shuffled = [...room.players].sort(() => Math.random() - 0.5);
        room.players.forEach(p => p.role = 'مواطن');
        shuffled.slice(0, mafiaCount).forEach(p => { p.role = 'مافيوسو 🔪'; });

        room.players.forEach(p => {
            const assign = scenario.assignments?.find(a => a.name === p.name);
            p.charName = assign?.charName || "مجهول";
            p.secret   = assign?.secret   || "لا يوجد سر";
        });

        const allChars = room.players.map(p => p.charName);

        // إرسال لكل لاعب
        room.players.forEach(p => {
            io.to(p.id).emit('gameData', {
                role: p.role,
                story: scenario.story,
                charName: p.charName,
                charSecret: p.secret,
                allCharNames: allChars
            });
        });

        // إرسال للبوس
        io.to(room.boss).emit('bossData', {
            story: scenario.story,
            players: room.players
        });

        sendClue(data.roomCode);
    });

    // ── إرسال دليل ──────────────────────────────────────────────────────────
    async function sendClue(roomCode) {
        const room = rooms[roomCode];
        if (!room?.scenario) return;
        const mafiaChars = room.players.filter(p => p.role.includes('🔪')).map(p => p.charName).join(' و ');
        const prompt = `في قصة المافيا هذه: ${room.scenario.story}. المافيا هم: ${mafiaChars}. اعطني دليل مادي غامض يلمح لأحدهم في الجولة ${room.round}. جملة واحدة فقط.`;
        const clue = await getAIResponse(prompt);
        if (clue) io.to(roomCode).emit('receiveClue', clue);
    }

    socket.on('requestPhysicalClue', (roomCode) => sendClue(roomCode));

    // ── Panic Mode ───────────────────────────────────────────────────────────
    socket.on('triggerPanic', (roomCode) => {
        io.to(roomCode).emit('panicAction');
    });

    // ── التصويت ─────────────────────────────────────────────────────────────
    socket.on('castVote', (data) => {
        const room = rooms[data.roomCode];
        if (!room) return;
        room.votes[socket.id] = data.votedForChar;
        const counts = {};
        Object.values(room.votes).forEach(v => counts[v] = (counts[v] || 0) + 1);
        io.to(room.boss).emit('voteResultUpdate', {
            totalVotes: Object.keys(room.votes).length,
            details: counts
        });
    });

    // ── تنفيذ الإعدام ────────────────────────────────────────────────────────
    socket.on('executePlayer', (roomCode) => {
        const room = rooms[roomCode];
        if (!room) return;

        const counts = {};
        Object.values(room.votes).forEach(v => counts[v] = (counts[v] || 0) + 1);
        const sorted = Object.entries(counts).sort((a, b) => b[1] - a[1]);

        if (!sorted.length) return;

        const kickedChar = sorted[0][0];
        const p = room.players.find(pl => pl.charName === kickedChar);
        if (p) p.alive = false;

        const remainingMafia = room.players.filter(pl => pl.alive && pl.role.includes('🔪')).length;

        io.to(roomCode).emit('executionResult', {
            charName: kickedChar,
            isMafia: p?.role.includes('🔪') || false,
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
    });

    // ── إغلاق الغرفة ─────────────────────────────────────────────────────────
    socket.on('closeRoom', (roomCode) => {
        io.to(roomCode).emit('gameOver', "تم إغلاق الغرفة من قبل البوس.");
        delete rooms[roomCode];
    });

    // ── قطع الاتصال ──────────────────────────────────────────────────────────
    // ✅ مش بنحذف اللاعب فورًا — بنديه فرصة يرجع
    socket.on('disconnect', () => {
        console.log('فصل مؤقت:', socket.id);
        // ماشيش نمسح حاجة — لو اللاعب رجع بنفس الاسم هيتحدث ID بتاعه
    });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`Server running on port ${PORT}`));