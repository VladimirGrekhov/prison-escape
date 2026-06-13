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
let turnSix = false;
let turnCaptures = 0;          // срубил в этом броске → доп. ход (не суммируется)
let gameOver = false;
let bmChoice = null;           // {seat,i} — ждём выбор «съехать на БМ или остаться»
let expressChoice = null;      // {seat,i,slot} — ждём выбор «экспресс или обычный +1»
let expressJumps = 0;          // сколько экспресс-прыжков в этом броске (каждый = +доп. ход)
let bonusSix = [0, 0, 0, 0];   // накопленные бонусные «6» по местам (за выкупленных пленных)
let bonusPhase = false;        // бонусные «6» ходятся ДО броска кубиков
let carryCaptures = 0;         // срубания в бонусной фазе → учесть в доп. ходе после броска
let rollCaptureChances = [];   // фишки, которые могли срубить этим броском (правило карцера)
let karzerHandled = false;     // освобождение по дублю 1 уже использовано в этом броске
let karzerOfferNet = null;     // онлайн: {seat,i} из карцера, кого можно забрать (от сервера)

function rnd() { return 1 + Math.floor(Math.random() * 6); }

function init() {
  const canvas = document.getElementById('board');

  initTheme();
  window.__turnSeat = currentPlayer;
  drawBoard(canvas);
  updateStatus();

  document.getElementById('roll-btn').onclick = onRollClick;
  // Горячая клавиша: пробел — бросок кубиков.
  document.addEventListener('keydown', (e) => {
    if (e.code !== 'Space' || e.repeat) return;
    const t = e.target;
    if (t && /INPUT|TEXTAREA|SELECT|BUTTON/.test(t.tagName)) return;
    const rules = document.getElementById('rules-overlay');
    if (rules && !rules.classList.contains('hidden')) return;
    e.preventDefault(); // не скроллить страницу
    onRollClick();
  });
  document.getElementById('d1').onclick = () => onDieClick(0);
  document.getElementById('d2').onclick = () => onDieClick(1);
  const d3 = document.getElementById('d3');
  if (d3) d3.onclick = () => onDieClick(2);
  document.getElementById('theme-btn').onclick = toggleTheme;
  setupRules();
  setupModeToggle();
  setupArtToggle();
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

/* ----------------------------- art skin ----------------------------- */

function applyArt(on) {
  window.__artMode = on;
  document.body.classList.toggle('art-mode', on);
  const btn = document.getElementById('art-btn');
  if (btn) btn.textContent = on ? '🎨 Обычный' : '🎨 Арт';
  if (typeof boardCanvas !== 'undefined' && boardCanvas) redrawBoard();
}

function setupArtToggle() {
  let on = false;
  try { on = localStorage.getItem('pe-art') === '1'; } catch (e) {}
  applyArt(on);
  const btn = document.getElementById('art-btn');
  if (btn) btn.onclick = () => {
    const next = !document.body.classList.contains('art-mode');
    try { localStorage.setItem('pe-art', next ? '1' : '0'); } catch (e) {}
    applyArt(next);
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
    // Server is authoritative; send the intent only when we may actually roll.
    if (MP.canRoll()) MP.roll(window.DBG && DBG.enabled ? DBG.takeForced() : null);
    return;
  }

  // Офлайн: нельзя бросать, пока не сходил предыдущими кубиками / игра не идёт.
  if (awaitingMove || gameOver) return;
  if (bonusSix[currentPlayer] > 0) { startBonusPhase(); return; } // бонусные 6 — до броска
  rollNormal();
}

function rollNormal() {
  const f = (window.DBG && DBG.enabled) ? DBG.takeForced() : [];
  animateDice(f[0] || rnd(), f[1] || rnd(), () => startMovePhase(diceVals[0], diceVals[1]));
}

// Бонусные «6» за выкуп: сначала ходишь ими, потом бросаешь кубики.
// Базовые слоты помечены использованными — активны только бонусные шестёрки (d3).
function startBonusPhase() {
  const n = bonusSix[currentPlayer];
  bonusSix[currentPlayer] = 0;
  dice = [0, 0]; used = [true, true];
  for (let k = 0; k < n; k++) { dice.push(6); used.push(false); }
  doubleOne = false; turnDouble = false;
  if (!hasAnyAction()) {
    if (window.DBG) DBG.log(`seat${currentPlayer} bonus6 x${n}: нет ходов, сгорают`);
    dice = []; used = [false, false];
    rollNormal();
    return;
  }
  bonusPhase = true;
  awaitingMove = true;
  selectedDie = -1;
  if (window.DBG) DBG.log(`--- bonus6 x${n} seat${currentPlayer} (до броска)`);
  setStatusMsg(`${PLAYERS[currentPlayer].name}: бонусный ход 6 — сначала сходи, потом бросай`);
  updateHighlights();
  markDice();
  redrawBoard();
  refreshControls();
}

// Бонусные «6» сыграны — вернуться к обычному броску (ход НЕ переходит).
function finishBonusPhase() {
  bonusPhase = false;
  carryCaptures = turnCaptures; turnCaptures = 0;
  awaitingMove = false;
  dice = []; used = [false, false]; selectedDie = -1;
  window.__movable = new Set();
  window.__targets = [];
  markDice();
  setStatusMsg(`${PLAYERS[currentPlayer].name}: бонус сыгран — бросай кубики`);
  if (window.DBG) DBG.log(`seat${currentPlayer} bonus6 done`);
  redrawBoard();
  refreshControls();
}

// Отладка (?debug=1): пара цифр с клавиатуры в фазе хода заменяет текущие
// кубики на месте (пока оба не потрачены); до броска — задаёт следующий бросок.
window.onForcedDice = function (vals) {
  if (!vals || vals.length < 2) return;
  if (isOnline()) {
    if (MP.phase === 'move' && MP.mySeat === currentPlayer) { MP.debugDice(vals); DBG.takeForced(); }
    return;
  }
  if (!awaitingMove || used[0] || used[1] || dice.length < 2 || bmChoice || expressChoice) return;
  dice[0] = vals[0]; dice[1] = vals[1];
  turnDouble = (dice[0] === dice[1]);
  doubleOne = (dice[0] === 1 && dice[1] === 1);
  turnSix = (dice[0] === 6 || dice[1] === 6);
  DBG.takeForced();
  DBG.log(`DBG set dice [${dice[0]},${dice[1]}]`);
  rollCaptureChances = ENGINE.captureChances(currentPlayer, dice, used, { doubleOne });
  const e1 = document.getElementById('d1'), e2 = document.getElementById('d2');
  if (e1) e1.textContent = FACES[dice[0] - 1];
  if (e2) e2.textContent = FACES[dice[1] - 1];
  selectedDie = -1;
  if (!hasAnyAction()) {
    markDice();
    setStatusMsg(`${PLAYERS[currentPlayer].name}: нет ходов`);
    setTimeout(endTurn, 600);
    return;
  }
  updateHighlights();
  updateStatus();
  markDice();
  redrawBoard();
};

// Клик по кубику: в фазе хода (офлайн) — выбор кубика; иначе — бросок.
function onDieClick(idx) {
  if (bmChoice || expressChoice) return;
  if (awaitingMove) {
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

  turnDouble = (a === b);
  doubleOne = (a === 1 && b === 1);
  turnSix = (a === 6 || b === 6);
  expressJumps = 0;
  turnCaptures = carryCaptures; // срубания бонусной фазы тоже дают доп. ход
  carryCaptures = 0;
  if (window.DBG) DBG.log(`--- roll seat${currentPlayer} [${a},${b}]${turnDouble ? ' DOUBLE' : ''}`);

  // Дубль 1: фишку из карцера можно забрать кликом по ней (не автоматически).
  karzerHandled = false;
  // Кто мог бы срубить этим броском (для правила карцера на конце хода).
  rollCaptureChances = ENGINE.captureChances(currentPlayer, dice, used, { doubleOne });

  if (!hasAnyAction()) {
    markDice();
    setStatusMsg(`${PLAYERS[currentPlayer].name}: нет ходов`);
    if (window.DBG) DBG.log(`seat${currentPlayer} no moves`);
    setTimeout(endTurn, 1100);
    return;
  }
  awaitingMove = true;
  selectedDie = -1; // кубик выбирается автоматически по клику по цели
  updateHighlights();
  updateStatus();
  refreshControls();
}

// Есть ли хоть какое-то действие: ход, выкуп пленного за 6 или карцер по дублю 1.
function hasAnyAction() {
  if (ENGINE.hasAnyMove(currentPlayer, dice, { doubleOne })) return true;
  if (hasUnusedSix() && ENGINE.hasRedeemable(currentPlayer)) return true;
  return !!karzerOffer();
}

// Дубль 1: кого сейчас можно забрать из карцера кликом ({seat,i} | null).
function karzerOffer() {
  if (isOnline()) return karzerOfferNet;
  if (!doubleOne || karzerHandled || bonusPhase) return null;
  return ENGINE.karzerEligible(currentPlayer);
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

// Снимок/восстановление фишек всех мест для lookahead-проверок.
function snapshotPieces() {
  return ENGINE.pieces.map(row => row.map(p => ({ ...p })));
}
function restorePieces(snap) {
  for (let s = 0; s < ENGINE.pieces.length; s++)
    for (let i = 0; i < ENGINE.pieces[s].length; i++)
      Object.assign(ENGINE.pieces[s][i], snap[s][i]);
}

// Максимальное число кубиков, которые можно потратить из текущего состояния движка.
// dArr/uArr — копии dice/used с учётом уже потраченных на этом шаге.
function _maxDiceRec(seat, dArr, uArr, ctx) {
  let best = 0;
  const total = uArr.filter(u => !u).length;
  if (total === 0) return 0;
  for (let k = 0; k < dArr.length; k++) {
    if (uArr[k]) continue;
    const d = dArr[k];
    // Обычные ходы.
    for (const i of ENGINE.legalForDie(seat, d, ctx)) {
      const snap = snapshotPieces();
      ENGINE.applyDie(seat, i, d);
      uArr[k] = true;
      const sub = _maxDiceRec(seat, dArr, uArr, ctx);
      uArr[k] = false;
      restorePieces(snap);
      best = Math.max(best, 1 + sub);
      if (best === total) return best;
    }
    // Выкуп как действие (кубик 6 + пленная фишка).
    if (d === 6) {
      for (let i = 0; i < ENGINE.pieces[seat].length; i++) {
        if (!ENGINE.canRedeem(seat, i)) continue;
        const snap = snapshotPieces();
        ENGINE.redeem(seat, i);
        uArr[k] = true;
        const sub = _maxDiceRec(seat, dArr, uArr, ctx);
        uArr[k] = false;
        restorePieces(snap);
        best = Math.max(best, 1 + sub);
        if (best === total) return best;
      }
    }
  }
  return best;
}

function maxDiceUsable(seat, ctx) {
  return _maxDiceRec(seat, dice.slice(), used.slice(), ctx);
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
    // Дубль 1: фишка в карцере, которую можно забрать кликом.
    const ko = karzerOffer();
    if (ko) set.add(`${ko.seat},${ko.i}`);
  }
  window.__movable = set;
  window.__targets = computeTargets();
  markDice();
  redrawBoard();
}

// Клетки-цели для выбранного кубика: куда встанут фишки (для подсветки/кликов).
// Все клетки-цели по ВСЕМ неиспользованным кубикам (кубик выбирается автоматически
// по тому, какую цель кликнули). Дубли клеток схлопываются.
function computeTargets() {
  const out = [];
  if (!awaitingMove) return out;
  const ctx = { doubleOne };
  const seen = new Set();
  const add = (t) => {
    const key = `${t.kind}:${t.i}:${t.cell ? t.cell.join(',') : ''}`;
    if (seen.has(key)) return;
    seen.add(key);
    out.push(t);
  };
  let exitAdded = false;
  for (let slot = 0; slot < dice.length; slot++) {
    if (used[slot]) continue;
    const d = dice[slot];
    ENGINE.legalForDie(currentPlayer, d, ctx).forEach((i) => {
      const p = ENGINE.pieces[currentPlayer][i];
      if (p.where === 'prison') {
        if (!exitAdded) { // выход на «Х» (выкуп — кликом по самой пленной фишке)
          add({ kind: 'exit', seat: currentPlayer, i, slot, cell: X_GRID[currentPlayer] });
          exitAdded = true;
        }
      } else if (ENGINE.canMove(currentPlayer, i, d, ctx)) {
        const dest = ENGINE.destCellOf(currentPlayer, i, d);
        if (dest) add({ kind: 'move', seat: currentPlayer, i, slot, cell: dest });
        const bm = ENGINE.bmAfterMove(currentPlayer, i, d);
        if (bm) add({ kind: 'moveBM', seat: currentPlayer, i, slot, bm, cell: [bm.r, bm.c] });
      }
    });
    if (d === 1 || d === 3) {
      ENGINE.pieces[currentPlayer].forEach((p, i) => {
        const target = ENGINE.expressTarget(currentPlayer, i, d);
        if (target >= 0) add({ kind: 'express', seat: currentPlayer, i, slot, cell: TRACK[target] });
      });
    }
  }
  // Ход на СУММУ двух базовых кубиков (если оба не использованы и ход легален).
  if (dice.length >= 2 && !used[0] && !used[1]) {
    const sum = dice[0] + dice[1];
    ENGINE.pieces[currentPlayer].forEach((p, i) => {
      if (!ENGINE.canMove(currentPlayer, i, sum, ctx)) return;
      const dest = ENGINE.destCellOf(currentPlayer, i, sum);
      if (dest) add({ kind: 'sum', seat: currentPlayer, i, cell: dest });
      const bm = ENGINE.bmAfterMove(currentPlayer, i, sum);
      if (bm) add({ kind: 'sumBM', seat: currentPlayer, i, bm, cell: [bm.r, bm.c] });
    });
  }

  // Комбинированный выход: 6 (на «Х») + другой кубик сразу — показать конечную клетку
  // ещё до выхода, чтобы было видно, куда фишка дойдёт.
  const sixSlot = dice.findIndex((d, k) => !used[k] && d === 6);
  if (sixSlot >= 0) {
    const exitable = ENGINE.legalForDie(currentPlayer, 6, ctx)
      .filter((j) => ENGINE.pieces[currentPlayer][j].where === 'prison');
    if (exitable.length) {
      const pi = exitable[0];
      const own = ENGINE.ownProgressSet(currentPlayer, pi);
      for (let k = 0; k < dice.length; k++) {
        if (used[k] || k === sixSlot) continue;
        const dd = dice[k];
        if (dd > MAX_PROGRESS) continue;
        let blocked = false;
        for (const q of own) if (q > 0 && q <= dd) { blocked = true; break; }
        if (blocked) continue;
        const cell = ENGINE.cellAtProgress(currentPlayer, dd);
        if (cell) add({ kind: 'exitMove', seat: currentPlayer, i: pi, sixSlot, dSlot: k, cell });
      }
    }
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
  if (t.kind === 'exitMove') { doExitMove(t.seat, t.i, t.sixSlot, t.dSlot); return; }
  if (t.kind === 'express') { doExpress(t.seat, t.i, t.slot); return; }
  if (t.kind === 'moveBM') { doNormalMove(t.seat, t.i, t.slot, true); return; } // ход + съезд на БМ
  if (t.kind === 'sum') { doSumMove(t.seat, t.i, false); return; }
  if (t.kind === 'sumBM') { doSumMove(t.seat, t.i, true); return; }
  doNormalMove(t.seat, t.i, t.slot, false);
}

// Ход одной фишкой на сумму двух базовых кубиков (тратит оба).
function doSumMove(seat, i, divert) {
  if (isOnline()) { MP.act('sum', i, 0, divert); return; }
  const sum = dice[0] + dice[1];
  const res = ENGINE.applyDie(seat, i, sum);
  turnCaptures += res.captured.length;
  if (divert && ENGINE.canOfferBM(seat, i)) ENGINE.divertToBM(seat, i);
  used[0] = true; used[1] = true;
  selectedDie = -1;
  playDiceLand();
  if (window.DBG) {
    DBG.log(`seat${seat} piece${i} SUM ${sum}${divert ? '+БМ' : ''}: cell ${JSON.stringify(ENGINE.cellOf(seat, i))}` +
      `${res.captured.length ? ' CAPTURED ' + JSON.stringify(res.captured) : ''}${res.finished ? ' HOME' : ''}`);
  }
  afterMove();
}

function doExit(i, slot) {
  if (isOnline()) { MP.act('exit', i, slot); return; }
  ENGINE.applyDie(currentPlayer, i, 6);
  used[slot] = true; selectedDie = -1; playDiceLand();
  if (window.DBG) DBG.log(`seat${currentPlayer} piece${i} EXIT -> x${currentPlayer}`);
  afterMove();
}

// Комбинированный выход: выйти на «Х» (6) и сразу пройти вторым кубиком.
function doExitMove(seat, i, sixSlot, dSlot) {
  if (isOnline()) { MP.act('exit', i, sixSlot); MP.act('move', i, dSlot); return; }
  ENGINE.applyDie(seat, i, 6);
  const res = ENGINE.applyDie(seat, i, dice[dSlot]);
  turnCaptures += res.captured.length;
  used[sixSlot] = true; used[dSlot] = true;
  selectedDie = -1; playDiceLand();
  if (window.DBG) DBG.log(`seat${seat} piece${i} EXIT+${dice[dSlot]} -> ${JSON.stringify(ENGINE.cellOf(seat, i))}` +
    `${res.captured.length ? ' CAPTURED ' + JSON.stringify(res.captured) : ''}`);
  afterMove();
}

function doExpress(seat, i, slot) {
  if (isOnline()) { MP.act('express', i, slot); return; }
  const res = ENGINE.expressJump(seat, i, dice[slot]);
  turnCaptures += res.captured.length;
  used[slot] = true; selectedDie = -1; expressJumps++; playDiceLand();
  if (window.DBG) DBG.log(`seat${seat} piece${i} EXPRESS die${dice[slot]} -> ${JSON.stringify(ENGINE.cellOf(seat, i))} (+доп. ход)` +
    `${res.captured.length ? ' CAPTURED ' + JSON.stringify(res.captured) : ''}`);
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
  if (!awaitingMove || bmChoice || expressChoice) return;

  // Дубль 1: клик по подсвеченной фишке в карцере — забрать её
  // (свою — домой, чужую — в плен). Забор тратит кубики этого броска.
  const ko = karzerOffer();
  if (ko && ko.seat === seat && ko.i === i) {
    if (isOnline()) { MP.act('karzer', i, 0); return; }
    karzerHandled = true;
    const rel = ENGINE.karzerOnDoubleOne(currentPlayer);
    if (rel) {
      playDiceLand();
      if (window.DBG) DBG.log(`seat${currentPlayer} КАРЦЕР дубль1: seat${rel.seat} piece${rel.i} ${rel.kind === 'home' ? 'домой' : 'в плен'}`);
    }
    used = used.map(() => true); // забор тратит кубики
    selectedDie = -1;
    afterMove();
    return;
  }
  if (seat !== currentPlayer) return;

  const piece = ENGINE.pieces[currentPlayer][i];

  if (piece.where === 'prison') {
    const slot = dice.findIndex((d, k) => !used[k] && d === 6);
    if (slot < 0) return;                     // и выход, и выкуп требуют 6

    // Пленная фишка: выкуп за 6 — возвращается в свою тюрьму; захватчик получает бонус-6.
    if (piece.captor >= 0) {
      // Нельзя выкупать, если есть последовательность ходов, использующая больше кубиков.
      const maxPossible = maxDiceUsable(currentPlayer, { doubleOne });
      if (maxPossible > 1) {
        const snap = snapshotPieces();
        const usedAfter = used.slice(); usedAfter[slot] = true;
        ENGINE.redeem(currentPlayer, i);
        const afterRansom = 1 + _maxDiceRec(currentPlayer, dice.slice(), usedAfter, { doubleOne });
        restorePieces(snap);
        if (afterRansom < maxPossible) return;
      }
      if (isOnline()) { MP.act('redeem', i, slot); return; }
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

  // Экспресс: фишка на экспресс-клетке + кубик 1 (следующая) или 3 (противоположная)
  // → предложить прыжок или обычный ход.
  if ((dice[slot] === 1 || dice[slot] === 3) && ENGINE.onExpress(currentPlayer, i) >= 0) {
    offerExpress(currentPlayer, i, slot);
    return;
  }
  doNormalMove(currentPlayer, i, slot);
}

// Обычный ход кубиком из слота `slot`; затем при попадании напротив БМ — выбор.
function doNormalMove(seat, i, slot, divert) {
  if (isOnline()) { MP.act('move', i, slot, !!divert); return; }
  const res = ENGINE.applyDie(seat, i, dice[slot]);
  turnCaptures += res.captured.length;
  if (divert && ENGINE.canOfferBM(seat, i)) ENGINE.divertToBM(seat, i);
  used[slot] = true;
  selectedDie = -1;
  playDiceLand();
  if (window.DBG) {
    const cell = ENGINE.cellOf(seat, i);
    DBG.log(`seat${seat} piece${i} die${dice[slot]}${divert ? '+БМ' : ''}: cell ${JSON.stringify(cell)}` +
      `${res.captured.length ? ' CAPTURED ' + JSON.stringify(res.captured) : ''}` +
      `${res.finished ? ' HOME' : ''}`);
  }
  afterMove();
}

// Предложение экспресс-прыжка (кубик 1 — следующая, 3 — противоположная).
function offerExpress(seat, i, slot) {
  expressChoice = { seat, i, slot };
  const ti = ENGINE.onExpress(seat, i);
  const target = ENGINE.expressTarget(seat, i, dice[slot]);
  const label = document.getElementById('express-label');
  if (label) label.textContent = `🚀 Экспресс ${ti} → ${target}?`;
  const stepBtn = document.getElementById('express-step');
  if (stepBtn) {
    stepBtn.style.display = ENGINE.canMove(seat, i, dice[slot], { doubleOne }) ? '' : 'none';
    stepBtn.textContent = `Обычный +${dice[slot]}`;
  }
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
// Подсветить кликабельные клетки выбора БМ: карман БМ (съехать) и текущую клетку (остаться).
function setBMTargets(seat, i) {
  const ti = ENGINE.trackIndex(seat, i);
  const bm = BM_BY_TRACK[ti];
  const cur = ENGINE.cellOf(seat, i);
  window.__movable = new Set([`${seat},${i}`]);
  window.__targets = [
    { kind: 'bmDivert', seat, i, bm, cell: [bm.r, bm.c] },
    { kind: 'bmStay', seat, i, cell: cur },
  ];
}

function offerBM(seat, i) {
  bmChoice = { seat, i };
  setBMTargets(seat, i);
  redrawBoard();
  setStatusMsg(`${PLAYERS[seat].name}: клик по БМ — съехать, по фишке — остаться`);
}

// Применить состояние от сервера (онлайн): зеркалим в ENGINE + локальные переменные.
function applyServerState(s) {
  for (let seat = 0; seat < 4; seat++) {
    for (let i = 0; i < 5; i++) {
      const p = s.pieces[seat][i];
      const e = ENGINE.pieces[seat][i];
      e.where = p.where; e.progress = p.progress; e.bm = p.bm; e.captor = p.captor;
    }
  }
  currentPlayer = s.turn;
  window.__turnSeat = s.turn;
  dice = s.dice.slice();
  used = s.used.slice();
  doubleOne = s.doubleOne;
  karzerOfferNet = (s.karzerSeat >= 0) ? { seat: s.karzerSeat, i: s.karzerI } : null;
  bonusSix = s.bonus.slice();
  if (!rolling) { // показать актуальные грани (например, при позднем подключении)
    const e1 = document.getElementById('d1'), e2 = document.getElementById('d2');
    if (e1 && dice[0]) e1.textContent = FACES[dice[0] - 1];
    if (e2 && dice[1]) e2.textContent = FACES[dice[1] - 1];
  }
  gameOver = (s.phase === 'over');
  const mine = (MP.mySeat === s.turn);
  awaitingMove = (s.phase === 'move' && mine);
  bmChoice = (s.phase === 'bm' && s.bmSeat === MP.mySeat) ? { seat: s.bmSeat, i: s.bmI } : null;

  if (gameOver && s.winner >= 0) {
    window.__movable = new Set(); window.__targets = [];
    setStatusMsg(`🏆 ${PLAYERS[s.winner].name} победил!`);
  } else if (bmChoice) {
    setBMTargets(bmChoice.seat, bmChoice.i);
    setStatusMsg(`${PLAYERS[bmChoice.seat].name}: клик по БМ — съехать, по фишке — остаться`);
  } else if (awaitingMove) {
    selectedDie = -1;
    updateHighlights();
    updateStatus();
  } else {
    window.__movable = new Set(); window.__targets = [];
    updateStatus();
  }
  markDice();
  redrawBoard();
  refreshControls();
}
window.applyServerState = applyServerState;

function resolveBM(divert) {
  if (!bmChoice) return;
  if (isOnline()) { MP.bm(divert); return; }
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

  // Остались ли ходы любым неиспользованным кубиком (или выкуп за 6)?
  const more = firstUsableSlot() >= 0 || (hasUnusedSix() && ENGINE.hasRedeemable(currentPlayer));
  if (more) {
    selectedDie = -1; // кубик автоматически по клику по цели
    updateHighlights();
    updateStatus();
  } else if (bonusPhase) {
    finishBonusPhase(); // бонусные 6 сыграны — теперь обычный бросок, ход не переходит
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

  // Карцер: была возможность срубить, но за весь бросок никого не срубил —
  // первая из фишек, которая могла срубить, отправляется в карцер.
  if (!gameOver && turnCaptures === 0 && rollCaptureChances.length) {
    const j = rollCaptureChances.find((i) => {
      const w = ENGINE.pieces[currentPlayer][i].where;
      return w === 'track' || w === 'lane';
    });
    if (j !== undefined) {
      ENGINE.sendToKarzer(currentPlayer, j);
      if (window.DBG) DBG.log(`seat${currentPlayer} piece${j} -> КАРЦЕР (мог срубить, не срубил)`);
    }
  }
  rollCaptureChances = [];

  // Дубль / срубание / экспресс дают один доп. бросок (не суммируются).
  const why = [];
  if (turnDouble) why.push('дубль');
  if (turnCaptures) why.push('срубил');
  if (expressJumps) why.push('экспресс');
  turnDouble = false; turnCaptures = 0; expressJumps = 0;
  if (why.length && !gameOver) {
    setStatusMsg(`${PLAYERS[currentPlayer].name}: ${why.join(' + ')} — ещё ход!`);
    if (window.DBG) DBG.log(`seat${currentPlayer} EXTRA turn (${why.join('+')})`);
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
  turnDouble = false; doubleOne = false; turnSix = false; gameOver = false;
  turnCaptures = 0; bonusPhase = false; carryCaptures = 0;
  bmChoice = null; expressChoice = null; expressJumps = 0;
  rollCaptureChances = [];
  karzerHandled = false;
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
    const myTurn = MP.mySeat >= 0 && MP.mySeat === currentPlayer;
    disabled = rolling || !(myTurn && MP.phase === 'idle' && !gameOver);
    diceLocked = !awaitingMove || rolling;
    if (MP.mySeat < 0) label = 'Зритель';
    else if (gameOver) label = 'Игра окончена';
    else if (!myTurn) label = 'Не ваш ход';
    else if (MP.phase === 'move') label = 'Ходите фишкой';
    else if (MP.phase === 'rolling') label = '…';
    else if (MP.phase === 'bm') label = 'Выбор БМ';
    else label = 'Бросить';
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
