"""Rubric order and the halt-on-block rule."""
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from runner import review


def test_blocking_angles_run_first():
    first_four = review.ORDER[:4]
    assert set(first_four) == review.BLOCKING, \
        "block-capable angles must run first so a block halts the round early"


def test_every_rubric_has_a_file():
    d = review.rubrics_dir()
    for r in review.ORDER:
        assert (d / f"{r}.md").is_file(), f"missing rubric file for {r}"
    assert (d / "_common.md").is_file()


def test_commit_mode_skips_green_rubrics():
    state = {"scope": {"verdict": "approve", "approved_sha": "aaa"}}
    assert "scope" not in review.select(review.ORDER, state, "aaa", "commit")
    assert "scope" in review.select(review.ORDER, state, "bbb", "commit")
    assert "scope" in review.select(review.ORDER, state, "aaa", "manual")


def test_prompt_puts_the_marker_after_the_rubric(tmp_path):
    d = review.rubrics_dir()
    p = review.build_prompt("scope", d, "CONTEXT", "", "MARKER-XYZ")
    assert p.index("API-map fit") < p.index("MARKER-XYZ")
    assert "Physlib's API maps stand in" not in p  # the index is read from disk, not inlined
