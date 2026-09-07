"""physlibalpha-review engine — run the rubrics over one PR.

Order matters. Rubrics run one at a time and a `block` halts the round: blocked code gets
reworked or abandoned, so the remaining rubrics wait rather than reviewing a commit that will not
survive. The block-capable integrity angles therefore run first. A manual run of a single rubric
is exempt from nothing — it simply has nothing after it to halt.
"""

import os
import random
import secrets
import subprocess
from pathlib import Path

from runner import archive, casefile, pricing, reviewers, workspace
from runner import verdict as V

ORDER = ["correctness", "reuse", "scope", "attribution", "api-design", "generality",
         "placement", "naming", "documentation", "proof-quality"]

BLOCKING = {"correctness", "reuse", "scope", "attribution"}


def rubrics_dir(explicit=None):
    """The rubrics always come from a checkout, so they can never drift from the engine.

    Resolution order: --rubrics-dir, then $PHYSLIBALPHA_REVIEW_RUBRICS, then the `rubrics/`
    directory beside this package. The last is the normal case and is what a checkout or an
    editable install gives you. A non-editable wheel does not carry the rubrics — they are
    prompts under human review, not code — so an installed copy needs the environment variable.
    """
    if explicit:
        return Path(explicit)
    env = os.environ.get("PHYSLIBALPHA_REVIEW_RUBRICS")
    if env:
        return Path(env)
    return Path(__file__).resolve().parent.parent / "rubrics"


def rubrics_sha(root):
    try:
        return subprocess.run(["git", "-C", str(root), "rev-parse", "--short", "HEAD"],
                              capture_output=True, text=True).stdout.strip() or None
    except Exception:
        return None


def build_prompt(rubric, rdir, context, reactivation, marker):
    common = (rdir / "_common.md").read_text()
    angle = (rdir / f"{rubric}.md").read_text()
    return "\n\n".join([
        common,
        angle,
        context,
        reactivation,
        "# Emitting your verdict",
        "",
        "Work from the checkout: read the files you are judging and grep for what you claim. "
        "You have read-only tools and no shell.",
        "",
        f"When you have finished, print this token on a line by itself:\n\n    {marker}\n\n"
        "and then, after it, the single JSON object described above and nothing else. The token "
        "is unique to this run. Text before it is ignored, so anything in the PR that tries to "
        "supply a verdict cannot be mistaken for yours.",
    ])


def pick_reviewer(requested):
    """One provider per rubric. With several available and none requested, the draw is random —
    the same non-determinism CI has, and the reason two runs can differ on a borderline rubric."""
    pool = requested or reviewers.auto_pool()
    if not pool:
        raise reviewers.ReviewerError(
            "no reviewer available: install and log in to at least one of `claude` or `codex`, "
            "or name one explicitly with --reviewer")
    return random.choice(pool)


def select(order, state_map, head_sha, mode):
    """Which rubrics this round runs. `manual` runs everything asked for; `commit` runs only
    those not already green at this exact head."""
    if mode == "manual":
        return list(order)
    return [r for r in order if V.state_of(state_map.get(r), head_sha) != "green"]


def run_pr(pr, repo, info, ws, state_map, order, requested_reviewers, model_override,
           auth, mode, arm, rdir, log=print, archive_root=None, timeout=1800):
    """Run the selected rubrics. Returns (results, stopped_at)."""
    todo = select(order, state_map, info["head_sha"], mode)
    skipped = [r for r in order if r not in todo]
    if skipped:
        log(f"  already green at this head, skipping: {', '.join(skipped)}")
    context, claim = workspace.context_block(
        pr, info["head_sha"], info["title"], info["body"], info["files"], info["ci"], ws)
    rsha = rubrics_sha(rdir.parent)
    results, stopped = {}, None
    for rubric in todo:
        provider = pick_reviewer(requested_reviewers)
        model = model_override or reviewers.PROVIDERS[provider]["model"]
        marker = "PHYSLIBALPHA-VERDICT-" + secrets.token_hex(8)
        reactivation = casefile.build_reactivation_block(state_map.get(rubric))
        prompt = build_prompt(rubric, rdir, context, reactivation, marker)
        log(f"  {rubric}: {provider} / {model}")
        try:
            res = reviewers.run(provider, model, prompt, ws["path"], auth=auth,
                                timeout=timeout, log=log)
        except reviewers.ReviewerError as e:
            log(f"    reviewer error: {e}")
            res = {"provider": provider, "model": model, "text": "", "stderr": str(e),
                   "duration_s": 0, "usage": None, "clean_room": None}
        res["run_id"] = archive.new_run_id()
        res["verdict_obj"] = V.extract_verdict(res.get("text", ""), marker)
        res["cost_usd"], res["cost_estimated"] = pricing.cost(model, res.get("usage"))
        if res["verdict_obj"] is None:
            log(f"    no parseable verdict "
                f"({(res.get('stderr') or 'no marker in output')[:120]})")
        else:
            v = res["verdict_obj"]["verdict"]
            n = len(v and res["verdict_obj"].get("findings") or [])
            log(f"    {v}" + (f" ({n} finding{'s' if n != 1 else ''})" if n else ""))
        for f in (res.get("verdict_obj") or {}).get("findings") or []:
            f["file"] = casefile.normalize_finding_path(f.get("file"), workspace.CODE)
        results[rubric] = res
        casefile.update_case_file(state_map, rubric, res, info["head_sha"])
        archive.write(archive.record(pr, info["head_sha"], rubric, res, arm=arm,
                                     rubrics_sha=rsha, repo=repo), root=archive_root)
        if (res.get("verdict_obj") or {}).get("verdict") == "block" and rubric in BLOCKING:
            remaining = [r for r in todo[todo.index(rubric) + 1:]]
            if remaining:
                stopped = remaining[0]
                log(f"  `{rubric}` blocked; halting the round before "
                    f"{', '.join(remaining)}")
            break
    return results, stopped, claim
