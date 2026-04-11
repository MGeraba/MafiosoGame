// ════════════════════════════════════════════════════════════════
//  IMPOSTOR — Server Module
//  الملف ده يتضاف في server.js جوه io.on('connection', ...)
// ════════════════════════════════════════════════════════════════

// اضيف السطر ده قبل io.on('connection') في server.js:
// let impRooms = {};

// فئات اللعبة الثابتة (backup لو AI فشل)
const CATEGORIES = {
    'أماكن': ['البيت', 'المطعم', 'المستشفى', 'الجامعة', 'المطار', 'الشاطئ', 'السينما', 'الجيم', 'السوق', 'الفندق', 'الملعب', 'المسجد', 'المدرسة', 'البنك', 'القطار'],
    'أكل ومشروبات': ['البيتزا', 'الكشري', 'الشاورما', 'العصير', 'الشوكولاتة', 'الفراخ المشوية', 'السوشي', 'الآيس كريم', 'البرغر', 'الفول', 'التمر', 'المانجو', 'الكنافة', 'الطرح', 'الكوكاكولا'],
    'مشاهير وممثلين': ['محمد رمضان', 'أحمد السقا', 'عمرو دياب', 'كريم عبد العزيز', 'هيفاء وهبي', 'نانسي عجرم', 'يسرا', 'عادل إمام', 'مصطفى شعبان', 'حسن الرداد', 'إيمي سمير غانم', 'طارق لطفي', 'مؤمن زكريا'],
    'حيوانات': ['الأسد', 'الفيل', 'الدلفين', 'الببر', 'القط', 'الكلب', 'الحصان', 'الزرافة', 'الذئب', 'الدب', 'القرد', 'التمساح', 'الأخطبوط', 'الثعلب', 'البومة'],
    'مهن ووظائف': ['الطبيب', 'المهندس', 'المعلم', 'الطيار', 'الشيف', 'المحامي', 'الممرض', 'رجل الإطفاء', 'الشرطي', 'المصور', 'المحاسب', 'السباك', 'الميكانيكي', 'الصحفي', 'المقاول'],
    'رياضة': ['كرة القدم', 'كرة السلة', 'السباحة', 'التنس', 'الملاكمة', 'الكاراتيه', 'ركوب الأمواج', 'الغوص', 'الجري', 'التزلج', 'كرة الطاولة', 'الدراجات', 'الغولف', 'الفروسية', 'الجودو'],
    'أفلام ومسلسلات': ['باب الحارة', 'لعبة الحبار', 'المسار', 'هاري بوتر', 'ابن حلال', 'تحت الوصاية', 'عوالم خفية', 'الاختيار', 'هجمة مرتدة', 'نابليون', 'رامبو', 'الوحش', 'بابا أوين'],
    'تكنولوجيا وإلكترونيات': ['الأيفون', 'اللاب توب', 'البلايستيشن', 'الروبوت', 'السيارة الكهربائية', 'الطابعة', 'الكاميرا', 'الساعة الذكية', 'الدرون', 'الراوتر', 'التلفزيون', 'الشاشة', 'السماعات'],
    'شخصيات كرتونية': ['توم وجيري', 'سبونج بوب', 'سوبر ماريو', 'باتمان', 'سبايدرمان', 'شريك', 'سيمبا', 'فروزن', 'نيمو', 'والاس وغروميت', 'فيلكس القط', 'باكمان', 'سنو وايت'],
    'كلمات عشوائية': ['الغيمة', 'الضوء', 'الصوت', 'الوقت', 'الحلم', 'الخوف', 'الحب', 'المال', 'القوة', 'الذاكرة', 'السر', 'الوهم', 'الحقيقة', 'المستقبل', 'اللغز']
};

module.exports = function registerImpostor(io, socket, impRooms, getAIResponse) {

    // ── إنشاء غرفة ───────────────────────────────────────────────
    socket.on('impCreateRoom', () => {
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
            spyGuess: null
        };
        socket.join('imp_' + code);
        socket.emit('impRoomCreated', code);
    });

    // ── Boss Reconnect ────────────────────────────────────────────
    socket.on('impBossReconnect', ({ roomCode, bossToken }) => {
        const room = impRooms[roomCode];
        if (!room) { socket.emit('roomEnded'); return; }
        if (room.bossToken !== bossToken) { socket.emit('error', 'غير مصرح'); return; }
        if (room.deleteTimer) { clearTimeout(room.deleteTimer); room.deleteTimer = null; }
        room.boss = socket.id;
        socket.join('imp_' + roomCode);
        socket.emit('impBossReconnected', {
            started: room.started,
            players: room.players,
            roomData: room.started ? {
                category: room.category,
                word: room.word,
                spies: room.spies,
                players: room.players
            } : null
        });
    });

    // ── انضمام لاعب ──────────────────────────────────────────────
    socket.on('impJoinRoom', (data) => {
        const room = impRooms[data.roomCode];
        if (!room) { socket.emit('roomEnded'); return; }
        if (room.started) { socket.emit('error', 'اللعبة بدأت!'); return; }
        const existing = room.players.find(p => p.name === data.playerName);
        if (existing) {
            existing.id = socket.id;
            socket.join('imp_' + data.roomCode);
            socket.emit('impJoinedSuccess', { reconnected: true });
        } else {
            room.players.push({ id: socket.id, name: data.playerName, alive: true });
            socket.join('imp_' + data.roomCode);
            socket.emit('impJoinedSuccess', { reconnected: false });
        }
        io.to(room.boss).emit('updatePlayersImp', room.players);
    });

    // ── Player Reconnect ──────────────────────────────────────────
    socket.on('impPlayerReconnect', (data) => {
        const room = impRooms[data.roomCode];
        if (!room) { socket.emit('roomEnded'); return; }
        const p = room.players.find(pl => pl.name === data.playerName);
        if (p) {
            p.id = socket.id;
            socket.join('imp_' + data.roomCode);
            if (room.started) {
                const isSpy = room.spies.includes(p.name);
                socket.emit('impGameData', {
                    name: p.name,
                    isSpy,
                    category: room.category,
                    word: isSpy ? '???' : room.word
                });
                socket.emit('impPlayerReconnected', {
                    gameData: {
                        name: p.name,
                        isSpy,
                        category: room.category,
                        word: isSpy ? '???' : room.word
                    }
                });
            } else {
                socket.emit('impJoinedSuccess', { reconnected: true });
                io.to(room.boss).emit('updatePlayersImp', room.players);
            }
        }
    });

    // ── بدء اللعبة ────────────────────────────────────────────────
    socket.on('impStartGame', async ({ roomCode, category, spyCount }) => {
        const room = impRooms[roomCode];
        if (!room || room.players.length < 3) { socket.emit('error', 'مطلوب 3 لاعبين على الأقل'); return; }

        room.started = true;

        // اختيار الكلمة والفئة بالذكاء الاصطناعي أو من القائمة
        let finalCategory = category;
        let finalWord = '';

        if (category === 'ai') {
            // نطلب من الذكاء الاصطناعي
            const allCats = Object.keys(CATEGORIES);
            const randomCat = allCats[Math.floor(Math.random() * allCats.length)];
            const playerNames = room.players.map(p => p.name).join(', ');

            const prompt = `أنت تلعب لعبة الإمبوستر/الجاسوس. اللاعبون: [${playerNames}].
اختر فئة وكلمة واحدة مثيرة للنقاش من قائمتك الداخلية.
الرد JSON فقط: {"category": "اسم الفئة", "word": "الكلمة المختارة"}
اختر من هذه الفئات: أماكن، أكل ومشروبات، مشاهير وممثلين، حيوانات، مهن ووظائف، رياضة، أفلام ومسلسلات، تكنولوجيا وإلكترونيات، شخصيات كرتونية، كلمات عشوائية`;

            try {
                const response = await getAIResponse(prompt);
                if (response) {
                    const cleaned = response.replace(/```json/gi, '').replace(/```/g, '').trim();
                    const parsed = JSON.parse(cleaned);
                    finalCategory = parsed.category || randomCat;
                    finalWord = parsed.word;
                }
            } catch (e) {
                console.warn('AI category failed, using fallback');
            }

            // fallback
            if (!finalWord) {
                finalCategory = randomCat;
                const words = CATEGORIES[randomCat] || CATEGORIES['كلمات عشوائية'];
                finalWord = words[Math.floor(Math.random() * words.length)];
            }
        } else {
            // فئة محددة من البوس
            const words = CATEGORIES[category];
            if (words) {
                finalWord = words[Math.floor(Math.random() * words.length)];
            } else {
                finalWord = 'كلمة';
            }
        }

        room.category = finalCategory;
        room.word = finalWord;
        room.votes = {};
        room.spyGuess = null;

        // اختيار الجواسيس عشوائياً
        const shuffled = [...room.players].sort(() => Math.random() - 0.5);
        const actualSpyCount = Math.min(spyCount || 1, Math.floor(room.players.length / 2));
        room.spies = shuffled.slice(0, actualSpyCount).map(p => p.name);

        // إرسال البيانات للبوس
        io.to(room.boss).emit('impBossData', {
            category: finalCategory,
            word: finalWord,
            spies: room.spies,
            players: room.players
        });

        // إرسال للاعبين
        room.players.forEach(p => {
            const isSpy = room.spies.includes(p.name);
            io.to(p.id).emit('impGameData', {
                name: p.name,
                isSpy,
                category: finalCategory,
                word: isSpy ? '???' : finalWord
            });
        });
    });

    // ── بدء التصويت ──────────────────────────────────────────────
    socket.on('impStartVoting', (roomCode) => {
        const room = impRooms[roomCode];
        if (!room) return;
        room.votes = {};

        const alive = room.players.filter(p => p.alive);
        alive.forEach(p => {
            const targets = alive.filter(o => o.name !== p.name).map(o => o.name);
            io.to(p.id).emit('impStartDayVoting', { canVote: true, targets });
        });

        io.to(room.boss).emit('impVotingStarted');
    });

    // ── التصويت ──────────────────────────────────────────────────
    socket.on('impCastVote', ({ roomCode, target }) => {
        const room = impRooms[roomCode];
        if (!room) return;
        room.votes[socket.id] = target;
        const counts = {};
        Object.values(room.votes).forEach(v => counts[v] = (counts[v] || 0) + 1);
        io.to(room.boss).emit('impVoteUpdate', {
            totalVotes: Object.keys(room.votes).length,
            details: counts
        });
    });

    // ── تخمين الجاسوس ────────────────────────────────────────────
    socket.on('impSpyGuess', ({ roomCode, guess }) => {
        const room = impRooms[roomCode];
        if (!room) return;
        const voter = room.players.find(p => p.id === socket.id);
        if (!voter || !room.spies.includes(voter.name)) return;
        // نحفظ أول تخمين فقط
        if (!room.spyGuess) room.spyGuess = { by: voter.name, guess };
        io.to(room.boss).emit('impSpyGuessReceived', { by: voter.name, guess });
    });

    // ── كشف النتيجة ──────────────────────────────────────────────
    socket.on('impRevealResult', (roomCode) => {
        const room = impRooms[roomCode];
        if (!room) return;

        const counts = {};
        Object.values(room.votes).forEach(v => counts[v] = (counts[v] || 0) + 1);
        const sorted = Object.entries(counts).sort((a, b) => b[1] - a[1]);
        const mostVoted = sorted[0]?.[0];

        const spyCaught = room.spies.includes(mostVoted);
        const spyGuessCorrect = room.spyGuess
            ? room.spyGuess.guess.trim().toLowerCase() === room.word.trim().toLowerCase()
            : false;

        // منطق الفوز:
        // - لو المواطنون اكتشفوا الجاسوس (spyCaught) والجاسوس مش خمّن صح → المواطنون يفوزوا
        // - لو الجاسوس خمّن الكلمة صح → الجاسوس يفوز حتى لو اتكشف
        // - لو المواطنون صوّتوا غلط → الجاسوس يفوز
        let winner, icon, title, winnerText;

        if (spyGuessCorrect) {
            winner = 'spy';
            icon = '🕵️';
            title = 'الجاسوس خمّن الكلمة الصح!';
            winnerText = '🕵️ الجاسوس فاز بذكائه!';
        } else if (spyCaught) {
            winner = 'civilians';
            icon = '🏆';
            title = 'المواطنون اكتشفوا الجاسوس!';
            winnerText = '🏆 المواطنون فازوا!';
        } else {
            winner = 'spy';
            icon = '🕵️';
            title = 'الجاسوس نجا من الاكتشاف!';
            winnerText = '🕵️ الجاسوس فاز بالتمويه!';
        }

        room.gameOver = true;
        const resultData = {
            winner,
            icon,
            title,
            winnerText,
            spies: room.spies,
            word: room.word,
            spyGuess: room.spyGuess?.guess || null,
            guessCorrect: spyGuessCorrect,
            message: `${title}\n${winnerText}`
        };

        io.to('imp_' + roomCode).emit('impResult', resultData);
    });

    // ── إغلاق الغرفة ─────────────────────────────────────────────
    socket.on('impCloseRoom', (roomCode) => {
        io.to('imp_' + roomCode).emit('roomEnded');
        delete impRooms[roomCode];
    });
};
