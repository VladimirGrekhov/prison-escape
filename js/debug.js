// Prison Escape — отладка: нумерация клеток на доске + лог действий с выгрузкой
// в файл. Включается параметром ?debug=1 в адресе.
window.DBG = {
  enabled: /[?&]debug\b/.test(location.search),
  lines: [],

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
    if (this.enabled) this.log('=== session start === ' + navigator.userAgent);
  },
};
