// Prison Escape — multiplayer client (Colyseus 0.16).
//
// Owns the network connection and translates server state changes into calls
// into game.js (animateDice / applyTurnFromNet / syncPlayersFromNet). If the
// server is unreachable, MP.enabled stays false and game.js plays offline.
(function () {
  function computeEndpoint() {
    if (window.MP_ENDPOINT) return window.MP_ENDPOINT;            // manual override
    if (location.protocol === 'file:') return 'ws://localhost:2567';
    if (location.hostname === 'localhost' || location.hostname === '127.0.0.1') {
      return 'ws://localhost:2567';                               // local dev
    }
    const proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
    return `${proto}//${location.host}/mp`;                       // nginx proxies /mp -> :2567
  }

  const MP = window.MP = {
    enabled: false,
    connected: false,
    room: null,
    mySeat: -1,
    turn: 0,
    rolling: false,
    _client: null,
    _token: null,
    _lastSeq: null,
    _leaving: false,

    isMyTurn() {
      return this.enabled && this.mySeat >= 0 &&
             this.mySeat === this.turn && !this.rolling;
    },
    myName() {
      try { return localStorage.getItem('pe-name') || ''; } catch (e) { return ''; }
    },
    setName(name) {
      try { localStorage.setItem('pe-name', name); } catch (e) {}
      if (this.room) this.room.send('name', String(name || '').slice(0, 16));
    },
    sendRoll() { if (this.room) this.room.send('roll'); },
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
    MP._lastSeq = null; // re-adopt seq on (re)connect without replaying a roll
    wire(room);
  }

  function wire(room) {
    const $ = Colyseus.getStateCallbacks(room);

    room.onMessage('welcome', (msg) => {
      MP.mySeat = msg.seat;
      window.__mySeat = msg.seat;
      MP.turn = room.state.turn;
      if (typeof syncPlayersFromNet === 'function') syncPlayersFromNet(snapshot(room));
      if (typeof applyTurnFromNet === 'function') applyTurnFromNet(room.state.turn);
      setStatus('online');
    });

    $(room.state).listen('turn', (v) => {
      MP.turn = v;
      if (typeof applyTurnFromNet === 'function') applyTurnFromNet(v);
    });

    $(room.state).listen('rolling', (v) => {
      MP.rolling = v;
      if (typeof refreshControls === 'function') refreshControls();
    });

    $(room.state).listen('seq', (v) => {
      // First value after (re)connect: adopt without animating — we might be
      // joining a game already in progress.
      if (MP._lastSeq === null) { MP._lastSeq = v; return; }
      if (v > MP._lastSeq) {
        MP._lastSeq = v;
        if (typeof animateDice === 'function') {
          animateDice(room.state.d1, room.state.d2);
        }
      }
    });

    const refreshRoster = () => {
      if (typeof syncPlayersFromNet === 'function') syncPlayersFromNet(snapshot(room));
    };
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
    if (MP._leaving) return;            // intentional leave
    setStatus('reconnecting');

    // The server holds our seat for a short grace period — try to slip back in.
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

    // Show the reset + name controls only when actually online.
    const ctrls = document.getElementById('mp-controls');
    if (ctrls) ctrls.style.display = (state === 'online') ? 'flex' : 'none';
  }

  window.addEventListener('beforeunload', () => {
    MP._leaving = true;
    if (MP.room) { try { MP.room.leave(); } catch (e) {} }
  });
})();
