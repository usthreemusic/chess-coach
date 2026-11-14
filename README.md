# Chess Coach

Personal chess.com game review coach. A Python pipeline fetches and analyses games into JSON under `data/`; a static site under `site/` reads that JSON and is deployed to GitHub Pages.

## Run locally

```sh
python3 -m venv .venv && .venv/bin/pip install -r requirements.txt
.venv/bin/python pipeline/fetch.py        # incremental fetch from chess.com
.venv/bin/python pipeline/analyse.py      # Stockfish analysis of games not yet analysed (needs `brew install stockfish`)
.venv/bin/python pipeline/puzzles.py     # build data/puzzles.json from my mistakes and blunders
.venv/bin/python pipeline/stats.py       # build data/stats.json (mistake stats by phase, opening, piece, ...)
python3 -m http.server -d site 8000       # then open http://localhost:8000
```

Settings live in `pipeline/config.toml`. Tests: `.venv/bin/python -m pytest tests`.

## Automation

`.github/workflows/update.yml` fetches and analyses new games nightly (and on every push or manual run), commits the data, and redeploys the site. Run `git pull` before pushing local changes, because the workflow commits data to `main`.

The feature roadmap is in `chess-review-coach-plan.md`.

## Third-party code

`site/vendor/` contains [chessground](https://github.com/lichess-org/chessground) (GPL-3.0) and [chess.js](https://github.com/jhlywa/chess.js) (BSD-2-Clause).
