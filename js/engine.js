// Prison Escape — чистая логика игры (без DOM).
// Использует топологию из board.js: TRACK, ENTRY, HOME_LANE, TRACK_MAIN,
// MAX_PROGRESS, SAFE. Состояние хранит сам движок; game.js его двигает,
// board.js отрисовывает.
(function () {
  const SEATS = 4;
  const PER_SEAT = 5;

  // [row, col] клетки по «прогрессу» фишки. progress 0 = вход (рисуется на «Х»),
  // далее по петле, затем — домашняя дорожка. Ход на N кубика = вход+N.
  function cellForProgress(seat, progress) {
    if (progress < 0) return null;
    if (progress < TRACK_MAIN) {
      return TRACK[(ENTRY[seat] + progress) % TRACK.length];
    }
    const lane = HOME_LANE[seat];
    const laneIdx = progress - TRACK_MAIN;
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
        for (let i = 0; i < PER_SEAT; i++) row.push({ where: 'prison', progress: 0, bm: false });
        this.pieces.push(row);
      }
    },

    // Клетка [r,c] фишки, либо null (в тюрьме / дома). Фишка «на БМ» стоит в кармане.
    cellOf(seat, i) {
      const p = this.pieces[seat][i];
      if (p.where === 'prison' || p.where === 'home') return null;
      if (p.bm) {
        const b = BM_BY_TRACK[(ENTRY[seat] + p.progress) % TRACK.length];
        if (b) return [b.r, b.c];
      }
      return cellForProgress(seat, p.progress);
    },

    // Индекс клетки в TRACK (или -1, если фишка не на петле).
    trackIndex(seat, i) {
      const p = this.pieces[seat][i];
      if (p.where !== 'track') return -1;
      return (ENTRY[seat] + p.progress) % TRACK.length;
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
        // Блокировка БМ: стоишь на БМ и рядом противник — выйти нельзя (кроме дубля 1).
        if (p.bm) {
          const ti = (ENTRY[seat] + p.progress) % TRACK.length;
          if (this.opponentAdjacentOnTrack(seat, ti) && !ctx.doubleOne) continue;
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
      p.bm = false; // сходя, фишка возвращается с БМ на маршрут

      if (p.progress >= MAX_PROGRESS) {
        p.where = 'home';
        res.finished = true;
        return res;
      }
      p.where = p.progress < TRACK_MAIN ? 'track' : 'lane';

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

    // Можно ли фишке предложить съезд на БМ (стоит на маршруте напротив БМ).
    canOfferBM(seat, i) {
      const p = this.pieces[seat][i];
      if (p.where !== 'track' || p.bm) return false;
      return !!BM_BY_TRACK[(ENTRY[seat] + p.progress) % TRACK.length];
    },

    divertToBM(seat, i) { this.pieces[seat][i].bm = true; },

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
