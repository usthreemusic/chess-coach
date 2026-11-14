// Analysis settings, mirroring pipeline/config.toml (centipawns unless noted).
export const CONFIG = {
  depth: 12,
  thresholds: { inaccuracy: 50, mistake: 100, blunder: 200 },
  decidedCp: 600,
  altMarginCp: 50,
  cap: 1000,
  monthsBack: 3, // default; each player can choose 3, 6 or 12 (see monthsBackFor)
  analysisVersion: 1,
};

// How far back to look, chosen per player and kept in localStorage.
export const MONTH_CHOICES = [3, 6, 12];
const MONTHS_KEY = "chess-coach-months";

/** Months of games to fetch, analyse and show for this player. */
export function monthsBackFor(user) {
  try {
    const n = Number(localStorage.getItem(MONTHS_KEY + ":" + user));
    if (MONTH_CHOICES.includes(n)) return n;
  } catch (e) { /* no storage: use the default */ }
  return CONFIG.monthsBack;
}

export function setMonthsBackFor(user, months) {
  try { localStorage.setItem(MONTHS_KEY + ":" + user, String(months)); } catch (e) { /* ignore */ }
}

/**
 * Unix time (seconds) of the start of the window: the first day (UTC) of the month
 * (months - 1) before the current one, so the window is this month plus the ones before it.
 */
export function windowStart(months, today = new Date()) {
  return Date.UTC(today.getUTCFullYear(), today.getUTCMonth() - (months - 1), 1) / 1000;
}
