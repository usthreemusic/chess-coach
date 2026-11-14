# Chess Coach

Personal chess.com game review coach. A Python pipeline fetches and analyses games into JSON under `data/`; a static site under `site/` reads that JSON and is deployed to GitHub Pages.

## Run locally

```sh
python3 -m venv .venv && .venv/bin/pip install -r requirements.txt
.venv/bin/python pipeline/fetch.py        # incremental fetch from chess.com
python3 -m http.server -d site 8000       # then open http://localhost:8000
```

Settings live in `pipeline/config.toml`. Tests: `.venv/bin/python -m pytest tests`.

## Automation

`.github/workflows/update.yml` fetches new games nightly (and on every push or manual run), commits them, and redeploys the site. Run `git pull` before pushing local changes, because the workflow commits data to `main`.

The feature roadmap is in `chess-review-coach-plan.md`.
