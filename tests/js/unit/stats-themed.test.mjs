// Unit tests for site/js/core/stats.js and site/js/core/themed.js.
//   node --test tests/js/unit/stats-themed.test.mjs
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
const core = (name) => import(pathToFileURL(path.join(ROOT, "site/js/core", name)).href);
const { CLASSES, DIMENSIONS, MISTAKE_TYPE, baseSeconds, monthOf, buildStats } = await core("stats.js");
const { MIN_BAND, MAX_BAND, DEFAULT_BAND, ratingBand, allocate, pickThemed } = await core("themed.js");
const readJson = (...p) => JSON.parse(fs.readFileSync(path.join(ROOT, ...p), "utf8"));

// ============================== stats.js ======================================================

test("exports: classes and dimensions", () => {
  assert.deepEqual(CLASSES, ["inaccuracy", "mistake", "blunder"]);
  assert.deepEqual(DIMENSIONS, ["phase", "opening", "colour", "time_class", "time_pressure", "piece", "month"]);
  assert.equal(MISTAKE_TYPE, "mistake_type");
});

test("baseSeconds: live time controls", () => {
  assert.equal(baseSeconds("600"), 600);
  assert.equal(baseSeconds("180+2"), 180);
  assert.equal(baseSeconds(" 300 +5"), 300);
  assert.equal(baseSeconds("60+1"), 60);
});

test("baseSeconds: not live gives null", () => {
  assert.equal(baseSeconds("1/86400"), null);
  assert.equal(baseSeconds("abc"), null);
  assert.equal(baseSeconds(undefined), null);
  assert.equal(baseSeconds(null), null);
  assert.equal(baseSeconds(600), null); // only strings are time controls
});

test("baseSeconds: empty string is not a live time control", () => {
  assert.equal(baseSeconds(""), null);
  assert.equal(baseSeconds("   "), null);
  assert.equal(baseSeconds("+5"), null);
});

test("monthOf: UTC month at boundaries", () => {
  assert.equal(monthOf(1767225599), "2025-12"); // 2025-12-31T23:59:59Z
  assert.equal(monthOf(1767225600), "2026-01"); // 2026-01-01T00:00:00Z
  assert.equal(monthOf(1769903999), "2026-01"); // 2026-01-31T23:59:59Z
  assert.equal(monthOf(1769904000), "2026-02");
  assert.equal(monthOf(0), "1970-01");
});

test("monthOf: independent of the local time zone", () => {
  const before = process.env.TZ;
  try {
    for (const tz of ["Pacific/Auckland", "America/Los_Angeles", "UTC"]) {
      process.env.TZ = tz;
      assert.equal(monthOf(1767225599), "2025-12", tz);
      assert.equal(monthOf(1767225600), "2026-01", tz);
    }
  } finally {
    if (before === undefined) delete process.env.TZ; else process.env.TZ = before;
  }
});

// ---- hand-written games ---------------------------------------------------------------------
const mv = (uci, extra = {}) => ({ san: "?", uci, ...extra });
const mkGame = (id, o) => ({ id, end_time: 1767225600, time_class: "rapid", time_control: "600", colour: "white", opening: "", ...o });

// G1: white, blitz 180+2, Dec 2025. 1.d4 Nf6 2.Nc3 Ne4 3.Bg5?? Nxg5
//   Bg5 misses Nxe4 (free knight) and hangs the bishop to Nxg5: two tags.
const G1 = {
  game: mkGame("g1", { time_class: "blitz", time_control: "180+2", end_time: 1767225599, opening: "Indian Defense Normal Variation" }),
  analysis: { moves: [
    mv("d2d4", { clk: 100 }),
    mv("g8f6"),
    mv("b1c3", { clk: 17.9, class: "inaccuracy", best_uci: "d2d3" }),
    mv("f6e4"),
    mv("c1g5", { clk: 18, class: "mistake", best_uci: "c3e4" }), // exactly 10% of 180
    mv("e4g5"),
  ] },
};
// G2: black, rapid 600, Jan 2026. 1.e4 e5 2.Nf3 Nc6 3.Bc4 Bc5 4.d3 Nf6 5.Nc3 O-O
const G2 = {
  game: mkGame("g2", { colour: "black", opening: "Italian Game Classical Variation", end_time: 1767225600 }),
  analysis: { moves: [
    mv("e2e4"),
    mv("e7e5", { clk: 59.9 }),
    mv("g1f3"),
    mv("b8c6", { clk: 60, class: "blunder" }), // exactly 10% of 600
    mv("f1c4"),
    mv("f8c5"),
    mv("d2d3"),
    mv("g8f6"),
    mv("b1c3"),
    mv("e8g8"), // black castles: a king move
  ] },
};
// G3: white, daily, Feb 2026, no opening. 1.h4 g5 2.hxg5 h6 3.gxh6 Nc6 4.h7 d6 5.hxg8=Q
const G3 = {
  game: mkGame("g3", { time_class: "daily", time_control: "1/86400", end_time: 1769904000, opening: undefined }),
  analysis: { moves: [
    mv("h2h4", { clk: 5 }), mv("g7g5"), mv("h4g5"), mv("h7h6"),
    mv("g5h6", { class: "mistake" }), mv("b8c6"), mv("h6h7"), mv("d7d6"),
    mv("h7g8q", { clk: 1 }), // promotion is a pawn move
  ] },
};
// G4: white, rapid, Mar 2026, 12 knight shuffles: my 12th move is at full-move 12 -> middlegame.
const shuffle = [];
for (let i = 0; i < 12; i++) shuffle.push(mv(i % 2 ? "f3g1" : "g1f3"), mv(i % 2 ? "f6g8" : "g8f6"));
const G4 = {
  game: mkGame("g4", { end_time: 1772323200, opening: "Zukertort Opening Shuffle" }),
  analysis: { moves: shuffle },
};
const PAIRS = [G1, G2, G3, G4];
const row = (key, games, moves, inaccuracy, mistake, blunder) => ({ key, games, moves, inaccuracy, mistake, blunder });

test("buildStats: empty input", () => {
  const s = buildStats([]);
  assert.equal(s.games, 0);
  assert.equal(s.moves, 0);
  assert.deepEqual(s.totals, { inaccuracy: 0, mistake: 0, blunder: 0 });
  assert.deepEqual(Object.keys(s.dimensions).sort(), [...DIMENSIONS, MISTAKE_TYPE].sort());
  for (const rows of Object.values(s.dimensions)) assert.deepEqual(rows, []);
});

test("buildStats: totals count only my own moves, as white and as black", () => {
  const s = buildStats(PAIRS);
  assert.equal(s.games, 4);
  assert.equal(s.moves, 3 + 5 + 5 + 12); // G1 3 white, G2 5 black, G3 5 white, G4 12 white
  assert.deepEqual(s.totals, { inaccuracy: 1, mistake: 2, blunder: 1 });
  assert.equal(buildStats([G2]).moves, 5);
  assert.equal(buildStats([G1]).moves, 3);
});

test("buildStats: row shape", () => {
  const s = buildStats(PAIRS);
  for (const rows of Object.values(s.dimensions)) {
    for (const r of rows) {
      assert.deepEqual(Object.keys(r).sort(), ["blunder", "games", "inaccuracy", "key", "mistake", "moves"]);
      assert.equal(typeof r.games, "number");
    }
  }
});

test("buildStats: phase, colour, time_class, month", () => {
  const d = buildStats(PAIRS).dimensions;
  assert.deepEqual(d.phase, [row("opening", 4, 24, 1, 2, 1), row("middlegame", 1, 1, 0, 0, 0)]);
  assert.deepEqual(d.colour, [row("white", 3, 20, 1, 2, 0), row("black", 1, 5, 0, 0, 1)]);
  assert.deepEqual(d.time_class, [row("rapid", 2, 17, 0, 0, 1), row("daily", 1, 5, 0, 1, 0), row("blitz", 1, 3, 1, 1, 0)]);
  // chronological, not by moves
  assert.deepEqual(d.month, [
    row("2025-12", 1, 3, 1, 1, 0), row("2026-01", 1, 5, 0, 0, 1),
    row("2026-02", 1, 5, 0, 1, 0), row("2026-03", 1, 12, 0, 0, 0),
  ]);
});

test("buildStats: opening families, moves descending then key", () => {
  assert.deepEqual(buildStats(PAIRS).dimensions.opening, [
    row("Zukertort Opening", 1, 12, 0, 0, 0),
    row("Italian Game", 1, 5, 0, 0, 1), // ties with Unknown on moves: key order
    row("Unknown", 1, 5, 0, 1, 0),
    row("Indian Defense", 1, 3, 1, 1, 0),
  ]);
});

test("buildStats: piece (castling is a king move, promotion a pawn move)", () => {
  // pawns: d4, e5, 5 in G3 = 7; knights: Nc3, Nc6, Nf6 + 12 shuffles = 15; bishops: Bg5, Bc5; king: O-O
  assert.deepEqual(buildStats(PAIRS).dimensions.piece, [
    row("knight", 3, 15, 1, 0, 1),
    row("pawn", 3, 7, 0, 1, 0),
    row("bishop", 2, 2, 0, 1, 0),
    row("king", 1, 1, 0, 0, 0),
  ]);
});

test("buildStats: white castling counts as a king move", () => {
  const g = { game: mkGame("c"), analysis: { moves: ["e2e4", "e7e5", "g1f3", "b8c6", "f1c4", "g8f6", "e1g1"].map((u) => mv(u)) } };
  const piece = buildStats([g]).dimensions.piece;
  assert.deepEqual(piece.find((r) => r.key === "king"), row("king", 1, 1, 0, 0, 0));
  assert.equal(piece.reduce((a, r) => a + r.moves, 0), 4);
});

test("buildStats: time_pressure", () => {
  // G1 base 180 (increment ignored): 100 s ok, 17.9 s under, exactly 18 s ok.
  // G2 base 600: 59.9 s under, exactly 60 s ok. G3 daily and G4 without clk are left out.
  assert.deepEqual(buildStats(PAIRS).dimensions.time_pressure, [
    row("10% or more", 2, 3, 0, 1, 1),
    row("under 10% of clock", 2, 2, 1, 0, 0),
  ]);
});

test("buildStats: time_pressure skips unusable time controls and missing clocks", () => {
  const moves = [mv("e2e4", { clk: 1 }), mv("e7e5"), mv("g1f3", { clk: null }), mv("b8c6"), mv("f1c4")];
  for (const tc of ["1/86400", "", "abc", undefined]) {
    const s = buildStats([{ game: mkGame("t", { time_control: tc }), analysis: { moves } }]);
    assert.deepEqual(s.dimensions.time_pressure, [], `time_control ${tc}`);
    assert.equal(s.moves, 3);
  }
  // daily class with a live-looking time control is still excluded
  const daily = buildStats([{ game: mkGame("t", { time_class: "daily", time_control: "600" }), analysis: { moves } }]);
  assert.deepEqual(daily.dimensions.time_pressure, []);
  // clk 0 is a real clock reading (flagged), not "missing"
  const zero = buildStats([{ game: mkGame("t"), analysis: { moves: [mv("e2e4", { clk: 0 })] } }]);
  assert.deepEqual(zero.dimensions.time_pressure, [row("under 10% of clock", 1, 1, 0, 0, 0)]);
});

test("buildStats: mistake_type counts mistakes and blunders only, a double tag counts in both rows", () => {
  // G1 Bg5 (mistake): missed_capture + hung_piece. G1 Nc3 is only an inaccuracy: not counted.
  // G2 Nc6 (blunder) and G3 gxh6 (mistake) have no best move: "other".
  assert.deepEqual(buildStats(PAIRS).dimensions[MISTAKE_TYPE], [
    row("other", 2, 2, 0, 1, 1),
    row("hung_piece", 1, 1, 0, 1, 0),
    row("missed_capture", 1, 1, 0, 1, 0),
  ]);
  // inaccuracy-only game has no mistake_type rows
  assert.deepEqual(buildStats([{ game: mkGame("i"), analysis: { moves: [mv("e2e4", { class: "inaccuracy", best_uci: "d2d4" })] } }]).dimensions[MISTAKE_TYPE], []);
});

test("buildStats: unknown or missing class values are not counted", () => {
  const s = buildStats([{ game: mkGame("u"), analysis: { moves: [mv("e2e4", { class: "great" }), mv("e7e5"), mv("g1f3", { class: null })] } }]);
  assert.equal(s.moves, 2);
  assert.deepEqual(s.totals, { inaccuracy: 0, mistake: 0, blunder: 0 });
});

test("buildStats: an unreadable analysis is skipped without affecting the others", () => {
  const illegalSecondMove = { game: mkGame("bad1"), analysis: { moves: [mv("e2e4"), mv("e7e5"), mv("e2e4")] } };
  const emptySquare = { game: mkGame("bad2"), analysis: { moves: [mv("e4e5")] } };
  const noMoves = { game: mkGame("bad3"), analysis: {} };
  const clean = buildStats([G1, G2]);
  const mixed = buildStats([G1, illegalSecondMove, emptySquare, G2, noMoves]);
  assert.deepEqual(mixed, clean);
  assert.equal(mixed.games, 2);
  assert.equal(mixed.moves, 8);
});

test("buildStats: a game with no moves of mine still counts as a game", () => {
  const s = buildStats([{ game: mkGame("e", { colour: "black" }), analysis: { moves: [mv("e2e4")] } }]);
  assert.equal(s.games, 1);
  assert.equal(s.moves, 0);
  for (const rows of Object.values(s.dimensions)) assert.deepEqual(rows, []);
});

test("buildStats: consistency over the real fixtures", () => {
  const games = readJson("tests/fixtures/games.json").games;
  const pairs = games.map((game) => ({ game, analysis: readJson("tests/fixtures/analysis", `${game.id}.json`) }));
  assert.ok(pairs.length > 0);
  const s = buildStats(pairs);
  assert.ok(s.moves > 0);
  for (const dim of ["phase", "opening", "colour", "time_class", "piece", "month"]) {
    const rows = s.dimensions[dim];
    assert.equal(rows.reduce((a, r) => a + r.moves, 0), s.moves, `${dim} moves`);
    for (const c of CLASSES) assert.equal(rows.reduce((a, r) => a + r[c], 0), s.totals[c], `${dim} ${c}`);
  }
  // time_pressure leaves moves out but can never exceed the totals
  const tp = s.dimensions.time_pressure;
  assert.ok(tp.reduce((a, r) => a + r.moves, 0) <= s.moves);
  for (const c of CLASSES) assert.ok(tp.reduce((a, r) => a + r[c], 0) <= s.totals[c]);
});

// ============================== themed.js =====================================================

test("themed exports: band constants", () => {
  assert.equal(MIN_BAND, 600);
  assert.equal(MAX_BAND, 1800);
  assert.equal(DEFAULT_BAND, 1000);
});

const g = (time_class, my_rating, end_time) => ({ time_class, my_rating, end_time });

test("ratingBand: exact edges of floor((rating + 300) / 200) * 200", () => {
  assert.equal(ratingBand([g("blitz", 699, 1)]), 800); // 999 -> 4 -> 800
  assert.equal(ratingBand([g("blitz", 700, 1)]), 1000); // 1000 -> 5 -> 1000
  assert.equal(ratingBand([g("blitz", 899, 1)]), 1000);
  assert.equal(ratingBand([g("blitz", 900, 1)]), 1200);
  assert.equal(ratingBand([g("blitz", 299, 1)]), 600); // 599 -> 400, clamped up
  assert.equal(ratingBand([g("blitz", 300, 1)]), 600);
  assert.equal(ratingBand([g("blitz", 499, 1)]), 600); // 799 -> 600
  assert.equal(ratingBand([g("blitz", 500, 1)]), 800);
  assert.equal(ratingBand([g("blitz", 1499, 1)]), 1600); // 1799 -> 1600
  assert.equal(ratingBand([g("blitz", 1500, 1)]), 1800);
  assert.equal(ratingBand([g("blitz", 1700, 1)]), 1800); // 2000, clamped down
  assert.equal(ratingBand([g("blitz", 0, 1)]), 600);
});

test("ratingBand: null, undefined and empty games give the default", () => {
  assert.equal(ratingBand(null), DEFAULT_BAND);
  assert.equal(ratingBand(undefined), DEFAULT_BAND);
  assert.equal(ratingBand([]), DEFAULT_BAND);
});

test("ratingBand: non-finite and non-number ratings are ignored", () => {
  assert.equal(ratingBand([g("blitz", NaN, 1), g("blitz", Infinity, 2), g("blitz", "1200", 3), g("blitz", undefined, 4)]), DEFAULT_BAND);
  // the one real rating decides, even though the junk entries are later and more numerous
  assert.equal(ratingBand([g("blitz", 900, 1), g("blitz", "1500", 2), g("blitz", NaN, 3), g("blitz", -Infinity, 4)]), 1200);
});

test("ratingBand: time class tie-break is most games, then latest end_time, then name", () => {
  // equal games: the class that played most recently wins
  assert.equal(ratingBand([g("blitz", 1500, 5), g("blitz", 1500, 1), g("rapid", 1000, 10), g("rapid", 1000, 2)]), 1200);
  assert.equal(ratingBand([g("rapid", 1000, 5), g("rapid", 1000, 1), g("blitz", 1500, 10), g("blitz", 1500, 2)]), 1800);
  // more games beats a later end_time
  assert.equal(ratingBand([g("blitz", 1000, 1), g("blitz", 1000, 2), g("rapid", 1500, 99)]), 1200);
  // equal games and equal latest end_time: name order ("blitz" before "bullet")
  assert.equal(ratingBand([g("bullet", 1500, 7), g("blitz", 1000, 7)]), 1200);
  assert.equal(ratingBand([g("blitz", 1000, 7), g("bullet", 1500, 7)]), 1200);
});

test("ratingBand: uses the rating of the latest game, wherever it sits in the list", () => {
  assert.equal(ratingBand([g("blitz", 1500, 9), g("blitz", 1000, 3), g("blitz", 1100, 4)]), 1800);
});

test("ratingBand: missing end_time counts as oldest", () => {
  assert.equal(ratingBand([g("blitz", 1000, 5), g("blitz", 2000, undefined)]), 1200);
  assert.equal(ratingBand([g("blitz", 2000, undefined), g("blitz", 1000, 5)]), 1200);
  assert.equal(ratingBand([g("rapid", 1500, undefined), g("blitz", 1000, 1)]), 1200);
});

test("ratingBand: daily is ignored while any live class has a rating", () => {
  assert.equal(ratingBand([g("daily", 1500, 9), g("daily", 1500, 8), g("blitz", 700, 1)]), 1000);
  assert.equal(ratingBand([g("daily", 1500, 9), g("blitz", null, 1)]), 1800); // live game has no usable rating: fall back to daily
});

// ---- allocate -------------------------------------------------------------------------------
test("allocate: nothing to split", () => {
  assert.deepEqual(allocate({}, 10, 1), {});
  assert.deepEqual(allocate({ a: 0, b: -3 }, 10, 1), {});
});

test("allocate: zero and negative counts are ignored", () => {
  assert.deepEqual(allocate({ a: 5, b: 0, c: -2 }, 10, 1), { a: 10 });
});

test("allocate: a single tag gets everything", () => {
  assert.deepEqual(allocate({ a: 5 }, 10, 1), { a: 10 });
  assert.deepEqual(allocate({ a: 1 }, 7, 0), { a: 7 });
});

test("allocate: proportional split with largest remainder", () => {
  assert.deepEqual(allocate({ a: 5, b: 3, c: 2 }, 7, 0), { a: 4, b: 2, c: 1 }); // 3.5 2.1 1.4 -> floors 3,2,1, spare to .5
  assert.deepEqual(allocate({ a: 1, b: 2 }, 5, 0), { a: 2, b: 3 }); // 1.67 3.33
  assert.deepEqual(allocate({ a: 1, b: 3 }, 8, 0), { a: 2, b: 6 }); // exact
});

test("allocate: remainder ties go to the earlier tag name, whatever the key order", () => {
  assert.deepEqual(allocate({ a: 1, b: 1, c: 1 }, 10, 0), { a: 4, b: 3, c: 3 });
  assert.deepEqual(allocate({ c: 1, b: 1, a: 1 }, 10, 0), { a: 4, b: 3, c: 3 });
  assert.deepEqual(allocate({ b: 1, a: 1 }, 3, 0), { a: 2, b: 1 });
});

test("allocate: tags below the minimum are lifted and the rest shrink", () => {
  assert.deepEqual(allocate({ a: 98, b: 1, c: 1 }, 100, 10), { a: 80, b: 10, c: 10 });
  assert.deepEqual(allocate({ a: 60, b: 30, c: 10 }, 30, 6), { a: 16, b: 8, c: 6 }); // shares 18, 9, 3
});

test("allocate: lifting can cascade to a second tag", () => {
  // total 100, min 20: shares 79.2, 19.8 (<20), 0.99 -> b, c lifted, a = 60
  assert.deepEqual(allocate({ a: 80, b: 20, c: 1 }, 100, 20), { a: 60, b: 20, c: 20 });
  // total 20, min 4, counts 10/3/1/1: shares 13.3, 4, 1.33, 1.33 -> c, d lifted (left 12); then a 9.23, b 2.77<4 -> b lifted (left 8) -> a 8
  assert.deepEqual(allocate({ a: 10, b: 3, c: 1, d: 1 }, 20, 4), { a: 8, b: 4, c: 4, d: 4 });
});

test("allocate: when minimum x tags >= total every tag gets the minimum", () => {
  assert.deepEqual(allocate({ a: 5, b: 1 }, 4, 2), { a: 2, b: 2 });
  assert.deepEqual(allocate({ a: 5, b: 1, c: 1 }, 5, 2), { a: 2, b: 2, c: 2 });
  assert.deepEqual(allocate({ a: 9 }, 3, 5), { a: 5 });
});

function lcg(seed) {
  let s = seed >>> 0;
  return () => {
    s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
    return s / 4294967296;
  };
}

test("allocate: properties over seeded random inputs", () => {
  const rnd = lcg(12345);
  const int = (lo, hi) => lo + Math.floor(rnd() * (hi - lo + 1));
  const failures = { sum: null, min: null, mono: null, valid: null };
  const note = (k, input) => {
    if (!failures[k] || JSON.stringify(input).length < JSON.stringify(failures[k]).length) failures[k] = input;
  };
  for (let i = 0; i < 600; i++) {
    const n = int(1, 7);
    const counts = {};
    for (let t = 0; t < n; t++) counts[`t${t}`] = int(-2, 200);
    const total = int(1, 300);
    const minimum = int(0, 30);
    const input = { counts, total, minimum };
    const positive = Object.keys(counts).filter((t) => counts[t] > 0);
    const q = allocate(counts, total, minimum);
    assert.deepEqual(Object.keys(q).sort(), positive.sort(), "quota keys are the positive-count tags");
    const sum = Object.values(q).reduce((a, b) => a + b, 0);
    if (!Object.values(q).every((v) => Number.isInteger(v) && v >= 0)) note("valid", input);
    if (!positive.length) continue;
    if (minimum * positive.length < total) {
      if (sum !== total) note("sum", { ...input, quota: q, sum });
      if (!positive.every((t) => q[t] >= minimum)) note("min", { ...input, quota: q });
    } else if (!positive.every((t) => q[t] === minimum)) {
      note("min", { ...input, quota: q });
    }
    for (const a of positive) for (const b of positive) if (counts[a] > counts[b] && q[a] < q[b]) note("mono", { ...input, quota: q });
  }
  assert.equal(failures.valid, null, `non-integer or negative quota: ${JSON.stringify(failures.valid)}`);
  assert.equal(failures.sum, null, `quotas do not sum to total: ${JSON.stringify(failures.sum)}`);
  assert.equal(failures.min, null, `minimum violated: ${JSON.stringify(failures.min)}`);
  assert.equal(failures.mono, null, `larger count got a smaller quota: ${JSON.stringify(failures.mono)}`);
});

// ---- pickThemed -----------------------------------------------------------------------------
const mk = (tag, n) => Array.from({ length: n }, (_, i) => ({ id: `${tag}${i}`, tag }));
const countBy = (out, t) => out.filter((p) => p.tag === t).length;
function deepFreeze(o) {
  if (o && typeof o === "object" && !Object.isFrozen(o)) {
    Object.freeze(o);
    for (const v of Object.values(o)) deepFreeze(v);
  }
  return o;
}

test("pickThemed: total 0, negative, NaN or missing gives nothing", () => {
  const pool = { a: mk("a", 5) };
  for (const total of [0, -5, NaN, undefined, null, "x"]) assert.deepEqual(pickThemed(pool, { a: 1 }, total), [], String(total));
});

test("pickThemed: empty or missing pool gives nothing", () => {
  assert.deepEqual(pickThemed(undefined, { a: 1 }, 5), []);
  assert.deepEqual(pickThemed(null, { a: 1 }, 5), []);
  assert.deepEqual(pickThemed({}, { a: 1 }, 5), []);
  assert.deepEqual(pickThemed({ a: [] }, { a: 1 }, 5), []);
});

test("pickThemed: empty arrays and non-arrays in the pool are ignored", () => {
  const pool = { a: [], b: "text", c: mk("c", 3), d: { length: 4 }, e: null };
  const out = pickThemed(pool, { a: 5, b: 5, c: 1, d: 5, e: 5 }, 5);
  assert.deepEqual(out.map((p) => p.id), ["c0", "c1", "c2"]);
});

test("pickThemed: tag counts for tags missing from the pool, and 'other', are ignored", () => {
  const pool = { a: mk("a", 10) };
  const out = pickThemed(pool, { a: 1, zzz: 1000, other: 500 }, 4);
  assert.equal(out.length, 4);
  assert.ok(out.every((p) => p.tag === "a"));
  // counts only for absent tags: falls back to an even split over what the pool has
  const even = pickThemed({ a: mk("a", 10), b: mk("b", 10) }, { zzz: 5, other: 5 }, 6);
  assert.equal(countBy(even, "a"), 3);
  assert.equal(countBy(even, "b"), 3);
});

test("pickThemed: never more than total, no duplicates, front of each list", () => {
  const pool = { a: mk("a", 50), b: mk("b", 50), c: mk("c", 50) };
  const rnd = lcg(99);
  for (let i = 0; i < 100; i++) {
    const total = 1 + Math.floor(rnd() * 60);
    const counts = { a: Math.floor(rnd() * 100), b: Math.floor(rnd() * 100), c: Math.floor(rnd() * 100) };
    const out = pickThemed(pool, counts, total);
    assert.ok(out.length <= total, `len ${out.length} > ${total} for ${JSON.stringify(counts)}`);
    assert.equal(new Set(out).size, out.length, "duplicate puzzle object");
    assert.equal(new Set(out.map((p) => p.id)).size, out.length, "duplicate puzzle id");
    for (const t of ["a", "b", "c"]) {
      assert.deepEqual(out.filter((p) => p.tag === t).map((p) => p.id), mk(t, countBy(out, t)).map((p) => p.id));
    }
  }
});

test("pickThemed: total smaller than the number of tags is still capped", () => {
  const pool = { a: mk("a", 5), b: mk("b", 5), c: mk("c", 5) };
  assert.equal(pickThemed(pool, { a: 1, b: 1, c: 1 }, 1).length, 1);
  assert.equal(pickThemed(pool, { a: 1, b: 1, c: 1 }, 2).length, 2);
});

test("pickThemed: leaves the pool and its puzzles untouched", () => {
  const pool = deepFreeze({ a: mk("a", 20), b: [{ id: "untagged0" }, { id: "untagged1", tag: "wrong" }] });
  const before = JSON.stringify(pool);
  const out = pickThemed(pool, { a: 3, b: 1 }, 10);
  assert.equal(JSON.stringify(pool), before);
  assert.ok(out.length > 0);
  // puzzles with a missing or wrong tag come back as tagged copies, the originals keep their shape
  const b = out.filter((p) => p.id.startsWith("untagged"));
  assert.ok(b.length > 0);
  assert.ok(b.every((p) => p.tag === "b"));
  assert.equal(pool.b[0].tag, undefined);
  assert.equal(pool.b[1].tag, "wrong");
  // properly tagged puzzles are passed through as the same objects
  assert.ok(out.filter((p) => p.tag === "a").every((p) => pool.a.includes(p)));
});

test("pickThemed: even split when there are no counts", () => {
  const pool = { a: mk("a", 10), b: mk("b", 10) };
  const out = pickThemed(pool, {}, 8);
  assert.equal(countBy(out, "a"), 4);
  assert.equal(countBy(out, "b"), 4);
  assert.equal(pickThemed(pool, undefined, 8).length, 8);
});

test("pickThemed: weights, minimum share and interleaving on a roomy pool", () => {
  const pool = { a: mk("a", 200), b: mk("b", 200), c: mk("c", 200) };
  const out = pickThemed(pool, { a: 80, b: 15, c: 5 }, 60);
  assert.equal(out.length, 60);
  // min 6; shares 48 / 9 / 3 -> c lifted to 6, rest 54 split 80:15 = 45.47 / 8.53 -> 45 + 9
  assert.deepEqual([countBy(out, "a"), countBy(out, "b"), countBy(out, "c")], [45, 9, 6]);
  // interleaved: a rare tag shows up early rather than all at the end
  assert.ok(out.slice(0, 10).some((p) => p.tag === "c"));
  assert.ok(out.slice(0, 10).some((p) => p.tag === "b"));
});

test("pickThemed: a pool too small for the quotas shrinks the total instead of capping tags", () => {
  const pool = { a: mk("a", 100), b: mk("b", 2) };
  const out = pickThemed(pool, { a: 1, b: 1 }, 20);
  // quota 10 each would overrun b (2), so the effective total shrinks to 4: 2 each, proportions kept
  assert.equal(countBy(out, "a"), 2);
  assert.equal(countBy(out, "b"), 2);
  assert.equal(out.length, 4);
});

test("pickThemed: weights hold when every tag's pool is smaller than its quota", () => {
  const pool = { a: mk("a", 120), b: mk("b", 120), c: mk("c", 120) };
  const out = pickThemed(pool, { a: 80, b: 15, c: 5 }, 2000);
  const [a, b, c] = [countBy(out, "a"), countBy(out, "b"), countBy(out, "c")];
  assert.equal(a, 120, "the dominant tag gets everything it has");
  assert.ok(b > c && b < a && c >= 10, `expected clearly unequal counts, got ${a}/${b}/${c}`);
  assert.ok(a >= 4 * b, `80:15 should be roughly 5:1, got ${a}/${b}`);
  assert.equal(out.length, a + b + c);
  assert.equal(new Set(out.map((p) => p.id)).size, out.length);
});

// ---- shipped data ---------------------------------------------------------------------------
test("pickThemed on data/themed/1000.json: proportions at total 2000 and 60", () => {
  const pool = readJson("data/themed/1000.json");
  const avail = (t) => pool.puzzles[t].length;
  const counts = { hung_piece: 80, missed_fork: 15, back_rank: 5 };

  // Every tag in the shipped pool has 120 puzzles, fewer than the quotas at total=2000
  // (about 1515 / 284 / 200), so the total shrinks until the dominant tag just fits: the
  // weights still show (hung_piece all 120; the others in proportion, subject to the 10% minimum).
  const big = pickThemed(pool.puzzles, counts, 2000);
  const bigCounts = { hung_piece: countBy(big, "hung_piece"), missed_fork: countBy(big, "missed_fork"), back_rank: countBy(big, "back_rank") };
  assert.equal(bigCounts.hung_piece, avail("hung_piece"));
  assert.ok(bigCounts.missed_fork < bigCounts.hung_piece / 3 && bigCounts.back_rank <= bigCounts.missed_fork, JSON.stringify(bigCounts));
  assert.equal(big.length, bigCounts.hung_piece + bigCounts.missed_fork + bigCounts.back_rank);
  // tags the player never made are not picked
  assert.equal(countBy(big, "endgame") + countBy(big, "missed_mate") + countBy(big, "missed_capture"), 0);

  // At a small total the 80/15/5 weights do show: min 6, so 45 / 9 / 6.
  const small = pickThemed(pool.puzzles, counts, 60);
  assert.deepEqual(
    { hung_piece: countBy(small, "hung_piece"), missed_fork: countBy(small, "missed_fork"), back_rank: countBy(small, "back_rank") },
    { hung_piece: 45, missed_fork: 9, back_rank: 6 },
  );
  assert.equal(new Set(small.map((p) => p.id)).size, 60);
});
