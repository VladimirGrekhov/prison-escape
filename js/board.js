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

// nx/ny — направление сдвига наружу (от прилегающей клетки луча креста),
// чтобы увеличенный кружок не наезжал на соседа.
const BM_CELLS = [
  {r:8,  c:6,  nx:0,  ny:-1}, {r:12, c:6,  nx:0,  ny:1},
  {r:8,  c:14, nx:0,  ny:-1}, {r:12, c:14, nx:0,  ny:1},
  {r:6,  c:8,  nx:-1, ny:0},  {r:6,  c:12, nx:1,  ny:0},
  {r:14, c:8,  nx:-1, ny:0},  {r:14, c:12, nx:1,  ny:0},
];

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

function drawCircle(ctx, x, y, label, bm, rad = R) {
  ctx.beginPath();
  ctx.arc(x, y, rad + 2, 0, Math.PI * 2);
  ctx.fillStyle = activeTheme.ring;
  ctx.fill();

  ctx.beginPath();
  ctx.arc(x, y, rad, 0, Math.PI * 2);
  ctx.fillStyle = bm ? '#ffffff' : activeTheme.cell;  // БМ — чисто белый фон
  ctx.fill();
  ctx.strokeStyle = activeTheme.cellStroke;
  ctx.lineWidth = 1;
  ctx.stroke();

  if (label) {
    ctx.fillStyle = activeTheme.ink;
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

function drawPiece(ctx, x, y, color) {
  const FR = R * 1.2;
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

  PIECE_OFFSETS.forEach(([dx, dy]) => {
    drawPiece(ctx, cx + dx, cy + dy, player.color);
  });

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
        drawCircle(ctx, boardPx(c), boardPy(r), ROMAN_CELLS[key] || '', false);
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

  // Одиночки (концы лучей креста) — рисуем крупнее остальных.
  drawCircle(ctx, boardPx(9),  boardPy(2)  - ENDGAP, '', false, ENDR);  // верх
  drawCircle(ctx, boardPx(11), boardPy(18) + ENDGAP, '', false, ENDR);  // низ
  drawCircle(ctx, boardPx(2)  - ENDGAP, boardPy(11), 'Л', false, ENDR); // лево
  drawCircle(ctx, boardPx(18) + ENDGAP, boardPy(9),  'В', false, ENDR); // право

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
  corners.forEach((pos, i) => drawCorner(ctx, pos.cx, pos.cy, PLAYERS[i], {
    highlight: window.__turnSeat === i,
    // In online mode __occupied is a Set of taken seats; offline it's undefined
    // and every seat is treated as present (classic hot-seat board).
    occupied: window.__occupied ? window.__occupied.has(i) : undefined,
  }));
}

// Переключение темы: палитра страницы (через data-theme) + перерисовка доски.
function applyTheme(name) {
  if (!THEMES[name]) name = 'day';
  activeTheme = THEMES[name];
  document.documentElement.dataset.theme = name;
  try { localStorage.setItem('pe-theme', name); } catch (e) {}
  if (boardCanvas) drawBoard(boardCanvas);
}
