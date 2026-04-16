// ════════════════════════════════════════════════════════════════
//  IMPOSTOR — Server Module (v3 - Boss plays, timers, hints)
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

// HINTS: حروف أو أوصاف جزئية
function generateHint(word, hintNumber) {
    const hints = [];
    if (word.length > 0) hints.push(`الكلمة بتبدأ بحرف "${word[0]}"`);
    if (word.length > 1) hints.push(`الكلمة فيها ${word.length} أحرف`);
    if (word.length > 2) hints.push(`آخر حرف في الكلمة "${word[word.length-1]}"`);
    if (word.length > 3) hints.push(`الحرف التاني في الكلمة "${word[1]}"`);
    hints.push(`الكلمة فيها حرف "${word[Math.floor(word.length/2)]}"`);
    return hints[Math.min(hintNumber, hints.length - 1)] || hints[0];
}

// Smart spy count based on player count
function getSmartSpyCount(playerCount, requestedCount) {
    // Max spies = floor(players / 3), min 1
    const maxSpies = Math.max(1, Math.floor(playerCount / 3));
    return Math.min(requestedCount || 1, maxSpies);
}

function sanitize(str, maxLen = 50) {
    if (typeof str !== 'string') return '';
    return str.trim().substring(0, maxLen).replace(/[<>]/g, '');
}

module.exports = function registerImpostor(io, socket, impRooms, getAIResponse) {

    function touchRoom(room) { room._lastActivity = Date.now(); }

    function broadcastImpLobbyList() {
        const list = Object.entries(impRooms)
            .filter(([, r]) => !r.isPrivate)
            .map(([code, r]) => ({
                code,
                players: r.players.length,
                started: r.started
            }));
        io.emit('impLobbyList', list);
    }

    // ── إنشاء غرفة ───────────────────────────────────────────────
    socket.on('impCreateRoom', (opts = {}) => {
        const code = Math.random().toString(36).substring(2, 6).toUpperCase();
        impRooms[code] = {
            boss: socket.id,
            bossToken: socket.id,
            players: [],
            started: false,
            gameOver: false,
            spies: [],
            word: '',
            category: '',
            votes: {},
            spyGuesses: [],
            hintsGiven: 0,
            isPrivate: !!opts.isPrivate,
            pendingJoins: {},
            _lastActivity: Date.now()
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
        touchRoom(room);
        socket.join('imp_' + roomCode);
        
        // ⚡ البوس يلعب — يحصل على نفس بيانات اللاعبين (بدون كشف الجواسيس)
        if (room.started) {
            const bossPlayer = room.players.find(p => p.id === room.boss || p.isBoss);
            const isSpy = bossPlayer ? room.spies.includes(bossPlayer.name) : false;
            socket.emit('impBossReconnected', {
                started: room.started,
                players: room.players,
                roomData: {
                    category: room.category,
                    word: isSpy ? '???' : room.word,
                    isSpy,
                    isBossPlaying: true,
                    // البوس يشوف بس إحصائيات التصويت وتخمينات الجواسيس (بدون معرفة مين الجاسوس)
                    spyGuesses: room.spyGuesses,
                    players: room.players.map(p => ({ name: p.name, spectator: p.spectator }))
                }
            });
        } else {
            socket.emit('impBossReconnected', {
                started: false,
                players: room.players,
                roomData: null
            });
        }
    });

    // ── انضمام لاعب ──────────────────────────────────────────────
    socket.on('impJoinRoom', (data) => {
        const room = impRooms[data.roomCode];
        if (!room) { socket.emit('roomEnded'); return; }
        touchRoom(room);

        const playerName = sanitize(data.playerName, 20);
        if (!playerName) { socket.emit('error', 'اسم غير صالح'); return; }
        
        const existing = room.players.find(p => p.name === playerName);

        if (room.started && !existing) {
            room.pendingJoins[socket.id] = { id: socket.id, name: playerName };
            io.to(room.boss).emit('impJoinRequest', { id: socket.id, name: playerName });
            socket.emit('impWaitingApproval');
            return;
        }

        if (existing) {
            existing.id = socket.id;
            socket.join('imp_' + data.roomCode);
            socket.emit('impJoinedSuccess', { reconnected: true });
            if (room.started) {
                const isSpy = room.spies.includes(existing.name);
                socket.emit('impGameData', { name: existing.name, isSpy, category: room.category, word: isSpy ? '???' : room.word });
            }
        } else {
            if (room.players.length >= 20) { socket.emit('error', 'الغرفة ممتلئة!'); return; }
            room.players.push({ id: socket.id, name: playerName, alive: true });
            socket.join('imp_' + data.roomCode);
            socket.emit('impJoinedSuccess', { reconnected: false });
        }
        io.to(room.boss).emit('updatePlayersImp', room.players);
        broadcastImpLobbyList();
    });

    // ── موافقة البوس ─────────────────────────────────────────────
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
                s.emit('impGameData', { name: pending.name, isSpy: false, category: room.category, word: '(مشاهد)', spectator: true });
            }
            io.to(room.boss).emit('updatePlayersImp', room.players);
        } else {
            io.to(playerId).emit('error', 'البوس رفض طلب انضمامك');
        }
    });

    // ── Player Reconnect ──────────────────────────────────────────
    socket.on('impPlayerReconnect', (data) => {
        const room = impRooms[data.roomCode];
        if (!room) { socket.emit('roomEnded'); return; }
        touchRoom(room);
        const p = room.players.find(pl => pl.name === data.playerName);
        if (p) {
            p.id = socket.id;
            socket.join('imp_' + data.roomCode);
            if (room.started) {
                const isSpy = room.spies.includes(p.name);
                socket.emit('impGameData', { name: p.name, isSpy, category: room.category, word: isSpy ? '???' : room.word });
                socket.emit('impPlayerReconnected', { gameData: { name: p.name, isSpy, category: room.category, word: isSpy ? '???' : room.word } });
            } else {
                socket.emit('impJoinedSuccess', { reconnected: true });
                io.to(room.boss).emit('updatePlayersImp', room.players);
            }
        }
    });

    // ── خروج لاعب ────────────────────────────────────────────────
    socket.on('impLeaveRoom', ({ roomCode }) => {
        const room = impRooms[roomCode];
        if (!room) return;
        room.players = room.players.filter(p => p.id !== socket.id);
        socket.leave('imp_' + roomCode);
        socket.emit('impLeftRoom');
        io.to(room.boss).emit('updatePlayersImp', room.players);
        broadcastImpLobbyList();
    });

    // ── بدء اللعبة ────────────────────────────────────────────────
    socket.on('impStartGame', async ({ roomCode, category, spyCount }) => {
        const room = impRooms[roomCode];
        if (!room || room.boss !== socket.id) return;
        if (room.players.length < 3) { socket.emit('error', 'مطلوب 3 لاعبين على الأقل'); return; }
        touchRoom(room);

        room.started = true;
        room.votes   = {};
        room.spyGuesses = [];
        room.hintsGiven = 0;

        let finalCategory = category;
        let finalWord     = '';

        if (category === 'ai') {
            const allCats = Object.keys(CATEGORIES);
            const prompt  = `أنت تدير لعبة الجاسوس. اختر فئة وكلمة واحدة مثيرة للنقاش ومتنوعة وغير متوقعة. الفئات المتاحة: ${allCats.join('، ')}. الرد JSON فقط: {"category": "اسم الفئة", "word": "الكلمة"}`;
            try {
                const res = await getAIResponse(prompt);
                if (res) {
                    const parsed = JSON.parse(res.replace(/```json|```/g, '').trim());
                    finalCategory = parsed.category || allCats[Math.floor(Math.random()*allCats.length)];
                    finalWord     = parsed.word;
                }
            } catch(e) {}
            if (!finalWord) {
                finalCategory = allCats[Math.floor(Math.random()*allCats.length)];
                const ws = CATEGORIES[finalCategory];
                finalWord = ws[Math.floor(Math.random()*ws.length)];
            }
        } else {
            const ws = CATEGORIES[category];
            if (ws) finalWord = ws[Math.floor(Math.random()*ws.length)];
            else { finalCategory = 'كلمات عشوائية'; finalWord = CATEGORIES['كلمات عشوائية'][0]; }
        }

        room.category = finalCategory;
        room.word     = finalWord;

        // ⚡ Smart spy count — البوس ممكن يكون جاسوس!
        const activePlayers = room.players.filter(p => !p.spectator);
        const actualCount = getSmartSpyCount(activePlayers.length, spyCount);
        
        // ⚡ الكل ممكن يكون جاسوس (بما فيهم البوس)
        const shuffled = [...activePlayers].sort(() => Math.random() - 0.5);
        room.spies = shuffled.slice(0, actualCount).map(p => p.name);

        // ⚡ إرسال لكل اللاعبين (بما فيهم البوس) — نفس البيانات
        activePlayers.forEach(p => {
            const isSpy = room.spies.includes(p.name);
            io.to(p.id).emit('impGameData', {
                name: p.name,
                isSpy,
                category: finalCategory,
                word: isSpy ? '???' : finalWord,
                totalPlayers: activePlayers.length,
                spyCount: actualCount
            });
        });

        // ⚡ البوس يحصل على بيانات إضافية للإدارة (بدون كشف الجواسيس!)
        io.to(room.boss).emit('impBossGameStarted', {
            category: finalCategory,
            totalPlayers: activePlayers.length,
            spyCount: actualCount,
            players: room.players.map(p => ({ name: p.name, spectator: p.spectator }))
            // ⚠️ لا نرسل word ولا spies — البوس بيلعب زي اللاعبين!
        });

        broadcastImpLobbyList();
    });

    // ── طلب هينت ──────────────────────────────────────────────────
    socket.on('impRequestHint', (roomCode) => {
        const room = impRooms[roomCode];
        if (!room || !room.started) return;
        if (room.hintsGiven >= 3) {
            socket.emit('error', 'تم استنفاد كل الهنتات (3/3)');
            return;
        }
        const hint = generateHint(room.word, room.hintsGiven);
        room.hintsGiven++;
        // أرسل الهنت للجميع
        io.to('imp_' + roomCode).emit('impHint', { 
            hint, 
            hintNumber: room.hintsGiven, 
            maxHints: 3 
        });
    });

    // ── إعادة اللعبة ─────────────────────────────────────────────
    socket.on('impRestartGame', ({ roomCode }) => {
        const room = impRooms[roomCode];
        if (!room || room.boss !== socket.id) return;
        room.started  = false;
        room.gameOver = false;
        room.spies    = [];
        room.votes    = {};
        room.spyGuesses = [];
        room.hintsGiven = 0;
        touchRoom(room);
        io.to('imp_' + roomCode).emit('impBackToLobby', { players: room.players });
        io.to(room.boss).emit('updatePlayersImp', room.players);
        broadcastImpLobbyList();
    });

    // ── بدء التصويت ──────────────────────────────────────────────
    socket.on('impStartVoting', (roomCode) => {
        const room = impRooms[roomCode];
        if (!room) return;
        room.votes = {};
        touchRoom(room);

        const VOTE_TIME = 30;

        // ⚡ الكل يصوت بما فيهم البوس — نفس الآلية
        const allActive = room.players.filter(p => !p.spectator);
        allActive.forEach(p => {
            const targets = allActive.filter(o => o.name !== p.name).map(o => o.name);
            io.to(p.id).emit('impStartDayVoting', { canVote: true, targets, timer: VOTE_TIME });
        });

        // إرسال تايمر للجميع
        io.to('imp_' + roomCode).emit('impPhaseTimer', {
            seconds: VOTE_TIME,
            label: 'التصويت',
            phase: 'voting'
        });

        io.to(room.boss).emit('impVotingStarted');
    });

    // ── تصويت لاعب (موحد — للكل بما فيهم البوس) ─────────────────
    socket.on('impCastVote', ({ roomCode, target }) => {
        const room = impRooms[roomCode];
        if (!room) return;
        touchRoom(room);
        room.votes[socket.id] = sanitize(target, 30);
        const counts = {};
        Object.values(room.votes).forEach(v => counts[v] = (counts[v] || 0) + 1);
        // أرسل التحديث للبوس
        io.to(room.boss).emit('impVoteUpdate', { totalVotes: Object.keys(room.votes).length, details: counts });
    });

    // ── تخمين الجاسوس ──────────────────────────────────────────
    socket.on('impSpyGuess', async ({ roomCode, guess }) => {
        const room = impRooms[roomCode];
        if (!room) return;
        const voter = room.players.find(p => p.id === socket.id);
        if (!voter || !room.spies.includes(voter.name)) return;
        touchRoom(room);

        const safeGuess = sanitize(guess, 50);
        
        const prompt = `أنت حكم في لعبة الجاسوس.
الكلمة الصحيحة: "${room.word}"
تخمين الجاسوس: "${safeGuess}"

هل التخمين صحيح؟ ضع في اعتبارك:
- المعنى وليس فقط اللفظ الحرفي
- الاختلافات الإملائية البسيطة تُعتبر صحيحة
- المرادفات القريبة جداً تُعتبر صحيحة

الرد JSON فقط: {"result": "صحيح" أو "قريب" أو "خطأ", "reason": "سبب قصير بالعربي"}`;

        let result = 'خطأ', reason = 'لم يستطع التحقق';
        try {
            const res = await getAIResponse(prompt);
            if (res) {
                const parsed = JSON.parse(res.replace(/```json|```/g, '').trim());
                result = parsed.result || 'خطأ';
                reason = parsed.reason || '';
            }
        } catch(e) {
            const g = safeGuess.trim().toLowerCase().replace(/\s+/g,' ');
            const w = room.word.trim().toLowerCase().replace(/\s+/g,' ');
            if (g === w) result = 'صحيح';
        }

        const isCorrect = result === 'صحيح';

        const guessEntry = { by: voter.name, guess: safeGuess, result, reason };
        room.spyGuesses.push(guessEntry);
        
        // أرسل للبوس
        io.to(room.boss).emit('impSpyGuessReceived', guessEntry);
        
        // ⚡ أرسل التخمينات السابقة لكل اللاعبين (بدون كشف الكلمة)
        io.to('imp_' + roomCode).emit('impPreviousGuesses', {
            guesses: room.spyGuesses.map(g => ({ by: g.by, guess: g.guess, result: g.result }))
        });

        // نُعلم الجاسوس بنتيجة تخمينه
        io.to(socket.id).emit('impGuessResult', { result, reason, word: room.word });
    });

    // ── كشف النتيجة ──────────────────────────────────────────────
    socket.on('impRevealResult', (roomCode) => {
        const room = impRooms[roomCode];
        if (!room) return;

        const counts = {};
        Object.values(room.votes).forEach(v => counts[v] = (counts[v] || 0) + 1);
        const sorted     = Object.entries(counts).sort((a, b) => b[1] - a[1]);
        const mostVoted  = sorted[0]?.[0];
        const spyCaught  = room.spies.includes(mostVoted);

        const bestGuess   = room.spyGuesses.find(g => g.result === 'صحيح') ||
                            room.spyGuesses.find(g => g.result === 'قريب');
        const guessCorrect = bestGuess?.result === 'صحيح';

        let winner, icon, title, winnerText;

        if (guessCorrect) {
            winner = 'spy'; icon = '🕵️';
            title  = 'الجاسوس خمّن الكلمة الصح!';
            winnerText = '🕵️ الجاسوس فاز بذكائه!';
        } else if (spyCaught && !guessCorrect) {
            winner = 'civilians'; icon = '🏆';
            title  = 'المواطنون اكتشفوا الجاسوس!';
            winnerText = '🏆 المواطنون فازوا!';
        } else {
            winner = 'spy'; icon = '🕵️';
            title  = 'الجاسوس نجا من الاكتشاف!';
            winnerText = '🕵️ الجاسوس فاز بالتمويه!';
        }

        room.gameOver = true;
        room.started  = false;

        io.to('imp_' + roomCode).emit('impResult', {
            winner, icon, title, winnerText,
            spies: room.spies,
            word: room.word,
            spyGuess: bestGuess?.guess || null,
            guessResult: bestGuess?.result || null,
            guessReason: bestGuess?.reason || null,
            guessCorrect,
            allGuesses: room.spyGuesses,
            message: `${title}\n${winnerText}`
        });

        broadcastImpLobbyList();
    });

    // ── تشات ─────────────────────────────────────────────────────
    socket.on('impChat', ({ roomCode, message }) => {
        const room = impRooms[roomCode];
        if (!room) return;
        const sender = room.players.find(p => p.id === socket.id);
        const isBoss = socket.id === room.boss;
        const name   = isBoss ? '👑 البوس' : (sender?.name || 'مجهول');
        io.to('imp_' + roomCode).emit('impChatMessage', {
            from: name,
            message: sanitize(String(message), 200),
            time: new Date().toLocaleTimeString('ar-EG', { hour: '2-digit', minute: '2-digit' })
        });
    });

    // ── قائمة الغرف ──────────────────────────────────────────────
    socket.on('impGetLobbyList', () => {
        const list = Object.entries(impRooms)
            .filter(([, r]) => !r.isPrivate)
            .map(([code, r]) => ({ code, players: r.players.length, started: r.started }));
        socket.emit('impLobbyList', list);
    });

    // ── إغلاق الغرفة ─────────────────────────────────────────────
    socket.on('impCloseRoom', (roomCode) => {
        io.to('imp_' + roomCode).emit('roomEnded');
        delete impRooms[roomCode];
        broadcastImpLobbyList();
    });
};
