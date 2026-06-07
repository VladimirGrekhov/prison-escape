const FACES = ['⚀', '⚁', '⚂', '⚃', '⚄', '⚅'];

// Local mirror of the game state. In online mode these are kept in sync with
// the Colyseus server; in offline mode they are driven entirely on the client.
let currentPlayer = 0;   // seat (0..3) whose turn it is
let rolling = false;     // local dice-animation lock
let diceVals = [1, 1];

// Офлайн-движок: состояние текущего хода.
let dice = [];                 // [v1, v2] — выпавшие значения (фиксированные слоты d1/d2)
let used = [false, false];     // какой кубик уже израсходован
let selectedDie = -1;          // индекс выбранного кубика (0/1)
let awaitingMove = false;
let turnDouble = false;
let doubleOne = false;
let gameOver = false;
let bmChoice = null;           // {seat,i} — ждём выбор «съехать на БМ или остаться»

function rnd() { return 1 + Math.floor(Math.random() * 6); }

function init() {
  const canvas = document.getElementById('board');

  initTheme();
  window.__turnSeat = currentPlayer;
  drawBoard(canvas);
  updateStatus();

  document.getElementById('roll-btn').onclick = onRollClick;
  document.getElementById('d1').onclick = () => onDieClick(0);
  document.getElementById('d2').onclick = () => onDieClick(1);
  document.getElementById('theme-btn').onclick = toggleTheme;
  setupRules();
  setupModeToggle();
  if (window.DBG) DBG.init();
  setupBoardInput(canvas);
  window.onBoardClick = onBoardClick;

  const bmYes = document.getElementById('bm-yes');
  const bmNo = document.getElementById('bm-no');
  if (bmYes) bmYes.onclick = () => resolveBM(true);
  if (bmNo) bmNo.onclick = () => resolveBM(false);

  const resetBtn = document.getElementById('reset-btn');
  if (resetBtn) resetBtn.onclick = onResetClick;

  const nameInput = document.getElementById('name-input');
  if (nameInput && window.MP) {
    nameInput.value = MP.myName();
    nameInput.onchange = () => MP.setName(nameInput.value.trim());
  }

  // Try to play online; if the server can't be reached we stay fully playable
  // offline (hot-seat on one device), exactly like before.
  if (window.MP && !offlinePreferred()) MP.connect();
  refreshControls();
}

/* ----------------------------- rules modal ----------------------------- */

function setupRules() {
  const btn = document.getElementById('rules-btn');
  const overlay = document.getElementById('rules-overlay');
  const close = document.getElementById('rules-close');
  if (!btn || !overlay) return;

  const open = () => overlay.classList.remove('hidden');
  const hide = () => overlay.classList.add('hidden');

  btn.onclick = open;
  if (close) close.onclick = hide;
  // Клик по затемнённому фону (но не по самому окну) закрывает.
  overlay.onclick = (e) => { if (e.target === overlay) hide(); };
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && !overlay.classList.contains('hidden')) hide();
  });
}

/* --------------------- online / offline mode toggle --------------------- */

// Хочет ли пользователь локальную игру: ?offline / ?solo в URL, либо сохранённый
// выбор в localStorage.
function offlinePreferred() {
  if (/[?&](offline|solo)\b/.test(location.search)) return true;
  try { return localStorage.getItem('pe-mode') === 'offline'; } catch (e) { return false; }
}

function setupModeToggle() {
  const btn = document.getElementById('mode-btn');
  if (!btn) return;
  const off = offlinePreferred();
  btn.textContent = off ? '🌐 Играть онлайн' : '🔌 Играть локально';
  btn.title = off ? 'Переключиться в онлайн' : 'Переключиться в локальную игру';
  btn.onclick = () => {
    try { localStorage.setItem('pe-mode', off ? 'online' : 'offline'); } catch (e) {}
    // Перезагрузка на чистый URL (без ?offline) — режим решает localStorage.
    window.location.href = window.location.pathname;
  };
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
  if (rolling || bmChoice) return;

  if (isOnline()) {
    // Only the seat whose turn it is may roll. The server is authoritative and
    // will ignore stray rolls; we just avoid sending noise. The dice animation
    // is triggered for everyone by the resulting state broadcast (see net.js).
    if (!MP.isMyTurn()) return;
    MP.sendRoll();
    return;
  }

  // Офлайн: нельзя бросать, пока не сходил предыдущими кубиками / игра не идёт.
  if (awaitingMove || gameOver) return;
  animateDice(rnd(), rnd(), () => startMovePhase(diceVals[0], diceVals[1]));
}

// Клик по кубику: в фазе хода (офлайн) — выбор кубика; иначе — бросок.
function onDieClick(idx) {
  if (bmChoice) return;
  if (!isOnline() && awaitingMove) { selectDie(idx); return; }
  onRollClick();
}

/* --------------------- offline move phase (full rules) --------------------- */

function startMovePhase(a, b) {
  dice = [a, b];
  used = [false, false];
  turnDouble = (a === b);
  doubleOne = (a === 1 && b === 1);
  if (window.DBG) DBG.log(`--- roll seat${currentPlayer} [${a},${b}]${turnDouble ? ' DOUBLE' : ''}`);

  if (!ENGINE.hasAnyMove(currentPlayer, dice, { doubleOne })) {
    markDice();
    setStatusMsg(`${PLAYERS[currentPlayer].name}: нет ходов`);
    if (window.DBG) DBG.log(`seat${currentPlayer} no moves`);
    setTimeout(endTurn, 1100);
    return;
  }
  awaitingMove = true;
  selectedDie = firstUsableSlot();
  updateHighlights();
  updateStatus();
  refreshControls();
}

// Первый неиспользованный кубик, которым есть ход (или -1).
function firstUsableSlot() {
  for (let k = 0; k < dice.length; k++) {
    if (!used[k] && ENGINE.legalForDie(currentPlayer, dice[k], { doubleOne }).length > 0) return k;
  }
  return -1;
}

function selectDie(idx) {
  if (idx < 0 || idx >= dice.length || used[idx]) return;
  if (ENGINE.legalForDie(currentPlayer, dice[idx], { doubleOne }).length === 0) return;
  selectedDie = idx;
  updateHighlights();
}

function updateHighlights() {
  const set = new Set();
  if (awaitingMove && selectedDie >= 0 && !used[selectedDie]) {
    ENGINE.legalForDie(currentPlayer, dice[selectedDie], { doubleOne })
      .forEach((i) => set.add(`${currentPlayer},${i}`));
  }
  window.__movable = set;
  markDice();
  redrawBoard();
}

// Кубики: израсходованные затемняются, выбранный обводится.
function markDice() {
  ['d1', 'd2'].forEach((id, idx) => {
    const el = document.getElementById(id);
    if (!el) return;
    el.classList.toggle('die-used', !!used[idx]);
    el.classList.toggle('die-selected', awaitingMove && idx === selectedDie && !used[idx]);
  });
}

// Клик по фишке на доске (вызывается из board.js через window.onBoardClick).
function onBoardClick(seat, i) {
  if (isOnline() || !awaitingMove || bmChoice || seat !== currentPlayer) return;

  const piece = ENGINE.pieces[currentPlayer][i];

  // Выход из тюрьмы (шаг 1): при 6 клик по тюремной фишке ставит её на «Х»
  // (расходует кубик с 6). Дальше фишку на «Х» двигают другим кубиком кликом.
  if (piece.where === 'prison') {
    const slot = dice.findIndex((d, k) => !used[k] && d === 6);
    if (slot < 0) return;                    // выйти можно только при 6
    ENGINE.applyDie(currentPlayer, i, 6);    // встать на Х (progress 0)
    used[slot] = true;
    selectedDie = -1;
    playDiceLand();
    if (window.DBG) DBG.log(`seat${currentPlayer} piece${i} EXIT -> x${currentPlayer} (die6, slot${slot})`);
    afterMove();
    return;
  }

  // Обычный ход: неиспользованный кубик (выбранный, иначе любой подходящий).
  let slot = -1;
  if (selectedDie >= 0 && !used[selectedDie] &&
      ENGINE.legalForDie(currentPlayer, dice[selectedDie], { doubleOne }).includes(i)) {
    slot = selectedDie;
  } else {
    slot = dice.findIndex((d, k) => !used[k] &&
      ENGINE.legalForDie(currentPlayer, d, { doubleOne }).includes(i));
  }
  if (slot < 0) return; // этой фишкой сейчас ходить нельзя

  const before = ENGINE.pieces[currentPlayer][i].progress;
  const res = ENGINE.applyDie(currentPlayer, i, dice[slot]);
  used[slot] = true;
  selectedDie = -1;
  playDiceLand();
  if (window.DBG) {
    const cell = ENGINE.cellOf(currentPlayer, i);
    DBG.log(`seat${currentPlayer} piece${i} die${dice[slot]}: prog ${before}->` +
      `${ENGINE.pieces[currentPlayer][i].progress} cell ${JSON.stringify(cell)}` +
      `${res.captured.length ? ' CAPTURED ' + JSON.stringify(res.captured) : ''}` +
      `${res.finished ? ' HOME' : ''}`);
  }

  // Ход закончился напротив БМ — предложить съезд на БМ или остаться.
  if (ENGINE.canOfferBM(currentPlayer, i)) { offerBM(currentPlayer, i); return; }
  afterMove();
}

// Предложение «съехать на БМ или остаться» после хода напротив БМ.
function offerBM(seat, i) {
  bmChoice = { seat, i };
  window.__movable = new Set([`${seat},${i}`]);
  redrawBoard();
  const el = document.getElementById('bm-prompt');
  if (el) el.classList.remove('hidden');
  setStatusMsg(`${PLAYERS[seat].name}: съехать на БМ?`);
}

function resolveBM(divert) {
  if (!bmChoice) return;
  const { seat, i } = bmChoice;
  if (divert) ENGINE.divertToBM(seat, i);
  if (window.DBG) DBG.log(`seat${seat} piece${i} ${divert ? '-> БМ' : 'остаётся на маршруте'}`);
  bmChoice = null;
  const el = document.getElementById('bm-prompt');
  if (el) el.classList.add('hidden');
  window.__movable = new Set();
  afterMove();
}

// Общая логика после хода: победа / следующий кубик / конец хода.
function afterMove() {
  const win = ENGINE.winner();
  if (win >= 0) { redrawBoard(); finishGame(win); return; }

  const next = firstUsableSlot();
  if (next >= 0) {
    selectedDie = next;
    updateHighlights();
    updateStatus();
  } else {
    endTurn();
  }
}

function endTurn() {
  awaitingMove = false;
  dice = [];
  used = [false, false];
  selectedDie = -1;
  window.__movable = new Set();
  markDice();

  if (turnDouble && !gameOver) {
    setStatusMsg(`${PLAYERS[currentPlayer].name}: дубль — ещё ход!`);
    if (window.DBG) DBG.log(`seat${currentPlayer} EXTRA turn (double)`);
  } else {
    currentPlayer = (currentPlayer + 1) % 4;
    window.__turnSeat = currentPlayer;
    updateStatus();
    if (window.DBG) DBG.log(`turn -> seat${currentPlayer}`);
  }
  redrawBoard();
  refreshControls();
}

function finishGame(seat) {
  gameOver = true;
  awaitingMove = false;
  window.__movable = new Set();
  setStatusMsg(`🏆 ${PLAYERS[seat].name} победил!`);
  if (window.DBG) DBG.log(`WINNER seat${seat}`);
  refreshControls();
}

function onResetClick() {
  if (isOnline()) { MP.reset(); return; }
  ENGINE.newGame();
  currentPlayer = 0;
  window.__turnSeat = 0;
  dice = []; used = [false, false]; selectedDie = -1; awaitingMove = false;
  turnDouble = false; doubleOne = false; gameOver = false; bmChoice = null;
  window.__movable = new Set();
  document.getElementById('total').textContent = 'Сумма: —';
  const bmEl = document.getElementById('bm-prompt');
  if (bmEl) bmEl.classList.add('hidden');
  markDice();
  updateStatus();
  redrawBoard();
  refreshControls();
}

function setStatusMsg(msg) {
  const el = document.getElementById('status');
  el.textContent = msg;
  el.style.color = PLAYERS[currentPlayer].color;
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
    if (gameOver) return; // не затирать сообщение о победе
    el.textContent = awaitingMove
      ? `Ход: ${player.name} — двигайте фишку`
      : `Ход: ${player.name}`;
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
  let diceLocked = rolling;

  if (isOnline()) {
    const serverRolling = !!MP.rolling;
    disabled = disabled || serverRolling || !MP.isMyTurn();
    diceLocked = disabled;
    if (MP.mySeat < 0) label = 'Зритель';
    else if (!rolling && !serverRolling && MP.mySeat !== currentPlayer) label = 'Не ваш ход';
  } else if (gameOver) {
    disabled = true; diceLocked = true; label = 'Игра окончена';
  } else if (awaitingMove) {
    // Кнопка «бросить» заблокирована, но кубики кликабельны для выбора.
    disabled = true; label = 'Ходите фишкой';
  }

  btn.disabled = disabled;
  btn.textContent = label;
  d1.classList.toggle('die-locked', diceLocked);
  d2.classList.toggle('die-locked', diceLocked);
}

window.onload = init;
