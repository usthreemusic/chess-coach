// Port of pipeline/fetch.py: reduce a chess.com API game to the fields we keep.

const DRAWS = new Set(["agreed", "repetition", "stalemate", "insufficient", "50move", "timevsinsufficient"]);
const FAMILY_ENDINGS = new Set(["Opening", "Defense", "Game", "Gambit", "Attack", "System"]);

export function myResult(code) {
  if (code === "win") return "win";
  return DRAWS.has(code) ? "draw" : "loss";
}

export function openingName(ecoUrl) {
  if (!ecoUrl) return "";
  const trimmed = ecoUrl.replace(/\/+$/, "");
  return trimmed.slice(trimmed.lastIndexOf("/") + 1).replaceAll("-", " ");
}

/** Reduce an opening name to its family, e.g. "Caro Kann Defense Exchange Variation" -> "Caro Kann Defense". */
export function openingFamily(name) {
  const words = (name || "").split(/\s+/).filter(Boolean);
  if (!words.length) return "Unknown";
  for (let i = 0; i < words.length; i++) {
    if (FAMILY_ENDINGS.has(words[i])) return words.slice(0, i + 1).join(" ");
  }
  for (let i = 0; i < words.length; i++) {
    if (/\d/.test(words[i])) return words.slice(0, i).join(" ") || "Unknown";
  }
  return words.join(" ");
}

function headersOf(pgn) {
  const headers = {};
  for (const m of pgn.matchAll(/\[(\w+) "([^"]*)"\]/g)) headers[m[1]] = m[2];
  return headers;
}

/** Reduce a chess.com API game to the fields we keep. null if unusable. */
export function normaliseGame(raw, username) {
  const pgn = raw.pgn;
  if (!pgn || raw.rules !== "chess" || !raw.white || !raw.black) return null;
  if (pgn.includes('[SetUp "1"]')) return null; // custom starting position
  const user = String(username).toLowerCase();
  const colour = String(raw.white.username).toLowerCase() === user ? "white" : "black";
  const me = raw[colour];
  const opp = raw[colour === "white" ? "black" : "white"];
  const headers = headersOf(pgn);
  const url = raw.url;
  return {
    id: raw.uuid || url.replace(/\/+$/, "").split("/").pop(),
    url,
    end_time: raw.end_time,
    time_class: raw.time_class ?? "",
    time_control: raw.time_control ?? "",
    rated: raw.rated ?? false,
    colour,
    result: myResult(me.result),
    result_detail: me.result !== "win" ? me.result : opp.result,
    my_rating: me.rating ?? null,
    opponent: opp.username,
    opponent_rating: opp.rating ?? null,
    eco: headers.ECO ?? "",
    opening: openingName(headers.ECOUrl || raw.eco),
    pgn,
  };
}
