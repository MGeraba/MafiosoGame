// ════════════════════════════════════════════════════════════════
//  MAFIA CLASSIC — Server Module
//  الملف ده يتضاف في server.js جوه io.on('connection', ...)
// ════════════════════════════════════════════════════════════════

// rooms للمافيا الكلاسيك منفصلة عن rooms الأصلية
// اضيف السطر ده قبل io.on('connection') في server.js:
// let mcRooms = {};

module.exports = function registerMafiaClassic(io, socket, mcRooms, getAIResponse) {

    // ── حساب عدد المافيا ─────────────────────────────────────────
    function getMafiaCount(playerCount) {
        if (playerCount >= 10) return 4;
        if (playerCount >= 8)  return 3;
        if (playerCount >= 5)  return 2;
        return 1;
    }

    // ── فحص الفوز ────────────────────────────────────────────────
    function checkWin(room) {
        const alive = room.players.filter(p => p.alive);
        const aliveMafia = alive.filter(p => p.role === 'mafia');
        const aliveCiv = alive.filter(p => p.role !== 'mafia');
        if (aliveMafia.length === 0) return { over: true, winner: 'civilians' };
        if (aliveMafia.length >= aliveCiv.length) return { over: true, winner: 'mafia' };
        return { over: false };
    }

    // ── إنشاء غرفة ───────────────────────────────────────────────
    socket.on('mcCreateRoom', () => {
        const code = Math.random().toString(36).substring(2, 6).toUpperCase();
        mcRooms[code] = {
            boss: socket.id,
            bossToken: socket.id,
            players: [],
            phase: 'lobby', // lobby | night_mafia | night_doctor | day
            round: 1,
            mafiaVotes: {},
            dayVotes: {},
            started: false,
            gameOver: false,
            nightTarget: null,
            doctorSave: null,
            firstRound: true
        };
        socket.join('mc_' + code);
        socket.emit('mcRoomCreated', code);
    });

    // ── Boss Reconnect ─────────────────────────────────────────────
    socket.on('mcBossReconnect', ({ roomCode, bossToken }) => {
        const room = mcRooms[roomCode];
        if (!room) { socket.emit('roomEnded'); return; }
        if (room.bossToken !== bossToken) { socket.emit('error', 'غير مصرح'); return; }
        if (room.deleteTimer) { clearTimeout(room.deleteTimer); room.deleteTimer = null; }
        room.boss = socket.id;
        socket.join('mc_' + roomCode);
        socket.emit('mcBossReconnected', {
            started: room.started,
            players: room.players,
            roomData: room.started ? {
                players: room.players,
                phase: room.phase
            } : null
        });
    });

    // ── انضمام لاعب ──────────────────────────────────────────────
    socket.on('mcJoinRoom', (data) => {
        const room = mcRooms[data.roomCode];
        if (!room) { socket.emit('roomEnded'); return; }
        if (room.started) { socket.emit('error', 'اللعبة بدأت!'); return; }
        const existing = room.players.find(p => p.name === data.playerName);
        if (existing) {
            existing.id = socket.id;
            socket.join('mc_' + data.roomCode);
            socket.emit('mcJoinedSuccess', { reconnected: true });
        } else {
            room.players.push({ id: socket.id, name: data.playerName, role: 'civilian', alive: true });
            socket.join('mc_' + data.roomCode);
            socket.emit('mcJoinedSuccess', { reconnected: false });
        }
        io.to(room.boss).emit('updatePlayersMC', room.players);
    });

    // ── Player Reconnect ──────────────────────────────────────────
    socket.on('mcPlayerReconnect', (data) => {
        const room = mcRooms[data.roomCode];
        if (!room) { socket.emit('roomEnded'); return; }
        const p = room.players.find(pl => pl.name === data.playerName);
        if (p) {
            p.id = socket.id;
            socket.join('mc_' + data.roomCode);
            if (room.started) {
                const gameData = buildPlayerData(p, room);
                socket.emit('mcGameData', gameData);
                socket.emit('mcPlayerReconnected', { gameData });
            } else {
                socket.emit('mcJoinedSuccess', { reconnected: true });
                io.to(room.boss).emit('updatePlayersMC', room.players);
            }
        }
    });

    function buildPlayerData(p, room) {
        const mafiaTeam = p.role === 'mafia'
            ? room.players.filter(pl => pl.role === 'mafia').map(pl => pl.name)
            : [];
        return {
            name: p.name,
            role: p.role,
            mafiaTeam,
            isAlive: p.alive
        };
    }

    // ── بدء اللعبة ────────────────────────────────────────────────
    socket.on('mcStartGame', async ({ roomCode }) => {
        const room = mcRooms[roomCode];
        if (!room || room.players.length < 4) { socket.emit('error', 'مطلوب 4 لاعبين على الأقل'); return; }

        room.started = true;
        room.phase = 'night_mafia';
        room.firstRound = true;

        // توزيع الأدوار عشوائياً
        const count = room.players.length;
        const mafiaCount = getMafiaCount(count);
        const shuffled = [...room.players].sort(() => Math.random() - 0.5);

        room.players.forEach(p => p.role = 'civilian');
        shuffled.slice(0, mafiaCount).forEach(p => p.role = 'mafia');
        // دكتور واحد دايماً
        const remaining = shuffled.slice(mafiaCount);
        if (remaining.length > 0) remaining[0].role = 'doctor';

        // إرسال البيانات للبوس
        io.to(room.boss).emit('mcBossData', { players: room.players });

        // إرسال البيانات للاعبين
        room.players.forEach(p => {
            const data = buildPlayerData(p, room);
            io.to(p.id).emit('mcGameData', data);
        });

        // بدء مرحلة الليل
        startNightPhase(roomCode);
    });

    // ── مرحلة الليل ──────────────────────────────────────────────
    function startNightPhase(roomCode) {
        const room = mcRooms[roomCode];
        if (!room) return;

        room.phase = 'night_mafia';
        room.mafiaVotes = {};
        room.nightTarget = null;
        room.doctorSave = null;

        const alivePlayers = room.players.filter(p => p.alive);
        const aliveMafia = alivePlayers.filter(p => p.role === 'mafia');
        const aliveNonMafia = alivePlayers.filter(p => p.role !== 'mafia');

        // المافيا تختار ضحية من المواطنين الأحياء
        aliveMafia.forEach(p => {
            io.to(p.id).emit('mcNightAction', {
                type: 'mafia_kill',
                canAct: true,
                targets: aliveNonMafia.map(pl => pl.name)
            });
        });

        // المواطنون لا يفعلون شيئاً
        aliveNonMafia.filter(p => p.role !== 'doctor').forEach(p => {
            io.to(p.id).emit('mcNightAction', { canAct: false });
        });

        // الدكتور لا يفعل شيئاً في هذه المرحلة بعد
        const doctor = aliveNonMafia.find(p => p.role === 'doctor');
        if (doctor) io.to(doctor.id).emit('mcNightAction', { canAct: false });
    }

    // ── تصويت المافيا ────────────────────────────────────────────
    socket.on('mcNightVote', ({ roomCode, target, type }) => {
        const room = mcRooms[roomCode];
        if (!room || room.phase !== 'night_mafia') return;
        if (type !== 'mafia_kill') return;

        const voter = room.players.find(p => p.id === socket.id);
        if (!voter || voter.role !== 'mafia' || !voter.alive) return;

        room.mafiaVotes[socket.id] = target;

        // حساب الأصوات
        const counts = {};
        Object.values(room.mafiaVotes).forEach(v => counts[v] = (counts[v] || 0) + 1);
        const sortedVotes = Object.entries(counts).sort((a, b) => b[1] - a[1]);
        const topTarget = sortedVotes[0]?.[0];
        const topCount = sortedVotes[0]?.[1] || 0;

        const aliveMafia = room.players.filter(p => p.alive && p.role === 'mafia');
        const allVoted = Object.keys(room.mafiaVotes).length >= aliveMafia.length;

        io.to(room.boss).emit('mcMafiaChose', {
            target: topTarget,
            votes: topCount,
            mafiaCount: aliveMafia.length,
            allVoted
        });

        if (allVoted) {
            room.nightTarget = topTarget;
            room.phase = 'night_doctor';
            startDoctorPhase(roomCode);
        }
    });

    // ── مرحلة الدكتور ────────────────────────────────────────────
    function startDoctorPhase(roomCode) {
        const room = mcRooms[roomCode];
        if (!room) return;

        const doctor = room.players.find(p => p.role === 'doctor' && p.alive);
        const alivePlayers = room.players.filter(p => p.alive);

        if (!doctor) return; // لو الدكتور مات

        let doctorTargets;
        if (room.firstRound) {
            // الجولة الأولى: الدكتور يعرف اسم المختار فقط
            doctorTargets = [room.nightTarget];
        } else {
            // الجولات التالية: الدكتور يختار من الكل (بما فيهم نفسه والمافيا)
            doctorTargets = alivePlayers.map(p => p.name);
        }

        io.to(doctor.id).emit('mcNightAction', {
            type: 'doctor_save',
            canAct: true,
            targets: doctorTargets
        });
    }

    // ── قرار الدكتور ─────────────────────────────────────────────
    socket.on('mcNightVote', ({ roomCode, target, type }) => {
        const room = mcRooms[roomCode];
        if (!room || type !== 'doctor_save') return;

        const voter = room.players.find(p => p.id === socket.id);
        if (!voter || voter.role !== 'doctor' || !voter.alive) return;

        room.doctorSave = target;
        io.to(room.boss).emit('mcDoctorChose', { target });
    });

    // ── كشف نتيجة الليل (البوس) ──────────────────────────────────
    socket.on('mcRevealNight', (roomCode) => {
        const room = mcRooms[roomCode];
        if (!room) return;

        const target = room.nightTarget;
        const saved = room.doctorSave === target;
        let killed = false;
        let killedPlayer = null;

        if (!saved && target) {
            const p = room.players.find(pl => pl.name === target);
            if (p && p.alive) {
                p.alive = false;
                killed = true;
                killedPlayer = p;
            }
        }

        room.firstRound = false;

        const win = checkWin(room);
        io.to(room.boss).emit('mcNightResult', {
            saved,
            killed,
            targetName: target,
            players: room.players
        });

        // إعلان عام للاعبين بنتيجة الليل
        if (killed) {
            io.to('mc_' + roomCode).emit('mcRoundAnnounce', {
                message: `🌅 الصباح — وُجد ${target} ميتاً! الجميع يجتمع للنقاش...`
            });
        } else {
            io.to('mc_' + roomCode).emit('mcRoundAnnounce', {
                message: `🌅 الصباح — ليلة هادئة! لا أحد مات. ابدأوا النقاش...`
            });
        }

        if (win.over) {
            endGame(roomCode, win.winner);
        }
    });

    // ── بدء التصويت النهاري ──────────────────────────────────────
    socket.on('mcStartVoting', (roomCode) => {
        const room = mcRooms[roomCode];
        if (!room) return;
        room.phase = 'day';
        room.dayVotes = {};

        const alivePlayers = room.players.filter(p => p.alive);

        alivePlayers.forEach(p => {
            const targets = alivePlayers.filter(o => o.name !== p.name).map(o => o.name);
            io.to(p.id).emit('mcStartDayVoting', { canVote: true, targets });
        });
        room.players.filter(p => !p.alive).forEach(p => {
            io.to(p.id).emit('mcStartDayVoting', { canVote: false, targets: [] });
        });

        io.to(room.boss).emit('votingStarted');
    });

    // ── التصويت النهاري ──────────────────────────────────────────
    socket.on('mcCastVote', ({ roomCode, target }) => {
        const room = mcRooms[roomCode];
        if (!room || room.phase !== 'day') return;
        const voter = room.players.find(p => p.id === socket.id);
        if (!voter || !voter.alive) return;
        room.dayVotes[socket.id] = target;
        const counts = {};
        Object.values(room.dayVotes).forEach(v => counts[v] = (counts[v] || 0) + 1);
        io.to(room.boss).emit('mcVoteUpdate', {
            totalVotes: Object.keys(room.dayVotes).length,
            details: counts
        });
    });

    // ── تنفيذ الإعدام ─────────────────────────────────────────────
    socket.on('mcExecute', (roomCode) => {
        const room = mcRooms[roomCode];
        if (!room) return;
        const counts = {};
        Object.values(room.dayVotes).forEach(v => counts[v] = (counts[v] || 0) + 1);
        const sorted = Object.entries(counts).sort((a, b) => b[1] - a[1]);
        if (!sorted.length) { io.to(room.boss).emit('error', 'مفيش تصويت!'); return; }
        if (sorted.length > 1 && sorted[0][1] === sorted[1][1]) {
            io.to(room.boss).emit('error', 'في تعادل! ناقشوا وصوّتوا تاني.'); return;
        }

        const kickedName = sorted[0][0];
        const p = room.players.find(pl => pl.name === kickedName);
        if (p) p.alive = false;

        const isMafia = p?.role === 'mafia';
        const aliveMafia = room.players.filter(pl => pl.alive && pl.role === 'mafia').length;
        const win = checkWin(room);

        io.to(room.boss).emit('mcExecutionResult', {
            charName: kickedName,
            isMafia,
            remaining: aliveMafia,
            players: room.players,
            gameOver: win.over
        });

        // إعلان للاعبين
        const roleAnnounce = isMafia ? '🔪 كان مافيا!' : p?.role === 'doctor' ? '💉 كان الدكتور!' : '👤 كان مواطناً بريئاً!';
        io.to('mc_' + roomCode).emit('mcRoundAnnounce', {
            message: `⚖️ ${kickedName} نُفّذ فيه الإعدام — ${roleAnnounce}`
        });

        if (win.over) {
            endGame(roomCode, win.winner);
        } else {
            room.round++;
            room.dayVotes = {};
            // بدء ليلة جديدة بعد شوية
            setTimeout(() => startNightPhase(roomCode), 3000);
        }
    });

    // ── إنهاء اللعبة ─────────────────────────────────────────────
    function endGame(roomCode, winner) {
        const room = mcRooms[roomCode];
        if (!room) return;
        room.gameOver = true;
        const msg = winner === 'civilians'
            ? '🏆 المدينة انتصرت! تم القضاء على المافيا كلها!'
            : '💀 المافيا كسبت! استولوا على المدينة!';

        const spies = room.players.filter(p => p.role === 'mafia').map(p => p.name);
        const doctor = room.players.find(p => p.role === 'doctor')?.name;

        setTimeout(() => {
            io.to('mc_' + roomCode).emit('mcGameOver', {
                winner,
                message: msg + (doctor ? `\n💉 الدكتور كان: ${doctor}` : '') + `\n🔪 المافيا كانوا: ${spies.join(', ')}`,
                icon: winner === 'civilians' ? '🏆' : '💀'
            });
            if (mcRooms[roomCode]) mcRooms[roomCode].gameOver = true;
        }, 3000);
    }

    // ── إغلاق الغرفة ─────────────────────────────────────────────
    socket.on('mcCloseRoom', (roomCode) => {
        io.to('mc_' + roomCode).emit('roomEnded');
        delete mcRooms[roomCode];
    });

    // ── Disconnect ────────────────────────────────────────────────
    // يتعالج في server.js الأصلي مع الـ disconnect handler
};
