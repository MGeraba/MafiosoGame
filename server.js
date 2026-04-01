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

// ════════════════════════════════════════════════
//  Multi-AI Setup
// ════════════════════════════════════════════════
const GEMINI_KEYS = [
    process.env.GEMINI_KEY,
    process.env.GEMINI_KEY_2,
    process.env.GEMINI_KEY_3,
].filter(Boolean);

const GROQ_KEYS = [
    process.env.GROQ_KEY,
    process.env.GROQ_KEY_2,
].filter(Boolean);

let geminiIndex = 0, groqIndex = 0;

async function tryGemini(prompt) {
    for (let i = 0; i < GEMINI_KEYS.length; i++) {
        const key = GEMINI_KEYS[(geminiIndex + i) % GEMINI_KEYS.length];
        try {
            const genAI = new GoogleGenerativeAI(key);
            // إضافة إجبار الـ JSON هنا
            const model = genAI.getGenerativeModel({ 
                model: "gemini-2.5-flash", 
                generationConfig: { responseMimeType: "application/json" } 
            });
            const result = await model.generateContent(prompt);
            geminiIndex = (geminiIndex + i + 1) % GEMINI_KEYS.length;
            return result.response.text().trim();
        } catch (e) {
            console.warn(`Gemini key ${i+1} failed: ${e.message}`);
        }
    }
    return null;
}

async function tryGroq(prompt) {
    for (let i = 0; i < GROQ_KEYS.length; i++) {
        const key = GROQ_KEYS[(groqIndex + i) % GROQ_KEYS.length];
        try {
            const res = await fetch("https://api.groq.com/openai/v1/chat/completions", {
                method: "POST",
                headers: { "Authorization": `Bearer ${key}`, "Content-Type": "application/json" },
                body: JSON.stringify({
                    model: "llama-3.3-70b-versatile",
                    messages: [{ role: "user", content: prompt }],
                    temperature: 0.8, 
                    max_tokens: 2000,
                    response_format: { type: "json_object" } // إضافة إجبار الـ JSON لجروق
                })
            });
            if (!res.ok) throw new Error(`HTTP ${res.status}`);
            const data = await res.json();
            groqIndex = (groqIndex + i + 1) % GROQ_KEYS.length;
            return data.choices[0].message.content.trim();
        } catch (e) {
            console.warn(`Groq key ${i+1} failed: ${e.message}`);
        }
    }
    return null;
}

async function getAIResponse(prompt) {
    if (GEMINI_KEYS.length > 0) {
        const res = await tryGemini(prompt);
        if (res) return res;
        console.error("All Gemini keys failed, trying Groq...");
    }
    if (GROQ_KEYS.length > 0) {
        const res = await tryGroq(prompt);
        if (res) return res;
    }
    return null;
}

app.use(express.static('public'));

let rooms = {};

// ════════════════════════════════════════════════
//  Helpers
// ════════════════════════════════════════════════

// حساب حالة الفوز
function checkWinCondition(room) {
    const alivePlayers = room.players.filter(p => p.alive);
    const aliveMafia = alivePlayers.filter(p => p.role.includes('🔪'));
    const aliveCivilians = alivePlayers.filter(p => !p.role.includes('🔪'));

    // المافيا كسبت لو عددهم >= المواطنين
    if (aliveMafia.length >= aliveCivilians.length) {
        return { over: true, winner: 'mafia', aliveMafia, aliveCivilians };
    }
    // المواطنون كسبوا لو مفيش مافيا
    if (aliveMafia.length === 0) {
        return { over: true, winner: 'civilians', aliveMafia, aliveCivilians };
    }
    return { over: false, aliveMafia, aliveCivilians };
}

// إرسال قائمة التصويت لكل لاعب حي
function broadcastVoteLists(room) {
    const alivePlayers = room.players.filter(p => p.alive);
    const deadCivilians = room.players.filter(p => !p.alive && !p.role.includes('🔪'));
    const aliveMafia = alivePlayers.filter(p => p.role.includes('🔪'));
    const aliveCivilians = alivePlayers.filter(p => !p.role.includes('🔪'));

    // حالة خاصة: مافيا واحد ومواطن واحد — المواطنون الميتون يصوتون
    const specialCase = aliveMafia.length === 1 && aliveCivilians.length === 1;

    if (specialCase) {
        // المواطنون الميتون يصوتون على الاثنين الباقيين
        const targets = alivePlayers.map(p => p.charName);
        deadCivilians.forEach(p => {
            io.to(p.id).emit('nextRound', { chars: targets, canVote: true, isGhost: true });
        });
        // اللاعبان الحيان لا يصوتون
        alivePlayers.forEach(p => {
            io.to(p.id).emit('nextRound', { chars: [], canVote: false, isGhost: false });
        });
    } else {
        // الحالة العادية: كل لاعب حي يصوت على غيره (بدون نفسه)
        alivePlayers.forEach(p => {
            const targets = alivePlayers
                .filter(other => other.name !== p.name)
                .map(other => other.charName);
            io.to(p.id).emit('nextRound', { chars: targets, canVote: true, isGhost: false });
        });
        // المواطنون الميتون لا يصوتون في الحالة العادية
        deadCivilians.forEach(p => {
            io.to(p.id).emit('nextRound', { chars: [], canVote: false, isGhost: false });
        });
    }

    // البوس يشوف كل الأحياء
    io.to(room.boss).emit('nextRound', {
        chars: alivePlayers.map(p => p.charName),
        canVote: false,
        isGhost: false
    });
}

// ════════════════════════════════════════════════
//  Socket Events
// ════════════════════════════════════════════════
io.on('connection', (socket) => {

    // ── إنشاء غرفة ──────────────────────────────────────────────
    socket.on('createRoom', () => {
        const roomCode = Math.random().toString(36).substring(2, 6).toUpperCase();
        rooms[roomCode] = {
            boss: socket.id,
            bossToken: socket.id,
            players: [],
            votes: {},
            clues: [],
            round: 1,
            started: false,
            gameOver: false
        };
        socket.join(roomCode);
        socket.emit('roomCreated', roomCode);
        console.log('Room created:', roomCode);
    });

    // ── Reconnect البوس ──────────────────────────────────────────
    socket.on('bossReconnect', ({ roomCode, bossToken }) => {
        const room = rooms[roomCode];
        if (!room) { socket.emit('roomEnded'); return; }
        if (room.bossToken !== bossToken) { socket.emit('error', 'غير مصرح'); return; }
        room.boss = socket.id;
        socket.join(roomCode);
        socket.emit('bossReconnected', {
            players: room.players,
            started: room.started,
            scenario: room.scenario,
            clues: room.clues,
            gameOver: room.gameOver
        });
    });

    // ── انضمام لاعب ─────────────────────────────────────────────
    socket.on('joinRoom', (data) => {
        const room = rooms[data.roomCode];
        if (!room) { socket.emit('roomEnded'); return; }

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
                    allCharNames: room.players
                        .filter(p => p.alive && p.name !== existing.name)
                        .map(p => p.charName),
                    isAlive: existing.alive
                });
            }
        } else {
            if (room.started) { socket.emit('error', 'اللعبة بدأت خلاص!'); return; }
            room.players.push({
                id: socket.id, name: data.playerName,
                role: 'مواطن', alive: true, charName: '', secret: ''
            });
            socket.join(data.roomCode);
            socket.emit('joinedSuccess', { reconnected: false });
        }
        io.to(room.boss).emit('updatePlayers', room.players);
    });

    // ── Reconnect لاعب ───────────────────────────────────────────
    socket.on('playerReconnect', (data) => {
        const room = rooms[data.roomCode];
        if (!room) { socket.emit('roomEnded'); return; }

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
                        .map(p => p.charName),
                    isAlive: existing.alive
                });
            } else if (!room.started) {
                socket.emit('joinedSuccess', { reconnected: true });
                io.to(room.boss).emit('updatePlayers', room.players);
            }
        }
    });

    // ── بدء اللعبة ──────────────────────────────────────────────
    socket.on('startGame', async (data) => {
        const room = rooms[data.roomCode];
        if (!room || room.players.length === 0) return;
        room.started = true;
        room.clues = [];

        const names = room.players.map(p => p.name).join(', ');
        const prompt = `أنت مؤلف لعبة مافيا محترف باللهجة المصرية. اللاعبون هم: [${names}]. 
الجريمة: ${data.crimeType || "جريمة غامضة"}. تريكات: ${data.tricks || "لا يوجد"}.
اكتب قصة جريمة مصرية مشوقة ووزع أسامي شخصيات وأسرار لكل لاعب.
الرد JSON فقط بدون أي نص خارجه:
{"story": "القصة هنا بالتفصيل", "assignments": [{"name": "الاسم الحقيقي", "charName": "اسم الشخصية", "secret": "السر الخاص بالشخصية"}]}`;

        const response = await getAIResponse(prompt);
        if (!response) {
            io.to(room.boss).emit('error', 'فشل توليد القصة، حاول تاني');
            room.started = false;
            return;
        }

        let scenario;
        try { 
            scenario = JSON.parse(response); 
        } catch (e) {
            // محاولة استخراج JSON من النص
            const match = response.match(/\{[\s\S]*\}/);
            if (match) { 
                try { 
                    scenario = JSON.parse(match[0]); 
                } catch(e2) { 
                    // إرسال رسالة خطأ بدلاً من الصمت
                    io.to(room.boss).emit('error', 'الذكاء الاصطناعي كتب قصة بس التنسيق باظ، دوس "ابدأ الجيم" تاني!');
                    room.started = false; 
                    return; 
                } 
            } else { 
                // إرسال رسالة خطأ بدلاً من الصمت
                io.to(room.boss).emit('error', 'الذكاء الاصطناعي ماردش بتنسيق صحيح، دوس "ابدأ الجيم" تاني!');
                room.started = false; 
                return; 
            }
        }

        room.scenario = scenario;

        const mafiaCount = room.players.length > 4 ? 2 : 1;
        const shuffled = [...room.players].sort(() => Math.random() - 0.5);
        room.players.forEach(p => p.role = 'مواطن');
        shuffled.slice(0, mafiaCount).forEach(p => { p.role = 'مافيوسو 🔪'; });

        room.players.forEach(p => {
            const assign = scenario.assignments?.find(a => a.name === p.name);
            p.charName = assign?.charName || p.name;
            p.secret   = assign?.secret   || "لا يوجد سر";
        });

        // إرسال للاعبين
        room.players.forEach(p => {
            io.to(p.id).emit('gameData', {
                role: p.role,
                story: scenario.story,
                charName: p.charName,
                charSecret: p.secret,
                allCharNames: room.players.filter(o => o.name !== p.name).map(o => o.charName),
                isAlive: true
            });
        });

        // إرسال للبوس مع القصة كاملة
        io.to(room.boss).emit('bossData', {
            story: scenario.story,
            players: room.players
        });

        // أول دليل في بداية اللعبة
        await sendClue(data.roomCode);
    });

    // ── إرسال دليل (للبوس فقط، ثابت) ──────────────────────────
    async function sendClue(roomCode) {
        const room = rooms[roomCode];
        if (!room?.scenario) return;
        const mafiaChars = room.players.filter(p => p.role.includes('🔪')).map(p => p.charName).join(' و ');
        const prevClues = room.clues.map(c => c.text).join(' | ');
        const prompt = `في لعبة المافيا هذه:
القصة: ${room.scenario.story}
المافيا (سري): ${mafiaChars}
الأدلة السابقة: ${prevClues || "لا يوجد"}
أعطني دليلاً مادياً غامضاً جديداً يلمح لأحد المافيا في الجولة ${room.round} دون أن يكشفه مباشرة. جملة واحدة فقط باللهجة المصرية.`;

        const clue = await getAIResponse(prompt);
        if (!clue) return;

        const clueObj = {
            text: clue,
            round: room.round,
            time: new Date().toLocaleTimeString('ar-EG')
        };
        room.clues.push(clueObj);
        // الدليل للبوس فقط
        io.to(room.boss).emit('receiveClue', clueObj);
    }

    socket.on('requestPhysicalClue', (roomCode) => sendClue(roomCode));

    // ── Panic Mode — حدث مفاجئ + تأثير بصري ────────────────────
    socket.on('triggerPanic', async (roomCode) => {
        const room = rooms[roomCode];
        // نبعت التأثير البصري/الصوتي فوراً للكل
        io.to(roomCode).emit('panicAction');

        // نولد Plot Twist من AI للبوس
        if (room?.scenario) {
            const prompt = `في لعبة مافيا مصرية، القصة: ${room.scenario.story}. 
اللاعبون الأحياء: ${room.players.filter(p=>p.alive).map(p=>p.charName).join(', ')}.
اكتب حدثاً مفاجئاً (Plot Twist) درامياً ومثيراً يغير مجرى التحقيق تماماً. 
جملتان أو ثلاث بالعربية، مثيرة ومشوقة.`;
            const twist = await getAIResponse(prompt);
            if (twist) {
                io.to(room.boss).emit('panicTwist', twist);
            }
        }
    });

    // ── التصويت ─────────────────────────────────────────────────
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

    // ── تنفيذ الإعدام ────────────────────────────────────────────
    socket.on('executePlayer', (roomCode) => {
        const room = rooms[roomCode];
        if (!room) return;

        const counts = {};
        Object.values(room.votes).forEach(v => counts[v] = (counts[v] || 0) + 1);
        const sorted = Object.entries(counts).sort((a, b) => b[1] - a[1]);
        if (!sorted.length) { io.to(room.boss).emit('error', 'مفيش تصويت لسه!'); return; }

        const kickedChar = sorted[0][0];
        const p = room.players.find(pl => pl.charName === kickedChar);
        if (p) p.alive = false;

        const isMafia = p?.role.includes('🔪') || false;
        const win = checkWinCondition(room);

        // رسالة الإعدام
        let execMsg = '';
        if (isMafia) {
            const remainingMafia = win.aliveMafia.length;
            if (win.over && win.winner === 'civilians') {
                execMsg = `🎉 انتصرت المدينة! "${kickedChar}" كان المافيوسو الأخير! اللعبة انتهت.`;
            } else {
                execMsg = `✅ أصبتم! "${kickedChar}" كان مافيوسو 🔪 — لا يزال ${remainingMafia} مافيا في الخفاء...`;
            }
        } else {
            execMsg = `😢 يا نهار أبيض! "${kickedChar}" كان مواطناً بريئاً. المدينة خسرت رجلاً صالحاً والمافيا لا تزال حرة!`;
        }

        io.to(roomCode).emit('executionResult', {
            charName: kickedChar,
            isMafia,
            message: execMsg,
            gameOver: win.over,
            winner: win.winner
        });

        if (win.over) {
            let finalMsg = win.winner === 'civilians'
                ? `🏆 المدينة انتصرت! تم القضاء على المافيا كلها!`
                : `💀 المافيا كسبت! استولوا على المدينة!`;
            setTimeout(() => {
                io.to(roomCode).emit('gameOver', finalMsg);
                if (rooms[roomCode]) rooms[roomCode].gameOver = true;
            }, 4000);
        } else {
            room.round++;
            room.votes = {};
            // دليل جديد في بداية الجولة الجديدة
            sendClue(roomCode);
            // إرسال قوائم التصويت
            setTimeout(() => broadcastVoteLists(room), 1000);
        }
    });

    // ── إغلاق الغرفة (البوس) ─────────────────────────────────────
    socket.on('closeRoom', (roomCode) => {
        io.to(roomCode).emit('roomEnded');
        delete rooms[roomCode];
        console.log('Room closed:', roomCode);
    });

    socket.on('disconnect', () => {
        // مش بنحذف اللاعب — بنديه فرصة يرجع
    });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
    console.log(`✅ Server on port ${PORT}`);
    console.log(`🤖 Gemini: ${GEMINI_KEYS.length} keys | Groq: ${GROQ_KEYS.length} keys`);
});