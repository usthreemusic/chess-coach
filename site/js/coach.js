// Coach's note panel on the Games page. The maths lives in core/coach.js; this only draws it.
import { buildCoach } from "./core/coach.js";

const key = (user) => `chess-coach-focus:${user}`;

function readFocus(user) {
  try {
    const v = JSON.parse(localStorage.getItem(key(user)));
    return v && typeof v.tag === "string" && Number.isFinite(v.since) ? { tag: v.tag, since: v.since } : null;
  } catch (e) { return null; }
}
function saveFocus(user, focus) {
  try { localStorage.setItem(key(user), JSON.stringify({ tag: focus.tag, since: focus.since })); } catch (e) { /* private mode */ }
}

function el(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

/** Fill `panel` from the games and puzzles; hides it when there is no player. */
export function renderCoach(panel, user, games, puzzles) {
  if (!user) { panel.hidden = true; return; }
  const prev = readFocus(user);
  const note = buildCoach(games, puzzles, { previousFocus: prev });
  panel.replaceChildren(el("h2", "", "Coach's note"));
  if (!note) {
    panel.append(el("p", "coach-wait", "Your coach needs a few more analysed games before saying anything useful."));
    panel.hidden = false;
    return;
  }
  if (!prev || prev.tag !== note.focus.tag || prev.since !== note.focus.since) saveFocus(user, note.focus);

  const list = el("ul", "coach-trends");
  for (const t of note.trends) list.append(el("li", t.better === true ? "good" : t.better === false ? "bad" : "", t.text));
  const train = el("a", "button-link", "Train this");
  train.href = note.focus.tag === "other" ? "train.html" : `train.html?tag=${encodeURIComponent(note.focus.tag)}`;
  panel.append(
    el("p", "coach-well", note.goingWell),
    el("p", "coach-pattern", note.pattern),
    el("h3", "", `This week's focus: ${note.focus.label}`),
    el("p", "coach-advice", note.advice),
    list,
    el("p", "coach-train", "")
  );
  panel.lastChild.append(train);
  panel.hidden = false;
}
