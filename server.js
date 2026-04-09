
const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const { GoogleGenerativeAI } = require("@google/generative-ai");
const classicMafia = require('./classicMafia'); // استدعاء ملف الكلاسيك

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
    
].filter(Boolean);

const GROQ_KEYS = [
    process.env.GROQ_KEY,
    
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

    // المواطنون يخسرون فقط إذا ماتوا جميعاً
    if (aliveCivilians.length === 0) {
        return { over: true, winner: 'mafia', aliveMafia, aliveCivilians };
    }
    // المافيا تخسر فقط إذا ماتوا جميعاً
    if (aliveMafia.length === 0) {
        return { over: true, winner: 'civilians', aliveMafia, aliveCivilians };
    }
    return { over: false, aliveMafia, aliveCivilians };
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
        
        // التعديل هنا: نلغي المؤقت لو البوس رجع للغرفة
        if (room.deleteTimer) {
            clearTimeout(room.deleteTimer);
            room.deleteTimer = null;
        }

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
        
        // لو البوس اختار الوضع الكلاسيكي
        if (data.mode === 'classic') {
            room.started = true;
            classicMafia.startGame(io, room, data.roomCode);
            return; // نوقف هنا عشان ميكملش لذكاء الاصطناعي
        }

        // --- باقي كود الذكاء الاصطناعي للمافيوسو كما هو أسفل هذا السطر ---
        room.started = true;
        room.clues = [];
        // ... (باقي كود الـ prompt و الـ AI اللي عندك)

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
        // التعديل هنا: تنظيف النص من علامات الماركداون قبل التحليل
        let cleanedResponse = response.replace(/```json/gi, '').replace(/```/g, '').trim();

        try { 
            scenario = JSON.parse(cleanedResponse); 
        } catch (e) {
            // محاولة استخراج JSON من النص
            const match = cleanedResponse.match(/\{[\s\S]*\}/);
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
المافيا (سري جداً): ${mafiaChars}
الأدلة السابقة: ${prevClues || "لا يوجد"}
أعطني دليلاً مادياً غامضاً جديداً يلمح لأحد المافيا في الجولة ${room.round}.
الرد يجب أن يكون JSON فقط بهذا الشكل: {"clue": "نص الدليل هنا"}`;
        
        const response = await getAIResponse(prompt);
        if (!response) return;

        try {
            let cleaned = response.replace(/```json/gi, '').replace(/```/g, '').trim();
            let parsed = JSON.parse(cleaned);
            const clueObj = {
                text: parsed.clue || parsed,
                round: room.round,
                time: new Date().toLocaleTimeString('ar-EG')
            };
            room.clues.push(clueObj);
            io.to(room.boss).emit('receiveClue', clueObj);
        } catch (e) {
            console.error("Clue parse error");
        }
    }

    socket.on('requestPhysicalClue', (roomCode) => sendClue(roomCode));

    // ── إرسال البوس الدليل للاعبين ─────────────────────────────
    socket.on('shareClue', (data) => {
        // نبعت الدليل لكل اللي في الغرفة (عشان يظهر عند اللاعبين)
        io.to(data.roomCode).emit('clueShared', data.clue);
    });

    // ── Panic Mode — حدث مفاجئ + تأثير بصري ────────────────────
    socket.on('triggerPanic', async (roomCode) => {
        const room = rooms[roomCode];
        io.to(roomCode).emit('panicAction');

        if (room?.scenario) {
            const prompt = `في لعبة مافيا مصرية، القصة: ${room.scenario.story}. 
اللاعبون الأحياء: ${room.players.filter(p=>p.alive).map(p=>p.charName).join(', ')}.
اكتب حدثاً مفاجئاً (Plot Twist) يغير مجرى التحقيق.
الرد يجب أن يكون JSON فقط بهذا الشكل: {"twist": "نص التويست هنا"}`;
            
            const response = await getAIResponse(prompt);
            if (response) {
                try {
                    let cleaned = response.replace(/```json/gi, '').replace(/```/g, '').trim();
                    let parsed = JSON.parse(cleaned);
                    io.to(room.boss).emit('panicTwist', parsed.twist || parsed);
                } catch(e) {
                    console.error("Twist parse error");
                }
            }
        }
    });

// ── إرسال البوس التويست للاعبين ─────────────────────────────
    socket.on('shareTwist', (data) => {
        io.to(data.roomCode).emit('twistShared', data.twist);
    });
    // ── بدء مرحلة التصويت (من البوس) ─────────────────────────────
    // ── بدء مرحلة التصويت (من البوس) ─────────────────────────────
    socket.on('startVotingPhase', (roomCode) => {
        const room = rooms[roomCode];
        if (!room) return;

        const alivePlayers = room.players.filter(p => p.alive);
        const aliveMafia = alivePlayers.filter(p => p.role.includes('🔪'));
        const aliveCivilians = alivePlayers.filter(p => !p.role.includes('🔪'));
        
        // الأموات مقسمين
        const deadCivilians = room.players.filter(p => !p.alive && !p.role.includes('🔪'));
        const deadMafia = room.players.filter(p => !p.alive && p.role.includes('🔪'));

        // حالة خاصة: 1 مافيا و 1 مواطن
        const specialCase = aliveMafia.length === 1 && aliveCivilians.length === 1 && alivePlayers.length === 2;

        if (specialCase) {
            const targets = alivePlayers.map(p => p.charName);
            
            // 1. المواطنون الميتون (الأشباح) فقط هم من يصوتون
            deadCivilians.forEach(p => {
                io.to(p.id).emit('nextRound', { chars: targets, canVote: true, isGhost: true });
            });
            
            // 2. الأحياء (المواطن والمافيا) لا يصوتون
            alivePlayers.forEach(p => {
                io.to(p.id).emit('nextRound', { chars: [], canVote: false, isGhost: false });
            });

            // 3. المافيا الميتين لا يصوتون
            deadMafia.forEach(p => {
                io.to(p.id).emit('nextRound', { chars: [], canVote: false, isGhost: true });
            });

        } else {
            // الحالة العادية
            // الأحياء يصوتون
            alivePlayers.forEach(p => {
                const targets = alivePlayers.filter(other => other.name !== p.name).map(other => other.charName);
                io.to(p.id).emit('nextRound', { chars: targets, canVote: true, isGhost: false });
            });
            
            // كل الأموات لا يصوتون في الحالة العادية
            room.players.filter(p => !p.alive).forEach(p => {
                io.to(p.id).emit('nextRound', { chars: [], canVote: false, isGhost: true });
            });
        }
        
        // إبلاغ البوس أن التصويت بدأ
        io.to(room.boss).emit('votingStarted');
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

        // التعديل هنا: فحص التعادل
        if (sorted.length > 1 && sorted[0][1] === sorted[1][1]) {
            io.to(room.boss).emit('error', 'في تعادل في التصويت! خلّي اللاعبين يتناقشوا وصوّتوا تاني.');
            return; // وقف التنفيذ هنا
        }

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
            // نرسل دليل جديد فقط، ولا نرسل قوائم التصويت!
            sendClue(roomCode);
        }
    });

    // ── إغلاق الغرفة (البوس) ─────────────────────────────────────
    socket.on('closeRoom', (roomCode) => {
        io.to(roomCode).emit('roomEnded');
        delete rooms[roomCode];
        console.log('Room closed:', roomCode);
    });

    // ════════════════════════════════════════════════
    //  نظام المحادثة الصوتية (WebRTC Signaling)
    // ════════════════════════════════════════════════
    
    // لاعب بيدخل غرفة الصوت
    socket.on('joinVoice', (roomCode) => {
        socket.join(`${roomCode}-voice`);
        // بنبلغ باقي الناس اللي في غرفة الصوت إن في حد جديد دخل
        socket.to(`${roomCode}-voice`).emit('user-joined-voice', socket.id);
    });

    // تبادل بيانات الاتصال بين اللاعبين
    socket.on('webrtc-offer', (data) => {
        io.to(data.target).emit('webrtc-offer', { sender: socket.id, sdp: data.sdp });
    });

    socket.on('webrtc-answer', (data) => {
        io.to(data.target).emit('webrtc-answer', { sender: socket.id, sdp: data.sdp });
    });

    socket.on('webrtc-ice-candidate', (data) => {
        io.to(data.target).emit('webrtc-ice-candidate', { sender: socket.id, candidate: data.candidate });
    });
   // ── أحداث لعبة المافيا الكلاسيكية ─────────────────────────────
    socket.on('mafiaSubmitKill', (data) => {
        const room = rooms[data.roomCode];
        if (room && room.mode === 'classic') {
            classicMafia.handleMafiaVote(io, room, data.roomCode, socket.id, data.target);
        }
    });

    socket.on('doctorSubmitSave', (data) => {
        const room = rooms[data.roomCode];
        if (room && room.mode === 'classic') {
            classicMafia.handleDoctorSave(io, room, data.roomCode, data.target);
        }
    });

    socket.on('disconnect', () => {
        for (const roomCode in rooms) {
            const room = rooms[roomCode];
            // لو اللي فصل هو البوس، نعمل مؤقت 10 دقايق يمسح الغرفة
            if (room.boss === socket.id) {
                room.deleteTimer = setTimeout(() => {
                    if (rooms[roomCode]) {
                        io.to(roomCode).emit('roomEnded');
                        delete rooms[roomCode];
                        console.log(`Room ${roomCode} deleted due to boss inactivity.`);
                    }
                }, 10 * 60 * 1000); // 10 دقائق
                break;
            }
        }
    });
    });

 

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
    console.log(`✅ Server on port ${PORT}`);
    console.log(`🤖 Gemini: ${GEMINI_KEYS.length} keys | Groq: ${GROQ_KEYS.length} keys`);
});
