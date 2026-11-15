// The coach's note: trends across recent games, the recurring mistake that costs most, and ONE thing to work on.
// Pure (no DOM, no storage) so it can be tested in Node.
import { Chess } from "../../vendor/chess.js";
import { phaseOf } from "./chessutil.js";
import { openingFamily } from "./normalise.js";

export const MIN_GAMES = 8; // analysed games needed before the coach says anything
export const WINDOW = 20; // games per window: the latest 20, and the 20 before them
const STICKY_MS = 7 * 24 * 3600 * 1000; // keep a chosen focus for a week
const DROP_CAP = 1000; // one huge swing (a missed mate) should not swamp everything else
const SAME = 0.1; // changes under 10% read as "about the same"

const LABELS = {
  hung_piece: "Hanging pieces",
  missed_capture: "Missed captures",
  missed_fork: "Missed forks",
  missed_mate: "Missed mates",
  back_rank: "Back-rank weakness",
  endgame: "Endgame technique",
  other: "Slowing down on key moves",
};

// What the focus tag is called inside a sentence about the player's games.
const DID = {
  hung_piece: "left a piece where it could be taken",
  missed_capture: "missed a capture that would have helped you",
  missed_fork: "missed a move that attacked two things at once",
  missed_mate: "missed a checkmate",
  back_rank: "ran into a back-rank problem",
  endgame: "went wrong in the endgame",
  other: "made a mistake that did not fit a clear pattern",
};

// For "going well": the same pattern as a trend, e.g. "You are hanging fewer pieces".
const FEWER = {
  hung_piece: "You are hanging fewer pieces",
  missed_capture: "You are missing fewer captures",
  missed_fork: "You are missing fewer forks",
  missed_mate: "You are missing fewer mates",
  back_rank: "You are running into fewer back-rank problems",
  endgame: "You are making fewer endgame errors",
};

const PER_GAME = {
  hung_piece: "Pieces left hanging per game",
  missed_capture: "Missed captures per game",
  missed_fork: "Missed forks per game",
  missed_mate: "Missed mates per game",
  back_rank: "Back-rank problems per game",
  endgame: "Endgame mistakes per game",
  other: "Unclassified mistakes per game",
};

const ADVICE = {
  hung_piece:
    "After you pick a move, look at where the piece lands and ask what your opponent can capture. " +
    "Do this on every move in your next games, even quick ones.",
  missed_capture:
    "Before you choose a move, list every capture you have, even the risky-looking ones. " +
    "For each, ask whether the piece is protected and whether the trade favours you.",
  missed_fork:
    "On your move, look for one move that attacks two things at once, especially with knights and the queen. " +
    "After each game, look again at any fork you missed.",
  missed_mate:
    "When their king is short of squares, look at every check you have, even ones that seem to lose a piece. " +
    "Many checkmates start with a check that looks pointless.",
  back_rank:
    "Give your king an escape square by moving one pawn in front of it a single step, then check your back rank before moving a rook or queen away. " +
    "Look for the same chance against your opponent.",
  endgame:
    "In the endgame, bring your king toward the centre and push passed pawns (pawns with no enemy pawn in front). " +
    "Slow down: with fewer pieces left, one careless move often decides the game.",
  other:
    "These mistakes do not fit one pattern, so slow down on the critical move: when a capture is possible or a piece is attacked, take an extra moment. " +
    "Check what your opponent threatens before you commit.",
};

export const CHECKLISTS = {
  hung_piece: "Before you move: what can they take?",
  missed_capture: "Before you move: have I looked at every capture?",
  missed_fork: "Before you move: can one move attack two things at once?",
  missed_mate: "Before you move: can I give a check that leaves their king nowhere to go?",
  back_rank: "Before you move: does my king have an escape square?",
  endgame: "Before you move: what do they threaten, and where is my king best placed?",
  other: "Before you move: what does their last move threaten?",
};

export const labelFor = (tag) => LABELS[tag] || tag;
export const checklistFor = (tag) => CHECKLISTS[tag] || null;

const TAGS = Object.keys(LABELS).filter((t) => t !== "other");
const plural = (n, one, many) => `${n} ${n === 1 ? one : many}`;
const times = (n) => (n === 1 ? "once" : `${n} times`);
const fmt = (x) => (Math.round(x * 10) / 10).toFixed(1);
const pct = (x) => `${Math.round(x * 100)}%`;
const cap = (s) => s[0].toUpperCase() + s.slice(1);

const tagsOf = (p) => (p.tags && p.tags.length ? p.tags : ["other"]);
const hasTag = (p, tag) => tagsOf(p).includes(tag);
const isMistake = (p) => p.class === "mistake" || p.class === "blunder";

/** Compare two rates. lowerBetter: fewer is good (mistakes), otherwise more is good (win rate). */
function compare(label, recent, previous, lowerBetter, show, haveHistory) {
  if (!haveHistory) {
    return { label, recent, previous: null, better: null, text: `${label}: ${show(recent)}. Not enough history yet to compare.` };
  }
  const change = previous === 0 ? (recent === 0 ? 0 : Infinity) : (recent - previous) / previous;
  if (Math.abs(change) < SAME) {
    return { label, recent, previous, better: null, text: `${label}: ${show(recent)}, about the same as before (${show(previous)}).` };
  }
  const up = change > 0;
  return {
    label, recent, previous,
    better: up !== lowerBetter,
    text: `${label}: ${show(recent)}, ${up ? "up" : "down"} from ${show(previous)}.`,
  };
}

function whereText(mine, count) {
  const share = (key) => {
    const tally = new Map();
    for (const p of mine) tally.set(key(p), (tally.get(key(p)) || 0) + 1);
    const [best, n] = [...tally].sort((a, b) => b[1] - a[1])[0] || [null, 0];
    return { best, n: n / mine.length };
  };
  if (!mine.length) return null;
  const phase = share((p) => phaseOf(new Chess(p.fen)));
  const colour = share((p) => p.colour);
  const parts = [];
  if (phase.n >= 0.6) parts.push(`in the ${phase.best}`);
  if (colour.n >= 0.65) parts.push(`as ${cap(colour.best)}`);
  if (!parts.length) return null;
  // "mostly" is odd for a single mistake
  return (count > 1 ? "mostly " : "") + parts.join(", ");
}

/**
 * @param games    game objects (as loadGames().games), any order
 * @param puzzles  puzzle objects (as loadPuzzles().puzzles)
 * @param opts     { now?: number (ms), previousFocus?: { tag, since (ms) } | null }
 * @returns null when fewer than MIN_GAMES analysed games, else the coach's note (see tests)
 */
export function buildCoach(games, puzzles, opts = {}) {
  const now = opts.now ?? Date.now();
  // Only games with analysis carry a `mistakes` count (see data.js loadGames).
  const analysed = games.filter((g) => g.mistakes).sort((a, b) => b.end_time - a.end_time);
  if (analysed.length < MIN_GAMES) return null;

  let recent, previous;
  if (analysed.length >= 28) {
    recent = analysed.slice(0, WINDOW);
    previous = analysed.slice(WINDOW, 2 * WINDOW);
  } else {
    const half = Math.ceil(analysed.length / 2);
    recent = analysed.slice(0, half);
    previous = analysed.slice(half);
  }
  const haveHistory = previous.length > 0;
  const recentIds = new Set(recent.map((g) => g.id));
  const previousIds = new Set(previous.map((g) => g.id));
  const recentP = puzzles.filter((p) => isMistake(p) && recentIds.has(p.game_id));
  const previousP = puzzles.filter((p) => isMistake(p) && previousIds.has(p.game_id));
  const nRecent = recent.length, nPrev = previous.length;

  // ---- focus: the tag that cost the most centipawns in the recent window ----
  const cost = new Map();
  for (const tag of TAGS) {
    const mine = recentP.filter((p) => hasTag(p, tag));
    if (mine.length) cost.set(tag, mine.reduce((s, p) => s + Math.min(p.drop || 0, DROP_CAP), 0));
  }
  const ranked = [...cost].sort((a, b) => b[1] - a[1]);
  const top = ranked.length ? ranked[0][0] : "other";
  const topCost = ranked.length ? ranked[0][1] : 0;
  const strictTop = ranked.length === 1 || (ranked.length > 1 && ranked[0][1] > ranked[1][1]);

  const prev = opts.previousFocus;
  let tag = top, since = now, kept = false;
  if (
    prev && LABELS[prev.tag] && Number.isFinite(prev.since) &&
    now - prev.since < STICKY_MS &&
    recentP.some((p) => hasTag(p, prev.tag)) &&
    !(prev.tag === "other" && top !== "other") // a clear pattern beats the catch-all
  ) {
    tag = prev.tag; since = prev.since; kept = true;
  }

  const mineRecent = recentP.filter((p) => hasTag(p, tag));
  const recentCount = mineRecent.length;
  const previousCount = previousP.filter((p) => hasTag(p, tag)).length;
  const where = whereText(mineRecent, recentCount);

  // ---- pattern ----
  let pattern;
  if (recentCount === 0) {
    pattern = `In your last ${nRecent} games there were no mistakes or blunders to sort into a pattern.`;
  } else {
    const head = `In your last ${nRecent} games you ${DID[tag]} ${times(recentCount)}${where ? ", " + where : ""}.`;
    let tail = "";
    if (tag === "other") tail = " Most of your mistakes did not fit a clear pattern.";
    else if (tag === top && strictTop) tail = " That cost you more than any other kind of mistake.";
    else if (tag === top || cost.get(tag) === topCost) tail = " That is among the costliest kinds of mistake for you.";
    else if (kept) tail = " It is still the focus you picked earlier.";
    pattern = head + tail;
  }

  // ---- trends ----
  const mb = (g) => (g.mistakes.mistake || 0) + (g.mistakes.blunder || 0);
  const sum = (list, f) => list.reduce((s, g) => s + f(g), 0);
  const wins = (list) => list.filter((g) => g.result === "win").length;
  const rate = (n, games) => (games ? n / games : 0);
  const trends = [
    compare("Blunders and mistakes per game", rate(sum(recent, mb), nRecent), rate(sum(previous, mb), nPrev), true, fmt, haveHistory),
    compare(PER_GAME[tag], recentCount / nRecent, rate(previousCount, nPrev), true, fmt, haveHistory),
    compare("Win rate", wins(recent) / nRecent, rate(wins(previous), nPrev), false, pct, haveHistory),
  ];

  const goingWell = pickGoingWell({ analysed, recent, previous, recentP, previousP, nRecent, nPrev, haveHistory, wins, rate });

  return {
    recentGames: nRecent,
    previousGames: nPrev,
    focus: {
      tag, label: LABELS[tag], since, kept,
      recentCount, previousCount,
      recentPerGame: recentCount / nRecent,
      previousPerGame: haveHistory ? previousCount / nPrev : 0,
      where,
    },
    goingWell,
    pattern,
    advice: ADVICE[tag],
    checklist: CHECKLISTS[tag],
    trends,
  };
}

// The most favourable thing that is actually true, in a fixed order of preference.
function pickGoingWell({ analysed, recent, previous, recentP, previousP, nRecent, nPrev, haveHistory, wins, rate }) {
  if (haveHistory) {
    // (a) a pattern whose per-game rate fell by 30% or more
    let best = null;
    for (const tag of TAGS) {
      const r = recentP.filter((p) => hasTag(p, tag)).length;
      const p = previousP.filter((q) => hasTag(q, tag)).length;
      if (p < 3) continue;
      const fall = 1 - (r / nRecent) / (p / nPrev);
      if (fall >= 0.3 && (!best || fall > best.fall)) best = { tag, r, p, fall };
    }
    if (best) {
      const same = nRecent === nPrev;
      return same
        ? `${FEWER[best.tag]}: ${best.r} in your last ${nRecent} games, down from ${best.p}.`
        : `${FEWER[best.tag]}: ${fmt(best.r / nRecent)} per game, down from ${fmt(best.p / nPrev)}.`;
    }
    // (b) blunders per game down by 20% or more (and enough of them before to mean something)
    const bl = (list) => list.reduce((s, g) => s + (g.mistakes.blunder || 0), 0);
    const bPrev = bl(previous), bRecent = bl(recent);
    if (bPrev >= 3 && bRecent / nRecent <= 0.8 * (bPrev / nPrev)) {
      return `You are blundering less: ${fmt(bRecent / nRecent)} per game, down from ${fmt(bPrev / nPrev)}.`;
    }
    // (c) win rate up 10 percentage points or more
    const wr = wins(recent) / nRecent, wp = wins(previous) / nPrev;
    if (wr - wp >= 0.1) return `Your win rate is up: ${pct(wr)} in your last ${nRecent} games, from ${pct(wp)} before.`;
  }
  // (d) the opening family with the best score over at least 4 recent games
  const fam = new Map();
  for (const g of recent) {
    const name = openingFamily(g.opening);
    if (name === "Unknown") continue;
    const s = fam.get(name) || { n: 0, w: 0, d: 0 };
    s.n++;
    if (g.result === "win") s.w++;
    else if (g.result === "draw") s.d++;
    fam.set(name, s);
  }
  const ranked = [...fam]
    .filter(([, s]) => s.n >= 4 && (s.w + s.d / 2) / s.n >= 0.5) // do not call a losing record a strength
    .sort((a, b) => (b[1].w + b[1].d / 2) / b[1].n - (a[1].w + a[1].d / 2) / a[1].n || b[1].n - a[1].n || a[0].localeCompare(b[0]));
  if (ranked.length) {
    const [name, s] = ranked[0];
    const score = s.d ? `${plural(s.w, "win", "wins")} and ${plural(s.d, "draw", "draws")}` : plural(s.w, "win", "wins");
    return `Your best results lately are in the ${name}: ${score} from ${s.n}.`;
  }
  // (e) fallback
  return `You have ${analysed.length} games analysed, which is enough to see real patterns.`;
}
