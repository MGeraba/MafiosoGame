const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const { GoogleGenerativeAI } = require("@google/generative-ai");

const app = express();
const server = http.createServer(app);

const io = new Server(server, {
    cors: { origin: "*", methods: ["GET", "POST"] },
    pingTimeout: 60000,
    pingInterval: 25000,
    transports: ['websocket', 'polling']
});

// ════════════════════════════════════════════════════════════════
//  Multi-AI Setup — Gemini أولاً، Groq كـ fallback
// ════════════════════════════════════════════════════════════════

// ── Gemini Keys (Google AI Studio — مجاني) ──────────────────────
const GEMINI_KEYS = [
    process.env.GEMINI_KEY,
    process.env.GEMINI_KEY_2,
    process.env.GEMINI_KEY_3,
].filter(Boolean);

let geminiIndex = 0;

async function tryGemini(prompt) {
    for (let i = 0; i < GEMINI_KEYS.length; i++) {
        const key = GEMINI_KEYS[(geminiIndex + i) % GEMINI_KEYS.length];
        try {
            const genAI = new GoogleGenerativeAI(key);
            const model = genAI.getGenerativeModel({ model: "gemini-2.0-flash-exp" });
            const result = await model.generateContent(prompt);
            geminiIndex = (geminiIndex + i + 1) % GEMINI_KEYS.length;
            console.log(`✅ Gemini key ${i + 1} نجح`);
            return result.response.text().replace(/```json|```/g, "").trim();
        } catch (e) {
            console.warn(`⚠️ Gemini key ${i + 1} فشل: ${e.message}`);
        }
    }
    return null; // كل مفاتيح Gemini فشلت
}

// ── Groq Keys (console.groq.com — مجاني) ────────────────────────
const GROQ_KEYS = [
    process.env.GROQ_KEY,
    process.env.GROQ_KEY_2,
].filter(Boolean);

let groqIndex = 0;

async function tryGroq(prompt) {
    for (let i = 0; i < GROQ_KEYS.length; i++) {
        const key = GROQ_KEYS[(groqIndex + i) % GROQ_KEYS.length];
        try {
            const res = await fetch("https://api.groq.com/openai/v1/chat/completions", {
                method: "POST",
                headers: {
                    "Authorization": `Bearer ${key}`,
                    "Content-Type": "application/json"
                },
                body: JSON.stringify({
                    model: "llama-3.3-70b-versatile",
                    messages: [{ role: "user", content: prompt }],
                    temperature: 0.8,
                    max_tokens: 2000
                })
            });
            if (!res.ok) throw new Error(`HTTP ${res.status}`);
            const data = await res.json();
            groqIndex = (groqIndex + i + 1) % GROQ_KEYS.length;
            console.log(`✅ Groq key ${i + 1} نجح`);
            return data.choices[0].message.content.replace(/```json|```/g, "").trim();
        } catch (e) {
            console.warn(`⚠️ Groq key ${i + 1} فشل: ${e.message}`);
        }
    }
    return null;
}

// ── الدالة الرئيسية — تجرب Gemini أولاً، لو فشل تجرب Groq ──────
async function getAIResponse(prompt) {
    // 1. جرب Gemini
    if (GEMINI_KEYS.length > 0) {
        const res = await tryGemini(prompt);
        if (res) return res;
        console.error("❌ كل مفاتيح Gemini فشلت — جاري تجربة Groq...");
    }

    // 2. Fallback: جرب Groq
    if (GROQ_KEYS.length > 0) {
        const res = await tryGroq(prompt);
        if (res) return res;
        console.error("❌ كل مفاتيح Groq فشلت كمان!");
    }

    return null; // فشل الكل
}

app.use(express.static('public'));

let rooms = {};

// ─── Socket Events ────────────────────────────────────────────────────────────
io.on('connection', (socket) => {

    // ── إنشاء غرفة ──────────────────────────────────────────────────────────
    socket.on('createRoom', () => {
        const roomCode = Math.random().toString(36).substring(2, 6).toUpperCase();
        rooms[roomCode] = {
            boss: socket.id,
            bossToken: socket.id,
            players: [],
            votes: {},
            scenario: null,
            clues: [],        // ✅ قائمة الهنتات الثابتة
            round: 1,
            started: false
        };
        socket.join(roomCode);
        socket.emit('roomCreated', roomCode);
    });

    // ── Reconnect البوس ──────────────────────────────────────────────────────
    socket.on('bossReconnect', ({ roomCode, bossToken }) => {
        const room = rooms[roomCode];
        if (!room) { socket.emit('error', 'الغرفة انتهت'); return; }
        if (room.bossToken !== bossToken) { socket.emit('error', 'غير مصرح'); return; }

        room.boss = socket.id;
        socket.join(roomCode);
        socket.emit('bossReconnected', {
            players: room.players,
            started: room.started,
            scenario: room.scenario,
            clues: room.clues        // ✅ نرجعله كل الهنتات المحفوظة
        });
    });

    // ── انضمام لاعب ─────────────────────────────────────────────────────────
    socket.on('joinRoom', (data) => {
        const room = rooms[data.roomCode];
        if (!room) { socket.emit('error', 'الغرفة مش موجودة!'); return; }

        const existing = room.players.find(p => p.name === data.playerName);
        if (existing) {
            existing.id = socket.id;
            socket.join(data.roomCode);
            socket.emit('joinedSuccess', { reconnected: true });
            if (room.started && existing.charName) {
                socket.emit('gameData', {
                    role: existing.role,
                    story: room.scenario.story,
                    charName: existing.charName,
                    charSecret: existing.secret,
                    // ✅ نبعت بس الشخصيات غير شخصيته عشان مايصوتش على نفسه
                    allCharNames: room.players
                        .filter(p => p.alive && p.name !== existing.name)
                        .map(p => p.charName)
                });
            }
        } else {
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
        io.to(room.boss).emit('updatePlayers', room.players);
    });

    // ── Reconnect لاعب ───────────────────────────────────────────────────────
    socket.on('playerReconnect', (data) => {
        const room = rooms[data.roomCode];
        if (!room) { socket.emit('error', 'الغرفة انتهت'); return; }

        const existing = room.players.find(p => p.name === data.playerName);
        if (existing) {
            existing.id = socket.id;
            socket.join(data.roomCode);
            if (room.started && existing.charName) {
                socket.emit('gameData', {
                    role: existing.role,
                    story: room.scenario.story,
                    charName: existing.charName,
                    charSecret: existing.secret,
                    allCharNames: room.players
                        .filter(p => p.alive && p.name !== existing.name)
                        .map(p => p.charName)
                });
            } else if (!room.started) {
                socket.emit('joinedSuccess', { reconnected: true });
                io.to(room.boss).emit('updatePlayers', room.players);
            }
        }
    });

    // ── بدء اللعبة ──────────────────────────────────────────────────────────
    socket.on('startGame', async (data) => {
        const room = rooms[data.roomCode];
        if (!room || room.players.length === 0) return;

        room.started = true;
        room.clues = []; // نصفر الهنتات

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

        const mafiaCount = room.players.length > 4 ? 2 : 1;
        const shuffled = [...room.players].sort(() => Math.random() - 0.5);
        room.players.forEach(p => p.role = 'مواطن');
        shuffled.slice(0, mafiaCount).forEach(p => { p.role = 'مافيوسو 🔪'; });

        room.players.forEach(p => {
            const assign = scenario.assignments?.find(a => a.name === p.name);
            p.charName = assign?.charName || "مجهول";
            p.secret   = assign?.secret   || "لا يوجد سر";
        });

        // ✅ كل لاعب ياخد قائمة الشخصيات بدون شخصيته هو
        room.players.forEach(p => {
            io.to(p.id).emit('gameData', {
                role: p.role,
                story: scenario.story,
                charName: p.charName,
                charSecret: p.secret,
                allCharNames: room.players
                    .filter(other => other.name !== p.name)
                    .map(other => other.charName)
            });
        });

        io.to(room.boss).emit('bossData', {
            story: scenario.story,
            players: room.players
        });

        sendClue(data.roomCode);
    });

    // ── إرسال دليل — للبوس بس وثابت ─────────────────────────────────────────
    async function sendClue(roomCode) {
        const room = rooms[roomCode];
        if (!room?.scenario) return;
        const mafiaChars = room.players.filter(p => p.role.includes('🔪')).map(p => p.charName).join(' و ');
        const prompt = `في قصة المافيا هذه: ${room.scenario.story}. المافيا هم: ${mafiaChars}. اعطني دليل مادي غامض يلمح لأحدهم في الجولة ${room.round}. جملة واحدة فقط.`;
        const clue = await getAIResponse(prompt);
        if (!clue) return;

        // ✅ نحفظ الهنت في الغرفة عشان يفضل موجود
        const clueObj = { text: clue, round: room.round, time: new Date().toLocaleTimeString('ar-EG') };
        room.clues.push(clueObj);

        // ✅ نبعت الهنت للبوس بس — مش للاعبين
        io.to(room.boss).emit('receiveClue', clueObj);
    }

    socket.on('requestPhysicalClue', (roomCode) => sendClue(roomCode));

    // ── Panic Mode — 10 ثواني ────────────────────────────────────────────────
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
            // ✅ نبعت الشخصيات الحية بدون شخصية كل لاعب نفسه
            room.players.filter(pl => pl.alive).forEach(pl => {
                io.to(pl.id).emit('nextRound',
                    room.players.filter(p => p.alive && p.name !== pl.name).map(p => p.charName)
                );
            });
            // للبوس نبعت كل الأحياء
            io.to(room.boss).emit('nextRound',
                room.players.filter(p => p.alive).map(p => p.charName)
            );
        }
    });

    // ── إغلاق الغرفة ─────────────────────────────────────────────────────────
    socket.on('closeRoom', (roomCode) => {
        io.to(roomCode).emit('gameOver', "تم إغلاق الغرفة من قبل البوس.");
        delete rooms[roomCode];
    });

    socket.on('disconnect', () => {
        // مش بنحذف اللاعب — بنديه فرصة يرجع
    });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
    console.log(`✅ Server on port ${PORT}`);
    console.log(`🤖 Gemini keys: ${GEMINI_KEYS.length} | Groq keys: ${GROQ_KEYS.length}`);
});