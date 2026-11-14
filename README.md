# Chess Coach

Personal chess.com game review coach. A Python pipeline fetches and analyses games into JSON under `data/`; a static site under `site/` reads that JSON and is deployed to GitHub Pages.

## Run locally

```sh
python3 -m venv .venv && .venv/bin/pip install -r requirements.txt
.venv/bin/python pipeline/fetch.py        # incremental fetch from chess.com
.venv/bin/python pipeline/analyse.py      # Stockfish analysis of games not yet analysed (needs `brew install stockfish`)
.venv/bin/python pipeline/puzzles.py     # build data/puzzles.json from my mistakes and blunders
.venv/bin/python pipeline/stats.py       # build data/stats.json (mistake stats by phase, opening, piece, ...)
.venv/bin/python pipeline/lichess.py    # manual, not in the nightly workflow: build data/themed.json (see Themed puzzles)
python3 -m http.server -d site 8000       # then open http://localhost:8000
```

Settings live in `pipeline/config.toml`. Tests: `.venv/bin/python -m pytest tests`.

## Automation

`.github/workflows/update.yml` fetches and analyses new games nightly (and on every push or manual run), commits the data, and redeploys the site. Run `git pull` before pushing local changes, because the workflow commits data to `main`.

The feature roadmap is in `chess-review-coach-plan.md`.

## Themed puzzles

`pipeline/themes.py` tags each of my mistakes and blunders (`missed_mate`, `missed_capture`, `missed_fork`, `hung_piece`, `back_rank`, `endgame`, or `other`) with simple rules and no engine. `puzzles.py` stores the tags on each puzzle and `stats.py` counts them in the `mistake_type` dimension.

`pipeline/lichess.py` is run by hand (it is not part of the nightly workflow). It downloads the Lichess puzzle database (CC0, about 300 MB) once to `.cache/lichess_db_puzzle.csv.zst`, stream-reads it, and writes `data/themed.json`: `[themed]` in `pipeline/config.toml` sets the rating range, popularity and plays floors and the total. The total is split across my tags in proportion to how often I make each mistake (at least 100 per tag), and for each tag the most-played qualifying puzzles with matching Lichess themes are kept. Re-run `puzzles.py` first if my mistakes have changed. The Train page's "Themed (Lichess)" mode plays these puzzles, filtered by weakness.

## Themes

The site has four switchable looks: Pastel desktop (default), Chess Coach 95, CHESS.EXE and Plain (the original look). `site/js/theme.js` stores the choice in localStorage (`chess-coach-theme`) and sets `data-theme` on `<html>`; `site/css/themes.css` holds one section per theme. To add one, add it to the `THEMES` list in `theme.js` and add a `:root[data-theme="name"]` section that redefines the colour variables and restyles the panels and board.

## Third-party code

`site/vendor/` contains [chessground](https://github.com/lichess-org/chessground) (GPL-3.0) [chess.js](https://github.com/jhlywa/chess.js) (BSD-2-Clause) and the VT323 font (SIL Open Font License).
