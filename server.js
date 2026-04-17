// ════════════════════════════════════════════════════════════════
//  MAFIOSO GAME — Server (v3 - Redis + Security + Timers)
// ════════════════════════════════════════════════════════════════

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
//  Redis (optional — falls back to in-memory)
// ════════════════════════════════════════════════
let redis = null;
let useRedis = false;

async function initRedis() {
    try {
        const { createClient } = require('redis');
        if (!process.env.REDIS_URL) {
    console.warn('⚠️ No REDIS_URL found → using memory only');
    useRedis = false;
    return;
}

redis = createClient({ url: process.env.REDIS_URL });

let redisErrorLogged = false;

redis.on('error', (err) => {
    if (!redisErrorLogged) {
        console.warn('Redis error:', err.message);
        redisErrorLogged = true;
    }
});


await redis.connect();
useRedis = true;
console.log('✅ Redis connected');
        redis.on('error', (err) => console.warn('Redis error:', err.message));
        await redis.connect();
        useRedis = true;
        console.log('✅ Redis connected');
    } catch (e) {
        console.warn('⚠️ Redis not available, using in-memory storage:', e.message);
        useRedis = false;
    }
}
async function start() {
    server.listen(PORT, () => {
        console.log(`✅ Server on port ${PORT}`);
    });

    await initRedis();
}
// ════════════════════════════════════════════════
//  Room Storage Adapter (Redis or Memory)
// ════════════════════════════════════════════════
class RoomStore {
    constructor(prefix) {
        this.prefix = prefix;
        this.memory = {};
    }

    async get(code) {
        if (useRedis) {
            try {
                const data = await redis.get(`${this.prefix}:${code}`);
                return data ? JSON.parse(data) : null;
            } catch (e) {
                return this.memory[code] || null;
            }
        }
        return this.memory[code] || null;
    }

    async set(code, room) {
        room._lastActivity = Date.now();
        this.memory[code] = room;
        if (useRedis) {
            try {
                await redis.set(`${this.prefix}:${code}`, JSON.stringify(room), { EX: 3600 }); // 1hr TTL
            } catch (e) {}
        }
    }

    async del(code) {
        delete this.memory[code];
        if (useRedis) {
            try { await redis.del(`${this.prefix}:${code}`); } catch (e) {}
        }
    }

    getAll() {
        return this.memory;
    }

    entries() {
        return Object.entries(this.memory);
    }
}

// Sync wrapper for backward compatibility — rooms still accessed synchronously in handlers
// We keep memory as primary and sync to Redis in background
let rooms = {};     // المافيوسو تريال
let mcRooms = {};   // المافيا الكلاسيك
let impRooms = {};  // الإمبوستر

// ════════════════════════════════════════════════
//  Rate Limiting
// ════════════════════════════════════════════════
const rateLimits = new Map(); // socketId -> { count, resetTime }

function rateLimit(socketId, maxPerMinute = 30) {
    const now = Date.now();
    let entry = rateLimits.get(socketId);
    if (!entry || now > entry.resetTime) {
        entry = { count: 0, resetTime: now + 60000 };
        rateLimits.set(socketId, entry);
    }
    entry.count++;
    if (entry.count > maxPerMinute) {
        return false; // rate limited
    }
    return true;
}

// Clean up rate limit entries every 5 min
setInterval(() => {
    const now = Date.now();
    for (const [id, entry] of rateLimits) {
        if (now > entry.resetTime) rateLimits.delete(id);
    }
}, 5 * 60 * 1000);

// ════════════════════════════════════════════════
//  Auto Cleanup — delete inactive rooms
// ════════════════════════════════════════════════
const ROOM_TTL = 30 * 60 * 1000; // 30 minutes

function autoCleanup() {
    const now = Date.now();
    for (const code in rooms) {
        if (rooms[code]._lastActivity && now - rooms[code]._lastActivity > ROOM_TTL) {
            io.to(code).emit('roomEnded');
            delete rooms[code];
            console.log(`🧹 Auto-cleaned room: ${code}`);
        }
    }
    for (const code in mcRooms) {
        if (mcRooms[code]._lastActivity && now - mcRooms[code]._lastActivity > ROOM_TTL) {
            io.to('mc_' + code).emit('roomEnded');
            delete mcRooms[code];
            console.log(`🧹 Auto-cleaned mc room: ${code}`);
        }
    }
    for (const code in impRooms) {
        if (impRooms[code]._lastActivity && now - impRooms[code]._lastActivity > ROOM_TTL) {
            io.to('imp_' + code).emit('roomEnded');
            delete impRooms[code];
            console.log(`🧹 Auto-cleaned imp room: ${code}`);
        }
    }
}

setInterval(autoCleanup, 5 * 60 * 1000);

// ════════════════════════════════════════════════
//  Input Validation
// ════════════════════════════════════════════════
function sanitize(str, maxLen = 50) {
    if (typeof str !== 'string') return '';
    return str.trim().substring(0, maxLen).replace(/[<>]/g, '');
}

function isValidCode(code) {
    return typeof code === 'string' && /^[A-Z0-9]{4}$/.test(code);
}

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
//  Helpers
// ════════════════════════════════════════════════
function touchRoom(room) {
    room._lastActivity = Date.now();
}

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
//  Load Game Modules
// ════════════════════════════════════════════════
const registerMafiaClassic = require('./mafia-classic-server');
const registerImpostor = require('./impostor-server');

// ════════════════════════════════════════════════
//  Socket Events
// ════════════════════════════════════════════════
io.on('connection', (socket) => {

    // Rate limit middleware
    const originalOn = socket.on.bind(socket);
    socket.on = function(event, handler) {
        if (['connect', 'disconnect', 'error'].includes(event)) {
            return originalOn(event, handler);
        }
        return originalOn(event, (...args) => {
            if (!rateLimit(socket.id)) {
                socket.emit('error', 'أنت بتبعت رسائل كتير! استنى شوية.');
                return;
            }
            handler(...args);
        });
    };

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
            gameOver: false,
            _lastActivity: Date.now()
        };
        socket.join(roomCode);
        socket.emit('roomCreated', roomCode);
        console.log('Room created:', roomCode);
    });

    socket.on('bossReconnect', ({ roomCode, bossToken }) => {
        if (!isValidCode(roomCode)) return;
        const room = rooms[roomCode];
        if (!room) { socket.emit('roomEnded'); return; }
        if (room.bossToken !== bossToken) { socket.emit('error', 'غير مصرح'); return; }
        if (room.deleteTimer) { clearTimeout(room.deleteTimer); room.deleteTimer = null; }
        room.boss = socket.id;
        touchRoom(room);
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
        if (!data || !isValidCode(data.roomCode)) return;
        const playerName = sanitize(data.playerName, 20);
        if (!playerName) { socket.emit('error', 'اسم غير صالح'); return; }
        
        const room = rooms[data.roomCode];
        if (!room) { socket.emit('roomEnded'); return; }
        touchRoom(room);
        
        const existing = room.players.find(p => p.name === playerName);
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
            if (room.players.length >= 20) { socket.emit('error', 'الغرفة ممتلئة!'); return; }
            room.players.push({ id: socket.id, name: playerName, role: 'مواطن', alive: true, charName: '', secret: '' });
            socket.join(data.roomCode);
            socket.emit('joinedSuccess', { reconnected: false });
        }
        io.to(room.boss).emit('updatePlayers', room.players);
    });

    socket.on('playerReconnect', (data) => {
        if (!data || !isValidCode(data.roomCode)) return;
        const room = rooms[data.roomCode];
        if (!room) { socket.emit('roomEnded'); return; }
        touchRoom(room);
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
        if (!data || !isValidCode(data.roomCode)) return;
        const room = rooms[data.roomCode];
        if (!room || room.players.length === 0) return;
        if (socket.id !== room.boss) return;
        room.started = true;
        room.clues = [];
        touchRoom(room);

        const crimeType = sanitize(data.crimeType || '', 100);
        const tricks = sanitize(data.tricks || '', 200);

        const names = room.players.map(p => p.name).join(', ');
        const prompt = `أنت مؤلف لعبة مافيا محترف باللهجة المصرية. اللاعبون هم: [${names}]. \nالجريمة: ${crimeType || "جريمة غامضة"}. تريكات: ${tricks || "لا يوجد"}.\nاكتب قصة جريمة مصرية مشوقة ووزع أسامي شخصيات وأسرار لكل لاعب.\nالرد JSON فقط بدون أي نص خارجه:\n{"story": "القصة هنا بالتفصيل", "assignments": [{"name": "الاسم الحقيقي", "charName": "اسم الشخصية", "secret": "السر الخاص بالشخصية"}]}`;

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
                catch(e2) { io.to(room.boss).emit('error', 'التنسيق باظ، دوس "ابدأ الجيم" تاني!'); room.started = false; return; } 
            } else { 
                io.to(room.boss).emit('error', 'الذكاء الاصطناعي ماردش بتنسيق صحيح، حاول تاني!'); room.started = false; return; 
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

    socket.on('requestPhysicalClue', (roomCode) => {
        if (!isValidCode(roomCode)) return;
        sendClue(roomCode);
    });

    socket.on('shareClue', (data) => {
        if (!data || !isValidCode(data.roomCode)) return;
        io.to(data.roomCode).emit('clueShared', data.clue);
    });

    socket.on('triggerPanic', async (roomCode) => {
        if (!isValidCode(roomCode)) return;
        const room = rooms[roomCode];
        io.to(roomCode).emit('panicAction');
        if (room?.scenario) {
            const prompt = `في لعبة مافيا مصرية، القصة: ${room.scenario.story}. \nاللاعبون الأحياء: ${room.players.filter(p=>p.alive).map(p=>p.charName).join(', ')}.\nاكتب حدثاً مفاجئاً (Plot Twist) يغير مجرى التحقيق.\nالرد JSON فقط: {"twist": "نص التويست هنا"}`;
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

    socket.on('shareTwist', (data) => {
        if (!data || !isValidCode(data.roomCode)) return;
        io.to(data.roomCode).emit('twistShared', data.twist);
    });

    socket.on('startVotingPhase', (roomCode) => {
        if (!isValidCode(roomCode)) return;
        const room = rooms[roomCode];
        if (!room) return;
        touchRoom(room);
        
        const VOTING_TIME = 30;
        
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
        
        room._votingTimer = setTimeout(() => {
            if(room && room.votes && Object.keys(room.votes).length > 0) {
                io.to(room.boss).emit('timerExpired', { phase: 'voting', autoExecute: true });
            }
        }, VOTING_TIME * 1000);
    });

    socket.on('castVote', (data) => {
        if (!data || !isValidCode(data.roomCode)) return;
        const room = rooms[data.roomCode];
        if (!room) return;
        touchRoom(room);
        room.votes[socket.id] = sanitize(data.votedForChar, 30);
        const counts = {};
        Object.values(room.votes).forEach(v => counts[v] = (counts[v] || 0) + 1);
        io.to(room.boss).emit('voteResultUpdate', { totalVotes: Object.keys(room.votes).length, details: counts });
    });
    
    socket.on('ghostMessage', ({ roomCode, message }) => {
        if (!isValidCode(roomCode)) return;
        const room = rooms[roomCode];
        if (!room) return;
        const sender = room.players.find(p => p.id === socket.id);
        if (!sender || sender.alive) return;
        const safeMsg = sanitize(message, 200);
        const deadPlayers = room.players.filter(p => !p.alive);
        deadPlayers.forEach(p => {
            io.to(p.id).emit('ghostMessage', {
                name: sender.charName || sender.name,
                message: safeMsg,
                time: new Date().toLocaleTimeString('ar-EG')
            });
        });
    });
    
    socket.on('requestSpectatorData', (roomCode) => {
        if (!isValidCode(roomCode)) return;
        const room = rooms[roomCode];
        if (!room) return;
        const player = room.players.find(p => p.id === socket.id);
        if (!player || player.alive) return;
        socket.emit('spectatorData', {
            allPlayers: room.players.map(p => ({
                name: p.name, charName: p.charName, role: p.role,
                secret: p.secret, alive: p.alive
            })),
            clues: room.clues || []
        });
    });
    
    socket.on('executePlayer', (roomCode) => {
        if (!isValidCode(roomCode)) return;
        const room = rooms[roomCode];
        if (!room) return;
        if (socket.id !== room.boss) return;
        touchRoom(room);
        
        const counts = {};
        Object.values(room.votes).forEach(v => counts[v] = (counts[v] || 0) + 1);
        const sorted = Object.entries(counts).sort((a, b) => b[1] - a[1]);
        if (!sorted.length) { io.to(room.boss).emit('error', 'مفيش تصويت لسه!'); return; }
        if (sorted.length > 1 && sorted[0][1] === sorted[1][1]) { io.to(room.boss).emit('error', 'في تعادل في التصويت!'); return; }

        const kickedChar = sorted[0][0];
        const p = room.players.find(pl => pl.charName === kickedChar);
        if (p) p.alive = false;
        const isMafia = p?.role.includes('🔪') || false;
        const win = checkWinCondition(room);

        let execMsg = '';
        if (isMafia) {
            const remainingMafia = win.aliveMafia.length;
            if (win.over && win.winner === 'civilians') execMsg = `🎉 انتصرت المدينة! "${kickedChar}" كان المافيوسو الأخير!`;
            else execMsg = `✅ أصبتم! "${kickedChar}" كان مافيوسو 🔪 — لا يزال ${remainingMafia} مافيا في الخفاء...`;
        } else {
            execMsg = `😢 "${kickedChar}" كان مواطناً بريئاً. المافيا لا تزال حرة!`;
        }

        io.to(roomCode).emit('executionResult', { charName: kickedChar, isMafia, message: execMsg, gameOver: win.over, winner: win.winner });

        if (win.over) {
            let finalMsg = win.winner === 'civilians' ? '🏆 المدينة انتصرت!' : '💀 المافيا كسبت!';
            setTimeout(() => { io.to(roomCode).emit('gameOver', finalMsg); if (rooms[roomCode]) rooms[roomCode].gameOver = true; }, 4000);
        } else {
            room.round++;
            room.votes = {};
            sendClue(roomCode);
        }
    });

    socket.on('closeRoom', (roomCode) => {
        if (!isValidCode(roomCode)) return;
        io.to(roomCode).emit('roomEnded');
        delete rooms[roomCode];
    });

    // WebRTC Signaling
    socket.on('joinVoice', (roomCode) => {
        if (!isValidCode(roomCode)) return;
        socket.join(`${roomCode}-voice`);
        socket.to(`${roomCode}-voice`).emit('user-joined-voice', socket.id);
    });
    socket.on('webrtc-offer', (data) => { if (data?.target) io.to(data.target).emit('webrtc-offer', { sender: socket.id, sdp: data.sdp }); });
    socket.on('webrtc-answer', (data) => { if (data?.target) io.to(data.target).emit('webrtc-answer', { sender: socket.id, sdp: data.sdp }); });
    socket.on('webrtc-ice-candidate', (data) => { if (data?.target) io.to(data.target).emit('webrtc-ice-candidate', { sender: socket.id, candidate: data.candidate }); });

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
        rateLimits.delete(socket.id);
        
        for (const roomCode in rooms) {
            const room = rooms[roomCode];
            if (room.boss === socket.id) {
                room.deleteTimer = setTimeout(() => {
                    if (rooms[roomCode]) { io.to(roomCode).emit('roomEnded'); delete rooms[roomCode]; }
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
//  Keep-alive
// ════════════════════════════════════════════════
setInterval(() => { console.log('💓 Keep-alive'); }, 10 * 60 * 1000);

// ════════════════════════════════════════════════
//  Start
// ════════════════════════════════════════════════
const PORT = process.env.PORT || 3000;

async function start() {
    await initRedis();
    server.listen(PORT, () => {
        console.log(`✅ Server on port ${PORT}`);
        console.log(`🤖 Gemini: ${GEMINI_KEYS.length} keys | Groq: ${GROQ_KEYS.length} keys`);
        console.log(`💾 Storage: ${useRedis ? 'Redis' : 'In-Memory'}`);
    });
}

start();
