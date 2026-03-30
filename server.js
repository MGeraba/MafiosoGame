const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const { GoogleGenerativeAI } = require("@google/generative-ai");

const app = express();
const server = http.createServer(app);

// التعديل السحري هنا: بنفتح الباب لأي حد يدخل (CORS)
const io = new Server(server, {
    cors: {
        origin: "*", 
        methods: ["GET", "POST"]
    }
});

const GEMINI_KEY = process.env.GEMINI_KEY; // بياخد المفتاح من إعدادات Render اللي عملناها
const genAI = new GoogleGenerativeAI(GEMINI_KEY);

app.use(express.static('public'));
const rooms = {};

// دالة توليد القصة (تأكد إنها gemini-2.0-flash-exp)
async function getInitialScenario(players, crimeType, tricks) {
    try {
        const model = genAI.getGenerativeModel({ model: "gemini-2.5-flash" });
        const names = players.map(p => p.name).join(', ');
        const prompt = `أنت مؤلف لعبة مافيا محترف. اللاعبون هم: [${names}]. 
        نوع الجريمة: ${crimeType || "غموض"}. تريكات: ${tricks || "لا يوجد"}.
        اكتب قصة جريمة ساخرة مصرية قصيرة جداً ووزع أسامي شخصيات وأسرار.
        الرد JSON فقط: {"story": "...", "assignments": [{"name": "الاسم الحقيقي", "charName": "الشخصية", "secret": "السر"}]}`;
        const result = await model.generateContent(prompt);
        let text = result.response.text().replace(/```json|```/g, "").trim();
        return JSON.parse(text);
    } catch (e) {
        console.error("AI Error:", e);
        return { story: "خناقة في الحارة!", assignments: players.map((p, i) => ({ name: p.name, charName: "مشتبه به " + (i+1), secret: "مخبي حاجة" })) };
    }
}

io.on('connection', (socket) => {
    console.log('لاعب جديد اتصل:', socket.id);

    socket.on('createRoom', () => {
        const roomCode = Math.random().toString(36).substring(2, 6).toUpperCase();
        rooms[roomCode] = { boss: socket.id, players: [], votes: {}, scenario: null, round: 1 };
        socket.join(roomCode);
        socket.emit('roomCreated', roomCode);
        console.log('تم إنشاء غرفة:', roomCode);
    });

    socket.on('joinRoom', (data) => {
        const room = rooms[data.roomCode];
        if (room) {
            // إضافة اللاعب للغرفة
            room.players.push({ id: socket.id, name: data.playerName, role: 'مواطن', alive: true });
            socket.join(data.roomCode);
            socket.emit('joinedSuccess');
            // تحديث قائمة اللاعبين عند البوس فوراً
            io.to(room.boss).emit('updatePlayers', room.players);
            console.log(`${data.playerName} دخل الغرفة ${data.roomCode}`);
        } else {
            socket.emit('error', 'الغرفة مش موجودة يا صاحبي!');
        }
    });

    socket.on('startGame', async (data) => {
        const room = rooms[data.roomCode];
        if (room && room.players.length > 0) {
            const scenario = await getInitialScenario(room.players, data.crimeType, data.tricks);
            room.scenario = scenario;
            
            const mafiaCount = room.players.length > 4 ? 2 : 1;
            const shuffled = [...room.players].sort(() => Math.random() - 0.5);
            shuffled.slice(0, mafiaCount).forEach(p => p.role = 'مافيوسو 🔪');
            
            room.players.forEach(p => {
                const det = scenario.assignments.find(a => a.name === p.name);
                p.charName = det ? det.charName : "مجهول";
                p.secret = det ? det.secret : "لا يوجد";
                io.to(p.id).emit('gameData', { 
                    role: p.role, 
                    story: scenario.story, 
                    charName: p.charName, 
                    charSecret: p.secret, 
                    allCharNames: room.players.map(pl => pl.charName) 
                });
            });
            io.to(room.boss).emit('bossData', { story: scenario.story, players: room.players });
        }
    });

    // باقي الأكواد (Timer, Clue, Panic) ضيفها هنا بنفس الطريقة اللي فاتت...
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`🚀 السيرفر شغال لايف على بورت ${PORT}`));