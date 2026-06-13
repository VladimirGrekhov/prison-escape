// Prison Escape — multiplayer client (Colyseus 0.16).
//
// Поток: lobby (LobbyRoom) → создание/вход в комнату → игра.
// applyServerState и syncPlayersFromNet живут в game.js и вызываются отсюда.
(function () {
  function computeEndpoint() {
    if (window.MP_ENDPOINT) return window.MP_ENDPOINT;
    if (location.protocol === 'file:') return 'ws://localhost:2567';
    if (location.hostname === 'localhost' || location.hostname === '127.0.0.1')
      return 'ws://localhost:2567';
    const proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
    return `${proto}//${location.host}/mp`;
  }

  const MP = window.MP = {
    enabled: false,
    connected: false,
    room: null,
    mySeat: -1,
    isHost: false,
    turn: 0,
    phase: 'idle',
    roomPhase: 'waiting',
    rolling: false,
    _client: null,
    _token: null,
    _lastSeq: null,
    _leaving: false,
    _lobbyRoom: null,

    isMyTurn() { return this.enabled && this.mySeat >= 0 && this.mySeat === this.turn; },
    canRoll() { return this.isMyTurn() && this.phase === 'idle' && this.roomPhase === 'playing'; },
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
    startGame() { if (this.room) this.room.send('start'); },
    connect,
    showLobby,
  };

  // ── entry point ───────────────────────────────────────────────────────────

  async function connect() {
    if (typeof Colyseus === 'undefined') { setStatus('offline'); return; }
    setStatus('connecting');
    try {
      MP._client = new Colyseus.Client(computeEndpoint());
      await showLobby();
    } catch (e) {
      console.warn('[MP] running offline:', e && e.message);
      goOffline();
    }
  }

  // ── lobby ─────────────────────────────────────────────────────────────────

  let _rooms = {};   // roomId → metadata

  async function showLobby() {
    if (!MP._client) return;
    try {
      // отсоединяемся от предыдущей lobby-комнаты если была
      if (MP._lobbyRoom) { try { MP._lobbyRoom.leave(); } catch (e) {} }
      MP._lobbyRoom = await MP._client.joinOrCreate('lobby');
      _rooms = {};

      MP._lobbyRoom.onMessage('rooms', (list) => {
        _rooms = {};
        list.forEach((r) => { _rooms[r.roomId] = r; });
        renderRooms();
      });
      MP._lobbyRoom.onMessage('+', ([roomId, room]) => {
        _rooms[roomId] = room;
        renderRooms();
      });
      MP._lobbyRoom.onMessage('-', (roomId) => {
        delete _rooms[roomId];
        renderRooms();
      });

      openLobbyOverlay();
    } catch (e) {
      console.warn('[MP] lobby unavailable:', e && e.message);
      goOffline();
    }
  }

  function renderRooms() {
    const list = document.getElementById('lobby-rooms-list');
    const hint = document.getElementById('lobby-empty-hint');
    if (!list) return;
    const waiting = Object.values(_rooms).filter((r) => r.metadata && r.metadata.roomPhase === 'waiting');
    if (hint) hint.style.display = waiting.length ? 'none' : '';
    list.innerHTML = '';
    waiting.forEach((r) => {
      const meta = r.metadata || {};
      const max = meta.maxPlayers || 4;
      const names = Array.isArray(meta.playerNames) ? meta.playerNames : [];

      // слоты: заполненные имена + пустые
      let slots = '';
      for (let s = 0; s < max; s++) {
        const name = names[s];
        slots += name
          ? `<div class="lobby-slot filled">${esc(name)}</div>`
          : `<div class="lobby-slot empty">свободно</div>`;
      }

      const card = document.createElement('div');
      card.className = 'lobby-room-card';
      card.innerHTML =
        `<div class="lobby-room-info">` +
          `<div class="lobby-room-header">` +
            `<span class="lobby-room-name">${esc(meta.name || r.roomId)}</span>` +
            `<span class="lobby-room-count">${meta.players || 0}/${max}</span>` +
          `</div>` +
          `<div class="lobby-room-slots">${slots}</div>` +
        `</div>` +
        `<div class="lobby-room-join"><button>Войти →</button></div>`;
      card.querySelector('button').onclick = () => joinRoom(r.roomId);
      list.appendChild(card);
    });
  }

  function esc(s) {
    return String(s).replace(/[&<>"']/g, (c) =>
      ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
  }

  async function createRoom() {
    const maxPlayers = parseInt(document.getElementById('lobby-maxplayers')?.value || '4', 10);
    const fillBots = !!(document.getElementById('lobby-fillbots')?.checked);
    try {
      const room = await MP._client.create('prison', {
        name: MP.myName(),
        maxPlayers,
        fillBots,
      });
      closeLobbyOverlay();
      adopt(room);
      setStatus('online');
    } catch (e) {
      console.warn('[MP] createRoom failed:', e && e.message);
    }
  }

  async function joinRoom(roomId) {
    try {
      const room = await MP._client.joinById(roomId, { name: MP.myName() });
      closeLobbyOverlay();
      adopt(room);
      setStatus('online');
    } catch (e) {
      console.warn('[MP] joinRoom failed:', e && e.message);
      renderRooms(); // обновить список (комната могла заполниться)
    }
  }

  // ── room adoption ─────────────────────────────────────────────────────────

  function adopt(room) {
    MP.room = room;
    MP._token = room.reconnectionToken;
    MP.enabled = true;
    MP.connected = true;
    MP._lastSeq = null;
    wire(room);
  }

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
      roomPhase: state.roomPhase,
      dice: Array.from(state.dice), used: Array.from(state.used),
      bonus: Array.from(state.bonus), doubleOne: state.doubleOne,
      winner: state.winner, bmSeat: state.bmSeat, bmI: state.bmI,
      karzerSeat: state.karzerSeat, karzerI: state.karzerI, pieces,
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
      MP.roomPhase = room.state.roomPhase || 'playing';
      MP.rolling = (room.state.phase === 'rolling');
      if (typeof applyServerState === 'function') applyServerState(readState(room.state));
      applyRoomPhase(room.state);
    }

    room.onMessage('welcome', (msg) => {
      MP.mySeat = msg.seat;
      MP.isHost = !!msg.isHost;
      window.__mySeat = msg.seat;
      window.__viewRot = ({ 0: 2, 1: 1, 2: 3 })[msg.seat] || 0;
      refreshRoster();
      refreshState();
      setStatus('online');
    });

    $(room.state).listen('rev', refreshState);
    ['turn', 'phase', 'winner', 'doubleOne', 'bmSeat', 'bmI', 'karzerSeat', 'karzerI'].forEach((f) =>
      $(room.state).listen(f, refreshState));

    $(room.state).listen('roomPhase', () => {
      MP.roomPhase = room.state.roomPhase;
      applyRoomPhase(room.state);
    });

    $(room.state).listen('hostSeat', () => {
      // пересчитать isHost по обновлённому hostSeat
      if (MP.room) {
        const p = room.state.players.get(room.sessionId);
        MP.isHost = p ? (p.seat === room.state.hostSeat) : false;
      }
      updateWaitingUI(room.state);
    });

    $(room.state).listen('countdown', () => {
      const el = document.getElementById('countdown-num');
      if (el) el.textContent = room.state.countdown;
    });

    $(room.state).listen('seq', (v) => {
      if (MP._lastSeq === null) { MP._lastSeq = v; refreshState(); return; }
      if (v > MP._lastSeq) {
        MP._lastSeq = v;
        if (typeof animateDice === 'function') animateDice(room.state.dice[0], room.state.dice[1]);
      }
      refreshState();
    });

    $(room.state).pieces.onAdd((p) => { $(p).onChange(refreshState); });

    $(room.state).players.onAdd((player) => {
      refreshRoster();
      $(player).onChange(() => { refreshRoster(); updateWaitingUI(room.state); });
    });
    $(room.state).players.onRemove(refreshRoster);

    room.onError((code, message) => console.warn('[MP] room error', code, message));
    room.onLeave((code) => handleLeave(code));
  }

  // ── phase UI ──────────────────────────────────────────────────────────────

  function applyRoomPhase(state) {
    const phase = state.roomPhase || 'playing';
    hide('waiting-overlay');
    hide('countdown-overlay');
    hide('finished-overlay');

    if (phase === 'waiting') {
      show('waiting-overlay');
      updateWaitingUI(state);
    } else if (phase === 'starting') {
      show('countdown-overlay');
      const el = document.getElementById('countdown-num');
      if (el) el.textContent = state.countdown;
    } else if (phase === 'finished') {
      show('finished-overlay');
      updateFinishedUI(state);
    }
    // 'playing' — оверлеи убраны, доска видна
    if (typeof refreshControls === 'function') refreshControls();
  }

  function updateWaitingUI(state) {
    const playersEl = document.getElementById('waiting-players');
    if (playersEl) {
      let html = '';
      // показываем места 0..maxPlayers-1
      const byBeat = {};
      state.players.forEach((p) => { if (p.seat >= 0) byBeat[p.seat] = p; });
      for (let s = 0; s < (state.maxPlayers || 4); s++) {
        const p = byBeat[s];
        html += `<div class="waiting-player ${p ? 'filled' : 'empty'}">` +
          (p ? `${esc(p.name)}${p.isBot ? ' 🤖' : ''}` : '— свободно —') +
          '</div>';
      }
      playersEl.innerHTML = html;
    }

    const hintEl = document.getElementById('waiting-hint');
    const humans = countHumans(state);
    const min = 2;
    if (hintEl) hintEl.textContent = humans < min ? `Нужно ещё ${min - humans} игрока` : 'Можно начинать!';

    const startBtn = document.getElementById('waiting-start-btn');
    if (startBtn) {
      const canStart = MP.isHost && humans >= min;
      startBtn.classList.toggle('hidden', !canStart);
    }
  }

  function updateFinishedUI(state) {
    const el = document.getElementById('finished-text');
    if (!el) return;
    if (state.winner >= 0) {
      // найти имя победителя по seat
      let winName = `Игрок ${state.winner + 1}`;
      state.players.forEach((p) => { if (p.seat === state.winner) winName = p.name; });
      el.textContent = `🏆 ${esc(winName)} победил!`;
    } else {
      el.textContent = 'Игра окончена';
    }
  }

  function countHumans(state) {
    let n = 0;
    state.players.forEach((p) => { if (!p.isBot) n++; });
    return n;
  }

  // ── overlay helpers ───────────────────────────────────────────────────────

  function show(id) { document.getElementById(id)?.classList.remove('hidden'); }
  function hide(id) { document.getElementById(id)?.classList.add('hidden'); }

  function openLobbyOverlay() { show('lobby-overlay'); }
  function closeLobbyOverlay() { hide('lobby-overlay'); }

  // ── reconnection ──────────────────────────────────────────────────────────

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
    goOffline();
    // после провала реконнекта — вернуть в лобби
    await showLobby();
  }

  function goOffline() {
    MP.enabled = false;
    MP.connected = false;
    setStatus('offline');
    window.__viewRot = 0;
    if (typeof redrawBoard === 'function') redrawBoard();
    if (typeof refreshControls === 'function') refreshControls();
  }

  // ── setup DOM buttons ─────────────────────────────────────────────────────

  function initLobbyButtons() {
    document.getElementById('lobby-create-btn')?.addEventListener('click', createRoom);
    document.getElementById('lobby-offline-btn')?.addEventListener('click', () => {
      closeLobbyOverlay();
      goOffline();
    });
    document.getElementById('waiting-start-btn')?.addEventListener('click', () => {
      MP.startGame();
    });
    document.getElementById('waiting-leave-btn')?.addEventListener('click', () => {
      if (MP.room) {
        MP._leaving = true;
        MP.room.leave();
        MP.room = null;
        MP._leaving = false;
      }
      MP.enabled = false;
      MP.mySeat = -1;
      hide('waiting-overlay');
      hide('countdown-overlay');
      showLobby();
    });
    document.getElementById('finished-close')?.addEventListener('click', async () => {
      hide('finished-overlay');
      if (MP.room) { try { MP.room.leave(); } catch (e) {} MP.room = null; }
      MP.enabled = false; MP.mySeat = -1;
      await showLobby();
    });
  }

  // ── misc ──────────────────────────────────────────────────────────────────

  function snapshot(room) {
    const out = {};
    room.state.players.forEach((p, key) => {
      out[key] = { seat: p.seat, name: p.name, connected: p.connected, me: key === room.sessionId };
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

  window.addEventListener('load', initLobbyButtons);

  window.addEventListener('beforeunload', () => {
    MP._leaving = true;
    if (MP._lobbyRoom) { try { MP._lobbyRoom.leave(); } catch (e) {} }
    if (MP.room) { try { MP.room.leave(); } catch (e) {} }
  });
})();
