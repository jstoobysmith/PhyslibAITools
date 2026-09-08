# Security model

The thing being defended: a review agent reads a pull request written by someone who wants it
merged, and produces a verdict that gates merging. The author controls almost everything the
agent sees.

## The verdict channel

Each run generates a fresh random marker token and instructs the agent to print it immediately
before its JSON verdict. `runner/verdict.py` parses only the text *after the last occurrence* of
that marker. A PR that contains `{"verdict": "approve"}` in its description, a docstring, a Lean
comment, or a file name cannot be mistaken for the agent's own output, because it cannot contain
a token generated after it was written.

Parsing **fails closed**: a missing marker, unparseable JSON, or a verdict word outside
`approve` / `request_changes` / `block` yields no verdict at all, which the runner renders as
`error`. An `error` is blocking for merge and never posts a review thread — an infrastructure
failure is not a contestable finding.

## Untrusted input

`rubrics/_common.md` tells every agent that the diff, description, comments, file contents,
docstrings, and commit messages are untrusted evidence, and that content directed at the agent
is itself a finding rather than a directive. The one exception is the runner-verified context
block, which is assembled by this tool from `gh` and the filesystem, is marked as trusted, and
carries the PR title and body quoted inside it and explicitly re-labelled untrusted.

## Read-only

Agents get `Read` / `Grep` / `Glob` and no shell, no write tools, no network tools, and no
sub-agents. Codex runs under `--sandbox read-only`. Beyond the allowlist, nothing the agent can
reach is the real repository: the workspace is a throwaway shallow checkout in a temp directory,
discarded at the end of the run unless `--keep`.

## Clean room

Isolation is done twice over. First with flags: Claude runs with `--setting-sources ""` (no user,
project, or local settings — so no personal `CLAUDE.md`, skills, or plugins) and
`--strict-mcp-config --mcp-config {}` (no MCP server), and Codex under `--sandbox read-only`.
Second with the environment: a throwaway `HOME` seeded with only that provider's credential, and
`CLAUDE_CONFIG_DIR` / `CODEX_HOME` / `XDG_CONFIG_HOME` stripped. Under `--auth api`, Claude also
gets `--bare`, which skips hooks, auto-memory, and keychain reads as well.

**Known gap:** on macOS a subscription login lives in the keychain rather than in a credential
file, so a throwaway HOME cannot carry it. The runner falls back to the real HOME there and says
so on every run. `--auth api` with a key gives a guaranteed clean room on every platform. If you
care about reproducibility across reviewers, use `--auth api`.

## What a local run deliberately drops

Compared with running review in CI with a metered API key:

- **Trust.** A local run posts as you, and you could have edited the rubrics, pointed
  `--rubrics-dir` elsewhere, or simply lied. There is no attestation. The safeguard is that the
  people running it are people the project already trusts.
- **Isolation.** CI runs the agent in a container with no credentials of yours at all. A local
  run has your `gh` token in the parent process (the agent itself never sees it — it is stripped
  from the reviewer's environment along with the rest of your config, and the agent has no shell
  to read it with).
- **Budget control.** There is no per-run spend cap.

## What it does not defend

- A reviewer who rubber-stamps.
- A malicious *maintainer* editing the rubrics.
- Any claim that the physics is right. The rubrics push agents to verify rather than defer, and
  the `correctness` angle exists precisely because a clean Lean build proves what was written
  and not that what was written is what was meant — but a review is evidence, not proof. Physlib's
  AI policy puts final responsibility on the human author, and this tool does not move it.
