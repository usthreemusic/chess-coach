"""Fetch chess.com games incrementally into data/.

Writes:
  data/archives/YYYY-MM.json  one file per month, full games including PGN
  data/games.json             index of every game (no PGN), oldest first

Months already cached as complete are never re-fetched. The current month,
and any month cached before it had ended, is always re-fetched.
"""

import json
import re
import sys
import time
import tomllib
from datetime import datetime, timezone
from pathlib import Path

import requests

ROOT = Path(__file__).resolve().parent.parent
DATA = ROOT / "data"
ARCHIVES = DATA / "archives"
USER_AGENT = "chess-coach/0.1 (personal game review tool)"

DRAWS = {"agreed", "repetition", "stalemate", "insufficient", "50move", "timevsinsufficient"}
HEADER = re.compile(r'\[(\w+) "([^"]*)"\]')


def get_json(url, retries=4):
    for attempt in range(retries):
        resp = requests.get(url, headers={"User-Agent": USER_AGENT}, timeout=30)
        if resp.status_code == 429 and attempt < retries - 1:
            time.sleep(5 * (attempt + 1))
            continue
        resp.raise_for_status()
        return resp.json()


def my_result(code):
    if code == "win":
        return "win"
    return "draw" if code in DRAWS else "loss"


def opening_name(eco_url):
    if not eco_url:
        return ""
    return eco_url.rstrip("/").rsplit("/", 1)[-1].replace("-", " ")


def normalise(game, username):
    """Reduce a chess.com API game to the fields we keep. None if unusable."""
    pgn = game.get("pgn")
    if not pgn or game.get("rules") != "chess":
        return None
    colour = "white" if game["white"]["username"].lower() == username else "black"
    me = game[colour]
    opp = game["black" if colour == "white" else "white"]
    headers = dict(HEADER.findall(pgn))
    return {
        "id": game.get("uuid") or game["url"].rstrip("/").rsplit("/", 1)[-1],
        "url": game["url"],
        "end_time": game["end_time"],
        "time_class": game.get("time_class", ""),
        "time_control": game.get("time_control", ""),
        "rated": game.get("rated", False),
        "colour": colour,
        "result": my_result(me["result"]),
        "result_detail": me["result"] if me["result"] != "win" else opp["result"],
        "my_rating": me.get("rating"),
        "opponent": opp["username"],
        "opponent_rating": opp.get("rating"),
        "eco": headers.get("ECO", ""),
        "opening": opening_name(headers.get("ECOUrl") or game.get("eco")),
        "pgn": pgn,
    }


def needs_fetch(month, current_month):
    path = ARCHIVES / f"{month}.json"
    if month >= current_month or not path.exists():
        return True
    return not json.loads(path.read_text()).get("complete", False)


def build_index(username):
    games = []
    for path in sorted(ARCHIVES.glob("*.json")):
        month = json.loads(path.read_text())
        for g in month["games"]:
            entry = {k: v for k, v in g.items() if k != "pgn"}
            entry["month"] = month["month"]
            games.append(entry)
    games.sort(key=lambda g: g["end_time"])
    index = {"username": username, "games": games}
    (DATA / "games.json").write_text(json.dumps(index, separators=(",", ":")))
    return len(games)


def main():
    config = tomllib.loads((ROOT / "pipeline" / "config.toml").read_text())
    username = config["username"].lower()
    ARCHIVES.mkdir(parents=True, exist_ok=True)
    current_month = datetime.now(timezone.utc).strftime("%Y-%m")

    urls = get_json(f"https://api.chess.com/pub/player/{username}/games/archives")["archives"]
    fetched = 0
    for url in urls:  # sequential on purpose: chess.com rate-limits parallel requests
        year, mon = url.rstrip("/").rsplit("/", 2)[-2:]
        month = f"{year}-{mon}"
        if not needs_fetch(month, current_month):
            continue
        raw = get_json(url)["games"]
        games = [g for g in (normalise(r, username) for r in raw) if g]
        games.sort(key=lambda g: g["end_time"])
        out = {"month": month, "complete": month < current_month, "games": games}
        (ARCHIVES / f"{month}.json").write_text(json.dumps(out, separators=(",", ":")))
        fetched += 1
        print(f"{month}: {len(games)} games")
        time.sleep(0.5)

    total = build_index(username)
    print(f"Fetched {fetched} month(s). Index holds {total} games.")


if __name__ == "__main__":
    sys.exit(main())
