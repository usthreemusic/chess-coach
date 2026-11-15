// Unit tests for the pure parts of site/js/core: sync.js (month selection), config.js (window and
// per-user months), chesscom.js (API client over a stubbed fetch) and normalise.js (cases that
// tests/js/run.mjs does not already cover). Run from the repo root:
//   node --test tests/js/unit/sync-config.test.mjs
import { describe, it, beforeEach, afterEach, mock } from "node:test";
import assert from "node:assert/strict";

const core = (name) => import(new URL("../../../site/js/core/" + name, import.meta.url).href);
const { monthOfUrl, shiftMonth, selectMonths } = await core("sync.js");
const { CONFIG, MONTH_CHOICES, windowStart, monthsBackFor, setMonthsBackFor } = await core("config.js");
const { listArchives, fetchMonth } = await core("chesscom.js");
const { myResult, openingName, openingFamily, normaliseGame } = await core("normalise.js");

const utc = (iso) => new Date(iso + (iso.includes("T") ? "" : "T00:00:00Z"));
const secs = (iso) => Date.parse(iso + "T00:00:00Z") / 1000;
const flush = () => new Promise((r) => setImmediate(r));

/** Run fn with the process time zone set to tz, restoring it afterwards. */
async function withTZ(tz, fn) {
  const had = Object.prototype.hasOwnProperty.call(process.env, "TZ");
  const old = process.env.TZ;
  process.env.TZ = tz;
  try { return await fn(); } finally {
    if (had) process.env.TZ = old; else delete process.env.TZ;
  }
}

// ---- sync.js ----------------------------------------------------------------------------------
const archiveUrl = (month, user = "bob") => `https://api.chess.com/pub/player/${user}/games/${month.replace("-", "/")}`;
/** "YYYY-MM" strings from..to inclusive. */
function monthsBetween(from, to) {
  const out = [];
  let [y, m] = from.split("-").map(Number);
  while (true) {
    const s = y + "-" + String(m).padStart(2, "0");
    out.push(s);
    if (s === to) return out;
    if (++m > 12) { m = 1; y++; }
  }
}
const monthsOf = (sel) => sel.map((s) => s.month);

describe("monthOfUrl", () => {
  it("reads the year and month from an archive URL", () => {
    assert.equal(monthOfUrl("https://api.chess.com/pub/player/bob/games/2025/03"), "2025-03");
    assert.equal(monthOfUrl("https://api.chess.com/pub/player/bob/games/2024/12"), "2024-12");
  });
  it("accepts a trailing slash", () => {
    assert.equal(monthOfUrl("https://api.chess.com/pub/player/bob/games/2025/03/"), "2025-03");
  });
  it("returns null for things that are not archive URLs", () => {
    assert.equal(monthOfUrl("hello"), null);
    assert.equal(monthOfUrl(""), null);
    assert.equal(monthOfUrl("https://api.chess.com/pub/player/bob/games/archives"), null);
    assert.equal(monthOfUrl("https://api.chess.com/pub/player/bob/games/2025/3"), null);
    assert.equal(monthOfUrl("https://api.chess.com/pub/player/bob/games/12025/03"), null);
  });
  it("returns null for null and undefined", () => {
    assert.equal(monthOfUrl(null), null);
    assert.equal(monthOfUrl(undefined), null);
  });
  it("rejects impossible months", () => {
    assert.equal(monthOfUrl("https://api.chess.com/pub/player/bob/games/2025/13"), null);
    assert.equal(monthOfUrl("https://api.chess.com/pub/player/bob/games/2025/00"), null);
  });
});

describe("shiftMonth", () => {
  const d = utc("2025-06-15");
  it("zero shift is the current month", () => assert.equal(shiftMonth(d, 0), "2025-06"));
  it("moves within a year", () => {
    assert.equal(shiftMonth(d, -2), "2025-04");
    assert.equal(shiftMonth(d, 3), "2025-09");
    assert.equal(shiftMonth(d, -5), "2025-01");
    assert.equal(shiftMonth(d, 6), "2025-12");
  });
  it("crosses the year boundary backwards", () => {
    assert.equal(shiftMonth(utc("2025-01-10"), -1), "2024-12");
    assert.equal(shiftMonth(utc("2025-02-10"), -2), "2024-12");
    assert.equal(shiftMonth(utc("2025-01-10"), -12), "2024-01");
    assert.equal(shiftMonth(utc("2025-01-10"), -13), "2023-12");
    assert.equal(shiftMonth(utc("2025-03-10"), -11), "2024-04");
  });
  it("crosses the year boundary forwards", () => {
    assert.equal(shiftMonth(utc("2025-12-10"), 1), "2026-01");
    assert.equal(shiftMonth(utc("2025-11-10"), 3), "2026-02");
    assert.equal(shiftMonth(utc("2025-12-10"), 12), "2026-12");
    assert.equal(shiftMonth(utc("2025-12-10"), 13), "2027-01");
  });
  it("zero-pads single digit months", () => {
    assert.equal(shiftMonth(utc("2025-10-01"), -1), "2025-09");
    assert.equal(shiftMonth(utc("2025-10-01"), 3), "2026-01");
  });
  it("uses UTC, not the local time zone", async () => {
    // 00:00:01 UTC on 1 Jan is still 31 Dec in the Americas; 23:59:59 UTC on 31 Mar is 1 Apr in NZ.
    const newYear = new Date(Date.UTC(2025, 0, 1, 0, 0, 1));
    const marchEnd = new Date(Date.UTC(2025, 2, 31, 23, 59, 59));
    await withTZ("America/Los_Angeles", () => {
      assert.equal(newYear.getMonth(), 11, "precondition: local month is December");
      assert.equal(shiftMonth(newYear, 0), "2025-01");
      assert.equal(shiftMonth(newYear, -1), "2024-12");
    });
    await withTZ("Pacific/Auckland", () => {
      assert.equal(marchEnd.getMonth(), 3, "precondition: local month is April");
      assert.equal(shiftMonth(marchEnd, 0), "2025-03");
    });
  });
});

describe("selectMonths", () => {
  const all = monthsBetween("2024-06", "2026-04").map((m) => archiveUrl(m));
  const today = utc("2026-01-15");

  it("keeps the current month and the (n-1) before it, across a year boundary", () => {
    assert.deepEqual(monthsOf(selectMonths(all, today, null, 3)), ["2025-11", "2025-12", "2026-01"]);
    assert.deepEqual(monthsOf(selectMonths(all, today, null, 6)),
      ["2025-08", "2025-09", "2025-10", "2025-11", "2025-12", "2026-01"]);
    assert.deepEqual(monthsOf(selectMonths(all, today, null, 12)),
      ["2025-02", "2025-03", "2025-04", "2025-05", "2025-06", "2025-07", "2025-08", "2025-09",
       "2025-10", "2025-11", "2025-12", "2026-01"]);
  });
  it("works for a window inside one year", () => {
    assert.deepEqual(monthsOf(selectMonths(all, utc("2025-08-31T23:59:59Z"), null, 3)), ["2025-06", "2025-07", "2025-08"]);
  });
  it("defaults to CONFIG.monthsBack (3)", () => {
    assert.equal(CONFIG.monthsBack, 3);
    assert.deepEqual(monthsOf(selectMonths(all, today, null)), ["2025-11", "2025-12", "2026-01"]);
  });
  it("a window of 1 is just the current month", () => {
    assert.deepEqual(monthsOf(selectMonths(all, today, null, 1)), ["2026-01"]);
  });
  it("returns { month, url } pairs with the original URL", () => {
    assert.deepEqual(selectMonths(all, today, null, 1), [{ month: "2026-01", url: archiveUrl("2026-01") }]);
  });
  it("excludes months after the current one and before the cutoff", () => {
    const sel = monthsOf(selectMonths(all, today, null, 3));
    assert.ok(!sel.includes("2026-02") && !sel.includes("2026-04"), "future months");
    assert.ok(!sel.includes("2025-10") && !sel.includes("2024-06"), "months before the cutoff");
  });
  it("skips past months stored as complete, refetches incomplete ones", () => {
    const stored = new Map([
      ["2025-11", { complete: false }],
      ["2025-12", { complete: true }],
    ]);
    assert.deepEqual(monthsOf(selectMonths(all, today, stored, 3)), ["2025-11", "2026-01"]);
  });
  it("always includes the current month, even when stored complete", () => {
    const stored = new Map([["2026-01", { complete: true }], ["2025-12", { complete: true }], ["2025-11", { complete: true }]]);
    assert.deepEqual(monthsOf(selectMonths(all, today, stored, 3)), ["2026-01"]);
  });
  it("treats a stored record without a complete flag as incomplete", () => {
    const stored = new Map([["2025-12", { fetched: 123 }], ["2025-11", {}]]);
    assert.deepEqual(monthsOf(selectMonths(all, today, stored, 3)), ["2025-11", "2025-12", "2026-01"]);
  });
  it("accepts stored as a plain object", () => {
    const stored = { "2025-11": { complete: true }, "2025-12": { complete: false } };
    assert.deepEqual(monthsOf(selectMonths(all, today, stored, 3)), ["2025-12", "2026-01"]);
  });
  it("accepts stored as null or undefined (nothing stored)", () => {
    const want = ["2025-11", "2025-12", "2026-01"];
    assert.deepEqual(monthsOf(selectMonths(all, today, null, 3)), want);
    assert.deepEqual(monthsOf(selectMonths(all, today, undefined, 3)), want);
    assert.deepEqual(monthsOf(selectMonths(all, today, new Map(), 3)), want);
    assert.deepEqual(monthsOf(selectMonths(all, today, {}, 3)), want);
  });
  it("ignores stored months outside the window", () => {
    const stored = new Map([["2020-01", { complete: false }], ["2027-01", { complete: false }]]);
    assert.deepEqual(monthsOf(selectMonths(all, today, stored, 3)), ["2025-11", "2025-12", "2026-01"]);
  });
  it("returns oldest first whatever the input order", () => {
    const shuffled = [archiveUrl("2026-01"), archiveUrl("2025-11"), archiveUrl("2025-12")];
    assert.deepEqual(monthsOf(selectMonths(shuffled, today, null, 3)), ["2025-11", "2025-12", "2026-01"]);
    assert.deepEqual(monthsOf(selectMonths([...shuffled].reverse(), today, null, 3)), ["2025-11", "2025-12", "2026-01"]);
  });
  it("ignores junk URLs", () => {
    const junk = ["", "nonsense", null, undefined, 42, "https://api.chess.com/pub/player/bob/games/archives",
      "https://api.chess.com/pub/player/bob/games/2025/7"];
    const sel = selectMonths([...junk, archiveUrl("2025-12")], today, null, 3);
    assert.deepEqual(monthsOf(sel), ["2025-12"]);
  });
  it("an empty archive list selects nothing", () => {
    assert.deepEqual(selectMonths([], today, null, 3), []);
  });
  it("duplicate URLs do not add months or break the order", () => {
    const sel = selectMonths([archiveUrl("2025-12"), archiveUrl("2025-12"), archiveUrl("2026-01")], today, null, 3);
    assert.deepEqual([...new Set(monthsOf(sel))], ["2025-12", "2026-01"]);
    assert.deepEqual(monthsOf(sel), [...monthsOf(sel)].sort());
  });
  it("uses the UTC month for 'today'", async () => {
    const t = new Date(Date.UTC(2026, 0, 1, 0, 0, 1)); // Dec 31 in Los Angeles
    await withTZ("America/Los_Angeles", () => {
      assert.deepEqual(monthsOf(selectMonths(all, t, null, 2)), ["2025-12", "2026-01"]);
    });
  });
  it("does not mutate its inputs", () => {
    const input = [archiveUrl("2026-01"), archiveUrl("2025-12")];
    const copy = [...input];
    selectMonths(input, today, null, 3);
    assert.deepEqual(input, copy);
  });
});

// ---- config.js --------------------------------------------------------------------------------
describe("windowStart", () => {
  it("is the first instant (UTC, in seconds) of the oldest month of the window", () => {
    const today = utc("2026-01-15T12:00:00Z");
    assert.equal(windowStart(3, today), secs("2025-11-01"));
    assert.equal(windowStart(6, today), secs("2025-08-01"));
    assert.equal(windowStart(12, today), secs("2025-02-01"));
    assert.equal(windowStart(1, today), secs("2026-01-01"));
  });
  it("handles windows inside a year and the last instant of a month", () => {
    assert.equal(windowStart(3, utc("2025-08-31T23:59:59Z")), secs("2025-06-01"));
    assert.equal(windowStart(12, utc("2024-03-01T00:00:00Z")), secs("2023-04-01"));
    assert.equal(windowStart(6, utc("2025-12-31T23:59:59Z")), secs("2025-07-01"));
  });
  it("is in UTC regardless of the local time zone", async () => {
    const t = new Date(Date.UTC(2026, 0, 1, 0, 0, 1));
    await withTZ("America/Los_Angeles", () => {
      assert.equal(windowStart(3, t), secs("2025-11-01"));
    });
    await withTZ("Pacific/Auckland", () => {
      assert.equal(windowStart(3, new Date(Date.UTC(2025, 2, 31, 23, 59, 59))), secs("2025-01-01"));
    });
  });
  it("defaults to the current date", () => {
    mock.timers.enable({ apis: ["Date"], now: Date.parse("2026-01-15T12:00:00Z") });
    try {
      assert.equal(windowStart(3), secs("2025-11-01"));
    } finally { mock.timers.reset(); }
  });
  it("matches the oldest month selectMonths keeps, and no kept month starts before it", () => {
    const archives = monthsBetween("2022-01", "2028-12").map((m) => archiveUrl(m));
    const todays = ["2026-01-01T00:00:00Z", "2026-01-31T23:59:59Z", "2025-12-15T08:00:00Z", "2024-02-29T12:00:00Z",
      "2025-06-30T23:59:59Z", "2025-07-01T00:00:00Z", "2026-03-10T00:00:00Z", "2026-12-31T23:59:59Z"];
    for (const iso of todays) {
      for (const n of MONTH_CHOICES) {
        const today = new Date(iso);
        const kept = selectMonths(archives, today, null, n);
        const ws = windowStart(n, today);
        const startOf = (m) => { const [y, mo] = m.split("-").map(Number); return Date.UTC(y, mo - 1, 1) / 1000; };
        assert.equal(kept.length, n, `${iso} n=${n}: number of months`);
        assert.equal(startOf(kept[0].month), ws, `${iso} n=${n}: oldest month starts at windowStart`);
        for (const k of kept) assert.ok(startOf(k.month) >= ws, `${iso} n=${n}: ${k.month} before window`);
        const before = shiftMonth(today, -n); // the first excluded month
        assert.ok(startOf(before) < ws, `${iso} n=${n}: ${before} should be outside`);
        assert.ok(!kept.some((k) => k.month === before));
      }
    }
  });
});

describe("MONTH_CHOICES", () => {
  it("offers 3, 6 and 12 months", () => assert.deepEqual(MONTH_CHOICES, [3, 6, 12]));
  it("includes the default", () => assert.ok(MONTH_CHOICES.includes(CONFIG.monthsBack)));
});

describe("monthsBackFor / setMonthsBackFor", () => {
  const hadOwn = Object.getOwnPropertyDescriptor(globalThis, "localStorage");
  /** Install a Map-backed fake localStorage; returns the backing Map. */
  function fakeStorage(overrides = {}) {
    const data = new Map();
    const storage = {
      getItem: (k) => (data.has(k) ? data.get(k) : null),
      setItem: (k, v) => { data.set(k, String(v)); },
      removeItem: (k) => { data.delete(k); },
      ...overrides,
    };
    Object.defineProperty(globalThis, "localStorage", { value: storage, configurable: true, writable: true });
    return data;
  }
  afterEach(() => {
    if (hadOwn) Object.defineProperty(globalThis, "localStorage", hadOwn);
    else delete globalThis.localStorage;
  });

  it("defaults to 3 when nothing is stored", () => {
    fakeStorage();
    assert.equal(monthsBackFor("bob"), 3);
  });
  it("round-trips each valid choice", () => {
    fakeStorage();
    for (const n of [3, 6, 12, 6]) {
      setMonthsBackFor("bob", n);
      assert.equal(monthsBackFor("bob"), n);
    }
  });
  it("returns a number, not a string", () => {
    fakeStorage();
    setMonthsBackFor("bob", 12);
    assert.strictEqual(monthsBackFor("bob"), 12);
  });
  it("reads valid values already in storage (written as strings)", () => {
    const data = fakeStorage();
    for (const key of [...data.keys()]) data.delete(key);
    setMonthsBackFor("zed", "6");
    assert.equal(monthsBackFor("zed"), 6);
  });
  it("falls back to 3 for invalid stored values", () => {
    const data = fakeStorage();
    setMonthsBackFor("bob", 6); // find out which key is used, then corrupt it
    const [key] = [...data.keys()];
    for (const bad of ["5", "0", "-3", "abc", "", "12.5", "NaN", "null", "undefined", "24", "[6]x"]) {
      data.set(key, bad);
      assert.equal(monthsBackFor("bob"), 3, `stored ${JSON.stringify(bad)}`);
    }
  });
  it("stores an unsupported value but reads back the default", () => {
    fakeStorage();
    setMonthsBackFor("bob", 5);
    assert.equal(monthsBackFor("bob"), 3);
  });
  it("keeps each user's choice separate", () => {
    fakeStorage();
    setMonthsBackFor("bob", 6);
    assert.equal(monthsBackFor("alice"), 3, "alice has not chosen");
    setMonthsBackFor("alice", 12);
    assert.equal(monthsBackFor("bob"), 6);
    assert.equal(monthsBackFor("alice"), 12);
    setMonthsBackFor("bob", 3);
    assert.equal(monthsBackFor("alice"), 12);
  });
  it("does not let one username prefix another", () => {
    fakeStorage();
    setMonthsBackFor("bob", 12);
    assert.equal(monthsBackFor("bo"), 3);
    assert.equal(monthsBackFor("bobby"), 3);
    assert.equal(monthsBackFor(""), 3);
  });
  it("falls back to the default when getItem throws", () => {
    fakeStorage({ getItem() { throw new Error("SecurityError"); } });
    assert.equal(monthsBackFor("bob"), 3);
  });
  it("setMonthsBackFor swallows a throwing setItem and the choice then reads as default", () => {
    fakeStorage({ setItem() { throw new Error("QuotaExceededError"); } });
    assert.doesNotThrow(() => setMonthsBackFor("bob", 12));
    assert.equal(monthsBackFor("bob"), 3);
  });
  it("falls back to the default when localStorage does not exist", () => {
    delete globalThis.localStorage;
    assert.equal(monthsBackFor("bob"), 3);
    assert.doesNotThrow(() => setMonthsBackFor("bob", 6));
    assert.equal(monthsBackFor("bob"), 3);
  });
});

// ---- chesscom.js ------------------------------------------------------------------------------
describe("chesscom API client", { timeout: 3000 }, () => {
  const realFetch = globalThis.fetch;
  const resp = (status, body, { badJson = false, headers = {} } = {}) => ({
    status,
    ok: status >= 200 && status < 300,
    headers: { get: (name) => headers[name] ?? null },
    json: async () => { if (badJson) throw new SyntaxError("Unexpected token <"); return body; },
  });
  /** Replace fetch with a scripted sequence; each step is a response, an Error to throw, or a Promise. */
  function stubFetch(...steps) {
    const stub = { calls: [], inFlight: 0, maxInFlight: 0 };
    globalThis.fetch = async (...args) => {
      stub.calls.push(args);
      stub.maxInFlight = Math.max(stub.maxInFlight, ++stub.inFlight);
      try {
        await Promise.resolve();
        const step = steps[stub.calls.length - 1];
        if (step === undefined) throw new Error("unexpected extra fetch call #" + stub.calls.length);
        if (step instanceof Error) throw step;
        return step;
      } finally { stub.inFlight--; }
    };
    return stub;
  }
  const assertCode = (code, msg) => (e) => {
    assert.equal(e.code, code);
    if (msg) assert.match(e.message, msg);
    return true;
  };
  const MONTH_URL = "https://api.chess.com/pub/player/bob/games/2025/03";

  beforeEach(() => { mock.timers.enable({ apis: ["setTimeout"] }); });
  afterEach(() => {
    mock.timers.reset();
    globalThis.fetch = realFetch;
  });

  describe("listArchives", () => {
    it("builds the URL from the lower-cased, trimmed username", async () => {
      const s = stubFetch(resp(200, { archives: [] }));
      await listArchives("  MagnusCarlsen ");
      assert.deepEqual(s.calls.map((c) => c[0]), ["https://api.chess.com/pub/player/magnuscarlsen/games/archives"]);
    });
    it("percent-encodes characters that are not URL safe", async () => {
      const s = stubFetch(resp(200, { archives: [] }));
      await listArchives("A b/c?d#e");
      assert.equal(s.calls[0][0], "https://api.chess.com/pub/player/a%20b%2Fc%3Fd%23e/games/archives");
    });
    it("encodes non-ASCII names as UTF-8 after lower-casing", async () => {
      const s = stubFetch(resp(200, { archives: [] }));
      await listArchives("ÜNÏ");
      assert.equal(s.calls[0][0], "https://api.chess.com/pub/player/%C3%BCn%C3%AF/games/archives");
    });
    it("calls fetch with only an abort signal as options (no custom headers)", async () => {
      const s = stubFetch(resp(200, { archives: [] }));
      await listArchives("bob");
      assert.deepEqual(Object.keys(s.calls[0][1]), ["signal"]);
    });
    it("returns the archives array in the order given", async () => {
      const list = [archiveUrl("2025-01"), archiveUrl("2025-02")];
      stubFetch(resp(200, { archives: list }));
      assert.deepEqual(await listArchives("bob"), list);
    });
    it("rejects an empty or blank username with not_found, without calling fetch", async () => {
      const s = stubFetch();
      for (const name of ["", "   ", "\t\n", null, undefined]) {
        await assert.rejects(listArchives(name), assertCode("not_found"), `name ${JSON.stringify(name)}`);
      }
      assert.equal(s.calls.length, 0);
    });
    it("maps a 404 to not_found", async () => {
      const s = stubFetch(resp(404, {}));
      await assert.rejects(listArchives("nobody"), assertCode("not_found"));
      assert.equal(s.calls.length, 1);
    });
    it("maps a 500 to network and puts the status in the message", async () => {
      stubFetch(resp(500, {}));
      await assert.rejects(listArchives("bob"), assertCode("network", /500/));
    });
    it("maps a 403 or 503 to network", async () => {
      stubFetch(resp(403, {}), resp(503, {}));
      await assert.rejects(listArchives("bob"), assertCode("network", /403/));
      await assert.rejects(listArchives("bob"), assertCode("network", /503/));
    });
    it("maps a throwing fetch to network and keeps the cause in the message", async () => {
      const s = stubFetch(new TypeError("boom"));
      await assert.rejects(listArchives("bob"), assertCode("network", /boom/));
      assert.equal(s.calls.length, 1, "no retry on a network failure");
    });
    it("copes with a thrown value that is not an Error", async () => {
      globalThis.fetch = async () => { throw undefined; };
      await assert.rejects(listArchives("bob"), assertCode("network"));
    });
    it("maps unreadable JSON to network", async () => {
      stubFetch(resp(200, null, { badJson: true }));
      await assert.rejects(listArchives("bob"), assertCode("network", /unreadable/));
    });
    it("returns [] when archives is missing, null, or not an array", async () => {
      stubFetch(resp(200, {}), resp(200, { archives: null }), resp(200, { archives: "x" }),
        resp(200, { archives: { 0: "a" } }), resp(200, null), resp(200, []));
      for (let i = 0; i < 6; i++) assert.deepEqual(await listArchives("bob"), [], `case ${i}`);
    });
    it("retries once after a 429, after exactly 5 seconds", async () => {
      const list = [archiveUrl("2025-01")];
      const s = stubFetch(resp(429, {}), resp(200, { archives: list }));
      const p = listArchives("bob");
      await flush();
      assert.equal(s.calls.length, 1);
      mock.timers.tick(4999);
      await flush();
      assert.equal(s.calls.length, 1, "must still be waiting at 4999 ms");
      mock.timers.tick(1);
      assert.deepEqual(await p, list);
      assert.equal(s.calls.length, 2);
      assert.equal(s.calls[1][0], s.calls[0][0], "retry hits the same URL");
    });
    it("a 404 after a 429 retry is still not_found", async () => {
      const s = stubFetch(resp(429, {}), resp(404, {}));
      const p = listArchives("bob");
      const check = assert.rejects(p, assertCode("not_found"));
      await flush();
      mock.timers.tick(5000);
      await check;
      assert.equal(s.calls.length, 2);
    });
  });

  describe("fetchMonth", () => {
    it("fetches exactly the URL it is given and returns the games array", async () => {
      const games = [{ url: "g1" }, { url: "g2" }];
      const s = stubFetch(resp(200, { games }));
      assert.deepEqual(await fetchMonth(MONTH_URL), games);
      assert.deepEqual(s.calls.map((c) => c[0]), [MONTH_URL]);
    });
    it("returns [] when games is missing, null or not an array", async () => {
      stubFetch(resp(200, {}), resp(200, { games: null }), resp(200, { games: "x" }), resp(200, { games: {} }), resp(200, null));
      for (let i = 0; i < 5; i++) assert.deepEqual(await fetchMonth(MONTH_URL), [], `case ${i}`);
    });
    it("a 404 on a month is a network error, not not_found", async () => {
      stubFetch(resp(404, {}));
      await assert.rejects(fetchMonth(MONTH_URL), assertCode("network", /404/));
    });
    it("a 500 is a network error with the status in the message", async () => {
      const s = stubFetch(resp(500, {}));
      await assert.rejects(fetchMonth(MONTH_URL), assertCode("network", /500/));
      assert.equal(s.calls.length, 1, "5xx is not retried");
    });
    it("a throwing fetch is a network error", async () => {
      stubFetch(new Error("offline"));
      await assert.rejects(fetchMonth(MONTH_URL), assertCode("network", /offline/));
    });
    it("unreadable JSON is a network error", async () => {
      stubFetch(resp(200, null, { badJson: true }));
      await assert.rejects(fetchMonth(MONTH_URL), assertCode("network"));
    });
    it("succeeds after one 429 and exactly one 5 s wait", async () => {
      const games = [{ url: "g" }];
      const s = stubFetch(resp(429, {}), resp(200, { games }));
      const p = fetchMonth(MONTH_URL);
      await flush();
      assert.equal(s.calls.length, 1, "first attempt made, second not yet");
      mock.timers.tick(4999);
      await flush();
      assert.equal(s.calls.length, 1);
      mock.timers.tick(1);
      assert.deepEqual(await p, games);
      assert.equal(s.calls.length, 2);
      assert.equal(s.maxInFlight, 1, "attempts never overlap");
    });
    it("gives up after a second 429: network error, no third attempt, one wait only", async () => {
      const s = stubFetch(resp(429, {}), resp(429, {}), resp(200, { games: [] }));
      const p = fetchMonth(MONTH_URL);
      const check = assert.rejects(p, assertCode("network"));
      await flush();
      mock.timers.tick(5000);
      await check;
      assert.equal(s.calls.length, 2);
      mock.timers.tick(60000);
      await flush();
      assert.equal(s.calls.length, 2, "no further attempts");
    });
    it("tells the user it is rate limited after two 429s", async () => {
      stubFetch(resp(429, {}), resp(429, {}));
      const p = fetchMonth(MONTH_URL);
      const check = assert.rejects(p, assertCode("network", /rate limit/i));
      await flush();
      mock.timers.tick(5000);
      await check;
    });
    it("waits the Retry-After seconds from a 429 instead of 5 s", async () => {
      const s = stubFetch(resp(429, {}, { headers: { "Retry-After": "2" } }), resp(200, { games: [{ a: 1 }] }));
      const p = fetchMonth(MONTH_URL);
      await flush();
      mock.timers.tick(1999);
      await flush();
      assert.equal(s.calls.length, 1, "still waiting at 1999 ms");
      mock.timers.tick(1);
      assert.deepEqual(await p, [{ a: 1 }]);
      assert.equal(s.calls.length, 2);
    });
    it("caps the Retry-After wait at 30 s", async () => {
      const s = stubFetch(resp(429, {}, { headers: { "Retry-After": "3600" } }), resp(200, { games: [] }));
      const p = fetchMonth(MONTH_URL);
      await flush();
      mock.timers.tick(29999);
      await flush();
      assert.equal(s.calls.length, 1);
      mock.timers.tick(1);
      await p;
      assert.equal(s.calls.length, 2);
    });
    it("falls back to 5 s when Retry-After is not a number of seconds", async () => {
      const s = stubFetch(resp(429, {}, { headers: { "Retry-After": "Wed, 21 Oct 2026 07:28:00 GMT" } }), resp(200, { games: [] }));
      const p = fetchMonth(MONTH_URL);
      await flush();
      mock.timers.tick(4999);
      await flush();
      assert.equal(s.calls.length, 1);
      mock.timers.tick(1);
      await p;
      assert.equal(s.calls.length, 2);
    });
    it("gives up on a request that stalls for 20 s with a 'did not respond' network error", async () => {
      const s = stubFetch(new Promise(() => {}));
      const check = assert.rejects(fetchMonth(MONTH_URL), assertCode("network", /did not respond/));
      await flush();
      mock.timers.tick(19999);
      await flush();
      assert.equal(s.calls[0][1].signal.aborted, false, "not aborted before 20 s");
      mock.timers.tick(1);
      await check;
      assert.equal(s.calls[0][1].signal.aborted, true);
      assert.equal(s.calls.length, 1, "a timeout is not retried");
    });
    it("also gives up when the response body stalls after the headers arrive", async () => {
      const s = stubFetch({ ...resp(200, {}), json: () => new Promise(() => {}) });
      const check = assert.rejects(fetchMonth(MONTH_URL), assertCode("network", /did not respond/));
      await flush();
      mock.timers.tick(20000);
      await check;
      assert.equal(s.calls.length, 1, "a timeout is not retried");
    });
    it("does not wait on errors other than 429", async () => {
      // With timers mocked, an unexpected sleep would hang until the describe timeout.
      stubFetch(resp(500, {}), resp(404, {}));
      await assert.rejects(fetchMonth(MONTH_URL), assertCode("network"));
      await assert.rejects(fetchMonth(MONTH_URL), assertCode("network"));
    });
    it("is used sequentially: two months fetched one after the other never overlap", async () => {
      const s = stubFetch(resp(200, { games: [{ a: 1 }] }), resp(200, { games: [{ b: 2 }] }));
      assert.deepEqual(await fetchMonth(MONTH_URL), [{ a: 1 }]);
      assert.deepEqual(await fetchMonth(MONTH_URL.replace("03", "04")), [{ b: 2 }]);
      assert.equal(s.maxInFlight, 1);
      assert.equal(s.calls.length, 2);
    });
  });
});

// ---- normalise.js -----------------------------------------------------------------------------
describe("myResult", () => {
  it("maps every chess.com result code", () => {
    const expected = {
      win: "win",
      checkmated: "loss", timeout: "loss", resigned: "loss", lose: "loss", abandoned: "loss",
      agreed: "draw", repetition: "draw", stalemate: "draw", insufficient: "draw",
      "50move": "draw", timevsinsufficient: "draw",
    };
    assert.equal(Object.keys(expected).length, 12);
    for (const [code, result] of Object.entries(expected)) assert.equal(myResult(code), result, code);
  });
  it("is exact-match: close-but-wrong codes are not wins", () => {
    assert.equal(myResult("Win"), "loss");
    assert.equal(myResult("won"), "loss");
  });
});

describe("openingName", () => {
  it("turns the last URL segment into words", () => {
    assert.equal(openingName("https://www.chess.com/openings/Caro-Kann-Defense-Exchange-Variation"), "Caro Kann Defense Exchange Variation");
  });
  it("keeps move text and strips repeated trailing slashes", () => {
    assert.equal(openingName("https://www.chess.com/openings/Sicilian-Defense-Najdorf-Variation-6.Be3-e5//"), "Sicilian Defense Najdorf Variation 6.Be3 e5");
  });
  it("handles a bare name and empty input", () => {
    assert.equal(openingName("Sicilian-Defense"), "Sicilian Defense");
    assert.equal(openingName(""), "");
    assert.equal(openingName(null), "");
    assert.equal(openingName("///"), "");
  });
});

describe("openingFamily", () => {
  it("stops at the first family word", () => {
    assert.equal(openingFamily("Kings Indian Attack"), "Kings Indian Attack");
    assert.equal(openingFamily("Italian Game Giuoco Piano"), "Italian Game");
    assert.equal(openingFamily("Vienna Game Max Lange Defense"), "Vienna Game");
    assert.equal(openingFamily("Kings Pawn Opening Kings Gambit"), "Kings Pawn Opening");
    assert.equal(openingFamily("Catalan Opening Closed Variation"), "Catalan Opening");
    assert.equal(openingFamily("Reti System"), "Reti System");
  });
  it("groups gambit lines under the gambit, dropping the declined/accepted suffix", () => {
    assert.equal(openingFamily("Queens Gambit Declined"), "Queens Gambit");
    assert.equal(openingFamily("Queens Gambit Accepted Central Variation"), "Queens Gambit");
    assert.equal(openingFamily("Kings Gambit Accepted Kieseritzky Gambit"), "Kings Gambit");
  });
  it("cuts at the first move number when there is no family word", () => {
    assert.equal(openingFamily("Ruy Lopez 3.Bb5 a6"), "Ruy Lopez");
    assert.equal(openingFamily("Nimzo Larsen 1.b3"), "Nimzo Larsen");
    assert.equal(openingFamily("Scandinavian 2.exd5"), "Scandinavian");
  });
  it("prefers a family word over a digit that comes after it", () => {
    assert.equal(openingFamily("Sicilian Defense Najdorf 5.Nc3"), "Sicilian Defense");
  });
  it("is Unknown when the name starts with a digit or is empty", () => {
    assert.equal(openingFamily("1.e4 e5 2.Nf3"), "Unknown");
    assert.equal(openingFamily("2...Nf6"), "Unknown");
    assert.equal(openingFamily(""), "Unknown");
    assert.equal(openingFamily("   "), "Unknown");
    assert.equal(openingFamily(null), "Unknown");
    assert.equal(openingFamily(undefined), "Unknown");
  });
  it("returns a single word and a lone family word unchanged", () => {
    assert.equal(openingFamily("Sicilian"), "Sicilian");
    assert.equal(openingFamily("Opening"), "Opening");
  });
  it("tolerates extra whitespace", () => {
    assert.equal(openingFamily("  Italian   Game  Two Knights "), "Italian Game");
  });
});

describe("normaliseGame (extra cases)", () => {
  const PGN = '[Event "Live Chess"]\n[ECO "B20"]\n[ECOUrl "https://www.chess.com/openings/Sicilian-Defense"]\n\n1. e4 c5 1-0';
  const PGN_NO_URL = '[Event "Live Chess"]\n[ECO "B20"]\n\n1. e4 c5 1-0';
  const PGN_NO_ECO = '[Event "Live Chess"]\n\n1. e4 c5 1-0';
  const raw = (over = {}) => ({
    url: "https://www.chess.com/game/live/123", uuid: "u-1", pgn: PGN, rules: "chess", end_time: 1700000000,
    time_class: "blitz", time_control: "180", rated: true,
    white: { username: "RobboSloth", rating: 1200, result: "win" },
    black: { username: "Other", rating: 1250, result: "resigned" },
    ...over,
  });
  const as = (meResult, oppResult) => raw({
    white: { username: "Me", rating: 1, result: meResult },
    black: { username: "Them", rating: 2, result: oppResult },
  });

  it("classifies every result code from my side as white", () => {
    const cases = [
      ["win", "checkmated", "win", "checkmated"],
      ["win", "timeout", "win", "timeout"],
      ["win", "resigned", "win", "resigned"],
      ["win", "abandoned", "win", "abandoned"],
      ["checkmated", "win", "loss", "checkmated"],
      ["timeout", "win", "loss", "timeout"],
      ["resigned", "win", "loss", "resigned"],
      ["abandoned", "win", "loss", "abandoned"],
      ["lose", "win", "loss", "lose"],
      ["agreed", "agreed", "draw", "agreed"],
      ["repetition", "repetition", "draw", "repetition"],
      ["stalemate", "stalemate", "draw", "stalemate"],
      ["insufficient", "insufficient", "draw", "insufficient"],
      ["50move", "50move", "draw", "50move"],
      ["timevsinsufficient", "insufficient", "draw", "timevsinsufficient"],
    ];
    for (const [me, opp, result, detail] of cases) {
      const g = normaliseGame(as(me, opp), "me");
      assert.deepEqual([g.result, g.result_detail], [result, detail], `${me} vs ${opp}`);
    }
  });
  it("result_detail for a win is the opponent's code, for a non-win my own code", () => {
    const win = normaliseGame(as("win", "timeout"), "me");
    assert.equal(win.result_detail, "timeout");
    const loss = normaliseGame(as("timeout", "win"), "me");
    assert.equal(loss.result_detail, "timeout");
    const draw = normaliseGame(as("agreed", "agreed"), "me");
    assert.equal(draw.result_detail, "agreed");
  });
  it("plays the same from the black side", () => {
    const blackWin = raw({
      white: { username: "Them", rating: 2, result: "checkmated" },
      black: { username: "Me", rating: 1, result: "win" },
    });
    const g = normaliseGame(blackWin, "me");
    assert.deepEqual([g.colour, g.result, g.result_detail, g.opponent, g.my_rating, g.opponent_rating],
      ["black", "win", "checkmated", "Them", 1, 2]);
  });
  it("matches the username case-insensitively in both directions", () => {
    assert.equal(normaliseGame(raw(), "ROBBOSLOTH").colour, "white");
    assert.equal(normaliseGame(raw(), "RobboSloth").colour, "white");
    const asBlack = raw({
      white: { username: "Other", result: "win" },
      black: { username: "RobboSLOTH", result: "resigned" },
    });
    assert.equal(normaliseGame(asBlack, "robbosloth").colour, "black");
    assert.equal(normaliseGame(asBlack, "ROBBOSLOTH").colour, "black");
  });
  it("keeps the opponent's name as chess.com spells it", () => {
    assert.equal(normaliseGame(raw(), "robbosloth").opponent, "Other");
  });
  it("takes the opening from the PGN ECOUrl header", () => {
    const g = normaliseGame(raw({ eco: "https://www.chess.com/openings/Different-Name" }), "robbosloth");
    assert.equal(g.opening, "Sicilian Defense");
    assert.equal(g.eco, "B20");
  });
  it("falls back to raw.eco when the PGN has no ECOUrl header", () => {
    const g = normaliseGame(raw({ pgn: PGN_NO_URL, eco: "https://www.chess.com/openings/Sicilian-Defense-Najdorf-Variation-6.Be3" }), "robbosloth");
    assert.equal(g.opening, "Sicilian Defense Najdorf Variation 6.Be3");
    assert.equal(g.eco, "B20");
  });
  it("falls back to raw.eco when the ECOUrl header is empty", () => {
    const pgn = '[ECOUrl ""]\n\n1. e4 *';
    const g = normaliseGame(raw({ pgn, eco: "https://www.chess.com/openings/Kings-Pawn-Opening" }), "robbosloth");
    assert.equal(g.opening, "Kings Pawn Opening");
  });
  it("has empty opening and eco when neither source exists", () => {
    const g = normaliseGame(raw({ pgn: PGN_NO_ECO }), "robbosloth");
    assert.equal(g.opening, "");
    assert.equal(g.eco, "");
  });
  it("fills defaults for optional fields", () => {
    const g = normaliseGame(raw({
      time_class: undefined, time_control: undefined, rated: undefined,
      white: { username: "robbosloth", result: "win" }, black: { username: "x", result: "resigned" },
    }), "robbosloth");
    assert.deepEqual([g.time_class, g.time_control, g.rated, g.my_rating, g.opponent_rating], ["", "", false, null, null]);
  });
  it("prefers the uuid, else the last URL segment even with a trailing slash", () => {
    assert.equal(normaliseGame(raw(), "robbosloth").id, "u-1");
    assert.equal(normaliseGame(raw({ uuid: undefined, url: "https://www.chess.com/game/live/987654/" }), "robbosloth").id, "987654");
  });
  it("skips games whose rules are missing", () => {
    assert.equal(normaliseGame(raw({ rules: undefined }), "robbosloth"), null);
    assert.equal(normaliseGame(raw({ pgn: "" }), "robbosloth"), null);
  });
  it("does not treat a different SetUp value as a custom position", () => {
    const g = normaliseGame(raw({ pgn: '[SetUp "0"]\n' + PGN }), "robbosloth");
    assert.equal(g.colour, "white");
  });
  it("returns null for a game with no white or black object (its docstring says null if unusable)", () => {
    assert.equal(normaliseGame(raw({ white: undefined }), "robbosloth"), null);
    assert.equal(normaliseGame(raw({ black: undefined, white: { username: "robbosloth", result: "win" } }), "robbosloth"), null);
  });
});
