import { ready, onRefresh } from "./app.js";
import { loadGames, loadPuzzles, currentUser } from "./core/data.js";
import { renderCoach } from "./coach.js";

const PAGE = 200;
const $ = (id) => document.getElementById(id);
let games = [];
let shown = PAGE;

function cell(row, text, className) {
  const td = row.insertCell();
  td.textContent = text;
  if (className) td.className = className;
  return td;
}

function filtered() {
  const cls = $("f-class").value;
  const colour = $("f-colour").value;
  const result = $("f-result").value;
  const list = games.filter(
    (g) => (!cls || g.time_class === cls) && (!colour || g.colour === colour) && (!result || g.result === result)
  );
  return $("f-order").value === "desc" ? list.reverse() : list;
}

function render() {
  const list = filtered();
  const count = (r) => list.filter((g) => g.result === r).length;
  $("summary").textContent =
    `${list.length} games · ${count("win")} won · ${count("loss")} lost · ${count("draw")} drawn`;

  const body = $("rows");
  body.replaceChildren();
  for (const g of list.slice(0, shown)) {
    const row = body.insertRow();
    cell(row, new Date(g.end_time * 1000).toLocaleDateString(undefined, { year: "numeric", month: "short", day: "numeric" }));
    cell(row, g.time_class);
    const res = cell(row, "", g.result);
    const dot = document.createElement("span");
    dot.className = `piece ${g.colour}`;
    dot.title = `Played ${g.colour}`;
    res.append(dot, `${g.result} (${g.result_detail})`);
    cell(row, `${g.opponent} (${g.opponent_rating ?? "?"})`);
    cell(row, g.my_rating ?? "", "num");
    cell(row, g.opening, "opening");
    const mistakes = cell(row, g.mistakes ? "" : "—", "num");
    if (g.mistakes) {
      for (const kind of ["inaccuracy", "mistake", "blunder"]) {
        const span = document.createElement("span");
        span.className = `count ${kind}`;
        span.title = kind;
        span.textContent = g.mistakes[kind];
        mistakes.append(span);
      }
    }
    const link = document.createElement("a");
    if (g.mistakes) {
      link.href = `review.html?id=${encodeURIComponent(g.id)}`;
      link.textContent = "Review";
    } else {
      link.href = g.url;
      link.target = "_blank";
      link.rel = "noopener";
      link.textContent = "chess.com";
    }
    cell(row, "").append(link);
  }
  $("empty").hidden = list.length > 0;
  $("more").hidden = list.length <= shown;
}

function fillClassOptions() {
  const select = $("f-class");
  const have = new Set([...select.options].map((o) => o.value));
  for (const cls of [...new Set(games.map((g) => g.time_class))].sort()) {
    if (!have.has(cls)) select.add(new Option(cls, cls));
  }
}

async function refresh() {
  const data = await loadGames();
  games = data.games;
  fillClassOptions();
  if (!games.length) {
    $("summary").textContent = "Fetching your games from chess.com…";
    $("rows").replaceChildren();
    $("empty").hidden = true;
    $("more").hidden = true;
    return;
  }
  render();
  // The note is a bonus: a failure here must not break the games list.
  try {
    const { puzzles } = await loadPuzzles();
    renderCoach($("coach"), currentUser(), games, puzzles);
  } catch (err) {
    console.error(err);
  }
}

async function init() {
  await ready;
  for (const id of ["f-class", "f-colour", "f-result", "f-order"]) {
    $(id).addEventListener("change", () => { shown = PAGE; render(); });
  }
  $("more").addEventListener("click", () => { shown += PAGE; render(); });
  try {
    await refresh();
  } catch (err) {
    $("summary").textContent = "Could not read your games from this browser's storage: " + err.message;
  }
  onRefresh(refresh);
}

init();
