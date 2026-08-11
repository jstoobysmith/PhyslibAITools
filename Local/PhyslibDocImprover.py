#!/usr/bin/env python3
"""Hunt for factual mistakes in Physlib documentation with a local LLM.

Walks the Physlib source tree in random order, hands the model whole `.lean`
files, and looks for a factual mistake anywhere in the documentation (module
docstring, declaration docstrings, comments). The model proposes one mistake as
a verbatim quote plus a correction; that claim is then put to a jury of
independent runs which each see the whole file and vote on whether it is really
wrong. The verdict must be unanimous (--threshold to relax it) -- a single
dissenting juror throws the claim out and the hunt moves on.

It runs until you stop it with Ctrl-C (--attempts to cap it). Every confirmed
mistake is appended to a YAML report as it is found, along with a permalink and
ready-to-paste GitHub issue text, so stopping the run never loses work.

Findings are de-duplicated against the whole report before the jury is even
convened, both by file-and-quote and by overlapping line range, so a re-run
never records the same complaint twice. `--check` audits an existing report for
duplicates without running the model at all.

Physlib itself is cloned on first run into a gitignored directory beside this
script, and fast-forwarded onto upstream on every run after that. If GitHub
cannot be reached the existing clone is reviewed as it stands; if there is no
clone either, that is an error -- there is nothing to review. Pass --physlib to
review a checkout of your own instead, which is read as-is and never updated.

Nothing is ever written back to the Lean source: the report is the output, and
applying a correction is a deliberate separate step.

Everything runs against a local ollama daemon; no data leaves the machine.

Usage:
    python3 Local/PhyslibDocImprover.py
    python3 Local/PhyslibDocImprover.py --rounds 3 --report /tmp/found.yml
    python3 Local/PhyslibDocImprover.py --file Physlib/QFT/Basic.lean --attempts 5
    python3 Local/PhyslibDocImprover.py --physlib ~/Documents/GitHub/JTSphyslib
    python3 Local/PhyslibDocImprover.py --check
"""

from __future__ import annotations

import argparse
import difflib
import hashlib
import json
import random
import re
import subprocess
import sys
import urllib.error
import urllib.request
from datetime import datetime
from pathlib import Path

import yaml

PHYSLIB_URL = "https://github.com/leanprover-community/physlib.git"
# Our own shallow clone of Physlib, kept beside this script and gitignored. It
# is read-only as far as this tool is concerned, so it can always be hard-reset
# to upstream without losing anything.
PHYSLIB_CHECKOUT = Path(__file__).resolve().parent / "physlib"
PHYSLIB = PHYSLIB_CHECKOUT / "Physlib"
MODEL = "qwen3.5:9b"
ROUNDS = 10
ATTEMPTS = 0  # 0 = sweep for ever, until Ctrl-C
NUM_CTX = 32768
REPORT = Path(__file__).resolve().parent / "physlib-doc-mistakes.yml"
FALLBACK_REPO = "https://github.com/leanprover-community/physlib"
FALLBACK_BRANCH = "master"

RED, GREEN, CYAN, DIM, BOLD, OFF = (
    "\033[31m",
    "\033[32m",
    "\033[36m",
    "\033[2m",
    "\033[1m",
    "\033[0m",
)

# ---------------------------------------------------------------------------
# Prompts
# ---------------------------------------------------------------------------

FIND_PROMPT = """\
You are reviewing the documentation of a Lean 4 file from Physlib, a \
formalisation of physics in Lean.

Find ONE genuine mistake in the documentation of this file. Documentation means \
the module docstring (`/-! ... -/`), declaration docstrings (`/-- ... -/`) and \
comments -- NOT the Lean code itself.

A mistake is something actually wrong: a false statement about the physics or \
mathematics, a claim that contradicts the code below it, a reference to a name \
that does not exist in the file, a wrong formula, a wrong sign or index, or a \
plain factual error. Style, tone, terseness and missing detail are NOT mistakes.

Be strict. If you cannot find a real mistake, reply with exactly:
NONE

Otherwise reply in exactly this format and nothing else:

<mistake>
<quote>the exact text from the file that is wrong, copied character for character</quote>
<why>one or two sentences on why it is wrong</why>
<fix>the corrected text that should replace the quote</fix>
</mistake>

The <quote> must be copied verbatim from the file and must be long enough to \
appear exactly once. The <fix> must be a drop-in replacement for it, keeping the \
same comment syntax and indentation style.

Here is the whole file:

<file>
{file}
</file>
"""

VERIFY_PROMPT = """\
You are checking a claim someone made about a Lean 4 file from Physlib, a \
formalisation of physics in Lean.

They claim this piece of documentation is WRONG:

<quote>
{quote}
</quote>

Their reasoning:

<why>
{why}
</why>

Their proposed correction:

<fix>
{fix}
</fix>

Read the whole file below and decide for yourself. Is the quoted documentation \
genuinely mistaken -- false physics or mathematics, contradicting the code, \
naming something that does not exist, a wrong formula or sign? Merely terse, \
informal or stylistically weak documentation is NOT a mistake, and neither is a \
correction that only rewords things.

Be sceptical. If you are not convinced there is a real error, say FINE.

Reply with exactly one line in this format, then at most one sentence of reason:
VERDICT: MISTAKE
or
VERDICT: FINE

Here is the whole file:

<file>
{file}
</file>
"""

ISSUE_PROMPT = """\
Write up a documentation bug as a GitHub issue for Physlib, a formalisation of \
physics in Lean.

The bug is in the file `{path}`. This documentation is wrong:

<quote>
{quote}
</quote>

The reviewer who found it gave this reasoning, which is rough and may ramble or \
raise side issues -- use it as a starting point, keep only what is correct and \
central, and drop the rest:

<reviewer-notes>
{why}
</reviewer-notes>

The agreed correction is:

<fix>
{fix}
</fix>

The whole file, so you can describe the error accurately:

<file>
{file}
</file>

Reply in exactly this format and nothing else:

<title>a one-line issue title, at most 80 characters, describing the error \
itself rather than the file; no prefix like "Bug:", no surrounding quotes, no \
trailing full stop</title>
<explanation>
Two or three short paragraphs of GitHub-flavoured markdown explaining, to a \
maintainer who has not seen this file, exactly what the documentation claims, \
why that is wrong, and why the correction is right. Refer to the relevant Lean \
declarations by name in backticks. Be specific and factual. Do not restate the \
quoted text or the correction verbatim -- both are shown separately in the \
issue. Do not include markdown headings, and do not speculate about anything \
beyond this one error.
</explanation>
"""

# ---------------------------------------------------------------------------
# ollama plumbing
# ---------------------------------------------------------------------------

OLLAMA_URL = "http://localhost:11434/api/generate"
THINK_RE = re.compile(r"<think>.*?</think>", re.S)

# Lean is symbol-dense and tokenises worse than prose. This estimate is
# deliberately pessimistic: overestimating only costs us a skipped file,
# whereas underestimating means a silently truncated prompt.
CHARS_PER_TOKEN = 2.8
# Headroom for the model's own reply. Thinking tokens are generated tokens, so
# they eat this budget too -- with thinking on for every role it has to cover a
# reasoning trace *plus* a full docstring or issue writeup, not just the answer.
RESERVED_TOKENS = 8192

# Sampling, per role. The model ships with chat defaults (temperature 1,
# presence_penalty 1.5) that are actively wrong here: presence_penalty
# penalises re-emitting tokens already in context, i.e. it penalises quoting
# the file verbatim -- exactly what `find` has to do. Judgement
# wants a low temperature and thinking on; candidate generation wants neither.
PROFILES = {
    "find":    {"think": True, "temperature": 0.8, "top_p": 0.95, "top_k": 40, "repeat_penalty": 1.0},
    "verify":  {"think": True, "temperature": 0.2, "top_p": 0.90, "top_k": 20, "repeat_penalty": 1.0},
    "issue":   {"think": True, "temperature": 0.4, "top_p": 0.90, "top_k": 40, "repeat_penalty": 1.1},
}


class ContextOverflow(RuntimeError):
    """The prompt does not fit the context window, so it would be truncated.

    ollama silently discards the *front* of an over-long prompt, which drops the
    instructions rather than the file -- the model then answers a question it
    was never asked. Never let that happen quietly.
    """


def run_ollama(args, prompt: str, role: str, think: bool | None = None) -> str:
    profile = dict(PROFILES[role])
    if think is None:
        think = profile.pop("think")
    else:
        profile.pop("think")

    budget = args.num_ctx - RESERVED_TOKENS
    estimate = len(prompt) / CHARS_PER_TOKEN
    if estimate > budget:
        raise ContextOverflow(
            f"~{estimate:.0f} tokens against a budget of {budget}"
        )

    payload = json.dumps({
        "model": args.model,
        "prompt": prompt,
        "stream": False,
        "think": think,
        "options": {
            "num_ctx": args.num_ctx,
            "num_predict": RESERVED_TOKENS,
            "presence_penalty": 0.0,
            **profile,
        },
    }).encode()
    req = urllib.request.Request(
        OLLAMA_URL, data=payload, headers={"Content-Type": "application/json"}
    )
    try:
        with urllib.request.urlopen(req) as resp:
            body = json.load(resp)
    except urllib.error.HTTPError as exc:
        detail = exc.read().decode(errors="replace")
        if think and "think" in detail.lower():  # model has no thinking mode
            return run_ollama(args, prompt, role, think=False)
        sys.exit(f"ollama returned HTTP {exc.code}:\n{detail}")
    except urllib.error.URLError as exc:
        sys.exit(f"Could not reach ollama at {OLLAMA_URL}: {exc.reason}\n"
                 f"Is `ollama serve` running?")

    # Ground truth beats the estimate: if ollama actually filled the window then
    # it truncated, and whatever came back is an answer to a mutilated prompt.
    used = body.get("prompt_eval_count", 0)
    if used >= args.num_ctx:
        raise ContextOverflow(f"ollama truncated the prompt at {used} tokens")
    return THINK_RE.sub("", body.get("response", ""))


# ---------------------------------------------------------------------------
# The Physlib checkout
# ---------------------------------------------------------------------------

CLONE_TIMEOUT = 600  # a first clone pulls the whole library
FETCH_TIMEOUT = 120  # a shallow update should be quick or not at all


def _git(*cmd: str, timeout: int):
    """Run git, returning None if it hangs -- a stall is a network failure too."""
    try:
        return subprocess.run(
            ["git", *cmd], capture_output=True, text=True, timeout=timeout
        )
    except subprocess.TimeoutExpired:
        return None


def _ok(proc) -> bool:
    return proc is not None and proc.returncode == 0


def ensure_physlib(checkout: Path) -> None:
    """Make sure `checkout` holds an up-to-date Physlib clone.

    Clone it if it is missing, fast-forward it if it is already there. We never
    write to the checkout, so updating is a hard reset onto upstream rather than
    a merge -- there is no local work to preserve and nothing to conflict.

    Being offline is only fatal when there is nothing to fall back on. With a
    clone already on disk the hunt carries on against whatever it last synced
    to; with no clone there is no documentation to review at all.
    """
    if (checkout / ".git").is_dir():
        head = _git("-C", str(checkout), "rev-parse", "--abbrev-ref", "HEAD", timeout=30)
        branch = head.stdout.strip() if _ok(head) else FALLBACK_BRANCH
        before = _git("-C", str(checkout), "rev-parse", "HEAD", timeout=30)
        print(f"{BOLD}Physlib:{OFF} {checkout} {DIM}(checking for updates){OFF}")

        fetched = _git("-C", str(checkout), "fetch", "--depth", "1", "origin", branch,
                       timeout=FETCH_TIMEOUT)
        if not _ok(fetched):
            stamp = _git("-C", str(checkout), "log", "-1", "--format=%h, %cd",
                         "--date=short", timeout=30)
            when = stamp.stdout.strip() if _ok(stamp) else "unknown revision"
            print(f"  {DIM}cannot reach {PHYSLIB_URL}; working offline from the "
                  f"checkout on disk ({when}){OFF}")
            return

        reset = _git("-C", str(checkout), "reset", "--hard", "FETCH_HEAD", timeout=60)
        if not _ok(reset):
            detail = (reset.stderr.strip() if reset else "git reset timed out")
            sys.exit(f"Could not update the Physlib checkout at {checkout}:\n  {detail}\n"
                     f"Delete it and let this script clone it again.")
        after = _git("-C", str(checkout), "rev-parse", "HEAD", timeout=30)
        sha = after.stdout.strip()[:8] if _ok(after) else "?"
        moved = _ok(before) and _ok(after) and before.stdout != after.stdout
        print(f"  {DIM}{'updated to' if moved else 'already up to date at'} "
              f"{sha} on {branch}{OFF}")
        return

    if checkout.exists() and any(checkout.iterdir()):
        sys.exit(f"{checkout} already exists but is not a git checkout.\n"
                 f"Move it aside, or point --physlib at a Physlib checkout of your own.")

    print(f"{BOLD}Physlib:{OFF} cloning {PHYSLIB_URL}\n"
          f"  into {checkout} {DIM}(first run; this takes a minute){OFF}")
    checkout.parent.mkdir(parents=True, exist_ok=True)
    cloned = _git("clone", "--depth", "1", PHYSLIB_URL, str(checkout),
                  timeout=CLONE_TIMEOUT)
    if not _ok(cloned):
        detail = "the clone timed out" if cloned is None else (
            cloned.stderr.strip() or "git clone failed")
        sys.exit(f"\nCould not clone Physlib from {PHYSLIB_URL}:\n  {detail}\n\n"
                 f"There is no checkout at {checkout} to fall back on, so there is "
                 f"nothing to review. Connect to the internet once so it can be "
                 f"cloned, or point --physlib at a checkout you already have.")
    print(f"  {DIM}cloned{OFF}")


# ---------------------------------------------------------------------------
# Lean file helpers
# ---------------------------------------------------------------------------


def lean_files() -> list[Path]:
    files = sorted(PHYSLIB.rglob("*.lean"))
    if not files:
        sys.exit(f"No .lean files found under {PHYSLIB}")
    return files


def locate(text: str, quote: str) -> tuple[int, int] | None:
    """Find `quote` in `text`, tolerating whitespace differences.

    The model reliably reproduces the words but often reflows the line breaks
    and indentation, so an exact match alone rejects too many good candidates.
    Returns None unless the quote is found exactly once.
    """
    quote = quote.strip()
    if not quote:
        return None
    if text.count(quote) == 1:
        i = text.index(quote)
        return i, i + len(quote)
    loose = r"\s+".join(re.escape(w) for w in quote.split())
    matches = list(re.finditer(loose, text))
    return (matches[0].start(), matches[0].end()) if len(matches) == 1 else None


def tag(name: str, text: str) -> str | None:
    m = re.search(rf"<{name}>(.*?)</{name}>", text, re.S)
    return m.group(1).strip("\n") if m else None


def git(*cmd: str) -> str | None:
    proc = subprocess.run(
        ["git", "-C", str(PHYSLIB.parent), *cmd], capture_output=True, text=True
    )
    return proc.stdout.strip() if proc.returncode == 0 else None


def upstream_repo() -> tuple[str, str]:
    """(repo web URL, default branch), preferring `upstream` over `origin`."""
    for remote in ("upstream", "origin"):
        url = git("remote", "get-url", remote)
        if not url:
            continue
        url = re.sub(r"^git@github\.com:", "https://github.com/", url.strip())
        url = re.sub(r"\.git$", "", url)
        head = git("symbolic-ref", "--short", f"refs/remotes/{remote}/HEAD")
        branch = head.split("/")[-1] if head else FALLBACK_BRANCH
        return url, branch
    return FALLBACK_REPO, FALLBACK_BRANCH


def tidy_title(raw: str) -> str:
    title = raw.strip().splitlines()[0].strip() if raw.strip() else ""
    title = title.strip('"').rstrip(".").strip()
    if len(title) > 80:  # cut on a word boundary, not mid-word
        title = title[:80].rsplit(" ", 1)[0].rstrip(" ,;:-")
    if title.count('"') % 2:  # drop a quote the truncation left unbalanced
        title = title[::-1].replace('"', "", 1)[::-1].strip()
    return title


def unescape_markdown(text: str) -> str:
    """The model sometimes backslash-escapes markdown that needs to stay live."""
    return re.sub(r"\\([`*_])", r"\1", text)


def build_issue(args, path: Path, original: str, span: tuple[int, int],
                quote: str, why: str, fix: str, votes: int, jurors: int) -> str:
    """Compose ready-to-paste GitHub issue text for a confirmed mistake."""
    rel = path.relative_to(PHYSLIB.parent).as_posix()
    first, last = line_span(original, span)
    lines = f"L{first}" if first == last else f"L{first}-L{last}"
    repo, branch = upstream_repo()

    # The finder's own reasoning is rough, so have the model write the issue up
    # properly. Only the prose is model-written; the link, the quoted text and
    # the correction are spliced in from what the jury actually confirmed.
    try:
        written = run_ollama(
            args,
            ISSUE_PROMPT.format(
                path=rel, quote=quote.strip(), why=why.strip(), fix=fix.strip(), file=original
            ),
            "issue",
        )
    except ContextOverflow as exc:
        # The mistake is already confirmed; fall back to the finder's own rough
        # reasoning rather than throwing the finding away over a long file.
        print(f"  {DIM}too long to write up ({exc}); using the raw reasoning{OFF}")
        written = ""
    title = tidy_title(tag("title", written) or "") or f"Incorrect documentation in {rel}"
    explanation = unescape_markdown((tag("explanation", written) or "").strip() or why.strip())

    body = f"""\
### Summary

The documentation in [`{rel}`]({repo}/blob/{branch}/{rel}#{lines}) \
(around line {first}) is incorrect.

### Current text

```lean
{quote.strip()}
```

### Why this is wrong

{explanation}

### Suggested correction

```lean
{fix.strip()}
```

---
<sub>Found with a local LLM pass over Physlib documentation ({args.model}); \
{votes} of {jurors} independent verification runs agreed this is a genuine error \
before filing. Please sanity-check before merging.</sub>
"""
    return title, body


def print_issue(title: str, body: str) -> None:
    print(f"{BOLD}{'=' * 72}{OFF}")
    print(f"{BOLD}Ready-made GitHub issue{OFF}\n")
    print(f"{BOLD}Title:{OFF} {title}\n")
    print(body.rstrip())
    print(f"{DIM}{'-' * 72}{OFF}")


def print_diff(original: str, final: str, name: str) -> bool:
    """Print a coloured unified diff. Returns True if there were changes."""
    diff = list(
        difflib.unified_diff(
            original.splitlines(keepends=True),
            final.splitlines(keepends=True),
            fromfile=f"a/{name}",
            tofile=f"b/{name}",
        )
    )
    if not diff:
        print("(no changes)")
        return False
    for line in diff:
        line = line.rstrip("\n")
        if line.startswith("+") and not line.startswith("+++"):
            print(f"{GREEN}{line}{OFF}")
        elif line.startswith("-") and not line.startswith("---"):
            print(f"{RED}{line}{OFF}")
        elif line.startswith("@@"):
            print(f"{CYAN}{line}{OFF}")
        else:
            print(line)
    return True


# ---------------------------------------------------------------------------
# Report
# ---------------------------------------------------------------------------


class _BlockDumper(yaml.SafeDumper):
    """Emits multi-line strings as `|-` literal blocks so Lean stays readable."""


def _block_str(dumper, data):
    style = "|" if "\n" in data else None
    return dumper.represent_scalar("tag:yaml.org,2002:str", data, style=style)


_BlockDumper.add_representer(str, _block_str)


def line_span(text: str, span: tuple[int, int]) -> tuple[int, int]:
    """1-based (first, last) line numbers covered by a character span."""
    return text.count("\n", 0, span[0]) + 1, text.count("\n", 0, span[1]) + 1


def finding_id(rel: str, quote: str) -> str:
    """Stable identity for a finding: its file plus its normalised quote.

    The model reflows whitespace between runs, so the raw quote is not a stable
    key -- collapsing runs of whitespace makes the same claim hash the same way
    whether or not it came back re-wrapped.
    """
    seed = f"{rel}\x00{' '.join(quote.split())}"
    return hashlib.sha1(seed.encode()).hexdigest()[:12]


def load_report(path: Path) -> list[dict]:
    if not path.exists():
        return []
    try:
        loaded = yaml.safe_load(path.read_text()) or []
    except yaml.YAMLError as exc:
        sys.exit(f"{path} is not valid YAML:\n{exc}")
    if not isinstance(loaded, list):
        sys.exit(f"{path} should hold a YAML list of findings, "
                 f"got {type(loaded).__name__}")
    return [e for e in loaded if isinstance(e, dict)]


class Report:
    """Append-only YAML list of confirmed findings, de-duplicated on the way in."""

    def __init__(self, path: Path):
        self.path = path
        self.entries = load_report(path)
        self.ids = {e.get("id") for e in self.entries if e.get("id")}
        self.spans: dict[str, list[tuple[int, int, str]]] = {}
        for e in self.entries:
            self.spans.setdefault(str(e.get("file", "")), []).append(
                (int(e.get("first_line") or 0), int(e.get("last_line") or 0),
                 str(e.get("id") or "?"))
            )

    def duplicate_of(self, rel: str, key: str, first: int, last: int) -> str | None:
        """Return the id this finding duplicates, or None if it is new.

        Two tests, because the model rarely quotes the same span twice running:
        an exact match on the normalised quote, and any overlap of line ranges
        within one file. The second is deliberately aggressive -- two findings
        on the same lines are nearly always the same complaint reworded, and a
        missed error costs far less here than a report full of near-duplicates.
        """
        if key in self.ids:
            return key
        for other_first, other_last, other_id in self.spans.get(rel, []):
            if first <= other_last and other_first <= last:
                return other_id
        return None

    def add(self, entry: dict) -> None:
        new = not self.path.exists()
        self.path.parent.mkdir(parents=True, exist_ok=True)
        with self.path.open("a", encoding="utf-8") as fh:
            if new:
                fh.write("# Physlib documentation mistakes found by a local LLM.\n"
                         "# Appended to by scripts/PhyslibDocImprover.py; every entry\n"
                         "# was confirmed by a jury. Sanity-check before filing.\n")
            fh.write(yaml.dump([entry], Dumper=_BlockDumper, sort_keys=False,
                               allow_unicode=True, width=88))
        self.entries.append(entry)
        self.ids.add(entry["id"])
        self.spans.setdefault(entry["file"], []).append(
            (entry["first_line"], entry["last_line"], entry["id"])
        )


def check_report(path: Path) -> int:
    """Verify no finding in the report duplicates another. Exit code for main."""
    entries = load_report(path)
    if not entries:
        print(f"{path}: nothing to check (no findings yet).")
        return 0

    by_id: dict[str, list[int]] = {}
    for i, e in enumerate(entries, start=1):
        key = e.get("id") or finding_id(str(e.get("file", "")), str(e.get("quote", "")))
        by_id.setdefault(str(key), []).append(i)
    exact = {k: v for k, v in by_id.items() if len(v) > 1}

    overlaps = []
    by_file: dict[str, list[tuple[int, int, int, str]]] = {}
    for i, e in enumerate(entries, start=1):
        by_file.setdefault(str(e.get("file", "")), []).append(
            (int(e.get("first_line") or 0), int(e.get("last_line") or 0), i,
             str(e.get("id") or "?"))
        )
    for rel, items in by_file.items():
        for a in range(len(items)):
            for b in range(a + 1, len(items)):
                (fa, la, ia, ida), (fb, lb, ib, idb) = items[a], items[b]
                if ida != idb and fa <= lb and fb <= la:
                    overlaps.append((rel, ia, ida, ib, idb))

    print(f"{path}: {len(entries)} findings, {len(by_id)} distinct ids")
    for key, rows in exact.items():
        print(f"  {RED}duplicate{OFF} id {key} at entries {rows}")
    for rel, ia, ida, ib, idb in overlaps:
        print(f"  {DIM}overlap{OFF}   {rel}: entry {ia} ({ida}) and {ib} ({idb}) "
              f"cover the same lines")
    if not exact and not overlaps:
        print(f"  {GREEN}no duplicates{OFF}")
        return 0
    return 1 if exact else 0


# ---------------------------------------------------------------------------
# Task: find-mistake
# ---------------------------------------------------------------------------


def candidate_files(args, rng):
    """Yield files to examine, forever, until the caller stops asking.

    With `--file`, that one file over and over -- the model is stochastic, so a
    later pass may spot what an earlier one missed. Otherwise a reshuffled
    sweep of the whole tree each pass.
    """
    if args.file:
        path = choose_file(args)
        while True:
            yield path
    pool = lean_files()
    while True:
        rng.shuffle(pool)
        yield from pool


def task_find_mistake(args, rng) -> int:
    """Sweep files for ever, appending every confirmed mistake to the report.

    Returns the number of new findings recorded this session.
    """
    threshold = min(args.threshold or args.rounds, args.rounds)
    cap = args.attempts or None
    verdict_rule = "unanimous" if threshold == args.rounds else f"{threshold} to convict"
    report = Report(args.report)
    found = skipped = examined = 0

    print(f"{BOLD}Task:{OFF}   find-mistake "
          f"({cap or 'unlimited'} attempts, {args.rounds} jurors, {verdict_rule})")
    print(f"{BOLD}Report:{OFF} {args.report} "
          f"({len(report.entries)} finding{'' if len(report.entries) == 1 else 's'} already)")
    print(f"{DIM}Runs until you stop it with Ctrl-C.{OFF}\n")

    for attempt, path in enumerate(candidate_files(args, rng), start=1):
        if cap and attempt > cap:
            break
        examined += 1
        original = path.read_text()
        rel = path.relative_to(PHYSLIB.parent).as_posix()
        tally = f"{found} found" + (f", {skipped} already known" if skipped else "")
        print(f"{BOLD}[{attempt}{'/' + str(cap) if cap else ''}]{OFF} {rel} "
              f"{DIM}({tally}){OFF}")

        print("  searching ...", end="", flush=True)
        try:
            proposal = run_ollama(args, FIND_PROMPT.format(file=original), "find")
        except ContextOverflow as exc:
            print(f" {DIM}will not fit the context window ({exc}), skipping{OFF}")
            continue
        quote = tag("quote", proposal)
        why = tag("why", proposal)
        fix = tag("fix", proposal)
        if not quote or fix is None:
            print(f" {DIM}no mistake proposed{OFF}")
            continue
        span = locate(original, quote)
        if span is None:
            print(f" {DIM}quote not found in the file (or ambiguous), skipping{OFF}")
            continue
        # A fix that adds or drops comment delimiters would rewrite Lean code as
        # documentation (or vice versa) -- never a legitimate doc correction.
        if [quote.count(d) for d in ("/-", "-/")] != [fix.count(d) for d in ("/-", "-/")]:
            print(f" {DIM}fix alters comment delimiters, skipping{OFF}")
            continue

        # Check the report *before* convening the jury: re-confirming something
        # already recorded is the most expensive way to learn nothing.
        first, last = line_span(original, span)
        key = finding_id(rel, quote)
        already = report.duplicate_of(rel, key, first, last)
        if already:
            skipped += 1
            print(f" {DIM}already reported as {already}, skipping{OFF}")
            continue

        print(" candidate found")
        print(f"  {RED}wrong:{OFF} {quote.strip()[:200]}")
        print(f"  {GREEN}fix:  {OFF} {fix.strip()[:200]}")
        print(f"  {DIM}why:   {(why or '').strip()[:300]}{OFF}")

        votes = n = 0
        try:
            for n in range(1, args.rounds + 1):
                verdict = run_ollama(
                    args,
                    VERIFY_PROMPT.format(file=original, quote=quote, why=why or "", fix=fix),
                    "verify",
                )
                agrees = re.search(r"VERDICT:\s*MISTAKE", verdict, re.I) is not None
                votes += agrees
                print(f"  juror {n}/{args.rounds}: "
                      f"{(GREEN + 'mistake' if agrees else DIM + 'fine') + OFF} "
                      f"({votes}/{n} so far)")
                # Early exit once the outcome can no longer change.
                if votes >= threshold or votes + (args.rounds - n) < threshold:
                    break
        except ContextOverflow as exc:
            # The verify prompt carries the claim on top of the file, so it can
            # overflow where the search prompt fitted. An unjudgeable candidate
            # is no candidate.
            print(f"  {DIM}jury will not fit the context window ({exc}), skipping{OFF}\n")
            continue

        if votes < threshold:
            print(f"  {DIM}rejected ({votes} of {threshold} needed) "
                  f"-- back to the hunt{OFF}\n")
            continue

        print(f"  {GREEN}confirmed{OFF} ({votes}/{n} jurors)")
        print(f"  {DIM}writing up the issue ...{OFF}")
        title, body = build_issue(
            args, path, original, span, quote, why or "", fix, votes, n
        )
        repo, branch = upstream_repo()
        lines = f"L{first}" if first == last else f"L{first}-L{last}"
        report.add({
            "id": key,
            "found": datetime.now().astimezone().isoformat(timespec="seconds"),
            "file": rel,
            "first_line": first,
            "last_line": last,
            "permalink": f"{repo}/blob/{branch}/{rel}#{lines}",
            "model": args.model,
            "jurors": f"{votes}/{n}",
            "quote": quote.strip(),
            "why": (why or "").strip(),
            "fix": fix.strip(),
            "issue_title": title,
            "issue_body": body.rstrip(),
        })
        found += 1
        print(f"  {GREEN}recorded as {key}{OFF} in {args.report}\n")
        print_diff(original,
                   original[: span[0]] + fix.strip() + original[span[1]:],
                   path.name)
        if args.show_issue:
            print_issue(title, body)
        print()

    print(f"\nStopped after {examined} file{'' if examined == 1 else 's'}"
          f"{f', {skipped} candidate(s) already reported' if skipped else ''}.")
    return found


# ---------------------------------------------------------------------------


def choose_file(args) -> Path:
    """Resolve `--file`, relative to the Physlib checkout if it is not absolute."""
    path = Path(args.file).expanduser()
    if not path.is_absolute():
        path = (PHYSLIB.parent / path).resolve()
    if not path.exists():
        sys.exit(f"No such file: {path}")
    return path


def main() -> None:
    global PHYSLIB
    ap = argparse.ArgumentParser(
        description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter
    )
    ap.add_argument("--file", help="Specific .lean file (default: sweep them all)")
    ap.add_argument(
        "--physlib",
        type=Path,
        help="Review an existing Physlib checkout of your own instead of the managed "
             "clone. Yours is read as-is and never fetched or reset, so local work is "
             "safe; point it at either the repository root or its Physlib/ directory",
    )
    ap.add_argument("--model", default=MODEL)
    ap.add_argument(
        "--num-ctx",
        type=int,
        default=NUM_CTX,
        help=f"Context window in tokens (default {NUM_CTX}). ollama's own default "
             f"is 4096, which silently truncates most Physlib files",
    )
    ap.add_argument(
        "--rounds",
        type=int,
        default=ROUNDS,
        help=f"Jurors voting on each candidate (default {ROUNDS})",
    )
    ap.add_argument(
        "--attempts",
        type=int,
        default=ATTEMPTS,
        help="Cap on candidate files (default: no cap, hunt until found)",
    )
    ap.add_argument(
        "--threshold",
        type=int,
        help="Jurors needed to confirm (default: all of them)",
    )
    ap.add_argument(
        "--report",
        type=Path,
        default=REPORT,
        help=f"YAML report to append findings to (default {REPORT})",
    )
    ap.add_argument(
        "--check",
        action="store_true",
        help="Check the report for duplicates and exit, without running the model",
    )
    ap.add_argument(
        "--show-issue",
        action="store_true",
        help="Also print the full GitHub issue text for each finding",
    )
    ap.add_argument("--seed", type=int, help="Seed for the file sweep order")
    args = ap.parse_args()
    args.report = args.report.expanduser()
    if args.check:
        sys.exit(check_report(args.report))
    if args.num_ctx <= RESERVED_TOKENS:
        ap.error(f"--num-ctx must exceed the {RESERVED_TOKENS} tokens reserved for "
                 f"the reply, or nothing fits; the default is {NUM_CTX}")

    if args.physlib:
        # Someone else's checkout: take it exactly as it is. Fetching or
        # resetting it could throw away work that is not ours to touch.
        checkout = args.physlib.expanduser().resolve()
        if not checkout.is_dir():
            sys.exit(f"No such Physlib checkout: {checkout}")
        inner = checkout / "Physlib"
        PHYSLIB = inner if inner.is_dir() else checkout
        print(f"{BOLD}Physlib:{OFF} {PHYSLIB} {DIM}(yours; left untouched){OFF}")
    else:
        ensure_physlib(PHYSLIB_CHECKOUT)

    print(f"{BOLD}Model:{OFF}  {args.model} ({args.num_ctx} ctx)")
    # Count from the report rather than the return value: Ctrl-C unwinds the
    # hunt before it can report back, and findings already on disk still count.
    before = len(load_report(args.report))
    try:
        task_find_mistake(args, random.Random(args.seed))
    except KeyboardInterrupt:
        print("\n\nStopped.")
    except ContextOverflow as exc:
        sys.exit(f"\nThis file does not fit the context window: {exc}\n"
                 f"Re-run with a larger --num-ctx.")

    total = len(load_report(args.report))
    found = total - before
    print(f"{BOLD}{found}{OFF} new finding{'' if found == 1 else 's'} this session; "
          f"{total} in {args.report}")
    if found:
        print(f"{DIM}Review them before filing -- confirmed by the jury is not "
              f"the same as correct.{OFF}")


if __name__ == "__main__":
    main()
