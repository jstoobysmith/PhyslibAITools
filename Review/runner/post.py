"""physlibalpha-review post — everything that talks to GitHub, through `gh`.

Reads are always allowed. Writes happen only with --post (the scoreboard and per-rubric threads)
or as part of the concurrency marker, which needs nothing more than the ability to comment — so
an independent reviewer with no repository write access still coordinates with everyone else.
"""

import json
import re
import subprocess
import time

CLAIM_MARK = "<!-- physlibalpha-review:in-progress -->"
CLAIM_TTL = 45 * 60  # a crashed reviewer must never block a head forever


class GhError(RuntimeError):
    pass


def gh(args, check=True):
    p = subprocess.run(["gh"] + args, capture_output=True, text=True)
    if check and p.returncode != 0:
        raise GhError(f"gh {' '.join(args)} failed: {(p.stderr or '').strip()[:400]}")
    return p.stdout


def gh_json(args):
    out = gh(args)
    try:
        return json.loads(out)
    except Exception as e:
        raise GhError(f"gh returned unparseable JSON for {' '.join(args)}: {e}")


def whoami():
    try:
        return gh_json(["api", "user", "--jq", "{login: .login}"]).get("login")
    except GhError:
        return None


def clone_url(repo):
    return f"https://github.com/{repo}.git"


def pr_info(repo, pr):
    """Head SHA, title, body, changed files and CI conclusion — all from `gh`, none from the
    author. This is what the runner-verified context block is built from."""
    d = gh_json(["pr", "view", str(pr), "--repo", repo, "--json",
                 "headRefOid,title,body,files,statusCheckRollup,isCrossRepository,"
                 "headRepositoryOwner,headRepository,url,author,baseRefName,baseRefOid"])
    files = [f["path"] for f in (d.get("files") or [])]
    rollup = d.get("statusCheckRollup") or []
    concl = {c.get("conclusion") or c.get("state") for c in rollup}
    if not rollup:
        ci = "no checks reported"
    elif concl <= {"SUCCESS", "NEUTRAL", "SKIPPED", "success"}:
        ci = "green"
    elif "FAILURE" in concl or "failure" in concl or "ERROR" in concl:
        ci = "failing"
    else:
        ci = "pending"
    head_repo = repo
    if d.get("isCrossRepository"):
        owner = (d.get("headRepositoryOwner") or {}).get("login")
        name = (d.get("headRepository") or {}).get("name")
        if owner and name:
            head_repo = f"{owner}/{name}"
    return {"head_sha": d["headRefOid"], "title": d.get("title") or "",
            "body": d.get("body") or "", "files": files, "ci": ci,
            "url": d.get("url"), "head_repo": head_repo,
            "base_ref": d.get("baseRefName"), "base_sha": d.get("baseRefOid"),
            "author": (d.get("author") or {}).get("login")}


def issue_comments(repo, pr):
    return gh_json(["api", f"repos/{repo}/issues/{pr}/comments?per_page=100"])


# --- concurrency marker -------------------------------------------------------------------

def claim_head(repo, pr, head_sha, me, log=print):
    """Claim this head before spending inference, so a fleet never pays twice for one commit.

    Scoped to the head alone: a different model is not a distinct unit of work, and the first
    claimer wins. Only a new push, being a fresh head, is a fresh unit. Simultaneous claimers
    wait for GitHub's comment replicas to settle and the lowest comment id wins. The marker
    self-expires so a crashed reviewer never blocks anyone.
    """
    body = f"{CLAIM_MARK}\n<!-- head: {head_sha} -->\n<!-- at: {int(time.time())} -->\n" \
           f"`physlibalpha-review` in progress on `{head_sha[:12]}` ({me or 'unknown'})."
    mine = gh_json(["api", f"repos/{repo}/issues/{pr}/comments", "-f", f"body={body}"])
    time.sleep(5)  # let comment replicas settle before deciding who won
    holders = []
    for c in issue_comments(repo, pr):
        if CLAIM_MARK not in (c.get("body") or ""):
            continue
        if f"<!-- head: {head_sha} -->" not in c["body"]:
            continue
        m = re.search(r"<!-- at: (\d+) -->", c["body"])
        if m and time.time() - int(m.group(1)) > CLAIM_TTL:
            continue  # expired: a crashed reviewer
        holders.append(c["id"])
    if holders and min(holders) != mine["id"]:
        release_claim(repo, mine["id"])
        log(f"  another reviewer already holds {head_sha[:12]}; skipping")
        return None
    return mine["id"]


def release_claim(repo, comment_id):
    if comment_id:
        gh(["api", "-X", "DELETE", f"repos/{repo}/issues/comments/{comment_id}"], check=False)


# --- publishing ---------------------------------------------------------------------------

def post_scoreboard(repo, pr, body):
    """A local run keeps no state shared with CI, so it always posts a fresh comment rather than
    editing a bot comment in place."""
    return gh_json(["api", f"repos/{repo}/issues/{pr}/comments", "-f", f"body={body}"])


def post_thread(repo, pr, head_sha, path, body):
    """A file-level review comment: robust to the finding's line not lying in a diff hunk."""
    return gh_json(["api", f"repos/{repo}/pulls/{pr}/comments",
                    "-f", f"body={body}", "-f", f"commit_id={head_sha}",
                    "-f", f"path={path}", "-f", "subject_type=file"])
