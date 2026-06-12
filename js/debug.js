// Prison Escape — отладка: нумерация клеток на доске + лог действий с выгрузкой
// в файл. Включается параметром ?debug=1 в адресе.
window.DBG = {
  enabled: /[?&]debug\b/.test(location.search),
  lines: [],

  // Форс кубиков с клавиатуры: 1–6 задают значения следующего броска (до двух),
  // 0/Esc — сброс. Забираются при броске (и офлайн, и онлайн).
  forced: [],
  takeForced() { const f = this.forced.slice(0, 2); this.forced = []; return f; },

  log() {
    const msg = Array.prototype.map.call(arguments, (a) =>
      (a && typeof a === 'object') ? JSON.stringify(a) : String(a)).join(' ');
    const line = `[${new Date().toISOString().slice(11, 23)}] ${msg}`;
    this.lines.push(line);
    if (this.enabled) {
      console.log('[PE]', msg);
      this.send(line);
    }
  },

  // Отправка строки лога на сервер (fire-and-forget) — пишется в файл client.log.
  send(line) {
    try {
      fetch('/log', {
        method: 'POST',
        headers: { 'Content-Type': 'text/plain' },
        body: line,
        keepalive: true,
      }).catch(() => {});
    } catch (e) { /* ignore */ }
  },

  download() {
    const blob = new Blob([this.lines.join('\n') + '\n'], { type: 'text/plain' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = `prison-escape-${Date.now()}.log`;
    document.body.appendChild(a);
    a.click();
    a.remove();
    URL.revokeObjectURL(a.href);
  },

  init() {
    const btn = document.getElementById('log-btn');
    if (btn) {
      btn.style.display = this.enabled ? '' : 'none';
      btn.onclick = () => this.download();
    }
    if (this.enabled) {
      this.log('=== session start === ' + navigator.userAgent);
      document.addEventListener('keydown', (e) => {
        if (e.target && /INPUT|TEXTAREA|SELECT/.test(e.target.tagName)) return;
        if (e.key >= '1' && e.key <= '6') {
          if (this.forced.length >= 2) this.forced = [];
          this.forced.push(+e.key);
          this.log(`DBG forced dice: [${this.forced}]`);
          // В фазе хода пара цифр заменяет текущие кубики на месте (game.js).
          if (window.onForcedDice) window.onForcedDice(this.forced.slice());
        } else if (e.key === '0' || e.key === 'Escape') {
          if (this.forced.length) { this.forced = []; this.log('DBG forced dice cleared'); }
        }
      });
    }
  },
};
