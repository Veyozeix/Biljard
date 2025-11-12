// server_pool.js
const path = require('path');
const express = require('express');
const http = require('http');
const { Server } = require('socket.io');

const app = express();
const server = http.createServer(app);
const io = new Server(server, { pingInterval: 25000, pingTimeout: 20000 });

app.use(express.static(path.join(__dirname, 'public')));

/** ---------- Lobby, kö, scoreboard ---------- **/
let queue = [];
let matches = new Map();
let waitingChampion = null;

const wins = [];
const DAY_MS = 24 * 60 * 60 * 1000;
function getScoreboard() {
  const now = Date.now();
  while (wins.length && now - wins[0].ts > DAY_MS) wins.shift();
  const tally = new Map();
  for (const w of wins) {
    if (now - w.ts > DAY_MS) continue;
    tally.set(w.name, (tally.get(w.name) || 0) + 1);
  }
  return [...tally.entries()].map(([name, count]) => ({ name, count }))
    .sort((a,b)=> b.count - a.count || a.name.localeCompare(b.name));
}
function broadcastQueue() {
  io.to('lobby').emit('queue:update', { count: queue.length, names: queue.map(p=>p.name) });
}
function broadcastScoreboard() { io.to('lobby').emit('score:update', getScoreboard()); }
function removeFromQueue(id){ const i = queue.findIndex(p=>p.id===id); if(i!==-1) queue.splice(i,1); }
function nextRoomId(){ return 'room_' + Math.random().toString(36).slice(2,10); }

/** ---------- Chat-begränsningar ---------- **/
function isInQueue(id){ return queue.some(p=>p.id===id); }
const CHAT_COOLDOWN_MS = 5000;
const lastChatAt = new Map();

/** ---------- Bord & fysik ---------- **/
const TICK_MS = 16;                 // ~60fps
const W = 1080, H = 540;
const MARGIN = 30;
const R = 10;
const POCKET_R = 18;
const FRICTION = 0.992;
const STOP_EPS = 0.04;
const CUE_IMPULSE = 7.5;
const MAX_SHOT_POWER = 1.0;

const POCKETS = [
  {x:MARGIN, y:MARGIN}, {x:W/2, y:MARGIN}, {x:W-MARGIN, y:MARGIN},
  {x:MARGIN, y:H-MARGIN}, {x:W/2, y:H-MARGIN}, {x:W-MARGIN, y:H-MARGIN},
];

const BALLS = {
  cue: 0, eight: 8,
  solids: [1,2,3,4,5,6,7],
  stripes: [9,10,11,12,13,14,15]
};

function rackLayout() {
  const startX = W*0.66, startY = H/2;
  const dx = R*2 + 0.5, dy = R*1.73;
  const order = [1,2,3,4,5,6,7,8,9,10,11,12,13,14,15];
  for (let i=order.length-1;i>0;i--){ const j=(Math.random()*(i+1))|0; [order[i],order[j]]=[order[j],order[i]]; }
  const balls = [];
  let idx=0;
  for (let row=0; row<5; row++){
    const nx = startX + row*dx;
    const ny = startY - row*dy/2;
    for (let k=0;k<=row;k++){
      const n = order[idx++];
      balls.push({ id:n, x:nx, y:ny+k*dy, vx:0, vy:0, potted:false });
    }
  }
  balls.push({ id:0, x:W*0.25, y:H*0.5, vx:0, vy:0, potted:false });
  return balls;
}

function dist2(ax,ay,bx,by){ const dx=ax-bx, dy=ay-by; retu
