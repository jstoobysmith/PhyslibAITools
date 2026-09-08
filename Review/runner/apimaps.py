"""physlibalpha-review apimaps — the roadmap layer.

Physlib has no separate roadmap repository. Its equivalent is the set of `API-map.yaml` files
that sit at the top of each API directory: each lists `Requirements`, and each requirement is
either `done: true` (formalized, with a `location` naming the declarations) or `done: false`
(planned, `location: N/A`). The guide is explicit that unformalized requirements belong in the
map so that "the map doubles as the API's roadmap" — so a `done: false` requirement is an open
target, and that is what the `scope` rubric judges new material against.

This module collects the maps out of the PR checkout and renders `apimaps/INDEX.md` into the
reviewer workspace, so an agent can see every open target without walking the tree.
"""

import re
from pathlib import Path

try:
    import yaml
except ImportError:  # pragma: no cover - surfaced by cli.doctor
    yaml = None

MAP_NAME = "API-map.yaml"
CLAIM_RE = re.compile(r"^\s*API-map:\s*(.+?)\s*$", re.M)


def find_maps(root):
    """Every API map in the checkout, repo-relative, sorted."""
    root = Path(root)
    return sorted(p.relative_to(root).as_posix() for p in root.rglob(MAP_NAME)
                  if ".lake" not in p.parts)


def load_map(root, rel):
    """Parse one map. Returns (data, error). A broken map is reported, never raised: the API-map
    linter owns schema enforcement in CI, and a review must still run against the rest."""
    if yaml is None:
        return None, "PyYAML is not installed"
    p = Path(root) / rel
    try:
        data = yaml.safe_load(p.read_text())
    except Exception as e:
        return None, f"unparseable: {e}"
    if not isinstance(data, dict):
        return None, "not a mapping"
    return data, None


def requirements(data):
    """The requirement entries of a map, defensively."""
    reqs = data.get("Requirements") or []
    return [r for r in reqs if isinstance(r, dict)]


def is_open(req):
    """An open target: `done` is falsey. The linter forbids a location on these, but we do not
    depend on that here."""
    return not bool(req.get("done"))


def summarize(root):
    """{rel_path: {title, overview, parents, references, open, done, reqs, error}}."""
    out = {}
    for rel in find_maps(root):
        data, err = load_map(root, rel)
        if err:
            out[rel] = {"error": err, "open": [], "done": 0, "total": 0}
            continue
        reqs = requirements(data)
        out[rel] = {
            "error": None,
            "title": data.get("Title") or "",
            "overview": (data.get("Overview") or "").strip(),
            "parents": data.get("ParentAPIs") or [],
            "references": data.get("References") or [],
            "open": [str(r.get("description", "")).strip() for r in reqs if is_open(r)],
            "done": sum(1 for r in reqs if not is_open(r)),
            "total": len(reqs),
        }
    return out


def render_index(maps):
    """The `apimaps/INDEX.md` an agent reads. Open requirements are the headline: they are the
    targets. Done counts are context for the `weigh advancement` test in the scope rubric."""
    total_open = sum(len(m["open"]) for m in maps.values())
    total_done = sum(m["done"] for m in maps.values())
    total_reqs = sum(m["total"] for m in maps.values())
    lines = [
        "# API maps — the open targets",
        "",
        "Physlib's API maps stand in for a roadmap repository. Every `API-map.yaml` below is a "
        "human-written, human-reviewed statement of what one API is meant to contain. A "
        "requirement marked `done: false` is an **open target**: work that is wanted and not yet "
        "formalized. New material in a PR is in scope only if it advances one of these, or "
        "supplies a prerequisite one needs.",
        "",
        "This index is generated. It is a finding aid, not the authority — open the actual "
        "`API-map.yaml` in the checkout before ruling on a claim, and read `ParentAPIs` and the "
        "requirement order for the layering.",
        "",
        f"{len(maps)} maps, {total_reqs} requirements, {total_done} done, {total_open} open.",
        "",
    ]
    for rel in sorted(maps):
        m = maps[rel]
        lines.append(f"## `{rel}`")
        if m["error"]:
            lines += [f"*Could not read this map: {m['error']}*", ""]
            continue
        lines.append(f"**{m['title']}** — {m['done']}/{m['total']} requirements done.")
        if m["parents"]:
            lines.append("")
            lines.append("Parent APIs: " + "; ".join(str(p) for p in m["parents"]))
        if m["overview"]:
            lines += ["", "> " + m["overview"].replace("\n", "\n> ")]
        lines.append("")
        if m["open"]:
            lines.append("Open targets:")
            for d in m["open"]:
                lines.append(f"- {d}")
        else:
            lines.append("*No open targets: every requirement in this map is done.*")
        lines.append("")
    return "\n".join(lines)


def write_index(root, dest):
    """Render the index into the workspace. Returns (path, maps)."""
    maps = summarize(root)
    dest = Path(dest)
    dest.parent.mkdir(parents=True, exist_ok=True)
    dest.write_text(render_index(maps))
    return dest, maps


def claimed_map(pr_body):
    """The `API-map: <path>` attribution line from a PR description, or None.

    Attribution, not authorization: the scope rubric still requires new material to quote the
    exact requirement it advances. `API-map: none` is a legitimate value for cross-cutting work
    and is returned as the literal string "none".
    """
    if not pr_body:
        return None
    m = CLAIM_RE.search(pr_body)
    if not m:
        return None
    return m.group(1).strip().strip("`")


def claim_status(root, claim):
    """Describe a claim for the runner-verified header: does the claimed map exist?"""
    if claim is None:
        return "absent", "the PR description has no `API-map:` line"
    if claim.lower() == "none":
        return "none", "the PR claims `API-map: none` (cross-cutting or infrastructure work)"
    p = Path(root) / claim
    if p.is_file():
        return "found", f"the claimed map `{claim}` exists in the checkout"
    return "missing", f"the claimed map `{claim}` is not a file in the checkout"
