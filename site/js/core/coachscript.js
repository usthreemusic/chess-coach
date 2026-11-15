// The coach's note as a script of chat messages, each optionally with positions to show on a board.
// Pure (no DOM, no storage) so it can be tested in Node.
import { Chess } from "../../vendor/chess.js";
import { pickExamples } from "./patterns.js";

const MAX_EXAMPLES = 3;

export const WAIT_TEXT = "I need a few more analysed games before I can say anything useful. Keep playing and check back.";

const tagsOf = (p) => (p.tags && p.tags.length ? p.tags : ["other"]);

/** The move the player made, as uci, found by playing `san` from `fen`. null when it cannot be read. */
export function uciFromSan(fen, san) {
  try {
    const m = new Chess(fen).move(san);
    return m.from + m.to + (m.promotion || "");
  } catch (e) { return null; }
}

/** One board example: { fen, orientation, played, best, caption, reviewUrl }. `ex` needs game_id, ply, fen, colour, best_*, a played move. */
function toExample(ex, playedSan, playedUci, gameById) {
  const game = gameById.get(ex.game_id);
  const when = game && game.opponent
    ? `against ${game.opponent}`
    : `in your game on ${new Date(ex.end_time * 1000).toISOString().slice(0, 10)}`;
  const better = ex.best_san || ex.best_uci;
  const caption = `Move ${Math.ceil(ex.ply / 2)} ${when}: you played ${playedSan}. ${better} was better.`;
  return {
    fen: ex.fen,
    orientation: ex.colour === "black" ? "black" : "white",
    played: playedUci || null,
    best: ex.best_uci || null,
    caption,
    reviewUrl: `review.html?id=${encodeURIComponent(ex.game_id)}&ply=${ex.ply}`,
  };
}

const fromPuzzle = (p, gameById) => toExample(p, p.played_san, uciFromSan(p.fen, p.played_san), gameById);
const fromHabit = (e, gameById) => toExample(e, e.san, e.uci, gameById);

/** Up to 3 puzzles carrying the focus tag from the games the note was written about, costliest first, one per game where possible. */
export function focusPuzzles(note, puzzles, games) {
  const tag = note.focus.tag;
  // buildCoach's recent window is the newest `recentGames` analysed games.
  const analysed = games.filter((g) => g.mistakes).sort((a, b) => b.end_time - a.end_time);
  const recent = new Set(analysed.slice(0, note.recentGames).map((g) => g.id));
  const mine = puzzles.filter((p) => recent.has(p.game_id) && p.best_uci && tagsOf(p).includes(tag));
  return pickExamples(mine, MAX_EXAMPLES);
}

/**
 * @param note     buildCoach(...) result, or null
 * @param picked   pickForCoach(findPatterns(...)) result, or null while the habits are still being worked out
 * @param puzzles  the player's puzzles
 * @param games    the player's games (for opponent names and the note's window)
 * @returns [{ id, paragraphs: string[], examples: [{ fen, orientation, played, best, caption, reviewUrl }] }]
 *   Without `picked` only the first three messages (greeting, pattern, focus) are returned; with it the
 *   habits, the strength and the trends follow. A null note gives one message.
 */
export function buildScript(note, picked, puzzles, games) {
  if (!note) return [{ id: "wait", paragraphs: [WAIT_TEXT], examples: [] }];
  const gameById = new Map(games.map((g) => [g.id, g]));
  const script = [
    { id: "greeting", paragraphs: [`Hi! I've looked at your last ${note.recentGames} games.`, note.goingWell], examples: [] },
    { id: "pattern", paragraphs: [note.pattern], examples: focusPuzzles(note, puzzles, games).map((p) => fromPuzzle(p, gameById)) },
    {
      id: "focus",
      paragraphs: [`This week's focus: ${note.focus.label}.`, note.advice, ...(note.checklist ? [`Checklist: ${note.checklist}`] : [])],
      examples: [],
    },
  ];
  if (!picked) return script;

  const examplesOf = (p) => (p.examples || []).map((e) => fromHabit(e, gameById));
  const { bad, good, headline } = picked;
  if (headline) {
    script.push({
      id: `habit:${headline.id}`,
      paragraphs: [`Something else I've noticed: ${headline.text}`, headline.advice],
      examples: examplesOf(headline),
    });
  }
  for (const p of bad) {
    if (p === headline) continue;
    script.push({ id: `habit:${p.id}`, paragraphs: [p.text, p.advice], examples: examplesOf(p) });
  }
  if (good) script.push({ id: `strength:${good.id}`, paragraphs: [good.text, good.advice], examples: [] });
  script.push({ id: "trends", paragraphs: note.trends.map((t) => t.text), examples: [] });
  return script;
}
