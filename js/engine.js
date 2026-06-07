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
        // captor: -1 в своей тюрьме; >=0 — в плену у этого места.
        for (let i = 0; i < PER_SEAT; i++) row.push({ where: 'prison', progress: 0, bm: false, captor: -1 });
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

    // «Прогрессы» своих фишек на доске (маршрут/дорожка; кроме кармана БМ, тюрьмы,
    // дома). У одного места progress однозначно соответствует клетке.
    ownProgressSet(seat, exceptI) {
      const s = new Set();
      const row = this.pieces[seat];
      for (let j = 0; j < PER_SEAT; j++) {
        if (j === exceptI) continue;
        const p = row[j];
        if ((p.where === 'track' && !p.bm) || p.where === 'lane') s.add(p.progress);
      }
      return s;
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
          // пленную фишку сначала надо выкупить (обрабатывается отдельно)
          if (p.captor >= 0) continue;
          // выйти можно по 6, если свой вход «Х» (progress 0) не занят своей фишкой
          if (die === 6 && !this.ownProgressSet(seat, i).has(0)) out.push(i);
          continue;
        }
        // обычный ход, либо экспресс-прыжок (на 1 со стоянки на экспресс-клетке)
        const expressOk = die === 1 && this.onExpress(seat, i) >= 0;
        if (this.canMove(seat, i, die, ctx) || expressOk) out.push(i);
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
        p.bm = false;
      } else {
        const from = p.progress;
        p.progress += die;
        p.bm = false;
        // захват «на пути»: рубим всех чужих на пройденных клетках (кроме безопасных)
        res.captured = this.captureAlongPath(seat, i, from, p.progress);
      }

      if (p.progress >= MAX_PROGRESS) {
        p.where = 'home';
        res.finished = true;
        return res;
      }
      p.where = p.progress < TRACK_MAIN ? 'track' : 'lane';
      return res;
    },

    // Отправить чужую фишку в плен к захватчику.
    _capture(o, captorSeat, out) {
      const t = this.pieces[o.seat][o.i];
      t.where = 'prison'; t.progress = 0; t.bm = false; t.captor = captorSeat;
      out.push(o);
    },

    // Срубить чужих на клетке фишки (seat,i) — для одиночного приземления (экспресс).
    captureAt(seat, i) {
      const captured = [];
      const p = this.pieces[seat][i];
      if (p.where !== 'track' || p.bm) return captured;
      const cell = this.cellOf(seat, i);
      if (cell && !this.isSafeCell(cell[0], cell[1])) {
        for (const o of this.occupantsAt(cell[0], cell[1], seat, i)) {
          if (o.seat !== seat) this._capture(o, seat, captured);
        }
      }
      return captured;
    },

    // Срубить всех чужих на клетках пути (from..to], кроме безопасных.
    captureAlongPath(seat, i, from, to) {
      const captured = [];
      for (let q = from + 1; q <= to; q++) {
        const cell = cellForProgress(seat, q);
        if (!cell || this.isSafeCell(cell[0], cell[1])) continue;
        for (const o of this.occupantsAt(cell[0], cell[1], seat, i)) {
          if (o.seat !== seat) this._capture(o, seat, captured);
        }
      }
      return captured;
    },

    // --- плен / выкуп ---
    canRedeem(seat, i) {
      const p = this.pieces[seat][i];
      return p.where === 'prison' && p.captor >= 0;
    },
    hasRedeemable(seat) {
      return this.pieces[seat].some((p) => p.where === 'prison' && p.captor >= 0);
    },
    // Выкупить свою фишку: возвращается в свою тюрьму. Возвращает место-захватчика.
    redeem(seat, i) {
      const p = this.pieces[seat][i];
      const captor = p.captor;
      p.captor = -1;
      return captor;
    },
    // Фишки, физически находящиеся в тюрьме места `holder` (свои + пленные).
    heldInPrison(holder) {
      const out = [];
      for (let s = 0; s < SEATS; s++) {
        for (let i = 0; i < PER_SEAT; i++) {
          const p = this.pieces[s][i];
          if (p.where !== 'prison') continue;
          const h = p.captor >= 0 ? p.captor : s;
          if (h === holder) out.push({ seat: s, i });
        }
      }
      return out;
    },

    // Стоит ли фишка на экспресс-клетке (вернёт её TRACK-индекс или -1).
    onExpress(seat, i) {
      const p = this.pieces[seat][i];
      if (p.where !== 'track' || p.bm) return -1;
      const ti = (ENTRY[seat] + p.progress) % TRACK.length;
      return (EXPRESS_NEXT[ti] !== undefined) ? ti : -1;
    },

    // Экспресс-прыжок на следующую экспресс-клетку (по кругу).
    expressJump(seat, i) {
      const p = this.pieces[seat][i];
      const ti = (ENTRY[seat] + p.progress) % TRACK.length;
      const target = EXPRESS_NEXT[ti];
      p.progress = (target - ENTRY[seat] + TRACK.length) % TRACK.length;
      p.bm = false;
      return { captured: this.captureAt(seat, i) };
    },

    // Клетка [r,c], куда встанет фишка при обычном ходе на `die` (или null).
    destCellOf(seat, i, die) {
      const p = this.pieces[seat][i];
      if (p.where === 'prison' || p.where === 'home') return null;
      const np = p.progress + die;
      if (np > MAX_PROGRESS) return null;
      return cellForProgress(seat, np);
    },

    // Можно ли сделать обычный ход фишкой (seat,i) на `die` клеток.
    canMove(seat, i, die, ctx) {
      ctx = ctx || {};
      const p = this.pieces[seat][i];
      if (p.where === 'home' || p.where === 'prison') return false;
      const dest = p.progress + die;
      if (dest > MAX_PROGRESS) return false;
      if (p.bm) {
        const ti = (ENTRY[seat] + p.progress) % TRACK.length;
        if (this.opponentAdjacentOnTrack(seat, ti) && !ctx.doubleOne) return false;
      }
      const own = this.ownProgressSet(seat, i);
      for (const q of own) if (q > p.progress && q <= dest) return false;
      return true;
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
