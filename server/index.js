// Prison Escape — authoritative multiplayer server (Colyseus 0.16).
//
// The server runs the SAME game engine as the browser (js/engine.js + js/topology.js,
// copied to ./shared on deploy) and is authoritative: clients send intents
// (roll / act / bm) and render the synchronised state.
const { Server, Room } = require("colyseus");
const { Schema, MapSchema, ArraySchema, defineTypes } = require("@colyseus/schema");

// Shared engine/topology: ./shared in production (/opt), ../js when run from the repo.
let TOP, createEngine;
try {
  TOP = require("./shared/topology");
  ({ createEngine } = require("./shared/engine"));
} catch (e) {
  TOP = require("../js/topology");
  ({ createEngine } = require("../js/engine"));
}

const MAX_SEATS = 4;
const ROLL_MS = 1500;      // dice "fly" lock (matches client animation)
const RECONNECT_SEC = 30;

// Серверный лог (онлайн-игры) — в тот же файл, что и клиентский ?debug=1.
const fs = require("fs");
const path = require("path");
const LOG_FILE = path.join(__dirname, "logs", "client.log");
function serverLog(msg) {
  try { fs.appendFileSync(LOG_FILE, `[srv ${new Date().toISOString().slice(11, 23)}] ${msg}\n`); }
  catch (e) { /* ignore */ }
}

// ---- Synchronised state --------------------------------------------------

class Player extends Schema {
  constructor() {
    super();
    this.seat = -1;
    this.name = "";
    this.connected = true;
  }
}
defineTypes(Player, { seat: "int8", name: "string", connected: "boolean" });

class Piece extends Schema {
  constructor() {
    super();
    this.where = "prison";   // prison | track | lane | home
    this.progress = 0;
    this.bm = false;
    this.captor = -1;        // -1 own prison; >=0 held captive by that seat
  }
}
defineTypes(Piece, { where: "string", progress: "uint8", bm: "boolean", captor: "int8" });

class GameState extends Schema {
  constructor() {
    super();
    this.players = new MapSchema(); // sessionId -> Player
    this.pieces = new ArraySchema(); // 20 Piece (index = seat*5 + i)
    this.turn = 0;
    this.phase = "idle";            // idle | rolling | move | bm | over
    this.dice = new ArraySchema();  // current roll values (incl. bonus 6s)
    this.used = new ArraySchema();  // per-die spent flags
    this.bonus = new ArraySchema(); // pending bonus 6s per seat (4)
    this.doubleOne = false;
    this.winner = -1;
    this.bmSeat = -1;               // pending БМ divert decision
    this.bmI = -1;
    this.seq = 0;                   // bumps on each roll -> dice animation
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
  seq: "uint32",
});

// ---- Room ----------------------------------------------------------------

class GameRoom extends Room {
  onCreate() {
    this.maxClients = 16;
    this.setState(new GameState());
    for (let k = 0; k < MAX_SEATS * 5; k++) this.state.pieces.push(new Piece());
    for (let s = 0; s < MAX_SEATS; s++) this.state.bonus.push(0);

    this.engine = createEngine();
    this.turn = 0;
    this.phase = "idle";
    this.dice = [];
    this.used = [];
    this.bonus = [0, 0, 0, 0];
    this.doubleOne = false;
    this.turnDouble = false;
    this.expressUsed = false;
    this.bm = null;
    this.winner = -1;
    this.sync();

    this.onMessage("roll", (c) => this.onRoll(c));
    this.onMessage("act", (c, m) => this.onAct(c, m));
    this.onMessage("bm", (c, m) => this.onBm(c, m));
    this.onMessage("name", (c, name) => {
      const p = this.state.players.get(c.sessionId);
      if (p && typeof name === "string") p.name = name.slice(0, 16);
    });
    this.onMessage("reset", () => this.resetGame());
  }

  // --- seat helpers ---
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

  onJoin(client, options) {
    const p = new Player();
    p.seat = this.firstFreeSeat();
    p.name = options && options.name
      ? String(options.name).slice(0, 16)
      : (p.seat >= 0 ? `Игрок ${p.seat + 1}` : "Зритель");
    p.connected = true;
    this.state.players.set(client.sessionId, p);

    if (p.seat >= 0 && !this.occupiedSeats().has(this.turn)) {
      this.turn = p.seat;
      this.sync();
    }
    client.send("welcome", { sessionId: client.sessionId, seat: p.seat });
  }

  // --- turn flow (ported from the offline client) ---
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
    return this.hasUnusedSix() && this.engine.hasRedeemable(this.turn);
  }

  onRoll(client) {
    if (this.seatOf(client) !== this.turn) return;
    if (this.phase !== "idle" || this.winner >= 0) return;
    if (!this.occupiedSeats().has(this.turn)) return;

    const a = 1 + Math.floor(Math.random() * 6);
    const b = 1 + Math.floor(Math.random() * 6);
    this.dice = [a, b];
    this.used = [false, false];
    const bonus = this.bonus[this.turn] || 0;
    for (let k = 0; k < bonus; k++) { this.dice.push(6); this.used.push(false); }
    this.bonus[this.turn] = 0;
    this.turnDouble = (a === b);
    this.doubleOne = (a === 1 && b === 1);
    this.expressUsed = false;
    this.phase = "rolling";
    this.state.seq++;
    serverLog(`--- roll seat${this.turn} [${a},${b}]${this.turnDouble ? ' DOUBLE' : ''}${bonus ? ' +bonus6x' + bonus : ''}`);
    this.sync();

    if (this._rollTimer) clearTimeout(this._rollTimer);
    this._rollTimer = setTimeout(() => {
      if (!this.hasAnyAction()) { this.endTurn(); }
      else { this.phase = "move"; }
      this.sync();
    }, ROLL_MS);
  }

  onAct(client, m) {
    if (this.seatOf(client) !== this.turn || this.phase !== "move" || !m) return;
    const i = m.i | 0, slot = m.slot | 0, kind = m.kind;
    if (slot < 0 || slot >= this.dice.length || this.used[slot]) return;
    const die = this.dice[slot];
    const seat = this.turn;
    const E = this.engine;

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
      if (die !== 1 || E.onExpress(seat, i) < 0) return;
      E.expressJump(seat, i);
      this.used[slot] = true;
      this.expressUsed = true;
      serverLog(`seat${seat} piece${i} EXPRESS`);
      this.afterMove();
    } else { // move (m.bm = сразу съехать на БМ, если ход закончился напротив него)
      if (!E.canMove(seat, i, die, this.ctx())) return;
      const res = E.applyDie(seat, i, die);
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
    if (w >= 0) { this.winner = w; this.phase = "over"; serverLog(`WINNER seat${w}`); return; }
    const next = this.firstUsableSlot();
    if (next >= 0) { this.phase = "move"; return; }
    if (this.hasUnusedSix() && this.engine.hasRedeemable(this.turn)) { this.phase = "move"; return; }
    this.endTurn();
  }

  endTurn() {
    this.dice = [];
    this.used = [];
    this.bm = null;
    this.phase = "idle";
    if (this.turnDouble || this.expressUsed) { serverLog(`seat${this.turn} EXTRA turn`); return; }
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

  // Mirror engine + turn state into the synchronised schema.
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
  }

  resetGame() {
    if (this._rollTimer) clearTimeout(this._rollTimer);
    this.engine.newGame();
    this.dice = []; this.used = []; this.bonus = [0, 0, 0, 0];
    this.doubleOne = false; this.turnDouble = false; this.expressUsed = false;
    this.bm = null; this.winner = -1; this.phase = "idle";
    const occ = [...this.occupiedSeats()].sort((x, y) => x - y);
    this.turn = occ.length ? occ[0] : 0;
    this.sync();
  }

  // A seat's player is gone: reset its pieces to prison and free its captives.
  freeSeat(seat) {
    for (let i = 0; i < 5; i++) {
      const p = this.engine.pieces[seat][i];
      p.where = "prison"; p.progress = 0; p.bm = false; p.captor = -1;
    }
    for (let s = 0; s < MAX_SEATS; s++) {
      for (let i = 0; i < 5; i++) {
        const p = this.engine.pieces[s][i];
        if (p.captor === seat) p.captor = -1; // освободить пленных
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
    if (seat >= 0) this.freeSeat(seat);

    const occ = this.occupiedSeats();
    if (occ.size === 0) { this.resetGame(); return; }
    if (wasTurn) {
      if (this._rollTimer) clearTimeout(this._rollTimer);
      this.dice = []; this.used = []; this.bm = null; this.phase = "idle";
      if (!occ.has(this.turn)) this.advanceTurn();
    }
    this.sync();
  }

  async onLeave(client, consented) {
    const p = this.state.players.get(client.sessionId);
    if (p) p.connected = false;
    try {
      if (consented) throw new Error("left");
      await this.allowReconnection(client, RECONNECT_SEC);
      const back = this.state.players.get(client.sessionId);
      if (back) back.connected = true;
    } catch (e) {
      this.removePlayer(client.sessionId);
    }
  }
}

// ---- Boot ----------------------------------------------------------------

const port = Number(process.env.PORT) || 2567;
const host = process.env.HOST || "127.0.0.1";
const gameServer = new Server();
gameServer.define("prison", GameRoom);
gameServer.listen(port, host);
console.log(`Prison Escape multiplayer listening on ws://${host}:${port}`);

// ---- Debug log sink ------------------------------------------------------
const http = require("http");
const LOG_PORT = Number(process.env.LOG_PORT) || 2568;
const MAX_BODY = 64 * 1024;
const MAX_FILE = 5 * 1024 * 1024;

http.createServer((req, res) => {
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
