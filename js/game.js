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
let expressChoice = null;      // {seat,i,slot} — ждём выбор «экспресс или обычный +1»
let expressUsed = false;       // экспресс в этом ходу → дополнительный ход
let bonusSix = [0, 0, 0, 0];   // накопленные бонусные «6» по местам (за выкупленных пленных)

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
  const d3 = document.getElementById('d3');
  if (d3) d3.onclick = () => onDieClick(2);
  document.getElementById('theme-btn').onclick = toggleTheme;
  setupRules();
  setupModeToggle();
  if (window.DBG) DBG.init();
  setupBoardInput(canvas);
  window.onBoardClick = onBoardClick;
  window.onTargetClick = onTargetClick;

  const bmYes = document.getElementById('bm-yes');
  const bmNo = document.getElementById('bm-no');
  if (bmYes) bmYes.onclick = () => resolveBM(true);
  if (bmNo) bmNo.onclick = () => resolveBM(false);

  const exGo = document.getElementById('express-yes');
  const exStep = document.getElementById('express-step');
  const exCancel = document.getElementById('express-no');
  if (exGo) exGo.onclick = () => resolveExpress('express');
  if (exStep) exStep.onclick = () => resolveExpress('step');
  if (exCancel) exCancel.onclick = () => resolveExpress('cancel');

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
  if (rolling || bmChoice || expressChoice) return;

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
  if (bmChoice || expressChoice) return;
  if (!isOnline() && awaitingMove) {
    if (idx === 2) {
      // бонусный кубик — выбрать первый неиспользованный бонусный слот (>=2)
      const slot = dice.findIndex((d, k) => k >= 2 && !used[k]);
      if (slot >= 0) selectDie(slot);
    } else {
      selectDie(idx);
    }
    return;
  }
  onRollClick();
}

/* --------------------- offline move phase (full rules) --------------------- */

function startMovePhase(a, b) {
  dice = [a, b];
  used = [false, false];
  // Бонусные «6» (за выкупленных у этого игрока пленных) добавляются к ходу.
  const bonus = bonusSix[currentPlayer] || 0;
  for (let k = 0; k < bonus; k++) { dice.push(6); used.push(false); }
  bonusSix[currentPlayer] = 0;

  turnDouble = (a === b);
  doubleOne = (a === 1 && b === 1);
  expressUsed = false;
  if (window.DBG) DBG.log(`--- roll seat${currentPlayer} [${a},${b}]${turnDouble ? ' DOUBLE' : ''}${bonus ? ' +bonus6x' + bonus : ''}`);

  if (!hasAnyAction()) {
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

// Есть ли хоть какое-то действие: обычный ход или выкуп пленного за 6.
function hasAnyAction() {
  if (ENGINE.hasAnyMove(currentPlayer, dice, { doubleOne })) return true;
  return hasUnusedSix() && ENGINE.hasRedeemable(currentPlayer);
}

function hasUnusedSix() {
  return dice.some((d, k) => !used[k] && d === 6);
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
  if (awaitingMove) {
    // Подсвечиваем ВСЕ разрешённые ходы — любым неиспользованным кубиком.
    dice.forEach((d, k) => {
      if (used[k]) return;
      ENGINE.legalForDie(currentPlayer, d, { doubleOne })
        .forEach((i) => set.add(`${currentPlayer},${i}`));
    });
    // Выкуп: пленные при наличии свободной 6.
    if (hasUnusedSix() && ENGINE.hasRedeemable(currentPlayer)) {
      ENGINE.pieces[currentPlayer].forEach((p, i) => {
        if (p.where === 'prison' && p.captor >= 0) set.add(`${currentPlayer},${i}`);
      });
    }
  }
  window.__movable = set;
  window.__targets = computeTargets();
  markDice();
  redrawBoard();
}

// Клетки-цели для выбранного кубика: куда встанут фишки (для подсветки/кликов).
function computeTargets() {
  const out = [];
  if (!awaitingMove || selectedDie < 0 || used[selectedDie]) return out;
  const d = dice[selectedDie];
  const ctx = { doubleOne };
  let exitAdded = false;
  ENGINE.legalForDie(currentPlayer, d, ctx).forEach((i) => {
    const p = ENGINE.pieces[currentPlayer][i];
    if (p.where === 'prison') {
      if (!exitAdded) { // выход на «Х» (выкуп — кликом по самой пленной фишке)
        out.push({ kind: 'exit', seat: currentPlayer, i, slot: selectedDie, cell: X_GRID[currentPlayer] });
        exitAdded = true;
      }
    } else if (ENGINE.canMove(currentPlayer, i, d, ctx)) {
      const dest = ENGINE.destCellOf(currentPlayer, i, d);
      if (dest) out.push({ kind: 'move', seat: currentPlayer, i, slot: selectedDie, cell: dest });
    }
  });
  if (d === 1) { // экспресс-цели
    ENGINE.pieces[currentPlayer].forEach((p, i) => {
      const ti = ENGINE.onExpress(currentPlayer, i);
      if (ti >= 0) out.push({ kind: 'express', seat: currentPlayer, i, slot: selectedDie, cell: TRACK[EXPRESS_NEXT[ti]] });
    });
  }
  return out;
}

// Клик по клетке-цели (из board.js).
function onTargetClick(idx) {
  if (expressChoice) return;
  const t = (window.__targets || [])[idx];
  if (!t) return;
  if (bmChoice) {                       // выбор БМ: только bm-цели
    if (t.kind === 'bmDivert') resolveBM(true);
    else if (t.kind === 'bmStay') resolveBM(false);
    return;
  }
  if (!awaitingMove) return;
  if (t.kind === 'exit') { doExit(t.i, t.slot); return; }
  if (t.kind === 'express') { doExpress(t.seat, t.i, t.slot); return; }
  doNormalMove(t.seat, t.i, t.slot);
}

function doExit(i, slot) {
  ENGINE.applyDie(currentPlayer, i, 6);
  used[slot] = true; selectedDie = -1; playDiceLand();
  if (window.DBG) DBG.log(`seat${currentPlayer} piece${i} EXIT -> x${currentPlayer}`);
  afterMove();
}

function doExpress(seat, i, slot) {
  ENGINE.expressJump(seat, i);
  used[slot] = true; selectedDie = -1; expressUsed = true; playDiceLand();
  if (window.DBG) DBG.log(`seat${seat} piece${i} EXPRESS (+доп. ход)`);
  window.__movable = new Set();
  afterMove();
}

// Кубики: израсходованные затемняются, выбранный обводится. d3 — бонусные «6».
function markDice() {
  ['d1', 'd2'].forEach((id, idx) => {
    const el = document.getElementById(id);
    if (!el) return;
    el.classList.toggle('die-used', !!used[idx]);
    el.classList.toggle('die-selected', awaitingMove && idx === selectedDie && !used[idx]);
  });

  const d3 = document.getElementById('d3');
  if (!d3) return;
  const bonusCount = dice.length - 2;                 // сколько всего бонусных слотов
  if (bonusCount <= 0) { d3.style.display = 'none'; d3.classList.remove('die-selected', 'die-used'); return; }
  let remaining = 0;
  for (let k = 2; k < dice.length; k++) if (!used[k]) remaining++;
  d3.style.display = '';
  d3.textContent = FACES[5];                          // ⚅
  d3.dataset.count = remaining > 1 ? String(remaining) : '';
  d3.classList.toggle('die-used', remaining === 0);
  d3.classList.toggle('die-selected', awaitingMove && selectedDie >= 2 && !used[selectedDie]);
}

// Клик по фишке на доске (вызывается из board.js через window.onBoardClick).
function onBoardClick(seat, i) {
  if (isOnline() || !awaitingMove || bmChoice || expressChoice || seat !== currentPlayer) return;

  const piece = ENGINE.pieces[currentPlayer][i];

  if (piece.where === 'prison') {
    const slot = dice.findIndex((d, k) => !used[k] && d === 6);
    if (slot < 0) return;                     // и выход, и выкуп требуют 6

    // Пленная фишка: выкуп за 6 — возвращается в свою тюрьму; захватчик получает бонус-6.
    if (piece.captor >= 0) {
      const captor = ENGINE.redeem(currentPlayer, i);
      used[slot] = true;
      bonusSix[captor] = (bonusSix[captor] || 0) + 1;
      selectedDie = -1;
      playDiceLand();
      if (window.DBG) DBG.log(`seat${currentPlayer} piece${i} REDEEM from seat${captor} (+bonus6 -> seat${captor})`);
      afterMove();
      return;
    }

    // Обычный выход из своей тюрьмы: фишка встаёт на «Х».
    if (!ENGINE.legalForDie(currentPlayer, 6, { doubleOne }).includes(i)) return; // напр. Х занят своей
    doExit(i, slot);
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

  // Экспресс: фишка на экспресс-клетке + кубик 1 → предложить прыжок или обычный ход.
  if (dice[slot] === 1 && ENGINE.onExpress(currentPlayer, i) >= 0) {
    offerExpress(currentPlayer, i, slot);
    return;
  }
  doNormalMove(currentPlayer, i, slot);
}

// Обычный ход кубиком из слота `slot`; затем при попадании напротив БМ — выбор.
function doNormalMove(seat, i, slot) {
  const before = ENGINE.pieces[seat][i].progress;
  const res = ENGINE.applyDie(seat, i, dice[slot]);
  used[slot] = true;
  selectedDie = -1;
  playDiceLand();
  if (window.DBG) {
    const cell = ENGINE.cellOf(seat, i);
    DBG.log(`seat${seat} piece${i} die${dice[slot]}: prog ${before}->` +
      `${ENGINE.pieces[seat][i].progress} cell ${JSON.stringify(cell)}` +
      `${res.captured.length ? ' CAPTURED ' + JSON.stringify(res.captured) : ''}` +
      `${res.finished ? ' HOME' : ''}`);
  }
  if (ENGINE.canOfferBM(seat, i)) { offerBM(seat, i); return; }
  afterMove();
}

// Предложение экспресс-прыжка (по кубику 1 со стоянки на экспресс-клетке).
function offerExpress(seat, i, slot) {
  expressChoice = { seat, i, slot };
  const ti = ENGINE.onExpress(seat, i);
  const label = document.getElementById('express-label');
  if (label) label.textContent = `🚀 Экспресс ${ti} → ${EXPRESS_NEXT[ti]}?`;
  const stepBtn = document.getElementById('express-step');
  if (stepBtn) stepBtn.style.display = ENGINE.canMove(seat, i, 1, { doubleOne }) ? '' : 'none';
  const el = document.getElementById('express-prompt');
  if (el) el.classList.remove('hidden');
  window.__movable = new Set([`${seat},${i}`]);
  window.__targets = [];
  redrawBoard();
  setStatusMsg(`${PLAYERS[seat].name}: экспресс?`);
}

function resolveExpress(mode) {
  if (!expressChoice) return;
  const { seat, i, slot } = expressChoice;
  const el = document.getElementById('express-prompt');
  if (el) el.classList.add('hidden');
  expressChoice = null;

  if (mode === 'cancel') { updateStatus(); updateHighlights(); return; }
  if (mode === 'express') { doExpress(seat, i, slot); return; }
  doNormalMove(seat, i, slot); // обычный +1
}

// После хода напротив БМ: подсветить кликабельные клетки — БМ (съехать) и
// текущую клетку фишки (остаться). Нижней плашки нет.
function offerBM(seat, i) {
  bmChoice = { seat, i };
  const ti = ENGINE.trackIndex(seat, i);
  const bm = BM_BY_TRACK[ti];
  const cur = ENGINE.cellOf(seat, i);
  window.__movable = new Set([`${seat},${i}`]);
  window.__targets = [
    { kind: 'bmDivert', seat, i, bm, cell: [bm.r, bm.c] },
    { kind: 'bmStay', seat, i, cell: cur },
  ];
  redrawBoard();
  setStatusMsg(`${PLAYERS[seat].name}: клик по БМ — съехать, по фишке — остаться`);
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
  } else if (hasUnusedSix() && ENGINE.hasRedeemable(currentPlayer)) {
    // ходов кубиками нет, но осталась 6 и есть кого выкупить
    selectedDie = -1;
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
  window.__targets = [];
  markDice();

  if ((turnDouble || expressUsed) && !gameOver) {
    const why = turnDouble ? 'дубль' : 'экспресс';
    setStatusMsg(`${PLAYERS[currentPlayer].name}: ${why} — ещё ход!`);
    if (window.DBG) DBG.log(`seat${currentPlayer} EXTRA turn (${why})`);
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
  window.__targets = [];
  setStatusMsg(`🏆 ${PLAYERS[seat].name} победил!`);
  if (window.DBG) DBG.log(`WINNER seat${seat}`);
  refreshControls();
}

function onResetClick() {
  if (isOnline()) { MP.reset(); return; }
  ENGINE.newGame();
  currentPlayer = 0;
  window.__turnSeat = 0;
  bonusSix = [0, 0, 0, 0];
  dice = []; used = [false, false]; selectedDie = -1; awaitingMove = false;
  turnDouble = false; doubleOne = false; gameOver = false;
  bmChoice = null; expressChoice = null; expressUsed = false;
  window.__movable = new Set();
  window.__targets = [];
  document.getElementById('total').textContent = 'Сумма: —';
  ['bm-prompt', 'express-prompt'].forEach((id) => {
    const e = document.getElementById(id); if (e) e.classList.add('hidden');
  });
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
