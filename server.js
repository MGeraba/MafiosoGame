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

// ── Multi-AI Setup (Gemini 2.5 Flash + Groq Fallback) ──
async function getAIResponse(prompt) {
    // 1. محاولة استخدام Gemini 2.5 Flash
    try {
        if (process.env.GEMINI_KEY) {
            const genAI = new GoogleGenerativeAI(process.env.GEMINI_KEY);
            const model = genAI.getGenerativeModel({ model: "gemini-2.5-flash" });
            const result = await model.generateContent(prompt);
            return result.response.text().replace(/```json|```/g, "").trim();
        }
    } catch (e) { console.error("Gemini Error, switching to Groq..."); }

    // 2. Fallback: محاولة استخدام Groq (Llama 3.3)
    try {
        if (process.env.GROQ_KEY) {
            const res = await fetch("https://api.groq.com/openai/v1/chat/completions", {
                method: "POST",
                headers: {
                    "Authorization": `Bearer ${process.env.GROQ_KEY}`,
                    "Content-Type": "application/json"
                },
                body: JSON.stringify({
                    model: "llama-3.3-70b-versatile",
                    messages: [{ role: "user", content: prompt }],
                    temperature: 0.8
                })
            });
            const data = await res.json();
            return data.choices[0].message.content.replace(/```json|```/g, "").trim();
        }
    } catch (e) { console.error("Both AIs failed!"); }
    return null;
}

app.use(express.static('public'));
let rooms = {};

io.on('connection', (socket) => {
    socket.on('createRoom', () => {
        const roomCode = Math.random().toString(36).substring(2, 6).toUpperCase();
        rooms[roomCode] = { boss: socket.id, players: [], votes: {}, scenario: null, round: 1, started: false };
        socket.join(roomCode);
        socket.emit('roomCreated', roomCode);
    });

    socket.on('joinRoom', (data) => {
        const room = rooms[data.roomCode];
        if (room) {
            const existing = room.players.find(p => p.name === data.playerName);
            if (!existing) {
                room.players.push({ id: socket.id, name: data.playerName, role: 'مواطن', alive: true, charName: '', secret: '' });
            } else { existing.id = socket.id; }
            
            socket.join(data.roomCode);
            socket.emit('joinedSuccess');
            io.to(room.boss).emit('updatePlayers', room.players);
        }
    });

    socket.on('startGame', async (data) => {
        const room = rooms[data.roomCode];
        if (!room) return;
        room.started = true;

        const prompt = `أنت مؤلف لعبة مافيا محترف. اللاعبون هم: [${room.players.map(p=>p.name).join(',')}]. 
        الجريمة: ${data.crimeType || "غموض"}. تريكات: ${data.tricks || "لا يوجد"}.
        اكتب قصة جريمة مصرية مشوقة ووزع أسامي شخصيات وأسرار.
        الرد JSON فقط: {"story": "...", "assignments": [{"name": "الاسم الحقيقي", "charName": "اسم الشخصية", "secret": "السر"}]}`;

        const response = await getAIResponse(prompt);
        if (!response) return;
        const scenario = JSON.parse(response);
        room.scenario = scenario;

        // توزيع الأدوار
        const mafiaCount = room.players.length > 4 ? 2 : 1;
        const shuffled = [...room.players].sort(() => Math.random() - 0.5);
        shuffled.forEach(p => p.role = 'مواطن');
        shuffled.slice(0, mafiaCount).forEach(p => p.role = 'مافيوسو 🔪');

        room.players.forEach(p => {
            const assign = scenario.assignments.find(a => a.name === p.name);
            p.charName = assign?.charName || "مجهول";
            p.secret = assign?.secret || "لا يوجد";
            io.to(p.id).emit('gameData', { 
                role: p.role, story: scenario.story, charName: p.charName, 
                charSecret: p.secret, allCharNames: room.players.map(pl => pl.charName) 
            });
        });

        io.to(room.boss).emit('bossData', { story: scenario.story, players: room.players });
    });

    socket.on('closeRoom', (roomCode) => {
        io.to(roomCode).emit('forceReset', "تم إغلاق الغرفة من قبل البوس. نتقابل في جيم جديد! 👋");
        delete rooms[roomCode];
    });

    // ... باقي الـ events (التصويت، الإعدام، Panic) تفضل زي ما هي ...
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`🚀 AI Server 2.5 Running`));