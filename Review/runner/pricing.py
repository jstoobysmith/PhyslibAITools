"""physlibalpha-review pricing — notional API-equivalent cost of a subscription run.

The scoreboard's cost line is an *estimate*: a subscription run has no per-token bill, so we
impute one from token counts at the rate recorded in prices.json. Rates in that file are
operator-maintained and ship unset; an unpriced model records `cost_usd: null` and renders as
"unpriced", never as $0 and never at a guessed rate. Kiro exposes no per-turn token telemetry at
all, so its runs are recorded at $0 rather than assigned a fictional price.
"""

import hashlib
import json
from pathlib import Path

PRICES = Path(__file__).with_name("prices.json")


def load():
    return json.loads(PRICES.read_text())


def prices_sha():
    """Stamped on every archived run so its cost is auditable against the rates then in force."""
    return hashlib.sha256(PRICES.read_bytes()).hexdigest()[:16]


def rate(model):
    return (load().get("models") or {}).get(model)


def is_priced(model):
    r = rate(model)
    return bool(r) and r.get("input") is not None and r.get("output") is not None


def cost(model, usage):
    """(usd, estimated) — usd is None when the model is unpriced or usage is unavailable."""
    if not usage:
        return (0.0, False) if model and "kiro" in str(model) else (None, False)
    r = rate(model)
    if not r or r.get("input") is None or r.get("output") is None:
        return None, False
    per = lambda n, k: (n or 0) / 1_000_000 * (r.get(k) or 0)
    total = (per(usage.get("input"), "input") + per(usage.get("output"), "output")
             + per(usage.get("cache_read"), "cache_read")
             + per(usage.get("cache_write"), "cache_write"))
    return round(total, 6), True


def render(usd, estimated):
    if usd is None:
        return "unpriced"
    return f"${usd:.4f}" + (" (notional API-equivalent)" if estimated else "")
