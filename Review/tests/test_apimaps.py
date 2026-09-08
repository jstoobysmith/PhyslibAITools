"""The API maps are the roadmap layer: open requirements are the targets."""
import sys
import textwrap
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from runner import apimaps

MAP = textwrap.dedent("""
    version: v0.1
    Title: Time
    Overview: |
        The time API.
    ParentAPIs:
      - "Space (Physlib/SpaceAndTime/Space)"
    References: []
    Requirements:
      - description: "The key data structure `Time` is defined."
        done: true
        location: "Physlib/SpaceAndTime/Time/Basic.lean (Time)"
      - description: "The API shall contain the time-translation action."
        done: false
        location: N/A
""")


def _repo(tmp_path):
    d = tmp_path / "Physlib" / "SpaceAndTime" / "Time"
    d.mkdir(parents=True)
    (d / "API-map.yaml").write_text(MAP)
    return tmp_path


def test_open_requirements_are_targets(tmp_path):
    maps = apimaps.summarize(_repo(tmp_path))
    (rel, m), = maps.items()
    assert rel == "Physlib/SpaceAndTime/Time/API-map.yaml"
    assert m["done"] == 1 and m["total"] == 2
    assert m["open"] == ["The API shall contain the time-translation action."]


def test_index_names_the_open_target(tmp_path):
    maps = apimaps.summarize(_repo(tmp_path))
    idx = apimaps.render_index(maps)
    assert "time-translation action" in idx
    assert "1 open" in idx


def test_claim_line(tmp_path):
    repo = _repo(tmp_path)
    body = "Adds the action.\n\nAPI-map: Physlib/SpaceAndTime/Time/API-map.yaml\n"
    claim = apimaps.claimed_map(body)
    assert claim == "Physlib/SpaceAndTime/Time/API-map.yaml"
    assert apimaps.claim_status(repo, claim)[0] == "found"
    assert apimaps.claim_status(repo, "none")[0] == "none"
    assert apimaps.claim_status(repo, None)[0] == "absent"
    assert apimaps.claim_status(repo, "Physlib/Nope/API-map.yaml")[0] == "missing"


def test_broken_map_is_reported_not_raised(tmp_path):
    d = tmp_path / "Physlib" / "Bad"
    d.mkdir(parents=True)
    (d / "API-map.yaml").write_text("Requirements: [oops\n")
    maps = apimaps.summarize(tmp_path)
    assert list(maps.values())[0]["error"]
