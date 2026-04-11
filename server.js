
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
                    response_format: { type: "json_object" }
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

// ════════════════════════════════════════════════
//  Rooms — كل لعبة لها rooms منفصلة
// ════════════════════════════════════════════════
let rooms = {};     // المافيوسو تريال (الأصلية)
let mcRooms = {};   // المافيا الكلاسيك
let impRooms = {};  // الإمبوستر

// ════════════════════════════════════════════════
//  Helpers
// ════════════════════════════════════════════════
function checkWinCondition(room) {
    const alivePlayers = room.players.filter(p => p.alive);
    const aliveMafia = alivePlayers.filter(p => p.role.includes('🔪'));
    const aliveCivilians = alivePlayers.filter(p => !p.role.includes('🔪'));
    if (aliveCivilians.length === 0) {
        return { over: true, winner: 'mafia', aliveMafia, aliveCivilians };
    }
    if (aliveMafia.length === 0) {
        return { over: true, winner: 'civilians', aliveMafia, aliveCivilians };
    }
    return { over: false, aliveMafia, aliveCivilians };
}

// ════════════════════════════════════════════════
//  Socket Events
// ════════════════════════════════════════════════
i// ════════════════════════════════════════════════
//  Socket Events
// ════════════════════════════════════════════════
io.on('connection', (socket) => {

    // ══════════════════════════════════════════════
    //  ① المافيوسو تريال (الأصلية)
    // ══════════════════════════════════════════════

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

    socket.on('bossReconnect', ({ roomCode, bossToken }) => {
        const room = rooms[roomCode];
        if (!room) { socket.emit('roomEnded'); return; }
        if (room.bossToken !== bossToken) { socket.emit('error', 'غير مصرح'); return; }
        if (room.deleteTimer) { clearTimeout(room.deleteTimer); room.deleteTimer = null; }
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
                    allCharNames: room.players.filter(p => p.alive && p.name !== existing.name).map(p => p.charName),
                    isAlive: existing.alive
                });
            }
        } else {
            if (room.started) { socket.emit('error', 'اللعبة بدأت خلاص!'); return; }
            room.players.push({ id: socket.id, name: data.playerName, role: 'مواطن', alive: true, charName: '', secret: '' });
            socket.join(data.roomCode);
            socket.emit('joinedSuccess', { reconnected: false });
        }
        io.to(room.boss).emit('updatePlayers', room.players);
    });

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
                    allCharNames: room.players.filter(p => p.alive && p.name !== existing.name).map(p => p.charName),
                    isAlive: existing.alive
                });
            } else if (!room.started) {
                socket.emit('joinedSuccess', { reconnected: true });
                io.to(room.boss).emit('updatePlayers', room.players);
            }
        }
    });

    socket.on('startGame', async (data) => {
        const room = rooms[data.roomCode];
        if (!room || room.players.length === 0) return;
        room.started = true;
        room.clues = [];

        const names = room.players.map(p => p.name).join(', ');
        const prompt = `أنت مؤلف لعبة مافيا محترف باللهجة المصرية. اللاعبون هم: [${names}]. \nالجريمة: ${data.crimeType || "جريمة غامضة"}. تريكات: ${data.tricks || "لا يوجد"}.\nاكتب قصة جريمة مصرية مشوقة ووزع أسامي شخصيات وأسرار لكل لاعب.\nالرد JSON فقط بدون أي نص خارجه:\n{"story": "القصة هنا بالتفصيل", "assignments": [{"name": "الاسم الحقيقي", "charName": "اسم الشخصية", "secret": "السر الخاص بالشخصية"}]}`;

        const response = await getAIResponse(prompt);
        if (!response) {
            io.to(room.boss).emit('error', 'فشل توليد القصة، حاول تاني');
            room.started = false;
            return;
        }

        let scenario;
        let cleanedResponse = response.replace(/```json/gi, '').replace(/```/g, '').trim();
        try { 
            scenario = JSON.parse(cleanedResponse); 
        } catch (e) {
            const match = cleanedResponse.match(/\{[\s\S]*\}/);
            if (match) { 
                try { scenario = JSON.parse(match[0]); } 
                catch(e2) { io.to(room.boss).emit('error', 'الذكاء الاصطناعي كتب قصة بس التنسيق باظ، دوس "ابدأ الجيم" تاني!'); room.started = false; return; } 
            } else { 
                io.to(room.boss).emit('error', 'الذكاء الاصطناعي ماردش بتنسيق صحيح، دوس "ابدأ الجيم" تاني!'); room.started = false; return; 
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
            p.secret = assign?.secret || "لا يوجد سر";
        });

        room.players.forEach(p => {
            io.to(p.id).emit('gameData', {
                role: p.role, story: scenario.story, charName: p.charName,
                charSecret: p.secret,
                allCharNames: room.players.filter(o => o.name !== p.name).map(o => o.charName),
                isAlive: true
            });
        });

        io.to(room.boss).emit('bossData', { story: scenario.story, players: room.players });
        await sendClue(data.roomCode);
    });

    async function sendClue(roomCode) {
        const room = rooms[roomCode];
        if (!room?.scenario) return;
        const mafiaChars = room.players.filter(p => p.role.includes('🔪')).map(p => p.charName).join(' و ');
        const prevClues = room.clues.map(c => c.text).join(' | ');
        const prompt = `في لعبة المافيا هذه:\nالقصة: ${room.scenario.story}\nالمافيا (سري جداً): ${mafiaChars}\nالأدلة السابقة: ${prevClues || "لا يوجد"}\nأعطني دليلاً مادياً غامضاً جديداً يلمح لأحد المافيا في الجولة ${room.round}.\nالرد يجب أن يكون JSON فقط بهذا الشكل: {"clue": "نص الدليل هنا"}`;
        
        const response = await getAIResponse(prompt);
        if (!response) return;

        try {
            let cleaned = response.replace(/```json/gi, '').replace(/```/g, '').trim();
            let parsed = JSON.parse(cleaned);
            const clueObj = { text: parsed.clue || parsed, round: room.round, time: new Date().toLocaleTimeString('ar-EG') };
            room.clues.push(clueObj);
            io.to(room.boss).emit('receiveClue', clueObj);
        } catch (e) { console.error("Clue parse error"); }
    }

    socket.on('requestPhysicalClue', (roomCode) => sendClue(roomCode));

    socket.on('shareClue', (data) => { io.to(data.roomCode).emit('clueShared', data.clue); });

    socket.on('triggerPanic', async (roomCode) => {
        const room = rooms[roomCode];
        io.to(roomCode).emit('panicAction');
        if (room?.scenario) {
            const prompt = `في لعبة مافيا مصرية، القصة: ${room.scenario.story}. \nاللاعبون الأحياء: ${room.players.filter(p=>p.alive).map(p=>p.charName).join(', ')}.\nاكتب حدثاً مفاجئاً (Plot Twist) يغير مجرى التحقيق.\nالرد يجب أن يكون JSON فقط بهذا الشكل: {"twist": "نص التويست هنا"}`;
            const response = await getAIResponse(prompt);
            if (response) {
                try {
                    let cleaned = response.replace(/```json/gi, '').replace(/```/g, '').trim();
                    let parsed = JSON.parse(cleaned);
                    io.to(room.boss).emit('panicTwist', parsed.twist || parsed);
                } catch(e) {}
            }
        }
    });

    socket.on('shareTwist', (data) => { io.to(data.roomCode).emit('twistShared', data.twist); });

    socket.on('startVotingPhase', (roomCode) => {
        const room = rooms[roomCode];
        if (!room) return;
        
        const VOTING_TIME = 30; // ثواني
        
        const alivePlayers = room.players.filter(p => p.alive);
        const aliveMafia = alivePlayers.filter(p => p.role.includes('🔪'));
        const aliveCivilians = alivePlayers.filter(p => !p.role.includes('🔪'));
        const deadPlayers = room.players.filter(p => !p.alive);
        const specialCase = aliveMafia.length === 1 && aliveCivilians.length === 1 && alivePlayers.length === 2;

        io.to(roomCode).emit('phaseTimer', {
            seconds: VOTING_TIME,
            label: 'التصويت',
            phase: 'voting'
        });

        if (specialCase) {
            const targets = alivePlayers.map(p => p.charName);
            deadPlayers.forEach(p => { 
                io.to(p.id).emit('nextRound', { chars: targets, canVote: true, isGhost: true, timer: VOTING_TIME }); 
            });
            alivePlayers.forEach(p => { 
                io.to(p.id).emit('nextRound', { chars: [], canVote: false, isGhost: false, timer: VOTING_TIME }); 
            });
        } else {
            alivePlayers.forEach(p => {
                const targets = alivePlayers.filter(other => other.name !== p.name).map(other => other.charName);
                io.to(p.id).emit('nextRound', { chars: targets, canVote: true, isGhost: false, timer: VOTING_TIME });
            });
            deadPlayers.forEach(p => { 
                io.to(p.id).emit('nextRound', { chars: [], canVote: false, isGhost: true, timer: VOTING_TIME }); 
            });
        }
        io.to(room.boss).emit('votingStarted', { timer: VOTING_TIME });
        
        setTimeout(() => {
            if(room && room.votes && Object.keys(room.votes).length > 0) {
                io.to(room.boss).emit('timerExpired', { phase: 'voting', autoExecute: true });
            }
        }, VOTING_TIME * 1000);
    });

    socket.on('castVote', (data) => {
        const room = rooms[data.roomCode];
        if (!room) return;
        room.votes[socket.id] = data.votedForChar;
        const counts = {};
        Object.values(room.votes).forEach(v => counts[v] = (counts[v] || 0) + 1);
        io.to(room.boss).emit('voteResultUpdate', { totalVotes: Object.keys(room.votes).length, details: counts });
    });
    
    socket.on('ghostMessage', ({ roomCode, message }) => {
        const room = rooms[roomCode];
        if (!room) return;
        
        const sender = room.players.find(p => p.id === socket.id);
        if (!sender || sender.alive) return;
        
        const deadPlayers = room.players.filter(p => !p.alive);
        deadPlayers.forEach(p => {
            io.to(p.id).emit('ghostMessage', {
                name: sender.charName || sender.name,
                message: message,
                time: new Date().toLocaleTimeString('ar-EG')
            });
        });
    });
    
    socket.on('requestSpectatorData', (roomCode) => {
        const room = rooms[roomCode];
        if (!room) return;
        
        const player = room.players.find(p => p.id === socket.id);
        if (!player || player.alive) return;
        
        socket.emit('spectatorData', {
            allPlayers: room.players.map(p => ({
                name: p.name,
                charName: p.charName,
                role: p.role,
                secret: p.secret,
                alive: p.alive
            })),
            clues: room.clues || []
        });
    });
    
    socket.on('executePlayer', (roomCode) => {
        const room = rooms[roomCode];
        if (!room) return;
        const counts = {};
        Object.values(room.votes).forEach(v => counts[v] = (counts[v] || 0) + 1);
        const sorted = Object.entries(counts).sort((a, b) => b[1] - a[1]);
        if (!sorted.length) { io.to(room.boss).emit('error', 'مفيش تصويت لسه!'); return; }
        if (sorted.length > 1 && sorted[0][1] === sorted[1][1]) { io.to(room.boss).emit('error', 'في تعادل في التصويت! خلّي اللاعبين يتناقشوا وصوّتوا تاني.'); return; }

        const kickedChar = sorted[0][0];
        const p = room.players.find(pl => pl.charName === kickedChar);
        if (p) p.alive = false;
        const isMafia = p?.role.includes('🔪') || false;
        const win = checkWinCondition(room);

        let execMsg = '';
        if (isMafia) {
            const remainingMafia = win.aliveMafia.length;
            if (win.over && win.winner === 'civilians') execMsg = `🎉 انتصرت المدينة! "${kickedChar}" كان المافيوسو الأخير! اللعبة انتهت.`;
            else execMsg = `✅ أصبتم! "${kickedChar}" كان مافيوسو 🔪 — لا يزال ${remainingMafia} مافيا في الخفاء...`;
        } else {
            execMsg = `😢 يا نهار أبيض! "${kickedChar}" كان مواطناً بريئاً. المدينة خسرت رجلاً صالحاً والمافيا لا تزال حرة!`;
        }

        io.to(roomCode).emit('executionResult', { charName: kickedChar, isMafia, message: execMsg, gameOver: win.over, winner: win.winner });

        if (win.over) {
            let finalMsg = win.winner === 'civilians' ? `🏆 المدينة انتصرت! تم القضاء على المافيا كلها!` : `💀 المافيا كسبت! استولوا على المدينة!`;
            setTimeout(() => { io.to(roomCode).emit('gameOver', finalMsg); if (rooms[roomCode]) rooms[roomCode].gameOver = true; }, 4000);
        } else {
            room.round++;
            room.votes = {};
            sendClue(roomCode);
        }
    });

    socket.on('closeRoom', (roomCode) => { io.to(roomCode).emit('roomEnded'); delete rooms[roomCode]; console.log('Room closed:', roomCode); });

    // WebRTC Signaling
    socket.on('joinVoice', (roomCode) => { socket.join(`${roomCode}-voice`); socket.to(`${roomCode}-voice`).emit('user-joined-voice', socket.id); });
    socket.on('webrtc-offer', (data) => { io.to(data.target).emit('webrtc-offer', { sender: socket.id, sdp: data.sdp }); });
    socket.on('webrtc-answer', (data) => { io.to(data.target).emit('webrtc-answer', { sender: socket.id, sdp: data.sdp }); });
    socket.on('webrtc-ice-candidate', (data) => { io.to(data.target).emit('webrtc-ice-candidate', { sender: socket.id, candidate: data.candidate }); });

    // ══════════════════════════════════════════════
    //  ② المافيا الكلاسيك
    // ══════════════════════════════════════════════
    registerMafiaClassic(io, socket, mcRooms, getAIResponse);

    // ══════════════════════════════════════════════
    //  ③ الإمبوستر
    // ══════════════════════════════════════════════
    registerImpostor(io, socket, impRooms, getAIResponse);

    // ══════════════════════════════════════════════
    //  Disconnect
    // ══════════════════════════════════════════════
    socket.on('disconnect', () => {
        for (const roomCode in rooms) {
            const room = rooms[roomCode];
            if (room.boss === socket.id) {
                room.deleteTimer = setTimeout(() => {
                    if (rooms[roomCode]) { io.to(roomCode).emit('roomEnded'); delete rooms[roomCode]; console.log(`Room ${roomCode} deleted.`); }
                }, 10 * 60 * 1000);
                break;
            }
        }
        for (const roomCode in mcRooms) {
            const room = mcRooms[roomCode];
            if (room.boss === socket.id) {
                room.deleteTimer = setTimeout(() => {
                    if (mcRooms[roomCode]) { io.to('mc_' + roomCode).emit('roomEnded'); delete mcRooms[roomCode]; }
                }, 10 * 60 * 1000);
                break;
            }
        }
        for (const roomCode in impRooms) {
            const room = impRooms[roomCode];
            if (room.boss === socket.id) {
                room.deleteTimer = setTimeout(() => {
                    if (impRooms[roomCode]) { io.to('imp_' + roomCode).emit('roomEnded'); delete impRooms[roomCode]; }
                }, 10 * 60 * 1000);
                break;
            }
        }
    });
});
// ════════════════════════════════════════════════
//  Load Game Modules
// ════════════════════════════════════════════════
const registerMafiaClassic = require('./mafia-classic-server');
const registerImpostor = require('./impostor-server');

// ════════════════════════════════════════════════
//  Keep-alive (يمنع الـ 502 على الاستضافة المجانية)
// ════════════════════════════════════════════════
setInterval(() => { console.log('💓 Keep-alive'); }, 10 * 60 * 1000);

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
    console.log(`✅ Server on port ${PORT}`);
    console.log(`🤖 Gemini: ${GEMINI_KEYS.length} keys | Groq: ${GROQ_KEYS.length} keys`);
});
