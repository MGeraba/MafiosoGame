// spyGame.js


module.exports = {
    startGame: async (io, room, roomCode, data, getAIResponse) => {
        room.mode = 'spy';
        room.spyData = {
            category: data.spyCategory,
            word: '',
            spies: [],
            votes: {},
            spyGuessing: false
        };

        // طلب الكلمة من الذكاء الاصطناعي بصيغة صارمة
        const prompt = `اكتب كلمة واحدة فقط باللغة العربية تنتمي إلى فئة: "${data.spyCategory}".
يجب أن يكون الرد بصيغة JSON فقط بهذا الشكل بالضبط: {"word": "الكلمة"}`;

        const response = await getAIResponse(prompt);
        if (!response) {
            io.to(room.boss).emit('error', 'الذكاء الاصطناعي مشغول حالياً، اضغط "ابدأ الجيم" مرة أخرى.');
            room.started = false; // عشان البوس يقدر يدوس تاني
            return;
        }

        try {
            // تنظيف صارم للـ JSON
            let cleaned = response.replace(/```json/gi, '').replace(/```/g, '').trim();
            let parsed;
            const match = cleaned.match(/\{[\s\S]*\}/);
            if (match) {
                parsed = JSON.parse(match[0]);
            } else {
                parsed = JSON.parse(cleaned);
            }
            room.spyData.word = parsed.word || parsed;
        } catch (e) {
            io.to(room.boss).emit('error', 'الذكاء الاصطناعي أرسل كلمة غير مفهومة، اضغط "ابدأ الجيم" مرة أخرى.');
            room.started = false; // عشان البوس يقدر يدوس تاني
            return;
        }

        // إدخال البوس كلاعب
        let playersWithBoss = [...room.players];
        if (!playersWithBoss.find(p => p.id === room.boss)) {
            playersWithBoss.push({
                id: room.boss,
                name: 'البوس 👑',
                role: 'مواطن',
                alive: true,
                charName: 'البوس'
            });
        }
        room.allSpyPlayers = playersWithBoss;

        // تحديد الجواسيس
        let numSpies = parseInt(data.spyCount) || 1;
        if (numSpies >= playersWithBoss.length) numSpies = 1;

        let shuffled = [...playersWithBoss].sort(() => Math.random() - 0.5);
        playersWithBoss.forEach(p => p.isSpy = false);
        
        for (let i = 0; i < numSpies; i++) {
            shuffled[i].isSpy = true;
            room.spyData.spies.push(shuffled[i].id);
        }

        // إرسال الكلمة للاعبين
        playersWithBoss.forEach(p => {
            const roleMsg = p.isSpy ? "أنت الجاسوس 🕵️‍♂️! حاول معرفة الكلمة من كلام الآخرين." : `الكلمة السرية هي: ${room.spyData.word}`;
            
            if (p.id === room.boss) {
                io.to(room.boss).emit('bossSpyData', { roleMsg, isSpy: p.isSpy, players: playersWithBoss });
            } else {
                io.to(p.id).emit('playerSpyData', { roleMsg, isSpy: p.isSpy });
            }
        });
    },

    // ... (باقي دوال الملف startVoting و handleVote زي ما هي بدون تغيير)

    startVoting: (io, room, roomCode) => {
        // إرسال قائمة اللاعبين للجميع عشان يصوتوا
        const targets = room.allSpyPlayers.map(p => p.name);
        room.allSpyPlayers.forEach(p => {
            const targetsForMe = targets.filter(t => t !== p.name);
            io.to(p.id).emit('spyVotingPhase', targetsForMe);
        });
        io.to(room.boss).emit('spyVotingStarted');
    },

    handleVote: (io, room, roomCode, voterId, targetName) => {
        room.spyData.votes[voterId] = targetName;
        const totalPlayers = room.allSpyPlayers.length;
        const currentVotes = Object.keys(room.spyData.votes).length;

        io.to(room.boss).emit('voteResultUpdate', {
            totalVotes: currentVotes,
            details: {} // يمكن عرضها لو حبيت
        });

        // لو الكل صوت، نحسب النتيجة
        if (currentVotes === totalPlayers) {
            const counts = {};
            Object.values(room.spyData.votes).forEach(v => counts[v] = (counts[v] || 0) + 1);
            const sorted = Object.entries(counts).sort((a, b) => b[1] - a[1]);
            
            const kickedName = sorted[0][0];
            const kickedPlayer = room.allSpyPlayers.find(p => p.name === kickedName);

            if (kickedPlayer && kickedPlayer.isSpy) {
                // مسكوا الجاسوس! ندي الجاسوس فرصة يخمن
                room.spyData.spyGuessing = true;
                io.to(roomCode).emit('spyCaughtGuessing', { spyName: kickedName });
                io.to(kickedPlayer.id).emit('spyGuessPhase');
            } else {
                // مسكوا حد بريء، الجواسيس تكسب
                io.to(roomCode).emit('gameOver', `💀 للأسف! صوّتم ضد "${kickedName}" وهو بريء! الجاسوس هرب وانتصر!`);
            }
        }
    },

    handleSpyGuess: (io, room, roomCode, guess) => {
        const actualWord = room.spyData.word;
        // مقارنة بسيطة (ممكن تخليها أذكى باستخدام الذكاء الاصطناعي لاحقاً)
        if (guess.trim() === actualWord.trim()) {
            io.to(roomCode).emit('gameOver', `🕵️‍♂️ الجاسوس كان ذكياً! لقد خمن الكلمة الصحيحة "${actualWord}" وانتصر!`);
        } else {
            io.to(roomCode).emit('gameOver', `🎉 الجاسوس أخطأ! قال "${guess}" والكلمة كانت "${actualWord}". انتصر الأبرياء!`);
        }
    }
};