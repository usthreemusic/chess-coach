# Chess Coach

A static chess.com game review coach. Anyone can open the site, enter their chess.com username, and their own browser fetches their recent games, analyses them with Stockfish and builds review, puzzle and statistics pages from the result. There is no server: the site is plain HTML and ES modules (no build step) hosted on GitHub Pages.

## What runs where

- **In the browser** (`site/js/`): `app.js` is the shared shell (username gate, player chip, sync status strip). `js/core/` is the data layer: `chesscom.js` and `sync.js` fetch the last 3, 6 or 12 months of games (the player chooses; 3 is the default) from chess.com's public API, `engine.js` runs Stockfish (WebAssembly, in Web Workers), `analyse.js` classifies moves, `puzzles.js`, `themes.js` and `stats.js` derive puzzles and statistics, and `store.js` keeps everything in IndexedDB per username. `data.js` is the facade the pages read. Analysis runs in one tab at a time; other tabs show "Analysing in another tab" and refresh as data arrives. Nothing is uploaded: games come from chess.com's public records and stay in the browser. Training progress and filters are saved in localStorage per player.
- **Shipped with the site** (`data/`, served as `site/data`): `data/themed/{band}.json` is the generic Lichess puzzle pool per rating band; `data/analysis/` holds pre-computed analyses for the seed player named in `data/seed.json`, so that player's games load without re-running the engine.
- **GitHub Actions** (`.github/workflows/update.yml`): on push to `main`, runs the Python and Node tests and deploys `site/` to GitHub Pages. It no longer fetches or analyses anything.

## Run locally

```sh
python3 -m http.server -d site 8000       # then open http://localhost:8000
```

`site/data` is a symlink to `data/`. `site/_dev.html` is a small page for driving the sync and data layer by hand.

## Tests

```sh
node tests/js/run.mjs                       # browser-side analysis code, against tests/fixtures
python3 -m venv .venv && .venv/bin/pip install -r requirements.txt
.venv/bin/python -m pytest -q tests         # pipeline/lichess.py
```

`tests/fixtures/` is a frozen sample of 25 real games with their analyses and the expected puzzles and stats, generated once with the retired Python pipeline. The JS tests check the in-browser code reproduces them exactly.

## Themed puzzles

`pipeline/lichess.py` is run by hand when you want to rebuild the pool:

```sh
.venv/bin/python pipeline/lichess.py
```

It downloads the Lichess puzzle database (CC0, about 300 MB) once to `.cache/lichess_db_puzzle.csv.zst`, stream-reads it, and writes `data/themed/{600,800,...,1800}.json` (band `b` covers ratings `b` to `b+199`). Each file holds, per mistake tag, the `per_tag` most-played qualifying puzzles (settings in `pipeline/config.toml`). The browser picks a band from the player's rating and draws from it in proportion to their own mistake types (`site/js/core/themed.js`).

## Themes

The site has four switchable looks: Pastel desktop (default), Chess Coach 95, CHESS.EXE and Plain. `site/js/theme.js` stores the choice in localStorage (`chess-coach-theme`) and sets `data-theme` on `<html>`; `site/css/themes.css` holds one section per theme. To add one, add it to the `THEMES` list in `theme.js` and add a `:root[data-theme="name"]` section that redefines the colour variables and restyles the panels, inputs and board.

The original feature roadmap is in `chess-review-coach-plan.md`.

## Third-party code

`site/vendor/` contains [chessground](https://github.com/lichess-org/chessground) (GPL-3.0), [chess.js](https://github.com/jhlywa/chess.js) (BSD-2-Clause), [Chart.js](https://www.chartjs.org/) (MIT), [Stockfish](https://stockfishchess.org/) (GPL-3.0, `site/vendor/stockfish`, via the [stockfish.js](https://www.npmjs.com/package/stockfish) npm package) and the VT323 font (SIL Open Font License). Puzzles in `data/themed/` come from the Lichess puzzle database (CC0).
