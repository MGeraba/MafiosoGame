// classicMafia.js

function checkClassicWin(room) {
    const alivePlayers = room.players.filter(p => p.alive);
    const aliveMafia = alivePlayers.filter(p => p.role === 'مافيا 🔪');
    const aliveCivilians = alivePlayers.filter(p => p.role !== 'مافيا 🔪');

    if (aliveCivilians.length === 0) return { over: true, winner: 'mafia' };
    if (aliveMafia.length === 0) return { over: true, winner: 'civilians' };
    return { over: false };
}

module.exports = {
    startGame: (io, room, roomCode) => {
        room.mode = 'classic';
        room.round = 1;
        room.nightAction = { mafiaVotes: {}, doctorSave: null, mafiaTarget: null };

        let pCount = room.players.length;
        let mafiaCount = 1;
        if (pCount >= 10) mafiaCount = 4;
        else if (pCount >= 8) mafiaCount = 3;
        else if (pCount >= 5) mafiaCount = 2;

        // توزيع الأدوار (مافيا - دكتور - مواطنين)
        let roles = Array(pCount).fill('مواطن 👤');
        for (let i = 0; i < mafiaCount; i++) roles[i] = 'مافيا 🔪';
        if (pCount >= 3) roles[mafiaCount] = 'دكتور 💉'; // نضيف دكتور لو العدد يسمح

        // خلط عشوائي للأدوار
        roles = roles.sort(() => Math.random() - 0.5);

        room.players.forEach((p, i) => {
            p.role = roles[i];
            p.charName = p.name; // في الكلاسيك، الاسم الحقيقي هو اسم الشخصية
            p.secret = p.role === 'مواطن 👤' ? "أنت مواطن شريف، ساعد المدينة." : 
                       p.role === 'دكتور 💉' ? "أنت الطبيب، مهمتك إنقاذ الأرواح ليلاً." : 
                       "أنت من المافيا، تخلص من المواطنين.";
        });

        const mafiaPlayers = room.players.filter(p => p.role === 'مافيا 🔪').map(p => p.name);

        // إرسال البيانات للاعبين
        room.players.forEach(p => {
            let colleagues = [];
            if (p.role === 'مافيا 🔪') colleagues = mafiaPlayers.filter(m => m !== p.name);

            io.to(p.id).emit('classicGameData', {
                role: p.role,
                charName: p.name,
                charSecret: p.secret,
                mafiaColleagues: colleagues, // المافيا يشوفوا زمايلهم
                isAlive: true
            });
        });

        // إرسال للبوس
        io.to(room.boss).emit('bossDataClassic', { players: room.players });

        // بدء أول ليل فوراً
        module.exports.startNightPhase(io, room, roomCode);
    },

    startNightPhase: (io, room, roomCode) => {
        room.nightAction = { mafiaVotes: {}, doctorSave: null, mafiaTarget: null };
        io.to(room.boss).emit('classicNightStarted');
        
        const alivePlayers = room.players.filter(p => p.alive);
        const aliveMafia = alivePlayers.filter(p => p.role === 'مافيا 🔪');
        const aliveTargets = alivePlayers.map(p => p.name);

        // إرسال طلب قتل للمافيا
        aliveMafia.forEach(m => {
            io.to(m.id).emit('mafiaNightAction', { targets: aliveTargets.filter(t => t !== m.name) });
        });
    },

    handleMafiaVote: (io, room, roomCode, playerId, targetName) => {
        const aliveMafia = room.players.filter(p => p.alive && p.role === 'مافيا 🔪');
        room.nightAction.mafiaVotes[playerId] = targetName;

        // لو كل المافيا الأحياء صوتوا
        if (Object.keys(room.nightAction.mafiaVotes).length === aliveMafia.length) {
            // حساب التصويت
            const counts = {};
            Object.values(room.nightAction.mafiaVotes).forEach(v => counts[v] = (counts[v] || 0) + 1);
            const sorted = Object.entries(counts).sort((a, b) => b[1] - a[1]);
            room.nightAction.mafiaTarget = sorted[0][0]; // اللي خد أعلى أصوات من المافيا

            // إرسال الدور للدكتور
            const doctor = room.players.find(p => p.alive && p.role === 'دكتور 💉');
            if (doctor) {
                const aliveTargets = room.players.filter(p => p.alive).map(p => p.name);
                if (room.round === 1) {
                    // الجولة الأولى: الدكتور يشوف الهدف مباشرة
                    io.to(doctor.id).emit('doctorNightAction', { isRoundOne: true, target: room.nightAction.mafiaTarget });
                } else {
                    // الجولات التانية: الدكتور يخمن
                    io.to(doctor.id).emit('doctorNightAction', { isRoundOne: false, targets: aliveTargets });
                }
            } else {
                // لو الدكتور ميت، نصحى الصبح فوراً
                module.exports.startDayPhase(io, room, roomCode);
            }
        }
    },

    handleDoctorSave: (io, room, roomCode, targetName) => {
        room.nightAction.doctorSave = targetName;
        module.exports.startDayPhase(io, room, roomCode);
    },

    startDayPhase: (io, room, roomCode) => {
        const target = room.nightAction.mafiaTarget;
        const saved = room.nightAction.doctorSave;
        
        let msg = '';
        if (target === saved) {
            msg = `🌅 أشرقت الشمس! الليلة الماضية حاولت المافيا قتل أحدهم، لكن الطبيب تدخل وأنقذ حياته!`;
        } else {
            const victim = room.players.find(p => p.name === target);
            if (victim) {
                victim.alive = false;
                msg = `🌅 أشرقت الشمس بخبر حزين... تم العثور على "${target}" مقتولاً!`;
            }
        }

        io.to(roomCode).emit('classicMorningNews', msg);
        
        // التحقق من الفوز بعد جرائم الليل
        const win = checkClassicWin(room);
        if (win.over) {
            setTimeout(() => {
                let finalMsg = win.winner === 'civilians' ? `🏆 المدينة انتصرت! تم القضاء على المافيا!` : `💀 المافيا كسبت! استولوا على المدينة!`;
                io.to(roomCode).emit('gameOver', finalMsg);
            }, 3000);
        } else {
            io.to(room.boss).emit('classicEnableVoting'); // تفعيل زر تصويت النهار للبوس
        }
    }
};