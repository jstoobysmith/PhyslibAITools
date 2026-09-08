# Derived from Tau Ceti Review (https://github.com/TauCetiProject/TauCetiReview),
# Apache-2.0. Modified for PhyslibAlpha; see ../NOTICE.

"""physlibalpha-review ledger — the on-disk review state (ledger.json).

The ledger is one JSON file: {"days": {date: usd_spent}, "prs": {pr: {"rounds": [...],
"state": {rubric: case_file}, "scoreboard_comment_id": id}}}.
"""
import json


class Ledger:
    def __init__(self, path):
        self.path = path
        self.data = (json.loads(path.read_text()) if path.exists()
                     else {"days": {}, "prs": {}})

    def spent(self, day):
        """USD already spent today (across all PRs), the base for the daily-budget reservation."""
        return self.data["days"].get(day, 0.0)

    def set_spent(self, day, amount):
        self.data["days"][day] = round(amount, 6)

    def pr_state(self, pr):
        """The per-PR record, with its sub-structures defaulted."""
        ps = self.data["prs"].setdefault(str(pr), {})
        ps.setdefault("rounds", [])
        ps.setdefault("state", {})            # per-rubric case files
        ps.setdefault("scoreboard_comment_id", None)
        return ps

    def persist(self):
        self.path.parent.mkdir(parents=True, exist_ok=True)
        self.path.write_text(json.dumps(self.data, indent=2))
