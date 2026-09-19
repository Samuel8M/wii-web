const socket = io();

const screens = {
  join: document.getElementById('screen-join'),
  waiting: document.getElementById('screen-waiting'),
  bowling: document.getElementById('screen-bowling'),
  balance: document.getElementById('screen-balance'),
};
function showScreen(name) {
  Object.values(screens).forEach((s) => s.classList.remove('active'));
  screens[name].classList.add('active');
}

let myId = null;
let myCode = null;
let myName = null;

const params = new URLSearchParams(location.search);
if (params.get('code')) document.getElementById('code-input').value = params.get('code').toUpperCase();

document.getElementById('join-btn').onclick = () => {
  const name = document.getElementById('name-input').value.trim() || 'Player';
  const code = document.getElementById('code-input').value.trim().toUpperCase();
  if (!code) {
    document.getElementById('join-error').textContent = 'Enter a room code.';
    return;
  }
  socket.emit('player:join', { code, name }, (res) => {
    if (!res.ok) {
      document.getElementById('join-error').textContent = res.error;
      return;
    }
    myId = res.playerId;
    myCode = code;
    myName = name;
    showScreen('waiting');
  });
};

socket.on('lobby:update', () => {
  if (screens.waiting.classList.contains('active')) {
    // still waiting, nothing else to do
  }
});

socket.on('game:start', ({ game }) => {
  stopTiltStream();
  if (game === 'bowling') showScreen('bowling');
  if (game === 'balance') { showScreen('balance'); resetBalanceUI(); }
});

function stopTiltStream() {
  if (tiltHandler) { window.removeEventListener('deviceorientation', tiltHandler); tiltHandler = null; }
  if (tiltInterval) { clearInterval(tiltInterval); tiltInterval = null; }
  if (sensorCheckTimeout) { clearTimeout(sensorCheckTimeout); sensorCheckTimeout = null; }
}

socket.on('host:disconnected', () => {
  alert('The host screen disconnected. Rejoin once it restarts.');
  showScreen('join');
});

/* Bowling controller: just shows whose turn it is + live scores. */
socket.on('bowling:update', ({ players, turnIndex }) => {
  const pill = document.getElementById('bowling-turn-pill');
  const current = players[turnIndex % players.length];
  if (current && current.id === myId) {
    pill.textContent = "🎳 YOUR TURN — swing at the camera!";
    pill.className = 'status-pill you';
    if (navigator.vibrate) navigator.vibrate(200);
  } else {
    pill.textContent = `Waiting: ${current ? current.name : '...'}'s turn`;
    pill.className = 'status-pill wait';
  }
  const scores = document.getElementById('bowling-scores');
  scores.innerHTML = '';
  players
    .slice()
    .sort((a, b) => b.score - a.score)
    .forEach((p) => {
      const row = document.createElement('div');
      row.className = 'player-chip';
      row.style.margin = '6px';
      row.textContent = `${p.name}: ${p.score}`;
      scores.appendChild(row);
    });
});

/* Balance controller: stream device tilt at ~20Hz, with a manual drag
   fallback for devices/browsers with no usable orientation sensor
   (most laptops, and some desktop browsers that fire the event with
   beta/gamma stuck at null). */
let tiltHandler = null;
let tiltInterval = null;
let sensorCheckTimeout = null;
let latestTilt = { beta: 0, gamma: 0 };
let eliminated = false;
let realSensorSeen = false;
let manualMode = false;
let manualGamma = 0;

function resetBalanceUI() {
  eliminated = false;
  realSensorSeen = false;
  manualMode = false;
  manualGamma = 0;
  document.getElementById('enable-tilt-btn').style.display = 'inline-block';
  document.getElementById('tilt-indicator').style.display = 'none';
  document.getElementById('balance-status-pill').style.display = 'none';
  document.getElementById('no-sensor-msg').style.display = 'none';
  document.getElementById('balance-hint').style.display = 'block';
}

document.getElementById('enable-tilt-btn').onclick = async () => {
  if (typeof DeviceOrientationEvent !== 'undefined' && typeof DeviceOrientationEvent.requestPermission === 'function') {
    try {
      const perm = await DeviceOrientationEvent.requestPermission();
      if (perm !== 'granted') {
        alert("Motion permission denied — falling back to manual drag control.");
      }
    } catch (e) {
      console.warn('Motion permission request failed, falling back to manual drag:', e);
    }
  }
  startTiltStream();
};

function startTiltStream() {
  document.getElementById('enable-tilt-btn').style.display = 'none';
  document.getElementById('tilt-indicator').style.display = 'block';
  const pill = document.getElementById('balance-status-pill');
  pill.style.display = 'inline-block';
  pill.textContent = 'Balancing…';
  pill.className = 'status-pill you';

  const dot = document.getElementById('tilt-dot');
  const indicator = document.getElementById('tilt-indicator');

  tiltHandler = (e) => {
    if (e.gamma === null || e.gamma === undefined) return; // no real sensor data
    realSensorSeen = true;
    if (manualMode) return; // user already took over manually, don't fight them
    latestTilt = { beta: e.beta || 0, gamma: e.gamma || 0 };
    const clampedGamma = Math.max(-45, Math.min(45, latestTilt.gamma));
    dot.style.transform = `translate(calc(-50% + ${clampedGamma * 2}px), -50%)`;
  };
  window.addEventListener('deviceorientation', tiltHandler);

  // If no real orientation data shows up shortly, switch to drag-to-tilt.
  sensorCheckTimeout = setTimeout(() => {
    if (!realSensorSeen) enableManualFallback();
  }, 1200);

  function enableManualFallback() {
    manualMode = true;
    document.getElementById('no-sensor-msg').style.display = 'block';
    document.getElementById('balance-hint').style.display = 'none';

    const setFromClientX = (clientX) => {
      const rect = indicator.getBoundingClientRect();
      const offset = clientX - (rect.left + rect.width / 2);
      manualGamma = Math.max(-45, Math.min(45, (offset / (rect.width / 2)) * 45));
      latestTilt = { beta: 0, gamma: manualGamma };
      dot.style.transform = `translate(calc(-50% + ${manualGamma * 2}px), -50%)`;
    };

    let dragging = false;
    indicator.style.cursor = 'grab';
    indicator.addEventListener('pointerdown', (e) => { dragging = true; indicator.setPointerCapture(e.pointerId); setFromClientX(e.clientX); });
    indicator.addEventListener('pointermove', (e) => { if (dragging) setFromClientX(e.clientX); });
    const stop = () => { dragging = false; };
    indicator.addEventListener('pointerup', stop);
    indicator.addEventListener('pointercancel', stop);
  }

  tiltInterval = setInterval(() => {
    if (eliminated) return;
    socket.emit('tilt:update', latestTilt);
  }, 50);
}

socket.on('balance:update', ({ players }) => {
  const me = players.find((p) => p.id === myId);
  if (me && me.alive === false && !eliminated) {
    eliminated = true;
    const pill = document.getElementById('balance-status-pill');
    pill.textContent = "You're OUT! Watch the big screen.";
    pill.className = 'status-pill out';
    if (navigator.vibrate) navigator.vibrate([100, 50, 100]);
  }
});
