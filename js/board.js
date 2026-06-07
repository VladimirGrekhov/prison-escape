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

// ----------------------------------------------------------------------------
// Топология маршрута (для игрового движка). Клетки — [row, col] сетки.
// Пиксели берутся через boardPx/boardPy. Координаты подобраны под текущую доску
// и подлежат визуальной донастройке вместе с пользователем.
// ----------------------------------------------------------------------------

// Главная петля по периметру креста (56 клеток). `.reverse()` задаёт направление
// движения — против часовой стрелки.
const TRACK = [
  [3,10],[3,11],[4,11],[5,11],[6,11],[7,11],[8,11],[9,11],
  [9,12],[9,13],[9,14],[9,15],[9,16],[9,17],
  [10,17],
  [11,17],[11,16],[11,15],[11,14],[11,13],[11,12],[11,11],
  [12,11],[13,11],[14,11],[15,11],[16,11],[17,11],
  [17,10],
  [17,9],[16,9],[15,9],[14,9],[13,9],[12,9],[11,9],
  [11,8],[11,7],[11,6],[11,5],[11,4],[11,3],
  [10,3],
  [9,3],[9,4],[9,5],[9,6],[9,7],[9,8],[9,9],
  [8,9],[7,9],[6,9],[5,9],[4,9],[3,9],
].reverse();
const TRACK_KEY = TRACK.map(([r, c]) => `${r},${c}`);
const trackIndexOf = (r, c) => TRACK_KEY.indexOf(`${r},${c}`);

// Клетка-вход на маршрут для каждого места (откуда фишка выходит из тюрьмы).
const ENTRY = [
  trackIndexOf(3, 10),   // место 0 — верхний луч
  trackIndexOf(10, 17),  // место 1 — правый луч
  trackIndexOf(17, 10),  // место 2 — нижний луч
  trackIndexOf(10, 3),   // место 3 — левый луч
];

// Домашняя дорожка (I→V→центр) для каждого места, от кончика луча к центру.
const HOME_LANE = [
  [[4,10],[5,10],[6,10],[7,10],[8,10],[9,10],[10,10]],     // верх
  [[10,16],[10,15],[10,14],[10,13],[10,12],[10,11],[10,10]], // право
  [[16,10],[15,10],[14,10],[13,10],[12,10],[11,10],[10,10]], // низ
  [[10,4],[10,5],[10,6],[10,7],[10,8],[10,9],[10,10]],     // лево
];

const TRACK_MAIN = TRACK.length;        // длина петли
const LANE_LEN = HOME_LANE[0].length;   // длина домашней дорожки (включая центр)
// progress 0 = вход (рисуется на «Х»); далее петля; затем домашняя дорожка.
const MAX_PROGRESS = TRACK_MAIN + LANE_LEN - 1; // точное число для финиша (центр)

// Кружок «Х» (вход в дом) каждого места — стартовая позиция после выхода (progress 0).
const X_GRID = [
  [2, 9],   // место 0 — верх
  [9, 18],  // место 1 — право
  [18, 11], // место 2 — низ
  [11, 2],  // место 3 — лево
];
const X_OFF = R * 0.45; // сдвиг центра «Х» наружу (как у нарисованного крупного кружка)
const X_SHIFT = [[0, -X_OFF], [X_OFF, 0], [0, X_OFF], [-X_OFF, 0]];
function xCenter(seat) {
  const [r, c] = X_GRID[seat];
  return { x: boardPx(c) + X_SHIFT[seat][0], y: boardPy(r) + X_SHIFT[seat][1] };
}

// Безопасные клетки (нельзя срубить): входы на маршрут + кружки «Х».
const SAFE = new Set([
  '3,10', '10,17', '17,10', '10,3',
  '2,9', '9,18', '18,11', '11,2',
]);

function cellCenter(r, c) { return { x: boardPx(c), y: boardPy(r) }; }

// nx/ny — направление сдвига наружу (от прилегающей клетки луча креста),
// чтобы увеличенный кружок не наезжал на соседа.
const BM_CELLS = [
  {r:8,  c:6,  nx:0,  ny:-1}, {r:12, c:6,  nx:0,  ny:1},
  {r:8,  c:14, nx:0,  ny:-1}, {r:12, c:14, nx:0,  ny:1},
  {r:6,  c:8,  nx:-1, ny:0},  {r:6,  c:12, nx:1,  ny:0},
  {r:14, c:8,  nx:-1, ny:0},  {r:14, c:12, nx:1,  ny:0},
];

// Сопоставление БМ ↔ соседняя клетка маршрута (для съезда «на БМ»).
const BM_BY_TRACK = {};
BM_CELLS.forEach((b) => {
  [[b.r-1, b.c], [b.r+1, b.c], [b.r, b.c-1], [b.r, b.c+1]].forEach(([r, c]) => {
    const idx = trackIndexOf(r, c);
    if (idx >= 0) BM_BY_TRACK[idx] = b;
  });
});
BM_CELLS.forEach((b) => SAFE.add(`${b.r},${b.c}`)); // карманы БМ безопасны
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

function isOnlineMode() { return !!(window.MP && window.MP.enabled); }

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
    ctx.save();
    ctx.beginPath();
    ctx.arc(x, y, FR + 4, 0, Math.PI * 2);
    ctx.shadowColor = '#ffffff';
    ctx.shadowBlur = 16;
    ctx.lineWidth = 3;
    ctx.strokeStyle = '#ffffff';
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
    // Только фишки, ещё сидящие в тюрьме, по их реальным индексам.
    const row = ENGINE.pieces[opts.seat];
    let slot = 0;
    for (let i = 0; i < row.length; i++) {
      if (row[i].where !== 'prison') continue;
      const off = PIECE_OFFSETS[slot++] || [0, 0];
      const x = cx + off[0], y = cy + off[1];
      const hl = opts.movable && opts.movable.has(`${opts.seat},${i}`);
      drawPiece(ctx, x, y, player.color, R * 1.2, hl);
      __pieceHits.push({ seat: opts.seat, i, x, y, r: R * 1.4 });
    }
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
  const engineMode = !isOnlineMode() && !!window.ENGINE;
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

  // Фишки на маршруте/в дорожке (только в офлайн-режиме движка).
  if (engineMode) drawTrackPieces(ctx, movable);

  drawDebug(ctx);
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
      const hl = movable && movable.has(`${p.seat},${p.i}`);
      drawPiece(ctx, px, py, PLAYERS[p.seat].color, PR, hl);
      __pieceHits.push({ seat: p.seat, i: p.i, x: px, y: py, r: hitR });
    });
  });
}

// Клик по доске → ближайшая фишка под курсором → window.onBoardClick(seat,i).
function setupBoardInput(canvas) {
  canvas.addEventListener('click', (e) => {
    if (typeof window.onBoardClick !== 'function') return;
    const rect = canvas.getBoundingClientRect();
    const x = (e.clientX - rect.left) * (canvas.width / rect.width);
    const y = (e.clientY - rect.top) * (canvas.height / rect.height);
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
