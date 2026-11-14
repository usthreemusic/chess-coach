import { Chessground } from "../vendor/chessground.min.js";
import { Chess } from "../vendor/chess.js";

const $ = (id) => document.getElementById(id);
const el = (tag, className, text) => {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
};
const SVG = "http://www.w3.org/2000/svg";
const LABEL = { inaccuracy: "Inaccuracy", mistake: "Mistake", blunder: "Blunder" };

let game, analysis, board;
let fens = [];
let idx = 0;

// Share of the bar given to White, 0-100, from a centipawn score.
const whiteShare = (cp) => 50 + 50 * (2 / (1 + Math.exp(-0.004 * cp)) - 1);

function evalAt(i) {
  if (i === 0) return { cp: analysis.start_cp };
  return analysis.moves[i - 1];
}

function evalText({ cp, mate }) {
  if (mate !== undefined) {
    if (mate === 0) return cp > 0 ? "1-0" : "0-1";
    return (mate > 0 ? "M" : "-M") + Math.abs(mate);
  }
  return (cp > 0 ? "+" : "") + (cp / 100).toFixed(1);
}

function clockText(seconds) {
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  const s = Math.floor(seconds % 60);
  return (h ? `${h}:${String(m).padStart(2, "0")}` : m) + ":" + String(s).padStart(2, "0");
}

function moveLabel(i) {
  const n = Math.ceil(i / 2);
  return `${n}${i % 2 ? "." : "…"} ${analysis.moves[i - 1].san}`;
}

function show(i) {
  idx = Math.max(0, Math.min(analysis.moves.length, i));
  const move = idx ? analysis.moves[idx - 1] : null;
  const score = evalAt(idx);

  board.set({
    fen: fens[idx],
    lastMove: move ? [move.uci.slice(0, 2), move.uci.slice(2, 4)] : undefined,
  });
  board.setAutoShapes(
    move && move.class
      ? [{ orig: move.best_uci.slice(0, 2), dest: move.best_uci.slice(2, 4), brush: "green" }]
      : []
  );

  $("bar-white").style.height = whiteShare(score.cp) + "%";
  $("eval-text").textContent = evalText(score);
  $("cursor").setAttribute("x1", idx);
  $("cursor").setAttribute("x2", idx);

  const info = $("info");
  info.replaceChildren();
  if (!move) {
    info.append(el("p", "muted", "Starting position. Use the arrow keys or the buttons to step through."));
  } else {
    const mine = (idx % 2 === 1) === (game.colour === "white");
    const head = el("p", "move-head");
    head.append(el("strong", "", moveLabel(idx)), ` · ${mine ? "you" : game.opponent}`);
    if (move.class) {
      head.append(" · ", el("span", `tag ${move.class}`, `${LABEL[move.class]} (−${(move.drop / 100).toFixed(1)})`));
    }
    info.append(head);
    if (move.class) {
      const rest = move.pv.slice(1).join(" ");
      info.append(el("p", "", `Best was ${move.best}${rest ? `, then ${rest}` : ""}.`));
    }
    if (move.clk !== undefined && game.time_class !== "daily") {
      info.append(el("p", "muted", `Clock: ${clockText(move.clk)}`));
    }
  }

  for (const btn of document.querySelectorAll("#moves button.active")) btn.classList.remove("active");
  const active = document.querySelector(`#moves button[data-i="${idx}"]`);
  if (active) {
    active.classList.add("active");
    const list = $("moves");
    const top = active.offsetTop - list.offsetTop;
    if (top < list.scrollTop || top > list.scrollTop + list.clientHeight - 32) {
      list.scrollTop = top - list.clientHeight / 2;
    }
  }
}

function buildMoves() {
  const list = $("moves");
  list.replaceChildren();
  analysis.moves.forEach((move, k) => {
    if (k % 2 === 0) list.append(el("span", "num", `${k / 2 + 1}.`));
    const btn = el("button", move.class || "", move.san);
    btn.dataset.i = k + 1;
    if (move.class) btn.title = LABEL[move.class];
    btn.addEventListener("click", () => show(k + 1));
    list.append(btn);
  });
}

function buildGraph() {
  const svg = $("graph");
  const n = analysis.moves.length;
  svg.setAttribute("viewBox", `0 0 ${Math.max(n, 1)} 100`);
  const ys = [analysis.start_cp, ...analysis.moves.map((m) => m.cp)].map((cp) => 100 - whiteShare(cp));
  const add = (tag, attrs) => {
    const node = document.createElementNS(SVG, tag);
    for (const [k, v] of Object.entries(attrs)) node.setAttribute(k, v);
    svg.append(node);
    return node;
  };
  svg.replaceChildren();
  add("rect", { x: 0, y: 0, width: n, height: 100, class: "g-black" });
  add("polygon", { points: `0,100 ${ys.map((y, i) => `${i},${y.toFixed(1)}`).join(" ")} ${n},100`, class: "g-white" });
  add("line", { x1: 0, x2: n, y1: 50, y2: 50, class: "g-mid" });
  analysis.moves.forEach((move, k) => {
    const mine = (k % 2 === 0) === (game.colour === "white");
    if (mine && (move.class === "mistake" || move.class === "blunder")) {
      add("line", { x1: k + 1, x2: k + 1, y1: 0, y2: 100, class: `g-mark ${move.class}` });
    }
  });
  add("line", { id: "cursor", x1: 0, x2: 0, y1: 0, y2: 100, class: "g-cursor" });
  svg.onclick = (event) => {
    const box = svg.getBoundingClientRect();
    show(Math.round(((event.clientX - box.left) / box.width) * n));
  };
}

function buildHeader(games, position) {
  const date = new Date(game.end_time * 1000).toLocaleDateString(undefined, { year: "numeric", month: "short", day: "numeric" });
  const title = $("title");
  title.replaceChildren(
    el("span", `piece ${game.colour}`),
    `You (${game.my_rating ?? "?"}) vs ${game.opponent} (${game.opponent_rating ?? "?"}) · `,
    el("span", game.result, `${game.result} (${game.result_detail})`)
  );
  const c = analysis.counts;
  $("meta").replaceChildren(
    `${date} · ${game.time_class} · ${game.opening || "Unknown opening"} · `,
    el("span", "inaccuracy", `${c.inaccuracy} ${c.inaccuracy === 1 ? "inaccuracy" : "inaccuracies"}`), ", ",
    el("span", "mistake", `${c.mistake} ${c.mistake === 1 ? "mistake" : "mistakes"}`), ", ",
    el("span", "blunder", `${c.blunder} ${c.blunder === 1 ? "blunder" : "blunders"}`), " · "
  );
  const link = el("a", "", "View on chess.com");
  link.href = game.url;
  link.target = "_blank";
  link.rel = "noopener";
  $("meta").append(link);

  const neighbour = (id, other) => {
    $(id).hidden = !other;
    if (other) $(id).href = `review.html?id=${encodeURIComponent(other.id)}`;
  };
  neighbour("older", games[position - 1]);
  neighbour("newer", games[position + 1]);
}

async function init() {
  const fail = (message) => {
    $("status").textContent = message;
    $("status").hidden = false;
  };
  let games;
  try {
    games = (await (await fetch("data/games.json")).json()).games;
  } catch (err) {
    return fail("Could not load data/games.json.");
  }
  const wanted = new URLSearchParams(location.search).get("id");
  const analysed = games.filter((g) => g.mistakes);
  game = wanted ? games.find((g) => g.id === wanted) : analysed[analysed.length - 1];
  if (!game) return fail(wanted ? "Game not found." : "No games have been analysed yet.");
  if (!game.mistakes) return fail("This game has not been analysed yet. It will be picked up by the next update.");

  const resp = await fetch(`data/analysis/${encodeURIComponent(game.id)}.json`);
  if (!resp.ok) return fail("Could not load the analysis for this game.");
  analysis = await resp.json();

  const chess = new Chess();
  fens = [chess.fen()];
  for (const move of analysis.moves) {
    chess.move(move.san);
    fens.push(chess.fen());
  }

  $("review").hidden = false;
  board = Chessground($("board"), {
    fen: fens[0],
    orientation: game.colour,
    viewOnly: true,
    coordinates: true,
    drawable: { enabled: false, visible: true },
  });
  $("bar").classList.toggle("flipped", game.colour === "black");
  buildHeader(analysed, analysed.indexOf(game));
  buildMoves();
  buildGraph();

  $("first").onclick = () => show(0);
  $("prev").onclick = () => show(idx - 1);
  $("next").onclick = () => show(idx + 1);
  $("last").onclick = () => show(analysis.moves.length);
  $("next-mistake").onclick = () => {
    const mine = (i) => (i % 2 === 1) === (game.colour === "white");
    for (let i = idx + 1; i <= analysis.moves.length; i++) {
      const cls = analysis.moves[i - 1].class;
      if (mine(i) && (cls === "mistake" || cls === "blunder")) return show(i);
    }
  };
  document.addEventListener("keydown", (event) => {
    const step = { ArrowLeft: idx - 1, ArrowRight: idx + 1, Home: 0, End: analysis.moves.length }[event.key];
    if (step !== undefined) {
      event.preventDefault();
      show(step);
    }
  });
  const ply = parseInt(new URLSearchParams(location.search).get("ply"), 10);
  show(ply > 0 ? ply - 1 : 0);
}

// Chessground caches where the board sits on the page. Refresh that whenever the
// layout moves (theme switch, filters wrapping), or drags land on the wrong squares.
const refreshBoard = () => board && board.redrawAll();
window.addEventListener("themechange", refreshBoard);
new ResizeObserver(refreshBoard).observe(document.body);

init();
