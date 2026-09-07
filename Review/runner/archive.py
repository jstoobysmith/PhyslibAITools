"""physlibalpha-review archive — durable run records.

Every run writes a record to the local store. Archival is for analytics and provenance and is
deliberately NOT part of the merge gate: a posted review counts whether or not the record was
published anywhere. Records are the input to `physlibalpha-review-costs` and to any later A/B
comparison of rubric or model versions.
"""

import json
import os
import time
import uuid
from pathlib import Path

from runner import pricing


def store_root():
    return Path(os.environ.get("PHYSLIBALPHA_REVIEW_HOME")
                or Path.home() / ".local" / "share" / "physlibalpha-review")


def new_run_id():
    return uuid.uuid4().hex[:12]


def record(pr, head_sha, rubric, res, arm="production", rubrics_sha=None, repo=None):
    """One (pr, head, rubric) run, stamped with the price table it was costed against."""
    return {
        "run_id": res.get("run_id") or new_run_id(),
        "at": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
        "repo": repo, "pr": pr, "head_sha": head_sha, "rubric": rubric, "arm": arm,
        "provider": res.get("provider"), "model": res.get("model"),
        "duration_s": res.get("duration_s"), "usage": res.get("usage"),
        "cost_usd": res.get("cost_usd"), "cost_estimated": res.get("cost_estimated"),
        "verdict": (res.get("verdict_obj") or {}).get("verdict") or "error",
        "findings": len((res.get("verdict_obj") or {}).get("findings") or []),
        "clean_room": res.get("clean_room"),
        "prices_sha": pricing.prices_sha(),
        "rubrics_sha": rubrics_sha,
    }


def write(rec, root=None):
    root = Path(root or store_root()) / "runs" / str(rec["pr"])
    root.mkdir(parents=True, exist_ok=True)
    p = root / f"{rec['head_sha'][:12]}-{rec['rubric']}-{rec['run_id']}.json"
    p.write_text(json.dumps(rec, indent=2))
    return p


def read_all(root=None):
    root = Path(root or store_root()) / "runs"
    if not root.is_dir():
        return []
    out = []
    for p in sorted(root.rglob("*.json")):
        try:
            out.append(json.loads(p.read_text()))
        except Exception:
            continue
    return out
