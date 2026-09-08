# Derived from Tau Ceti Review (https://github.com/TauCetiProject/TauCetiReview),
# Apache-2.0. Modified for PhyslibAlpha; see ../NOTICE.

"""physlibalpha-review verdict — parsing and rubric state.

The verdict is read only from after a one-time secret marker, so PR content cannot forge one.
"""

import datetime
import json
import re


def extract_verdict(text, marker):
    """Parse the verdict only from after the one-time secret marker.

    The marker is a fresh random token the attacker cannot predict, so it cannot be forged in
    PR content. We take the text after the last marker occurrence (tolerating a benign restate)
    and read the JSON object there. Everything before the marker — including any attacker JSON
    echoed by the model — is ignored. Fail closed (None) on a missing marker, unparseable JSON,
    or a verdict outside the allowed set; the caller renders that as an `error` verdict.
    """
    if not text or marker not in text:
        return None
    tail = text.rsplit(marker, 1)[1]
    m = re.search(r"\{.*\}", tail, flags=re.S)
    if not m:
        return None
    try:
        d = json.loads(m.group(0))
    except Exception:
        return None
    if not isinstance(d, dict) or d.get("verdict") not in ("approve", "request_changes", "block"):
        return None
    return d


def today():
    return datetime.datetime.now(datetime.timezone.utc).strftime("%Y-%m-%d")


def state_of(cf, head_sha):
    """A rubric's live state from its case file and the current HEAD."""
    if not cf or not cf.get("verdict"):
        return "absent"
    v = cf["verdict"]
    if v == "approve":
        return "green" if cf.get("approved_sha") == head_sha else "stale"
    if v == "block":
        return "blocking_block"
    if v == "request_changes":
        return "blocking_request"
    return "error"


def is_unresolved(state):
    """States holding an adverse verdict (vs `absent`, which is merely not yet run)."""
    return state in ("blocking_request", "blocking_block", "error")


def is_blocking(state):
    """States that must be (re-)run before merge: unresolved findings or never-run rubrics."""
    return is_unresolved(state) or state == "absent"


def posts_review_thread(state):
    """States that warrant creating/updating a contestable review thread: a genuine adverse
    verdict. Deliberately narrower than is_unresolved — `error` is an infrastructure failure (no
    parseable verdict), not a finding to contest, so it must never spawn a thread. `error` stays
    blocking for merge and shows on the scoreboard; it just gets no thread."""
    return state in ("blocking_request", "blocking_block")


def newest_reply_id(cf):
    """The highest author-reply comment id recorded for this rubric, or None. GitHub comment ids
    are monotonic, so this is the watermark a re-run compares against `last_reply_seen`."""
    ids = [r.get("id") for r in ((cf or {}).get("author_replies") or []) if r.get("id") is not None]
    return max(ids) if ids else None


def has_new_contest(cf):
    """True iff this rubric carries an author reply newer than the one last adjudicated. Strict
    `>` on the monotonic id (not `!=`), so a deleted/minimized newest reply can never re-fire."""
    nr = newest_reply_id(cf)
    return nr is not None and nr > ((cf or {}).get("last_reply_seen") or 0)


def overall_label(states, stopped):
    if any(s == "blocking_block" for s in states):
        label = "blocked"
    elif any(s in ("blocking_request", "error") for s in states):
        label = "changes requested"
    elif any(s == "absent" for s in states):
        label = "pending"
    elif any(s == "stale" for s in states):
        label = "freshness sweep pending"
    elif states and all(s == "green" for s in states):
        label = "approved"
    else:
        label = "partial"
    if stopped:
        label += f" (budget cap reached; deferred {stopped} and after)"
    return label
