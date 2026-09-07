"""Every dispatchable model must have an entry in prices.json.

This enforces coverage, not correctness: the rates themselves are operator-maintained and are
not checked against any provider here. A model with a null rate is dispatchable and its runs are
recorded as unpriced; a model with no entry at all is a packaging bug.
"""
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from runner import pricing, reviewers


def test_every_dispatchable_model_is_listed():
    listed = set((pricing.load().get("models") or {}))
    for provider, spec in reviewers.PROVIDERS.items():
        assert spec["model"] in listed, f"{provider}'s default model {spec['model']} is unpriced"


def test_unpriced_model_costs_none_not_zero():
    usd, est = pricing.cost("claude-opus-5", {"input": 1000, "output": 100})
    assert usd is None or est, "an unpriced model must not report a fabricated cost"
