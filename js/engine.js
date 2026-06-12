// Prison Escape — чистая логика игры (без DOM). Работает в браузере
// (window.ENGINE) и в Node-сервере (require -> createEngine()). Топология берётся
// из topology.js (глобали в браузере, require в Node).
(function (root, factory) {
  const TOP = (typeof module !== 'undefined' && module.exports)
    ? require('./topology') : root;
  const api = factory(TOP);
  if (typeof module !== 'undefined' && module.exports) {
    module.exports = api;
  } else {
    root.createEngine = api.createEngine;
    root.ENGINE = api.createEngine(); // единственный экземпляр для клиента
  }
})(typeof self !== 'undefined' ? self : this, function (TOP) {
  const { TRACK, ENTRY, HOME_LANE, TRACK_MAIN, MAX_PROGRESS, SAFE, BM_BY_TRACK, EXPRESS_NEXT, EXPRESS_ACROSS } = TOP;
  // Карта экспресс-прыжка для кубика: 1 — следующая по кругу, 3 — противоположная.
  const expressMapFor = (die) => (die === 1 ? EXPRESS_NEXT : die === 3 ? EXPRESS_ACROSS : null);
  const SEATS = 4;
  const PER_SEAT = 5;

  // [row, col] по «прогрессу»: 0 = вход (рисуется на «Х»), далее петля, затем дорожка.
  function cellForProgress(seat, progress) {
    if (progress < 0) return null;
    if (progress < TRACK_MAIN) return TRACK[(ENTRY[seat] + progress) % TRACK.length];
    const lane = HOME_LANE[seat];
    const laneIdx = progress - TRACK_MAIN;
    return laneIdx < lane.length ? lane[laneIdx] : null;
  }

  function createEngine() {
    const ENGINE = {
      SEATS,
      PER_SEAT,
      pieces: [], // pieces[seat][i] = { where, progress, bm, captor }

      newGame() {
        this.pieces = [];
        for (let s = 0; s < SEATS; s++) {
          const row = [];
          for (let i = 0; i < PER_SEAT; i++) row.push({ where: 'prison', progress: 0, bm: false, captor: -1 });
          this.pieces.push(row);
        }
      },

      cellOf(seat, i) {
        const p = this.pieces[seat][i];
        if (p.where === 'prison' || p.where === 'home') return null;
        if (p.bm) {
          const b = BM_BY_TRACK[(ENTRY[seat] + p.progress) % TRACK.length];
          if (b) return [b.r, b.c];
        }
        return cellForProgress(seat, p.progress);
      },

      trackIndex(seat, i) {
        const p = this.pieces[seat][i];
        if (p.where !== 'track') return -1;
        return (ENTRY[seat] + p.progress) % TRACK.length;
      },

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

      opponentAdjacentOnTrack(seat, trackIdx) {
        const L = TRACK.length;
        for (const ni of [(trackIdx + 1) % L, (trackIdx - 1 + L) % L]) {
          const [r, c] = TRACK[ni];
          if (this.occupantsAt(r, c, seat, -1).some((o) => o.seat !== seat)) return true;
        }
        return false;
      },

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

      legalForDie(seat, die, ctx) {
        ctx = ctx || {};
        const out = [];
        const row = this.pieces[seat];
        for (let i = 0; i < PER_SEAT; i++) {
          const p = row[i];
          if (p.where === 'home') continue;
          if (p.where === 'prison') {
            if (p.captor >= 0) continue; // пленную сначала выкупить
            if (die === 6 && !this.ownProgressSet(seat, i).has(0)) out.push(i);
            continue;
          }
          const expressOk = !!expressMapFor(die) && this.onExpress(seat, i) >= 0;
          if (this.canMove(seat, i, die, ctx) || expressOk) out.push(i);
        }
        return out;
      },

      applyDie(seat, i, die) {
        const p = this.pieces[seat][i];
        const res = { captured: [], finished: false };
        if (p.where === 'prison') {
          p.where = 'track';
          p.progress = 0;
          p.bm = false;
        } else {
          const from = p.progress;
          p.progress += die;
          p.bm = false;
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

      _capture(o, captorSeat, out) {
        const t = this.pieces[o.seat][o.i];
        t.where = 'prison'; t.progress = 0; t.bm = false; t.captor = captorSeat;
        out.push(o);
      },

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

      canRedeem(seat, i) {
        const p = this.pieces[seat][i];
        return p.where === 'prison' && p.captor >= 0;
      },
      hasRedeemable(seat) {
        return this.pieces[seat].some((p) => p.where === 'prison' && p.captor >= 0);
      },
      redeem(seat, i) {
        const p = this.pieces[seat][i];
        const captor = p.captor;
        p.captor = -1;
        return captor;
      },
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

      onExpress(seat, i) {
        const p = this.pieces[seat][i];
        if (p.where !== 'track' || p.bm) return -1;
        const ti = (ENTRY[seat] + p.progress) % TRACK.length;
        return (EXPRESS_NEXT[ti] !== undefined) ? ti : -1;
      },
      expressJump(seat, i, die) {
        const p = this.pieces[seat][i];
        const ti = (ENTRY[seat] + p.progress) % TRACK.length;
        const map = expressMapFor(die) || EXPRESS_NEXT;
        const target = map[ti];
        p.progress = (target - ENTRY[seat] + TRACK.length) % TRACK.length;
        p.bm = false;
        return { captured: this.captureAt(seat, i) };
      },
      // Куда прыгнет экспресс с этим кубиком (track-индекс цели) или -1.
      expressTarget(seat, i, die) {
        const map = expressMapFor(die);
        const ti = this.onExpress(seat, i);
        return (map && ti >= 0) ? map[ti] : -1;
      },

      destCellOf(seat, i, die) {
        const p = this.pieces[seat][i];
        if (p.where === 'prison' || p.where === 'home') return null;
        const np = p.progress + die;
        if (np > MAX_PROGRESS) return null;
        return cellForProgress(seat, np);
      },

      // Клетка по «прогрессу» для места (для комбинированной цели выход+ход).
      cellAtProgress(seat, progress) { return cellForProgress(seat, progress); },

      // Если ход на `die` заканчивается напротив БМ — вернуть этот БМ (иначе null).
      bmAfterMove(seat, i, die) {
        const p = this.pieces[seat][i];
        if (p.where === 'prison' || p.where === 'home') return null;
        const np = p.progress + die;
        if (np < 1 || np >= TRACK_MAIN) return null; // БМ только на петле
        return BM_BY_TRACK[(ENTRY[seat] + np) % TRACK.length] || null;
      },

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

      canOfferBM(seat, i) {
        const p = this.pieces[seat][i];
        if (p.where !== 'track' || p.bm) return false;
        return !!BM_BY_TRACK[(ENTRY[seat] + p.progress) % TRACK.length];
      },
      divertToBM(seat, i) { this.pieces[seat][i].bm = true; },

      hasAnyMove(seat, dice, ctx) {
        return dice.some((d) => this.legalForDie(seat, d, ctx).length > 0);
      },
      prisonCount(seat) {
        return this.pieces[seat].filter((p) => p.where === 'prison').length;
      },
      winner() {
        for (let s = 0; s < SEATS; s++) {
          if (this.pieces[s].every((p) => p.where === 'home')) return s;
        }
        return -1;
      },
    };

    ENGINE.newGame();
    return ENGINE;
  }

  return { createEngine };
});
