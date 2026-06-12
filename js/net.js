// Prison Escape — multiplayer client (Colyseus 0.16).
//
// Mirrors the authoritative server state into the local ENGINE + game globals
// (via applyServerState in game.js) so all rendering/targeting code is reused.
// If the server is unreachable, MP.enabled stays false and game.js plays offline.
(function () {
  function computeEndpoint() {
    if (window.MP_ENDPOINT) return window.MP_ENDPOINT;
    if (location.protocol === 'file:') return 'ws://localhost:2567';
    if (location.hostname === 'localhost' || location.hostname === '127.0.0.1') {
      return 'ws://localhost:2567';
    }
    const proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
    return `${proto}//${location.host}/mp`;
  }

  const MP = window.MP = {
    enabled: false,
    connected: false,
    room: null,
    mySeat: -1,
    turn: 0,
    phase: 'idle',
    rolling: false,
    _client: null,
    _token: null,
    _lastSeq: null,
    _leaving: false,

    isMyTurn() {
      return this.enabled && this.mySeat >= 0 && this.mySeat === this.turn;
    },
    canRoll() { return this.isMyTurn() && this.phase === 'idle'; },
    myName() {
      try { return localStorage.getItem('pe-name') || ''; } catch (e) { return ''; }
    },
    setName(name) {
      try { localStorage.setItem('pe-name', name); } catch (e) {}
      if (this.room) this.room.send('name', String(name || '').slice(0, 16));
    },
    roll(forced) { if (this.room) this.room.send('roll', (forced && forced.length) ? forced : undefined); },
    debugDice(vals) { if (this.room) this.room.send('dbgdice', vals); },
    act(kind, i, slot, bm) { if (this.room) this.room.send('act', { kind, i, slot, bm: !!bm }); },
    bm(divert) { if (this.room) this.room.send('bm', { divert: !!divert }); },
    reset() { if (this.room) this.room.send('reset'); },
    connect,
  };

  async function connect() {
    if (typeof Colyseus === 'undefined') { setStatus('offline'); return; }
    setStatus('connecting');
    try {
      MP._client = new Colyseus.Client(computeEndpoint());
      const room = await MP._client.joinOrCreate('prison', { name: MP.myName() });
      adopt(room);
      setStatus('online');
    } catch (e) {
      console.warn('[MP] running offline:', e && e.message);
      MP.enabled = false;
      MP.connected = false;
      setStatus('offline');
    }
  }

  function adopt(room) {
    MP.room = room;
    MP.token = room.reconnectionToken;
    MP._token = room.reconnectionToken;
    MP.enabled = true;
    MP.connected = true;
    MP._lastSeq = null;
    wire(room);
  }

  // Plain snapshot of the synchronised game state for game.js.
  function readState(state) {
    const pieces = [];
    for (let s = 0; s < 4; s++) {
      const row = [];
      for (let i = 0; i < 5; i++) {
        const p = state.pieces[s * 5 + i];
        row.push({ where: p.where, progress: p.progress, bm: p.bm, captor: p.captor });
      }
      pieces.push(row);
    }
    return {
      turn: state.turn, phase: state.phase,
      dice: Array.from(state.dice), used: Array.from(state.used),
      bonus: Array.from(state.bonus), doubleOne: state.doubleOne,
      winner: state.winner, bmSeat: state.bmSeat, bmI: state.bmI, pieces,
    };
  }

  function wire(room) {
    const $ = Colyseus.getStateCallbacks(room);

    function refreshRoster() {
      if (typeof syncPlayersFromNet === 'function') syncPlayersFromNet(snapshot(room));
    }
    function refreshState() {
      MP.turn = room.state.turn;
      MP.phase = room.state.phase;
      MP.rolling = (room.state.phase === 'rolling');
      if (typeof applyServerState === 'function') applyServerState(readState(room.state));
    }

    room.onMessage('welcome', (msg) => {
      MP.mySeat = msg.seat;
      window.__mySeat = msg.seat;
      refreshRoster();
      refreshState();
      setStatus('online');
    });

    // rev меняется на каждый серверный sync() → гарантированная перерисовка,
    // даже если поменялись только pieces/used (их onChange не всегда срабатывает).
    $(room.state).listen('rev', refreshState);
    ['turn', 'phase', 'winner', 'doubleOne', 'bmSeat', 'bmI'].forEach((f) =>
      $(room.state).listen(f, refreshState));

    $(room.state).listen('seq', (v) => {
      if (MP._lastSeq === null) { MP._lastSeq = v; refreshState(); return; }
      if (v > MP._lastSeq) {
        MP._lastSeq = v;
        if (typeof animateDice === 'function') animateDice(room.state.dice[0], room.state.dice[1]);
      }
      refreshState();
    });

    // Any piece change (moves, captures, ransom) → re-mirror + redraw.
    $(room.state).pieces.onAdd((p) => { $(p).onChange(refreshState); });

    $(room.state).players.onAdd((player) => {
      refreshRoster();
      $(player).onChange(refreshRoster);
    });
    $(room.state).players.onRemove(refreshRoster);

    room.onError((code, message) => console.warn('[MP] room error', code, message));
    room.onLeave((code) => handleLeave(code));
  }

  async function handleLeave(code) {
    MP.connected = false;
    if (MP._leaving) return;
    setStatus('reconnecting');
    for (let attempt = 0; attempt < 6; attempt++) {
      try {
        const room = await MP._client.reconnect(MP._token);
        adopt(room);
        setStatus('online');
        return;
      } catch (e) {
        await new Promise((r) => setTimeout(r, 2000));
      }
    }
    MP.enabled = false;
    setStatus('offline');
    if (typeof refreshControls === 'function') refreshControls();
  }

  // Plain-object view of the player map for game.js.
  function snapshot(room) {
    const out = {};
    room.state.players.forEach((p, key) => {
      out[key] = {
        seat: p.seat,
        name: p.name,
        connected: p.connected,
        me: key === room.sessionId,
      };
    });
    return out;
  }

  function setStatus(state) {
    const el = document.getElementById('mp-status');
    if (!el) return;
    const seatTxt = MP.mySeat >= 0 ? `вы Игрок ${MP.mySeat + 1}` : 'зритель';
    const labels = {
      offline: '🔌 Локальная игра',
      connecting: '⏳ Подключение…',
      online: `🟢 Онлайн · ${seatTxt}`,
      reconnecting: '🟡 Переподключение…',
    };
    el.textContent = labels[state] || '';
    el.dataset.state = state;
    const ctrls = document.getElementById('mp-controls');
    if (ctrls) ctrls.style.display = (state === 'online') ? 'flex' : 'none';
  }

  window.addEventListener('beforeunload', () => {
    MP._leaving = true;
    if (MP.room) { try { MP.room.leave(); } catch (e) {} }
  });
})();
