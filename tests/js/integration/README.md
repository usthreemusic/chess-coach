# Integration tests (storage and sync)
Optional layer: runs site/js/core store.js, data.js and sync.js on `fake-indexeddb` with fake localStorage, BroadcastChannel, navigator.locks, a UCI Worker and a stubbed fetch (no network).
Separate from the dependency-free `tests/js/run.mjs`; this directory has its own package.json.
Run: `cd tests/js/integration && npm ci && npm test` (Node 22+); a single file: `node --test store.test.mjs`.
