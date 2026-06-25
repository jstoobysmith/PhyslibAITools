# Physlib AI Tools

## Scripts/physlib-auto-task.sh

A generic one-shot harness that uses [Claude Code](https://docs.claude.com/en/docs/claude-code/overview)
to run an automated task against [Physlib](https://github.com/leanprover-community/physlib)
and open a pull request with the result. The surrounding setup is the same for
every task; only the task prompt differs, so the one script can drive many
different automated contributions.

The default task is **Golf**: find one theorem or lemma with a long proof and golf
it for length, speed, and structure — without changing any theorem, lemma, or
definition statement — then verify the project still builds before opening the PR.

Given a fresh machine, it will:

1. Install anything missing — Lean (`elan`/`lake`), the GitHub CLI (`gh`), `uv`,
   and Claude Code.
2. Sign you in to GitHub if you aren't already.
3. Refuse to run if more than `MAX_OPEN_AUTO_PRS` (default 10) automated PRs (open
   PRs whose title starts with `auto-`) are already open upstream, so a fleet of
   runs can't flood the maintainers.
4. Fork and clone Physlib into `physlib-auto/` (reusing the checkout if it exists).
5. Create a fresh work branch off `upstream/master`.
6. Fetch the Mathlib cache and build the project (the first build can take 10+
   minutes).
7. Register the `lean-lsp-mcp` server with Claude Code.
8. Load the task prompt from `Tasks/<Task>.md` (a local copy if found, otherwise
   fetched from this repo) and launch Claude to carry it out.
9. Show you the staged diff and ask for confirmation before committing, pushing,
   and opening the pull request (Claude writes the PR title and body).

### Requirements

- **A paid Claude plan** — Claude Pro/Max, or an Anthropic API account with credits.
  The free tier cannot run Claude Code.
- **A GitHub account**, used to fork Physlib and open the PR.
- **`git` and `curl`** must already be present (the script exits if either is
  missing).
- **macOS (with Homebrew) or Debian/Ubuntu (with apt)** for the auto-install paths.
  On other systems, install `gh` and Claude Code yourself first, then re-run.
- **`npm`** is needed to auto-install Claude Code (skip if it's already installed).
- Disk space and time for a full Mathlib build on the first run.

Everything else (`elan`/`lake`, `gh`, `uv`, Claude Code) is installed automatically
if missing.

### Usage

By default the script runs **fully automatically** — Claude runs headless, finishes
on its own, and the PR is pushed without prompting (see the requirements under
[Auto mode](#auto-mode-default) below). The quickest way, run the default (Golf)
task straight from GitHub:

```bash
curl -fsSL https://raw.githubusercontent.com/jstoobysmith/PhyslibAITools/main/Scripts/physlib-auto-task.sh | bash
```

Or, if you've already cloned this repo:

```bash
./Scripts/physlib-auto-task.sh             # automatic, default task (Golf)
./Scripts/physlib-auto-task.sh Generalize  # automatic, a specific task
./Scripts/physlib-auto-task.sh --manual    # interactive: pick a task, confirm before pushing
```

Run it from wherever you want the `physlib-auto/` checkout to be created. If a
`./physlib-auto` folder already exists in the current directory it is reused
instead of cloning again; otherwise a fresh fork is cloned into it. The script
always works in that dedicated checkout, never in whatever directory you launch
from.

#### Choosing a task

Tasks live in [`Tasks/`](Tasks/) as `Tasks/<Name>.md` — each file is the prompt for
one task. Pick one with the first argument or the `TASK` environment variable; if
you give neither, the default `Golf` is used (in `--manual` mode the script instead
lists the available tasks and asks you to choose).

```bash
TASK=Golf ./Scripts/physlib-auto-task.sh
```

To add a new task, drop a `Tasks/<Name>.md` prompt file in this repo — no change to
the script is needed. The PR title/body handoff is standard and added by the script
for every task (titles use the form `auto-<task>(<subject>): <description>`).

#### Auto mode (default)

Auto mode is the **default**: the script runs start-to-finish with no human in the
loop — Claude runs headless and exits on its own when finished, and the push/PR step
auto-confirms. Nothing extra is needed to enable it:

```bash
curl -fsSL https://raw.githubusercontent.com/jstoobysmith/PhyslibAITools/main/Scripts/physlib-auto-task.sh | bash
```

To run **interactively** instead — Claude opens in its TUI and you confirm before
anything is pushed — pass `--manual` / `-i` (or set `AUTO=0`):

```bash
./Scripts/physlib-auto-task.sh --manual
```

Auto mode requires a bit of setup, since nothing can prompt you:

- **GitHub must already be authenticated** (`gh auth login`, or a `GH_TOKEN` in the
  environment). The script exits early if it isn't.
- **Claude Code must already be signed in** (or `ANTHROPIC_API_KEY` /
  `CLAUDE_CODE_OAUTH_TOKEN` set) — headless mode won't do an interactive login.
- Claude runs with `--permission-mode bypassPermissions`, so it edits files and runs
  `lake`/`gh` **without per-action approval**. Tasks are tightly scoped and leave the
  PR text empty — which the script treats as "don't push" — if they can't finish,
  but Claude is still running unattended. It's intended for the throwaway
  `physlib-auto/` checkout the script creates.

#### Environment variables

| Variable | Effect |
| --- | --- |
| `TASK` | Which task to run (e.g. `Golf`); defaults to `Golf` (in `--manual` mode you're asked). |
| `AUTO` | Auto mode, on by default (`AUTO=1`). Set `AUTO=0` (or pass `--manual` / `-i`) for an interactive run. |
| `MAX_OPEN_AUTO_PRS` | Cap on concurrent open automated PRs before the script refuses to run (default `10`). |
| `NO_COLOR` | Disable coloured output. |
| `FORCE_COLOR` | Force coloured output on even when stdout isn't detected as a terminal. |

### Step-by-step

1. **Get the script.** Clone this repo (or download `Scripts/physlib-auto-task.sh`),
   and make it executable if needed: `chmod +x Scripts/physlib-auto-task.sh`.
2. **Run it:** `./Scripts/physlib-auto-task.sh`, from the directory where you want
   the `physlib-auto/` checkout created.
3. **Pick a task** if you didn't pass one — the script lists the tasks in `Tasks/`
   and lets you choose by number or name.
4. **Authenticate if prompted.** If you aren't already signed in, `gh auth login`
   runs interactively — follow its prompts to sign in to GitHub. You may also need
   to log in to Claude Code the first time.
5. **Wait through install + build.** On a fresh machine the script installs the
   toolchain, fetches the Mathlib cache, and builds Physlib — the first build can
   take 10+ minutes. (It only needs to do this once.)
6. **Let Claude do the work.** Claude carries out the task and iterates until the
   build succeeds. Grant it the permissions it needs to read/edit files and run
   `lake`/`gh`. Read its summary of what it changed.
7. **Quit Claude when it says it's done.** The script pauses while Claude runs and
   resumes automatically once you exit (Claude tells you to quit when finished). In
   auto mode this is automatic.
8. **Review the proposed PR.** The script prints the PR title and the staged diff
   stat, then prompts `Push '<branch>' and open this PR ... [Y/n]`. Inspect the
   diff. Answer `n` to keep the changes staged locally without pushing, or accept
   to push the branch to your fork and open a PR against
   `leanprover-community/physlib`.
9. **Check the opened PR.** Open the PR link, confirm the diff, title, and body
   look correct, and that CI passes before asking for review.

---

> **Note:** `Scripts/auto-golf.sh` and `Scripts/auto-lint.sh` are the earlier,
> single-purpose versions of this harness and are now superseded by
> `physlib-auto-task.sh` (the Golf task, and a future Lint task, cover what they
> did). They are kept only for reference.
