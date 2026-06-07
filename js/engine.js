// Prison Escape — чистая логика игры (без DOM).
// Использует топологию из board.js: TRACK, ENTRY, HOME_LANE, TRACK_MAIN,
// MAX_PROGRESS, SAFE. Состояние хранит сам движок; game.js его двигает,
// board.js отрисовывает.
(function () {
  const SEATS = 4;
  const PER_SEAT = 5;

  // [row, col] клетки по «прогрессу» фишки. progress 0 = кружок «Х» (старт),
  // 1..TRACK_MAIN — петля, далее — домашняя дорожка.
  function cellForProgress(seat, progress) {
    if (progress <= 0) return X_GRID[seat];     // стоит на «Х»
    const onTrack = progress - 1;
    if (onTrack < TRACK_MAIN) {
      return TRACK[(ENTRY[seat] + onTrack) % TRACK.length];
    }
    const lane = HOME_LANE[seat];
    const laneIdx = onTrack - TRACK_MAIN;
    return laneIdx < lane.length ? lane[laneIdx] : null;
  }

  const ENGINE = window.ENGINE = {
    SEATS,
    PER_SEAT,
    pieces: [], // pieces[seat][i] = { where:'prison'|'track'|'lane'|'home', progress }

    newGame() {
      this.pieces = [];
      for (let s = 0; s < SEATS; s++) {
        const row = [];
        for (let i = 0; i < PER_SEAT; i++) row.push({ where: 'prison', progress: 0 });
        this.pieces.push(row);
      }
    },

    // Клетка [r,c] фишки, либо null (в тюрьме / дома).
    cellOf(seat, i) {
      const p = this.pieces[seat][i];
      if (p.where === 'prison' || p.where === 'home') return null;
      return cellForProgress(seat, p.progress);
    },

    // Индекс клетки в TRACK (или -1, если фишка на «Х» / не на петле).
    trackIndex(seat, i) {
      const p = this.pieces[seat][i];
      if (p.where !== 'track' || p.progress < 1) return -1;
      return (ENTRY[seat] + p.progress - 1) % TRACK.length;
    },

    // Фишки на клетке [r,c] (только на маршруте/дорожке), кроме указанной.
    occupantsAt(r, c, exceptSeat, exceptI) {
      const out = [];
      for (let s = 0; s < SEATS; s++) {
        for (let i = 0; i < PER_SEAT; i++) {
          if (s === exceptSeat && i === exceptI) continue;
          const cell = this.cellOf(s, i);
          if (cell && cell[0] === r && cell[1] === c) out.push({ seat: s, i });
        }
      }
      return out;
    },

    isSafeCell(r, c) { return SAFE.has(`${r},${c}`); },

    // Есть ли фишка противника на соседней клетке петли (±1) — блокировка БМ.
    opponentAdjacentOnTrack(seat, trackIdx) {
      const L = TRACK.length;
      for (const ni of [(trackIdx + 1) % L, (trackIdx - 1 + L) % L]) {
        const [r, c] = TRACK[ni];
        if (this.occupantsAt(r, c, seat, -1).some(o => o.seat !== seat)) return true;
      }
      return false;
    },

    // Индексы фишек места, которыми можно сходить значением кубика `die`.
    // ctx.doubleOne — выпал дубль 1 (снимает блокировку БМ).
    legalForDie(seat, die, ctx) {
      ctx = ctx || {};
      const out = [];
      const row = this.pieces[seat];
      for (let i = 0; i < PER_SEAT; i++) {
        const p = row[i];
        if (p.where === 'home') continue;
        if (p.where === 'prison') {
          if (die === 6) out.push(i); // выйти можно только по 6
          continue;
        }
        if (p.progress + die > MAX_PROGRESS) continue; // нужно точное число для дома
        if (p.where === 'track' && p.progress >= 1) {
          const ti = this.trackIndex(seat, i);
          const [r, c] = TRACK[ti];
          if (this.isSafeCell(r, c) && this.opponentAdjacentOnTrack(seat, ti) && !ctx.doubleOne) {
            continue; // заблокирован у БМ (снимается дублем 1)
          }
        }
        out.push(i);
      }
      return out;
    },

    // Применить кубик к фишке. → { captured:[{seat,i}], finished:bool }.
    applyDie(seat, i, die) {
      const p = this.pieces[seat][i];
      const res = { captured: [], finished: false };

      if (p.where === 'prison') {
        p.where = 'track';
        p.progress = 0; // встать на кружок «Х» (6 «тратится» на выход)
      } else {
        p.progress += die;
      }

      if (p.progress >= MAX_PROGRESS) {
        p.where = 'home';
        res.finished = true;
        return res;
      }
      p.where = p.progress <= TRACK_MAIN ? 'track' : 'lane';

      // Захват: только на небезопасной клетке петли.
      if (p.where === 'track') {
        const cell = this.cellOf(seat, i);
        if (cell && !this.isSafeCell(cell[0], cell[1])) {
          for (const o of this.occupantsAt(cell[0], cell[1], seat, i)) {
            if (o.seat !== seat) {
              this.pieces[o.seat][o.i] = { where: 'prison', progress: 0 };
              res.captured.push(o);
            }
          }
        }
      }
      return res;
    },

    hasAnyMove(seat, dice, ctx) {
      return dice.some(d => this.legalForDie(seat, d, ctx).length > 0);
    },

    prisonCount(seat) {
      return this.pieces[seat].filter(p => p.where === 'prison').length;
    },

    winner() {
      for (let s = 0; s < SEATS; s++) {
        if (this.pieces[s].every(p => p.where === 'home')) return s;
      }
      return -1;
    },
  };

  ENGINE.newGame();
})();
