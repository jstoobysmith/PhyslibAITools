# PhyslibAlpha Review

The review rubrics and the machinery that runs review for
[PhyslibAlpha](https://github.com/leanprover-community/physlib/tree/master/PhyslibAlpha), the
AI-welcome staging area downstream of [Physlib](https://github.com/leanprover-community/physlib).
Humans own these rubrics and the API maps; AIs author the code.

This is inspired by [TauCetiReview](https://github.com/TauCetiProject/TauCetiReview) with one substitution: **Tau Ceti's roadmap
repository is replaced by Physlib's API maps.**

## The API maps are the roadmap

Tau Ceti keeps a separate `TauCetiRoadmap` repo of human-written markdown specifying what should
be formalized, and its `scope` rubric checks that a PR advances a specific roadmap target.

Physlib already has that artifact: every API directory carries an `API-map.yaml` listing
`Requirements`, each marked `done: true` (formalized, with a `location` naming the declarations)
or `done: false` (planned, `location: N/A`). The API map guide is explicit that unformalized
requirements belong in the map so that _"the map doubles as the API's roadmap."_

So: **a `done: false` requirement is an open target**, and [`rubrics/scope.md`](rubrics/scope.md)
judges new material against it exactly as Tau Ceti's judges against a roadmap node. At the time
of writing the repository has 34 maps, 510 requirements, 375 done and **135 open targets**.

The other structural difference follows from PhyslibAlpha living _inside_ the Physlib repository
rather than in a repo of its own: there is no second checkout to make. The reviewer workspace's
`code/` already contains `Physlib/`, `QuantumInfo/`, `PhyslibAlpha/`, and every API map, so the
`reuse` rubric can grep the upstream library even when Mathlib was skipped.

## How review works

Reviewers run only after a PR's CI is green, so the mechanical layer — `lake build`, the
`sorry`/`axiom` bans, `lake exe lint_all`, `./scripts/lint-style.sh`, the PhyslibAlpha linters,
and `scripts/api_map_linter.py` — is already satisfied. Each PR is then judged by several
independent agents, one per angle, which post `approve` / `request_changes` / `block` verdicts
with evidence. Only the integrity angles may block. Rubrics run one at a time, and a `block`
halts the round: blocked code gets reworked or abandoned, so the remaining rubrics wait rather
than reviewing a commit that will not survive.

## Rubrics

Each agent's prompt is [`rubrics/_common.md`](rubrics/_common.md) followed by its angle file;
see [`rubrics/README.md`](rubrics/README.md) for the list and which angles can block.

The angles are Tau Ceti's, re-grounded in Physlib's own rules — `lemma` over `theorem`, no
`axiom`, no `sorry`, no `True`-valued statements, docstrings on every definition, proofs under
50 lines or split along the directions `AGENTS.md` names, Alpha mirroring Physlib's file
structure, and no lemma that is a trivial rewrite of an existing Mathlib or Physlib result.

## Reviewing it yourself

```bash
uvx --from ./Review physlibalpha-review 42
```

It defaults to a **dry run**: prints the scoreboard and each rubric's thread, posts nothing.
Add `--post` to publish, as you. See [REVIEWING.md](REVIEWING.md) for prerequisites and flags.

```bash
physlibalpha-review --doctor
```

## Costs

`physlibalpha-review-costs` reports the engine's review spend — tokens and imputed dollars, per
day, per PR, per model, and split by outcome — from the durable run archive.

**The rate table ships unset.** `runner/prices.json` has an entry for every dispatchable model
with `null` rates, because inventing a price is worse than reporting none: an unpriced model
records `cost_usd: null` and renders as `unpriced`, never as `$0` and never at a guessed rate.
Fill the rates in from the providers' current price lists before quoting a cost figure anywhere.
`tests/test_prices.py` enforces that every dispatchable model has an entry, not that the numbers
are right.

## Status

- `rubrics/` — the ten per-angle prompts plus the shared protocol.
- `runner/` — the review engine and the `physlibalpha-review` CLI.
- `runner/apimaps.py` — the roadmap layer: collects every `API-map.yaml` and renders the open
  targets into the reviewer workspace.
- `runner/costs.py` — the `physlibalpha-review-costs` analytics CLI.
- `tests/` — verdict-forgery, rubric-order, API-map, and price-coverage tests.

Not ported from TauCetiReview: the GitHub Actions workflows (Tau Ceti's caller disables metered
review generation anyway), the auto-merge integration, and the meta-review A/B judging that
lives in TauCetiData. `--shadow` and `--label` are here and archive their arms locally, so the
A/B data collection has somewhere to land when you want to build the judge on top.

## Provenance

Derived from [TauCetiReview](https://github.com/TauCetiProject/TauCetiReview) (Apache-2.0), with
attribution in [NOTICE](NOTICE). Concretely:

- `runner/verdict.py`, `runner/casefile.py`, `runner/ledger.py` are copied from it — the logic is
  unchanged; only docstrings, imports, and one `mkdir` differ. Each carries a change notice.
- `rubrics/_common.md` keeps its section skeleton and several paragraphs; `rubrics/scope.md` keeps
  its shape (fit → single topic → verdict) but is rewritten for API maps; `rubrics/README.md`
  keeps the table format.
- Everything else — the other nine rubrics, `cli.py`, `review.py`, `reviewers.py`, `workspace.py`,
  `apimaps.py`, `post.py`, `render.py`, `archive.py`, `pricing.py`, `costs.py`, and the tests —
  was written here against the behaviour Tau Ceti Review documents, not copied from its source.
  Those files are correspondingly much smaller than their upstream namesakes and certainly lack
  behaviour upstream has; `sweep.py`, `merge.py`, and the queue reservation are not ported at all.

Around 8% of the lines in this directory are identical to upstream, concentrated in those three
modules.

## Conventions this introduces

Two things Physlib does not have yet, adopted from Tau Ceti and required by `rubrics/scope.md`:

1. **An `API-map: <path>` line in the PR description**, or `API-map: none` for cross-cutting
   work. Attribution, not authorization — new material must still quote the requirement it
   advances. `runner/apimaps.py` parses it and the runner reports whether the claimed map exists.
2. **Agents do not write API maps.** If material is off-map but worthwhile, the scope rubric
   blocks and says a human must add the requirement first. This is the boundary the whole design
   rests on, and it mirrors Tau Ceti forbidding agents from opening roadmap PRs.

Adopt or drop either one; if you drop the claim line, `scope.md`'s "Claiming a requirement"
section should go with it.
