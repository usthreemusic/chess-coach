// Choosing themed (Lichess) puzzles for one player. No DOM, no network.

export const MIN_BAND = 600;
export const MAX_BAND = 1800;
export const DEFAULT_BAND = 1000;

/**
 * Puzzle rating band for a player: their latest rating in their most-played non-daily time
 * class (any class if none), plus 300, rounded down to a multiple of 200, clamped to 600..1800.
 * The band covers ratings [band, band + 200).
 */
export function ratingBand(games) {
  const rated = (games || []).filter((g) => typeof g.my_rating === "number" && Number.isFinite(g.my_rating));
  if (!rated.length) return DEFAULT_BAND;
  const live = rated.filter((g) => g.time_class !== "daily");
  const pool = live.length ? live : rated;
  const byClass = new Map();
  for (const g of pool) {
    const entry = byClass.get(g.time_class) || { n: 0, latest: null };
    entry.n += 1;
    if (!entry.latest || (g.end_time ?? 0) >= (entry.latest.end_time ?? 0)) entry.latest = g;
    byClass.set(g.time_class, entry);
  }
  const [, best] = [...byClass.entries()].sort(
    (a, b) => b[1].n - a[1].n || (b[1].latest.end_time ?? 0) - (a[1].latest.end_time ?? 0) || (a[0] < b[0] ? -1 : 1),
  )[0];
  const band = Math.floor((best.latest.my_rating + 300) / 200) * 200;
  return Math.max(MIN_BAND, Math.min(MAX_BAND, band));
}

/** Split `total` across `counts` ({tag: n}) in proportion, giving every tag at least `minimum`. */
export function allocate(counts, total, minimum) {
  const tags = Object.keys(counts).filter((t) => counts[t] > 0).sort();
  const quota = {};
  if (!tags.length) return quota;
  if (minimum * tags.length >= total) {
    for (const t of tags) quota[t] = minimum;
    return quota;
  }
  let free = [...tags];
  let left = total;
  for (;;) { // tags whose share falls below the minimum are pinned to it
    const weight = free.reduce((a, t) => a + counts[t], 0);
    const low = free.filter((t) => (left * counts[t]) / weight < minimum);
    if (!low.length) break;
    for (const t of low) { quota[t] = minimum; left -= minimum; }
    free = free.filter((t) => !low.includes(t));
    if (!free.length) return quota;
  }
  const weight = free.reduce((a, t) => a + counts[t], 0);
  const shares = Object.fromEntries(free.map((t) => [t, (left * counts[t]) / weight]));
  for (const t of free) quota[t] = Math.floor(shares[t]);
  let spare = total - Object.values(quota).reduce((a, b) => a + b, 0);
  const byFraction = [...free].sort((a, b) => (shares[b] % 1) - (shares[a] % 1) || (a < b ? -1 : 1));
  for (const t of byFraction) {
    if (spare <= 0) break;
    quota[t] += 1;
    spare -= 1;
  }
  return quota;
}

/**
 * Pick `total` puzzles from pool ({tag: [puzzle, ...]}, most-played first) in proportion to the
 * player's mistake counts per tag (at least 10% of total for any tag they make; an even split
 * when tagCounts is empty). Each tag gives puzzles from the front of its list, capped by what
 * is available; the result interleaves the tags in proportion so a mixed session mixes weaknesses.
 */
export function pickThemed(pool, tagCounts, total) {
  const available = Object.keys(pool || {}).filter((t) => Array.isArray(pool[t]) && pool[t].length);
  if (!available.length || !(total > 0)) return [];
  const counts = {};
  for (const t of available) if ((tagCounts?.[t] || 0) > 0) counts[t] = tagCounts[t];
  if (!Object.keys(counts).length) for (const t of available) counts[t] = 1;
  const quota = allocate(counts, total, Math.ceil(total * 0.1));
  const picked = [];
  for (const tag of Object.keys(quota)) {
    const list = pool[tag].slice(0, quota[tag]);
    list.forEach((p, i) => picked.push({ at: i / list.length, tag, puzzle: p.tag === tag ? p : { ...p, tag } }));
  }
  picked.sort((a, b) => a.at - b.at || (a.tag < b.tag ? -1 : a.tag > b.tag ? 1 : 0));
  return picked.map((x) => x.puzzle).slice(0, total);
}
