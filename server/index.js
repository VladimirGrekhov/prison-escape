// Prison Escape — authoritative multiplayer server (Colyseus 0.16).
const { Server, Room, LobbyRoom } = require("colyseus");
const { Schema, MapSchema, ArraySchema, defineTypes } = require("@colyseus/schema");

let TOP, createEngine;
try {
  TOP = require("./shared/topology");
  ({ createEngine } = require("./shared/engine"));
} catch (e) {
  TOP = require("../js/topology");
  ({ createEngine } = require("../js/engine"));
}

const MAX_SEATS = 4;
const ROLL_MS = 1500;
const RECONNECT_SEC = 30;

const fs = require("fs");
const path = require("path");
const LOG_FILE = path.join(__dirname, "logs", "client.log");
function serverLog(msg) {
  try { fs.appendFileSync(LOG_FILE, `[srv ${new Date().toISOString().slice(11, 23)}] ${msg}\n`); }
  catch (e) { /* ignore */ }
}

// ---- Helpers -------------------------------------------------------------

function generateCode() {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  let c = '';
  for (let i = 0; i < 5; i++) c += chars[Math.floor(Math.random() * chars.length)];
  return c;
}

// ---- Synchronised state --------------------------------------------------

class Player extends Schema {
  constructor() {
    super();
    this.seat = -1;
    this.name = "";
    this.connected = true;
    this.isBot = false;
  }
}
defineTypes(Player, { seat: "int8", name: "string", connected: "boolean", isBot: "boolean" });

class Piece extends Schema {
  constructor() {
    super();
    this.where = "prison";
    this.progress = 0;
    this.bm = false;
    this.captor = -1;
  }
}
defineTypes(Piece, { where: "string", progress: "uint8", bm: "boolean", captor: "int8" });

class GameState extends Schema {
  constructor() {
    super();
    this.players = new MapSchema();
    this.pieces = new ArraySchema();
    this.turn = 0;
    this.phase = "idle";          // idle | rolling | move | bm | over  (game mechanics)
    this.dice = new ArraySchema();
    this.used = new ArraySchema();
    this.bonus = new ArraySchema();
    this.doubleOne = false;
    this.winner = -1;
    this.bmSeat = -1;
    this.bmI = -1;
    this.karzerSeat = -1;
    this.karzerI = -1;
    this.seq = 0;
    this.rev = 0;
    // lobby / lifecycle
    this.roomPhase = "waiting";   // waiting | starting | playing | finished
    this.countdown = 0;
    this.maxPlayers = 4;
    this.hostSeat = -1;
  }
}
defineTypes(GameState, {
  players: { map: Player },
  pieces: [Piece],
  turn: "int8",
  phase: "string",
  dice: ["uint8"],
  used: ["boolean"],
  bonus: ["uint8"],
  doubleOne: "boolean",
  winner: "int8",
  bmSeat: "int8",
  bmI: "int8",
  karzerSeat: "int8",
  karzerI: "int8",
  seq: "uint32",
  rev: "uint32",
  roomPhase: "string",
  countdown: "uint8",
  maxPlayers: "uint8",
  hostSeat: "int8",
});

// ---- Room ----------------------------------------------------------------

class GameRoom extends Room {
  onCreate(options) {
    this.maxClients = options && options.maxPlayers
      ? Math.min(Math.max(2, options.maxPlayers | 0), MAX_SEATS)
      : MAX_SEATS;
    this.fillBots = !!(options && options.fillBots);
    this.preCreated = !!(options && options.preCreated);
    this.isPrivate = !!(options && options.private);
    this.autoDispose = !this.preCreated;
    this.minPlayers = 2;
    this.hostSessionId = "";
    this._rollTimer = null;
    this._startTimer = null;
    this._emptyTimer = null;
    this._finishedTimer = null;
    this._roomCode = this.isPrivate ? generateCode() : null;

    this._roomName = options && options.roomName
      ? String(options.roomName).slice(0, 24)
      : `Комната ${Math.random().toString(36).slice(2, 6).toUpperCase()}`;

    this.setState(new GameState());
    this.state.maxPlayers = this.maxClients;
    for (let k = 0; k < MAX_SEATS * 5; k++) this.state.pieces.push(new Piece());
    for (let s = 0; s < MAX_SEATS; s++) this.state.bonus.push(0);

    this.engine = createEngine();
    this._resetVars();

    this._syncMeta();

    // ── message handlers ───────────────────────────────────────────────────

    this.onMessage("start", (client) => {
      if (client.sessionId !== this.hostSessionId) return;
      if (this.roomPhase !== "waiting") return;
      if (this.humansCount() >= this.minPlayers) this.toStarting();
    });

    this.onMessage("roll", (c, m) => this.onRoll(c, m));
    this.onMessage("dbgdice", (c, m) => this.onDbgDice(c, m));
    this.onMessage("act", (c, m) => this.onAct(c, m));
    this.onMessage("bm", (c, m) => this.onBm(c, m));
    this.onMessage("name", (c, name) => {
      const p = this.state.players.get(c.sessionId);
      if (p && typeof name === "string") p.name = name.slice(0, 16);
    });
    this.onMessage("reset", () => {
      if (this.roomPhase === "playing" || this.roomPhase === "finished") this.resetGame();
    });

    this.onMessage("rematch", (client) => {
      if (this.roomPhase !== "finished") return;
      if (this.humansCount() < this.minPlayers) return;
      if (this._finishedTimer) { this._finishedTimer.clear(); this._finishedTimer = null; }
      this.removeBots();
      this.toStarting(true);
      serverLog(`room ${this.roomId} rematch by seat${this.seatOf(client)}`);
    });

    this.onMessage("setmax", (client, n) => {
      if (client.sessionId !== this.hostSessionId) return;
      if (this.roomPhase !== "waiting") return;
      const max = Math.min(Math.max(2, n | 0), MAX_SEATS);
      this.maxClients = max;
      this.state.maxPlayers = max;
      this._syncMeta();
      if (this.humansCount() >= max) this.toStarting();
      else this.sync();
    });

    // waiting → dispose если за 90 с не набралось игроков (пресет-комнаты не умирают)
    if (!this.preCreated) {
      this._emptyTimer = this.clock.setTimeout(() => {
        if (this.roomPhase === "waiting" && this.humansCount() < this.minPlayers) {
          serverLog(`room ${this.roomId} empty timeout → disconnect`);
          this.disconnect();
        }
      }, 90_000);
    }

    this.sync();
  }

  // ── metadata ──────────────────────────────────────────────────────────────

  _syncMeta() {
    const byBeat = {};
    for (const [, p] of this.state.players) if (!p.isBot && p.seat >= 0) byBeat[p.seat] = p.name;
    const playerNames = [];
    for (let s = 0; s < this.maxClients; s++) playerNames.push(byBeat[s] || null);
    this.setMetadata({
      name: this._roomName,
      roomPhase: this.state.roomPhase,
      players: this.humansCount(),
      maxPlayers: this.maxClients,
      playerNames,
      code: this._roomCode,
      private: !!this.isPrivate,
    });
  }

  // ── lifecycle ─────────────────────────────────────────────────────────────

  get roomPhase() { return this.state ? this.state.roomPhase : "waiting"; }

  toWaiting() {
    if (this._startTimer) { this._startTimer.clear(); this._startTimer = null; }
    this.state.roomPhase = "waiting";
    this.state.countdown = 0;
    this.removeBots();
    this.unlock();
    this._syncMeta();
    serverLog(`room ${this.roomId} → waiting`);
    this.sync();
  }

  toStarting(force = false) {
    if (!force && this.roomPhase !== "waiting") return;
    if (this._emptyTimer) { this._emptyTimer.clear(); this._emptyTimer = null; }
    this.state.roomPhase = "starting";
    if (this.fillBots) this.fillSeatsWithBots();
    this.lock();
    this._syncMeta();

    let n = 3;
    this.state.countdown = n;
    this._startTimer = this.clock.setInterval(() => {
      n--;
      this.state.countdown = n;
      if (n <= 0) {
        this._startTimer.clear();
        this._startTimer = null;
        this.toPlaying();
      }
    }, 1000);
    serverLog(`room ${this.roomId} → starting (${this.humansCount()} humans)`);
    this.sync();
  }

  toPlaying() {
    this.state.roomPhase = "playing";
    this.state.countdown = 0;
    this._syncMeta();
    this.resetGame();
    serverLog(`room ${this.roomId} → playing`);
    this.sync();
  }

  toFinished(winnerSeat) {
    if (this._startTimer) { this._startTimer.clear(); this._startTimer = null; }
    if (this._finishedTimer) { this._finishedTimer.clear(); this._finishedTimer = null; }
    this.state.roomPhase = "finished";
    this.winner = winnerSeat;
    this.phase = "over";
    this._syncMeta();
    this._finishedTimer = this.clock.setTimeout(() => {
      this._finishedTimer = null;
      if (this.preCreated) { this.removeBots(); this.state.players.clear(); this.unlock(); this.toWaiting(); }
      else this.disconnect();
    }, 15_000);
    serverLog(`room ${this.roomId} → finished (winner seat${winnerSeat})`);
    this.sync();
  }

  // ── join / leave ──────────────────────────────────────────────────────────

  onJoin(client, options) {
    const p = new Player();
    p.seat = this.firstFreeSeat();
    p.name = options && options.name
      ? String(options.name).slice(0, 16)
      : (p.seat >= 0 ? `Игрок ${p.seat + 1}` : "Зритель");
    p.connected = true;
    this.state.players.set(client.sessionId, p);

    // первый игрок = хост
    if (this.humansCount() === 1) {
      this.hostSessionId = client.sessionId;
      this.state.hostSeat = p.seat;
    }

    const humanCount = this.humansCount();
    this._syncMeta();

    client.send("welcome", {
      sessionId: client.sessionId,
      seat: p.seat,
      isHost: client.sessionId === this.hostSessionId,
      code: this._roomCode,
      isPrivate: this.isPrivate,
    });

    if (p.seat >= 0 && !this.occupiedSeats().has(this.turn)) {
      this.turn = p.seat;
    }

    // зал полон → старт
    if (this.roomPhase === "waiting" && humanCount >= this.maxClients) this.toStarting();
    else this.sync();
  }

  async onLeave(client, consented) {
    const p = this.state.players.get(client.sessionId);
    if (p) p.connected = false;

    if (this.roomPhase === "waiting" || this.roomPhase === "starting") {
      // до игры — сразу убираем
      this.removePlayer(client.sessionId);
      if (client.sessionId === this.hostSessionId) this.rotateHost();
      if (this.roomPhase === "starting" && this.humansCount() < this.minPlayers) this.toWaiting();
      else {
        this._syncMeta();
        this.sync();
      }
      return;
    }

    // в игре — ждём реконнект
    try {
      if (consented) throw new Error("left");
      await this.allowReconnection(client, RECONNECT_SEC);
      const back = this.state.players.get(client.sessionId);
      if (back) back.connected = true;
      this.sync();
    } catch (e) {
      this.botify(client.sessionId);
      if (this.humansCount() === 0) {
        if (this.preCreated) {
          serverLog(`room ${this.roomId}: no humans left → reset to waiting`);
          if (this._startTimer) { this._startTimer.clear(); this._startTimer = null; }
          if (this._finishedTimer) { this._finishedTimer.clear(); this._finishedTimer = null; }
          this.removeBots();
          this.state.players.clear();
          this.unlock();
          this.toWaiting();
        } else {
          serverLog(`room ${this.roomId}: no humans left → disconnect`);
          this.disconnect();
        }
      }
      this.sync();
    }
  }

  // ── helpers ───────────────────────────────────────────────────────────────

  humansCount() {
    let n = 0;
    for (const [, p] of this.state.players) if (!p.isBot) n++;
    return n;
  }

  rotateHost() {
    for (const [id, p] of this.state.players) {
      if (!p.isBot) {
        this.hostSessionId = id;
        this.state.hostSeat = p.seat;
        return;
      }
    }
    this.hostSessionId = "";
    this.state.hostSeat = -1;
  }

  fillSeatsWithBots() {
    for (let seat = 0; seat < this.maxClients; seat++) {
      if (!this.seatTaken(seat)) {
        const botId = `bot_${seat}`;
        const b = new Player();
        b.seat = seat;
        b.name = `Бот ${seat + 1}`;
        b.connected = true;
        b.isBot = true;
        this.state.players.set(botId, b);
      }
    }
  }

  removeBots() {
    for (const [id, p] of this.state.players) {
      if (p.isBot) this.state.players.delete(id);
    }
  }

  botify(sessionId) {
    const p = this.state.players.get(sessionId);
    if (!p) return;
    p.isBot = true;
    p.connected = true;
    serverLog(`seat${p.seat} botified`);
  }

  // ── seat helpers ──────────────────────────────────────────────────────────

  seatOf(client) {
    const p = this.state.players.get(client.sessionId);
    return p ? p.seat : -1;
  }
  seatTaken(seat) {
    for (const [, p] of this.state.players) if (p.seat === seat) return true;
    return false;
  }
  firstFreeSeat() {
    for (let s = 0; s < MAX_SEATS; s++) if (!this.seatTaken(s)) return s;
    return -1;
  }
  occupiedSeats() {
    const set = new Set();
    for (const [, p] of this.state.players) if (p.seat >= 0) set.add(p.seat);
    return set;
  }

  // ── turn flow ─────────────────────────────────────────────────────────────

  ctx() { return { doubleOne: this.doubleOne }; }
  hasUnusedSix() { return this.dice.some((d, k) => !this.used[k] && d === 6); }
  firstUsableSlot() {
    for (let k = 0; k < this.dice.length; k++) {
      if (!this.used[k] && this.engine.legalForDie(this.turn, this.dice[k], this.ctx()).length > 0) return k;
    }
    return -1;
  }
  hasAnyAction() {
    if (this.engine.hasAnyMove(this.turn, this.dice, this.ctx())) return true;
    if (this.hasUnusedSix() && this.engine.hasRedeemable(this.turn)) return true;
    return !!this.karzerOffer();
  }
  karzerOffer() {
    if (!this.doubleOne || this.karzerHandled || this.bonusPhase) return null;
    return this.engine.karzerEligible(this.turn);
  }

  onRoll(client, m) {
    if (this.roomPhase !== "playing") return;
    if (this.seatOf(client) !== this.turn) return;
    if (this.phase !== "idle" || this.winner >= 0) return;
    if (!this.occupiedSeats().has(this.turn)) return;

    if (this.bonus[this.turn] > 0) {
      const n = this.bonus[this.turn];
      this.bonus[this.turn] = 0;
      this.dice = [0, 0];
      this.used = [true, true];
      for (let k = 0; k < n; k++) { this.dice.push(6); this.used.push(false); }
      this.doubleOne = false; this.turnDouble = false;
      this.expressJumps = 0; this.turnCaptures = 0;
      if (this.hasAnyAction()) {
        this.bonusPhase = true;
        this.phase = "move";
        serverLog(`--- bonus6 x${n} seat${this.turn} (до броска)`);
        this.sync();
        return;
      }
      serverLog(`seat${this.turn} bonus6 x${n}: нет ходов, сгорают`);
      this.dice = []; this.used = [];
    }

    let a = 1 + Math.floor(Math.random() * 6);
    let b = 1 + Math.floor(Math.random() * 6);
    const forced = Array.isArray(m) ? m.map((d) => d | 0).filter((d) => d >= 1 && d <= 6).slice(0, 2) : [];
    if (forced.length) { a = forced[0]; if (forced.length > 1) b = forced[1]; }
    this.dice = [a, b];
    this.used = [false, false];
    this.turnDouble = (a === b);
    this.doubleOne = (a === 1 && b === 1);
    this.turnSix = (a === 6 || b === 6);
    this.expressJumps = 0;
    this.turnCaptures = this.carryCaptures || 0;
    this.carryCaptures = 0;
    this.phase = "rolling";
    this.state.seq++;
    serverLog(`--- roll seat${this.turn} [${a},${b}]${this.turnDouble ? ' DOUBLE' : ''}${forced.length ? ' FORCED' : ''}`);
    this.karzerHandled = false;
    this.rollCaptureChances = this.engine.captureChances(this.turn, this.dice, this.used, this.ctx());
    this.sync();

    if (this._rollTimer) { this._rollTimer.clear(); this._rollTimer = null; }
    this._rollTimer = this.clock.setTimeout(() => {
      this._rollTimer = null;
      if (!this.hasAnyAction()) { this.endTurn(); }
      else { this.phase = "move"; }
      this.sync();
    }, ROLL_MS);
  }

  onDbgDice(client, m) {
    if (this.roomPhase !== "playing") return;
    if (this.seatOf(client) !== this.turn || this.phase !== "move") return;
    const f = Array.isArray(m) ? m.map((d) => d | 0).filter((d) => d >= 1 && d <= 6).slice(0, 2) : [];
    if (f.length < 2 || this.used[0] || this.used[1] || this.dice.length < 2) return;
    this.dice[0] = f[0]; this.dice[1] = f[1];
    this.turnDouble = (f[0] === f[1]);
    this.doubleOne = (f[0] === 1 && f[1] === 1);
    this.turnSix = (f[0] === 6 || f[1] === 6);
    serverLog(`--- DBG set dice seat${this.turn} [${f[0]},${f[1]}]`);
    this.rollCaptureChances = this.engine.captureChances(this.turn, this.dice, this.used, this.ctx());
    if (!this.hasAnyAction()) this.endTurn();
    this.sync();
  }

  onAct(client, m) {
    if (this.roomPhase !== "playing") return;
    if (this.seatOf(client) !== this.turn || this.phase !== "move" || !m) return;
    const i = m.i | 0, slot = m.slot | 0, kind = m.kind;
    const seat = this.turn;
    const E = this.engine;

    if (kind === "karzer") {
      if (!this.karzerOffer()) return;
      this.karzerHandled = true;
      const rel = E.karzerOnDoubleOne(seat);
      if (rel) serverLog(`seat${seat} КАРЦЕР дубль1: seat${rel.seat} piece${rel.i} ${rel.kind === 'home' ? 'домой' : 'в плен'}`);
      this.used = this.used.map(() => true);
      this.afterMove();
      this.sync();
      return;
    }

    if (slot < 0 || slot >= this.dice.length || this.used[slot]) return;
    const die = this.dice[slot];

    if (kind === "redeem") {
      if (die !== 6 || !E.canRedeem(seat, i)) return;
      const captor = E.redeem(seat, i);
      if (captor >= 0) this.bonus[captor] = (this.bonus[captor] || 0) + 1;
      this.used[slot] = true;
      serverLog(`seat${seat} piece${i} REDEEM from seat${captor}`);
      this.afterMove();
    } else if (kind === "exit") {
      if (!E.legalForDie(seat, die, this.ctx()).includes(i) || E.pieces[seat][i].where !== "prison") return;
      E.applyDie(seat, i, die);
      this.used[slot] = true;
      serverLog(`seat${seat} piece${i} EXIT -> x${seat}`);
      this.afterMove();
    } else if (kind === "express") {
      if ((die !== 1 && die !== 3) || E.onExpress(seat, i) < 0) return;
      const res = E.expressJump(seat, i, die);
      this.turnCaptures += res.captured.length;
      this.used[slot] = true;
      this.expressJumps++;
      serverLog(`seat${seat} piece${i} EXPRESS die${die} -> ${JSON.stringify(E.cellOf(seat, i))}` +
        `${res.captured.length ? ' CAPTURED ' + JSON.stringify(res.captured) : ''}`);
      this.afterMove();
    } else if (kind === "sum") {
      if (this.used[0] || this.used[1] || this.dice.length < 2) return;
      const sum = this.dice[0] + this.dice[1];
      if (!E.canMove(seat, i, sum, this.ctx())) return;
      const res = E.applyDie(seat, i, sum);
      this.turnCaptures += res.captured.length;
      const divert = !!(m.bm) && E.canOfferBM(seat, i);
      if (divert) E.divertToBM(seat, i);
      this.used[0] = true; this.used[1] = true;
      serverLog(`seat${seat} piece${i} SUM ${sum}${divert ? '+БМ' : ''} -> ${JSON.stringify(E.cellOf(seat, i))}` +
        `${res.captured.length ? ' CAPTURED ' + JSON.stringify(res.captured) : ''}${res.finished ? ' HOME' : ''}`);
      this.afterMove();
    } else {
      if (!E.canMove(seat, i, die, this.ctx())) return;
      const res = E.applyDie(seat, i, die);
      this.turnCaptures += res.captured.length;
      const divert = !!(m.bm) && E.canOfferBM(seat, i);
      if (divert) E.divertToBM(seat, i);
      this.used[slot] = true;
      serverLog(`seat${seat} piece${i} die${die}${divert ? '+БМ' : ''} -> ${JSON.stringify(E.cellOf(seat, i))}` +
        `${res.captured.length ? ' CAPTURED ' + JSON.stringify(res.captured) : ''}${res.finished ? ' HOME' : ''}`);
      this.afterMove();
    }
    this.sync();
  }

  onBm(client, m) {
    if (this.roomPhase !== "playing") return;
    if (this.phase !== "bm" || !this.bm || this.seatOf(client) !== this.bm.seat) return;
    if (m && m.divert) this.engine.divertToBM(this.bm.seat, this.bm.i);
    serverLog(`seat${this.bm.seat} piece${this.bm.i} ${m && m.divert ? '-> БМ' : 'остаётся'}`);
    this.bm = null;
    this.phase = "move";
    this.afterMove();
    this.sync();
  }

  afterMove() {
    const w = this.engine.winner();
    if (w >= 0) { this.toFinished(w); return; }
    const next = this.firstUsableSlot();
    if (next >= 0) { this.phase = "move"; return; }
    if (this.hasUnusedSix() && this.engine.hasRedeemable(this.turn)) { this.phase = "move"; return; }
    if (this.bonusPhase) {
      this.bonusPhase = false;
      this.carryCaptures = this.turnCaptures; this.turnCaptures = 0;
      this.dice = []; this.used = [];
      this.phase = "idle";
      serverLog(`seat${this.turn} bonus6 done — бросай`);
      return;
    }
    this.endTurn();
  }

  endTurn() {
    if (this.winner < 0 && this.turnCaptures === 0 && this.rollCaptureChances.length) {
      const j = this.rollCaptureChances.find((i) => {
        const w = this.engine.pieces[this.turn][i].where;
        return w === "track" || w === "lane";
      });
      if (j !== undefined) {
        this.engine.sendToKarzer(this.turn, j);
        serverLog(`seat${this.turn} piece${j} -> КАРЦЕР (мог срубить, не срубил)`);
      }
    }
    this.rollCaptureChances = [];
    this.dice = [];
    this.used = [];
    this.bm = null;
    this.phase = "idle";
    const why = [];
    if (this.turnDouble) why.push("дубль");
    if (this.turnCaptures) why.push("срубил");
    if (this.expressJumps) why.push("экспресс");
    this.turnDouble = false; this.turnCaptures = 0; this.expressJumps = 0;
    if (why.length) {
      serverLog(`seat${this.turn} EXTRA turn (${why.join('+')})`);
      return;
    }
    this.advanceTurn();
    serverLog(`turn -> seat${this.turn}`);
  }

  advanceTurn() {
    const occ = this.occupiedSeats();
    if (occ.size === 0) return;
    let t = this.turn;
    for (let k = 0; k < MAX_SEATS; k++) {
      t = (t + 1) % MAX_SEATS;
      if (occ.has(t)) { this.turn = t; return; }
    }
  }

  sync() {
    for (let s = 0; s < MAX_SEATS; s++) {
      for (let i = 0; i < 5; i++) {
        const p = this.engine.pieces[s][i];
        const sp = this.state.pieces[s * 5 + i];
        sp.where = p.where; sp.progress = p.progress; sp.bm = p.bm; sp.captor = p.captor;
      }
      this.state.bonus[s] = this.bonus[s] || 0;
    }
    this.state.dice.splice(0);
    this.dice.forEach((d) => this.state.dice.push(d));
    this.state.used.splice(0);
    this.used.forEach((u) => this.state.used.push(u));
    this.state.turn = this.turn;
    this.state.phase = this.phase;
    this.state.doubleOne = this.doubleOne;
    this.state.winner = this.winner;
    this.state.bmSeat = this.bm ? this.bm.seat : -1;
    this.state.bmI = this.bm ? this.bm.i : -1;
    const ko = (this.phase === "move") ? this.karzerOffer() : null;
    this.state.karzerSeat = ko ? ko.seat : -1;
    this.state.karzerI = ko ? ko.i : -1;
    this.state.rev = (this.state.rev + 1) >>> 0;
  }

  resetGame() {
    if (this._rollTimer) { this._rollTimer.clear(); this._rollTimer = null; }
    this.engine.newGame();
    this._resetVars();
    const occ = [...this.occupiedSeats()].sort((x, y) => x - y);
    this.turn = occ.length ? occ[0] : 0;
    this.sync();
  }

  _resetVars() {
    this.dice = []; this.used = []; this.bonus = [0, 0, 0, 0];
    this.doubleOne = false; this.turnDouble = false; this.turnSix = false; this.expressJumps = 0;
    this.turnCaptures = 0; this.bonusPhase = false; this.carryCaptures = 0;
    this.rollCaptureChances = [];
    this.karzerHandled = false;
    this.bm = null; this.winner = -1; this.phase = "idle";
    this.turn = 0;
  }

  freeSeat(seat) {
    for (let i = 0; i < 5; i++) {
      const p = this.engine.pieces[seat][i];
      p.where = "prison"; p.progress = 0; p.bm = false; p.captor = -1;
    }
    for (let s = 0; s < MAX_SEATS; s++) {
      for (let i = 0; i < 5; i++) {
        const p = this.engine.pieces[s][i];
        if (p.captor === seat) p.captor = -1;
      }
    }
    this.bonus[seat] = 0;
  }

  removePlayer(sessionId) {
    const p = this.state.players.get(sessionId);
    if (!p) return;
    const seat = p.seat;
    const wasTurn = seat === this.turn;
    this.state.players.delete(sessionId);
    if (seat >= 0 && this.roomPhase === "playing") this.freeSeat(seat);

    const occ = this.occupiedSeats();
    if (occ.size === 0) { this.resetGame(); return; }
    if (wasTurn && this.roomPhase === "playing") {
      if (this._rollTimer) { this._rollTimer.clear(); this._rollTimer = null; }
      this.dice = []; this.used = []; this.bm = null; this.phase = "idle";
      if (!occ.has(this.turn)) this.advanceTurn();
    }
    this.sync();
  }
}

// ---- Boot ----------------------------------------------------------------

const { matchMaker } = require("colyseus");

const PRESET_NAMES = ["Комната 1", "Комната 2"];
// roomId → имя; обновляется при создании/гибели
const presetRooms = new Map();

async function ensurePresetRooms() {
  try {
    const rooms = await matchMaker.query({ name: "prison" });
    const existingIds = new Set(rooms.map((r) => r.roomId));
    // убираем умершие пресеты
    for (const id of presetRooms.keys()) if (!existingIds.has(id)) presetRooms.delete(id);
    // создаём только если нужен конкретный слот
    for (let i = 0; i < PRESET_NAMES.length; i++) {
      const name = PRESET_NAMES[i];
      const already = [...presetRooms.values()].includes(name);
      if (already) continue;
      const r = await matchMaker.createRoom("prison", {
        roomName: name, maxPlayers: 4, fillBots: false, preCreated: true,
      });
      presetRooms.set(r.roomId, name);
      serverLog(`preset room created: "${name}" ${r.roomId}`);
    }
  } catch (e) {
    console.warn("ensurePresetRooms:", e && e.message);
  }
}

const port = Number(process.env.PORT) || 2567;
const host = process.env.HOST || "127.0.0.1";
const gameServer = new Server();
gameServer.define("lobby", LobbyRoom);
gameServer.define("prison", GameRoom);
gameServer.listen(port, host).then(async () => {
  console.log(`Prison Escape multiplayer listening on ws://${host}:${port}`);
  await ensurePresetRooms();
  // проверяем каждые 30 с — если пресет-комната умерла, пересоздаём
  setInterval(ensurePresetRooms, 30_000);
});

// ---- Debug log sink ------------------------------------------------------
const http = require("http");
const LOG_PORT = Number(process.env.LOG_PORT) || 2568;
const MAX_BODY = 64 * 1024;
const MAX_FILE = 5 * 1024 * 1024;

http.createServer((req, res) => {
  // GET /find?code=XXXXX — поиск приватной комнаты по коду
  if (req.method === "GET" && req.url.startsWith("/find")) {
    const code = (new URL(req.url, "http://localhost").searchParams.get("code") || "").toUpperCase().slice(0, 6);
    matchMaker.query({ name: "prison" }).then((rooms) => {
      const room = rooms.find((r) => r.metadata && r.metadata.code === code && r.metadata.roomPhase === "waiting");
      res.writeHead(room ? 200 : 404, { "Content-Type": "application/json" });
      res.end(JSON.stringify(room ? { roomId: room.roomId } : {}));
    }).catch(() => { res.writeHead(500); res.end("{}"); });
    return;
  }
  if (req.method !== "POST") { res.writeHead(405); return res.end(); }
  let body = "", aborted = false;
  req.on("data", (chunk) => {
    body += chunk;
    if (body.length > MAX_BODY) { aborted = true; req.destroy(); }
  });
  req.on("end", () => {
    if (aborted) return;
    try {
      if (fs.existsSync(LOG_FILE) && fs.statSync(LOG_FILE).size > MAX_FILE) {
        fs.writeFileSync(LOG_FILE, "");
      }
      fs.appendFileSync(LOG_FILE, body.replace(/\s+$/, "") + "\n");
    } catch (e) { /* ignore */ }
    res.writeHead(204); res.end();
  });
}).listen(LOG_PORT, host, () => console.log(`Log sink on http://${host}:${LOG_PORT}`));
