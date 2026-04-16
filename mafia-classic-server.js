// ════════════════════════════════════════════════════════════════
//  MAFIA CLASSIC — Server Module (v3 - Timers + Security)
// ════════════════════════════════════════════════════════════════

module.exports = function registerMafiaClassic(io, socket, mcRooms) {

    function getMafiaCount(n) {
        if (n >= 10) return 4;
        if (n >= 8)  return 3;
        if (n >= 5)  return 2;
        return 1;
    }

    function checkWin(room) {
        const alive = room.players.filter(p => p.alive && p.role !== 'spectator');
        const aliveMafia = alive.filter(p => p.role === 'mafia');
        const aliveCiv   = alive.filter(p => p.role !== 'mafia');
        if (aliveMafia.length === 0) return { over: true, winner: 'civilians' };
        if (aliveMafia.length >= aliveCiv.length) return { over: true, winner: 'mafia' };
        return { over: false };
    }

    function buildPlayerData(p, room) {
        const mafiaTeam = p.role === 'mafia'
            ? room.players.filter(pl => pl.role === 'mafia').map(pl => pl.name)
            : [];
        return { name: p.name, role: p.role, mafiaTeam, isAlive: p.alive };
    }

    function sanitize(str, maxLen = 50) {
        if (typeof str !== 'string') return '';
        return str.trim().substring(0, maxLen).replace(/[<>]/g, '');
    }

    function touchRoom(room) { room._lastActivity = Date.now(); }

    function broadcastLobbyList() {
        const list = Object.entries(mcRooms)
            .filter(([, r]) => !r.isPrivate)
            .map(([code, r]) => ({
                code,
                players: r.players.filter(p => p.role !== 'spectator').length,
                started: r.started
            }));
        io.emit('mcLobbyList', list);
    }

    // ── Phase Timers ──────────────────────────────────────────────
    const PHASE_TIMERS = {
        night_mafia: 20,
        night_doctor: 10,
        discussion: 60,
        voting: 20
    };

    function startPhaseTimer(roomCode, phase, onTimeout) {
        const room = mcRooms[roomCode];
        if (!room) return;

        // Clear previous timer
        if (room._phaseTimer) clearTimeout(room._phaseTimer);

        const seconds = PHASE_TIMERS[phase] || 30;
        
        // Broadcast timer to all players
        io.to('mc_' + roomCode).emit('mcPhaseTimer', {
            seconds,
            phase,
            label: phase === 'night_mafia' ? '🌙 ليلة المافيا'
                 : phase === 'night_doctor' ? '💉 دور الدكتور'
                 : phase === 'discussion' ? '☀️ النقاش'
                 : '🗳️ التصويت'
        });

        room._phaseTimer = setTimeout(() => {
            if (mcRooms[roomCode] && onTimeout) {
                onTimeout();
            }
        }, seconds * 1000);
    }

    // ── إنشاء غرفة ───────────────────────────────────────────────
    socket.on('mcCreateRoom', (opts = {}) => {
        const code = Math.random().toString(36).substring(2, 6).toUpperCase();
        mcRooms[code] = {
            boss: socket.id,
            bossToken: socket.id,
            players: [],
            phase: 'lobby',
            round: 1,
            mafiaVotes: {},
            dayVotes: {},
            started: false,
            gameOver: false,
            nightTarget: null,
            doctorSave: null,
            doctorVoted: false,
            firstRound: true,
            isPrivate: !!opts.isPrivate,
            pendingJoins: {},
            _lastActivity: Date.now()
        };
        socket.join('mc_' + code);
        socket.emit('mcRoomCreated', code);
        broadcastLobbyList();
    });

    // ── Boss Reconnect ────────────────────────────────────────────
    socket.on('mcBossReconnect', ({ roomCode, bossToken }) => {
        const room = mcRooms[roomCode];
        if (!room) { socket.emit('roomEnded'); return; }
        if (room.bossToken !== bossToken) { socket.emit('error', 'غير مصرح'); return; }
        if (room.deleteTimer) { clearTimeout(room.deleteTimer); room.deleteTimer = null; }
        room.boss = socket.id;
        touchRoom(room);
        socket.join('mc_' + roomCode);
        socket.emit('mcBossReconnected', {
            started: room.started,
            players: room.players,
            roomData: room.started ? { players: room.players, phase: room.phase } : null
        });
    });

    // ── انضمام لاعب ──────────────────────────────────────────────
    socket.on('mcJoinRoom', (data) => {
        const room = mcRooms[data.roomCode];
        if (!room) { socket.emit('roomEnded'); return; }
        touchRoom(room);

        const playerName = sanitize(data.playerName, 20);
        if (!playerName) { socket.emit('error', 'اسم غير صالح'); return; }

        const existing = room.players.find(p => p.name === playerName);

        if (room.started && !existing) {
            room.pendingJoins[socket.id] = { id: socket.id, name: playerName };
            io.to(room.boss).emit('mcJoinRequest', { id: socket.id, name: playerName });
            socket.emit('mcWaitingApproval');
            return;
        }

        if (existing) {
            existing.id = socket.id;
            socket.join('mc_' + data.roomCode);
            socket.emit('mcJoinedSuccess', { reconnected: true });
            if (room.started) socket.emit('mcGameData', buildPlayerData(existing, room));
        } else {
            if (room.players.length >= 20) { socket.emit('error', 'الغرفة ممتلئة!'); return; }
            room.players.push({ id: socket.id, name: playerName, role: 'civilian', alive: true });
            socket.join('mc_' + data.roomCode);
            socket.emit('mcJoinedSuccess', { reconnected: false });
        }
        io.to(room.boss).emit('updatePlayersMC', room.players);
        broadcastLobbyList();
    });

    socket.on('mcApproveJoin', ({ roomCode, playerId, approve }) => {
        const room = mcRooms[roomCode];
        if (!room || room.boss !== socket.id) return;
        const pending = room.pendingJoins[playerId];
        if (!pending) return;
        delete room.pendingJoins[playerId];
        if (approve) {
            room.players.push({ id: playerId, name: pending.name, role: 'spectator', alive: false });
            const s = io.sockets.sockets.get(playerId);
            if (s) {
                s.join('mc_' + roomCode);
                s.emit('mcJoinedSuccess', { reconnected: false, spectator: true });
                s.emit('mcGameData', { name: pending.name, role: 'spectator', mafiaTeam: [], isAlive: false });
            }
            io.to(room.boss).emit('updatePlayersMC', room.players);
            io.to('mc_' + roomCode).emit('mcChatMessage', { from: '🔔 النظام', message: `${pending.name} انضم كمشاهد`, time: '' });
        } else {
            io.to(playerId).emit('error', 'البوس رفض طلب انضمامك');
        }
    });

    socket.on('mcPlayerReconnect', (data) => {
        const room = mcRooms[data.roomCode];
        if (!room) { socket.emit('roomEnded'); return; }
        touchRoom(room);
        const p = room.players.find(pl => pl.name === data.playerName);
        if (p) {
            p.id = socket.id;
            socket.join('mc_' + data.roomCode);
            if (room.started) {
                socket.emit('mcGameData', buildPlayerData(p, room));
                socket.emit('mcPlayerReconnected', { gameData: buildPlayerData(p, room) });
            } else {
                socket.emit('mcJoinedSuccess', { reconnected: true });
                io.to(room.boss).emit('updatePlayersMC', room.players);
            }
        }
    });

    socket.on('mcLeaveRoom', ({ roomCode }) => {
        const room = mcRooms[roomCode];
        if (!room) return;
        room.players = room.players.filter(p => p.id !== socket.id);
        socket.leave('mc_' + roomCode);
        socket.emit('mcLeftRoom');
        io.to(room.boss).emit('updatePlayersMC', room.players);
        broadcastLobbyList();
    });

    // ── بدء / إعادة اللعبة ───────────────────────────────────────
    socket.on('mcStartGame', ({ roomCode }) => {
        const room = mcRooms[roomCode];
        if (!room || room.boss !== socket.id) return;
        const realPlayers = room.players.filter(p => p.role !== 'spectator');
        if (realPlayers.length < 4) { socket.emit('error', 'مطلوب 4 لاعبين على الأقل'); return; }
        touchRoom(room);

        room.started   = true;
        room.gameOver  = false;
        room.phase     = 'night_mafia';
        room.firstRound = true;
        room.round     = 1;
        room.mafiaVotes = {};
        room.dayVotes   = {};
        room.nightTarget = null;
        room.doctorSave  = null;
        room.doctorVoted = false;

        const mafiaCount = getMafiaCount(realPlayers.length);
        const shuffled   = [...realPlayers].sort(() => Math.random() - 0.5);
        realPlayers.forEach(p => { p.role = 'civilian'; p.alive = true; });
        shuffled.slice(0, mafiaCount).forEach(p => p.role = 'mafia');
        const nonMafia = shuffled.slice(mafiaCount);
        if (nonMafia.length > 0) nonMafia[0].role = 'doctor';

        io.to(room.boss).emit('mcBossData', { players: room.players });
        room.players.forEach(p => io.to(p.id).emit('mcGameData', buildPlayerData(p, room)));

        startNightPhase(roomCode);
        broadcastLobbyList();
    });

    socket.on('mcRestartGame', ({ roomCode }) => {
        const room = mcRooms[roomCode];
        if (!room || room.boss !== socket.id) return;
        if (room._phaseTimer) clearTimeout(room._phaseTimer);
        room.started  = false;
        room.gameOver = false;
        room.players.forEach(p => { p.role = p.role === 'spectator' ? 'spectator' : 'civilian'; p.alive = true; });
        io.to('mc_' + roomCode).emit('mcBackToLobby', { players: room.players });
        io.to(room.boss).emit('updatePlayersMC', room.players);
        broadcastLobbyList();
    });

    // ── مرحلة الليل ──────────────────────────────────────────────
    function startNightPhase(roomCode) {
        const room = mcRooms[roomCode];
        if (!room) return;

        room.phase = 'night_mafia';
        room.mafiaVotes  = {};
        room.nightTarget = null;
        room.doctorSave  = null;
        room.doctorVoted = false;

        const alive = room.players.filter(p => p.alive && p.role !== 'spectator');
        const aliveMafia  = alive.filter(p => p.role === 'mafia');
        const aliveOthers = alive.filter(p => p.role !== 'mafia');

        aliveMafia.forEach(p => {
            io.to(p.id).emit('mcNightAction', {
                type: 'mafia_kill', canAct: true,
                targets: aliveOthers.map(pl => pl.name)
            });
        });

        aliveOthers.forEach(p => io.to(p.id).emit('mcNightAction', { canAct: false, phase: 'night_mafia' }));
        room.players.filter(p => !p.alive || p.role === 'spectator').forEach(p => {
            io.to(p.id).emit('mcNightAction', { canAct: false, phase: 'night_mafia' });
        });

        // ⚡ Timer for mafia phase
        startPhaseTimer(roomCode, 'night_mafia', () => {
            // Auto-pick random target if mafia didn't vote
            if (room.phase === 'night_mafia' && !room.nightTarget) {
                const randomTarget = aliveOthers[Math.floor(Math.random() * aliveOthers.length)];
                if (randomTarget) {
                    room.nightTarget = randomTarget.name;
                    room.phase = 'night_doctor';
                    io.to(room.boss).emit('mcMafiaChose', {
                        target: randomTarget.name, votes: 0,
                        mafiaCount: aliveMafia.length, allVoted: true, autoSelected: true
                    });
                    startDoctorPhase(roomCode);
                }
            }
        });

        // Notify boss of current phase
        io.to(room.boss).emit('mcPhaseChange', { phase: 'night_mafia' });
    }

    // ── تصويت الليل ──────────────────────────────────────────────
    socket.on('mcNightVote', ({ roomCode, target, type }) => {
        const room = mcRooms[roomCode];
        if (!room) return;
        const voter = room.players.find(p => p.id === socket.id);
        if (!voter || !voter.alive) return;
        touchRoom(room);

        if (type === 'mafia_kill' && voter.role === 'mafia' && room.phase === 'night_mafia') {
            room.mafiaVotes[socket.id] = sanitize(target, 30);
            const counts = {};
            Object.values(room.mafiaVotes).forEach(v => counts[v] = (counts[v] || 0) + 1);
            const sorted = Object.entries(counts).sort((a, b) => b[1] - a[1]);
            const aliveMafia = room.players.filter(p => p.alive && p.role === 'mafia');
            const allVoted   = Object.keys(room.mafiaVotes).length >= aliveMafia.length;
            io.to(room.boss).emit('mcMafiaChose', {
                target: sorted[0]?.[0], votes: sorted[0]?.[1] || 0,
                mafiaCount: aliveMafia.length, allVoted
            });
            if (allVoted) {
                room.nightTarget = sorted[0]?.[0];
                room.phase = 'night_doctor';
                startDoctorPhase(roomCode);
            }
            return;
        }

        if (type === 'doctor_save' && voter.role === 'doctor' && room.phase === 'night_doctor') {
            if (room.doctorVoted) return;
            room.doctorVoted = true;
            room.doctorSave  = sanitize(target, 30);
            io.to(room.boss).emit('mcDoctorChose', { target: room.doctorSave });
        }
    });

    // ── مرحلة الدكتور ────────────────────────────────────────────
    function startDoctorPhase(roomCode) {
        const room = mcRooms[roomCode];
        if (!room) return;

        const doctor = room.players.find(p => p.role === 'doctor' && p.alive);
        const alive  = room.players.filter(p => p.alive && p.role !== 'spectator');

        room.players.filter(p => p.role !== 'doctor').forEach(p => {
            io.to(p.id).emit('mcNightAction', { canAct: false, phase: 'night_doctor' });
        });

        if (!doctor) {
            room.doctorSave = null;
            io.to(room.boss).emit('mcDoctorChose', { target: null, doctorDead: true });
            return;
        }

        const targets = room.firstRound ? [room.nightTarget] : alive.map(p => p.name);
        io.to(doctor.id).emit('mcNightAction', {
            type: 'doctor_save', canAct: true,
            targets, isFirstRound: room.firstRound
        });

        // Notify boss
        io.to(room.boss).emit('mcPhaseChange', { phase: 'night_doctor' });

        // ⚡ Timer for doctor
        startPhaseTimer(roomCode, 'night_doctor', () => {
            if (room.phase === 'night_doctor' && !room.doctorVoted) {
                // Doctor didn't save anyone
                room.doctorVoted = true;
                room.doctorSave = null;
                io.to(room.boss).emit('mcDoctorChose', { target: null, autoSkipped: true });
            }
        });
    }

    // ── كشف نتيجة الليل ──────────────────────────────────────────
    socket.on('mcRevealNight', (roomCode) => {
        const room = mcRooms[roomCode];
        if (!room || room.boss !== socket.id) return;
        if (room._phaseTimer) clearTimeout(room._phaseTimer);

        const target = room.nightTarget;
        const saved  = room.doctorSave != null && room.doctorSave === target;
        let killed   = false;

        if (!saved && target) {
            const p = room.players.find(pl => pl.name === target);
            if (p && p.alive && p.role !== 'spectator') { p.alive = false; killed = true; }
        }

        room.firstRound = false;
        const win = checkWin(room);

        io.to(room.boss).emit('mcNightResult', { saved, killed, targetName: target, players: room.players });

        const msg = killed
            ? `🌅 الصباح — وُجد ${target} ميتاً! ابدأوا النقاش...`
            : `🌅 الصباح — ليلة هادئة! لا أحد مات. ابدأوا النقاش...`;
        io.to('mc_' + roomCode).emit('mcRoundAnnounce', { message: msg });

        if (win.over) {
            endGame(roomCode, win.winner);
        } else {
            // ⚡ بدء مرحلة النقاش مع تايمر
            room.phase = 'discussion';
            io.to(room.boss).emit('mcPhaseChange', { phase: 'discussion' });
            startPhaseTimer(roomCode, 'discussion', () => {
                io.to('mc_' + roomCode).emit('mcRoundAnnounce', { message: '⏰ انتهى وقت النقاش! جاهزين للتصويت.' });
                io.to(room.boss).emit('mcDiscussionEnded');
            });
        }
    });

    // ── بدء التصويت النهاري ──────────────────────────────────────
    socket.on('mcStartVoting', (roomCode) => {
        const room = mcRooms[roomCode];
        if (!room || room.boss !== socket.id) return;
        if (room._phaseTimer) clearTimeout(room._phaseTimer);
        touchRoom(room);
        
        room.phase     = 'day';
        room.dayVotes  = {};

        const alive = room.players.filter(p => p.alive && p.role !== 'spectator');
        alive.forEach(p => {
            io.to(p.id).emit('mcStartDayVoting', {
                canVote: true,
                targets: alive.filter(o => o.name !== p.name).map(o => o.name),
                timer: PHASE_TIMERS.voting
            });
        });
        room.players.filter(p => !p.alive || p.role === 'spectator').forEach(p => {
            io.to(p.id).emit('mcStartDayVoting', { canVote: false, targets: [] });
        });
        io.to(room.boss).emit('votingStarted');
        io.to(room.boss).emit('mcPhaseChange', { phase: 'voting' });

        // ⚡ Timer for voting
        startPhaseTimer(roomCode, 'voting', () => {
            if (room.phase === 'day' && Object.keys(room.dayVotes).length > 0) {
                io.to(room.boss).emit('mcVotingTimerExpired');
            }
        });
    });

    // ── التصويت النهاري ──────────────────────────────────────────
    socket.on('mcCastVote', ({ roomCode, target }) => {
        const room = mcRooms[roomCode];
        if (!room || room.phase !== 'day') return;
        const voter = room.players.find(p => p.id === socket.id);
        if (!voter || !voter.alive || voter.role === 'spectator') return;
        touchRoom(room);
        room.dayVotes[socket.id] = sanitize(target, 30);
        const counts = {};
        Object.values(room.dayVotes).forEach(v => counts[v] = (counts[v] || 0) + 1);
        
        // ⚡ أرسل مين صوّت لمين (بدون كشف الأسماء — بس الإجمالي)
        const totalAlive = room.players.filter(p => p.alive && p.role !== 'spectator').length;
        io.to(room.boss).emit('mcVoteUpdate', { 
            totalVotes: Object.keys(room.dayVotes).length, 
            details: counts,
            totalAlive 
        });
        
        // أرسل للاعب نفسه تأكيد
        socket.emit('mcVoteConfirmed', { target });
    });

    // ── تنفيذ الإعدام ─────────────────────────────────────────────
    socket.on('mcExecute', (roomCode) => {
        const room = mcRooms[roomCode];
        if (!room || room.boss !== socket.id) return;
        if (room._phaseTimer) clearTimeout(room._phaseTimer);
        touchRoom(room);
        
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

        const isMafia  = p?.role === 'mafia';
        const isDoctor = p?.role === 'doctor';
        const win = checkWin(room);

        io.to(room.boss).emit('mcExecutionResult', {
            charName: kickedName, isMafia, isDoctor,
            remaining: room.players.filter(pl => pl.alive && pl.role === 'mafia').length,
            players: room.players, gameOver: win.over
        });

        const roleAnnounce = isMafia ? '🔪 كان مافيا!' : isDoctor ? '💉 كان الدكتور!' : '👤 كان مواطناً بريئاً!';
        io.to('mc_' + roomCode).emit('mcRoundAnnounce', { message: `⚖️ ${kickedName} نُفّذ فيه الإعدام — ${roleAnnounce}` });

        if (win.over) {
            endGame(roomCode, win.winner);
        } else {
            room.round++;
            room.dayVotes = {};
            setTimeout(() => startNightPhase(roomCode), 3000);
        }
    });

    // ── تشات ─────────────────────────────────────────────────────
    socket.on('mcChat', ({ roomCode, message }) => {
        const room = mcRooms[roomCode];
        if (!room) return;
        const sender  = room.players.find(p => p.id === socket.id);
        const isBoss  = socket.id === room.boss;
        const name    = isBoss ? '👑 البوس' : (sender?.name || 'مجهول');
        io.to('mc_' + roomCode).emit('mcChatMessage', {
            from: name,
            message: sanitize(String(message), 200),
            time: new Date().toLocaleTimeString('ar-EG', { hour: '2-digit', minute: '2-digit' })
        });
    });

    function endGame(roomCode, winner) {
        const room = mcRooms[roomCode];
        if (!room) return;
        if (room._phaseTimer) clearTimeout(room._phaseTimer);
        room.gameOver = true;
        room.started  = false;
        const spies  = room.players.filter(p => p.role === 'mafia').map(p => p.name);
        const doctor = room.players.find(p => p.role === 'doctor')?.name;
        const msg    = winner === 'civilians' ? '🏆 المدينة انتصرت!' : '💀 المافيا كسبت!';
        setTimeout(() => {
            io.to('mc_' + roomCode).emit('mcGameOver', {
                winner, message: msg,
                details: `💉 الدكتور: ${doctor || 'مات'}  |  🔪 المافيا: ${spies.join(', ')}`
            });
            broadcastLobbyList();
        }, 2500);
    }

    socket.on('mcGetLobbyList', () => {
        const list = Object.entries(mcRooms)
            .filter(([, r]) => !r.isPrivate)
            .map(([code, r]) => ({
                code,
                players: r.players.filter(p => p.role !== 'spectator').length,
                started: r.started
            }));
        socket.emit('mcLobbyList', list);
    });

    socket.on('mcCloseRoom', (roomCode) => {
        const room = mcRooms[roomCode];
        if (room && room._phaseTimer) clearTimeout(room._phaseTimer);
        io.to('mc_' + roomCode).emit('roomEnded');
        delete mcRooms[roomCode];
        broadcastLobbyList();
    });
};
