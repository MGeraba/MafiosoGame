// ════════════════════════════════════════════════════════════════
//  MAFIA CLASSIC — Server Module v3
//  Fixes: doctor vote, timers, rate-limit, auto-cleanup
// ════════════════════════════════════════════════════════════════

// Phase timers (seconds)
const TIMERS = {
  night_mafia: 30,
  night_doctor: 20,
  discussion: 90,
  voting: 25
};

// Rate limit: max events per socket per second
const rateLimits = new Map(); // socketId -> { count, resetAt }
function rateOk(socketId, max = 10) {
  const now = Date.now();
  const r = rateLimits.get(socketId) || { count: 0, resetAt: now + 1000 };
  if (now > r.resetAt) { r.count = 0; r.resetAt = now + 1000; }
  r.count++;
  rateLimits.set(socketId, r);
  return r.count <= max;
}

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

  // ── Phase Timer Helper ────────────────────────────────────────
  function startPhaseTimer(roomCode, phase, seconds, onExpire) {
    const room = mcRooms[roomCode];
    if (!room) return;
    // clear existing
    if (room.phaseTimer) clearTimeout(room.phaseTimer);
    // broadcast countdown
    io.to('mc_' + roomCode).emit('mcPhaseTimer', { phase, seconds });
    // auto-expire
    room.phaseTimer = setTimeout(() => {
      if (mcRooms[roomCode]) onExpire();
    }, seconds * 1000);
  }

  function clearPhaseTimer(room) {
    if (room?.phaseTimer) { clearTimeout(room.phaseTimer); room.phaseTimer = null; }
  }

  // ── Auto Cleanup (غرف قديمة كل ساعة) ────────────────────────
  setInterval(() => {
    const cutoff = Date.now() - 3 * 60 * 60 * 1000; // 3 hours
    for (const code in mcRooms) {
      const r = mcRooms[code];
      if (r.createdAt && r.createdAt < cutoff) {
        io.to('mc_' + code).emit('roomEnded');
        delete mcRooms[code];
        console.log(`[MC] Auto-cleaned room ${code}`);
      }
    }
  }, 60 * 60 * 1000);

  // ── Create Room ───────────────────────────────────────────────
  socket.on('mcCreateRoom', (opts = {}) => {
    if (!rateOk(socket.id, 3)) return;
    const code = Math.random().toString(36).substring(2, 6).toUpperCase();
    mcRooms[code] = {
      boss: socket.id, bossToken: socket.id,
      players: [], phase: 'lobby', round: 1,
      mafiaVotes: {}, dayVotes: {},
      started: false, gameOver: false,
      nightTarget: null, doctorSave: null, doctorVoted: false,
      firstRound: true,
      isPrivate: !!opts.isPrivate,
      pendingJoins: {},
      createdAt: Date.now(),
      phaseTimer: null
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
    socket.join('mc_' + roomCode);
    socket.emit('mcBossReconnected', {
      started: room.started, players: room.players,
      roomData: room.started ? { players: room.players, phase: room.phase } : null
    });
  });

  // ── Join Room ─────────────────────────────────────────────────
  socket.on('mcJoinRoom', (data) => {
    if (!rateOk(socket.id, 5)) return;
    if (!data?.roomCode || !data?.playerName) return;
    const name = String(data.playerName).trim().substring(0, 20);
    const room = mcRooms[data.roomCode];
    if (!room) { socket.emit('roomEnded'); return; }

    const existing = room.players.find(p => p.name === name);
    if (room.started && !existing) {
      room.pendingJoins[socket.id] = { id: socket.id, name };
      io.to(room.boss).emit('mcJoinRequest', { id: socket.id, name });
      socket.emit('mcWaitingApproval');
      return;
    }
    if (existing) {
      existing.id = socket.id;
      socket.join('mc_' + data.roomCode);
      socket.emit('mcJoinedSuccess', { reconnected: true });
      if (room.started) socket.emit('mcGameData', buildPlayerData(existing, room));
    } else {
      if (room.players.filter(p => p.role !== 'spectator').length >= 16) {
        socket.emit('error', 'الغرفة ممتلئة'); return;
      }
      room.players.push({ id: socket.id, name, role: 'civilian', alive: true });
      socket.join('mc_' + data.roomCode);
      socket.emit('mcJoinedSuccess', { reconnected: false });
    }
    io.to(room.boss).emit('updatePlayersMC', room.players);
    broadcastLobbyList();
  });

  // ── Approve Join ──────────────────────────────────────────────
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

  // ── Player Reconnect ──────────────────────────────────────────
  socket.on('mcPlayerReconnect', (data) => {
    const room = mcRooms[data?.roomCode];
    if (!room) { socket.emit('roomEnded'); return; }
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

  // ── Leave Room ────────────────────────────────────────────────
  socket.on('mcLeaveRoom', ({ roomCode }) => {
    const room = mcRooms[roomCode];
    if (!room) return;
    room.players = room.players.filter(p => p.id !== socket.id);
    socket.leave('mc_' + roomCode);
    socket.emit('mcLeftRoom');
    io.to(room.boss).emit('updatePlayersMC', room.players);
    broadcastLobbyList();
  });

  // ── Start / Restart Game ──────────────────────────────────────
  socket.on('mcStartGame', ({ roomCode }) => {
    const room = mcRooms[roomCode];
    if (!room || room.boss !== socket.id) return;
    const real = room.players.filter(p => p.role !== 'spectator');
    if (real.length < 4) { socket.emit('error', 'مطلوب 4 لاعبين على الأقل'); return; }

    clearPhaseTimer(room);
    room.started = true; room.gameOver = false;
    room.phase = 'night_mafia'; room.firstRound = true; room.round = 1;
    room.mafiaVotes = {}; room.dayVotes = {};
    room.nightTarget = null; room.doctorSave = null; room.doctorVoted = false;

    const mafiaCount = getMafiaCount(real.length);
    const shuffled   = [...real].sort(() => Math.random() - 0.5);
    real.forEach(p => { p.role = 'civilian'; p.alive = true; });
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
    clearPhaseTimer(room);
    room.started = false; room.gameOver = false;
    room.players.forEach(p => { p.role = p.role === 'spectator' ? 'spectator' : 'civilian'; p.alive = true; });
    io.to('mc_' + roomCode).emit('mcBackToLobby', { players: room.players });
    io.to(room.boss).emit('updatePlayersMC', room.players);
    broadcastLobbyList();
  });

  // ── Night Phase ───────────────────────────────────────────────
  function startNightPhase(roomCode) {
    const room = mcRooms[roomCode];
    if (!room) return;
    room.phase = 'night_mafia';
    room.mafiaVotes = {}; room.nightTarget = null;
    room.doctorSave = null; room.doctorVoted = false;

    const alive      = room.players.filter(p => p.alive && p.role !== 'spectator');
    const aliveMafia = alive.filter(p => p.role === 'mafia');
    const aliveOther = alive.filter(p => p.role !== 'mafia');

    aliveMafia.forEach(p => io.to(p.id).emit('mcNightAction', {
      type: 'mafia_kill', canAct: true,
      targets: aliveOther.map(pl => pl.name),
      timer: TIMERS.night_mafia
    }));
    aliveOther.forEach(p => io.to(p.id).emit('mcNightAction', { canAct: false }));
    room.players.filter(p => !p.alive || p.role === 'spectator').forEach(p =>
      io.to(p.id).emit('mcNightAction', { canAct: false })
    );

    // timer: auto-pick random target if mafia didn't all vote
    startPhaseTimer(roomCode, 'night_mafia', TIMERS.night_mafia, () => {
      const r = mcRooms[roomCode];
      if (!r || r.phase !== 'night_mafia') return;
      // اختار أكثر صوت أو random
      const counts = {};
      Object.values(r.mafiaVotes).forEach(v => counts[v] = (counts[v] || 0) + 1);
      const sorted = Object.entries(counts).sort((a, b) => b[1] - a[1]);
      const aliveOtherNow = r.players.filter(p => p.alive && p.role !== 'mafia' && p.role !== 'spectator');
      if (!sorted.length && aliveOtherNow.length) {
        r.nightTarget = aliveOtherNow[Math.floor(Math.random() * aliveOtherNow.length)].name;
      } else if (sorted.length) {
        r.nightTarget = sorted[0][0];
      }
      r.phase = 'night_doctor';
      io.to(r.boss).emit('mcMafiaChose', { target: r.nightTarget, votes: 0, mafiaCount: aliveMafia.length, allVoted: true });
      startDoctorPhase(roomCode);
    });
  }

  // ── Night Vote ────────────────────────────────────────────────
  socket.on('mcNightVote', ({ roomCode, target, type }) => {
    if (!rateOk(socket.id)) return;
    const room = mcRooms[roomCode];
    if (!room) return;
    const voter = room.players.find(p => p.id === socket.id);
    if (!voter || !voter.alive) return;

    // Mafia vote
    if (type === 'mafia_kill' && voter.role === 'mafia' && room.phase === 'night_mafia') {
      // validate target exists and alive
      const targetPlayer = room.players.find(p => p.name === target && p.alive && p.role !== 'mafia');
      if (!targetPlayer) return;
      room.mafiaVotes[socket.id] = target;
      const counts = {};
      Object.values(room.mafiaVotes).forEach(v => counts[v] = (counts[v] || 0) + 1);
      const sorted = Object.entries(counts).sort((a, b) => b[1] - a[1]);
      const aliveMafia = room.players.filter(p => p.alive && p.role === 'mafia');
      const allVoted = Object.keys(room.mafiaVotes).length >= aliveMafia.length;
      io.to(room.boss).emit('mcMafiaChose', {
        target: sorted[0]?.[0], votes: sorted[0]?.[1] || 0,
        mafiaCount: aliveMafia.length, allVoted
      });
      if (allVoted) {
        clearPhaseTimer(room);
        room.nightTarget = sorted[0]?.[0];
        room.phase = 'night_doctor';
        startDoctorPhase(roomCode);
      }
      return;
    }

    // Doctor vote
    if (type === 'doctor_save' && voter.role === 'doctor' && room.phase === 'night_doctor') {
      if (room.doctorVoted) return;
      // validate target
      const targetPlayer = room.players.find(p => p.name === target && p.alive);
      if (!targetPlayer) return;
      room.doctorVoted = true;
      room.doctorSave = target;
      clearPhaseTimer(room);
      io.to(room.boss).emit('mcDoctorChose', { target });
    }
  });

  // ── Doctor Phase ──────────────────────────────────────────────
  function startDoctorPhase(roomCode) {
    const room = mcRooms[roomCode];
    if (!room) return;
    const doctor = room.players.find(p => p.role === 'doctor' && p.alive);
    const alive  = room.players.filter(p => p.alive && p.role !== 'spectator');

    room.players.filter(p => p.role !== 'doctor').forEach(p =>
      io.to(p.id).emit('mcNightAction', { canAct: false })
    );

    if (!doctor) {
      room.doctorSave = null;
      io.to(room.boss).emit('mcDoctorChose', { target: null, doctorDead: true });
      return;
    }

    const targets = room.firstRound ? [room.nightTarget] : alive.map(p => p.name);
    io.to(doctor.id).emit('mcNightAction', {
      type: 'doctor_save', canAct: true,
      targets, isFirstRound: room.firstRound,
      timer: TIMERS.night_doctor
    });

    // timer: if doctor doesn't respond, random save
    startPhaseTimer(roomCode, 'night_doctor', TIMERS.night_doctor, () => {
      const r = mcRooms[roomCode];
      if (!r || r.phase !== 'night_doctor' || r.doctorVoted) return;
      // doctor didn't vote — no save
      r.doctorVoted = true;
      r.doctorSave = null;
      io.to(r.boss).emit('mcDoctorChose', { target: null, timedOut: true });
    });
  }

  // ── Reveal Night ──────────────────────────────────────────────
  socket.on('mcRevealNight', (roomCode) => {
    const room = mcRooms[roomCode];
    if (!room || room.boss !== socket.id) return;
    clearPhaseTimer(room);

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

    if (win.over) { endGame(roomCode, win.winner); return; }

    // Discussion timer
    startPhaseTimer(roomCode, 'discussion', TIMERS.discussion, () => {
      const r = mcRooms[roomCode];
      if (!r || r.phase !== 'day') return;
      io.to(r.boss).emit('mcTimerExpired', { phase: 'discussion' });
    });
  });

  // ── Start Day Voting ──────────────────────────────────────────
  socket.on('mcStartVoting', (roomCode) => {
    const room = mcRooms[roomCode];
    if (!room || room.boss !== socket.id) return;
    clearPhaseTimer(room);
    room.phase = 'day'; room.dayVotes = {};

    const alive = room.players.filter(p => p.alive && p.role !== 'spectator');
    alive.forEach(p => io.to(p.id).emit('mcStartDayVoting', {
      canVote: true,
      targets: alive.filter(o => o.name !== p.name).map(o => o.name),
      timer: TIMERS.voting
    }));
    room.players.filter(p => !p.alive || p.role === 'spectator').forEach(p =>
      io.to(p.id).emit('mcStartDayVoting', { canVote: false, targets: [] })
    );
    io.to(room.boss).emit('votingStarted');

    startPhaseTimer(roomCode, 'voting', TIMERS.voting, () => {
      const r = mcRooms[roomCode];
      if (!r || r.phase !== 'day') return;
      io.to(r.boss).emit('mcTimerExpired', { phase: 'voting', autoExecute: Object.keys(r.dayVotes).length > 0 });
    });
  });

  // ── Cast Vote ─────────────────────────────────────────────────
  socket.on('mcCastVote', ({ roomCode, target }) => {
    if (!rateOk(socket.id)) return;
    const room = mcRooms[roomCode];
    if (!room || room.phase !== 'day') return;
    const voter = room.players.find(p => p.id === socket.id);
    if (!voter || !voter.alive || voter.role === 'spectator') return;
    // validate target
    if (!room.players.find(p => p.name === target && p.alive)) return;
    room.dayVotes[socket.id] = target;
    const counts = {};
    Object.values(room.dayVotes).forEach(v => counts[v] = (counts[v] || 0) + 1);
    io.to(room.boss).emit('mcVoteUpdate', { totalVotes: Object.keys(room.dayVotes).length, details: counts });
  });

  // ── Execute ───────────────────────────────────────────────────
  socket.on('mcExecute', (roomCode) => {
    const room = mcRooms[roomCode];
    if (!room || room.boss !== socket.id) return;
    clearPhaseTimer(room);

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

  // ── Chat ──────────────────────────────────────────────────────
  socket.on('mcChat', ({ roomCode, message }) => {
    if (!rateOk(socket.id, 5)) return;
    const room = mcRooms[roomCode];
    if (!room) return;
    const sender = room.players.find(p => p.id === socket.id);
    const isBoss = socket.id === room.boss;
    const name   = isBoss ? '👑 البوس' : (sender?.name || 'مجهول');
    io.to('mc_' + roomCode).emit('mcChatMessage', {
      from: name,
      message: String(message).substring(0, 200),
      time: new Date().toLocaleTimeString('ar-EG', { hour: '2-digit', minute: '2-digit' })
    });
  });

  // ── End Game ──────────────────────────────────────────────────
  function endGame(roomCode, winner) {
    const room = mcRooms[roomCode];
    if (!room) return;
    clearPhaseTimer(room);
    room.gameOver = true; room.started = false;
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

  // ── Lobby List ────────────────────────────────────────────────
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

  // ── Close Room ────────────────────────────────────────────────
  socket.on('mcCloseRoom', (roomCode) => {
    const room = mcRooms[roomCode];
    if (!room || room.boss !== socket.id) return;
    clearPhaseTimer(room);
    io.to('mc_' + roomCode).emit('roomEnded');
    delete mcRooms[roomCode];
    broadcastLobbyList();
  });
};
