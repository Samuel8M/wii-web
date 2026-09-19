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
  if (game === 'bowling') { showScreen('bowling'); resizeBowlingCanvas(); startBowling(); }
  if (game === 'balance') { showScreen('balance'); resizeBalanceCanvas(); startBalance(); }
});

window.addEventListener('resize', () => {
  if (bowlingActive) resizeBowlingCanvas();
  if (balanceActive) resizeBalanceCanvas();
});

function mapRange(v, inMin, inMax, outMin, outMax) {
  const t = Math.max(0, Math.min(1, (v - inMin) / (inMax - inMin)));
  return outMin + t * (outMax - outMin);
}

/* =========================================================
   BOWLING — full-body pose tracking (MediaPipe Pose) reads a real
   arm-swing motion from the webcam; a 3D scene (Three.js) rolls the
   ball down a lane at 10 pins, camera gliding along behind it.
   ========================================================= */
let bowlingPose = null;
let bowlingCamera = null;
let bowlingRAF = null;
let bowlingActive = false;
let bLastTime = null;

const bVideo = document.getElementById('bowling-video');
const b3dCanvas = document.getElementById('bowling-3d');
const bOverlay = document.getElementById('bowling-overlay');
const bOverlayCtx = bOverlay.getContext('2d');

const SWING_TRIGGER = 0.28; // px/ms of downward wrist velocity needed to launch
const LANE_HALF_WIDTH = 1.4;
const LANE_LENGTH = 20;
const PIN_APEX_Z = -15;
const PIN_ROW_SPACING = 0.62;
const PIN_LATERAL_SPACING = 0.58;
const BALL_RADIUS = 0.13;
const PIN_RADIUS = 0.11;
const PIN_FALL_DURATION = 0.7; // seconds
const CAMERA_HOME_Z = 2.4;

let bScene, bCamera, bRenderer, bBallMesh;
let pins = [];
let ball;
let swingState = 'idle'; // idle -> cooldown
let wristHistory = { left: [], right: [] };
let cameraOk = false;
let cameraError = null;
let poseDetected = false;
let lastSwingSpeed = 0;

function ensureBowlingScene() {
  if (bScene) return;
  bRenderer = new THREE.WebGLRenderer({ canvas: b3dCanvas, antialias: true });
  bRenderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));

  bScene = new THREE.Scene();
  bScene.background = new THREE.Color(0x0b0e1a);
  bScene.fog = new THREE.Fog(0x0b0e1a, 8, 22);

  bCamera = new THREE.PerspectiveCamera(55, 16 / 9, 0.1, 100);
  bCamera.position.set(0, 1.1, CAMERA_HOME_Z);
  bCamera.lookAt(0, 0.3, -10);

  const hemi = new THREE.HemisphereLight(0xbfe3ff, 0x3a2a1a, 0.9);
  bScene.add(hemi);
  const dir = new THREE.DirectionalLight(0xffffff, 0.8);
  dir.position.set(3, 6, 2);
  bScene.add(dir);

  const laneGeo = new THREE.BoxGeometry(LANE_HALF_WIDTH * 2, 0.08, LANE_LENGTH);
  const laneMat = new THREE.MeshStandardMaterial({ color: 0x8a5a2b, roughness: 0.6 });
  const lane = new THREE.Mesh(laneGeo, laneMat);
  lane.position.set(0, -0.08, -LANE_LENGTH / 2 + 1);
  bScene.add(lane);

  const gutterGeo = new THREE.BoxGeometry(0.18, 0.1, LANE_LENGTH);
  const gutterMat = new THREE.MeshStandardMaterial({ color: 0x1c2438 });
  [-1, 1].forEach((side) => {
    const g = new THREE.Mesh(gutterGeo, gutterMat);
    g.position.set(side * (LANE_HALF_WIDTH + 0.13), -0.06, -LANE_LENGTH / 2 + 1);
    bScene.add(g);
  });

  const backdropGeo = new THREE.PlaneGeometry(10, 5);
  const backdropMat = new THREE.MeshStandardMaterial({ color: 0x141a2e });
  const backdrop = new THREE.Mesh(backdropGeo, backdropMat);
  backdrop.position.set(0, 2, -LANE_LENGTH + 1);
  bScene.add(backdrop);

  const ballGeo = new THREE.SphereGeometry(BALL_RADIUS, 20, 20);
  const ballMat = new THREE.MeshStandardMaterial({ color: 0x4fd1ff, roughness: 0.3, metalness: 0.2 });
  bBallMesh = new THREE.Mesh(ballGeo, ballMat);
  bScene.add(bBallMesh);

  const pinGeo = new THREE.CylinderGeometry(0.045, PIN_RADIUS, 0.38, 10);
  pinGeo.translate(0, 0.19, 0);
  pins = [];
  const rows = [1, 2, 3, 4];
  let z = PIN_APEX_Z;
  rows.forEach((count) => {
    const rowWidth = (count - 1) * PIN_LATERAL_SPACING;
    for (let i = 0; i < count; i++) {
      const x = -rowWidth / 2 + i * PIN_LATERAL_SPACING;
      const mat = new THREE.MeshStandardMaterial({ color: 0xffffff });
      const mesh = new THREE.Mesh(pinGeo, mat);
      mesh.position.set(x, 0, z);
      bScene.add(mesh);
      pins.push({ x, z, baseX: x, baseZ: z, knocked: false, fallProgress: 1, mesh });
    }
    z -= PIN_ROW_SPACING;
  });

  ball = { x: 0, z: 0, vx: 0, vz: 0, curveAccel: 0, moving: false };
}

function resizeBowlingCanvas() {
  const wrap = document.getElementById('bowling-wrap');
  const w = Math.max(wrap.clientWidth, 2);
  const h = Math.max(wrap.clientHeight, 2);
  bOverlay.width = w;
  bOverlay.height = h;
  if (bRenderer) {
    bRenderer.setSize(w, h, false);
    bCamera.aspect = w / h;
    bCamera.updateProjectionMatrix();
  }
}

function resetPins3D() {
  pins.forEach((p) => {
    p.knocked = false;
    p.fallProgress = 1;
    p.x = p.baseX;
    p.z = p.baseZ;
    p.mesh.position.set(p.baseX, 0, p.baseZ);
    p.mesh.rotation.set(0, 0, 0);
    p.mesh.visible = true;
  });
}
function resetBall3D() {
  ball.x = 0; ball.z = 0; ball.vx = 0; ball.vz = 0; ball.curveAccel = 0; ball.moving = false;
  bBallMesh.position.set(0, BALL_RADIUS, 0);
  bBallMesh.rotation.set(0, 0, 0);
}

function startBowling() {
  bowlingActive = true;
  swingState = 'idle';
  wristHistory = { left: [], right: [] };
  bLastTime = null;
  ensureBowlingScene();
  resizeBowlingCanvas();
  resetPins3D();
  resetBall3D();
  updateTurnBanner();
  renderScoreboard();

  // eslint-disable-next-line no-undef
  bowlingPose = new Pose({
    locateFile: (file) => `https://cdn.jsdelivr.net/npm/@mediapipe/pose/${file}`,
  });
  bowlingPose.setOptions({
    modelComplexity: 0,
    smoothLandmarks: true,
    minDetectionConfidence: 0.6,
    minTrackingConfidence: 0.5,
  });
  bowlingPose.onResults(onPoseResults);

  // eslint-disable-next-line no-undef
  bowlingCamera = new Camera(bVideo, {
    onFrame: async () => {
      cameraOk = true;
      await bowlingPose.send({ image: bVideo });
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
  bowlingPose = null;
}

function onPoseResults(results) {
  bOverlayCtx.save();
  bOverlayCtx.clearRect(0, 0, bOverlay.width, bOverlay.height);
  bOverlayCtx.translate(bOverlay.width, 0);
  bOverlayCtx.scale(-1, 1); // mirror so it feels natural

  if (results.poseLandmarks) {
    poseDetected = true;
    const lm = results.poseLandmarks;
    // eslint-disable-next-line no-undef
    drawConnectors(bOverlayCtx, lm, POSE_CONNECTIONS, { color: '#4fd1ff', lineWidth: 3 });
    // eslint-disable-next-line no-undef
    drawLandmarks(bOverlayCtx, lm, { color: '#ff5fa2', radius: 3 });

    const now = performance.now();
    pushWrist('left', lm[15], now);
    pushWrist('right', lm[16], now);
    evaluateSwing();
  } else {
    poseDetected = false;
    wristHistory.left = [];
    wristHistory.right = [];
  }
  bOverlayCtx.restore();
  drawDebugHud();
}

function pushWrist(side, lm, now) {
  if (!lm || (lm.visibility !== undefined && lm.visibility < 0.4)) return;
  const px = lm.x * bOverlay.width;
  const py = lm.y * bOverlay.height;
  const hist = wristHistory[side];
  hist.push({ x: px, y: py, t: now });
  if (hist.length > 4) hist.shift();
}

function evaluateSwing() {
  if (!bowlingActive || ball.moving || swingState === 'cooldown') return;
  const candidates = [];
  ['left', 'right'].forEach((side) => {
    const hist = wristHistory[side];
    if (hist.length < 2) return;
    const prev = hist[hist.length - 2];
    const cur = hist[hist.length - 1];
    const dt = cur.t - prev.t;
    if (dt <= 0) return;
    candidates.push({ vx: (cur.x - prev.x) / dt, vy: (cur.y - prev.y) / dt });
  });
  if (!candidates.length) return;
  const best = candidates.reduce((a, b) => (b.vy > a.vy ? b : a));
  lastSwingSpeed = best.vy;

  if (best.vy > SWING_TRIGGER) {
    launchBall(best.vx, best.vy);
    swingState = 'cooldown';
    setTimeout(() => { swingState = 'idle'; }, 1200);
  }
}

function launchBall(vx, vy) {
  ball.vz = mapRange(vy, SWING_TRIGGER, 1.0, 8, 16);
  ball.curveAccel = mapRange(Math.abs(vx), 0, 0.6, 0, 3) * Math.sign(vx);
  ball.vx = 0;
  ball.moving = true;
}

function knockPin(p, nx, nz) {
  if (p.knocked) return;
  p.knocked = true;
  p.fallProgress = 0;
  p.fallDirX = nx;
  p.fallDirZ = nz;
  pins.forEach((other) => {
    if (other === p || other.knocked) return;
    const dist = Math.hypot(other.x - p.x, other.z - p.z);
    if (dist < PIN_RADIUS * 2.6) {
      knockPin(other, (other.x - p.x) / (dist || 1), (other.z - p.z) / (dist || 1));
    }
  });
}

function updateFallingPins(dt) {
  pins.forEach((p) => {
    if (!p.knocked || p.fallProgress >= 1) return;
    p.fallProgress = Math.min(1, p.fallProgress + dt / PIN_FALL_DURATION);
    const axis = new THREE.Vector3(-(p.fallDirZ || 0), 0, p.fallDirX || 1).normalize();
    p.mesh.setRotationFromAxisAngle(axis, p.fallProgress * 1.4);
    p.mesh.position.y = -p.fallProgress * 0.08;
    if (p.fallProgress >= 1) p.mesh.visible = false;
  });
}

function step3D(dt) {
  if (!ball.moving) { updateFallingPins(dt); return; }
  ball.vx += (ball.curveAccel || 0) * dt;
  ball.z -= ball.vz * dt;
  ball.x += ball.vx * dt;
  ball.vz -= ball.vz * 0.15 * dt;

  bBallMesh.position.set(ball.x, BALL_RADIUS, ball.z);
  bBallMesh.rotation.x -= (ball.vz * dt) / BALL_RADIUS;

  if (Math.abs(ball.x) > LANE_HALF_WIDTH - BALL_RADIUS) { finishRoll(true); return; }

  pins.forEach((p) => {
    if (p.knocked) return;
    const dist = Math.hypot(ball.x - p.x, ball.z - p.z);
    if (dist < BALL_RADIUS + PIN_RADIUS) {
      knockPin(p, (p.x - ball.x) / (dist || 1), (p.z - ball.z) / (dist || 1));
    }
  });
  updateFallingPins(dt);

  if (ball.z < PIN_APEX_Z - 2.5 || ball.vz < 0.4) finishRoll(false);
}

function finishRoll(gutter) {
  ball.moving = false;
  const pinsKnocked = gutter ? 0 : pins.filter((p) => p.knocked).length;
  socket.emit('bowling:frameResult', { pinsKnocked, gutter });
  setTimeout(() => {
    resetPins3D();
    resetBall3D();
    swingState = 'idle';
    wristHistory.left = [];
    wristHistory.right = [];
  }, 1600);
}

function updateCameraDolly() {
  const targetZ = ball.moving ? Math.max(ball.z + 2.2, -12) : CAMERA_HOME_Z;
  bCamera.position.z += (targetZ - bCamera.position.z) * 0.04;
  const lookZ = ball.moving ? ball.z - 3 : -10;
  bCamera.lookAt(0, 0.3, lookZ);
}

function drawDebugHud() {
  const ctx = bOverlayCtx;
  ctx.save();
  ctx.font = '16px monospace';
  ctx.textAlign = 'left';
  const lines = [
    cameraOk ? 'camera: ok' : `camera: ${cameraError ? 'ERROR - ' + cameraError : 'starting...'}`,
    `pose: ${poseDetected ? 'detected' : 'not detected - step into frame'}`,
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

function bowlingLoop(now) {
  if (!bowlingActive) return;
  const dt = bLastTime ? Math.min((now - bLastTime) / 1000, 0.05) : 0.016;
  bLastTime = now;
  step3D(dt);
  updateCameraDolly();
  bRenderer.render(bScene, bCamera);
  if (!poseDetected) drawDebugHud(); // keep status visible even if MediaPipe never calls back
  bowlingRAF = requestAnimationFrame(bowlingLoop);
}

function updateTurnBanner() {
  const el = document.getElementById('bowling-turn');
  if (!players.length) { el.textContent = 'Waiting for players…'; return; }
  el.textContent = `${players[0].name}'s turn — step up and swing!`;
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
    el.textContent = `${players[turnIndex % players.length].name}'s turn — step up and swing!`;
  }
});

/* =========================================================
   BALANCE EGG — fully human-powered. Everyone stands in front of
   the same webcam at once; TensorFlow.js MoveNet MultiPose tracks
   each person's body independently and their torso lean (shoulders
   relative to hips) drives their own egg on a shared beam overlay.
   ========================================================= */
let balanceActive = false;
let balanceRAF = null;
let balanceLastTime = null;
let balanceDetector = null;
let balanceBusy = false;
let balanceCameraOk = false;
let balanceCameraError = null;
let posesDetectedCount = 0;
let balanceLanes = []; // [{ id, name, angle, targetAngle, pos, vel, alive, startTime, screenX }]
let balanceEnded = false;

const balanceVideo = document.getElementById('balance-video');
const bal3dCanvas = document.getElementById('balance-3d');
const bal3dCtx = bal3dCanvas.getContext('2d');
const balOverlay = document.getElementById('balance-overlay');
const balOverlayCtx = balOverlay.getContext('2d');

const BODY_TILT_DEADZONE = 4; // degrees of torso lean that count as "upright"
const BODY_TILT_MAX = 18; // degrees for full effect — real bodies can't lean as far as a phone can tilt
const BODY_TILT_SMOOTHING = 0.18;
const GRAVITY_ACCEL = 0.9; // units/sec^2
const DAMPING = 3.2; // per-second velocity damping
const FALL_THRESHOLD = 1.2;

const COCO_PAIRS = [
  ['left_shoulder', 'right_shoulder'], ['left_shoulder', 'left_elbow'], ['left_elbow', 'left_wrist'],
  ['right_shoulder', 'right_elbow'], ['right_elbow', 'right_wrist'], ['left_shoulder', 'left_hip'],
  ['right_shoulder', 'right_hip'], ['left_hip', 'right_hip'], ['left_hip', 'left_knee'],
  ['left_knee', 'left_ankle'], ['right_hip', 'right_knee'], ['right_knee', 'right_ankle'],
];

function resizeBalanceCanvas() {
  const wrap = document.getElementById('balance-wrap');
  const w = Math.max(wrap.clientWidth, 2);
  const h = Math.max(wrap.clientHeight, 2);
  bal3dCanvas.width = w; bal3dCanvas.height = h;
  balOverlay.width = w; balOverlay.height = h;
}

async function ensureBalanceDetector() {
  if (balanceDetector) return balanceDetector;
  await tf.setBackend('webgl');
  await tf.ready();
  // eslint-disable-next-line no-undef
  balanceDetector = await poseDetection.createDetector(poseDetection.SupportedModels.MoveNet, {
    modelType: poseDetection.movenet.modelType.MULTIPOSE_LIGHTNING,
    enableTracking: true,
    trackerType: poseDetection.TrackerType.BoundingBox,
  });
  return balanceDetector;
}

async function startBalance() {
  balanceActive = true;
  balanceEnded = false;
  balanceLastTime = null;
  balanceCameraOk = false;
  balanceCameraError = null;
  resizeBalanceCanvas();
  balanceLanes = players.map((p) => ({
    id: p.id, name: p.name, angle: 0, targetAngle: 0, pos: 0, vel: 0, alive: true,
    startTime: performance.now(), screenX: null,
  }));
  document.getElementById('balance-status').textContent = 'Stand left-to-right, lean your whole body to balance your egg!';

  try {
    const stream = await navigator.mediaDevices.getUserMedia({ video: { width: 640, height: 480 } });
    balanceVideo.srcObject = stream;
    await balanceVideo.play();
    balanceCameraOk = true;
  } catch (err) {
    balanceCameraOk = false;
    balanceCameraError = err && err.message ? err.message : String(err);
    console.error('Balance camera failed:', err);
  }

  try {
    await ensureBalanceDetector();
  } catch (err) {
    console.error('Could not load pose detector:', err);
  }

  balanceRAF = requestAnimationFrame(balanceLoop);
}

function stopBalance() {
  balanceActive = false;
  if (balanceRAF) { cancelAnimationFrame(balanceRAF); balanceRAF = null; }
  if (balanceVideo.srcObject) {
    balanceVideo.srcObject.getTracks().forEach((t) => t.stop());
    balanceVideo.srcObject = null;
  }
}

function applyPosesToLanes(poses) {
  const validPoses = poses
    .filter((p) => p.score === undefined || p.score > 0.25)
    .map((p) => {
      const kp = {};
      p.keypoints.forEach((k) => { kp[k.name] = k; });
      return kp;
    })
    .filter((kp) => kp.left_shoulder && kp.right_shoulder && kp.left_hip && kp.right_hip);

  validPoses.sort((a, b) => (a.left_hip.x + a.right_hip.x) - (b.left_hip.x + b.right_hip.x));
  posesDetectedCount = validPoses.length;

  balanceLanes.forEach((lane, i) => {
    const kp = validPoses[i];
    if (!kp) { lane.screenX = null; return; }
    const midShoulderX = (kp.left_shoulder.x + kp.right_shoulder.x) / 2;
    const midShoulderY = (kp.left_shoulder.y + kp.right_shoulder.y) / 2;
    const midHipX = (kp.left_hip.x + kp.right_hip.x) / 2;
    const midHipY = (kp.left_hip.y + kp.right_hip.y) / 2;
    const dx = midShoulderX - midHipX;
    const dy = midShoulderY - midHipY; // image y grows downward
    const angleDeg = (Math.atan2(dx, -dy) * 180) / Math.PI;
    lane.screenX = balanceVideo.videoWidth ? balanceVideo.videoWidth - midHipX : null;
    lane.keypoints = kp;

    if (!lane.alive) return;
    let a = angleDeg;
    if (Math.abs(a) < BODY_TILT_DEADZONE) a = 0;
    else a -= Math.sign(a) * BODY_TILT_DEADZONE;
    lane.targetAngle = Math.max(-BODY_TILT_MAX, Math.min(BODY_TILT_MAX, a));
  });
}

function stepBalancePhysics(dt) {
  let aliveCount = 0;
  balanceLanes.forEach((lane) => {
    if (!lane.alive) return;
    aliveCount++;
    lane.angle += (lane.targetAngle - lane.angle) * Math.min(1, BODY_TILT_SMOOTHING * dt * 60);
    const rad = (lane.angle * Math.PI) / 180;
    lane.vel += Math.sin(rad) * GRAVITY_ACCEL * dt;
    lane.vel *= Math.max(0, 1 - DAMPING * dt);
    lane.pos += lane.vel * dt;
    if (Math.abs(lane.pos) > FALL_THRESHOLD) {
      lane.alive = false;
      const survivalMs = performance.now() - lane.startTime;
      socket.emit('balance:eliminated', { playerId: lane.id, survivalMs });
    }
  });
  if (balanceLanes.length > 0 && aliveCount <= (balanceLanes.length > 1 ? 1 : 0)) {
    endBalanceIfDone();
  }
}

function drawBalanceScene() {
  const w = bal3dCanvas.width, h = bal3dCanvas.height;
  bal3dCtx.clearRect(0, 0, w, h);
  bal3dCtx.fillStyle = '#0b0e1a';
  bal3dCtx.fillRect(0, 0, w, h);

  if (balanceCameraOk && balanceVideo.videoWidth) {
    bal3dCtx.save();
    bal3dCtx.translate(w, 0);
    bal3dCtx.scale(-1, 1);
    bal3dCtx.drawImage(balanceVideo, 0, 0, w, h);
    bal3dCtx.restore();
  }

  balOverlayCtx.clearRect(0, 0, balOverlay.width, balOverlay.height);
  if (balanceVideo.videoWidth) drawAllSkeletons();

  const beamY = h * 0.74;
  const beamHalfLen = w * 0.08;
  balanceLanes.forEach((lane, i) => {
    const cx = lane.screenX != null ? (lane.screenX / balanceVideo.videoWidth) * w : w * ((i + 1) / (balanceLanes.length + 1));
    drawBeam(cx, beamY, beamHalfLen, lane);
  });

  drawBalanceDebugHud();
}

function drawAllSkeletons() {
  balOverlayCtx.save();
  balOverlayCtx.strokeStyle = 'rgba(79,209,255,0.6)';
  balOverlayCtx.lineWidth = 2;
  const w = balOverlay.width, h = balOverlay.height, vw = balanceVideo.videoWidth, vh = balanceVideo.videoHeight;
  balanceLanes.forEach((lane) => {
    const kp = lane.keypoints;
    if (!kp) return;
    COCO_PAIRS.forEach(([a, b]) => {
      if (!kp[a] || !kp[b]) return;
      const ax = w - (kp[a].x / vw) * w, ay = (kp[a].y / vh) * h;
      const bx = w - (kp[b].x / vw) * w, by = (kp[b].y / vh) * h;
      balOverlayCtx.beginPath();
      balOverlayCtx.moveTo(ax, ay);
      balOverlayCtx.lineTo(bx, by);
      balOverlayCtx.stroke();
    });
  });
  balOverlayCtx.restore();
}

function drawBeam(cx, cy, halfLen, lane) {
  const ctx = bal3dCtx;
  ctx.save();
  ctx.translate(cx, cy);
  const rad = (lane.angle * Math.PI) / 180;
  ctx.rotate(rad);
  ctx.strokeStyle = lane.alive ? '#4fd1ff' : '#ff5f5f';
  ctx.lineWidth = 8;
  ctx.beginPath();
  ctx.moveTo(-halfLen, 0);
  ctx.lineTo(halfLen, 0);
  ctx.stroke();
  if (lane.alive) {
    const eggX = lane.pos * halfLen;
    ctx.translate(eggX, -halfLen * 0.16);
    ctx.rotate(-rad);
    ctx.fillStyle = '#fff7e0';
    ctx.beginPath();
    ctx.ellipse(0, 0, halfLen * 0.11, halfLen * 0.15, 0, 0, Math.PI * 2);
    ctx.fill();
  }
  ctx.restore();

  ctx.save();
  ctx.font = 'bold 16px sans-serif';
  ctx.textAlign = 'center';
  const nameLabel = `${lane.name}${lane.alive ? '' : ' — OUT'}`;
  ctx.fillStyle = 'rgba(0,0,0,0.55)';
  ctx.fillRect(cx - ctx.measureText(nameLabel).width / 2 - 8, cy - halfLen - 34, ctx.measureText(nameLabel).width + 16, 24);
  ctx.fillStyle = lane.alive ? '#4fd1ff' : '#ff5f5f';
  ctx.fillText(nameLabel, cx, cy - halfLen - 16);
  ctx.restore();
}

function drawBalanceDebugHud() {
  const ctx = balOverlayCtx;
  ctx.save();
  ctx.font = '16px monospace';
  ctx.textAlign = 'left';
  const lines = [
    balanceCameraOk ? 'camera: ok' : `camera: ${balanceCameraError ? 'ERROR - ' + balanceCameraError : 'starting...'}`,
    balanceDetector ? `bodies detected: ${posesDetectedCount} / ${balanceLanes.length} players` : 'pose model: loading...',
  ];
  lines.forEach((line, i) => {
    const y = 22 + i * 20;
    ctx.fillStyle = 'rgba(0,0,0,0.55)';
    ctx.fillRect(6, y - 16, ctx.measureText(line).width + 12, 22);
    ctx.fillStyle = i === 0 && !balanceCameraOk ? '#ff5f5f' : '#4fd1ff';
    ctx.fillText(line, 12, y);
  });
  ctx.restore();
}

function balanceLoop(now) {
  if (!balanceActive) return;
  const dt = balanceLastTime ? Math.min((now - balanceLastTime) / 1000, 0.05) : 0.016;
  balanceLastTime = now;

  if (!balanceBusy && balanceDetector && balanceVideo.readyState >= 2) {
    balanceBusy = true;
    balanceDetector.estimatePoses(balanceVideo)
      .then((poses) => { applyPosesToLanes(poses); balanceBusy = false; })
      .catch((e) => { console.error(e); balanceBusy = false; });
  }

  stepBalancePhysics(dt);
  drawBalanceScene();

  balanceRAF = requestAnimationFrame(balanceLoop);
}

socket.on('balance:update', ({ players: p }) => {
  players = p;
});

function endBalanceIfDone() {
  if (balanceEnded) return;
  balanceEnded = true;
  const ranking = balanceLanes
    .map((lane) => ({ name: lane.name, ms: lane.alive ? performance.now() - lane.startTime : null }))
    .sort((a, b) => (b.ms ?? 999999) - (a.ms ?? 999999));
  document.getElementById('balance-status').textContent =
    `🏆 ${ranking[0]?.name || '?'} wins! Balanced the longest.`;
}

socket.on('host:disconnected', () => {
  alert('Lost connection.');
});
