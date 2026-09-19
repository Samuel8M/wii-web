const socket = io();

const screens = {
  lobby: document.getElementById('screen-lobby'),
  bowling: document.getElementById('screen-bowling'),
  balance: document.getElementById('screen-balance'),
};
function showScreen(name) {
  Object.values(screens).forEach((s) => s.classList.remove('active'));
  screens[name].classList.add('active');
}

let roomCode = null;
let players = [];

socket.emit('host:create', {}, async ({ code }) => {
  roomCode = code;
  document.getElementById('room-code').textContent = code;

  // Only localhost/127.0.0.1 is unreachable from a phone (it means "the phone
  // itself"). Any other origin — a LAN IP, or a public tunnel/deploy URL like
  // an ngrok/localtunnel/Render domain — is already the right address to share.
  let base = location.origin;
  if (['localhost', '127.0.0.1'].includes(location.hostname)) {
    try {
      const res = await fetch('/api/ip');
      const { ip, port } = await res.json();
      base = `http://${ip}:${port}`;
    } catch (e) {
      console.warn('Could not resolve LAN IP, falling back to location.origin', e);
    }
  }

  const url = `${base}/controller.html?code=${code}`;
  document.getElementById('join-url').textContent = url;
  // eslint-disable-next-line no-undef
  new QRCode(document.getElementById('qrcode'), { text: url, width: 220, height: 220 });
});

function renderPlayerList() {
  const list = document.getElementById('player-list');
  list.innerHTML = '';
  players.forEach((p) => {
    const chip = document.createElement('div');
    chip.className = 'player-chip' + (p.alive === false ? ' dead' : '');
    chip.textContent = p.name;
    list.appendChild(chip);
  });
  document.getElementById('start-bowling').disabled = players.length < 1;
  document.getElementById('start-balance').disabled = players.length < 1;
}

socket.on('lobby:update', (payload) => {
  players = payload.players;
  renderPlayerList();
});

document.getElementById('start-bowling').onclick = () => {
  socket.emit('host:startGame', { game: 'bowling' });
};
document.getElementById('start-balance').onclick = () => {
  socket.emit('host:startGame', { game: 'balance' });
};
document.getElementById('bowling-back').onclick = () => {
  stopBowling();
  socket.emit('host:backToLobby');
  showScreen('lobby');
};
document.getElementById('balance-back').onclick = () => {
  stopBalance();
  socket.emit('host:backToLobby');
  showScreen('lobby');
};

socket.on('game:start', ({ game, players: p }) => {
  players = p;
  if (game === 'bowling') { showScreen('bowling'); startBowling(); }
  if (game === 'balance') { showScreen('balance'); startBalance(); }
});

/* =========================================================
   BOWLING — MediaPipe Hands tracks a "swing" gesture from the
   webcam; a simple physics sim rolls a ball at 10 pins.
   ========================================================= */
let bowlingHands = null;
let bowlingCamera = null;
let bowlingRAF = null;
let bowlingActive = false;

const bCanvas = document.getElementById('bowling-canvas');
const bCtx = bCanvas.getContext('2d');
const bOverlay = document.getElementById('bowling-overlay');
const bOverlayCtx = bOverlay.getContext('2d');
const bVideo = document.getElementById('bowling-video');

const LANE = { w: 960, h: 600, ballR: 18, pinR: 12 };
const SWING_TRIGGER = 0.28; // px/ms of downward palm velocity needed to launch
let ball, pins, ballMoving, swingState, handHistory;
let cameraOk = false;
let cameraError = null;
let handDetected = false;
let lastSwingSpeed = 0;

function resetPins() {
  pins = [];
  const rows = [4, 3, 2, 1];
  let y = 90;
  rows.forEach((count) => {
    const rowWidth = (count - 1) * 40;
    for (let i = 0; i < count; i++) {
      pins.push({
        x: LANE.w / 2 - rowWidth / 2 + i * 40,
        y,
        knocked: false,
        origX: LANE.w / 2 - rowWidth / 2 + i * 40,
      });
    }
    y += 38;
  });
}
function resetBall() {
  ball = { x: LANE.w / 2, y: LANE.h - 60, vx: 0, vy: 0, moving: false };
}

function startBowling() {
  bowlingActive = true;
  resetPins();
  resetBall();
  swingState = 'idle'; // idle -> ready -> cooldown
  handHistory = [];
  updateTurnBanner();
  renderScoreboard();

  // eslint-disable-next-line no-undef
  bowlingHands = new Hands({
    locateFile: (file) => `https://cdn.jsdelivr.net/npm/@mediapipe/hands/${file}`,
  });
  bowlingHands.setOptions({
    maxNumHands: 1,
    modelComplexity: 0,
    minDetectionConfidence: 0.6,
    minTrackingConfidence: 0.5,
  });
  bowlingHands.onResults(onHandResults);

  // eslint-disable-next-line no-undef
  bowlingCamera = new Camera(bVideo, {
    onFrame: async () => {
      cameraOk = true;
      await bowlingHands.send({ image: bVideo });
    },
    width: 640,
    height: 480,
  });
  bowlingCamera.start().catch((err) => {
    cameraOk = false;
    cameraError = err && err.message ? err.message : String(err);
    console.error('Camera failed to start:', err);
  });

  bowlingRAF = requestAnimationFrame(bowlingLoop);
}

function stopBowling() {
  bowlingActive = false;
  if (bowlingCamera) { bowlingCamera.stop(); bowlingCamera = null; }
  if (bowlingRAF) { cancelAnimationFrame(bowlingRAF); bowlingRAF = null; }
  bowlingHands = null;
}

function onHandResults(results) {
  bOverlayCtx.save();
  bOverlayCtx.clearRect(0, 0, bOverlay.width, bOverlay.height);
  bOverlayCtx.translate(bOverlay.width, 0);
  bOverlayCtx.scale(-1, 1); // mirror so it feels natural

  if (results.multiHandLandmarks && results.multiHandLandmarks.length > 0) {
    handDetected = true;
    const lm = results.multiHandLandmarks[0];
    // eslint-disable-next-line no-undef
    drawConnectors(bOverlayCtx, lm, HAND_CONNECTIONS, { color: '#4fd1ff', lineWidth: 4 });
    // eslint-disable-next-line no-undef
    drawLandmarks(bOverlayCtx, lm, { color: '#ff5fa2', radius: 5 });

    const palm = lm[9]; // middle finger MCP ~ palm center
    const px = palm.x * bOverlay.width;
    const py = palm.y * bOverlay.height;
    const now = performance.now();
    handHistory.push({ x: px, y: py, t: now });
    if (handHistory.length > 4) handHistory.shift();

    evaluateSwing();
  } else {
    handDetected = false;
    handHistory = [];
  }
  bOverlayCtx.restore();
  drawDebugHud();
}

function evaluateSwing() {
  if (!bowlingActive || ballMoving || swingState === 'cooldown') return;
  if (handHistory.length < 2) return;
  // Frame-to-frame velocity is far more responsive to a real swing than a
  // windowed average, which gets swamped by tracking jitter when the hand
  // is held roughly still.
  const prev = handHistory[handHistory.length - 2];
  const cur = handHistory[handHistory.length - 1];
  const dt = cur.t - prev.t;
  if (dt <= 0) return;
  const vy = (cur.y - prev.y) / dt; // px/ms, positive = moving down (post-mirror)
  const vx = (cur.x - prev.x) / dt;
  lastSwingSpeed = vy;

  if (vy > SWING_TRIGGER) {
    launchBall(vx, vy);
    swingState = 'cooldown';
    setTimeout(() => { swingState = 'idle'; }, 1200);
  }
}

function launchBall(vx, vy) {
  const power = Math.min(Math.max(vy * 24, 9), 24);
  const curve = Math.max(Math.min(vx * 14, 8), -8);
  ball.vx = curve;
  ball.vy = -power;
  ball.moving = true;
  ballMoving = true;
}

function drawDebugHud() {
  const ctx = bOverlayCtx;
  ctx.save();
  ctx.font = '16px monospace';
  ctx.textAlign = 'left';
  const lines = [
    cameraOk ? 'camera: ok' : `camera: ${cameraError ? 'ERROR - ' + cameraError : 'starting...'}`,
    `hand: ${handDetected ? 'detected' : 'not detected - step into frame'}`,
    `swing speed: ${lastSwingSpeed.toFixed(2)} (trigger @ ${SWING_TRIGGER})`,
  ];
  lines.forEach((line, i) => {
    const y = 22 + i * 20;
    ctx.fillStyle = 'rgba(0,0,0,0.55)';
    ctx.fillRect(6, y - 16, ctx.measureText(line).width + 12, 22);
    ctx.fillStyle = i === 0 && !cameraOk ? '#ff5f5f' : '#4fd1ff';
    ctx.fillText(line, 12, y);
  });
  ctx.restore();
}

function bowlingLoop() {
  if (!bowlingActive) return;
  step();
  draw();
  if (!handDetected) drawDebugHud(); // keep status visible even if MediaPipe never calls back
  bowlingRAF = requestAnimationFrame(bowlingLoop);
}

function step() {
  if (!ball.moving) return;
  ball.x += ball.vx;
  ball.y += ball.vy;
  if (ball.x < LANE.ballR || ball.x > LANE.w - LANE.ballR) {
    finishRoll(true);
    return;
  }
  for (const pin of pins) {
    if (pin.knocked) continue;
    const d = Math.hypot(ball.x - pin.x, ball.y - pin.y);
    if (d < LANE.ballR + LANE.pinR) {
      pin.knocked = true;
      pin.x += ball.vx * 3;
      pin.y += ball.vy * 0.5;
    }
  }
  if (ball.y < 40) finishRoll(false);
}

function finishRoll(gutter) {
  ball.moving = false;
  ballMoving = false;
  const pinsKnocked = gutter ? 0 : pins.filter((p) => p.knocked).length;
  socket.emit('bowling:frameResult', { pinsKnocked, gutter });
  setTimeout(() => {
    resetPins();
    resetBall();
    swingState = 'idle';
    handHistory = [];
  }, 1400);
}

function draw() {
  bCtx.clearRect(0, 0, LANE.w, LANE.h);
  bCtx.fillStyle = '#3a2a1a';
  bCtx.fillRect(0, 0, LANE.w, LANE.h);
  bCtx.fillStyle = '#5c4327';
  bCtx.fillRect(60, 20, LANE.w - 120, LANE.h - 40);
  // pins
  pins.forEach((p) => {
    if (p.knocked) return;
    bCtx.beginPath();
    bCtx.arc(p.x, p.y, LANE.pinR, 0, Math.PI * 2);
    bCtx.fillStyle = '#fff';
    bCtx.fill();
    bCtx.strokeStyle = '#ff5fa2';
    bCtx.lineWidth = 2;
    bCtx.stroke();
  });
  // ball
  bCtx.beginPath();
  bCtx.arc(ball.x, ball.y, LANE.ballR, 0, Math.PI * 2);
  bCtx.fillStyle = '#4fd1ff';
  bCtx.fill();
}

function updateTurnBanner() {
  const el = document.getElementById('bowling-turn');
  if (!players.length) { el.textContent = 'Waiting for players…'; return; }
  el.textContent = `${players[0].name}'s turn — swing your hand!`;
}
function renderScoreboard() {
  const el = document.getElementById('bowling-scoreboard');
  el.innerHTML = '';
  players.forEach((p) => {
    const chip = document.createElement('div');
    chip.className = 'player-chip';
    chip.textContent = `${p.name}: ${p.score}`;
    el.appendChild(chip);
  });
}

socket.on('bowling:update', ({ players: p, turnIndex }) => {
  players = p;
  renderScoreboard();
  const el = document.getElementById('bowling-turn');
  if (players.length) {
    el.textContent = `${players[turnIndex % players.length].name}'s turn — swing your hand!`;
  }
});

/* =========================================================
   BALANCE EGG — one lane per phone, tilt (gamma) sets beam
   angle, egg slides via simple physics, falls off = eliminated.
   ========================================================= */
let balanceActive = false;
let balanceRAF = null;
let balancePlayers = new Map(); // id -> { name, angle, pos, vel, alive, startTime, canvas, ctx }

const LANE_W = 160, LANE_H = 420, BEAM_LEN = 130;
// Beginner-friendly physics: gentle pull, strong damping, small tilts ignored,
// input smoothed so phone jitter doesn't snap the beam around, and a bit of
// extra room past the ends of the beam before the egg actually falls.
const GRAVITY = 0.00035;
const FRICTION = 0.93;
const TILT_DEADZONE = 5; // degrees of tilt that count as "flat"
const TILT_MAX = 30; // degrees for full effect (was effectively 45)
const TILT_SMOOTHING = 0.12; // 0..1, lower = lazier/more forgiving response
const FALL_THRESHOLD = 1.2; // was 1 — egg can overhang the beam a bit before it's "off"

function startBalance() {
  balanceActive = true;
  balancePlayers = new Map();
  const container = document.getElementById('balance-lanes');
  container.innerHTML = '';
  players.forEach((p) => {
    const wrap = document.createElement('div');
    wrap.className = 'lane';
    const canvas = document.createElement('canvas');
    canvas.width = LANE_W; canvas.height = LANE_H;
    wrap.appendChild(canvas);
    const nameEl = document.createElement('div');
    nameEl.className = 'lane-name'; nameEl.textContent = p.name;
    wrap.appendChild(nameEl);
    const timeEl = document.createElement('div');
    timeEl.className = 'lane-time'; timeEl.textContent = '0.0s';
    wrap.appendChild(timeEl);
    container.appendChild(wrap);
    balancePlayers.set(p.id, {
      name: p.name, angle: 0, targetAngle: 0, pos: 0, vel: 0, alive: true,
      startTime: performance.now(), canvas, ctx: canvas.getContext('2d'), timeEl,
    });
  });
  document.getElementById('balance-status').textContent = 'Tilt your phone to keep the egg on the beam!';
  balanceRAF = requestAnimationFrame(balanceLoop);
}

function stopBalance() {
  balanceActive = false;
  if (balanceRAF) { cancelAnimationFrame(balanceRAF); balanceRAF = null; }
}

socket.on('tilt:update', ({ playerId, gamma }) => {
  const st = balancePlayers.get(playerId);
  if (!st || !st.alive) return;
  let g = gamma || 0;
  if (Math.abs(g) < TILT_DEADZONE) g = 0;
  else g -= Math.sign(g) * TILT_DEADZONE; // smooth entry past the deadzone instead of a hard jump
  st.targetAngle = Math.max(-TILT_MAX, Math.min(TILT_MAX, g));
});

function balanceLoop() {
  if (!balanceActive) return;
  let aliveCount = 0;
  balancePlayers.forEach((st, id) => {
    if (!st.alive) return;
    aliveCount++;
    st.angle += (st.targetAngle - st.angle) * TILT_SMOOTHING;
    const rad = (st.angle * Math.PI) / 180;
    st.vel += Math.sin(rad) * GRAVITY * 16;
    st.vel *= FRICTION;
    st.pos += st.vel * 16;
    st.timeEl.textContent = ((performance.now() - st.startTime) / 1000).toFixed(1) + 's';
    if (Math.abs(st.pos) > FALL_THRESHOLD) {
      st.alive = false;
      const survivalMs = performance.now() - st.startTime;
      socket.emit('balance:eliminated', { playerId: id, survivalMs });
    }
    drawLane(st);
  });
  if (aliveCount <= (balancePlayers.size > 1 ? 1 : 0) && balancePlayers.size > 0) {
    endBalanceIfDone();
  }
  balanceRAF = requestAnimationFrame(balanceLoop);
}

function drawLane(st) {
  const ctx = st.ctx;
  ctx.clearRect(0, 0, LANE_W, LANE_H);
  ctx.fillStyle = '#141a2e';
  ctx.fillRect(0, 0, LANE_W, LANE_H);
  const cx = LANE_W / 2, cy = LANE_H / 2;
  const rad = (st.angle * Math.PI) / 180;
  ctx.save();
  ctx.translate(cx, cy);
  ctx.rotate(rad);
  ctx.strokeStyle = st.alive ? '#4fd1ff' : '#ff5f5f';
  ctx.lineWidth = 8;
  ctx.beginPath();
  ctx.moveTo(-BEAM_LEN / 2, 0);
  ctx.lineTo(BEAM_LEN / 2, 0);
  ctx.stroke();
  if (st.alive) {
    const eggX = st.pos * (BEAM_LEN / 2);
    ctx.translate(eggX, -16);
    ctx.rotate(-rad);
    ctx.fillStyle = '#fff7e0';
    ctx.beginPath();
    ctx.ellipse(0, 0, 12, 16, 0, 0, Math.PI * 2);
    ctx.fill();
  }
  ctx.restore();
  if (!st.alive) {
    ctx.fillStyle = '#ff5f5f';
    ctx.font = 'bold 20px sans-serif';
    ctx.textAlign = 'center';
    ctx.fillText('OUT', cx, cy);
  }
}

let balanceEnded = false;
function endBalanceIfDone() {
  if (balanceEnded) return;
  balanceEnded = true;
  balanceActive = false;
  const ranking = Array.from(balancePlayers.entries())
    .map(([id, st]) => ({ id, name: st.name, ms: st.alive ? performance.now() - st.startTime : null }))
    .sort((a, b) => (b.ms ?? 999999) - (a.ms ?? 999999));
  document.getElementById('balance-status').textContent =
    `🏆 ${ranking[0]?.name || '?'} wins! Balanced the longest.`;
}

document.getElementById('start-bowling').addEventListener('click', () => { balanceEnded = false; });
document.getElementById('start-balance').addEventListener('click', () => { balanceEnded = false; });

socket.on('host:disconnected', () => {
  alert('Lost connection.');
});
