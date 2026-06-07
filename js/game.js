const FACES = ['⚀', '⚁', '⚂', '⚃', '⚄', '⚅'];

// Local mirror of the game state. In online mode these are kept in sync with
// the Colyseus server; in offline mode they are driven entirely on the client.
let currentPlayer = 0;   // seat (0..3) whose turn it is
let rolling = false;     // local dice-animation lock
let diceVals = [1, 1];

function rnd() { return 1 + Math.floor(Math.random() * 6); }

function init() {
  const canvas = document.getElementById('board');

  initTheme();
  window.__turnSeat = currentPlayer;
  drawBoard(canvas);
  updateStatus();

  document.getElementById('roll-btn').onclick = onRollClick;
  document.getElementById('d1').onclick = onRollClick;
  document.getElementById('d2').onclick = onRollClick;
  document.getElementById('theme-btn').onclick = toggleTheme;

  const resetBtn = document.getElementById('reset-btn');
  if (resetBtn) resetBtn.onclick = () => { if (window.MP && MP.enabled) MP.reset(); };

  const nameInput = document.getElementById('name-input');
  if (nameInput && window.MP) {
    nameInput.value = MP.myName();
    nameInput.onchange = () => MP.setName(nameInput.value.trim());
  }

  // Try to play online; if the server can't be reached we stay fully playable
  // offline (hot-seat on one device), exactly like before.
  if (window.MP) MP.connect();
  refreshControls();
}

/* ----------------------------- theme ----------------------------- */

function currentThemeName() {
  return document.documentElement.dataset.theme || 'day';
}

function updateThemeBtn() {
  // Иконка показывает, на что переключит клик.
  document.getElementById('theme-btn').textContent =
    currentThemeName() === 'night' ? '☀️' : '🌙';
}

function initTheme() {
  let saved = null;
  try { saved = localStorage.getItem('pe-theme'); } catch (e) {}
  const prefersDark = window.matchMedia &&
    window.matchMedia('(prefers-color-scheme: dark)').matches;
  applyTheme(saved || (prefersDark ? 'night' : 'day'));
  updateThemeBtn();
}

function toggleTheme() {
  applyTheme(currentThemeName() === 'night' ? 'day' : 'night');
  updateThemeBtn();
}

/* ----------------------------- rolling ----------------------------- */

const isOnline = () => !!(window.MP && MP.enabled);

function onRollClick() {
  if (rolling) return;

  if (isOnline()) {
    // Only the seat whose turn it is may roll. The server is authoritative and
    // will ignore stray rolls; we just avoid sending noise. The dice animation
    // is triggered for everyone by the resulting state broadcast (see net.js).
    if (!MP.isMyTurn()) return;
    MP.sendRoll();
    return;
  }

  // Offline hot-seat: pick locally, animate, then pass the turn.
  animateDice(rnd(), rnd(), () => setTimeout(nextTurnLocal, 1200));
}

// Animate both dice tumbling and settle on the given values. `onLand` (offline
// only) fires once the dice have landed.
function animateDice(target1, target2, onLand) {
  if (rolling) return;
  rolling = true;

  const d1 = document.getElementById('d1');
  const d2 = document.getElementById('d2');

  document.getElementById('total').textContent = 'Сумма: —';
  d1.classList.add('rolling');
  d2.classList.add('rolling');
  refreshControls();

  playDiceRattle();

  let i = 0;
  const iv = setInterval(() => {
    d1.textContent = FACES[Math.floor(Math.random() * 6)];
    d2.textContent = FACES[Math.floor(Math.random() * 6)];
    if (++i > 10) {
      clearInterval(iv);
      d1.classList.remove('rolling');
      d2.classList.remove('rolling');

      diceVals = [target1, target2];
      d1.textContent = FACES[target1 - 1];
      d2.textContent = FACES[target2 - 1];

      playDiceLand();
      document.getElementById('total').textContent = `Сумма: ${target1 + target2}`;

      rolling = false;
      refreshControls();
      if (onLand) onLand();
    }
  }, 60);
}

function nextTurnLocal() {
  currentPlayer = (currentPlayer + 1) % 4;
  window.__turnSeat = currentPlayer;
  updateStatus();
  redrawBoard();
  refreshControls();
}

/* ------------------- hooks called by net.js (online) ------------------- */

// Server advanced the turn (or we just joined).
function applyTurnFromNet(seat) {
  currentPlayer = seat;
  window.__turnSeat = seat;
  updateStatus();
  redrawBoard();
  refreshControls();
}

// Roster changed: refresh seat names, occupancy and connection state.
function syncPlayersFromNet(players) {
  const occupied = new Set();
  const connected = {};

  PLAYERS.forEach((p, i) => { p.name = `Игрок ${i + 1}`; });

  Object.values(players).forEach((p) => {
    if (p.seat >= 0 && p.seat < PLAYERS.length) {
      occupied.add(p.seat);
      connected[p.seat] = p.connected;
      PLAYERS[p.seat].name = (p.name || `Игрок ${p.seat + 1}`) + (p.me ? ' (вы)' : '');
    }
  });

  window.__occupied = occupied;
  window.__connected = connected;
  redrawBoard();
  updateStatus();
  refreshControls();
}

/* ----------------------------- view ----------------------------- */

function redrawBoard() {
  if (boardCanvas) drawBoard(boardCanvas);
}

function updateStatus() {
  const player = PLAYERS[currentPlayer];
  const el = document.getElementById('status');

  if (isOnline()) {
    if (MP.mySeat < 0) {
      el.textContent = `Ход: ${player.name} (вы наблюдаете)`;
    } else if (MP.mySeat === currentPlayer) {
      el.textContent = `Ваш ход — ${player.name}`;
    } else {
      el.textContent = `Ход: ${player.name}`;
    }
  } else {
    el.textContent = `Ход: ${player.name}`;
  }
  el.style.color = player.color;
}

// Enable/disable the roll controls depending on whose turn it is.
function refreshControls() {
  const btn = document.getElementById('roll-btn');
  const d1 = document.getElementById('d1');
  const d2 = document.getElementById('d2');

  let disabled = rolling;
  let label = 'Бросить';

  if (isOnline()) {
    const serverRolling = !!MP.rolling;
    disabled = disabled || serverRolling || !MP.isMyTurn();
    if (MP.mySeat < 0) label = 'Зритель';
    else if (!rolling && !serverRolling && MP.mySeat !== currentPlayer) label = 'Не ваш ход';
  }

  btn.disabled = disabled;
  btn.textContent = label;
  d1.classList.toggle('die-locked', disabled);
  d2.classList.toggle('die-locked', disabled);
}

window.onload = init;
