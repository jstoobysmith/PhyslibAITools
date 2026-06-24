#!/usr/bin/env bash
#
# auto-golf.sh - one-shot setup + proof golf for Physlib
# (https://github.com/leanprover-community/physlib)
#
# Installing anything that's missing, it will:
#   1. Install Lean (elan), the GitHub CLI (gh), uv, and Claude Code
#   2. Sign you in to GitHub if needed
#   3. Fork + clone Physlib
#   4. Fetch the Mathlib cache and build the project (slow the first time)
#   5. Register the lean-lsp-mcp server with Claude Code
#   6. Launch Claude to pick one long proof and golf it (without changing any
#      theorem, lemma, or definition statement)
#   7. Commit the change and open a pull request (Claude writes the title + body)
#
# It shows you the staged diff and asks for confirmation before pushing and
# opening the PR, so nothing leaves your machine without your OK.
#
# Auto-install paths are tested for macOS (Homebrew) and Debian/Ubuntu (apt).
# On other systems, install gh and Claude Code yourself first, then re-run.
 
set -euo pipefail
 
log()  { printf '\n\033[1;34m==>\033[0m %s\n' "$*"; }
warn() { printf '\033[1;33m[warn]\033[0m %s\n' "$*"; }
die()  { printf '\033[1;31m[error]\033[0m %s\n' "$*" >&2; exit 1; }
have() { command -v "$1" >/dev/null 2>&1; }
 
OS="$(uname -s)"

# Make tools installed in non-default locations visible to the checks below, so
# the preflight reflects reality even before the install steps re-export PATH.
export PATH="$HOME/.elan/bin:$HOME/.local/bin:$PATH"
have npm && export PATH="$(npm prefix -g 2>/dev/null)/bin:$PATH" || true

# Checkbox line:  check <ok|missing|info> <label>
#   ok      -> green [x]   (ready)
#   missing -> red   [ ]   (the script will install / set this up below)
#   info    -> yellow[*]   (couldn't determine, or nothing needs doing)
check() {
  local state="$1"; shift
  case "$state" in
    ok)      printf '  \033[1;32m[x]\033[0m %s\n' "$*";;
    missing) printf '  \033[1;31m[ ]\033[0m %s\n' "$*";;
    *)       printf '  \033[1;33m[*]\033[0m %s\n' "$*";;
  esac
}

# Best-effort detection of a Claude Code login (no official status command).
claude_signed_in() {
  [ -f "$HOME/.claude/.credentials.json" ] && return 0
  [ -f "$HOME/.config/claude/.credentials.json" ] && return 0
  [ "$OS" = "Darwin" ] \
    && security find-generic-password -s "Claude Code-credentials" >/dev/null 2>&1 \
    && return 0
  return 1
}

# --- 0. Preflight: report the status of every prerequisite ------------------

log "Prerequisite check (anything unchecked will be installed/set up below):"

have git    && check ok "git installed"                 || check missing "git installed (REQUIRED - install it and re-run)"
have curl   && check ok "curl installed"                || check missing "curl installed (REQUIRED - install it and re-run)"
have lake   && check ok "Lean toolchain (elan/lake)"    || check missing "Lean toolchain (elan/lake)"
have gh     && check ok "GitHub CLI (gh)"               || check missing "GitHub CLI (gh)"
{ have uv || have uvx; } && check ok "uv (for lean-lsp-mcp)" || check missing "uv (for lean-lsp-mcp)"
have claude && check ok "Claude Code (claude)"          || check missing "Claude Code (claude)"

# GitHub authentication
if have gh && gh auth status >/dev/null 2>&1; then
  check ok "GitHub: signed in"
elif have gh; then
  check missing "GitHub: signed in (you'll be prompted)"
else
  check info "GitHub: sign-in pending (gh not installed yet)"
fi

# Claude Code authentication (best effort)
if have claude && claude_signed_in; then
  check ok "Claude Code: signed in"
elif have claude; then
  check info "Claude Code: sign-in not detected (you may be prompted at launch)"
else
  check info "Claude Code: sign-in pending (claude not installed yet)"
fi

# Physlib checkout / working folder
if [ -f lakefile.toml ] || [ -f lakefile.lean ]; then
  check ok "Physlib checkout (using the current directory)"
elif [ -d physlib-auto ]; then
  check ok "./physlib-auto folder (reusing existing checkout)"
else
  check info "./physlib-auto folder not found - that's OK, we'll create one"
fi

printf '\n'

# --- 1. Prerequisites -------------------------------------------------------
 
log "Checking prerequisites..."
have git  || die "git is required. Install it and re-run."
have curl || die "curl is required. Install it and re-run."
 
# Lean toolchain (elan / lake)
if ! have lake; then
  log "Installing Lean (elan)..."
  curl https://elan.lean-lang.org/elan-init.sh -sSf | sh -s -- -y
else
  log "Lean (lake) already installed."
fi
export PATH="$HOME/.elan/bin:$PATH"
have lake || die "lake not found after installing elan; open a new shell and re-run."
 
# GitHub CLI (gh)
if ! have gh; then
  log "Installing the GitHub CLI (gh)..."
  if [ "$OS" = "Darwin" ] && have brew; then
    brew install gh
  elif have apt-get; then
    curl -fsSL https://cli.github.com/packages/githubcli-archive-keyring.gpg \
      | sudo dd of=/usr/share/keyrings/githubcli-archive-keyring.gpg
    sudo chmod go+r /usr/share/keyrings/githubcli-archive-keyring.gpg
    echo "deb [arch=$(dpkg --print-architecture) signed-by=/usr/share/keyrings/githubcli-archive-keyring.gpg] https://cli.github.com/packages stable main" \
      | sudo tee /etc/apt/sources.list.d/github-cli.list >/dev/null
    sudo apt-get update -y && sudo apt-get install -y gh
  else
    die "Couldn't auto-install gh. Install from https://cli.github.com/ and re-run."
  fi
else
  log "GitHub CLI (gh) already installed."
fi
 
# uv (runner used by lean-lsp-mcp)
if ! have uv && ! have uvx; then
  log "Installing uv..."
  curl -LsSf https://astral.sh/uv/install.sh | sh
else
  log "uv already installed."
fi
export PATH="$HOME/.local/bin:$PATH"
 
# Claude Code
if ! have claude; then
  log "Installing Claude Code..."
  if have npm; then
    npm install -g @anthropic-ai/claude-code
    export PATH="$(npm prefix -g)/bin:$PATH"
  else
    die "Claude Code not found and npm unavailable. Install it from \
https://docs.claude.com/en/docs/claude-code/overview and re-run."
  fi
else
  log "Claude Code already installed."
fi

# --- 2. GitHub auth ---------------------------------------------------------
 
log "Checking GitHub authentication..."
if ! gh auth status >/dev/null 2>&1; then
  log "Signing in to GitHub..."
  gh auth login
else
  log "Already signed in to GitHub."
fi
 
# --- 3. Fork + clone --------------------------------------------------------
 
if [ -f lakefile.toml ] || [ -f lakefile.lean ]; then
  log "Already inside a Lean project directory; using it."
elif [ -d physlib-auto ]; then
  log "Reusing existing physlib-auto checkout (no re-clone)."
  cd physlib-auto
else
  log "Forking and cloning Physlib into physlib-auto..."
  # Pin the clone directory to "physlib-auto" via a git-clone arg (after --), so
  # we don't depend on what the fork happens to be named on your account.
  gh repo fork leanprover-community/physlib --clone -- physlib-auto
  cd physlib-auto
fi

# Start a fresh working branch off upstream master, so edits never land on master,
# don't stack on a leftover branch from a previous run in a reused checkout, and
# start from the latest upstream rather than a possibly-stale fork.
# (gh repo fork --clone adds an "upstream" remote pointing at leanprover-community.)
BASE="master"
if git remote get-url upstream >/dev/null 2>&1; then
  log "Fetching upstream master..."
  if git fetch upstream master 2>/dev/null; then
    BASE="upstream/master"
  else
    warn "Couldn't fetch upstream; basing the branch off local master."
  fi
else
  warn "No 'upstream' remote; basing the branch off local master."
fi
BRANCH="golf-proof-$(date +%Y%m%d-%H%M%S)"
log "Creating work branch $BRANCH off $BASE..."
git checkout -b "$BRANCH" "$BASE" 2>/dev/null \
  || { warn "Branch $BRANCH exists; checking it out."; git checkout "$BRANCH"; }

# Fail fast if there's no commit identity, rather than dying at the `git commit`
# in step 7 after the 10+ minute build. We're inside the repo we'll commit in, so
# `git config user.name` reflects the identity that commit would actually use
# (a local setting, or an inherited global/system one).
if [ -z "$(git config user.name || true)" ] || [ -z "$(git config user.email || true)" ]; then
  die "No git commit identity is configured. Set one with:
  git config --global user.name \"Your Name\"
  git config --global user.email \"you@example.com\"
then re-run this script. (To keep your email private, you can use your GitHub
noreply address, shown at https://github.com/settings/emails.)"
fi
log "Git commit identity: $(git config user.name) <$(git config user.email)>"
 
# --- 4. Build (slow the first time) ----------------------------------------
 
log "Fetching the Mathlib cache..."
lake exe cache get
log "Mathlib cache fetched."
log "Building Physlib (the first build can take 10+ minutes)..."
lake build
log "Build complete."
 
# --- 5. Register the Lean LSP MCP server -----------------------------------
 
log "Registering lean-lsp-mcp with Claude Code..."
claude mcp add lean-lsp -- uvx lean-lsp-mcp 2>/dev/null \
  && log "lean-lsp-mcp registered." \
  || warn "lean-lsp may already be registered; continuing."
 
# --- 6. Hand off to Claude --------------------------------------------------
 
# Temp files (outside the repo, so they never get committed) where Claude leaves
# the PR title and description for the script to use in step 7.
PR_TITLE_FILE="$(mktemp)"
PR_BODY_FILE="$(mktemp)"
trap 'rm -f "$PR_TITLE_FILE" "$PR_BODY_FILE"' EXIT

read -r -d '' PROMPT <<'PROMPT_EOF' || true
You're working in the Physlib repository (a Lean 4 physics library). Your task is
to "golf" (improve) EXACTLY ONE long proof. If Lean LSP tools (from lean-lsp-mcp)
are available, use them to read goal states, diagnostics, and hover info rather
than guessing.

1. Find exactly ONE theorem or lemma with a long proof. Search the Lean source
   (e.g. under Physlib/) for a single `theorem` or `lemma` whose proof is long -
   many tactic lines, lots of repetition, or obviously heavier than it needs to
   be. This whole run is about that one proof and nothing else: you change one
   proof and one proof only, and you never start or edit a second proof or file.
2. Golf that one proof, improving it along three axes:
     i)   length    - fewer lines / less repetition / more idiomatic tactics
     ii)  speed      - faster to elaborate (avoid expensive tactics like heavy
                       `simp` calls or `omega`/`decide` where a direct term works;
                       prefer targeted lemmas; you can sanity-check with
                       `set_option profiler true` or `count_heartbeats`)
     iii) structure  - clearer, more readable, following Mathlib conventions
                       (https://leanprover-community.github.io/contribute/naming.html)
3. Do NOT change any theorem, lemma, or definition STATEMENT - the signature
   (name, binders, type) of the thing you are proving must stay byte-for-byte
   identical. You are only allowed to rewrite the proof term/tactic block. Do not
   add, remove, or restate any theorem, lemma, or definition.
4. You should change ONLY that one proof. Do not edit any other proof, any other
   declaration, or any other file. Do not touch imports, docstrings, or the
   exemption list.
5. Verify: build the project (`lake build`, or the relevant `lake build Physlib`
   / `lake build QuantumInfo` target) and confirm it succeeds with your golfed
   proof in place. The proof must still close all goals with no `sorry`, no new
   axioms, and no errors or warnings introduced.

Iterate until the build succeeds with the golfed proof - that is the bar for this
PR. If you genuinely can't improve the proof while keeping the build green, stop
and tell me exactly what's blocking - don't leave the proof half-edited or
broken. Do NOT commit, push, or open a pull request yourself - the script does
that after you exit. When you're done, tell me which theorem/lemma you golfed (and
in which file), show the before/after proof, and paste the final build output.

Write a message of how to quit claude and that the script will continue after you exit claude.
PROMPT_EOF

# Where Claude should leave the PR text. These paths are dynamic, so append them
# to the (quoted) prompt above rather than embedding them in the heredoc.
PROMPT="$PROMPT

Finally, once the build passes with the golfed proof, write the pull-request
text so the script can open the PR for me:
  - A concise, conventional-commit style PR title -> write it to: $PR_TITLE_FILE
  - A clear PR description (which theorem/lemma in which file, and how you golfed
    the proof for length, speed, and structure) in Markdown -> write it to:
    $PR_BODY_FILE
Write nothing else to those two files. If you could NOT golf the proof while
keeping the build green, leave both files empty so the script knows not to open a
PR."
 
log "Launching Claude to fix a file..."
set +e
claude "$PROMPT"
set -e
 
# --- 7. Commit, push, and open the pull request ----------------------------
 
log "Reviewing what Claude changed..."
git add -A

if [ -z "$(git diff --cached --name-only)" ]; then
  warn "Claude made no changes; nothing to open a PR for. Stopping here."
  exit 0
fi

# Claude writes the PR title and body only once the build passes with the golfed
# proof; if it couldn't golf the proof while keeping the build green, it leaves
# them empty (see the prompt above). Treat empty PR text as that "couldn't finish"
# signal: keep the changes staged on the branch, but don't commit, push, or open a
# PR for an unverified golf. Verification stays with Claude in-session, where build
# errors can actually be fixed and its explanation is already on screen - rather
# than a post-hoc check that would only strand the user after Claude has exited.
TITLE="$(head -n1 "$PR_TITLE_FILE" 2>/dev/null || true)"
if [ -z "$TITLE" ] || [ ! -s "$PR_BODY_FILE" ]; then
  warn "Claude left no PR text - its signal that the proof isn't golfed yet. Your
changes are staged on '$BRANCH' but nothing was committed or pushed. Re-run Claude
on this branch to finish the golf, then re-run this script."
  exit 0
fi

log "Proposed pull request:"
printf '  Title: %s\n\n' "$TITLE"
git --no-pager diff --cached --stat
printf '\n'

read -r -p "Push '$BRANCH' and open this PR against leanprover-community/physlib? [Y/n] " REPLY
case "$REPLY" in
  [Nn]*) log "No problem - changes are staged on '$BRANCH'. Nothing pushed."; exit 0 ;;
  *) ;;
esac

log "Committing..."
git commit -m "$TITLE"
log "Pushing '$BRANCH' to your fork..."
git push -u origin "$BRANCH"

ME="$(gh api user --jq .login)"
log "Opening the pull request..."
gh pr create --repo leanprover-community/physlib --base master \
  --head "${ME}:${BRANCH}" --title "$TITLE" --body-file "$PR_BODY_FILE"
log "Done - pull request opened."
 