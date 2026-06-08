const R = 22;
const SP = R * 2 + 4;
const GRID = 21;
const OFF = 10;
const CORNER = 6;
const CW = CORNER * SP;   // размер угловой зоны игрока
const MARGIN = 16;        // внешние поля канваса вокруг доски

const centerR = 10, centerC = 10;

const ROMAN = ['V', 'IV', 'III', 'II', 'I'];
const ROMAN_CELLS = {};
for (let i = 0; i < 5; i++) ROMAN_CELLS[`${centerR-2-i},${centerC}`] = ROMAN[i];
for (let i = 0; i < 5; i++) ROMAN_CELLS[`${centerR+2+i},${centerC}`] = ROMAN[i];
for (let i = 0; i < 5; i++) ROMAN_CELLS[`${centerR},${centerC-2-i}`] = ROMAN[i];
for (let i = 0; i < 5; i++) ROMAN_CELLS[`${centerR},${centerC+2+i}`] = ROMAN[i];

const ARROW_CELLS = new Set([
  `${centerR-1},${centerC}`,
  `${centerR},${centerC+1}`,
  `${centerR+1},${centerC}`,
  `${centerR},${centerC-1}`,
]);

// Диагональные кружки вокруг центра — стрелки смотрят внутрь, на решётку.
// `a` — угол стрелки (0 = вправо, по часовой; canvas y вниз).
const DIAG_ARROWS = [
  { r: centerR-1, c: centerC-1, a:  Math.PI/4 },   // верх-лево  → центр
  { r: centerR-1, c: centerC+1, a:  3*Math.PI/4 }, // верх-право → центр
  { r: centerR+1, c: centerC-1, a: -Math.PI/4 },   // низ-лево   → центр
  { r: centerR+1, c: centerC+1, a: -3*Math.PI/4 }, // низ-право  → центр
];
const DIAG_ARROW_CELLS = new Set(DIAG_ARROWS.map(d => `${d.r},${d.c}`));

// Клетки-входы на маршрут (откуда фишки выходят из дома) — белые, как кончики лучей.
const ENTRY_CELLS = new Set([
  '3,10',   // верх  — средний ряд луча, у кончика
  '17,10',  // низ
  '10,3',   // лево
  '10,17',  // право
]);

// Топология маршрута (TRACK, ENTRY, HOME_LANE, TRACK_MAIN, MAX_PROGRESS, X_GRID,
// SAFE, BM_CELLS, BM_BY_TRACK, EXPRESS…) живёт в js/topology.js (общий код с
// сервером) и доступна здесь как глобали.

const X_OFF = R * 0.45; // сдвиг центра «Х» наружу (как у нарисованного крупного кружка)
const X_SHIFT = [[0, -X_OFF], [X_OFF, 0], [0, X_OFF], [-X_OFF, 0]];
function xCenter(seat) {
  const [r, c] = X_GRID[seat];
  return { x: boardPx(c) + X_SHIFT[seat][0], y: boardPy(r) + X_SHIFT[seat][1] };
}

function cellCenter(r, c) { return { x: boardPx(c), y: boardPy(r) }; }

// Центр нарисованного кружка БМ (с учётом сдвига наружу).
function bmCenter(b) {
  const g = R * 0.45;
  return { x: boardPx(b.c) + b.nx * g, y: boardPy(b.r) + b.ny * g };
}

// Палитры доски (canvas) для дневной и ночной темы.
const THEMES = {
  day: {
    bg:         '#7a4a18',  // освещённое дерево
    ring:       '#2a1500',
    cell:       '#f0e8cc',
    bm:         '#d8c450',
    cellStroke: '#5a3000',
    ink:        '#241000',  // метки и стрелки
    barBody:    '#3a1800',
    barStroke:  '#6a4010',
    barLines:   '#bdbdbd',
  },
  night: {
    bg:         '#1b1726',  // тёмное лунное дерево
    ring:       '#05030a',
    cell:       '#8e8a9c',
    bm:         '#9a8a3e',
    cellStroke: '#0d0a16',
    ink:        '#0a0712',
    barBody:    '#0f0a18',
    barStroke:  '#34304a',
    barLines:   '#6b6880',
  },
};

let activeTheme = THEMES.day;
let boardCanvas = null;
let __pieceHits = [];   // [{seat,i,x,y,r}] для попадания клика по фишке (canvas-координаты)
let __targetHits = [];  // [{idx,x,y,r}] для попадания клика по клетке-цели

function isOnlineMode() { return !!(window.MP && window.MP.enabled); }

// Цвет подсветки = цвет игрока, чей сейчас ход.
function turnColor() {
  const s = window.__turnSeat;
  return (PLAYERS[s] && PLAYERS[s].color) || '#ffffff';
}

const PLAYERS = [
  { color: '#e04040', name: 'Игрок 1' },
  { color: '#4040e0', name: 'Игрок 2' },
  { color: '#40c040', name: 'Игрок 3' },
  { color: '#e0c030', name: 'Игрок 4' },
];

const PIECE_OFFSETS = [
  [-R*1.5, -R*1.5], [R*1.5, -R*1.5], [0, -R*1.5],
  [-R*1.5,  R*0.5], [R*1.5,  R*0.5],
];

const CORNER_POS = [
  { cx: CW*0.5,               cy: CW*0.5 },
  { cx: null,                  cy: CW*0.5 },
  { cx: CW*0.5,               cy: null },
  { cx: null,                  cy: null },
];

function inCross(r, c) {
  return (c >= 9 && c <= 11 && r >= 3 && r <= 17) ||
         (r >= 9 && r <= 11 && c >= 3 && c <= 17);
}

function boardPx(c) { return MARGIN + OFF + c * SP + R; }
function boardPy(r) { return MARGIN + OFF + r * SP + R; }

function drawCircle(ctx, x, y, label, white, rad = R, labelColor) {
  ctx.beginPath();
  ctx.arc(x, y, rad + 2, 0, Math.PI * 2);
  ctx.fillStyle = activeTheme.ring;
  ctx.fill();

  ctx.beginPath();
  ctx.arc(x, y, rad, 0, Math.PI * 2);
  ctx.fillStyle = white ? '#ffffff' : activeTheme.cell;  // белая заливка (БМ и входы в дом)
  ctx.fill();
  ctx.strokeStyle = activeTheme.cellStroke;
  ctx.lineWidth = 1;
  ctx.stroke();

  if (label) {
    ctx.fillStyle = labelColor || activeTheme.ink;
    ctx.font = `bold ${String(label).length > 2 ? rad * 0.64 : rad * 0.82}px serif`;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText(label, x, y);
  }
}

function drawArrow(ctx, x, y, angle) {
  ctx.beginPath();
  ctx.arc(x, y, R + 2, 0, Math.PI * 2);
  ctx.fillStyle = activeTheme.ring;
  ctx.fill();

  ctx.beginPath();
  ctx.arc(x, y, R, 0, Math.PI * 2);
  ctx.fillStyle = activeTheme.cell;
  ctx.fill();
  ctx.strokeStyle = activeTheme.cellStroke;
  ctx.lineWidth = 1;
  ctx.stroke();

  ctx.save();
  ctx.translate(x, y);
  ctx.rotate(angle);
  const len = R * 0.65, hw = R * 0.25;
  ctx.strokeStyle = activeTheme.ink;
  ctx.fillStyle = activeTheme.ink;
  ctx.lineWidth = 2;
  ctx.lineCap = 'round';
  ctx.beginPath();
  ctx.moveTo(-len * 0.3, 0);
  ctx.lineTo(len * 0.5, 0);
  ctx.stroke();
  ctx.beginPath();
  ctx.moveTo(len * 0.5, 0);
  ctx.lineTo(len * 0.5 - hw * 0.8, -hw * 0.5);
  ctx.lineTo(len * 0.5 - hw * 0.8,  hw * 0.5);
  ctx.closePath();
  ctx.fill();
  ctx.restore();
}

function drawBars(ctx, x, y, size) {
  ctx.fillStyle = activeTheme.barBody;
  ctx.beginPath();
  ctx.arc(x, y, size, 0, Math.PI * 2);
  ctx.fill();
  ctx.strokeStyle = activeTheme.barStroke;
  ctx.lineWidth = 1;
  ctx.stroke();

  ctx.strokeStyle = activeTheme.barLines;
  ctx.lineWidth = 3;
  ctx.lineCap = 'round';
  for (let i = -1; i <= 1; i++) {
    ctx.beginPath();
    ctx.moveTo(x + i * (size * 0.38), y - size * 0.85);
    ctx.lineTo(x + i * (size * 0.38), y + size * 0.85);
    ctx.stroke();
  }
  ctx.lineWidth = 2;
  for (let i = -1; i <= 1; i++) {
    ctx.beginPath();
    ctx.moveTo(x - size * 0.85, y + i * (size * 0.35));
    ctx.lineTo(x + size * 0.85, y + i * (size * 0.35));
    ctx.stroke();
  }
}

function drawPiece(ctx, x, y, color, rad, highlight) {
  const FR = rad || R * 1.2;

  if (highlight) {
    // highlight может быть цветом (строка) — иначе белый.
    const hc = (typeof highlight === 'string') ? highlight : '#ffffff';
    ctx.save();
    ctx.beginPath();
    ctx.arc(x, y, FR + 4, 0, Math.PI * 2);
    ctx.shadowColor = hc;
    ctx.shadowBlur = 18;
    ctx.lineWidth = 4;
    ctx.strokeStyle = hc;
    ctx.stroke();
    ctx.restore();
  }

  ctx.beginPath();
  ctx.arc(x, y, FR + 2, 0, Math.PI * 2);
  ctx.fillStyle = '#1e0e00';
  ctx.fill();

  ctx.beginPath();
  ctx.arc(x, y, FR, 0, Math.PI * 2);
  ctx.fillStyle = color;
  ctx.fill();
  ctx.strokeStyle = 'rgba(255,255,255,0.6)';
  ctx.lineWidth = 1.5;
  ctx.stroke();

  ctx.beginPath();
  ctx.arc(x - FR * 0.3, y - FR * 0.3, FR * 0.25, 0, Math.PI * 2);
  ctx.fillStyle = 'rgba(255,255,255,0.3)';
  ctx.fill();
}

function drawCorner(ctx, cx, cy, player, opts) {
  opts = opts || {};
  const occupied = opts.occupied;      // seat has a player (undefined => offline: treat as present)
  const highlight = opts.highlight;    // it is this seat's turn
  const empty = occupied === false;    // online & nobody on this seat

  ctx.save();
  if (empty) ctx.globalAlpha = 0.32;   // dim unoccupied seats in online mode

  ctx.fillStyle = 'rgba(0,0,0,0.25)';
  ctx.beginPath();
  ctx.roundRect(cx - CW * 0.45, cy - CW * 0.45, CW * 0.9, CW * 0.9, 8);
  ctx.fill();

  if (highlight) {
    // Glowing border around the player whose turn it is.
    ctx.save();
    ctx.shadowColor = player.color;
    ctx.shadowBlur = 18;
    ctx.strokeStyle = player.color;
    ctx.lineWidth = 4;
    ctx.stroke();
    ctx.restore();
  } else {
    ctx.strokeStyle = player.color;
    ctx.lineWidth = 2;
    ctx.stroke();
  }

  if (opts.engineMode && window.ENGINE) {
    // Фишки в этой тюрьме: свои + пленные (цветом владельца). Пустые места (онлайн)
    // не показывают фишек.
    const held = empty ? [] : ENGINE.heldInPrison(opts.seat);
    held.forEach((h, slot) => {
      const off = PIECE_OFFSETS[slot] || [0, 0];
      const x = cx + off[0], y = cy + off[1];
      const hl = (opts.movable && opts.movable.has(`${h.seat},${h.i}`)) ? turnColor() : false;
      drawPiece(ctx, x, y, PLAYERS[h.seat].color, R * 1.2, hl);
      __pieceHits.push({ seat: h.seat, i: h.i, x, y, r: R * 1.4 });
    });
  } else {
    PIECE_OFFSETS.forEach(([dx, dy]) => {
      drawPiece(ctx, cx + dx, cy + dy, player.color);
    });
  }

  ctx.fillStyle = 'rgba(255,255,255,0.8)';
  ctx.font = `bold ${R * 1.1}px sans-serif`;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillText(empty ? 'свободно' : player.name, cx, cy + CW * 0.38);

  ctx.restore();
}

function drawBoard(canvas) {
  const TW = GRID * SP + OFF * 2 + MARGIN * 2;
  const TH = GRID * SP + OFF * 2 + MARGIN * 2;
  canvas.width = TW;
  canvas.height = TH;

  boardCanvas = canvas;
  __pieceHits = [];
  __targetHits = [];
  const ctx = canvas.getContext('2d');
  ctx.fillStyle = activeTheme.bg;
  ctx.fillRect(0, 0, TW, TH);

  // Крест
  for (let r = 0; r < GRID; r++) {
    for (let c = 0; c < GRID; c++) {
      const key = `${r},${c}`;
      if (r === centerR && c === centerC) continue;
      if (ARROW_CELLS.has(key)) continue;
      if (DIAG_ARROW_CELLS.has(key)) continue;
      if (inCross(r, c)) {
        drawCircle(ctx, boardPx(c), boardPy(r), ROMAN_CELLS[key] || '', ENTRY_CELLS.has(key));
      }
    }
  }

  // Крупные кружки (БМ и концы лучей) — больше обычных клеток.
  const ENDR = R * 1.45;     // радиус крупных кружков
  const ENDGAP = ENDR - R;   // сдвиг наружу, чтобы зазор до соседней клетки был как у обычных (4px)

  // БМ
  BM_CELLS.forEach(({r, c, nx, ny}) => {
    drawCircle(ctx, boardPx(c) + nx * ENDGAP, boardPy(r) + ny * ENDGAP, 'БМ', true, ENDR);
  });

  // Одиночки (концы лучей, напротив римской I) — входы в дом игрока:
  // белые, крупные, с буквой «Х» цветом владеющего лучом игрока.
  drawCircle(ctx, boardPx(9),  boardPy(2)  - ENDGAP, 'Х', true, ENDR, PLAYERS[0].color); // верх → игрок 1
  drawCircle(ctx, boardPx(11), boardPy(18) + ENDGAP, 'Х', true, ENDR, PLAYERS[2].color); // низ  → игрок 3
  drawCircle(ctx, boardPx(2)  - ENDGAP, boardPy(11), 'Х', true, ENDR, PLAYERS[3].color); // лево → игрок 4
  drawCircle(ctx, boardPx(18) + ENDGAP, boardPy(9),  'Х', true, ENDR, PLAYERS[1].color); // право→ игрок 2

  // Стрелки
  drawArrow(ctx, boardPx(centerC),   boardPy(centerR-1), Math.PI);
  drawArrow(ctx, boardPx(centerC+1), boardPy(centerR),  -Math.PI/2);
  drawArrow(ctx, boardPx(centerC),   boardPy(centerR+1), 0);
  drawArrow(ctx, boardPx(centerC-1), boardPy(centerR),   Math.PI/2);

  // Диагональные стрелки в углах вокруг центра — смотрят внутрь.
  DIAG_ARROWS.forEach(({ r, c, a }) => drawArrow(ctx, boardPx(c), boardPy(r), a));

  // Решётка в центре
  drawBars(ctx, boardPx(centerC), boardPy(centerR), R + 2);

  // Угловые зоны
  // Квадраты игроков ставим в диагональные секторы рядом с крестом.
  // QCELL — позиция центра квадрата (в клетках от края). Больше = ближе к кресту.
  const QCELL = 3.4;
  const inX = boardPx(QCELL), inY = boardPy(QCELL);
  const corners = [
    { cx: inX,       cy: inY },
    { cx: TW - inX,  cy: inY },
    { cx: inX,       cy: TH - inY },
    { cx: TW - inX,  cy: TH - inY },
  ];
  // Движок-отрисовка работает и офлайн, и онлайн (net.js зеркалит состояние в ENGINE).
  const engineMode = !!window.ENGINE;
  const movable = window.__movable instanceof Set ? window.__movable : null;
  corners.forEach((pos, i) => drawCorner(ctx, pos.cx, pos.cy, PLAYERS[i], {
    highlight: window.__turnSeat === i,
    // In online mode __occupied is a Set of taken seats; offline it's undefined
    // and every seat is treated as present (classic hot-seat board).
    occupied: window.__occupied ? window.__occupied.has(i) : undefined,
    engineMode,
    seat: i,
    movable,
  }));

  // Экспресс-клетки — тонкое синее кольцо-маркер.
  ctx.save();
  ctx.strokeStyle = '#1e90ff';
  ctx.lineWidth = 3;
  EXPRESS.forEach((idx) => {
    const [r, c] = TRACK[idx];
    const p = cellCenter(r, c);
    ctx.beginPath();
    ctx.arc(p.x, p.y, R * 0.72, 0, Math.PI * 2);
    ctx.stroke();
  });
  ctx.restore();

  // Клетки-цели (куда можно походить) — подсветка инверсией + кликабельны.
  if (engineMode) drawTargets(ctx);

  // Фишки на маршруте/в дорожке (только в офлайн-режиме движка).
  if (engineMode) drawTrackPieces(ctx, movable);

  drawDebug(ctx);
}

// Центр клетки-цели в canvas-координатах (учёт смещения «Х» и кармана БМ).
function targetCenter(t) {
  if (t.kind === 'exit') return xCenter(t.seat);
  if (t.kind === 'bmDivert' || t.kind === 'moveBM') return bmCenter(t.bm);
  return cellCenter(t.cell[0], t.cell[1]);
}
function targetRadius(t) {
  return (t.kind === 'bmDivert' || t.kind === 'moveBM' || t.kind === 'exit') ? R * 1.15 : R * 0.92;
}

// Подсветка клеток-целей цветом игрока, чей ход (заливка + кольцо).
function drawTargets(ctx) {
  const targets = window.__targets;
  if (!targets || !targets.length) return;
  const col = turnColor();
  ctx.save();
  targets.forEach((t) => {
    const c = targetCenter(t);
    const rad = targetRadius(t);
    ctx.beginPath();
    ctx.arc(c.x, c.y, rad, 0, Math.PI * 2);
    ctx.fillStyle = col;
    ctx.globalAlpha = 0.35;
    ctx.fill();
    ctx.globalAlpha = 1;
    ctx.lineWidth = 3;
    ctx.strokeStyle = col;
    ctx.stroke();
  });
  ctx.restore();
  targets.forEach((t, idx) => {
    const c = targetCenter(t);
    __targetHits.push({ idx, x: c.x, y: c.y, r: targetRadius(t) + R * 0.15 });
  });
}

// Отладочная нумерация клеток (включается ?debug=1). Подписи смещены в угол
// клетки, чтобы не перекрываться фишками.
function drawDebug(ctx) {
  if (!(window.DBG && DBG.enabled)) return;
  ctx.save();
  ctx.font = `bold ${Math.round(R * 0.5)}px sans-serif`;
  ctx.textAlign = 'left';
  ctx.textBaseline = 'top';
  const put = (x, y, txt, color) => {
    ctx.fillStyle = color;
    ctx.fillText(txt, x - R * 0.9, y - R * 0.9);
  };
  TRACK.forEach(([r, c], idx) => { const p = cellCenter(r, c); put(p.x, p.y, String(idx), '#b00020'); });
  HOME_LANE.forEach((lane, s) => lane.forEach(([r, c], k) => {
    const p = cellCenter(r, c); put(p.x, p.y, `h${s}.${k}`, '#0050c0');
  }));
  for (let s = 0; s < 4; s++) { const p = xCenter(s); put(p.x, p.y, `x${s}`, '#006400'); }
  BM_CELLS.forEach((b, n) => {
    const p = cellCenter(b.r, b.c);
    put(p.x + b.nx * R * 0.45, p.y + b.ny * R * 0.45, `бм${n}`, '#7a4a00');
  });
  const cp = cellCenter(centerR, centerC); put(cp.x, cp.y, 'ц', '#ffffff');
  ctx.restore();
}

// Рисует все фишки, вышедшие из тюрьмы, на их клетках. Несколько фишек на одной
// клетке слегка раздвигаются. Заполняет __pieceHits для попадания клика.
function drawTrackPieces(ctx, movable) {
  const groups = {};                 // "x,y" -> { x, y, list:[{seat,i}], onX }
  for (let s = 0; s < ENGINE.SEATS; s++) {
    for (let i = 0; i < ENGINE.PER_SEAT; i++) {
      const p = ENGINE.pieces[s][i];
      if (p.where === 'prison' || p.where === 'home') continue;
      const onX = (p.where === 'track' && p.progress === 0); // стоит на кружке «Х»
      let pos, big = onX;
      if (onX) {
        pos = xCenter(s);
      } else if (p.bm) {
        const b = BM_BY_TRACK[ENGINE.trackIndex(s, i)];
        pos = b ? bmCenter(b) : cellCenter(...ENGINE.cellOf(s, i));
        big = true;                            // БМ-кружок крупный
      } else {
        const cell = ENGINE.cellOf(s, i);
        if (!cell) continue;
        pos = cellCenter(cell[0], cell[1]);
      }
      const key = `${Math.round(pos.x)},${Math.round(pos.y)}`;
      (groups[key] || (groups[key] = { x: pos.x, y: pos.y, list: [], big })).list.push({ seat: s, i });
    }
  }
  Object.values(groups).forEach((g) => {
    const PR = g.big ? R * 1.05 : R * 0.8;     // на «Х»/БМ фишка крупнее (заметнее)
    const hitR = g.big ? R * 1.45 : R * 1.1;   // и кликается во весь кружок
    g.list.forEach((p, n) => {
      // лёгкое раздвижение при наложении нескольких фишек
      const ang = g.list.length > 1 ? (n / g.list.length) * Math.PI * 2 : 0;
      const rad = g.list.length > 1 ? R * 0.35 : 0;
      const px = g.x + Math.cos(ang) * rad;
      const py = g.y + Math.sin(ang) * rad;
      const hl = (movable && movable.has(`${p.seat},${p.i}`)) ? turnColor() : false;
      drawPiece(ctx, px, py, PLAYERS[p.seat].color, PR, hl);
      __pieceHits.push({ seat: p.seat, i: p.i, x: px, y: py, r: hitR });
    });
  });
}

// Клик по доске: сначала клетки-цели (onTargetClick), затем фишки (onBoardClick).
function setupBoardInput(canvas) {
  canvas.addEventListener('click', (e) => {
    const rect = canvas.getBoundingClientRect();
    const x = (e.clientX - rect.left) * (canvas.width / rect.width);
    const y = (e.clientY - rect.top) * (canvas.height / rect.height);

    // 1) клетка-цель
    if (typeof window.onTargetClick === 'function') {
      let bt = null, btD = Infinity;
      for (const h of __targetHits) {
        const d = Math.hypot(x - h.x, y - h.y);
        if (d <= h.r && d < btD) { bt = h; btD = d; }
      }
      if (bt) { window.onTargetClick(bt.idx); return; }
    }

    // 2) фишка
    if (typeof window.onBoardClick !== 'function') return;
    let best = null, bestD = Infinity;
    for (const h of __pieceHits) {
      const d = Math.hypot(x - h.x, y - h.y);
      if (d <= h.r && d < bestD) { best = h; bestD = d; }
    }
    if (best) window.onBoardClick(best.seat, best.i);
  });
}

// Переключение темы: палитра страницы (через data-theme) + перерисовка доски.
function applyTheme(name) {
  if (!THEMES[name]) name = 'day';
  activeTheme = THEMES[name];
  document.documentElement.dataset.theme = name;
  try { localStorage.setItem('pe-theme', name); } catch (e) {}
  if (boardCanvas) drawBoard(boardCanvas);
}
