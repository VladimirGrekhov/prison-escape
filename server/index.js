// Prison Escape — authoritative multiplayer server (Colyseus 0.16).
//
// The browser is "dumb": it sends a single "roll" intent and renders whatever
// state the server broadcasts. The server owns the dice, the turn order and
// seat assignment, so no client can roll out of turn or fake a result.
const { Server, Room } = require("colyseus");
const { Schema, MapSchema, defineTypes } = require("@colyseus/schema");

const MAX_SEATS = 4;       // 4 corner players, like the offline board
const ROLL_MS = 1800;      // turn is locked while dice "fly" (matches client anim)
const RECONNECT_SEC = 30;  // grace period to rejoin after a drop

// ---- Synchronised state --------------------------------------------------

class Player extends Schema {
  constructor() {
    super();
    this.seat = -1;        // 0..3 = playing, -1 = spectator (board is full)
    this.name = "";
    this.connected = true;
  }
}
defineTypes(Player, { seat: "int8", name: "string", connected: "boolean" });

class GameState extends Schema {
  constructor() {
    super();
    this.players = new MapSchema(); // sessionId -> Player
    this.turn = 0;                  // seat index whose turn it is
    this.d1 = 1;
    this.d2 = 1;
    this.seq = 0;                   // bumps on every roll -> drives client animation
    this.rolling = false;          // true while a roll is resolving
  }
}
defineTypes(GameState, {
  players: { map: Player },
  turn: "int8",
  d1: "uint8",
  d2: "uint8",
  seq: "uint32",
  rolling: "boolean",
});

// ---- Room ----------------------------------------------------------------

class GameRoom extends Room {
  onCreate() {
    this.maxClients = 16; // 4 players + spectators
    this.setState(new GameState());

    this.onMessage("roll", (client) => this.handleRoll(client));
    this.onMessage("name", (client, name) => {
      const p = this.state.players.get(client.sessionId);
      if (p && typeof name === "string") p.name = name.slice(0, 16);
    });
    this.onMessage("reset", () => this.resetGame());
  }

  // --- seat helpers ---
  seatTaken(seat) {
    for (const [, p] of this.state.players) if (p.seat === seat) return true;
    return false;
  }
  firstFreeSeat() {
    for (let s = 0; s < MAX_SEATS; s++) if (!this.seatTaken(s)) return s;
    return -1; // board full -> spectator
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

    // If the current turn points at an empty seat (e.g. first player to join),
    // hand the turn to someone who is actually here.
    if (p.seat >= 0 && !this.occupiedSeats().has(this.state.turn)) {
      this.state.turn = p.seat;
    }

    client.send("welcome", { sessionId: client.sessionId, seat: p.seat });
  }

  handleRoll(client) {
    const p = this.state.players.get(client.sessionId);
    if (!p || p.seat < 0) return;          // spectators can't roll
    if (this.state.rolling) return;        // already resolving a roll
    if (p.seat !== this.state.turn) return; // not your turn

    this.state.d1 = 1 + Math.floor(Math.random() * 6);
    this.state.d2 = 1 + Math.floor(Math.random() * 6);
    this.state.seq++;
    this.state.rolling = true;

    // Lock the turn while the dice animate everywhere, then pass it on.
    this._rollTimer = setTimeout(() => {
      this.state.rolling = false;
      this.advanceTurn();
    }, ROLL_MS);
  }

  advanceTurn() {
    const occ = this.occupiedSeats();
    if (occ.size === 0) return;
    let t = this.state.turn;
    for (let i = 0; i < MAX_SEATS; i++) {
      t = (t + 1) % MAX_SEATS;
      if (occ.has(t)) { this.state.turn = t; return; }
    }
  }

  removePlayer(sessionId) {
    const p = this.state.players.get(sessionId);
    if (!p) return;
    const wasTurn = p.seat === this.state.turn;
    this.state.players.delete(sessionId);

    const occ = this.occupiedSeats();
    if (occ.size === 0) { this.state.turn = 0; return; }
    if (wasTurn && !occ.has(this.state.turn)) {
      let t = this.state.turn;
      for (let i = 0; i < MAX_SEATS; i++) {
        t = (t + 1) % MAX_SEATS;
        if (occ.has(t)) { this.state.turn = t; break; }
      }
    }
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

  resetGame() {
    if (this._rollTimer) clearTimeout(this._rollTimer);
    this.state.seq = 0;
    this.state.d1 = 1;
    this.state.d2 = 1;
    this.state.rolling = false;
    const occ = [...this.occupiedSeats()].sort((a, b) => a - b);
    this.state.turn = occ.length ? occ[0] : 0;
  }
}

// ---- Boot ----------------------------------------------------------------

const port = Number(process.env.PORT) || 2567;
const host = process.env.HOST || "127.0.0.1"; // nginx proxies to us locally
const gameServer = new Server();
gameServer.define("prison", GameRoom);
gameServer.listen(port, host);
console.log(`Prison Escape multiplayer listening on ws://${host}:${port}`);

// ---- Debug log sink ------------------------------------------------------
// Клиент (?debug=1) шлёт строки лога сюда POST-ом, сервер дописывает их в файл
// logs/client.log (папка добавлена в ReadWritePaths systemd-юнита).
const http = require("http");
const fs = require("fs");
const path = require("path");
const LOG_PORT = Number(process.env.LOG_PORT) || 2568;
const LOG_FILE = path.join(__dirname, "logs", "client.log");
const MAX_BODY = 64 * 1024;          // ограничение тела запроса
const MAX_FILE = 5 * 1024 * 1024;    // простая ротация при превышении

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
