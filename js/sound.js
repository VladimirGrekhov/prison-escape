// Звук кубиков через Web Audio API — без внешних файлов.
let audioCtx = null;

function getCtx() {
  if (!audioCtx) {
    const AC = window.AudioContext || window.webkitAudioContext;
    audioCtx = new AC();
  }
  // На мобильных контекст стартует в suspended — будим после жеста пользователя.
  if (audioCtx.state === 'suspended') audioCtx.resume();
  return audioCtx;
}

// Деревянный «стук»: тоновый резонатор тела (затухающая синусоида в низко-среднем
// диапазоне) + короткий шумовой щелчок атаки.
function clack(ctx, t, gain, dur, freq) {
  // Резонанс «дерева»: основной тон с лёгкими случайными вариациями.
  const f0 = freq || (260 + Math.random() * 160);

  // Тело — две гармоники для «полого» деревянного тембра.
  [[f0, 1.0], [f0 * 2.7, 0.35]].forEach(([f, amp]) => {
    const osc = ctx.createOscillator();
    osc.type = 'sine';
    osc.frequency.value = f;

    const g = ctx.createGain();
    g.gain.setValueAtTime(0, t);
    g.gain.linearRampToValueAtTime(gain * amp, t + 0.002);
    g.gain.exponentialRampToValueAtTime(0.0001, t + dur);

    osc.connect(g).connect(ctx.destination);
    osc.start(t);
    osc.stop(t + dur);
  });

  // Щелчок атаки — очень короткий приглушённый шум, придаёт «деревянность» удара.
  const clickDur = 0.012;
  const len = Math.floor(ctx.sampleRate * clickDur);
  const buf = ctx.createBuffer(1, len, ctx.sampleRate);
  const data = buf.getChannelData(0);
  for (let i = 0; i < len; i++) {
    const env = Math.pow(1 - i / len, 2);
    data[i] = (Math.random() * 2 - 1) * env;
  }
  const src = ctx.createBufferSource();
  src.buffer = buf;

  const lp = ctx.createBiquadFilter();
  lp.type = 'lowpass';
  lp.frequency.value = 2500;

  const cg = ctx.createGain();
  cg.gain.value = gain * 0.6;

  src.connect(lp).connect(cg).connect(ctx.destination);
  src.start(t);
  src.stop(t + clickDur);
}

// Тряска кубиков: серия неравномерных стуков.
function playDiceRattle() {
  const ctx = getCtx();
  const now = ctx.currentTime;
  let t = now;
  for (let i = 0; i < 7; i++) {
    clack(ctx, t, 0.12 + Math.random() * 0.1, 0.08 + Math.random() * 0.04);
    t += 0.05 + Math.random() * 0.05;
  }
}

// Приземление: два звонких стука покрупнее.
function playDiceLand() {
  const ctx = getCtx();
  const now = ctx.currentTime;
  // Ниже по тону и с более длинным резонансом — «солидный» деревянный стук.
  clack(ctx, now, 0.35, 0.16, 200);
  clack(ctx, now + 0.09, 0.28, 0.14, 240);
}
