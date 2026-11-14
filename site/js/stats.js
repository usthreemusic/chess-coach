const $ = (id) => document.getElementById(id);
const el = (tag, className, text) => {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
};

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
function barChart(canvas, rows, labels, colours, count = false) {
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
      plugins: { legend: { display: false }, tooltip: baseTooltip(rows, colours) },
    },
  });
}

function addCard(parent, title, note, height, wide) {
  const card = el("section", wide ? "chart-card wide" : "chart-card");
  card.appendChild(el("h2", "", title));
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

function renderCharts() {
  for (const c of charts) c.destroy();
  charts.length = 0;
  const host = $("charts");
  host.replaceChildren();
  const colours = chartColours();
  Chart.defaults.font.family = getComputedStyle(document.body).fontFamily;

  const months = data.dimensions.month || [];
  if (months.length) {
    const canvas = addCard(host, "Monthly trend", "Hover or tap a point for details. A hollow point has fewer than 150 moves.", 260, true);
    charts.push(lineChart(canvas, months, colours));
  }
  for (const [dim, title] of BAR_DIMS) {
    const rows = barRows(dim);
    if (!rows.length) continue;
    const note = dim === "opening"
      ? `Families with at least ${MIN_OPENING_GAMES} games, up to ${MAX_OPENINGS}.`
      : "Lighter bars have fewer than 150 moves.";
    const canvas = addCard(host, title, note, Math.max(120, rows.length * 36 + 60), false);
    charts.push(barChart(canvas, rows, rows.map((b) => cap(b.key)), colours));
  }
  const types = [...(data.dimensions.mistake_type || [])].sort((a, b) => b.moves - a.moves);
  if (types.length) {
    const canvas = addCard(host, "Mistake type",
      "How many of your mistakes and blunders have each tag. One mistake can have several tags.",
      Math.max(120, types.length * 36 + 60), false);
    charts.push(barChart(canvas, types, types.map((b) => MISTAKE_TYPE_LABELS[b.key] || cap(b.key)), colours, true));
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
