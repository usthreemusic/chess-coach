// chess.com public API. Sequential use only; no custom headers.

function apiError(message, code) {
  const e = new Error(message);
  e.code = code;
  return e;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function getJson(url, { notFoundIs404 = false } = {}) {
  for (let attempt = 0; attempt < 2; attempt++) {
    let resp;
    try {
      resp = await fetch(url);
    } catch (e) {
      throw apiError("Could not reach chess.com (" + (e && e.message ? e.message : "network error") + ")", "network");
    }
    if (resp.status === 429 && attempt === 0) { await sleep(5000); continue; }
    if (resp.status === 404 && notFoundIs404) throw apiError("Not found", "not_found");
    if (!resp.ok) throw apiError("chess.com returned HTTP " + resp.status, "network");
    try { return await resp.json(); }
    catch (e) { throw apiError("chess.com returned an unreadable response", "network"); }
  }
  throw apiError("chess.com is rate limiting requests, try again shortly", "network");
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
