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

socket.on('host:disconnected', () => {
  alert('The host screen disconnected. Rejoin once it restarts.');
  showScreen('join');
});

/* Bowling controller: just shows whose turn it is + live scores.
   Gameplay itself is full-body, tracked by the host's webcam. */
socket.on('bowling:update', ({ players, turnIndex }) => {
  const pill = document.getElementById('bowling-turn-pill');
  const current = players[turnIndex % players.length];
  if (current && current.id === myId) {
    pill.textContent = "🎳 YOUR TURN — step up and swing!";
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

/* Balance-egg controller: no phone input at all — the host's webcam tracks
   everyone's body lean simultaneously. The phone just tells you which lane
   (left-to-right standing position) you are and shows live status. */
let eliminated = false;

socket.on('game:start', ({ game, players }) => {
  if (game === 'bowling') showScreen('bowling');
  if (game === 'balance') {
    showScreen('balance');
    eliminated = false;
    const laneIndex = players.findIndex((p) => p.id === myId);
    document.getElementById('balance-lane-pill').textContent =
      laneIndex >= 0 ? `You're Lane ${laneIndex + 1}` : 'You';
    const statusPill = document.getElementById('balance-status-pill');
    statusPill.style.display = 'inline-block';
    statusPill.textContent = 'Balancing…';
    statusPill.className = 'status-pill you';
  }
});

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
