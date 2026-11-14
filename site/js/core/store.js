// IndexedDB wrapper. Everything is scoped by lower-case username.
const DB_NAME = "chess-coach";
const DB_VERSION = 1;

let dbPromise = null;

function open() {
  if (dbPromise) return dbPromise;
  dbPromise = new Promise((resolve, reject) => {
    let idb;
    try { idb = typeof indexedDB !== "undefined" ? indexedDB : null; } catch (e) { idb = null; }
    if (!idb) return reject(new Error("IndexedDB is not available in this browser"));
    let req;
    try { req = idb.open(DB_NAME, DB_VERSION); } catch (e) { return reject(e); }
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains("months")) db.createObjectStore("months", { keyPath: ["username", "month"] });
      if (!db.objectStoreNames.contains("games")) {
        const s = db.createObjectStore("games", { keyPath: ["username", "id"] });
        s.createIndex("user", "username");
      }
      if (!db.objectStoreNames.contains("analyses")) {
        const s = db.createObjectStore("analyses", { keyPath: ["username", "id"] });
        s.createIndex("user", "username");
      }
      // Light per-game summary so we need not load whole analyses to know what is done.
      if (!db.objectStoreNames.contains("analysisIndex")) {
        const s = db.createObjectStore("analysisIndex", { keyPath: ["username", "id"] });
        s.createIndex("user", "username");
      }
      if (!db.objectStoreNames.contains("meta")) db.createObjectStore("meta", { keyPath: ["username", "key"] });
    };
    req.onsuccess = () => {
      const db = req.result;
      db.onversionchange = () => { db.close(); dbPromise = null; };
      resolve(db);
    };
    req.onerror = () => reject(req.error || new Error("IndexedDB open failed"));
    req.onblocked = () => reject(new Error("IndexedDB is blocked by another tab"));
  }).catch((e) => { dbPromise = null; throw e; });
  return dbPromise;
}

const lc = (u) => String(u || "").trim().toLowerCase();

// Run fn(stores) in one transaction; resolves with fn's value after commit.
async function tx(names, mode, fn) {
  const db = await open();
  return new Promise((resolve, reject) => {
    let t, result;
    try {
      t = db.transaction(names, mode);
      const stores = {};
      for (const n of names) stores[n] = t.objectStore(n);
      t.oncomplete = () => resolve(result);
      t.onerror = () => reject(t.error || new Error("IndexedDB transaction failed"));
      t.onabort = () => reject(t.error || new Error("IndexedDB transaction aborted"));
      result = fn(stores);
    } catch (e) { reject(e); }
  });
}

const reqP = (r) => new Promise((res, rej) => { r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error); });

export async function getMonth(username, month) {
  const u = lc(username);
  const db = await open();
  const rec = await reqP(db.transaction("months").objectStore("months").get([u, month]));
  return rec ? { complete: !!rec.complete, fetched: rec.fetched } : null;
}

export function putMonth(username, month, { complete, fetched }) {
  const u = lc(username);
  return tx(["months"], "readwrite", (s) => { s.months.put({ username: u, month, complete: !!complete, fetched: fetched || Date.now() }); });
}

/** Map month -> { complete, fetched } for a user. */
export async function getMonths(username) {
  const u = lc(username);
  const db = await open();
  const all = await reqP(db.transaction("months").objectStore("months").getAll(IDBKeyRange.bound([u, ""], [u, "￿"])));
  return new Map(all.map((r) => [r.month, { complete: !!r.complete, fetched: r.fetched }]));
}

export function putGames(username, games) {
  const u = lc(username);
  return tx(["games"], "readwrite", (s) => { for (const g of games) s.games.put({ ...g, username: u }); });
}

/** All stored games for a user, oldest first (pgn included). */
export async function getGames(username) {
  const u = lc(username);
  const db = await open();
  const all = await reqP(db.transaction("games").objectStore("games").index("user").getAll(u));
  all.sort((a, b) => a.end_time - b.end_time);
  for (const g of all) delete g.username;
  return all;
}

export async function getAnalysis(username, id) {
  const u = lc(username);
  const db = await open();
  const rec = await reqP(db.transaction("analyses").objectStore("analyses").get([u, id]));
  if (!rec) return null;
  delete rec.username;
  return rec;
}

export function putAnalysis(username, analysis) {
  const u = lc(username);
  return tx(["analyses", "analysisIndex"], "readwrite", (s) => {
    s.analyses.put({ ...analysis, username: u });
    s.analysisIndex.put({ username: u, id: analysis.id, analysisVersion: analysis.analysisVersion, counts: analysis.counts || null });
  });
}

/** Map id -> analysis for a user. */
export async function getAnalyses(username) {
  const u = lc(username);
  const db = await open();
  const all = await reqP(db.transaction("analyses").objectStore("analyses").index("user").getAll(u));
  const map = new Map();
  for (const a of all) { delete a.username; map.set(a.id, a); }
  return map;
}

/** Map id -> { analysisVersion, counts } (cheap). */
export async function getAnalysisIndex(username) {
  const u = lc(username);
  const db = await open();
  const all = await reqP(db.transaction("analysisIndex").objectStore("analysisIndex").index("user").getAll(u));
  return new Map(all.map((r) => [r.id, { analysisVersion: r.analysisVersion, counts: r.counts }]));
}

export function deleteUser(username) {
  const u = lc(username);
  const names = ["months", "games", "analyses", "analysisIndex", "meta"];
  return tx(names, "readwrite", (s) => {
    s.months.delete(IDBKeyRange.bound([u, ""], [u, "￿"]));
    s.meta.delete(IDBKeyRange.bound([u, ""], [u, "￿"]));
    for (const n of ["games", "analyses", "analysisIndex"]) s[n].delete(IDBKeyRange.bound([u, ""], [u, "￿"]));
  });
}

export async function listUsers() {
  const db = await open();
  const users = new Set();
  for (const name of ["months", "games"]) {
    const keys = await reqP(db.transaction(name).objectStore(name).getAllKeys());
    for (const k of keys) users.add(k[0]);
  }
  return [...users].sort();
}
