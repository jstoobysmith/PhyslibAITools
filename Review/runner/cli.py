"""physlibalpha-review — run the PhyslibAlpha review on a PR.

Defaults to a dry run: it prints the scoreboard and each rubric's thread and posts nothing.
"""

import argparse
import shutil
import sys
from pathlib import Path

if __package__ in (None, ""):  # running from a checkout: python runner/cli.py
    sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from runner import archive, casefile, post, render, review, reviewers, workspace
from runner import verdict as V
from runner.ledger import Ledger

DEFAULT_REPO = "leanprover-community/physlib"


def parse_args(argv=None):
    p = argparse.ArgumentParser(
        prog="physlibalpha-review",
        description="Review a PhyslibAlpha pull request against the rubrics, using your own "
                    "Claude/Codex/Kiro subscription. Prints the verdicts; posts nothing "
                    "unless you pass --post.")
    p.add_argument("pr", nargs="?", type=int, help="pull request number")
    p.add_argument("--repo", default=DEFAULT_REPO, help=f"default: {DEFAULT_REPO}")
    p.add_argument("--post", action="store_true",
                   help="post the scoreboard comment and per-rubric review threads, as you")
    p.add_argument("--rubrics", help="comma-separated subset (default: all)")
    p.add_argument("--reviewer", help="comma-separated: claude, codex, sonnet, kiro, deepseek, "
                                      "minimax, grok (default: every auto-drawn one you have)")
    p.add_argument("--kiro-model", default="gpt-5.6-sol", help="exact Kiro model id")
    p.add_argument("--model", help="override the model for the chosen provider")
    p.add_argument("--mode", choices=("manual", "commit"), default="manual",
                   help="manual: run every rubric. commit: skip rubrics already green at this head")
    p.add_argument("--no-mathlib", action="store_true",
                   help="skip fetching pinned Mathlib source (faster; weaker reuse/naming checks)")
    p.add_argument("--auth", choices=("subscription", "api"), default="subscription")
    p.add_argument("--keep", action="store_true", help="keep the temporary workspace")
    p.add_argument("--coordinate", action="store_true",
                   help="take the in-progress marker on a dry run too (default: only --post runs "
                        "claim the head, so a dry run never writes to the PR)")
    p.add_argument("--no-coordinate", action="store_true",
                   help="never post the in-progress marker, even with --post (may duplicate spend)")
    p.add_argument("--shadow", action="store_true",
                   help="A/B arm: archive the runs, post nothing, touch the PR not at all")
    p.add_argument("--label", help="name for a --shadow arm")
    p.add_argument("--rubrics-dir", help="use rubrics from this directory instead of the checkout")
    p.add_argument("--timeout", type=int, default=1800, help="per-rubric timeout in seconds")
    p.add_argument("--doctor", action="store_true", help="report what this host can run, and exit")
    return p.parse_args(argv)


def doctor():
    print("physlibalpha-review doctor\n")
    ok = True
    for tool in ("git", "gh"):
        path = shutil.which(tool)
        print(f"  {tool:10} {path or 'MISSING — required'}")
        ok = ok and bool(path)
    try:
        import yaml  # noqa: F401
        print(f"  {'PyYAML':10} installed")
    except ImportError:
        print(f"  {'PyYAML':10} MISSING — required to read the API maps")
        ok = False
    print()
    pool = reviewers.auto_pool()
    for prov in reviewers.PROVIDERS:
        mark = "auto-drawn" if prov in pool else (
            "available (explicit-only)" if reviewers.available(prov) else "not installed")
        print(f"  {prov:10} {mark}")
    if not pool:
        print("\n  No auto-drawn reviewer. Install and log in to `claude` or `codex`,")
        print("  or name an explicit one with --reviewer.")
        ok = False
    login = post.whoami()
    print(f"\n  gh login   {login or 'not authenticated — run `gh auth login`'}")
    print(f"  store      {archive.store_root()}")
    print(f"  rubrics    {review.rubrics_dir()}")
    return 0 if ok and login else 1


def main(argv=None):
    a = parse_args(argv)
    if a.doctor:
        return doctor()
    if a.pr is None:
        print("error: a PR number is required (or --doctor)", file=sys.stderr)
        return 2
    if a.shadow and a.post:
        print("error: --shadow posts nothing; drop --post", file=sys.stderr)
        return 2

    order = [r.strip() for r in a.rubrics.split(",")] if a.rubrics else list(review.ORDER)
    unknown = [r for r in order if r not in review.ORDER]
    if unknown:
        print(f"error: unknown rubric(s): {', '.join(unknown)}\n"
              f"known: {', '.join(review.ORDER)}", file=sys.stderr)
        return 2
    requested = [r.strip() for r in a.reviewer.split(",")] if a.reviewer else None
    if requested:
        bad = [r for r in requested if r not in reviewers.PROVIDERS]
        if bad:
            print(f"error: unknown reviewer(s): {', '.join(bad)}", file=sys.stderr)
            return 2
    model = a.model or (a.kiro_model if requested == ["kiro"] else None)

    rdir = review.rubrics_dir(a.rubrics_dir)
    if not (rdir / "_common.md").is_file():
        print(f"error: no rubrics at {rdir}\n"
              f"The rubrics live in the checkout, not in the wheel. Either run from the checkout, "
              f"install with `uv tool install --editable <checkout>`, or point "
              f"PHYSLIBALPHA_REVIEW_RUBRICS (or --rubrics-dir) at the `rubrics/` directory.",
              file=sys.stderr)
        return 2

    log = print
    log(f"physlibalpha-review: {a.repo}#{a.pr}")
    info = post.pr_info(a.repo, a.pr)
    log(f"  head {info['head_sha'][:12]} · base {info.get('base_ref') or '?'} "
        f"{(info.get('base_sha') or '')[:12]} · CI {info['ci']} · "
        f"{len(info['files'])} files changed")
    if info["ci"] != "green":
        log("  note: rubrics assume the mechanical layer is already satisfied. CI is not green, "
            "so mechanical breakage may show up as review findings.")

    me = post.whoami()
    claim_id = None
    # Coordination costs a comment on the PR, so only a run that will actually publish takes the
    # head. A dry run spends inference but touches nothing, which is what makes it safe to point
    # at any PR; if you want a dry run to hold the head anyway, pass --coordinate.
    contributes = (a.post or a.coordinate) and not a.no_coordinate and not a.shadow
    if contributes:
        claim_id = post.claim_head(a.repo, a.pr, info["head_sha"], me, log=log)
        if claim_id is None:
            return 0

    ledger = Ledger(archive.store_root() / "ledger.json")
    pr_state = ledger.pr_state(a.pr)
    state_map = pr_state["state"]

    ws = None
    try:
        log("building the reviewer workspace")
        ws = workspace.build(a.pr, info["head_sha"], post.clone_url(info["head_repo"]),
                             base_ref=info.get("base_ref"),
                             base_sha=info.get("base_sha"),
                             base_url=post.clone_url(a.repo),
                             changed_files=info["files"],
                             want_mathlib=not a.no_mathlib, keep=a.keep, log=log)
        (ws["path"] / "diff.patch").write_text(
            post.gh(["pr", "diff", str(a.pr), "--repo", a.repo], check=False))
        log(f"  workspace {ws['path']}")

        arm = f"shadow:{a.label}" if a.shadow else "production"
        log(f"running {len(order)} rubric(s)")
        results, stopped, claim = review.run_pr(
            a.pr, a.repo, info, ws, state_map, order, requested, model, a.auth, a.mode,
            arm, rdir, log=log, timeout=a.timeout)

        ledger.persist()

        if a.shadow:
            log(f"\nshadow arm `{a.label or 'unnamed'}`: archived, nothing posted.")
            return 0

        board = render.scoreboard(a.pr, info["head_sha"], order, state_map, me, stopped)
        if not a.post:
            print()
            print(render.terminal(a.pr, info["head_sha"], order, state_map, stopped))
            print("\n(dry run — nothing was posted. Add --post to publish.)")
            return 0

        anchor_fallback = info["files"][0] if info["files"] else None
        changed = set(info["files"])
        for rubric in order:
            cf = state_map.get(rubric) or {}
            if not V.posts_review_thread(V.state_of(cf, info["head_sha"])):
                continue
            path = casefile.pick_anchor(cf, anchor_fallback, changed)
            if not path:
                log(f"  {rubric}: no anchorable file; folding into the scoreboard only")
                continue
            c = post.post_thread(a.repo, a.pr, info["head_sha"], path,
                                 render.thread(rubric, cf))
            cf["thread"] = c.get("id")
            cf.pop("pending_thread_run_id", None)
            log(f"  {rubric}: thread posted on {path}")
        c = post.post_scoreboard(a.repo, a.pr, board)
        pr_state["scoreboard_comment_id"] = c.get("id")
        ledger.persist()
        log(f"\nposted: {info['url']}#issuecomment-{c.get('id')}")
        return 0
    finally:
        if claim_id:
            post.release_claim(a.repo, claim_id)
        if ws:
            if a.keep:
                log(f"workspace kept at {ws['path']}")
            else:
                workspace.cleanup(ws)


if __name__ == "__main__":
    sys.exit(main())
