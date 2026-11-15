"""More tests for pipeline/lichess.py: theme mapping, filtering, conversion, selection, IO, shipped data.

No network and no real .cache: download is tested with a fake `requests.get`, everything else
uses tmp_path. The shipped data/themed/*.json files are only read.
"""

import csv
import io
import json
import random
import re
import sys
import tomllib
from pathlib import Path

import chess
import pytest
import zstandard

REPO = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(REPO / "pipeline"))
import lichess  # noqa: E402

COLUMNS = ["PuzzleId", "FEN", "Moves", "Rating", "RatingDeviation", "Popularity", "NbPlays",
           "Themes", "GameUrl", "OpeningTags"]

# After 1.e4 e5 2.Nf3 it is Black's move: the opponent plays b8c6, the solver f1b5, reply a7a6.
BASE_FEN = "rnbqkbnr/pppp1ppp/8/4p3/4P3/5N2/PPPP1PPP/RNBQKB1R b KQkq - 1 2"
BASE_MOVES = "b8c6 f1b5 a7a6"
CFG = {"per_tag": 2, "min_popularity": 80, "min_plays": 500}


def mk(pid, plays=1000, themes="fork", rating=1000, pop=90, moves=BASE_MOVES, fen=BASE_FEN):
    return {"PuzzleId": pid, "FEN": fen, "Moves": moves, "Rating": str(rating), "RatingDeviation": "75",
            "Popularity": str(pop), "NbPlays": str(plays), "Themes": themes, "GameUrl": "", "OpeningTags": ""}


def ids(out, band, tag):
    return [p["id"] for p in out[band][tag]]


def write_csv_zst(path, row_dicts, header=True, newline="\n"):
    buf = io.StringIO(newline="")
    w = csv.DictWriter(buf, fieldnames=COLUMNS, lineterminator=newline)
    if header:
        w.writeheader()
    w.writerows(row_dicts)
    path.write_bytes(zstandard.ZstdCompressor().compress(buf.getvalue().encode("utf-8")))
    return path


# ---------------------------------------------------------------- theme -> tag mapping

def tags_for(theme_string):
    out = lichess.select([mk("x", themes=theme_string)], CFG, bands=[1000])
    return {t for t, ps in out[1000].items() if ps}


@pytest.mark.parametrize("theme,expected", [
    ("mateIn1", {"missed_mate"}),
    ("mateIn2", {"missed_mate"}),
    ("fork", {"missed_fork"}),
    ("defensiveMove", {"hung_piece"}),
    ("backRankMate", {"back_rank"}),
    ("endgame", {"endgame"}),
])
def test_each_theme_maps_to_its_tag(theme, expected):
    assert tags_for(theme) == expected


def test_hanging_piece_is_a_theme_of_two_tags_but_used_once():
    # hangingPiece is listed under both missed_capture and hung_piece; one puzzle is used for one tag only
    got = tags_for("hangingPiece")
    assert len(got) == 1 and got <= {"missed_capture", "hung_piece"}


@pytest.mark.parametrize("theme", ["opening", "middlegame", "pin", "skewer", "short", "mate", "sacrifice", ""])
def test_unmapped_themes_are_dropped(theme):
    assert tags_for(theme) == set()


def test_theme_matching_is_exact_whole_words():
    assert tags_for("forks") == set()
    assert tags_for("Fork") == set()
    assert tags_for("mateIn10") == set()


def test_puzzle_with_several_mapped_themes_goes_to_one_tag_and_is_not_duplicated():
    # fork + mateIn1 + endgame: three tags qualify, but a puzzle is used for at most one tag per band
    out = lichess.select([mk("multi", themes="endgame fork mateIn1 short")], CFG, bands=[1000])
    placed = [(t, p["id"]) for t, ps in out[1000].items() for p in ps]
    assert len(placed) == 1 and placed[0][1] == "multi"
    assert placed[0][0] in {"endgame", "missed_fork", "missed_mate"}


def test_multi_theme_puzzle_goes_to_the_tag_that_needs_it_more():
    # "fork endgame" would fit two tags; the fork tag has other candidates, endgame has only this one
    rows = [mk("m", 5000, "fork endgame"), mk("f1", 900, "fork"), mk("f2", 800, "fork")]
    out = lichess.select(rows, CFG, bands=[1000])
    assert ids(out, 1000, "endgame") == ["m"]
    assert ids(out, 1000, "missed_fork") == ["f1", "f2"]


def test_shipped_tag_names_match_the_site():
    js = (REPO / "site" / "js" / "core" / "themes.js").read_text()
    m = re.search(r"export const TAGS = \[(.*?)\]", js)
    site_tags = re.findall(r'"([a-z_]+)"', m.group(1))
    assert sorted(site_tags) == sorted(lichess.TAG_THEMES)


# ---------------------------------------------------------------- row filtering

def test_min_popularity_and_plays_are_inclusive_thresholds():
    rows = [mk("pop80", pop=80), mk("pop79", pop=79), mk("pl500", plays=500), mk("pl499", plays=499)]
    out = lichess.select(rows, {"per_tag": 10, "min_popularity": 80, "min_plays": 500}, bands=[1000])
    assert sorted(ids(out, 1000, "missed_fork")) == ["pl500", "pop80"]


def test_thresholds_come_from_config():
    rows = [mk("a", plays=50, pop=10), mk("b", plays=49, pop=10), mk("c", plays=50, pop=9)]
    out = lichess.select(rows, {"per_tag": 10, "min_popularity": 10, "min_plays": 50}, bands=[1000])
    assert ids(out, 1000, "missed_fork") == ["a"]


def test_negative_popularity_is_below_the_floor():
    # Lichess popularity runs -100..100
    out = lichess.select([mk("neg", pop=-50)], CFG, bands=[1000])
    assert ids(out, 1000, "missed_fork") == []


@pytest.mark.parametrize("rating,band", [
    (599, None), (600, 600), (799, 600), (800, 800), (999, 800), (1000, 1000), (1799, 1600),
    (1800, 1800), (1999, 1800), (2000, None), (3000, None), (0, None), (-100, None),
])
def test_band_boundaries(rating, band):
    assert lichess.band_of(mk("x", rating=rating)) == band
    assert lichess.qualifies(mk("x", rating=rating), CFG) == band


@pytest.mark.parametrize("rating", [599, 2000, "abc", "", "1000.5"])
def test_select_ignores_ratings_outside_bands_or_unparseable(rating):
    out = lichess.select([mk("x", rating=rating)], CFG)
    assert all(not ps for by_tag in out.values() for ps in by_tag.values())


def test_non_numeric_popularity_or_plays_do_not_qualify():
    assert lichess.qualifies({**mk("x"), "Popularity": "n/a"}, CFG) is None
    assert lichess.qualifies({**mk("x"), "NbPlays": ""}, CFG) is None
    row = mk("x")
    del row["NbPlays"]
    assert lichess.qualifies(row, CFG) is None


def test_row_with_no_moves_or_single_move_is_never_emitted():
    rows = [mk("empty", moves=""), mk("one", moves="b8c6"), mk("ok", 100000)]
    out = lichess.select(rows, CFG, bands=[1000])
    assert ids(out, 1000, "missed_fork") == ["ok"]


def test_row_with_illegal_moves_is_not_emitted_and_does_not_block_later_ones():
    rows = [mk("badfirst", 9000, moves="a7a3 f1b5"), mk("badlater", 8000, moves="b8c6 f1b5 a7a7"),
            mk("badfen", 7000, fen="not a fen"), mk("good", 600)]
    out = lichess.select(rows, CFG, bands=[1000])
    assert ids(out, 1000, "missed_fork") == ["good"]


def test_row_to_puzzle_handles_garbage_values():
    assert lichess.row_to_puzzle(mk("x", moves="   "), "t") is None
    assert lichess.row_to_puzzle(mk("x", moves="b8c6 zz"), "t") is None
    assert lichess.row_to_puzzle(mk("x", fen=""), "t") is None
    assert lichess.row_to_puzzle(mk("x", rating="1e3"), "t") is None


def test_header_row_is_not_data(tmp_path):
    path = write_csv_zst(tmp_path / "db.csv.zst", [mk("only", 900)])
    got = list(lichess.rows(path))
    assert [r["PuzzleId"] for r in got] == ["only"]
    assert list(got[0]) == COLUMNS


def test_stray_header_line_inside_the_data_is_skipped(tmp_path):
    stray = dict(zip(COLUMNS, COLUMNS))
    path = write_csv_zst(tmp_path / "db.csv.zst", [mk("a", 900), stray, mk("b", 800)])
    out = lichess.select(lichess.rows(path), CFG, bands=[1000])
    assert ids(out, 1000, "missed_fork") == ["a", "b"]


def test_truncated_csv_row_is_skipped_not_fatal(tmp_path):
    # a short line yields None for the missing columns (csv.DictReader); the pipeline should skip it
    text = ",".join(COLUMNS) + "\n" + "short,FENONLY,b8c6\n" + ",".join(
        [mk("good")[c] for c in COLUMNS]) + "\n"
    path = tmp_path / "db.csv.zst"
    path.write_bytes(zstandard.ZstdCompressor().compress(text.encode()))
    out = lichess.select(lichess.rows(path), CFG, bands=[1000])
    assert ids(out, 1000, "missed_fork") == ["good"]


def test_truncated_row_missing_only_themes_or_moves(tmp_path):
    full = [mk("full")[c] for c in COLUMNS]
    text = "\n".join([
        ",".join(COLUMNS),
        ",".join(full[:7]),  # ends before Themes
        ",".join(full[:2]),  # ends before Moves
        ",".join(full),
    ]) + "\n"
    path = tmp_path / "db.csv.zst"
    path.write_bytes(zstandard.ZstdCompressor().compress(text.encode()))
    out = lichess.select(lichess.rows(path), CFG, bands=[1000])
    assert ids(out, 1000, "missed_fork") == ["full"]


# ---------------------------------------------------------------- conversion

def test_stored_fen_is_after_the_opponents_move_and_solver_to_move():
    row = mk("c1")
    p = lichess.row_to_puzzle(row, "missed_fork")
    before = chess.Board(BASE_FEN)
    assert before.turn == chess.BLACK  # the opponent moves first in the database
    assert p["fen"] == "r1bqkbnr/pppp1ppp/2n5/4p3/4P3/5N2/PPPP1PPP/RNBQKB1R w KQkq - 2 3"
    after = chess.Board(p["fen"])
    assert after.turn == chess.WHITE  # the solver
    assert p["last_uci"] == "b8c6"
    assert p["solution"] == ["f1b5", "a7a6"]
    assert chess.Move.from_uci(p["solution"][0]) in after.legal_moves
    # replaying the whole thing from the database fen gives the same position
    replay = chess.Board(BASE_FEN)
    replay.push_uci(p["last_uci"])
    assert replay.fen() == p["fen"]


def test_output_fields_and_types():
    p = lichess.row_to_puzzle(mk("zz9", rating=1234, themes="fork endgame short"), "missed_fork")
    assert set(p) == {"id", "tag", "fen", "last_uci", "solution", "rating", "themes"}
    assert p["id"] == "zz9" and p["tag"] == "missed_fork" and p["rating"] == 1234
    assert p["themes"] == ["fork", "endgame", "short"]
    assert isinstance(p["rating"], int)


def test_promotion_uci_survives_unchanged():
    fen = "7k/P7/8/8/8/2K5/8/7r b - - 0 1"
    for promo in ("a7a8q", "a7a8n", "a7a8r", "a7a8b"):
        p = lichess.row_to_puzzle(mk("pr", fen=fen, moves=f"h1h2 {promo}"), "t")
        assert p is not None
        assert p["fen"] == "7k/P7/8/8/8/2K5/7r/8 w - - 1 2"
        assert p["solution"] == [promo]
        assert chess.Move.from_uci(promo) in chess.Board(p["fen"]).legal_moves


def test_promotion_without_piece_letter_is_not_a_legal_move():
    fen = "7k/P7/8/8/8/2K5/8/7r b - - 0 1"
    assert lichess.row_to_puzzle(mk("pr", fen=fen, moves="h1h2 a7a8 h2h3"), "t") is None


def test_castling_uci_survives_unchanged():
    fen = "r3k2r/8/8/8/8/8/8/R3K2R w KQkq - 0 1"
    # the opponent (White) castles short, the solver (Black) castles long
    p = lichess.row_to_puzzle(mk("ca", fen=fen, moves="e1g1 e8c8"), "t")
    assert p["last_uci"] == "e1g1"
    assert p["solution"] == ["e8c8"]
    assert p["fen"] == "r3k2r/8/8/8/8/8/8/R4RK1 b kq - 1 1"
    assert chess.Move.from_uci("e8c8") in chess.Board(p["fen"]).legal_moves


def test_castling_not_allowed_when_rights_gone_is_rejected():
    fen = "r3k2r/8/8/8/8/8/8/R3K2R w - - 0 1"
    assert lichess.row_to_puzzle(mk("ca", fen=fen, moves="e1g1 e8c8"), "t") is None


def test_en_passant_in_solution():
    # White pawn e5, Black pawn d7: the opponent (Black) plays d7d5, the solver captures e5d6 en passant
    fen = "4k3/3p4/8/4P3/8/8/8/4K3 b - - 0 1"
    p = lichess.row_to_puzzle(mk("ep", fen=fen, moves="d7d5 e5d6"), "t")
    assert p["fen"] == "4k3/8/8/3pP3/8/8/8/4K3 w - d6 0 2"
    assert p["solution"] == ["e5d6"]


def test_long_solution_is_kept_in_full_and_in_order():
    moves = "b8c6 f1b5 a7a6 b5a4 g8f6 e1g1"
    p = lichess.row_to_puzzle(mk("long", moves=moves), "t")
    assert p["solution"] == ["f1b5", "a7a6", "b5a4", "g8f6", "e1g1"]


def test_extra_whitespace_in_moves_is_tolerated():
    p = lichess.row_to_puzzle(mk("ws", moves="  b8c6   f1b5\ta7a6 "), "t")
    assert p["solution"] == ["f1b5", "a7a6"]


def test_row_to_puzzle_does_not_mutate_input():
    row = mk("m")
    snapshot = dict(row)
    lichess.row_to_puzzle(row, "t")
    assert row == snapshot


# ---------------------------------------------------------------- selection

def test_select_returns_every_band_and_tag_even_when_empty():
    out = lichess.select([], CFG)
    assert list(out) == list(range(600, 2000, 200))
    assert all(set(by_tag) == set(lichess.TAG_THEMES) and all(v == [] for v in by_tag.values())
               for by_tag in out.values())


def test_puzzles_land_in_their_rating_band_only():
    rows = [mk("lo", 900, rating=600), mk("lo2", 900, rating=799), mk("mid", 900, rating=800),
            mk("top", 900, rating=1999), mk("out", 900, rating=2000), mk("under", 900, rating=599)]
    out = lichess.select(rows, CFG)
    assert ids(out, 600, "missed_fork") == ["lo", "lo2"] or ids(out, 600, "missed_fork") == ["lo2", "lo"]
    assert ids(out, 800, "missed_fork") == ["mid"]
    assert ids(out, 1800, "missed_fork") == ["top"]
    everything = [p["id"] for by_tag in out.values() for ps in by_tag.values() for p in ps]
    assert "out" not in everything and "under" not in everything


def test_per_tag_cap_and_most_played_first():
    rows = [mk(f"f{i}", plays) for i, plays in enumerate([600, 900, 700, 1000, 800])]
    out = lichess.select(rows, {**CFG, "per_tag": 3}, bands=[1000])
    assert ids(out, 1000, "missed_fork") == ["f3", "f1", "f4"]  # 1000, 900, 800


def test_fewer_candidates_than_per_tag_gives_a_short_list():
    out = lichess.select([mk("a", 700), mk("b", 800)], {**CFG, "per_tag": 5}, bands=[1000])
    assert ids(out, 1000, "missed_fork") == ["b", "a"]


def test_per_tag_larger_than_internal_heap_still_correct_when_pool_is_large():
    # more candidates than the internal buffer (per_tag * number of tags): the top ones survive eviction
    rows = [mk(f"p{i:03d}", 1000 + i) for i in range(100)]
    out = lichess.select(rows, {**CFG, "per_tag": 3}, bands=[1000])
    assert ids(out, 1000, "missed_fork") == ["p099", "p098", "p097"]
    out = lichess.select(list(reversed(rows)), {**CFG, "per_tag": 3}, bands=[1000])
    assert ids(out, 1000, "missed_fork") == ["p099", "p098", "p097"]


def test_overlap_between_tags_is_filled_from_deeper_candidates():
    # hangingPiece feeds missed_capture and hung_piece; defensiveMove only hung_piece.
    rows = [mk(f"h{i}", 5000 - 1000 * i, "hangingPiece") for i in range(5)] + [mk("d", 600, "defensiveMove")]
    out = lichess.select(rows, CFG, bands=[1000])
    assert ids(out, 1000, "missed_capture") == ["h0", "h1"]
    assert ids(out, 1000, "hung_piece") == ["h2", "h3"]
    used = [p["id"] for ps in out[1000].values() for p in ps]
    assert len(used) == len(set(used))


def test_invalid_top_puzzle_is_replaced_by_the_next_candidate():
    rows = [mk("bad", 9000, moves="b8c6 f1f7"), mk("g1", 800), mk("g2", 700), mk("g3", 600)]
    out = lichess.select(rows, CFG, bands=[1000])
    assert ids(out, 1000, "missed_fork") == ["g1", "g2"]


def test_same_puzzle_listed_twice_is_emitted_once():
    rows = [mk("dup", 900), mk("dup", 900), mk("other", 800)]
    out = lichess.select(rows, CFG, bands=[1000])
    assert ids(out, 1000, "missed_fork") == ["dup", "other"]


def test_same_puzzle_id_with_different_plays_is_emitted_once():
    rows = [mk("dup", 900), mk("dup", 950), mk("other", 800)]
    out = lichess.select(rows, CFG, bands=[1000])
    got = ids(out, 1000, "missed_fork")
    assert got.count("dup") == 1 and "other" in got


def test_ties_are_broken_deterministically_regardless_of_input_order():
    base = [mk(f"t{i}", 1000, "fork") for i in range(8)] + [mk(f"e{i}", 1000, "endgame fork") for i in range(5)]
    cfg = {**CFG, "per_tag": 3}
    reference = json.dumps(lichess.select(base, cfg, bands=[1000]), sort_keys=False)
    rng = random.Random(7)
    for _ in range(20):
        shuffled = base[:]
        rng.shuffle(shuffled)
        assert json.dumps(lichess.select(shuffled, cfg, bands=[1000])) == reference


def test_ties_at_the_heap_boundary_are_deterministic():
    # many equal-plays puzzles competing for the last places; also across a mix of plays
    rows = [mk(f"z{i:02d}", 1000 if i % 3 else 2000) for i in range(60)]
    cfg = {**CFG, "per_tag": 4}
    reference = json.dumps(lichess.select(rows, cfg, bands=[1000]))
    rng = random.Random(11)
    for _ in range(20):
        rng.shuffle(rows)
        assert json.dumps(lichess.select(rows, cfg, bands=[1000])) == reference


def test_select_works_with_a_one_shot_generator():
    gen = (r for r in [mk("a", 700), mk("b", 800)])
    out = lichess.select(gen, CFG, bands=[1000])
    assert ids(out, 1000, "missed_fork") == ["b", "a"]


def test_select_output_puzzles_have_their_tag_and_a_band_rating():
    rows = [mk("a", 900, "mateIn1", 1210), mk("b", 800, "endgame", 1399), mk("c", 700, "backRankMate", 1200)]
    out = lichess.select(rows, CFG, bands=[1200])
    for tag, puzzles in out[1200].items():
        for p in puzzles:
            assert p["tag"] == tag and 1200 <= p["rating"] < 1400


# ---------------------------------------------------------------- streaming / IO

def test_rows_reads_a_zstd_csv(tmp_path):
    src = [mk("a", 900, "fork", 1000), mk("b", 700, "endgame short", 1500)]
    src[0]["OpeningTags"] = "Sicilian_Defense, Najdorf"  # a quoted comma
    path = write_csv_zst(tmp_path / "db.csv.zst", src)
    got = list(lichess.rows(path))
    assert got == src


def test_rows_handles_crlf_and_unicode(tmp_path):
    src = [mk("a", 900)]
    src[0]["GameUrl"] = "https://lichess.org/é中"
    path = write_csv_zst(tmp_path / "db.csv.zst", src, newline="\r\n")
    assert list(lichess.rows(path)) == src


def test_rows_is_a_lazy_generator(tmp_path):
    path = write_csv_zst(tmp_path / "db.csv.zst", [mk("a"), mk("b")])
    it = lichess.rows(path)
    assert iter(it) is it
    assert next(it)["PuzzleId"] == "a"


def test_rows_on_larger_file_streams_through_select(tmp_path):
    src = [mk(f"r{i:04d}", 1000 + i, "fork", 600 + (i % 1400)) for i in range(3000)]
    path = write_csv_zst(tmp_path / "db.csv.zst", src)
    out = lichess.select(lichess.rows(path), {**CFG, "per_tag": 2})
    # the best two of each band by plays: highest i with rating in that band
    for band in lichess.BANDS:
        in_band = [r for r in src if band <= int(r["Rating"]) < band + 200]
        want = [r["PuzzleId"] for r in sorted(in_band, key=lambda r: -int(r["NbPlays"]))[:2]]
        assert ids(out, band, "missed_fork") == want


def test_rows_on_empty_or_header_only_file(tmp_path):
    path = write_csv_zst(tmp_path / "db.csv.zst", [])
    assert list(lichess.rows(path)) == []
    path.write_bytes(zstandard.ZstdCompressor().compress(b""))
    assert list(lichess.rows(path)) == []


def test_rows_on_non_zstd_file_raises(tmp_path):
    path = tmp_path / "bad.zst"
    path.write_bytes(b"PuzzleId,FEN\nplain,text\n")
    with pytest.raises(zstandard.ZstdError):
        list(lichess.rows(path))


@pytest.fixture
def sandbox(tmp_path, monkeypatch):
    """A fake repo root for main(): config, output dir and a compressed db, nothing real touched."""
    (tmp_path / "pipeline").mkdir()
    (tmp_path / "pipeline" / "config.toml").write_text(
        "[themed]\nper_tag = 2\nmin_popularity = 80\nmin_plays = 500\n")
    out = tmp_path / "data" / "themed"
    db = tmp_path / "db.csv.zst"
    real_rows = lichess.rows
    monkeypatch.setattr(lichess, "ROOT", tmp_path)
    monkeypatch.setattr(lichess, "OUT", out)
    monkeypatch.setattr(lichess, "download", lambda *a, **k: None)
    monkeypatch.setattr(lichess, "rows", lambda: real_rows(db))
    return tmp_path, out, db


def test_main_writes_one_json_per_band_with_the_documented_shape(sandbox, capsys):
    root, out, db = sandbox
    src = [mk("m1", 900, "mateIn1", 650), mk("f1", 800, "fork", 1250), mk("e1", 700, "endgame", 1850),
           mk("e2", 750, "endgame", 1850), mk("x", 900, "fork", 2100)]
    write_csv_zst(db, src)
    assert lichess.main() is None
    assert sorted(p.stem for p in out.glob("*.json")) == sorted(str(b) for b in range(600, 2000, 200))
    d1200 = json.loads((out / "1200.json").read_text())
    assert list(d1200) == ["source", "band", "puzzles"]
    assert d1200["source"] == "Lichess puzzle database (CC0)" and d1200["band"] == 1200
    assert list(d1200["puzzles"]) == list(lichess.TAG_THEMES)
    assert [p["id"] for p in d1200["puzzles"]["missed_fork"]] == ["f1"]
    d1800 = json.loads((out / "1800.json").read_text())
    assert [p["id"] for p in d1800["puzzles"]["endgame"]] == ["e2", "e1"]
    d600 = json.loads((out / "600.json").read_text())
    assert [p["id"] for p in d600["puzzles"]["missed_mate"]] == ["m1"]
    empty = json.loads((out / "1000.json").read_text())
    assert empty["puzzles"] == {t: [] for t in lichess.TAG_THEMES}
    assert "1200.json" in capsys.readouterr().out


def test_main_output_matches_what_the_site_reads(sandbox):
    # site/js/core/data.js uses pool.source, pool.band, pool.puzzles; themed.js uses puzzles[tag][i].tag
    # and train.js uses id, fen, last_uci, solution (array of uci), tag, rating
    root, out, db = sandbox
    write_csv_zst(db, [mk("f1", 800, "fork", 1250)])
    lichess.main()
    pool = json.loads((out / "1200.json").read_text())
    (p,) = pool["puzzles"]["missed_fork"]
    assert set(p) == {"id", "tag", "fen", "last_uci", "solution", "rating", "themes"}
    assert isinstance(p["solution"], list) and all(isinstance(m, str) for m in p["solution"])
    assert isinstance(p["rating"], int) and isinstance(p["themes"], list)
    assert re.fullmatch(r"[a-h][1-8][a-h][1-8][qrbn]?", p["last_uci"])
    shipped = json.loads((REPO / "data" / "themed" / "1000.json").read_text())
    sample = next(ps[0] for ps in shipped["puzzles"].values() if ps)
    assert set(sample) == set(p)
    assert list(shipped) == list(pool)


def test_main_is_byte_identical_on_shuffled_input(sandbox):
    root, out, db = sandbox
    src = [mk(f"t{i:02d}", 1000 + (i % 3) * 10, ("fork", "endgame fork", "hangingPiece", "mateIn2")[i % 4],
              rating=600 + 37 * i % 1400) for i in range(80)]
    write_csv_zst(db, src)
    lichess.main()
    first = {p.name: p.read_bytes() for p in out.glob("*.json")}
    for seed in (1, 2, 3):
        random.Random(seed).shuffle(src)
        write_csv_zst(db, src)
        lichess.main()
        assert {p.name: p.read_bytes() for p in out.glob("*.json")} == first


def test_main_json_is_compact_and_utf8(sandbox):
    root, out, db = sandbox
    write_csv_zst(db, [mk("f1", 800, "fork", 1250)])
    lichess.main()
    text = (out / "1200.json").read_text()
    assert ": " not in text and ", " not in text and "\n" not in text


def test_main_overwrites_stale_band_files(sandbox):
    root, out, db = sandbox
    out.mkdir(parents=True)
    (out / "1200.json").write_text('{"stale": true}')
    write_csv_zst(db, [mk("f1", 800, "fork", 1250)])
    lichess.main()
    assert json.loads((out / "1200.json").read_text())["band"] == 1200


def test_main_reads_settings_from_config_toml(sandbox):
    root, out, db = sandbox
    (root / "pipeline" / "config.toml").write_text(
        "[themed]\nper_tag = 1\nmin_popularity = 95\nmin_plays = 1000\n")
    write_csv_zst(db, [mk("a", 2000, "fork", 1250, pop=95), mk("b", 1500, "fork", 1250, pop=95),
                       mk("c", 3000, "fork", 1250, pop=94), mk("d", 999, "fork", 1250, pop=99)])
    lichess.main()
    assert [p["id"] for p in json.loads((out / "1200.json").read_text())["puzzles"]["missed_fork"]] == ["a"]


def test_shipped_config_has_the_keys_the_script_reads():
    cfg = tomllib.loads((REPO / "pipeline" / "config.toml").read_text())["themed"]
    for key in ("per_tag", "min_popularity", "min_plays"):
        assert isinstance(cfg[key], int) and not isinstance(cfg[key], bool)
    assert cfg["per_tag"] > 0 and cfg["min_plays"] >= 0


def test_main_without_a_config_key_fails_loudly(sandbox):
    # there are no built-in defaults: a missing setting is an error rather than a silent default
    root, out, db = sandbox
    (root / "pipeline" / "config.toml").write_text("[themed]\nper_tag = 2\n")
    write_csv_zst(db, [mk("a")])
    with pytest.raises(KeyError):
        lichess.main()


# ---------------------------------------------------------------- download

class FakeResponse:
    def __init__(self, chunks, status_error=None, fail_after=None):
        self.chunks, self.status_error, self.fail_after = chunks, status_error, fail_after

    def __enter__(self):
        return self

    def __exit__(self, *exc):
        return False

    def raise_for_status(self):
        if self.status_error:
            raise self.status_error

    def iter_content(self, size):
        for i, chunk in enumerate(self.chunks):
            if self.fail_after is not None and i >= self.fail_after:
                raise ConnectionError("connection dropped")
            yield chunk


@pytest.fixture
def fake_get(monkeypatch):
    calls = []

    def install(response):
        def get(url, **kw):
            calls.append((url, kw))
            return response
        monkeypatch.setattr(lichess.requests, "get", get)
        return calls
    return install


def test_download_skips_when_cache_exists(tmp_path, monkeypatch):
    path = tmp_path / "c" / "db.zst"
    path.parent.mkdir()
    path.write_bytes(b"cached")

    def boom(*a, **k):
        raise AssertionError("network used")
    monkeypatch.setattr(lichess.requests, "get", boom)
    lichess.download(path)
    assert path.read_bytes() == b"cached"


def test_download_writes_file_and_creates_parent_dirs(tmp_path, fake_get):
    path = tmp_path / "a" / "b" / "db.zst"
    calls = fake_get(FakeResponse([b"abc", b"def"]))
    lichess.download(path)
    assert path.read_bytes() == b"abcdef"
    assert not path.with_suffix(".zst.part").exists()
    (url, kw), = calls
    assert url == lichess.URL and kw["stream"] is True and kw["headers"]["User-Agent"]
    assert kw["timeout"]


def test_interrupted_download_leaves_no_final_file_so_it_is_retried(tmp_path, fake_get):
    path = tmp_path / "db.zst"
    fake_get(FakeResponse([b"abc", b"def", b"ghi"], fail_after=2))
    with pytest.raises(ConnectionError):
        lichess.download(path)
    # it writes to a .part file and renames at the end, so a half-download is never mistaken for the cache
    assert not path.exists()
    assert path.with_suffix(".zst.part").read_bytes() == b"abcdef"
    # the next run starts over (the stale .part is overwritten) and completes
    fake_get(FakeResponse([b"X", b"Y"]))
    lichess.download(path)
    assert path.read_bytes() == b"XY"
    assert not path.with_suffix(".zst.part").exists()


def test_http_error_leaves_nothing_behind(tmp_path, fake_get):
    import requests
    path = tmp_path / "db.zst"
    fake_get(FakeResponse([b"x"], status_error=requests.HTTPError("503")))
    with pytest.raises(requests.HTTPError):
        lichess.download(path)
    assert list(tmp_path.iterdir()) == []


def test_default_cache_path_is_inside_the_repo_cache_dir():
    assert lichess.CACHE == REPO / ".cache" / "lichess_db_puzzle.csv.zst"
    assert lichess.OUT == REPO / "data" / "themed"
    assert list(lichess.BANDS) == [600, 800, 1000, 1200, 1400, 1600, 1800]


# ---------------------------------------------------------------- shipped data (read-only)

SHIPPED = sorted((REPO / "data" / "themed").glob("*.json"))
PER_TAG = tomllib.loads((REPO / "pipeline" / "config.toml").read_text())["themed"]["per_tag"]
UCI_RE = re.compile(r"^[a-h][1-8][a-h][1-8][qrbn]?$")


def test_every_band_has_a_shipped_file():
    assert sorted(p.stem for p in SHIPPED) == sorted(str(b) for b in lichess.BANDS)


@pytest.mark.parametrize("path", SHIPPED, ids=lambda p: p.name)
def test_shipped_band_file_is_consistent(path):
    data = json.loads(path.read_text())
    band = int(path.stem)
    assert data["band"] == band and data["source"] == lichess.SOURCE
    assert set(data["puzzles"]) == set(lichess.TAG_THEMES)
    seen_in_band = {}
    problems = []
    for tag, plist in data["puzzles"].items():
        assert len(plist) <= PER_TAG, f"{path.name}/{tag}: {len(plist)} > per_tag {PER_TAG}"
        assert len({p["id"] for p in plist}) == len(plist), f"{path.name}/{tag}: duplicate ids"
        for p in plist:
            where = f"{path.name}/{tag}/{p['id']}"
            if set(p) != {"id", "tag", "fen", "last_uci", "solution", "rating", "themes"}:
                problems.append(f"{where}: keys {sorted(p)}")
                continue
            if p["tag"] != tag:
                problems.append(f"{where}: tag {p['tag']}")
            if not (band <= p["rating"] < band + 200):
                problems.append(f"{where}: rating {p['rating']}")
            if not set(p["themes"]) & set(lichess.TAG_THEMES[tag]):
                problems.append(f"{where}: themes {p['themes']} do not include any of {lichess.TAG_THEMES[tag]}")
            if p["id"] in seen_in_band:
                problems.append(f"{where}: also under {seen_in_band[p['id']]}")
            seen_in_band[p["id"]] = tag
            board = chess.Board(p["fen"])
            if not board.is_valid():
                problems.append(f"{where}: invalid position")
            if not p["solution"] or not all(UCI_RE.match(m) for m in p["solution"]) or not UCI_RE.match(p["last_uci"]):
                problems.append(f"{where}: malformed uci")
                continue
            # the opponent's move has just been played: its piece is on the destination square
            dest = chess.Move.from_uci(p["last_uci"]).to_square
            piece = board.piece_at(dest)
            if piece is None or piece.color == board.turn:
                problems.append(f"{where}: last_uci {p['last_uci']} not by the side that just moved")
            for uci in p["solution"]:
                move = chess.Move.from_uci(uci)
                if move not in board.legal_moves:
                    problems.append(f"{where}: illegal solution move {uci}")
                    break
                board.push(move)
    assert not problems, f"{len(problems)} problems:\n" + "\n".join(problems[:20])


def test_shipped_lists_are_reasonably_full():
    short = {f"{p.name}/{t}": len(v) for p in SHIPPED for t, v in json.loads(p.read_text())["puzzles"].items()
             if len(v) == 0}
    assert not short, f"empty tag lists: {short}"


def test_row_to_puzzle_with_none_fields_from_a_short_csv_line():
    assert lichess.row_to_puzzle({**mk("x"), "Moves": None}, "t") is None


def test_truncated_row_missing_popularity_and_plays_is_skipped(tmp_path):
    full = [mk("full")[c] for c in COLUMNS]
    text = ",".join(COLUMNS) + "\n" + ",".join(full[:5]) + "\n" + ",".join(full) + "\n"
    path = tmp_path / "db.csv.zst"
    path.write_bytes(zstandard.ZstdCompressor().compress(text.encode()))
    out = lichess.select(lichess.rows(path), CFG, bands=[1000])
    assert ids(out, 1000, "missed_fork") == ["full"]
