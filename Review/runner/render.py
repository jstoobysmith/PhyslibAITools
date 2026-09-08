"""physlibalpha-review render — the scoreboard and the per-rubric threads."""

from runner import pricing, verdict as V

MARK = "<!-- physlibalpha-review:scoreboard -->"

GLYPH = {"approve": "✅", "request_changes": "🔸", "block": "⛔", "error": "⚠️", None: "·"}
STATE_WORD = {"green": "approved", "stale": "approved (earlier head)",
              "blocking_request": "changes requested", "blocking_block": "blocked",
              "error": "no parseable verdict", "absent": "not run"}


def scoreboard(pr, head_sha, order, state_map, submitted_by, stopped=None, shadow=None):
    """The head-pinned comment. Auto-merge (where enabled) reads the newest marked scoreboard and
    requires it to name the current head, so the head SHA is load-bearing, not decoration."""
    states = [V.state_of(state_map.get(r), head_sha) for r in order]
    label = V.overall_label(states, stopped)
    rows = ["| Rubric | Verdict | Reviewer | Cost |", "| --- | --- | --- | --- |"]
    total, any_est = 0.0, False
    for r, st in zip(order, states):
        cf = state_map.get(r) or {}
        g = GLYPH.get(cf.get("verdict"))
        who = f"{cf.get('provider') or '—'}" + (f" / `{cf['model']}`" if cf.get("model") else "")
        usd, est = cf.get("cost_usd"), cf.get("cost_estimated")
        if usd:
            total += usd
            any_est = any_est or bool(est)
        rows.append(f"| `{r}` | {g} {STATE_WORD[st]} | {who} | {pricing.render(usd, est)} |")
    out = [MARK,
           f"## PhyslibAlpha review — **{label}**",
           "",
           f"Head: `{head_sha}`",
           ""] + rows + [""]
    out.append(f"Review spend: {pricing.render(round(total, 4) if total else None, any_est)} "
               f"· rates `{pricing.prices_sha()}`")
    if submitted_by:
        out.append(f"<!-- submitted_by: {submitted_by} -->")
    if shadow:
        out.append(f"<!-- shadow arm: {shadow} — not a production verdict -->")
    out.append(f"<!-- head: {head_sha} -->")
    return "\n".join(out)


def thread(rubric, cf):
    """One rubric's contestable thread body."""
    v = cf.get("verdict")
    head = f"**`{rubric}` — {STATE_WORD.get('blocking_block' if v == 'block' else 'blocking_request')}**"
    out = [f"{GLYPH.get(v)} {head}", "", (cf.get("summary") or "").strip(), ""]
    for i, f in enumerate(cf.get("findings") or [], 1):
        loc = (f.get("file") or "PR-wide")
        if f.get("line"):
            loc += f":{f['line']}"
        out += [f"**{i}. `{loc}`**", "",
                (f.get("issue") or "").strip(), ""]
        if f.get("fix"):
            out += [f"*Fix:* {f['fix'].strip()}", ""]
        if f.get("evidence"):
            out += [f"*Evidence:* {f['evidence'].strip()}", ""]
    out.append("---")
    out.append("Reply in this thread to contest a finding. Quote the rubric and round of any "
               "conflicting finding from another angle rather than satisfying one and letting "
               "the other re-fire.")
    return "\n".join(out)


def terminal(pr, head_sha, order, state_map, stopped=None):
    """The dry-run rendering: what would be posted, printed instead."""
    lines = [scoreboard(pr, head_sha, order, state_map, None, stopped).replace(MARK, "").strip()]
    for r in order:
        cf = state_map.get(r) or {}
        if V.posts_review_thread(V.state_of(cf, head_sha)):
            lines += ["", "-" * 72, "", thread(r, cf)]
    return "\n".join(lines)
