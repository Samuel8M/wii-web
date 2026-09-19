const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const os = require('os');

const app = express();
const server = http.createServer(app);
const io = new Server(server);

app.use(express.static('public'));

// In-memory room state. Fine for a hackathon demo (single process, no persistence needed).
// rooms[code] = {
//   hostSocketId, game: null | 'bowling' | 'balance',
//   players: [{ id, name, score, alive }],
//   turnIndex: 0
// }
const rooms = {};

function makeRoomCode() {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; // no confusing chars
  let code;
  do {
    code = Array.from({ length: 4 }, () => chars[Math.floor(Math.random() * chars.length)]).join('');
  } while (rooms[code]);
  return code;
}

function lobbyPayload(room) {
  return {
    players: room.players.map(({ id, name, score, alive }) => ({ id, name, score, alive })),
    game: room.game,
    turnIndex: room.turnIndex,
  };
}

function getLocalIp() {
  const nets = os.networkInterfaces();
  const candidates = [];
  for (const name of Object.keys(nets)) {
    // Skip virtual adapters (Docker, Hyper-V, VPNs, VirtualBox) that show up
    // alongside the real WiFi/Ethernet adapter but aren't reachable from a phone.
    if (/virtualbox|vmware|hyper-v|v?ethernet|docker|wsl|tailscale|loopback/i.test(name)) continue;
    for (const net of nets[name]) {
      if (net.family === 'IPv4' && !net.internal) candidates.push({ name, address: net.address });
    }
  }
  // Prefer common home/office LAN ranges.
  const home = candidates.find((c) => /^(192\.168\.|10\.)/.test(c.address));
  return (home || candidates[0] || { address: 'localhost' }).address;
}

app.get('/api/ip', (req, res) => {
  res.json({ ip: getLocalIp(), port: server.address() ? server.address().port : PORT });
});

io.on('connection', (socket) => {
  socket.data.role = null;
  socket.data.roomCode = null;

  socket.on('host:create', (_payload, ack) => {
    const code = makeRoomCode();
    rooms[code] = { hostSocketId: socket.id, game: null, players: [], turnIndex: 0 };
    socket.data.role = 'host';
    socket.data.roomCode = code;
    socket.join(code);
    ack && ack({ ok: true, code });
  });

  socket.on('player:join', ({ code, name }, ack) => {
    code = (code || '').toUpperCase().trim();
    const room = rooms[code];
    if (!room) {
      ack && ack({ ok: false, error: 'Room not found. Check the code.' });
      return;
    }
    const player = { id: socket.id, name: (name || 'Player').slice(0, 16), score: 0, alive: true };
    room.players.push(player);
    socket.data.role = 'player';
    socket.data.roomCode = code;
    socket.join(code);

    ack && ack({ ok: true, code, playerId: socket.id, players: lobbyPayload(room).players });
    io.to(code).emit('lobby:update', lobbyPayload(room));
  });

  socket.on('host:startGame', ({ game }) => {
    const room = rooms[socket.data.roomCode];
    if (!room || socket.data.role !== 'host') return;
    room.game = game;
    room.turnIndex = 0;
    room.players.forEach((p) => { p.score = 0; p.alive = true; });
    io.to(socket.data.roomCode).emit('game:start', { game, players: lobbyPayload(room).players });
  });

  socket.on('host:backToLobby', () => {
    const room = rooms[socket.data.roomCode];
    if (!room || socket.data.role !== 'host') return;
    room.game = null;
    io.to(socket.data.roomCode).emit('lobby:update', lobbyPayload(room));
  });

  // --- Bowling: turn-based. Host owns the webcam + physics, phones just show whose turn it is
  // and let that player confirm readiness / see the shared scoreboard.
  socket.on('bowling:frameResult', ({ pinsKnocked, gutter }) => {
    const room = rooms[socket.data.roomCode];
    if (!room || socket.data.role !== 'host' || room.players.length === 0) return;
    const current = room.players[room.turnIndex % room.players.length];
    if (current) {
      current.score += gutter ? 0 : pinsKnocked;
    }
    room.turnIndex = (room.turnIndex + 1) % room.players.length;
    io.to(socket.data.roomCode).emit('bowling:update', {
      players: lobbyPayload(room).players,
      turnIndex: room.turnIndex,
      lastRoll: { playerId: current ? current.id : null, pinsKnocked, gutter: !!gutter },
    });
  });

  // --- Balance egg: fully webcam-driven now (host tracks every player's body
  // lean directly via multi-person pose detection), so phones only ever
  // receive status updates here — nothing streams tilt anymore.
  socket.on('balance:eliminated', ({ playerId, survivalMs }) => {
    const room = rooms[socket.data.roomCode];
    if (!room || socket.data.role !== 'host') return;
    const player = room.players.find((p) => p.id === playerId);
    if (player) {
      player.alive = false;
      player.score = survivalMs;
    }
    io.to(socket.data.roomCode).emit('balance:update', { players: lobbyPayload(room).players });
  });

  socket.on('disconnect', () => {
    const code = socket.data.roomCode;
    const room = rooms[code];
    if (!room) return;
    if (socket.data.role === 'host') {
      io.to(code).emit('host:disconnected');
      delete rooms[code];
    } else if (socket.data.role === 'player') {
      room.players = room.players.filter((p) => p.id !== socket.id);
      io.to(code).emit('lobby:update', lobbyPayload(room));
    }
  });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`wii-web running: http://localhost:${PORT}/host.html  (host screen)`);
  console.log(`Phones join at: http://${getLocalIp()}:${PORT}/controller.html`);
});
