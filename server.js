const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const { GoogleGenerativeAI } = require("@google/generative-ai");

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
    cors: { origin: "*", methods: ["GET", "POST"] },
    pingTimeout: 60000,
    pingInterval: 25000
});

async function getAIResponse(prompt) {
    try {
        if (process.env.GEMINI_KEY) {
            const genAI = new GoogleGenerativeAI(process.env.GEMINI_KEY);
            const model = genAI.getGenerativeModel({ model: "gemini-2.5-flash" });
            const result = await model.generateContent(prompt);
            return result.response.text().replace(/```json|```/g, "").trim();
        }
    } catch (e) { console.error("Gemini Error"); }

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
    } catch (e) { console.error("Groq Error"); }
    return null;
}

app.use(express.static('public'));
let rooms = {};

io.on('connection', (socket) => {
    
    // ─── إنشاء الغرفة ───
    socket.on('createRoom', () => {
        const roomCode = Math.random().toString(36).substring(2, 6).toUpperCase();
        rooms[roomCode] = { boss: socket.id, bossToken: socket.id, players: [], votes: {}, scenario: null, clues: [], round: 1, started: false };
        socket.join(roomCode);
        socket.emit('roomCreated', roomCode);
    });

    // ─── إعادة الاتصال (البوس) ───
    socket.on('bossReconnect', ({ roomCode, bossToken }) => {
        const room = rooms[roomCode];
        if (room && room.bossToken === bossToken) {
            room.boss = socket.id;
            socket.join(roomCode);
            socket.emit('bossReconnected', { players: room.players, started: room.started, scenario: room.scenario, clues: room.clues });
        }
    });

    // ─── الانضمام وإعادة الاتصال (اللاعبين) ───
    socket.on('joinRoom', (data) => {
        const room = rooms[data.roomCode];
        if (!room) return socket.emit('error', 'الغرفة غير موجودة');
        
        let existing = room.players.find(p => p.name === data.playerName);
        if (existing) {
            existing.id = socket.id;
            socket.join(data.roomCode);
            socket.emit('joinedSuccess', { reconnected: true });
        } else {
            if (room.started) return socket.emit('error', 'اللعبة بدأت بالفعل');
            room.players.push({ id: socket.id, name: data.playerName, role: 'مواطن', alive: true, charName: '', secret: '' });
            socket.join(data.roomCode);
            socket.emit('joinedSuccess', { reconnected: false });
        }
        io.to(room.boss).emit('updatePlayers', room.players);
    });

    // ─── بدء اللعبة ───
    socket.on('startGame', async (data) => {
        const room = rooms[data.roomCode];
        if (!room || room.players.length === 0) return;
        room.started = true;
        room.clues = [];

        const prompt = `أنت مؤلف لعبة مافيا. اللاعبون: [${room.players.map(p=>p.name).join(',')}]. الجريمة: ${data.crimeType}. تريكات: ${data.tricks}. 
        الرد JSON فقط: {"story": "...", "assignments": [{"name": "الاسم", "charName": "اسم الشخصية", "secret": "السر"}]}`;
        
        const res = await getAIResponse(prompt);
        if (!res) return;
        const scenario = JSON.parse(res);
        room.scenario = scenario;

        const mafiaCount = room.players.length >= 6 ? 2 : 1;
        const shuffled = [...room.players].sort(() => Math.random() - 0.5);
        room.players.forEach(p => p.role = 'مواطن');
        shuffled.slice(0, mafiaCount).forEach(p => p.role = 'مافيوسو 🔪');

        room.players.forEach(p => {
            const assign = scenario.assignments.find(a => a.name === p.name);
            p.charName = assign?.charName || "مجهول";
            p.secret = assign?.secret || "لا يوجد";
            
            // إرسال البيانات لكل لاعب، وإخفاء دوره من قائمة التصويت
            io.to(p.id).emit('gameData', {
                role: p.role, story: scenario.story, charName: p.charName, charSecret: p.secret,
                allCharNames: room.players.filter(pl => pl.alive && pl.name !== p.name).map(pl => pl.charName)
            });
        });

        io.to(room.boss).emit('bossData', { story: scenario.story, players: room.players });
        generateClue(data.roomCode, "دليل مبدئي"); // الدليل الأول أوتوماتيك
    });

    // ─── نظام الهنتات والأدلة ───
    async function generateClue(roomCode, context) {
        const room = rooms[roomCode];
        if (!room) return;
        const mafia = room.players.filter(p => p.role.includes('🔪')).map(p => p.charName).join(' و ');
        const prompt = `القصة: ${room.scenario.story}. المافيا: ${mafia}. أعطني ${context} غامض يلمح للقاتل دون كشفه مباشرة. جملة واحدة.`;
        const clue = await getAIResponse(prompt);
        if (clue) {
            room.clues.push({ text: clue, round: room.round });
            io.to(room.boss).emit('receiveClueBoss', room.clues);
        }
    }

    socket.on('requestPhysicalClue', (roomCode) => generateClue(roomCode, "تلميح في منتصف الجولة بناءً على الأحداث"));

    // ─── البانيك مود المطور (Panic Mode) ───
    socket.on('triggerPanic', async (roomCode) => {
        const room = rooms[roomCode];
        if (!room) return;
        io.to(roomCode).emit('panicAction'); // تشغيل الصوت والهزة للكل
        
        const prompt = `القصة: ${room.scenario.story}. اكتب حدث مفاجئ ومرعب (Plot Twist) يقطع النقاش ويغير مسار الشكوك. جملة واحدة فقط.`;
        const twist = await getAIResponse(prompt);
        if (twist) io.to(roomCode).emit('systemMessage', `🚨 حدث مفاجئ: ${twist}`);
    });

    // ─── التصويت المباشر (Live Voting) ───
    socket.on('castVote', (data) => {
        const room = rooms[data.roomCode];
        if (!room) return;
        room.votes[socket.id] = data.votedFor;
        const counts = {};
        Object.values(room.votes).forEach(v => counts[v] = (counts[v] || 0) + 1);
        io.to(room.boss).emit('voteUpdate', counts); // تحديث لايف للبوس
    });

    // ─── الإعدام والنهايات ───
    socket.on('executePlayer', (roomCode) => {
        const room = rooms[roomCode];
        if (!room) return;
        
        const counts = {};
        Object.values(room.votes).forEach(v => counts[v] = (counts[v] || 0) + 1);
        const sorted = Object.entries(counts).sort((a,b) => b[1]-a[1]);
        if (!sorted.length) return;

        const kickedChar = sorted[0][0];
        const p = room.players.find(pl => pl.charName === kickedChar);
        if(p) p.alive = false;

        const aliveMafia = room.players.filter(pl => pl.alive && pl.role.includes('🔪')).length;
        const aliveCitizens = room.players.filter(pl => pl.alive && !pl.role.includes('🔪')).length;

        // رسالة الإعدام
        if (p?.role.includes('🔪')) {
            io.to(roomCode).emit('executionResult', `🔥 انتصار جزئي: تم إعدام (${kickedChar}) وكان من المافيا! متبقي ${aliveMafia} مافيا.`);
        } else {
            io.to(roomCode).emit('executionResult', `💔 خسارة مؤلمة: تم إعدام (${kickedChar}) وكان مواطناً صالحاً! القاتل لا يزال حراً.`);
        }

        // فحص نهايات الجيم
        if (aliveMafia === 0) {
            io.to(roomCode).emit('gameOver', "🎉 المدينة انتصرت! تم القضاء على كل المافيا.");
            delete rooms[roomCode];
        } else if (aliveMafia >= aliveCitizens && aliveMafia > 1) {
            io.to(roomCode).emit('gameOver', "🔪 المافيا سيطرت على المدينة تماماً! فوز المافيا.");
            delete rooms[roomCode];
        } else if (aliveMafia === 1 && aliveCitizens === 1) {
            // حالة 1 ضد 1 (مواطنون ميتين فقط يصوتون)
            room.round++;
            room.votes = {};
            const finalTwo = room.players.filter(pl => pl.alive).map(pl => pl.charName);
            io.to(roomCode).emit('systemMessage', "⚡ وصلنا للمواجهة الأخيرة 1 ضد 1! القرار الآن في يد أشباح المواطنين الميتين.");
            
            room.players.forEach(pl => {
                if (!pl.alive && !pl.role.includes('🔪')) {
                    io.to(pl.id).emit('nextRound', finalTwo); // إرسال التصويت للمواطنين الميتين
                } else {
                    io.to(pl.id).emit('hideVoting', "أنت لا تملك حق التصويت الآن. مصيرك في يد أشباح المدينة!");
                }
            });
            generateClue(roomCode, "دليل نهائي وحاسم");
        } else {
            // جولة عادية جديدة
            room.round++;
            room.votes = {};
            const aliveChars = room.players.filter(pl => pl.alive).map(pl => pl.charName);
            room.players.forEach(pl => {
                if(pl.alive) io.to(pl.id).emit('nextRound', aliveChars.filter(c => c !== pl.charName));
            });
            generateClue(roomCode, `دليل للجولة ${room.round}`);
        }
    });

    socket.on('closeRoom', (roomCode) => {
        io.to(roomCode).emit('gameOver', "تم إنهاء اللعبة ومسح البيانات من قبل البوس.");
        delete rooms[roomCode];
    });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`🚀 Server Running on Port ${PORT}`));