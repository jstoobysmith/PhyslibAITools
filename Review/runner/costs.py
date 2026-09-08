"""physlibalpha-review-costs — what the review engine spent.

Reads the durable run archive and reports tokens and imputed dollars: per day, per PR, per
model, and split by verdict. Costs are recomputed from token counts at the rate in effect on
each run's date, and every run carries the `prices_sha` it was costed against, so a figure is
auditable rather than merely asserted. Unpriced models are counted and reported as unpriced —
never silently as $0.
"""

import argparse
import collections
import sys
from pathlib import Path

if __package__ in (None, ""):
    sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from runner import archive


def _fmt(usd):
    return "unpriced" if usd is None else f"${usd:8.4f}"


def main(argv=None):
    p = argparse.ArgumentParser(prog="physlibalpha-review-costs")
    p.add_argument("--store", help="archive root (default: the local store)")
    p.add_argument("--pr", type=int, help="restrict to one PR")
    p.add_argument("--by", choices=("day", "pr", "model", "rubric", "verdict"), default="day")
    p.add_argument("--json", action="store_true")
    a = p.parse_args(argv)

    runs = archive.read_all(a.store)
    if a.pr:
        runs = [r for r in runs if r.get("pr") == a.pr]
    if not runs:
        print("no archived runs")
        return 0

    key = {"day": lambda r: (r.get("at") or "")[:10],
           "pr": lambda r: f"#{r.get('pr')}",
           "model": lambda r: r.get("model") or "?",
           "rubric": lambda r: r.get("rubric") or "?",
           "verdict": lambda r: r.get("verdict") or "?"}[a.by]

    agg = collections.defaultdict(lambda: {"runs": 0, "usd": 0.0, "unpriced": 0,
                                           "in": 0, "out": 0, "secs": 0.0})
    for r in runs:
        g = agg[key(r)]
        g["runs"] += 1
        if r.get("cost_usd") is None:
            g["unpriced"] += 1
        else:
            g["usd"] += r["cost_usd"]
        u = r.get("usage") or {}
        g["in"] += u.get("input") or 0
        g["out"] += u.get("output") or 0
        g["secs"] += r.get("duration_s") or 0

    if a.json:
        import json
        print(json.dumps(agg, indent=2))
        return 0

    print(f"{a.by:<14} {'runs':>5} {'cost':>10} {'in tok':>10} {'out tok':>9} {'minutes':>8}")
    print("-" * 60)
    for k in sorted(agg):
        g = agg[k]
        cost = _fmt(g["usd"] if g["usd"] or not g["unpriced"] else None)
        note = f"  ({g['unpriced']} unpriced)" if g["unpriced"] else ""
        print(f"{k:<14} {g['runs']:>5} {cost:>10} {g['in']:>10} {g['out']:>9} "
              f"{g['secs']/60:>8.1f}{note}")
    shas = {r.get("prices_sha") for r in runs if r.get("prices_sha")}
    print(f"\nprice tables in play: {', '.join(sorted(shas)) or 'none recorded'}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
