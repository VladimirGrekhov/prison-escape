// Prison Escape — простой бот для локальной игры («🤖 Бот»). Человек — Игрок 4
// (место 3, низ доски), места 0–2 ведёт компьютер. Бот действует теми же функциями, что и
// клики игрока (onBoardClick/doNormalMove/…), поэтому все правила — рубка,
// карцер, выкуп, точный заход в дом — соблюдаются движком автоматически.
(function () {
  const TICK_MS = 750; // пауза между действиями бота (видно, что происходит)

  function botPreferred() {
    try { return localStorage.getItem('pe-bot') === '1'; } catch (e) { return false; }
  }

  const BOT = window.BOT = { on: false, timer: null };

  function humanSeat() { return 3; } // человек — Игрок 4 (нижнее место)
  function botTurn() { return BOT.on && !isOnline() && currentPlayer !== humanSeat(); }

  // Выигрыш в прогрессе от экспресс-прыжка (может быть отрицательным).
  function expressGain(seat, i, die) {
    const t = ENGINE.expressTarget(seat, i, die);
    if (t < 0) return -1;
    const np = (t - ENTRY[seat] + TRACK.length) % TRACK.length;
    return np - ENGINE.pieces[seat][i].progress;
  }

  // Одно действие бота в фазе хода. Приоритеты: срубить → забрать свою из
  // карцера → точный финиш → выход по 6 → выкуп → лучший обычный ход →
  // сумма → чужая из карцера.
  function botStep() {
    const s = currentPlayer;
    const ctx = { doubleOne };

    // 1) срубить одним кубиком
    for (let k = 0; k < dice.length; k++) {
      if (used[k]) continue;
      for (const i of ENGINE.legalForDie(s, dice[k], ctx)) {
        if (ENGINE.pieces[s][i].where === 'prison') continue;
        if (ENGINE.moveWouldCapture(s, i, dice[k], ctx)) { doNormalMove(s, i, k, false); return; }
      }
    }
    // 2) срубить суммой двух базовых кубиков
    if (dice.length >= 2 && !used[0] && !used[1]) {
      const sum = dice[0] + dice[1];
      for (let i = 0; i < ENGINE.PER_SEAT; i++) {
        if (ENGINE.canMove(s, i, sum, ctx) && ENGINE.moveWouldCapture(s, i, sum, ctx)) {
          doSumMove(s, i, false); return;
        }
      }
    }
    // 3) дубль 1: забрать СВОЮ фишку из карцера
    const ko = karzerOffer();
    if (ko && ko.seat === s) { onBoardClick(ko.seat, ko.i); return; }

    // 4) точный финиш (встать на конец дома)
    for (let k = 0; k < dice.length; k++) {
      if (used[k]) continue;
      for (const i of ENGINE.legalForDie(s, dice[k], ctx)) {
        const p = ENGINE.pieces[s][i];
        if (p.where === 'prison') continue;
        if (p.progress + dice[k] === maxProgressFor(s)) { doNormalMove(s, i, k, false); return; }
      }
    }
    // 5) выход из тюрьмы по 6
    if (hasUnusedSix()) {
      for (const i of ENGINE.legalForDie(s, 6, ctx)) {
        if (ENGINE.pieces[s][i].where === 'prison') { onBoardClick(s, i); return; }
      }
      // 6) выкуп пленной (выхода нет, а 6 есть)
      for (let i = 0; i < ENGINE.PER_SEAT; i++) {
        if (ENGINE.canRedeem(s, i)) { onBoardClick(s, i); return; }
      }
    }
    // 7) лучший обычный ход: двигаем самую продвинутую фишку, кубик побольше
    let best = null;
    for (let k = 0; k < dice.length; k++) {
      if (used[k]) continue;
      for (const i of ENGINE.legalForDie(s, dice[k], ctx)) {
        const p = ENGINE.pieces[s][i];
        if (p.where === 'prison') continue;
        if (!best || p.progress > best.progress ||
            (p.progress === best.progress && dice[k] > dice[best.slot])) {
          best = { i, slot: k, progress: p.progress };
        }
      }
    }
    if (best) {
      const p = ENGINE.pieces[s][best.i];
      // фишка на экспрессе с кубиком 1/3 и выгодным прыжком — кликнуть фишку,
      // появится выбор «экспресс/обычный», его решит следующий тик
      if ((dice[best.slot] === 1 || dice[best.slot] === 3) &&
          ENGINE.onExpress(s, best.i) >= 0 && expressGain(s, best.i, dice[best.slot]) > 0 &&
          p.where === 'track') {
        onBoardClick(s, best.i); return;
      }
      doNormalMove(s, best.i, best.slot, false); return;
    }
    // 8) ход на сумму (одиночные заблокированы, сумма проходит)
    if (dice.length >= 2 && !used[0] && !used[1]) {
      const sum = dice[0] + dice[1];
      for (let i = 0; i < ENGINE.PER_SEAT; i++) {
        if (ENGINE.canMove(s, i, sum, ctx)) { doSumMove(s, i, false); return; }
      }
    }
    // 9) дубль 1: забрать чужую из карцера (других действий нет)
    if (ko) { onBoardClick(ko.seat, ko.i); return; }
  }

  function tick() {
    if (!botTurn() || gameOver || rolling) return;
    // выбор «экспресс или обычный ход»
    if (expressChoice) {
      const { seat, i, slot } = expressChoice;
      if (expressGain(seat, i, dice[slot]) > 0) resolveExpress('express');
      else if (ENGINE.canMove(seat, i, dice[slot], { doubleOne })) resolveExpress('step');
      else resolveExpress('express');
      return;
    }
    if (bmChoice) { resolveBM(false); return; } // (офлайн не встречается)
    if (awaitingMove) { botStep(); return; }
    if (dice.length === 0) onRollClick(); // свой ход — бросить (или бонусные 6)
  }

  function setupButton() {
    const btn = document.getElementById('bot-btn');
    if (!btn) return;
    btn.textContent = BOT.on ? '🤖 Бот: вкл' : '🤖 Бот';
    btn.title = BOT.on ? 'Выключить игру с компьютером' : 'Играть против компьютера (вы — Игрок 4)';
    btn.onclick = () => {
      const next = !botPreferred();
      try {
        localStorage.setItem('pe-bot', next ? '1' : '0');
        if (next) localStorage.setItem('pe-mode', 'offline'); // бот — локальная игра
      } catch (e) {}
      window.location.href = window.location.pathname; // перезагрузка, как mode-btn
    };
  }

  window.addEventListener('load', () => {
    BOT.on = botPreferred();
    setupButton();
    if (BOT.on) BOT.timer = setInterval(tick, TICK_MS);
  });
})();
