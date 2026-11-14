# Chess Game Review Coach — Build Plan

## Goal
A personal app that pulls all of my chess.com games, orders them chronologically, finds my mistakes with an engine, and trains me with puzzles built from those mistakes plus themed puzzles that target my recurring weaknesses.

## Constraints
- Single user (me). No accounts or auth needed.
- Python backend preferred (I'm strong in Python, weaker in C++/JS frameworks).
- Simple web front end is fine (vanilla JS or a light framework).
- Runs locally first. Hosting is optional later.

## Architecture
1. **Python pipeline** (offline, run on demand): fetch, analyse, cache to JSON or SQLite.
2. **Web UI** (reads cached data): game list, game review, puzzle trainer, stats.

## Phase 1 — Fetch and cache games
- Use the chess.com public API (no login): `https://api.chess.com/pub/player/{username}/games/archives`, then each monthly archive URL.
- Send a `User-Agent` header and request archives one at a time (sequentially, not in parallel).
- Store each game's PGN, date, time control, colour, result, opponent, ratings, and opening/ECO.
- Sort by end time, ascending.
- Make it incremental: only fetch months not already cached, and always re-fetch the current month.

## Phase 2 — Engine analysis
- Use `python-chess` with a local Stockfish binary.
- Analyse each of my moves at a fixed depth (start with 14–16) and store the evaluation before and after.
- Classify my moves by eval drop, in centipawns, from my perspective:
  - Inaccuracy: 50–99
  - Mistake: 100–199
  - Blunder: 200 or more
- Cap mate scores (for example ±1000) and ignore moves in positions that were already completely lost or completely won.
- Cache results per game ID. Never re-analyse a game.
- Record clock time remaining per move (from `%clk` in the PGN) to flag time-pressure mistakes.

## Phase 3 — Puzzles from my own games
- Each mistake or blunder becomes a puzzle:
  - Position: the FEN before my bad move.
  - Solution: the engine's best move, plus a short principal variation (2–3 moves) where it's forcing.
  - Context: link to the source game and move number.
- Trainer UI: show the board, I play a move, it's checked against the solution, and it reveals the line on failure.
- Spaced repetition: requeue failed puzzles sooner, push solved ones further out (a simple Leitner box system is fine).

## Phase 4 — Mistake stats
Aggregate mistakes by:
- Game phase (opening, before move 12; middlegame; endgame, by material count)
- Opening / ECO
- Colour
- Time control
- Time pressure (under 10% of clock remaining)
- Piece moved

Show these as simple charts on a stats page, with the trend over time (mistakes per game by month).

## Phase 5 — Themed puzzles (weakness targeting)
- Download the Lichess puzzle database (CSV, CC0, theme-tagged) and import it into SQLite.
- Classify my mistakes with simple rules where feasible: hanging piece, missed capture, missed mate, missed fork (the best move attacks 2 or more pieces), back-rank issues, endgame mistakes.
- Serve Lichess puzzles whose themes match my most frequent mistake types, at a rating near mine.

## UI pages
1. **Games:** chronological list with filters (time control, colour, result) and mistake counts.
2. **Review:** board with move list, eval bar, and mistakes highlighted. Step through the game.
3. **Train:** my own-game puzzles and themed puzzles (selectable).
4. **Stats:** the weakness breakdown and trends.

## Suggested libraries
- Python: `python-chess`, `requests`, `sqlite3`, Flask or FastAPI
- Front end: `chessground` or `chessboard.js` for the board, `chess.js` for move validation, Chart.js for stats

## Build order
Phase 1, then 2, then 3, then 4, then 5. Each phase should be usable on its own before moving to the next.

## Config
- `username`
- Analysis depth
- Mistake thresholds
- Path to the Stockfish binary
