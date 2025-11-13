// server_pool.js
const path = require('path');
const express = require('express');
const http = require('http');
const { Server } = require('socket.io');

const app = express();
const server = http.createServer(app);
const io = new Server(server, { pingInterval: 25000, pingTimeout: 20000 });

app.use(express.static(path.join(__dirname, 'public')));

// Root -> pool.html (så "Cannot GET /" aldrig händer)
app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'pool.html'));
});

/* ---------------- Lobby, kö, scoreboard ---------------- */
let queue = [];                   // [{id, name}]
let matches = new Map();          // roomId -> Match
let waitingChampion = null;       // { id, name, readyAt, timeout }

const wins = [];                  // [{ name, ts }]
const DAY_MS = 24 * 60 * 60 * 1000;

function getScoreboard() {
  const now = Date.now();
  while (wins.length && now - wins[0].ts > DAY_MS) wins.shift();
  const tally = new Map();
  for (const w of wins) {
    if (now - w.ts > DAY_MS) continue;
    tally.set(w.name, (tally.get(w.name) || 0) + 1);
  }
  return [...tally.entries()]
    .map(([name, count]) => ({ name, count }))
    .sort((a, b) => b.count - a.count || a.name.localeCompare(b.name));
}

function broadcastQueue() {
  io.to('lobby').emit('queue:update', {
    count: queue.length,
    names: queue.map(p => p.name),
  });
}
function broadcastScoreboard() {
  io.to('lobby').emit('score:update', getScoreboard());
}
function removeFromQueue(id) {
  const i = queue.findIndex(p => p.id === id);
  if (i !== -1) queue.splice(i, 1);
}
function nextRoomId() {
  return 'room_' + Math.random().toString(36).slice(2, 10);
}

/* ---------------- Chat-begränsningar ---------------- */
function isInQueue(id) { return queue.some(p => p.id === id); }
const CHAT_COOLDOWN_MS = 5000;
const lastChatAt = new Map(); // socketId -> timestamp

/* ---------------- Bord & fysik (server-authoritativ) ---------------- */
const TICK_MS = 16;                      // ~60fps
const W = 1080, H = 540;                 // bordstorlek
const MARGIN = 30;                       // rails
const R = 10;                            // bollradie
const POCKET_R = 18;                     // fickradie
const FRICTION = 0.992;                  // friktion per tick
const STOP_EPS = 0.04;                   // tröskel för vila
const CUE_IMPULSE = 9.5;                 // kraft-multiplikator (lite punchy)
const MAX_SHOT_POWER = 1.0;

const POCKETS = [
  { x: MARGIN, y: MARGIN },
  { x: W / 2, y: MARGIN },
  { x: W - MARGIN, y: MARGIN },
  { x: MARGIN, y: H - MARGIN },
  { x: W / 2, y: H - MARGIN },
  { x: W - MARGIN, y: H - MARGIN },
];

// Mindre strikt: tillåt placering nära fickor men inte inne i dem
function nearPocket(x, y) {
  const rr = (POCKET_R - 2) * (POCKET_R - 2);
  for (const p of POCKETS) {
    const dx = x - p.x, dy = y - p.y;
    if (dx * dx + dy * dy <= rr) return true;
  }
  return false;
}

const BALLS = {
  cue: 0, eight: 8,
  solids: [1, 2, 3, 4, 5, 6, 7],
  stripes: [9, 10, 11, 12, 13, 14, 15],
};

function rackLayout() {
  const startX = W * 0.66, startY = H / 2;
  const dx = R * 2 + 0.5, dy = R * 1.73;
  const order = [1,2,3,4,5,6,7,8, 9,10,11,12,13,14,15];
  for (let i = order.length - 1; i > 0; i--) {
    const j = (Math.random() * (i + 1)) | 0; [order[i], order[j]] = [order[j], order[i]];
  }
  const balls = [];
  let idx = 0;
  for (let row = 0; row < 5; row++) {
    const nx = startX + row * dx;
    const ny = startY - row * dy / 2;
    for (let k = 0; k <= row; k++) {
      const n = order[idx++];
      balls.push({ id: n, x: nx, y: ny + k * dy, vx: 0, vy: 0, potted: false });
    }
  }
  // cue-ball
  balls.push({ id: 0, x: W * 0.25, y: H * 0.5, vx: 0, vy: 0, potted: false });
  return balls;
}
function dist2(ax, ay, bx, by) { const dx = ax - bx, dy = ay - by; return dx * dx + dy * dy; }
function norm(x, y) { const d = Math.hypot(x, y) || 1; return [x / d, y / d]; }

/* ---------------- Match ---------------- */
class Match {
  constructor(roomId, left, right) {
    this.roomId = roomId;
    this.players = [left.id, right.id];
    this.names = { [left.id]: left.name, [right.id]: right.name };

    this.current = this.players[0];        // tur-ägare
    this.balls = rackLayout();
    this.groups = { [left.id]: null, [right.id]: null }; // solid/stripe
    this.legalToEight = { [left.id]: false, [right.id]: false };

    this.ballInHand = true;                // <-- ÖPPNING: första spelaren får placera
    this.waitingShot = true;
    this.anyPottedThisTurn = [];
    this.foulThisTurn = false;

    // För UI + misslogik
    this.pottedBy = { [left.id]: [], [right.id]: [] };
    this.firstContactMade = false;

    this.timer = null;
    this.lastSent = 0; // nät-throttle
  }

  start() {
    if (this.timer) return;
    this.timer = setInterval(() => this.tick(), TICK_MS);
    this.sendState();
  }
  stop() { if (this.timer) clearInterval(this.timer); this.timer = null; }

  ballsMoving() {
    for (const b of this.balls) {
      if (!b.potted && (Math.abs(b.vx) > STOP_EPS || Math.abs(b.vy) > STOP_EPS)) return true;
    }
    return false;
  }

  shot(fromId, { dx, dy, power, place }) {
    if (fromId !== this.current) return;
    const cue = this.balls.find(b => b.id === BALLS.cue);
    if (this.ballInHand && place) {
      cue.x = Math.min(W - MARGIN - R, Math.max(MARGIN + R, place.x));
      cue.y = Math.min(H - MARGIN - R, Math.max(MARGIN + R, place.y));
    }
    const p = Math.max(0, Math.min(MAX_SHOT_POWER, +power || 0));
    const [nx, ny] = norm(dx, dy);
    cue.vx += nx * CUE_IMPULSE * p;
    cue.vy += ny * CUE_IMPULSE * p;

    this.waitingShot = false;
    this.anyPottedThisTurn.length = 0;
    this.foulThisTurn = false;
    this.firstContactMade = false;  // för "missade allt"
  }

  tick() {
    if (this.waitingShot) { this.sendState(); return; }

    this.integrate();
    this.handleCollisions();
    this.handlePockets();

    if (!this.ballsMoving()) {
      this.resolveTurn();
      this.waitingShot = true;
    }

    this.sendState(); // mjuk animation
  }

  integrate() {
    for (const b of this.balls) {
      if (b.potted) continue;
      b.x += b.vx; b.y += b.vy;
      b.vx *= FRICTION; b.vy *= FRICTION;
      // rails
      if (b.x <= MARGIN + R) { b.x = MARGIN + R; b.vx = Math.abs(b.vx); }
      if (b.x >= W - MARGIN - R) { b.x = W - MARGIN - R; b.vx = -Math.abs(b.vx); }
      if (b.y <= MARGIN + R) { b.y = MARGIN + R; b.vy = Math.abs(b.vy); }
      if (b.y >= H - MARGIN - R) { b.y = H - MARGIN - R; b.vy = -Math.abs(b.vy); }
      if (Math.abs(b.vx) < STOP_EPS) b.vx = 0;
      if (Math.abs(b.vy) < STOP_EPS) b.vy = 0;
    }
  }

  handleCollisions() {
    for (let i = 0; i < this.balls.length; i++) {
      const a = this.balls[i]; if (a.potted) continue;
      for (let j = i + 1; j < this.balls.length; j++) {
        const b = this.balls[j]; if (b.potted) continue;
        const dx = b.x - a.x, dy = b.y - a.y, rr = (R * 2) * (R * 2);
        const d2 = dx * dx + dy * dy;
        if (d2 > 0 && d2 < rr) {
          const d = Math.sqrt(d2) || 1;
          const nx = dx / d, ny = dy / d;
          // separera
          const overlap = (R * 2 - d) / 2;
          a.x -= nx * overlap; a.y -= ny * overlap;
          b.x += nx * overlap; b.y += ny * overlap;
          // elastisk impuls (lika massor)
          const av = a.vx * nx + a.vy * ny;
          const bv = b.vx * nx + b.vy * ny;
          const p = bv - av;
          a.vx += nx * p; a.vy += ny * p;
          b.vx -= nx * p; b.vy -= ny * p;

          // första kontakt mellan cue och någon annan boll
          if (!this.firstContactMade) {
            if ((a.id === BALLS.cue && b.id !== BALLS.cue) ||
                (b.id === BALLS.cue && a.id !== BALLS.cue)) {
              this.firstContactMade = true;
            }
          }
        }
      }
    }
  }

  handlePockets() {
    for (const b of this.balls) {
      if (b.potted) continue;
      for (const p of POCKETS) {
        if (dist2(b.x, b.y, p.x, p.y) <= (POCKET_R - 4) * (POCKET_R - 4)) {
          b.potted = true; b.vx = 0; b.vy = 0;
          this.anyPottedThisTurn.push(b.id);
          if (b.id === BALLS.cue) this.foulThisTurn = true;
          break;
        }
      }
    }
  }

  resolveTurn() {
    const me = this.current;
    const opp = this.players.find(id => id !== me);

    // foul: scratch eller ingen träff alls
    if (this.anyPottedThisTurn.includes(BALLS.cue) || !this.firstContactMade) {
      const cue = this.balls.find(b => b.id === BALLS.cue);
      if (this.anyPottedThisTurn.includes(BALLS.cue)) {
        cue.potted = false; cue.x = W * 0.25; cue.y = H * 0.5; cue.vx = cue.vy = 0;
      }
      this.ballInHand = true;   // motståndaren får placera
      this.foulThisTurn = true;
    } else {
      this.ballInHand = false;
    }

    // kreditera sänkningar till skytten (UI-listor)
    for (const id of this.anyPottedThisTurn) {
      if (id !== BALLS.cue && id !== BALLS.eight) this.pottedBy[me].push(id);
    }

    // sätt grupper om ej satta
    if (this.groups[me] == null && this.anyPottedThisTurn.some(id => id !== BALLS.cue && id !== BALLS.eight)) {
      const first = this.anyPottedThisTurn.find(id => id !== BALLS.cue && id !== BALLS.eight);
      const isSolid = BALLS.solids.includes(first);
      this.groups[me] = isSolid ? 'solid' : 'stripe';
      this.groups[opp] = isSolid ? 'stripe' : 'solid';
    }

    // uppdatera legalToEight
    for (const pid of this.players) {
      const grp = this.groups[pid];
      if (!grp) { this.legalToEight[pid] = false; continue; }
      const left = this.balls.filter(b =>
        !b.potted && ((grp === 'solid' && BALLS.solids.includes(b.id)) ||
                      (grp === 'stripe' && BALLS.stripes.includes(b.id)))).length;
      this.legalToEight[pid] = (left === 0);
    }

    // 8:an?
    if (this.anyPottedThisTurn.includes(BALLS.eight)) {
      const legal = this.legalToEight[me] && !this.foulThisTurn;
      const winner = legal ? me : opp;
      const loser = legal ? opp : me;
      this.endMatch(winner, loser);
      return;
    }

    // turbyte/fortsatt tur
    const scoredMine = this.anyPottedThisTurn.some(id => {
      const grp = this.groups[me]; if (!grp) return false;
      return (grp === 'solid' && BALLS.solids.includes(id)) ||
             (grp === 'stripe' && BALLS.stripes.includes(id));
    });
    if (this.foulThisTurn || !scoredMine) this.current = opp;

    this.anyPottedThisTurn.length = 0;
    this.foulThisTurn = false;
  }

  endMatch(winner, loser) {
    const wName = this.names[winner] || 'Spelare';
    wins.push({ name: wName, ts: Date.now() });
    broadcastScoreboard();

    io.to('lobby').emit('chat:system', `${wName} VANN MATCHEN!! STORT GRATTIS!`);

    io.to(this.roomId).emit('pool:match:end', {
      winnerId: winner,
      loserId: loser,
      winnerName: wName,
      loserName: this.names[loser] || 'Spelare'
    });

    this.stop();

    // kasta båda ur kön (kräv aktivt "Gå med i kön" igen)
    removeFromQueue(winner); removeFromQueue(loser);

    const wSock = io.sockets.sockets.get(winner);
    const lSock = io.sockets.sockets.get(loser);
    if (wSock) { wSock.leave(this.roomId); wSock.join('lobby'); wSock.emit('queue:left'); }
    if (lSock) { lSock.leave(this.roomId); lSock.join('lobby'); lSock.emit('queue:left'); }

    matches.delete(this.roomId);
    broadcastQueue();

    setChampionHold30s(winner, wName);
  }

  snapshot() {
    return {
      w: W, h: H, r: R, pr: POCKET_R, m: MARGIN,
      pockets: POCKETS,
      balls: this.balls.map(b => ({ id: b.id, x: b.x, y: b.y, vx: b.vx, vy: b.vy, potted: b.potted })),
      current: this.current,
      players: this.players,
      names: this.names,
      groups: this.groups,
      legalToEight: this.legalToEight,
      ballInHand: this.ballInHand,
      waitingShot: this.waitingShot,
      pottedBy: this.pottedBy
    };
  }

  sendState() {
    const now = Date.now();
    if (now - this.lastSent < 33) return; // ~30 fps till klienten
    this.lastSent = now;
    io.to(this.roomId).emit('pool:state', this.snapshot());
  }
}

/* ---------------- Champion-hold & matchmaking ---------------- */
function clearWinnerHold() {
  if (waitingChampion?.timeout) clearTimeout(waitingChampion.timeout);
  waitingChampion = null;
}
function setChampionHold30s(id, name) {
  clearWinnerHold();
  waitingChampion = { id, name, readyAt: Date.now() + 30000, timeout: null };
  waitingChampion.timeout = setTimeout(() => {
    const s = io.sockets.sockets.get(waitingChampion.id);
    if (s) s.emit('winner:timeout');
    waitingChampion.readyAt = Date.now();
    tryStartMatch();
  }, 30000);
}
function canStartMatch() {
  if (matches.size > 0) return false;
  if (waitingChampion) {
    if (Date.now() < (waitingChampion.readyAt || 0)) return false;
    return queue.length >= 1;
  }
  return queue.length >= 2;
}
function tryStartMatch() {
  if (!canStartMatch()) { broadcastQueue(); return; }

  let left, right;
  if (waitingChampion) { left = waitingChampion; right = queue.shift(); clearWinnerHold(); }
  else { left = queue.shift(); right = queue.shift(); }

  const sL = io.sockets.sockets.get(left.id);
  const sR = io.sockets.sockets.get(right.id);
  if (!sL || !sR) {
    if (sL) queue.unshift(left);
    if (sR) queue.unshift(right);
    broadcastQueue();
    return;
  }

  const roomId = nextRoomId();
  sL.leave('lobby'); sR.leave('lobby');
  sL.join(roomId); sR.join(roomId);

  const m = new Match(roomId, left, right);
  matches.set(roomId, m); m.start();

  sL.emit('pool:match:start', {
    roomId, opponent: right.name,
    players: { selfId: left.id, oppId: right.id }
  });
  sR.emit('pool:match:start', {
    roomId, opponent: left.name,
    players: { selfId: right.id, oppId: left.id }
  });

  broadcastQueue();
}

/* ---------------- Socket.IO ---------------- */
io.on('connection', (socket) => {
  socket.join('lobby');
  socket.emit('queue:update', { count: queue.length, names: queue.map(p => p.name) });
  socket.emit('score:update', getScoreboard());

  // chatt: krav att stå i kön + cooldown
  socket.on('chat:message', ({ text }) => {
    const now = Date.now();
    if (!isInQueue(socket.id)) {
      socket.emit('chat:error', 'Du måste vara i kön för att chatta.');
      return;
    }
    const last = lastChatAt.get(socket.id) || 0;
    const diff = now - last;
    if (diff < CHAT_COOLDOWN_MS) {
      const secs = Math.ceil((CHAT_COOLDOWN_MS - diff) / 1000);
      socket.emit('chat:error', `Vänta ${secs}s innan du skickar igen.`);
      return;
    }
    const entry = queue.find(p => p.id === socket.id);
    const name = entry?.name || 'Spelare';
    const clean = String(text || '').slice(0, 500).trim();
    if (!clean) return;
    lastChatAt.set(socket.id, now);
    io.to('lobby').emit('chat:message', { name, text: clean, ts: now });
  });

  // kö
  socket.on('queue:join', (name) => {
    if (queue.some(p => p.id === socket.id)) return;
    const clean = (name || 'Spelare').trim().slice(0, 18);
    queue.push({ id: socket.id, name: clean });
    socket.emit('queue:joined');
    broadcastQueue();
    tryStartMatch();
  });

  socket.on('queue:leave', () => {
    removeFromQueue(socket.id);
    socket.emit('queue:left');
    broadcastQueue();
  });

  socket.on('winner:cancel', () => { clearWinnerHold(); broadcastQueue(); });

  socket.on('disconnect', () => {
    const wasInQueue = isInQueue(socket.id);
    removeFromQueue(socket.id);
    if (waitingChampion && waitingChampion.id === socket.id) clearWinnerHold();

    for (const [roomId, m] of matches) {
      if (!m.players.includes(socket.id)) continue;
      const other = m.players.find(id => id !== socket.id);
      const otherSock = io.sockets.sockets.get(other);
      if (otherSock) {
        otherSock.leave(roomId); otherSock.join('lobby');
        otherSock.emit('pool:opponent-left');
        otherSock.emit('queue:left');
      }
      m.stop(); matches.delete(roomId);
    }
    if (wasInQueue) socket.emit?.('queue:left');
    broadcastQueue();
    tryStartMatch();
  });

  // spel-input
  socket.on('pool:shot', ({ roomId, dx, dy, power, place }) => {
    const m = matches.get(roomId); if (!m) return;
    if (!m.players.includes(socket.id)) return;
    if (m.current !== socket.id) return;
    m.shot(socket.id, { dx, dy, power, place });
  });

  // klick-placering av vit boll när ball-in-hand
  socket.on('pool:place', ({ roomId, x, y }) => {
    const m = matches.get(roomId); if (!m) return;
    if (!m.players.includes(socket.id)) return;
    if (m.current !== socket.id) return;
    if (!m.ballInHand || !m.waitingShot) return;

    // Begränsa inom bordet
    let nx = Math.min(W - MARGIN - R, Math.max(MARGIN + R, x));
    let ny = Math.min(H - MARGIN - R, Math.max(MARGIN + R, y));

    // Inte inne i ficka
    if (nearPocket(nx, ny)) return;

    // Inte över annan boll
    for (const b of m.balls) {
      if (b.id === 0 || b.potted) continue;
      const dx = nx - b.x, dy = ny - b.y;
      if (dx*dx + dy*dy < (2*R)*(2*R)) return;
    }

    const cue = m.balls.find(b => b.id === 0);
    cue.potted = false; cue.vx = cue.vy = 0;
    cue.x = nx; cue.y = ny;

    m.sendState();
  });
});

/* ---------------- Start ---------------- */
const port = process.env.PORT || 3000;
server.listen(port, () => console.log('Pool server on', port));
