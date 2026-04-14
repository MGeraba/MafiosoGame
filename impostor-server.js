// ════════════════════════════════════════════════════════════════
//  IMPOSTOR — Server Module v3
//  Fix: boss doesn't see spies, AI guess check, hints system
// ════════════════════════════════════════════════════════════════

const CATEGORIES = {
  'أماكن': ['البيت','المطعم','المستشفى','الجامعة','المطار','الشاطئ','السينما','الجيم','السوق','الفندق','الملعب','المسجد','المدرسة','البنك','القطار','الحديقة','المتحف','الصيدلية','المخبز','المصنع'],
  'أكل ومشروبات': ['البيتزا','الكشري','الشاورما','العصير','الشوكولاتة','الفراخ المشوية','السوشي','الآيس كريم','البرغر','الفول','التمر','المانجو','الكنافة','الطرح','الكوكاكولا','الحمص','الفلافل','الكريب','الكيك','الشاي'],
  'مشاهير وممثلين': ['محمد رمضان','أحمد السقا','عمرو دياب','كريم عبد العزيز','هيفاء وهبي','نانسي عجرم','يسرا','عادل إمام','مصطفى شعبان','حسن الرداد','محمد صلاح','رونالدو','ميسي','بيونسيه','إيلون ماسك'],
  'حيوانات': ['الأسد','الفيل','الدلفين','الببر','القط','الكلب','الحصان','الزرافة','الذئب','الدب','القرد','التمساح','الأخطبوط','الثعلب','البومة','الببغاء','الحمامة','الأرنب','الكنغر','البطريق'],
  'مهن ووظائف': ['الطبيب','المهندس','المعلم','الطيار','الشيف','المحامي','الممرض','رجل الإطفاء','الشرطي','المصور','المحاسب','السباك','الميكانيكي','الصحفي','المقاول','الفنان','الموسيقي','المبرمج','الفلاح','الملاح'],
  'رياضة': ['كرة القدم','كرة السلة','السباحة','التنس','الملاكمة','الكاراتيه','ركوب الأمواج','الغوص','الجري','التزلج','كرة الطاولة','الدراجات','الغولف','الفروسية','الجودو'],
  'أفلام ومسلسلات': ['باب الحارة','لعبة الحبار','هاري بوتر','ابن حلال','تحت الوصاية','الاختيار','هجمة مرتدة','رامبو','الوحش','بدون ذكر أسماء','النمر الأسود','المومياء','شارلوك هولمز','ماتريكس','تيتانيك'],
  'تكنولوجيا وإلكترونيات': ['الأيفون','اللاب توب','البلايستيشن','الروبوت','السيارة الكهربائية','الطابعة','الكاميرا','الساعة الذكية','الدرون','الراوتر','التلفزيون','الشاشة','السماعات','الميكروويف','المكيف'],
  'شخصيات كرتونية': ['توم وجيري','سبونج بوب','سوبر ماريو','باتمان','سبايدرمان','شريك','سيمبا','إلسا','نيمو','الجوكر','دوراإكسبلورا','بن تن','شادو','سكوبي دو','كونان'],
  'كلمات عشوائية': ['الغيمة','الضوء','الصوت','الوقت','الحلم','الخوف','الحب','المال','القوة','الذاكرة','السر','الوهم','الحقيقة','المستقبل','اللغز','الريح','الصمت','الظل','النجمة','المرآة']
};

// spy count limits
function getSpyCount(playerCount, requested) {
  const max = playerCount <= 4 ? 1 : playerCount <= 7 ? 2 : 3;
  return Math.min(requested || 1, max);
}

const rateLimits = new Map();
function rateOk(id, max = 10) {
  const now = Date.now();
  const r = rateLimits.get(id) || { count: 0, resetAt: now + 1000 };
  if (now > r.resetAt) { r.count = 0; r.resetAt = now + 1000; }
  r.count++;
  rateLimits.set(id, r);
  return r.count <= max;
}

module.exports = function registerImpostor(io, socket, impRooms, getAIResponse) {

  function broadcastImpLobbyList() {
    const list = Object.entries(impRooms)
      .filter(([, r]) => !r.isPrivate)
      .map(([code, r]) => ({ code, players: r.players.length, started: r.started }));
    io.emit('impLobbyList', list);
  }

  // Auto cleanup
  setInterval(() => {
    const cutoff = Date.now() - 3 * 60 * 60 * 1000;
    for (const code in impRooms) {
      if (impRooms[code].createdAt < cutoff) {
        io.to('imp_' + code).emit('roomEnded');
        delete impRooms[code];
      }
    }
  }, 60 * 60 * 1000);

  // ── Create Room ───────────────────────────────────────────────
  socket.on('impCreateRoom', (opts = {}) => {
    if (!rateOk(socket.id, 3)) return;
    const code = Math.random().toString(36).substring(2, 6).toUpperCase();
    impRooms[code] = {
      boss: socket.id, bossToken: socket.id,
      players: [], started: false, gameOver: false,
      spies: [], word: '', category: '',
      votes: {}, spyGuesses: [],
      isPrivate: !!opts.isPrivate,
      pendingJoins: {},
      createdAt: Date.now(),
      hints: []
    };
    socket.join('imp_' + code);
    socket.emit('impRoomCreated', code);
    broadcastImpLobbyList();
  });

  // ── Boss Reconnect ────────────────────────────────────────────
  socket.on('impBossReconnect', ({ roomCode, bossToken }) => {
    const room = impRooms[roomCode];
    if (!room) { socket.emit('roomEnded'); return; }
    if (room.bossToken !== bossToken) { socket.emit('error', 'غير مصرح'); return; }
    if (room.deleteTimer) { clearTimeout(room.deleteTimer); room.deleteTimer = null; }
    room.boss = socket.id;
    socket.join('imp_' + roomCode);
    // IMPORTANT: boss reconnect doesn't get spies list — he plays normally
    socket.emit('impBossReconnected', {
      started: room.started, players: room.players,
      roomData: room.started ? {
        category: room.category,
        word: room.word,
        // NO spies sent to boss
        players: room.players
      } : null
    });
  });

  // ── Join Room ─────────────────────────────────────────────────
  socket.on('impJoinRoom', (data) => {
    if (!rateOk(socket.id, 5)) return;
    if (!data?.roomCode || !data?.playerName) return;
    const name = String(data.playerName).trim().substring(0, 20);
    const room = impRooms[data.roomCode];
    if (!room) { socket.emit('roomEnded'); return; }

    const existing = room.players.find(p => p.name === name);
    if (room.started && !existing) {
      room.pendingJoins[socket.id] = { id: socket.id, name };
      io.to(room.boss).emit('impJoinRequest', { id: socket.id, name });
      socket.emit('impWaitingApproval');
      return;
    }
    if (existing) {
      existing.id = socket.id;
      socket.join('imp_' + data.roomCode);
      socket.emit('impJoinedSuccess', { reconnected: true });
      if (room.started) {
        const isSpy = room.spies.includes(existing.name);
        socket.emit('impGameData', {
          name: existing.name, isSpy,
          category: room.category,
          word: isSpy ? '???' : room.word,
          hints: room.hints
        });
      }
    } else {
      if (room.players.length >= 14) { socket.emit('error', 'الغرفة ممتلئة'); return; }
      room.players.push({ id: socket.id, name, alive: true });
      socket.join('imp_' + data.roomCode);
      socket.emit('impJoinedSuccess', { reconnected: false });
    }
    io.to(room.boss).emit('updatePlayersImp', room.players);
    broadcastImpLobbyList();
  });

  // ── Approve Join ──────────────────────────────────────────────
  socket.on('impApproveJoin', ({ roomCode, playerId, approve }) => {
    const room = impRooms[roomCode];
    if (!room || room.boss !== socket.id) return;
    const pending = room.pendingJoins[playerId];
    if (!pending) return;
    delete room.pendingJoins[playerId];
    if (approve) {
      room.players.push({ id: playerId, name: pending.name, alive: true, spectator: true });
      const s = io.sockets.sockets.get(playerId);
      if (s) {
        s.join('imp_' + roomCode);
        s.emit('impJoinedSuccess', { reconnected: false, spectator: true });
        s.emit('impGameData', { name: pending.name, isSpy: false, category: room.category, word: '(مشاهد)', spectator: true, hints: room.hints });
      }
      io.to(room.boss).emit('updatePlayersImp', room.players);
    } else {
      io.to(playerId).emit('error', 'البوس رفض طلب انضمامك');
    }
  });

  // ── Player Reconnect ──────────────────────────────────────────
  socket.on('impPlayerReconnect', (data) => {
    const room = impRooms[data?.roomCode];
    if (!room) { socket.emit('roomEnded'); return; }
    const p = room.players.find(pl => pl.name === data.playerName);
    if (p) {
      p.id = socket.id;
      socket.join('imp_' + data.roomCode);
      if (room.started) {
        const isSpy = room.spies.includes(p.name);
        socket.emit('impGameData', { name: p.name, isSpy, category: room.category, word: isSpy ? '???' : room.word, hints: room.hints });
        socket.emit('impPlayerReconnected', { gameData: { name: p.name, isSpy, category: room.category, word: isSpy ? '???' : room.word, hints: room.hints } });
      } else {
        socket.emit('impJoinedSuccess', { reconnected: true });
        io.to(room.boss).emit('updatePlayersImp', room.players);
      }
    }
  });

  // ── Leave Room ────────────────────────────────────────────────
  socket.on('impLeaveRoom', ({ roomCode }) => {
    const room = impRooms[roomCode];
    if (!room) return;
    room.players = room.players.filter(p => p.id !== socket.id);
    socket.leave('imp_' + roomCode);
    socket.emit('impLeftRoom');
    io.to(room.boss).emit('updatePlayersImp', room.players);
    broadcastImpLobbyList();
  });

  // ── Start Game ────────────────────────────────────────────────
  socket.on('impStartGame', async ({ roomCode, category, spyCount }) => {
    const room = impRooms[roomCode];
    if (!room || room.boss !== socket.id) return;
    // include boss in player count
    const totalPlayers = room.players.length + 1; // +1 for boss
    if (totalPlayers < 3) { socket.emit('error', 'مطلوب 3 لاعبين على الأقل'); return; }

    room.started = true;
    room.votes   = {};
    room.spyGuesses = [];
    room.hints = [];

    let finalCategory = category, finalWord = '';

    if (category === 'ai') {
      const allCats = Object.keys(CATEGORIES);
      const prompt = `أنت تدير لعبة الجاسوس. اختر فئة وكلمة واحدة مثيرة للنقاش ومتنوعة وغير متوقعة. الفئات: ${allCats.join('، ')}. الرد JSON فقط: {"category": "اسم الفئة", "word": "الكلمة"}`;
      try {
        const res = await getAIResponse(prompt);
        if (res) {
          const parsed = JSON.parse(res.replace(/```json|```/g, '').trim());
          finalCategory = parsed.category || allCats[Math.floor(Math.random() * allCats.length)];
          finalWord = parsed.word;
        }
      } catch(e) {}
      if (!finalWord) {
        finalCategory = Object.keys(CATEGORIES)[Math.floor(Math.random() * Object.keys(CATEGORIES).length)];
        const ws = CATEGORIES[finalCategory];
        finalWord = ws[Math.floor(Math.random() * ws.length)];
      }
    } else {
      const ws = CATEGORIES[category];
      if (ws) { finalWord = ws[Math.floor(Math.random() * ws.length)]; }
      else { finalCategory = 'كلمات عشوائية'; finalWord = CATEGORIES['كلمات عشوائية'][0]; }
    }

    room.category = finalCategory;
    room.word = finalWord;

    // spy count based on player count (excluding boss)
    const actualSpyCount = getSpyCount(room.players.length, parseInt(spyCount) || 1);
    // Boss is excluded from spy selection
    const eligible = room.players.filter(p => !p.spectator);
    const shuffled = [...eligible].sort(() => Math.random() - 0.5);
    room.spies = shuffled.slice(0, actualSpyCount).map(p => p.name);

    // Generate initial hint via AI (async, non-blocking)
    generateHint(roomCode).then(hint => {
      if (hint) room.hints.push(hint);
    });

    // Send to boss — ONLY word and category, NOT spies
    io.to(room.boss).emit('impBossData', {
      category: finalCategory,
      word: finalWord,
      // spies NOT sent to boss — boss plays as normal player
      players: room.players,
      spyCount: actualSpyCount
    });

    // Send to players
    room.players.forEach(p => {
      if (p.spectator) {
        io.to(p.id).emit('impGameData', { name: p.name, isSpy: false, category: finalCategory, word: '(مشاهد)', spectator: true, hints: [] });
        return;
      }
      const isSpy = room.spies.includes(p.name);
      io.to(p.id).emit('impGameData', {
        name: p.name, isSpy,
        category: finalCategory,
        word: isSpy ? '???' : finalWord,
        hints: []
      });
    });

    broadcastImpLobbyList();
  });

  // ── Generate AI Hint ──────────────────────────────────────────
  async function generateHint(roomCode) {
    const room = impRooms[roomCode];
    if (!room) return null;
    const prompt = `في لعبة الجاسوس، الكلمة السرية هي "${room.word}" من فئة "${room.category}".
أعطني تلميحاً غامضاً يساعد اللاعبين يتناقشوا بدون أن يكشف الكلمة مباشرة.
التلميح يجب أن يكون جملة قصيرة.
الرد JSON فقط: {"hint": "التلميح هنا"}`;
    try {
      const res = await getAIResponse(prompt);
      if (res) {
        const p = JSON.parse(res.replace(/```json|```/g, '').trim());
        return p.hint || null;
      }
    } catch(e) {}
    return null;
  }

  socket.on('impRequestHint', async ({ roomCode }) => {
    const room = impRooms[roomCode];
    if (!room || room.boss !== socket.id) return;
    const hint = await generateHint(roomCode);
    if (hint) {
      room.hints.push(hint);
      io.to('imp_' + roomCode).emit('impNewHint', { hint, index: room.hints.length });
    }
  });

  // ── Restart ───────────────────────────────────────────────────
  socket.on('impRestartGame', ({ roomCode }) => {
    const room = impRooms[roomCode];
    if (!room || room.boss !== socket.id) return;
    room.started = false; room.gameOver = false;
    room.spies = []; room.votes = {}; room.spyGuesses = []; room.hints = [];
    io.to('imp_' + roomCode).emit('impBackToLobby', { players: room.players });
    io.to(room.boss).emit('updatePlayersImp', room.players);
    broadcastImpLobbyList();
  });

  // ── Start Voting ──────────────────────────────────────────────
  socket.on('impStartVoting', (roomCode) => {
    const room = impRooms[roomCode];
    if (!room || room.boss !== socket.id) return;
    room.votes = {};
    const allActive = room.players.filter(p => !p.spectator);
    allActive.forEach(p => {
      io.to(p.id).emit('impStartDayVoting', {
        canVote: true,
        targets: allActive.filter(o => o.name !== p.name).map(o => o.name)
      });
    });
    // Boss can vote too — send separate event
    const bossTargets = allActive.map(p => p.name);
    io.to(room.boss).emit('impBossCanVote', { targets: bossTargets });
    io.to(room.boss).emit('impVotingStarted');
    // Send spy guess section to spies
    room.spies.forEach(spyName => {
      const p = room.players.find(pl => pl.name === spyName);
      if (p) io.to(p.id).emit('impSpyCanGuess', { previousGuesses: room.spyGuesses });
    });
  });

  // ── Cast Votes ────────────────────────────────────────────────
  socket.on('impCastVote', ({ roomCode, target }) => {
    if (!rateOk(socket.id)) return;
    const room = impRooms[roomCode];
    if (!room) return;
    if (!room.players.find(p => p.name === target)) return; // validate
    room.votes[socket.id] = target;
    const counts = {};
    Object.values(room.votes).forEach(v => counts[v] = (counts[v] || 0) + 1);
    io.to(room.boss).emit('impVoteUpdate', { totalVotes: Object.keys(room.votes).length, details: counts });
  });

  socket.on('impBossVote', ({ roomCode, target }) => {
    const room = impRooms[roomCode];
    if (!room || room.boss !== socket.id) return;
    room.votes[socket.id] = target;
    const counts = {};
    Object.values(room.votes).forEach(v => counts[v] = (counts[v] || 0) + 1);
    io.to(room.boss).emit('impVoteUpdate', { totalVotes: Object.keys(room.votes).length, details: counts });
  });

  // ── Spy Guess (AI-checked) ────────────────────────────────────
  socket.on('impSpyGuess', async ({ roomCode, guess }) => {
    if (!rateOk(socket.id, 3)) return;
    const room = impRooms[roomCode];
    if (!room) return;
    const voter = room.players.find(p => p.id === socket.id);
    if (!voter || !room.spies.includes(voter.name)) return;

    const prompt = `أنت حكم في لعبة الجاسوس.
الكلمة الصحيحة: "${room.word}"
تخمين الجاسوس: "${guess}"
هل التخمين صحيح؟ ضع في الاعتبار: المعنى وليس اللفظ، الاختلافات الإملائية البسيطة تُعتبر صحيحة، المرادفات القريبة جداً تُعتبر صحيحة.
- صحيح: مطابق في المعنى أو اللفظ مع فرق بسيط
- قريب: معنى قريب لكن ليس مطابقاً
- خطأ: بعيد في المعنى
الرد JSON فقط: {"result": "صحيح" أو "قريب" أو "خطأ", "reason": "سبب قصير"}`;

    let result = 'خطأ', reason = '';
    try {
      const res = await getAIResponse(prompt);
      if (res) {
        const parsed = JSON.parse(res.replace(/```json|```/g, '').trim());
        result = parsed.result || 'خطأ';
        reason = parsed.reason || '';
      }
    } catch(e) {
      const g = guess.trim().toLowerCase(), w = room.word.trim().toLowerCase();
      if (g === w) result = 'صحيح';
    }

    room.spyGuesses.push({ by: voter.name, guess, result, reason, time: new Date().toLocaleTimeString('ar-EG') });
    io.to(room.boss).emit('impSpyGuessReceived', { by: voter.name, guess, result, reason });
    io.to(socket.id).emit('impGuessResult', { result, reason, word: result === 'صحيح' ? room.word : undefined });
    // Also broadcast all guesses to spies for visibility
    room.spies.forEach(n => {
      const p = room.players.find(pl => pl.name === n);
      if (p) io.to(p.id).emit('impGuessHistory', room.spyGuesses);
    });
  });

  // ── Reveal Result ─────────────────────────────────────────────
  socket.on('impRevealResult', (roomCode) => {
    const room = impRooms[roomCode];
    if (!room || room.boss !== socket.id) return;

    const counts = {};
    Object.values(room.votes).forEach(v => counts[v] = (counts[v] || 0) + 1);
    const sorted = Object.entries(counts).sort((a, b) => b[1] - a[1]);
    const mostVoted  = sorted[0]?.[0];
    const spyCaught  = room.spies.includes(mostVoted);
    const bestGuess  = room.spyGuesses.find(g => g.result === 'صحيح') || room.spyGuesses.find(g => g.result === 'قريب');
    const guessCorrect = bestGuess?.result === 'صحيح';

    let winner, icon, title, winnerText;
    if (guessCorrect) {
      winner = 'spy'; icon = '🕵️'; title = 'الجاسوس خمّن الكلمة الصح!'; winnerText = '🕵️ الجاسوس فاز بذكائه!';
    } else if (spyCaught) {
      winner = 'civilians'; icon = '🏆'; title = 'المواطنون اكتشفوا الجاسوس!'; winnerText = '🏆 المواطنون فازوا!';
    } else {
      winner = 'spy'; icon = '🕵️'; title = 'الجاسوس نجا!'; winnerText = '🕵️ الجاسوس فاز بالتمويه!';
    }

    room.gameOver = true; room.started = false;
    io.to('imp_' + roomCode).emit('impResult', {
      winner, icon, title, winnerText,
      spies: room.spies, word: room.word,
      spyGuess: bestGuess?.guess || null,
      guessResult: bestGuess?.result || null,
      guessReason: bestGuess?.reason || null,
      guessCorrect,
      message: `${title}\n${winnerText}`
    });
    broadcastImpLobbyList();
  });

  // ── Chat ──────────────────────────────────────────────────────
  socket.on('impChat', ({ roomCode, message }) => {
    if (!rateOk(socket.id, 5)) return;
    const room = impRooms[roomCode];
    if (!room) return;
    const sender = room.players.find(p => p.id === socket.id);
    const isBoss = socket.id === room.boss;
    const name   = isBoss ? '👑 البوس' : (sender?.name || 'مجهول');
    io.to('imp_' + roomCode).emit('impChatMessage', {
      from: name,
      message: String(message).substring(0, 200),
      time: new Date().toLocaleTimeString('ar-EG', { hour: '2-digit', minute: '2-digit' })
    });
  });

  // ── Lobby List ────────────────────────────────────────────────
  socket.on('impGetLobbyList', () => {
    const list = Object.entries(impRooms)
      .filter(([, r]) => !r.isPrivate)
      .map(([code, r]) => ({ code, players: r.players.length, started: r.started }));
    socket.emit('impLobbyList', list);
  });

  // ── Close Room ────────────────────────────────────────────────
  socket.on('impCloseRoom', (roomCode) => {
    const room = impRooms[roomCode];
    if (!room || room.boss !== socket.id) return;
    io.to('imp_' + roomCode).emit('roomEnded');
    delete impRooms[roomCode];
    broadcastImpLobbyList();
  });
};
