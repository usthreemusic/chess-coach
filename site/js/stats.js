const $ = (id) => document.getElementById(id);
const el = (tag, className, text) => {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
};

// The ONLY place the puzzle data is fetched. Cached after the first call; returns null if unavailable.
let puzzlesPromise = null;
function loadPuzzles() {
  if (!puzzlesPromise) {
    puzzlesPromise = (async () => {
      try {
        const res = await fetch("data/puzzles.json");
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const body = await res.json();
        if (!body || !Array.isArray(body.puzzles)) throw new Error("unexpected format");
        return body.puzzles;
      } catch (err) {
        puzzlesPromise = null; // allow a retry next time
        return null;
      }
    })();
  }
  return puzzlesPromise;
}

// HELPERS-START (pure; also exercised by a scratch Node script)
// Kind of move for a SAN string, first match wins.
function moveKind(san) {
  if (!san) return "Quiet piece move";
  if (san.endsWith("#")) return "Checkmate";
  if (san.endsWith("+")) return "Check";
  if (san.includes("x")) return "Capture";
  if (san.includes("=")) return "Promotion";
  if (san.startsWith("O-O")) return "Castling";
  if (/^[a-h]/.test(san)) return "Quiet pawn move";
  return "Quiet piece move";
}

// Opening below full move 12; endgame at 13 points or less of non-pawn material; else middlegame.
function phaseOf(fen, ply) {
  if (Math.ceil(ply / 2) < 12) return "Opening";
  const values = { q: 9, r: 5, b: 3, n: 3 };
  let total = 0;
  for (const ch of fen.split(" ")[0].toLowerCase()) total += values[ch] || 0;
  return total <= 13 ? "Endgame" : "Middlegame";
}

// Piece moved, from SAN. Castling counts as the King.
function pieceMoved(san) {
  if (!san) return "Pawn";
  if (san.startsWith("O-O")) return "King";
  const names = { K: "King", Q: "Queen", R: "Rook", B: "Bishop", N: "Knight" };
  return names[san[0]] || "Pawn";
}

// Centipawn drop to a bucket label.
function costBucket(drop) {
  if (drop >= 500) return "5+ pawns";
  if (drop >= 300) return "3–5 pawns";
  if (drop >= 200) return "2–3 pawns";
  return "1–2 pawns";
}
// HELPERS-END

const MOVE_KIND_ORDER = ["Checkmate", "Check", "Capture", "Promotion", "Castling", "Quiet pawn move", "Quiet piece move"];
const PHASE_LABELS = ["Opening", "Middlegame", "Endgame"];
const COST_LABELS = ["1–2 pawns", "2–3 pawns", "3–5 pawns", "5+ pawns"];
const MAX_EXAMPLES = 8;
const MAX_PANEL_OPENINGS = 6;

const MIN_MOVES = 150; // buckets with fewer moves are low-sample
const MIN_OPENING_GAMES = 5;
const MAX_OPENINGS = 12;
const PHASE_ORDER = ["opening", "middlegame", "endgame"];
const WEAKNESS_DIMS = ["phase", "opening", "time_class", "time_pressure", "piece"];
const BAR_DIMS = [
  ["phase", "Game phase"],
  ["opening", "Opening"],
  ["time_class", "Time class"],
  ["time_pressure", "Time pressure"],
  ["piece", "Piece moved"],
  ["colour", "Colour"],
];

const MISTAKE_TYPE_LABELS = {
  missed_mate: "Missed mate",
  missed_capture: "Missed capture",
  missed_fork: "Missed fork",
  hung_piece: "Hung a piece",
  back_rank: "Back rank",
  endgame: "Endgame",
  other: "Other",
};

let data = null;
let openTag = null; // tag whose detail panel is open
let panelToken = 0; // guards against a slow load finishing after the panel changed
const panelCharts = []; // kept apart from `charts` so closing a panel never touches the main charts

const rate = (b) => (b.moves ? ((b.mistake + b.blunder) / b.moves) * 100 : 0);
const fmt = (x) => x.toFixed(1);
const cap = (s) => s.charAt(0).toUpperCase() + s.slice(1);
const isLow = (b) => b.moves < MIN_MOVES;

function weaknessLabel(dim, key) {
  switch (dim) {
    case "opening": return `${key} games`;
    case "time_class": return `${cap(key)} games`;
    case "piece": return `${cap(key)} moves`;
    case "time_pressure": return cap(key);
    default: return cap(key);
  }
}

function css(name) {
  return getComputedStyle(document.documentElement).getPropertyValue(name).trim();
}

// Convert any CSS colour to rgba() with the given alpha, via the canvas parser
function withAlpha(colour, alpha) {
  const ctx = document.createElement("canvas").getContext("2d");
  ctx.fillStyle = "#000";
  ctx.fillStyle = colour;
  const c = ctx.fillStyle; // "#rrggbb" or "rgba(...)"
  if (c.startsWith("#")) {
    const n = parseInt(c.slice(1), 16);
    return `rgba(${n >> 16}, ${(n >> 8) & 255}, ${n & 255}, ${alpha})`;
  }
  return c;
}

function tooltipLines(b, count) {
  if (count) {
    return [
      `Mistakes and blunders: ${b.moves}`,
      `Mistakes: ${b.mistake}`,
      `Blunders: ${b.blunder}`,
      `Games: ${b.games}`,
    ];
  }
  const lines = [
    `Error rate: ${fmt(rate(b))} per 100 moves${isLow(b) ? " (few moves)" : ""}`,
    `Mistakes: ${b.mistake}`,
    `Blunders: ${b.blunder}`,
    `Inaccuracies: ${b.inaccuracy}`,
    `Moves: ${b.moves}`,
    `Games: ${b.games}`,
  ];
  return lines;
}

function renderSummary() {
  const t = data.totals;
  const overall = ((t.mistake + t.blunder) / data.moves) * 100;
  $("summary").textContent =
    `${data.games} games analysed, ${data.moves} of your moves, overall error rate ${fmt(overall)} per 100 moves ` +
    `(${t.inaccuracy} inaccuracies, ${t.mistake} mistakes, ${t.blunder} blunders).`;
  return overall;
}

function renderWeaknesses(overall) {
  const list = $("weaknesses");
  const all = [];
  for (const dim of WEAKNESS_DIMS) {
    for (const b of data.dimensions[dim] || []) {
      if (b.moves >= MIN_MOVES) all.push({ dim, b, r: rate(b) });
    }
  }
  all.sort((x, y) => y.r - x.r);
  const top = all.slice(0, 3);
  if (!top.length || overall <= 0) {
    list.appendChild(el("li", "", "Not enough moves yet to rank weaknesses."));
    return;
  }
  for (const { dim, b, r } of top) {
    list.appendChild(el("li", "",
      `${weaknessLabel(dim, b.key)}: ${fmt(r)} errors per 100 moves, ${fmt(r / overall)}× your average`));
  }
}

function chartColours() {
  const accent = css("--accent");
  return {
    accent,
    accentLow: withAlpha(accent, 0.35),
    text: css("--text"),
    muted: css("--muted"),
    line: css("--line"),
    surface: css("--surface"),
  };
}

// Draws the rate at the end of each bar so values read without hovering
const valueLabels = {
  id: "valueLabels",
  afterDatasetsDraw(chart, args, opts) {
    const meta = chart.getDatasetMeta(0);
    const { ctx } = chart;
    ctx.save();
    ctx.fillStyle = opts.colour;
    ctx.font = `12px ${getComputedStyle(document.body).fontFamily}`;
    ctx.textBaseline = "middle";
    meta.data.forEach((bar, i) => {
      ctx.textAlign = "left";
      const value = chart.data.datasets[0].data[i];
      ctx.fillText(opts.count ? String(value) : fmt(value), bar.x + 6, bar.y);
    });
    ctx.restore();
  },
};

const charts = [];
let tagCard = null; // the Mistake type card, which the panel is inserted after
const tagLabel = (key) => MISTAKE_TYPE_LABELS[key] || cap(key);

function baseTooltip(rows, colours, count) {
  return {
    backgroundColor: colours.surface,
    titleColor: colours.text,
    bodyColor: colours.text,
    borderColor: colours.line,
    borderWidth: 1,
    displayColors: false,
    callbacks: {
      title: (items) => items[0].label,
      label: (item) => tooltipLines(rows[item.dataIndex], count),
    },
  };
}

// count: bars show how many mistakes and blunders there are, not a rate per 100 moves
function barChart(canvas, rows, labels, colours, count = false, onClick = null) {
  return new Chart(canvas, {
    type: "bar",
    data: {
      labels,
      datasets: [{
        data: rows.map(count ? (b) => b.moves : rate),
        backgroundColor: rows.map((b) => (!count && isLow(b) ? colours.accentLow : colours.accent)),
        borderRadius: 4,
        barPercentage: 0.7,
        categoryPercentage: 0.9,
      }],
    },
    options: {
      indexAxis: "y",
      responsive: true,
      maintainAspectRatio: false,
      animation: false,
      layout: { padding: { right: 36 } },
      ...(onClick ? {
        onClick: (evt, elements) => { if (elements.length) onClick(elements[0].index); },
        onHover: (evt, elements) => { evt.native.target.style.cursor = elements.length ? "pointer" : ""; },
      } : {}),
      scales: {
        x: {
          beginAtZero: true,
          grid: { color: colours.line },
          border: { display: false },
          ticks: { color: colours.muted },
          title: { display: true, text: count ? "Mistakes and blunders (count)" : "Errors per 100 moves", color: colours.muted },
        },
        y: {
          grid: { display: false },
          border: { color: colours.line },
          ticks: { color: colours.text, font: { size: 13 } },
        },
      },
      plugins: {
        legend: { display: false },
        tooltip: baseTooltip(rows, colours, count),
        valueLabels: { colour: colours.text, count },
      },
    },
    plugins: [valueLabels],
  });
}

function lineChart(canvas, rows, colours) {
  return new Chart(canvas, {
    type: "line",
    data: {
      labels: rows.map((b) => b.key),
      datasets: [{
        data: rows.map(rate),
        borderColor: colours.accent,
        backgroundColor: colours.accent,
        borderWidth: 2,
        pointRadius: 4,
        pointHoverRadius: 6,
        pointBackgroundColor: rows.map((b) => (isLow(b) ? colours.surface : colours.accent)),
        pointBorderColor: colours.accent,
        tension: 0,
      }],
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      animation: false,
      interaction: { mode: "nearest", axis: "x", intersect: false },
      scales: {
        x: { grid: { display: false }, border: { color: colours.line }, ticks: { color: colours.muted, maxRotation: 0, autoSkipPadding: 12 } },
        y: {
          beginAtZero: true,
          grid: { color: colours.line },
          border: { display: false },
          ticks: { color: colours.muted },
          title: { display: true, text: "Errors per 100 moves", color: colours.muted },
        },
      },
      plugins: {
        legend: { display: false },
        // Sit below the point with a long arrow, so the tooltip does not cover the line.
        tooltip: { ...baseTooltip(rows, colours), yAlign: "top", caretSize: 20, caretPadding: 12 },
      },
    },
  });
}

// key: "bar" or "point" adds a small "<150 moves" colour key at the top right.
function addCard(parent, title, note, height, wide, key) {
  const card = el("section", wide ? "chart-card wide" : "chart-card");
  const head = el("div", "chart-head");
  head.appendChild(el("h2", "", title));
  if (key) {
    const legend = el("span", "chart-key");
    legend.append(el("i", key), `<${MIN_MOVES} moves`);
    head.appendChild(legend);
  }
  card.appendChild(head);
  if (note) card.appendChild(el("p", "muted", note));
  const box = el("div", "chart-box");
  box.style.height = `${height}px`;
  const canvas = document.createElement("canvas");
  box.appendChild(canvas);
  card.appendChild(box);
  parent.appendChild(card);
  return canvas;
}

function barRows(dim) {
  let rows = [...(data.dimensions[dim] || [])];
  if (dim === "opening") {
    rows = rows.filter((b) => b.games >= MIN_OPENING_GAMES)
      .sort((a, b) => b.games - a.games).slice(0, MAX_OPENINGS);
  }
  if (dim === "phase") {
    rows.sort((a, b) => PHASE_ORDER.indexOf(a.key) - PHASE_ORDER.indexOf(b.key));
  } else {
    rows.sort((a, b) => rate(b) - rate(a));
  }
  return rows;
}

function destroyPanelCharts() {
  for (const c of panelCharts) c.destroy();
  panelCharts.length = 0;
}

function removePanel() {
  destroyPanelCharts();
  const old = document.getElementById("tag-panel");
  if (old) old.remove();
}

function closePanel() {
  panelToken++;
  openTag = null;
  removePanel();
}

// Rows for a bar chart: one per label, counts plus mistake/blunder/game numbers for the tooltip.
function tally(list, keyFn, order, limit) {
  const map = new Map();
  for (const p of list) {
    const k = keyFn(p);
    if (!map.has(k)) map.set(k, { key: k, moves: 0, mistake: 0, blunder: 0, games: new Set() });
    const r = map.get(k);
    r.moves++;
    if (p.class === "blunder") r.blunder++; else r.mistake++;
    r.games.add(p.game_id);
  }
  let rows;
  if (order) rows = order.map((k) => map.get(k) || { key: k, moves: 0, mistake: 0, blunder: 0, games: new Set() });
  else rows = [...map.values()].sort((a, b) => b.moves - a.moves || a.key.localeCompare(b.key));
  if (limit) rows = rows.slice(0, limit);
  for (const r of rows) r.games = r.games.size;
  return rows;
}

function formatDay(epoch) {
  return new Date(epoch * 1000).toLocaleDateString("en-GB", { day: "numeric", month: "short", year: "numeric" });
}

function fillPanel(panel, tag, list) {
  const colours = chartColours();
  const grid = el("div", "detail-grid");
  const breakdowns = [
    ["What the best move was", tally(list, (p) => moveKind(p.best_san), null)],
    ["What you played instead", tally(list, (p) => moveKind(p.played_san), null)],
    ["Game phase", tally(list, (p) => phaseOf(p.fen, p.ply), PHASE_LABELS)],
    ["Piece you moved", tally(list, (p) => pieceMoved(p.played_san), null)],
    ["How costly", tally(list, (p) => costBucket(p.drop), COST_LABELS)],
    ["Opening", tally(list, (p) => p.opening_family || "Unknown", null, MAX_PANEL_OPENINGS)],
  ];
  for (const [title, rows] of breakdowns) {
    if (!rows.length) continue;
    const item = el("div", "detail-item");
    item.appendChild(el("h3", "", title));
    const box = el("div", "chart-box");
    box.style.height = `${Math.max(100, rows.length * 34 + 56)}px`;
    const canvas = document.createElement("canvas");
    box.appendChild(canvas);
    item.appendChild(box);
    grid.appendChild(item);
    panelCharts.push(barChart(canvas, rows, rows.map((r) => r.key), colours, true));
  }
  panel.appendChild(grid);

  panel.appendChild(el("h3", "detail-sub", "Recent examples"));
  const ul = el("ul", "examples");
  const recent = [...list].sort((a, b) => b.end_time - a.end_time || b.ply - a.ply).slice(0, MAX_EXAMPLES);
  for (const p of recent) {
    const li = el("li");
    const a = el("a", "", `${formatDay(p.end_time)} · ${p.opening_family || "Unknown opening"} · you played ${p.played_san}, best was ${p.best_san}`);
    a.href = `review.html?id=${encodeURIComponent(p.game_id)}&ply=${p.ply}`;
    li.appendChild(a);
    ul.appendChild(li);
  }
  panel.appendChild(ul);

  const train = el("a", "button-link", "Train these mistakes");
  train.href = `train.html?tag=${encodeURIComponent(tag)}`;
  panel.appendChild(el("p", "detail-train")).appendChild(train);
}

async function openPanel(tag, scroll = true) {
  if (!tagCard) return;
  const token = ++panelToken;
  openTag = tag;
  removePanel();
  const row = (data.dimensions.mistake_type || []).find((b) => b.key === tag);
  const panel = el("section", "chart-card wide tag-panel");
  panel.id = "tag-panel";
  const head = el("div", "chart-head");
  const title = el("h2", "", `Inside: ${tagLabel(tag)}`);
  if (row) title.append(el("span", "muted detail-count", ` · ${row.moves.toLocaleString()} mistakes and blunders`));
  head.appendChild(title);
  const close = el("button", "tag-close", "Close");
  close.type = "button";
  close.onclick = closePanel;
  head.appendChild(close);
  panel.appendChild(head);
  const status = el("p", "muted", "Loading…");
  panel.appendChild(status);
  tagCard.after(panel);
  if (scroll) panel.scrollIntoView({ behavior: "smooth", block: "start" });

  const all = await loadPuzzles();
  if (token !== panelToken) return; // closed or replaced while loading
  if (!all) {
    status.textContent = "Could not load the detailed puzzle data, so there is nothing more to show here yet.";
    return;
  }
  const list = all.filter((p) => (p.tags || []).includes(tag));
  if (!list.length) {
    status.textContent = "No puzzles found with this tag.";
    return;
  }
  status.remove();
  Chart.defaults.font.family = getComputedStyle(document.body).fontFamily;
  fillPanel(panel, tag, list);
}

function renderCharts() {
  for (const c of charts) c.destroy();
  charts.length = 0;
  destroyPanelCharts();
  tagCard = null;
  const host = $("charts");
  host.replaceChildren();
  const colours = chartColours();
  Chart.defaults.font.family = getComputedStyle(document.body).fontFamily;

  const months = data.dimensions.month || [];
  if (months.length) {
    const canvas = addCard(host, "Monthly trend", "Tap a point for details.", 260, true,
      months.some((b) => b.moves < MIN_MOVES) ? "point" : null);
    charts.push(lineChart(canvas, months, colours));
  }
  for (const [dim, title] of BAR_DIMS) {
    const rows = barRows(dim);
    if (!rows.length) continue;
    const note = dim === "opening" ? `Families with at least ${MIN_OPENING_GAMES} games, up to ${MAX_OPENINGS}.` : "";
    const canvas = addCard(host, title, note, Math.max(120, rows.length * 36 + 60), false,
      rows.some((b) => b.moves < MIN_MOVES) ? "bar" : null);
    charts.push(barChart(canvas, rows, rows.map((b) => cap(b.key)), colours));
  }
  const types = [...(data.dimensions.mistake_type || [])].sort((a, b) => b.moves - a.moves);
  if (types.length) {
    const canvas = addCard(host, "Mistake type",
      "Tap a bar or a button to look inside a category.",
      Math.max(120, types.length * 36 + 60), false);
    charts.push(barChart(canvas, types, types.map((b) => tagLabel(b.key)), colours, true,
      (i) => openPanel(types[i].key)));
    const card = canvas.closest(".chart-card");
    const buttons = el("div", "tag-buttons");
    for (const b of types) {
      const btn = el("button", "tag-button", `${tagLabel(b.key)} (${b.moves.toLocaleString()})`);
      btn.type = "button";
      btn.onclick = () => openPanel(b.key);
      buttons.appendChild(btn);
    }
    card.appendChild(buttons);
    tagCard = card;
    if (openTag) openPanel(openTag, false); // rebuild after a redraw
  }
}

function showStatus(message) {
  const status = $("status");
  status.textContent = message;
  status.hidden = false;
  $("stats").hidden = true;
}

async function init() {
  try {
    const res = await fetch("data/stats.json");
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    data = await res.json();
    if (!data || !data.dimensions) throw new Error("unexpected format");
  } catch (err) {
    showStatus("Stats are not available yet. They are built after games have been analysed.");
    return;
  }
  if (!data.moves) {
    showStatus("No analysed games yet, so there are no stats to show.");
    return;
  }
  $("stats").hidden = false;
  renderWeaknesses(renderSummary());
  renderCharts();
  // Colours come from CSS variables, so redraw when the colour scheme changes
  const mq = window.matchMedia("(prefers-color-scheme: dark)");
  mq.addEventListener("change", renderCharts);
  window.addEventListener("themechange", renderCharts);
}

init();
