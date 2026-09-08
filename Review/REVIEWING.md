# Reviewing a PR yourself

`physlibalpha-review` runs the PhyslibAlpha review on your **own Claude / Codex / Kiro
subscription**: the inference runs through the locally logged-in provider CLI, so there is no
per-token bill. Same engine, same rubrics, same scoreboard and per-rubric threads.

This is for people the project already trusts. The tool is read-only and posts under *your*
GitHub identity, but nothing stops a reviewer from rubber-stamping — the safeguard is social,
not technical. See [SECURITY.md](SECURITY.md).

## Prerequisites

On your `PATH`, all logged in:

- `git`
- [`gh`](https://cli.github.com/) — `gh auth login`. This identity reads the PR and posts the review.
- `claude` signed into a Claude subscription, and/or `codex` signed into a ChatGPT subscription.
  You need **at least one**; each rubric is judged by whichever you have, drawn per rubric.
- For explicit Kiro reviews, `kiro-cli login` (or a headless `KIRO_API_KEY`). Kiro is never
  auto-drawn.
- Python ≥ 3.10 and PyYAML (needed to read the API maps).

```bash
physlibalpha-review --doctor
```

## Install

```bash
uv tool install --editable ./Review
```

`--editable` matters: the rubrics are prompts under human review and live in the checkout, not in
the wheel, so a non-editable install cannot find them unless you point
`PHYSLIBALPHA_REVIEW_RUBRICS` (or `--rubrics-dir`) at the `rubrics/` directory.

Or run it without installing:

```bash
uvx --from ./Review physlibalpha-review 42
```

Or from the checkout, which is also how to hack on it:

```bash
uv run --with PyYAML python runner/cli.py 42
```

The rubrics always come from a checkout — `--rubrics-dir`, else `$PHYSLIBALPHA_REVIEW_RUBRICS`,
else the `rubrics/` directory beside the package — so they never drift from the engine that runs
them.

## Use

```bash
physlibalpha-review 42                        # review PR #42, PRINT the verdicts — posts nothing
physlibalpha-review 42 --post                 # also post the scoreboard + threads, as you
physlibalpha-review 42 --rubrics scope,correctness,reuse
physlibalpha-review 42 --reviewer claude      # use only Claude even if both are installed
physlibalpha-review 42 --reviewer kiro --kiro-model gpt-5.6-sol
physlibalpha-review 42 --no-mathlib           # skip the Mathlib fetch (faster; weaker reuse checks)
```

It **defaults to a dry run**. Useful flags:

| flag | effect |
|---|---|
| `--post` | post the scoreboard comment + per-rubric review threads, under your GitHub login |
| `--rubrics a,b,c` | review only these rubrics (default: all ten) |
| `--reviewer claude\|codex\|sonnet\|kiro\|deepseek\|minimax\|grok` | restrict to these reviewers (default: every auto-drawn one you have — `claude` and `codex`). All but those two are explicit-only |
| `--kiro-model MODEL` | exact Kiro model id; defaults to `gpt-5.6-sol` |
| `--model MODEL` | override the model for the chosen provider |
| `--mode commit` | review only rubrics not already green at this head (default `manual` = all) |
| `--no-mathlib` | skip fetching pinned Mathlib source; `reuse`/`naming` can't grep Mathlib |
| `--repo owner/name` | review a different repo (default `leanprover-community/physlib`) |
| `--auth api` | use `ANTHROPIC_API_KEY` / `OPENAI_API_KEY` / `KIRO_API_KEY` instead of a browser login |
| `--coordinate` | take the in-progress marker on a dry run too (by default only `--post` runs claim the head, so a dry run writes nothing to the PR) |
| `--no-coordinate` | never post the in-progress marker, even with `--post` (may duplicate spend) |
| `--keep` | keep the temporary workspace for inspection |
| `--timeout N` | per-rubric timeout in seconds (default 1800) |

## What it does

1. Reads the PR head SHA, diff, description, changed files, and CI conclusion via `gh`.
2. Builds the reviewer workspace: the PR source at its head (`code/` — the whole repository, so
   `Physlib/`, `QuantumInfo/` and every `API-map.yaml` come with it), a generated index of every
   API map's open targets (`apimaps/INDEX.md`), the diff (`diff.patch`), and unless
   `--no-mathlib` the Mathlib source at the revision `lake-manifest.json` pins.
3. Runs each rubric through `claude -p`, `codex exec`, `kiro-cli chat`, or the `pi` agent,
   **read-only** (`Read`/`Grep`/`Glob` — no shell, no writes). Each reviewer runs in a **clean
   room**: a throwaway HOME seeded with only its own credential, so it ignores your personal
   `CLAUDE.md` / `AGENTS.md`, skills, plugins, MCP servers, and settings. The review depends on
   the rubrics and the PR, not on who runs it.
4. Reads each verdict from a fresh one-time marker token, so nothing in the PR text can forge an
   `approve`.
5. Prints the scoreboard + threads, and with `--post`, publishes them via `gh` as you.

## Notes

- **Cost line.** The scoreboard's `Review spend` is a *notional* API-equivalent estimate from
  token usage. `runner/prices.json` ships with null rates, so out of the box every run renders as
  `unpriced` rather than as a fabricated dollar figure. Fill it in before quoting costs. Kiro
  exposes no per-turn token telemetry, so Kiro runs record $0 rather than a fictional price.
- **Who it posts as.** With `--post`, comments are created under your `gh` identity. The
  authenticated login is recorded as `submitted_by` in the scoreboard's hidden provenance.
- **Subscription terms.** Driving a personal subscription as an automated reviewer is fine for
  occasional, interactive, human-initiated runs like this. Standing it up as a 24/7 auto-reviewer
  is closer to API-tier usage and likely outside subscription terms — use `--auth api` with keys.
- **Reproducibility.** The clean room means your personal config does not influence the review.
  On macOS, where a subscription login lives in the keychain rather than a credential file, it
  falls back to your real HOME and prints a note; pass `--auth api` with a key for a guaranteed
  clean room there. (The repo's own in-tree `AGENTS.md` is still visible — it is part of the code
  under review, and the rubrics reference its rules deliberately.)
- **Determinism.** With both CLIs installed the reviewer is drawn at random per rubric, so two
  runs can differ on borderline rubrics — the same property CI review has.
- **Concurrent reviewers.** Before spending inference, a contributing run posts a short-lived
  `in progress` comment scoped to the head alone and checks for one already there. If another
  reviewer holds the commit, this run skips it entirely — so a commit is reviewed once regardless
  of model, and a fleet never pays twice. A *different* model is not a distinct unit (first
  claimer wins); only a new push, being a fresh head, is a fresh unit. Simultaneous claimers wait
  five seconds for GitHub's comment replicas to settle, then the lowest comment id wins. The
  marker self-expires after 45 minutes, so a crashed reviewer never blocks anyone, and is deleted
  when done. It needs only the ability to comment, so a reviewer with no repo write still
  coordinates. A **dry run does not claim the head** — it writes nothing to the PR at all, which is
  what makes it safe to point at someone else's PR; pass `--coordinate` if you want a dry run to
  hold the head anyway, and `--no-coordinate` to publish without claiming.

## Shadow reviews (A/B arms)

A shadow review runs the same PR through alternative rubrics and/or models, archives the results
locally, and posts **nothing** — the PR thread and the production review state are untouched.

```bash
physlibalpha-review 139 --shadow --label deepseek-arm --reviewer deepseek
physlibalpha-review 139 --shadow --label rubrics-v2 --rubrics-dir ../rubrics-v2
```

Arms always run every requested rubric fresh so two arms over the same `(PR, head, rubric)` are
comparable; records land with `arm: shadow:<label>` in the archive alongside the production run.
