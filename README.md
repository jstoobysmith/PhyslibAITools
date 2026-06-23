# Physlib AI Tools

## Scripts/auto-golf.sh

A script that uses [Claude Code](https://docs.claude.com/en/docs/claude-code/overview)
to "golf" a single long proof in [Physlib](https://github.com/leanprover-community/physlib)
— improving it for length, speed, and structure without changing any theorem,
lemma, or definition statement — and open a pull request for the change.

It shares the same setup as `auto-lint.sh` (install toolchain, fork/clone, build,
register `lean-lsp-mcp`), but instead of fixing a linter-exempted file it launches
Claude to find exactly one theorem or lemma with a long proof, golf only that
proof, and verify the project still builds before opening the PR.

### Usage

The quickest way just run:

```bash
curl -fsSL https://raw.githubusercontent.com/jstoobysmith/PhyslibAITools/main/Scripts/auto-golf.sh | bash
```

Or, if you've already cloned this repo:

```bash
./Scripts/auto-golf.sh
```

## Scripts/auto-lint.sh

A script that uses [Claude Code](https://docs.claude.com/en/docs/claude-code/overview)
to fix a single linter-exempted file in [Physlib](https://github.com/leanprover-community/physlib)
and open a pull request for the fix.

Given a fresh machine, it will:

1. Install anything missing — Lean (`elan`/`lake`), the GitHub CLI (`gh`), `uv`,
   Claude Code, and (optionally) `ripgrep`.
2. Sign you in to GitHub if you aren't already.
3. Fork and clone Physlib into `physlib-auto/` (reusing the checkout if it exists).
4. Create a fresh work branch off `upstream/master`.
5. Fetch the Mathlib cache and build the project (the first build can take 10+
   minutes).
6. Register the `lean-lsp-mcp` server with Claude Code.
7. Launch Claude to pick one file from `scripts/LinterExemption.txt`, fix it until
   `lake exe runPhyslibLinters` and `./scripts/lint-style.sh` both pass, and remove
   its line from the exemption list.
8. Show you the staged diff and ask for confirmation before committing, pushing,
   and opening the pull request (Claude writes the PR title and body).

### Requirements

- **macOS (with Homebrew) or Debian/Ubuntu (with apt)** for the auto-install paths.
  On other systems, install `gh` and Claude Code yourself first, then re-run.
- **`git` and `curl`** must already be present (the script exits if either is
  missing).
- **`npm`** is needed to auto-install Claude Code (skip if Claude Code is already
  installed).
- **A GitHub account**, used to fork Physlib and open the PR.
- **A Claude Code login / API access**, since the fixing step runs Claude.
- Disk space and time for a full Mathlib build on the first run.

Everything else (`elan`/`lake`, `gh`, `uv`, `ripgrep`) is installed automatically
if missing.

### Usage

The quickest way just run:

```bash
curl -fsSL https://raw.githubusercontent.com/jstoobysmith/PhyslibAITools/main/Scripts/auto-lint.sh | bash
```

Or, if you've already cloned this repo:

```bash
./Scripts/auto-lint.sh
```

Run it from wherever you want the `physlib-auto/` checkout to be created. If you
run it from inside an existing Lean project directory (one containing a
`lakefile.toml` or `lakefile.lean`), it uses that directory instead of cloning.

### Step-by-step

1. **Get the script.** Clone this repo (or download just `Scripts/auto-lint.sh`),
   and make it executable if needed: `chmod +x Scripts/auto-lint.sh`.
2. **Run it:** `./Scripts/auto-lint.sh`. Run it from the directory where you want
   the `physlib-auto/` checkout created.
3. **Authenticate if prompted.** If you aren't already signed in, `gh auth login`
   runs interactively — follow its prompts to sign in to GitHub. You may also need
   to log in to Claude Code the first time.
4. **Wait through install + build.** On a fresh machine the script installs the
   toolchain, fetches the Mathlib cache, and builds Physlib — the first build can
   take 10+ minutes. (It will only need to do this for one run)
5. **Let Claude do the fix.** When Claude launches it picks one file from
   `scripts/LinterExemption.txt` and iterates until the build and both required
   linters (`lake exe runPhyslibLinters` and `./scripts/lint-style.sh`) pass.
   Grant it the permissions it needs to read/edit the file, run `lake`, and run the
   linters. Read its summary of which file it fixed.
6. **Quit Claude when it says it's done.** The script pauses while Claude runs and
   resumes automatically once you exit (Claude will tell you to quit when finished).
7. **Review the proposed PR.** The script prints the PR title and the staged diff
   stat, then prompts `Push '<branch>' and open this PR ... [Y/n]`. Inspect the
   diff. Answer `n` to keep the changes staged locally without pushing, or accept
   to push the branch to your fork and open a PR against
   `leanprover-community/physlib`.
8. **Check the opened PR.** Open the PR link, confirm the diff, title, and body
   look correct, and that CI passes before asking for review. Check also the content
