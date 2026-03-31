const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const { GoogleGenerativeAI } = require("@google/generative-ai");

const app = express();
const server = http.createServer(app);
const io = new Server(server);

app.use(express.static('public'));

const genAI = new GoogleGenerativeAI(process.env.GEMINI_KEY);

async function AI(prompt){
    const model = genAI.getGenerativeModel({ model: "gemini-2.5-flash" });
    const res = await model.generateContent(prompt);
    return res.response.text().replace(/```json|```/g,'').trim();
}

let rooms = {};

io.on('connection',(socket)=>{

socket.on('createRoom',()=>{
const code=Math.random().toString(36).substring(2,6).toUpperCase();

rooms[code]={boss:socket.id,players:[],votes:{},round:1};

socket.join(code);
socket.emit('roomCreated',code);
});

socket.on('joinRoom',(d)=>{
const r=rooms[d.roomCode];
if(!r) return;

r.players.push({id:socket.id,name:d.playerName,alive:true,role:"مواطن"});

socket.join(d.roomCode);
socket.emit('joinedSuccess');
io.to(r.boss).emit('updatePlayers',r.players);
});

socket.on('startGame',async (d)=>{
const r=rooms[d.roomCode];

const prompt=`
اكتب قصة مافيا + 6 hints + شخصيات
JSON فقط:
{
"story":"...",
"hints":["...","...","...","...","...","..."],
"assignments":[{"name":"...","charName":"...","secret":"..."}]
}`;

const aiText=await AI(prompt);
const scenario=JSON.parse(aiText);

r.scenario=scenario;

// توزيع مافيا
const shuffled=[...r.players].sort(()=>Math.random()-0.5);
shuffled[0].role="مافيوسو";
shuffled[1].role="مافيوسو";

r.players.forEach(p=>{
const a=scenario.assignments.find(x=>x.name===p.name);
p.charName=a?.charName||p.name;
p.secret=a?.secret||"";

io.to(p.id).emit('gameData',{
role:p.role,
story:scenario.story,
charName:p.charName,
secret:p.secret
});
});

io.to(r.boss).emit('bossData',{story:scenario.story,players:r.players});

io.to(r.boss).emit('newHint',{hint:scenario.hints[0],round:1});
});

socket.on('startVoting',(c)=>{
io.to(c).emit('startVoting',rooms[c].players);
});

socket.on('vote',({roomCode,target})=>{
const r=rooms[roomCode];
if(!r.votes[target]) r.votes[target]=0;
r.votes[target]++;
});

socket.on('executeKill',(c)=>{
const r=rooms[c];
let max=0,k=null;

for(let p in r.votes){
if(r.votes[p]>max){max=r.votes[p];k=p;}
}

const pl=r.players.find(x=>x.name===k);
if(pl) pl.alive=false;

io.to(c).emit('playerKilled',k);
});

socket.on('nextRound',(c)=>{
const r=rooms[c];
r.round++;
r.votes={};

io.to(r.boss).emit('newHint',{
hint:r.scenario.hints[r.round-1],
round:r.round
});
});

socket.on('getHint',async (c)=>{
const h=await AI("هنت غامض للمافيا");
io.to(rooms[c].boss).emit('extraHint',h);
});

});

server.listen(3000,()=>console.log("🔥 Running"));