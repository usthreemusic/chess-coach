// chess.com public API. Sequential use only; no custom headers.

function apiError(message, code) {
  const e = new Error(message);
  e.code = code;
  return e;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const TIMEOUT_MS = 20000;
const MAX_RETRY_WAIT_MS = 30000;

async function getJson(url, { notFoundIs404 = false } = {}) {
  for (let attempt = 0; attempt < 2; attempt++) {
    const ctl = new AbortController();
    const timer = setTimeout(() => ctl.abort(), TIMEOUT_MS);
    // Race the abort too, so a fetch or body read that ignores the signal still times out.
    const aborted = new Promise((_, reject) => ctl.signal.addEventListener("abort", () => reject(new Error("timeout"))));
    const timedOut = () => apiError("chess.com did not respond. Check your connection and try again.", "network");
    let resp;
    try {
      try {
        resp = await Promise.race([fetch(url, { signal: ctl.signal }), aborted]);
      } catch (e) {
        if (ctl.signal.aborted) throw timedOut();
        throw apiError("Could not reach chess.com (" + (e && e.message ? e.message : "network error") + ")", "network");
      }
      if (resp.ok) {
        try { return await Promise.race([resp.json(), aborted]); }
        catch (e) {
          if (ctl.signal.aborted) throw timedOut();
          throw apiError("chess.com returned an unreadable response", "network");
        }
      }
    } finally {
      clearTimeout(timer);
    }
    if (resp.status === 429) {
      if (attempt === 1) throw apiError("chess.com is rate limiting requests, try again shortly", "network");
      const header = resp.headers && resp.headers.get ? resp.headers.get("Retry-After") : null;
      const secs = header !== null && /^\s*\d+(\.\d+)?\s*$/.test(header) ? Number(header) : null;
      await sleep(secs === null ? 5000 : Math.min(secs * 1000, MAX_RETRY_WAIT_MS));
      continue;
    }
    if (resp.status === 404 && notFoundIs404) throw apiError("Not found", "not_found");
    throw apiError("chess.com returned HTTP " + resp.status, "network");
  }
}

/** Month archive URLs for a player, oldest first as chess.com returns them. */
export async function listArchives(username) {
  const name = encodeURIComponent(String(username || "").trim().toLowerCase());
  if (!name) throw apiError("Not found", "not_found");
  const data = await getJson("https://api.chess.com/pub/player/" + name + "/games/archives", { notFoundIs404: true });
  return Array.isArray(data && data.archives) ? data.archives : [];
}

/** Raw games array for one month archive URL. */
export async function fetchMonth(url) {
  const data = await getJson(url);
  return Array.isArray(data && data.games) ? data.games : [];
}
