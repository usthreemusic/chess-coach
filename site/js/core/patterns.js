// Playing-style patterns: habits that show up across a player's recent games, such as
// "you push the pawns in front of your king" or "you relax when you are winning".
// Pure (no DOM, no storage) so it can be tested in Node.
//
// How it works: every game is replayed ONCE (scanGame). For each of my moves we record cheap facts
// (what was moved, was it a capture or check, the eval before it, which threats existed, ...).
// Each detector is then a small predicate over those records, so adding a detector costs no replay.
//
// An "error" is a move labelled mistake or blunder (analysis.moves[k].class). For a move-level
// habit we compare the error rate of the qualifying moves with the error rate of the other moves
// in the same situation (the detector's `scope`): lift = rate / baseline.
import { Chess } from "../../vendor/chess.js";
import { ENDGAME_MATERIAL, OPENING_MOVES, VALUES, attacksFrom, other } from "./chessutil.js";
import { CONFIG } from "./config.js";
import { POINTS } from "./themes.js";

const DROP_CAP = 1000; // a single missed mate should not swamp an average
// Moves in positions this lopsided are mostly not labelled as errors (the game is already decided), so they
// are left out of every comparison. Judged on the position BEFORE the move only: judging on the result
// would keep the errors and drop the good moves.
const DECIDED = CONFIG.decidedCp;
const AHEAD = 300; // "well ahead" / "well behind", centipawns
const TRADE_EDGE = 150; // even trades are judged separately when this far ahead or behind

// Thresholds at runtime (the window is small, so lower than the ones used to explore 470 games).
export const LIMITS = { minN: 12, minLift: 1.4, goodN: 20, goodLift: 0.6, minGames: 8, minGap: 0.15 };

const isErr = (m) => m.class === "mistake" || m.class === "blunder";
const fileOf = (sq) => sq.charCodeAt(0) - 97;
const relRank = (sq, colour) => (colour === "w" ? Number(sq[1]) : 9 - Number(sq[1])); // 1 = own back rank

// ---------------------------------------------------------------------------------------------
// Position helpers
// ---------------------------------------------------------------------------------------------

/** Pawns per file for `me`, non-pawn material of both sides, and whether both queens are on. */
function scan(chess, me) {
  const files = [0, 0, 0, 0, 0, 0, 0, 0];
  let material = 0, queens = 0;
  for (const row of chess.board()) {
    for (const p of row) {
      if (!p) continue;
      if (p.type === "p") { if (p.color === me) files[fileOf(p.square)]++; continue; }
      if (p.type === "k") continue;
      material += VALUES[p.type];
      if (p.type === "q") queens++;
    }
  }
  return { files, material, bothQueens: queens >= 2 };
}

/** Doubled pawns (extra pawns on a file) plus isolated pawns (no friendly pawn on a neighbouring file). */
export function pawnDamage(files) {
  let damage = 0;
  for (let f = 0; f < 8; f++) {
    if (!files[f]) continue;
    damage += files[f] - 1;
    if (!(f > 0 && files[f - 1]) && !(f < 7 && files[f + 1])) damage += files[f];
  }
  return damage;
}

/**
 * Captures that `side` could make that win material: the victim is worth more than the capturer, or it
 * is not defended. Same rule as themes.winsMaterial, but cheaper: the defence is read off the position
 * before the capture (no board is cloned) and captures come from attack maps, not full move generation,
 * so pins are ignored (a pinned piece may be counted as a threat). When `side` is in check the legal
 * moves are used instead. Returns a Set of "fromto" strings.
 */
export function winningCaptures(chess, side = chess.turn()) {
  const out = new Set();
  const victimSide = other(side);
  const consider = (from, to, attacker, victim) => {
    if (POINTS[victim] > POINTS[attacker] || !chess.isAttacked(to, victimSide)) out.add(from + to);
  };
  if (chess.turn() === side && chess.isCheck()) {
    for (const m of chess.moves({ verbose: true })) if (m.isCapture()) consider(m.from, m.to, m.piece, m.captured);
    return out;
  }
  for (const row of chess.board()) {
    for (const p of row) {
      if (!p || p.color !== side) continue;
      for (const sq of attacksFrom(chess, p.square)) {
        const t = chess.get(sq);
        if (t && t.color === victimSide && t.type !== "k") consider(p.square, sq, p.type, t.type);
      }
    }
  }
  return out;
}

/** Points of the least valuable piece of `colour` attacking `square` (Infinity when none). */
function cheapestAttacker(chess, square, colour) {
  let best = Infinity;
  for (const row of chess.board()) {
    for (const p of row) {
      if (!p || p.color !== colour) continue;
      if (POINTS[p.type] >= best) continue;
      if (attacksFrom(chess, p.square).includes(square)) best = POINTS[p.type];
    }
  }
  return best;
}

const HOME_PIECES = { w: ["b1", "c1", "d1", "f1", "g1"], b: ["b8", "c8", "d8", "f8", "g8"] };

// ---------------------------------------------------------------------------------------------
// One pass over a game
// ---------------------------------------------------------------------------------------------

/**
 * Replay one analysed game and describe each of my moves.
 * @param analysis  { start_cp, moves: [{ uci, san, cp, class?, drop?, ... }] }
 * @param colour    "white" | "black" (my colour)
 * @param meta      { game_id, end_time } copied into each example (see `ex` below)
 * @returns { recs, ahead, behind, centre }
 *   recs   one record per move of mine: { number, phase, cp (eval before it, my side), f (habit flags),
 *          err, drop, blunder, oppBlunder, quiet, decided, castled, inCheck, hasPrev, piece, next2 }
 *   ahead / behind  true when I was 300+ cp up / down after one of my moves AND after their reply
 *   centre  at my 12th move: true = king still uncastled with both queens on, false = already castled,
 *           null = game too short, or neither
 */
export function scanGame(analysis, colour, meta = {}) {
  const me = colour === "white" ? "w" : "b";
  const enemy = other(me);
  const sign = me === "w" ? 1 : -1;
  const moves = analysis.moves;
  const chess = new Chess();
  const recs = [];
  const unmoved = new Set(HOME_PIECES[me]); // my knights, bishops and queen still on their home squares
  let castled = null, centre = null, ahead = false, behind = false;
  const cpMine = (k) => sign * (k < 0 ? analysis.start_cp : moves[k].cp); // eval after ply k+1, my side

  for (let k = 0; k < moves.length; k++) {
    const mv = moves[k];
    const uci = mv.uci;
    const isMine = (k % 2 === 0) === (me === "w");
    if (!isMine) {
      const reply = chess.move({ from: uci.slice(0, 2), to: uci.slice(2, 4), promotion: uci[4] });
      if (reply.isCapture()) unmoved.delete(reply.to);
      if (cpMine(k - 1) >= AHEAD && cpMine(k) >= AHEAD) ahead = true;
      if (cpMine(k - 1) <= -AHEAD && cpMine(k) <= -AHEAD) behind = true;
      continue;
    }

    const prev = k > 0 ? moves[k - 1] : null;
    const number = chess.moveNumber();
    const before = scan(chess, me);
    const phase = number < OPENING_MOVES ? "opening" : before.material <= ENDGAME_MATERIAL ? "endgame" : "middlegame";
    const inCheck = chess.isCheck();
    if (number === OPENING_MOVES) centre = castled ? false : before.bothQueens ? true : null;

    // facts needed before the move is made
    const from = uci.slice(0, 2), to = uci.slice(2, 4);
    const attackedBefore = chess.isAttacked(from, enemy);
    let undevelopedMinors = 0;
    for (const sq of unmoved) if (sq[0] !== "d") undevelopedMinors++;
    const alreadyMoved = !unmoved.has(from);
    // winning captures they already had; not asked when I am in check (then their "threats" are not real)
    const threatsBefore = inCheck ? null : winningCaptures(chess, enemy);

    // The position before my move, kept only for errors that have a better move to show (fen() is not free).
    const err = isErr(mv);
    const ex = err && mv.best_uci
      ? { game_id: meta.game_id, ply: k + 1, fen: chess.fen(), uci, san: mv.san, best_uci: mv.best_uci, best_san: mv.best,
          drop: mv.drop || 0, colour, end_time: meta.end_time }
      : null;

    const played = chess.move({ from, to, promotion: uci[4] });
    const piece = played.piece;
    const capture = played.isCapture();
    const recapture = capture && prev && prev.uci.slice(2, 4) === to && prev.san.includes("x");
    const check = /[+#]/.test(played.san);
    const victim = capture ? POINTS[played.captured] : 0;
    const value = POINTS[piece];
    const castles = played.isKingsideCastle() || played.isQueensideCastle();
    const f = {};

    // 1. loosening your own king: pawns in front of the castled king pushed while queens are on
    if (castled && piece === "p" && !capture && before.bothQueens) {
      const file = fileOf(from), rank = relRank(from, me);
      if ((castled === "k" ? file >= 5 : file <= 2) && (rank === 2 || rank === 3)) f.king_loosen = true;
    }
    // 2. early queen: a queen move before my move 10 that is not a recapture or a queen trade
    if (piece === "q" && number < 10 && !recapture && played.captured !== "q") f.early_queen = true;
    // 3. attacking before developing: an already-moved piece moves again, two+ minors still at home,
    //    no capture, and the piece was not attacked (so it was not running away)
    if (number < OPENING_MOVES && (piece === "n" || piece === "b" || piece === "q") && alreadyMoved &&
        undevelopedMinors >= 2 && !capture && !attackedBefore) f.undeveloped = true;
    // 4. lunges: a piece (not pawn or king) lands where something cheaper can take it, or where it is
    //    attacked and undefended; capturing something worth as much or more is not a lunge
    if (piece !== "p" && piece !== "k" && chess.isAttacked(to, enemy) && !(capture && victim >= value)) {
      if (cheapestAttacker(chess, to, enemy) < value || !chess.isAttacked(to, me)) {
        f[capture || check ? "lunge_aggressive" : "lunge_quiet"] = true;
      }
    }
    // 5. checks for the sake of it
    if (check && !capture) f.quiet_check = true;
    // 6. pawn grabbing with the queen or a rook
    if (capture && played.captured === "p" && (piece === "q" || piece === "r") && phase !== "endgame") f.pawn_grab = true;
    // 7. pawns pushed to my 5th rank or further (not captures) before the endgame
    if (piece === "p" && !capture && relRank(to, me) >= 5 && phase !== "endgame") f.pawn_push = true;
    // 8. a pawn move chosen freely (not an answer to check) that leaves me with more doubled or isolated pawns
    if (piece === "p" && !inCheck && pawnDamage(scan(chess, me).files) > pawnDamage(before.files)) f.pawn_damage = true;
    // 9. an even trade of pieces: I take, they can take back, equal value
    if (capture && victim >= 3 && victim === value && chess.isAttacked(to, enemy)) f.even_trade = true;
    // 10 / 11. a threat they already had that I did not deal with, versus walking into a new one
    //    (only quiet moves: a capture or a check changes the material count the threat is judged on)
    if (threatsBefore && !capture && !check) {
      const threatsAfter = winningCaptures(chess);
      let persists = false;
      for (const key of threatsBefore) if (threatsAfter.has(key)) persists = true;
      if (persists) f.ignored_threat = true;
      else if (!threatsBefore.size && threatsAfter.size) f.walked_into = true;
    }
    // extras: moving the king by hand (it can no longer castle) and knights to the rim in the opening
    if (piece === "k" && !castles && !inCheck && phase !== "endgame") f.king_walk = true;
    if (piece === "n" && (fileOf(to) === 0 || fileOf(to) === 7) && phase === "opening" && !capture) f.rim_knight = true;

    if (castles) castled = played.isKingsideCastle() ? "k" : "q";
    unmoved.delete(from);

    recs.push({
      ply: k, number, phase, f, cp: cpMine(k - 1), piece, err,
      drop: err ? Math.min(mv.drop || 0, DROP_CAP) : 0,
      blunder: mv.class === "blunder",
      oppBlunder: Boolean(prev && prev.class === "blunder"),
      quiet: !capture && !check, decided: Math.abs(cpMine(k - 1)) >= DECIDED,
      hasPrev: Boolean(prev), castled: castled !== null, inCheck,
      next2: null, ex, follow: null,
    });
  }
  // errors in my next two moves (tilt): total drop, or null when fewer than two moves follow
  for (let i = 0; i + 2 < recs.length; i++) {
    recs[i].next2 = recs[i + 1].drop + recs[i + 2].drop;
    recs[i].follow = recs[i + 1].ex || recs[i + 2].ex; // the follow-up error, the example for "tilt"
  }
  return { recs, ahead, behind, centre };
}

// ---------------------------------------------------------------------------------------------
// Detectors
// ---------------------------------------------------------------------------------------------
// q(rec): the move shows the habit.  scope(rec): moves it is fairly compared with (default: all other moves).
// out(rec): the cost of the move, 0 when it was fine (default: its drop when it was an error).
const all = () => true;
const noEndgame = (r) => r.phase !== "endgame";
const flag = (name) => (r) => Boolean(r.f[name]);

export const DETECTORS = [
  { id: "king_loosen", group: "aggression", q: flag("king_loosen"), scope: (r) => r.castled && noEndgame(r) },
  { id: "early_queen", group: "aggression", q: flag("early_queen"), scope: (r) => r.phase === "opening" },
  { id: "undeveloped", group: "aggression", q: flag("undeveloped"), scope: (r) => r.phase === "opening" },
  { id: "lunge_aggressive", group: "aggression", q: flag("lunge_aggressive"), scope: all },
  { id: "lunge_quiet", group: "aggression", q: flag("lunge_quiet"), scope: all },
  { id: "quiet_check", group: "aggression", q: flag("quiet_check"), scope: all },
  { id: "pawn_grab", group: "aggression", q: flag("pawn_grab"), scope: noEndgame },
  { id: "pawn_push", group: "aggression", q: flag("pawn_push"), scope: noEndgame },
  { id: "pawn_damage", group: "structure", q: flag("pawn_damage"), scope: (r) => r.piece === "p" && !r.inCheck },
  { id: "trade_behind", group: "structure", q: (r) => r.f.even_trade && r.cp <= -TRADE_EDGE, scope: (r) => r.cp <= -TRADE_EDGE },
  { id: "trade_ahead", group: "structure", q: (r) => r.f.even_trade && r.cp >= TRADE_EDGE, scope: (r) => r.cp >= TRADE_EDGE },
  { id: "ignored_threat", group: "awareness", q: flag("ignored_threat"), scope: (r) => !r.inCheck && r.quiet },
  { id: "walked_into", group: "awareness", q: flag("walked_into"), scope: (r) => !r.inCheck && r.quiet },
  { id: "no_punish", group: "awareness", q: (r) => r.oppBlunder, scope: (r) => r.hasPrev },
  // Lopsided positions produce more errors than level ones for everybody (there is more to lose), so
  // "relaxing when ahead" is compared with the same distance on the other side, not with level positions.
  { id: "relax", group: "flow", q: (r) => r.cp >= AHEAD, scope: (r) => r.cp <= -AHEAD },
  { id: "giveup", group: "flow", q: (r) => r.cp <= -AHEAD, scope: (r) => r.cp >= AHEAD },
  { id: "tilt", group: "flow", q: (r) => r.blunder && r.next2 !== null, scope: (r) => !r.blunder && r.next2 !== null,
    out: (r) => r.next2 },
  { id: "slow_start", group: "flow", q: (r) => r.number < OPENING_MOVES, scope: (r) => r.number >= OPENING_MOVES },
  { id: "king_walk", group: "aggression", q: flag("king_walk"), scope: noEndgame },
  { id: "rim_knight", group: "aggression", q: flag("rim_knight"), scope: (r) => r.phase === "opening" },
];

/** Cost of a move for the detector: its eval drop when it was an error, else 0. */
const outOf = (d, r) => (d.out ? d.out(r) : r.drop);

/** Up to 3 of a habit's error moves, costliest first, from different games where there are enough games. */
export function pickExamples(hits, max = 3) {
  const byDrop = [...hits].sort((a, b) => b.drop - a.drop);
  const chosen = [], games = new Set();
  for (const e of byDrop) if (chosen.length < max && !games.has(e.game_id)) { chosen.push(e); games.add(e.game_id); }
  for (const e of byDrop) if (chosen.length < max && !chosen.includes(e)) chosen.push(e);
  return chosen.sort((a, b) => b.drop - a.drop);
}

/**
 * Statistics of every move-level detector over `scans` (results of scanGame), no thresholds applied.
 * rate / baseline are shares of moves with a cost; avgDrop is the mean cost of those.
 */
export function moveStats(scans) {
    const recs = scans.flatMap((s) => s.recs).filter((r) => !r.decided);
  return DETECTORS.map((d) => {
    let n = 0, errors = 0, dropSum = 0, scopeN = 0, scopeErr = 0, scopeDrop = 0;
    const hits = [];
    for (const r of recs) {
      if (d.q(r)) {
        n++;
        const c = outOf(d, r);
        if (c > 0) {
          errors++; dropSum += c;
          const e = d.id === "tilt" ? r.follow : r.ex;
          if (e) hits.push(e);
        }
      } else if (d.scope(r)) {
        scopeN++;
        if (outOf(d, r) > 0) { scopeErr++; scopeDrop += outOf(d, r); }
      }
    }
    const rate = n ? errors / n : 0;
    const baseline = scopeN ? scopeErr / scopeN : 0;
    return {
      id: d.id, group: d.group, n, errors, rate, baseline, scopeN,
      lift: rate / Math.max(baseline, 0.01),
      avgDrop: errors ? dropSum / errors : 0,
      scopeAvgDrop: scopeErr ? scopeDrop / scopeErr : 0, // average cost of the errors in the comparison moves
      examples: pickExamples(hits),
    };
  });
}

/**
 * Game-level statistics. items: [{ scan, result }] where result is "win" | "draw" | "loss" | undefined.
 * Each entry: { id, group, withGames, withoutGames, withRate, withoutRate } (rates are shares of wins,
 * except "comeback" where draws count too).
 */
export function gameStats(items) {
  const known = items.filter((i) => i.result);
  const share = (list, ok) => (list.length ? list.filter(ok).length / list.length : 0);
  const won = (i) => i.result === "win";
  const split = (id, group, inGroup, good) => {
    const w = known.filter(inGroup), wo = known.filter((i) => !inGroup(i));
    return { id, group, withGames: w.length, withoutGames: wo.length, withRate: share(w, good), withoutRate: share(wo, good) };
  };
  return [
    split("convert", "flow", (i) => i.scan.ahead, won),
    split("comeback", "flow", (i) => i.scan.behind, (i) => i.result !== "loss"),
    // castled in time versus king still in the centre: "with" = the king stayed in the centre
    (() => {
      const w = known.filter((i) => i.scan.centre === true), wo = known.filter((i) => i.scan.centre === false);
      return { id: "king_centre", group: "flow", withGames: w.length, withoutGames: wo.length, withRate: share(w, won), withoutRate: share(wo, won) };
    })(),
  ];
}

// ---------------------------------------------------------------------------------------------
// Wording
// ---------------------------------------------------------------------------------------------
const pct = (x) => `${Math.round(x * 100)}%`;
const TIMES = { 1.5: "one and a half times", 2: "twice", 2.5: "two and a half times", 3: "three times", 3.5: "three and a half times", 4: "four times", 4.5: "four and a half times" };
/** "about twice", "about three times": the lift rounded to the nearest half. */
export function aboutTimes(lift) {
  const m = Math.max(1.5, Math.round(lift * 2) / 2);
  return "about " + (TIMES[m] || `${Math.round(m)} times`);
}
const going = (s) => `${s.errors} of them were mistakes or blunders, ${aboutTimes(s.lift)} as often as your other moves`;
const lastGames = (s) => `your last ${s.games} games`;

/**
 * COPY[id]: title; text(s) for a bad habit (s = { n, errors, rate, baseline, lift, games }); advice;
 * and, for habits that can be a strength, good: { text(s), advice }.
 * Game-level habits get s = { withGames, withoutGames, withRate, withoutRate, wins }.
 */
const COPY = {
  king_loosen: {
    title: "Pushing the pawns in front of your castled king",
    text: (s) => `When you push the pawns in front of your castled king, it goes wrong: ${going(s)} (${s.n} in ${lastGames(s)}, with queens still on).`,
    advice: "Once you have castled, leave those pawns where they are unless you have a clear reason: every push gives their pieces a way in.",
  },
  early_queen: {
    title: "Early queen moves",
    text: (s) => `You bring your queen out early a lot (${s.n} times before move 10 in ${lastGames(s)}), and it costs you: ${going(s)}.`,
    advice: "Get your knights and bishops out first; the queen can come later, when you can see where it is safe.",
  },
  undeveloped: {
    title: "Attacking before developing",
    text: (s) => `You often move a piece a second time while other knights and bishops are still at home (${s.n} times in ${lastGames(s)}), and ${going(s)}.`,
    advice: "In the first ten moves, ask which piece has not moved yet before you move one that already has.",
  },
  lunge_aggressive: {
    title: "Attacking with pieces that can be taken",
    text: (s) => `You like attacking, but your captures and checks often land a piece where it can be taken for less than it is worth, or for free: ${going(s)} (${s.n} in ${lastGames(s)}).`,
    advice: "Before a capture or a check, look at the square you land on: if it can be taken, make sure you get enough in return.",
  },
  lunge_quiet: {
    title: "Moving pieces where they can be taken",
    text: (s) => `Sometimes you move a piece to a square where it can be taken for less than it is worth, or for nothing (${s.n} times in ${lastGames(s)}): ${going(s)}.`,
    advice: "Before you let go of a piece, name what can capture it on its new square and whether you protect it.",
  },
  quiet_check: {
    title: "Checks that win nothing",
    text: (s) => `You give a lot of checks that do not capture anything (${s.n} in ${lastGames(s)}), and ${going(s)}.`,
    advice: "Before you check, ask what the check wins or forces; a check that only chases the king can hand over the initiative.",
  },
  pawn_grab: {
    title: "Grabbing pawns with the queen or a rook",
    text: (s) => `You often take pawns with your queen or a rook before the endgame (${s.n} times in ${lastGames(s)}), and ${going(s)}.`,
    advice: "Before the queen or a rook takes a pawn, check whether it can be trapped or whether it leaves something else loose.",
  },
  pawn_push: {
    title: "Pushing pawns far up the board",
    text: (s) => `You push pawns far up the board, to your own fifth row or beyond, before the endgame (${s.n} times in ${lastGames(s)}), and ${going(s)}.`,
    advice: "A pawn cannot go back and leaves holes behind it. Push it only when it is protected and your other pieces are ready to follow.",
  },
  pawn_damage: {
    title: "Damaging your own pawn structure",
    text: (s) => `Some of your pawn moves leave you with more doubled pawns (two on one file) or isolated pawns (none beside them): ${going(s)} (${s.n} in ${lastGames(s)}).`,
    advice: "Before a pawn move or capture, check whether it leaves two pawns on one file or a pawn with no neighbours; those become targets later.",
  },
  trade_behind: {
    title: "Trading pieces when you are behind",
    text: (s) => `You swap equal pieces even when you are behind (${s.n} times in ${lastGames(s)}), and ${going(s)}.`,
    advice: "When you are behind, keep pieces on: trade only to remove an attacker or to escape a threat.",
  },
  trade_ahead: {
    title: "Trading pieces when you are ahead",
    text: (s) => `You swap pieces well when you are ahead: ${s.errors} of your ${s.n} even trades when you were ahead were mistakes or blunders, ${pct(1 - s.lift)} less often than your other moves in those positions.`,
    advice: "Keep doing this: when you are ahead, swapping pieces is the simplest way to win.",
    goodOnly: true,
  },
  ignored_threat: {
    title: "Not dealing with a threat",
    text: (s) => `Often your opponent was already threatening to win material and your move did not deal with it (${s.n} times in ${lastGames(s)}): ${going(s)}.`,
    advice: "Before each move, ask what your opponent's last move was aiming at, and check that your move stops it.",
  },
  walked_into: {
    title: "Moving into a threat",
    text: (s) => `Sometimes your own move creates the problem: after it, your opponent could win material with a capture that was not there before (${s.n} times in ${lastGames(s)}), and ${going(s)}.`,
    advice: "After you choose a move, look at the board as your opponent would: what can they capture now?",
  },
  no_punish: {
    title: "Not punishing their blunders",
    text: (s) => `When your opponent blunders, you often do not take advantage: your own reply was a mistake or blunder ${s.errors} times out of ${s.n} (${pct(s.rate)}), ${aboutTimes(s.lift)} as often as usual.`,
    advice: "After a big mistake from them, slow down: there is something to win. Look at every check, capture and threat before you reply.",
    good: {
      text: (s) => `You make the most of your opponent's blunders: after ${s.n} of them your own reply was a mistake or blunder only ${s.errors} times, ${pct(1 - s.lift)} less often than usual.`,
      advice: "Keep doing this: when they slip, look for the forcing move first.",
    },
  },
  relax: {
    title: "Relaxing when you are ahead",
    text: (s) => `You tend to relax when you are well ahead: ${s.errors} of your ${s.n} moves when you were 3 pawns or more up were mistakes or blunders (${pct(s.rate)}), compared with ${pct(s.baseline)} when you were behind by the same amount.`,
    advice: "When you are winning, keep checking what your opponent threatens, and trade pieces rather than looking for a flashy finish.",
  },
  giveup: {
    title: "Giving up when you are behind",
    text: (s) => `When you are well behind, your play gets worse: ${s.errors} of your ${s.n} moves when you were 3 pawns or more down were mistakes or blunders (${pct(s.rate)}), compared with ${pct(s.baseline)} when you were ahead by the same amount.`,
    advice: "When you are behind, make the move that sets the most problems and look for checks and captures: opponents slip more often than you expect.",
  },
  tilt: {
    title: "One blunder leads to another",
    text: (s) => `After a blunder, the next two moves often go wrong as well: it happened after ${s.errors} of your ${s.n} blunders in ${lastGames(s)}, ${aboutTimes(s.lift)} as often as usual.`,
    advice: "After you notice a blunder, take a breath and play your next move slowly: the position is usually still playable.",
  },
  slow_start: {
    title: "Slow starts",
    text: (s) => `Your opening moves go wrong more than your later ones: ${s.errors} of ${s.n} moves before move 12 were mistakes or blunders.`,
    advice: "Spend your thinking time early: develop pieces, castle, and check what each move allows.",
  },
  king_walk: {
    title: "Moving the king by hand",
    text: (s) => `You move your king without castling before the endgame (${s.n} times in ${lastGames(s)}), and ${going(s)}.`,
    advice: "Castle instead: a king that has moved can no longer castle and is easier to attack.",
  },
  rim_knight: {
    title: "Knights on the edge",
    text: (s) => `You put knights on the edge of the board in the opening (${s.n} times in ${lastGames(s)}), and ${going(s)}.`,
    advice: "A knight on the edge attacks half as many squares. Aim for the centre.",
  },
};
// Habits that praise when the rate is low. A low rate is only meaningful for these (not, say, "pawn damage").
const CAN_BE_GOOD = new Set(["trade_ahead", "no_punish"]);
// Habits that describe the same thing from two sides: only one of a family is shown at a time.
const FAMILY = { lunge_quiet: "en_prise", walked_into: "en_prise" };

const GAME_COPY = {
  convert: {
    title: "Finishing off winning games",
    good: {
      text: (s) => `You are good at finishing games off: you won ${s.wins} of the ${s.withGames} games where you got well ahead.`,
      advice: "Keep doing this: when you are ahead, trade pieces and keep your king safe.",
    },
    bad: {
      text: (s) => `Winning positions slip away from you: you won only ${s.wins} of the ${s.withGames} games where you got well ahead.`,
      advice: "When you are ahead, trade pieces, keep your king safe and check what your opponent threatens before every move: you win the game by not losing it.",
    },
  },
  comeback: {
    title: "Fighting back from a bad position",
    good: {
      text: (s) => `You fight back well: you won or drew ${s.wins} of the ${s.withGames} games where you fell well behind.`,
      advice: "Keep doing this: keep setting problems; your opponents do not always find the win.",
    },
  },
  king_centre: {
    title: "Leaving the king in the centre",
    bad: {
      text: (s) => `When your king is still in the middle at move 12, you win ${pct(s.withRate)} of those games (${s.withGames}), against ${pct(s.withoutRate)} when you have castled by then (${s.withoutGames}).`,
      advice: "Castle in the first ten moves unless you have a good reason not to.",
    },
  },
};

// ---------------------------------------------------------------------------------------------
// findPatterns
// ---------------------------------------------------------------------------------------------
/**
 * Strength = how much the habit is worth talking about, in "pawns per game":
 *   excess errors x average drop (in pawns) / games analysed,
 * where excess errors = errors above what the baseline rate would have given on the same number of moves
 * (for a strength: the errors saved, at the average cost of the comparison moves' errors). A frequent, costly habit therefore outranks a rare curiosity, and a
 * high lift on a handful of moves scores low. Game-level habits use gap x share of games affected x 10
 * (a 10% change in win chance is worth about a pawn).
 */
// A habit that costs a pawn or more per game is said outside the "More from your coach" fold. On this player's
// data the top habit scored 0.5 to 5 over sliding 60-game windows; typical secondary habits 0.2 to 1.
export const STRONG = 1.0;

/**
 * @param pairs [{ game, analysis }] for one player (any order); game needs colour and (for game-level habits) result
 * @param opts  { maxGames = 60 }  the most recent maxGames analysed games are used
 * @returns patterns that pass the thresholds, strongest first (see the field list in the task / tests)
 */
export function findPatterns(pairs, opts = {}) {
  const maxGames = opts.maxGames ?? 60;
  const L = { ...LIMITS, ...(opts.limits || {}) };
  const recent = pairs
    .filter((p) => p && p.analysis && p.analysis.moves && p.analysis.moves.length && p.game && (p.game.colour === "white" || p.game.colour === "black"))
    .sort((a, b) => (b.game.end_time || 0) - (a.game.end_time || 0))
    .slice(0, maxGames);
  const items = [];
  for (const p of recent) {
    try { items.push({ scan: scanGame(p.analysis, p.game.colour, { game_id: p.game.id, end_time: p.game.end_time }), result: p.game.result }); } catch (e) { /* a game that cannot be replayed is skipped */ }
  }
  const games = items.length;
  if (!games) return [];
  const out = [];

  for (const s of moveStats(items.map((i) => i.scan))) {
    const copy = COPY[s.id];
    const base = { id: s.id, title: copy.title, group: s.group, n: s.n, errors: s.errors, rate: s.rate, baseline: s.baseline, lift: s.lift };
    const stat = { ...s, games };
    const bad = !copy.goodOnly && s.n >= L.minN && s.errors >= 4 && s.lift >= L.minLift;
    const good = CAN_BE_GOOD.has(s.id) && s.n >= L.goodN && s.lift <= L.goodLift && (copy.good || copy.goodOnly);
    if (bad) {
      const excess = s.errors - s.n * s.baseline;
      out.push({ ...base, strength: (Math.max(excess, 0) * s.avgDrop) / 100 / games, text: copy.text(stat), advice: copy.advice, good: false, family: FAMILY[s.id] || s.id, examples: s.examples });
    } else if (good) {
      const g = copy.good || { text: copy.text, advice: copy.advice };
      const saved = s.n * s.baseline - s.errors;
      out.push({ ...base, strength: (Math.max(saved, 0) * s.scopeAvgDrop) / 100 / games, text: g.text(stat), advice: g.advice, good: true, family: FAMILY[s.id] || s.id, examples: [] });
    }
  }

  for (const g of gameStats(items)) {
    const copy = GAME_COPY[g.id];
    const base = { id: g.id, title: copy.title, group: g.group, withRate: g.withRate, withoutRate: g.withoutRate, withGames: g.withGames, withoutGames: g.withoutGames };
    const stat = { ...g, wins: Math.round(g.withRate * g.withGames) };
    let verdict = null;
    if (g.id === "convert" && g.withGames >= L.minGames) verdict = g.withRate >= 0.85 ? "good" : g.withRate <= 0.6 ? "bad" : null;
    if (g.id === "comeback" && g.withGames >= L.minGames) verdict = g.withRate >= 0.45 ? "good" : null;
    if (g.id === "king_centre" && g.withGames >= L.minGames && g.withoutGames >= L.minGames) {
      verdict = g.withoutRate - g.withRate >= L.minGap ? "bad" : null;
    }
    if (!verdict || !copy[verdict]) continue;
    const gap = verdict === "bad"
      ? (g.id === "convert" ? 0.75 - g.withRate : g.withoutRate - g.withRate)
      : (g.id === "convert" ? g.withRate - 0.75 : g.withRate - 0.4);
    out.push({
      ...base, strength: (Math.max(gap, 0) * g.withGames * 10) / games,
      text: copy[verdict].text(stat), advice: copy[verdict].advice, good: verdict === "good", family: g.id,
      examples: [], // no single move stands for a whole-game habit
    });
  }

  return out.sort((a, b) => b.strength - a.strength);
}

/**
 * What the coach panel shows: up to two bad habits (one per family), the best strength, and the
 * habit said outside the "more" section.
 *
 * Habits of style (how the player attacks and handles pawns) come first. The awareness and
 * game-flow habits (not punishing blunders, a second mistake after a blunder) are frequent and
 * costly for almost everyone, so on strength alone they would always win and the coach would
 * never say anything about the player's style. The top style habit is therefore listed first and
 * is the headline whenever there is one; otherwise the strongest habit is the headline only when
 * it is strong enough (STRONG).
 */
const STYLE_GROUPS = ["aggression", "structure"];
export function pickForCoach(patterns) {
  const habits = patterns.filter((p) => !p.good);
  const style = habits.find((p) => STYLE_GROUPS.includes(p.group)) || null;
  const bad = style ? [style] : [];
  const families = new Set(bad.map((p) => p.family));
  for (const p of habits) {
    if (bad.length === 2) break;
    if (families.has(p.family)) continue;
    families.add(p.family);
    bad.push(p);
  }
  const good = patterns.find((p) => p.good) || null;
  const headline = style || (bad.length && bad[0].strength >= STRONG ? bad[0] : null);
  return { bad, good, headline };
}
