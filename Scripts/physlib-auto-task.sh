#!/usr/bin/env bash
#
# physlib-auto-task.sh - generic one-shot harness that runs an automated Claude
# task against Physlib (https://github.com/leanprover-community/physlib) and opens
# a pull request with the result.
#
# The surrounding setup is identical for every task; only the task prompt differs.
# Choose a task with the first argument (or the TASK env var, default "Golf"); its
# prompt is loaded from Tasks/<Task>.md - a local copy if one is found next to this
# script or under the current directory, otherwise fetched from the GitHub repo.
#
# Installing anything that's missing, it will:
#   1. Install Lean (elan), the GitHub CLI (gh), uv, and Claude Code
#   2. Sign you in to GitHub if needed
#   3. Fork + clone Physlib
#   4. Fetch the Mathlib cache and build the project (slow the first time)
#   5. Register the lean-lsp-mcp server with Claude Code
#   6. Load Tasks/<Task>.md and launch Claude to carry it out
#   7. Commit the change and open a pull request (Claude writes the title + body)
#
# It shows you the staged diff and asks for confirmation before pushing and
# opening the PR, so nothing leaves your machine without your OK.
#
# Usage:
#   ./physlib-auto-task.sh [Task] [--auto]   # e.g. ./physlib-auto-task.sh Golf
#   TASK=Golf ./physlib-auto-task.sh
#   curl -fsSL <raw-url> | bash              # runs the default task (Golf)
#
# Tasks come in two flavours, both under Tasks/:
#   * Markdown (Tasks/<Task>.md)  - just the prompt; always run against Physlib,
#     in a ./physlib-auto checkout. This is the default.
#   * YAML     (Tasks/<Task>.yaml) - the prompt PLUS the repo to fork and the local
#     checkout folder, so the same harness can target any Lean repo. A YAML task
#     must set three fields: 'repo:' (e.g. ImperialCollegeLondon/FLT), 'dir:' (the
#     checkout folder, e.g. flt-auto), and 'prompt: |' (the task text). See the
#     YAML schema note further down and the example task files.
# When both Tasks/<Task>.yaml and Tasks/<Task>.md exist, the YAML one wins.
#
# Auto-install paths are tested for macOS (Homebrew) and Debian/Ubuntu (apt).
# On other systems, install gh and Claude Code yourself first, then re-run.
 
set -euo pipefail

# Decide whether to colour output. Default: on when stdout is a real terminal and
# TERM isn't "dumb". NO_COLOR (https://no-color.org) always wins and turns it off.
# FORCE_COLOR / CLICOLOR_FORCE turn it on even when the TTY check fails - useful for
# IDE "run"/output panels and other runners that pipe output but still render ANSI.
# (If colours look wrong on a Mac, try: FORCE_COLOR=1 ./physlib-auto-task.sh)
use_color=0
if [ -n "${NO_COLOR:-}" ]; then
  use_color=0
elif [ -n "${FORCE_COLOR:-}" ] || [ -n "${CLICOLOR_FORCE:-}" ]; then
  use_color=1
elif [ -t 1 ] && [ "${TERM:-dumb}" != "dumb" ]; then
  use_color=1
fi
if [ "$use_color" = 1 ]; then
  C_RESET=$'\033[0m';   C_BOLD=$'\033[1m';      C_DIM=$'\033[2m'
  C_BLUE=$'\033[1;34m'; C_YELLOW=$'\033[1;33m'; C_RED=$'\033[1;31m'
  C_GREEN=$'\033[1;32m'; C_CYAN=$'\033[1;36m'
else
  C_RESET='';  C_BOLD='';   C_DIM=''
  C_BLUE='';   C_YELLOW=''; C_RED=''
  C_GREEN='';  C_CYAN=''
fi

log()  { printf '\n%s==>%s %s\n'   "$C_BLUE"   "$C_RESET" "$*"; }
warn() { printf '%s[warn]%s %s\n'  "$C_YELLOW" "$C_RESET" "$*"; }
die()  { printf '%s[error]%s %s\n' "$C_RED"    "$C_RESET" "$*" >&2; exit 1; }
have() { command -v "$1" >/dev/null 2>&1; }

# Temp files to delete when the script exits - a downloaded task file (resolve_task)
# and the PR-text handoff files (step 6). Registered here once so any temp we make
# is cleaned up no matter where we leave off.
CLEANUP_FILES=()
cleanup() { [ "${#CLEANUP_FILES[@]}" -gt 0 ] && rm -f "${CLEANUP_FILES[@]}"; return 0; }
trap cleanup EXIT

OS="$(uname -s)"

# Auto mode is the DEFAULT: run start-to-finish with no human in the loop. Claude
# runs headless (`claude -p`, so it finishes and exits on its own instead of waiting
# in the TUI) and the final push/PR step auto-confirms. Because nobody is there to
# approve things, auto mode REQUIRES gh and Claude Code to be signed in already, and
# it grants Claude bypass-permission tool access.
# To run interactively instead, pass --manual/-i (or set AUTO=0): Claude opens in its
# TUI (you quit it when done) and you confirm before anything is pushed.
AUTO="${AUTO:-1}"
# Which task to run. A task may be given in advance - the TASK env var or the first
# non-flag argument - otherwise we ask for it interactively below (see choose_task),
# falling back to this default when there's no one to ask. The prompt for a task
# (and, for YAML tasks, the repo + checkout dir) is loaded later by resolve_task.
TASK_GIVEN=0
[ -n "${TASK:-}" ] && TASK_GIVEN=1
TASK="${TASK:-Golf}"
for arg in "$@"; do
  case "$arg" in
    --auto|-y|--yes)           AUTO=1 ;;
    --manual|--interactive|-i) AUTO=0 ;;
    -*)                        warn "Ignoring unknown flag: $arg" ;;
    *)                         TASK="$arg"; TASK_GIVEN=1 ;;
  esac
done

# The upstream repo to fork/build/PR-against, the local checkout folder, and the
# task prompt are all decided by resolve_task (below) once the task is known:
#   * Markdown task -> Physlib, in ./physlib-auto.
#   * YAML task     -> the repo/dir/prompt declared in the task file.
# They're left unset here on purpose; nothing references them before resolve_task.

# Politeness cap: refuse to run when more than this many automated PRs (open PRs
# whose title starts with "auto-", the prefix every task here uses) already exist
# upstream, so a fleet of runs can't flood the maintainers. Override with the
# MAX_OPEN_AUTO_PRS env var if you ever need to.
MAX_OPEN_AUTO_PRS="${MAX_OPEN_AUTO_PRS:-10}"

# Credit Claude as a co-author on the commit. GitHub reads this trailer and shows
# Claude as a co-author on the resulting PR (your git identity stays the author).
CLAUDE_COAUTHOR="Claude <noreply@anthropic.com>"

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
    ok)      printf '  %s[x]%s %s\n' "$C_GREEN"  "$C_RESET" "$*";;
    missing) printf '  %s[ ]%s %s\n' "$C_RED"    "$C_RESET" "$*";;
    *)       printf '  %s[*]%s %s\n' "$C_YELLOW" "$C_RESET" "$*";;
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

# This script's name and its canonical GitHub location, plus the base URL for the
# task files - used by the update check and by resolve_task's GitHub fallback.
REPO_RAW_BASE="https://raw.githubusercontent.com/jstoobysmith/PhyslibAITools/main"
SELF_NAME="physlib-auto-task.sh"
SELF_RAW_URL="$REPO_RAW_BASE/Scripts/$SELF_NAME"
TASKS_RAW_BASE="$REPO_RAW_BASE/Tasks"

# Directory this script lives in - only resolvable when run from a file (not when
# piped via `curl | bash`); left empty otherwise so the local lookups below skip.
SELF_PATH="${BASH_SOURCE[0]:-$0}"
SCRIPT_DIR=""
[ -f "$SELF_PATH" ] && SCRIPT_DIR="$(cd "$(dirname "$SELF_PATH")" && pwd)"

# Best-effort self-update check: compare the running script against the copy on
# GitHub and report whether a newer version exists. Never fatal - a failed fetch or
# a piped (`curl | bash`) invocation, where there's no local file to compare, just
# downgrades to an info line. Emits a check() line so it fits the preflight report.
check_for_updates() {
  local remote
  if [ -z "$SCRIPT_DIR" ] || [ ! -r "$SELF_PATH" ]; then
    check info "Update check: skipped (running from a pipe; re-fetch the URL for the latest)"
    return 0
  fi
  remote="$(curl -fsSL --max-time 10 "$SELF_RAW_URL" 2>/dev/null || true)"
  if [ -z "$remote" ]; then
    check info "Update check: couldn't reach GitHub (offline?); continuing with this copy"
  elif [ "$remote" = "$(cat "$SELF_PATH")" ]; then
    check ok "$SELF_NAME is up to date"
  else
    check missing "$SELF_NAME is OUT OF DATE - a newer version is on GitHub"
    printf '      %sUpdate with: git pull  (or re-download: %s)%s\n' "$C_DIM" "$SELF_RAW_URL" "$C_RESET"
  fi
}

# --- YAML task helpers ------------------------------------------------------
# A YAML task file carries three fields (see the schema note below):
#   repo: user/repo            # upstream repo to fork, build, and PR against
#   dir:  some-auto            # local checkout folder this script owns
#   prompt: |                  # the task prompt (a literal block scalar)
#     ...indented prompt...
# These two readers handle exactly that shape - not arbitrary YAML.

# Print the trimmed value of a top-level "key: value" scalar from YAML file $2
# (surrounding quotes removed), or nothing if the key is absent. Used for repo/dir.
yaml_scalar() {
  local key="$1" file="$2" line
  line="$(grep -m1 -E "^${key}:" "$file" 2>/dev/null)" || return 0
  line="${line#"$key":}"
  line="${line#"${line%%[![:space:]]*}"}"   # strip leading whitespace
  line="${line%"${line##*[![:space:]]}"}"   # strip trailing whitespace
  case "$line" in                            # strip one pair of surrounding quotes
    \"*\") line="${line#\"}"; line="${line%\"}" ;;
    \'*\') line="${line#\'}"; line="${line%\'}" ;;
  esac
  printf '%s' "$line"
}

# Print the literal block-scalar value of "key: |" (or "key: >") from YAML file $2:
# every following line indented under it, dedented by the block's own indentation,
# stopping at the next unindented (top-level) line. Used for the multi-line prompt.
yaml_block() {
  local key="$1" file="$2"
  awk -v k="$key" '
    BEGIN { inblock = 0; indent = -1 }
    inblock == 0 { if ($0 ~ ("^" k ":[ \t]*[|>]")) inblock = 1; next }
    {
      if ($0 ~ /^[ \t]*$/) { print ""; next }     # blank line -> keep, do not end
      match($0, /^[ \t]*/); cur = RLENGTH
      if (indent < 0) indent = cur                 # first content line sets indent
      if (cur < indent) exit                       # dedent -> block has ended
      print substr($0, indent + 1)
    }
  ' "$file"
}

# Locate the task file for "$1" and record its path (TASK_FILE) and format
# (TASK_FORMAT = yaml|md). Prefers a YAML task (Tasks/<Task>.yaml or .yml) over the
# classic Markdown one (Tasks/<Task>.md); for each it looks next to this script and
# under the current directory, then falls back to fetching from GitHub into a temp
# file. Accepts the name as given or with a capitalised first letter (so "golf" and
# "Golf" both resolve). Returns non-zero if the task can't be found anywhere.
TASK_FILE=""
TASK_FORMAT=""
resolve_task() {
  local name="$1" cap stem ext d f body tmp
  cap="$(printf '%s' "$name" | awk '{print toupper(substr($0,1,1)) substr($0,2)}')"
  for ext in yaml yml md; do
    for stem in "$name" "$cap"; do
      for d in "${SCRIPT_DIR:+$SCRIPT_DIR/../Tasks}" "./Tasks" "${SCRIPT_DIR:+$SCRIPT_DIR/Tasks}"; do
        f="${d:+$d/$stem.$ext}"
        if [ -n "$f" ] && [ -f "$f" ]; then
          TASK_FILE="$f"; [ "$ext" = md ] && TASK_FORMAT=md || TASK_FORMAT=yaml
          return 0
        fi
      done
    done
  done
  for ext in yaml yml md; do
    for stem in "$name" "$cap"; do
      body="$(curl -fsSL --max-time 15 "$TASKS_RAW_BASE/$stem.$ext" 2>/dev/null || true)"
      if [ -n "$body" ]; then
        tmp="$(mktemp)"; printf '%s' "$body" >"$tmp"; CLEANUP_FILES+=("$tmp")
        TASK_FILE="$tmp"; [ "$ext" = md ] && TASK_FORMAT=md || TASK_FORMAT=yaml
        return 0
      fi
    done
  done
  return 1
}

# Ask an interactive user which task to run when none was given in advance. Lists
# the task files we can see in a local Tasks/ directory as a numbered menu; if there
# is no local Tasks/ (e.g. piped from curl) it just asks for a name. A blank answer
# keeps the current default ("$TASK").
choose_task() {
  local tasks_dir="" d f base reply
  local names=()
  for d in "${SCRIPT_DIR:+$SCRIPT_DIR/../Tasks}" "./Tasks" "${SCRIPT_DIR:+$SCRIPT_DIR/Tasks}"; do
    [ -n "$d" ] && [ -d "$d" ] && { tasks_dir="$d"; break; }
  done
  if [ -n "$tasks_dir" ]; then
    for f in "$tasks_dir"/*.md "$tasks_dir"/*.yaml "$tasks_dir"/*.yml; do
      [ -e "$f" ] || continue
      base="$(basename "$f")"
      names+=("${base%.*}")
    done
  fi
  if [ "${#names[@]}" -gt 0 ]; then
    log "Which task should Claude run? (default: $TASK)"
    local i
    for i in "${!names[@]}"; do
      printf '  %d) %s\n' "$((i + 1))" "${names[$i]}"
    done
    read -r -p "Enter a number or task name [$TASK]: " reply || true
    case "$reply" in
      '')          : ;;                                  # blank -> keep default
      *[!0-9]*)    TASK="$reply" ;;                      # has a non-digit -> a name
      *)           TASK="${names[$((reply - 1))]:-$TASK}" ;;  # all digits -> menu index
    esac
  else
    read -r -p "Which task should Claude run? [$TASK]: " reply || true
    [ -n "$reply" ] && TASK="$reply"
  fi
}

# Weighted random task picker, used in auto mode when no task was given. Weights are
# out of 100 and should sum to 100; edit the table to change the mix. Each entry is
# Name:weight, and a task is chosen with probability weight/100.
TASK_WEIGHTS="Golf:34 LintQI:33 ImportMinimizer:33"
pick_weighted_task() {
  local r=$(( RANDOM % 100 )) acc=0 entry name="" weight
  for entry in $TASK_WEIGHTS; do
    name="${entry%%:*}"; weight="${entry##*:}"
    acc=$(( acc + weight ))
    [ "$r" -lt "$acc" ] && { printf '%s' "$name"; return 0; }
  done
  printf '%s' "$name"   # fallback if weights sum to < 100: last entry
}

# Friendly intro shown at startup: what this does and the handful of knobs worth
# knowing before the long build kicks off.
welcome() {
  cat <<EOF

${C_BOLD}${C_BLUE}===============================================================${C_RESET}
${C_BOLD}${C_BLUE}  Physlib Auto-Task${C_RESET}  -  run an automated Claude task, open a PR
${C_BOLD}${C_BLUE}===============================================================${C_RESET}

It forks & builds Physlib, has Claude carry out a task (default
${C_BOLD}Golf${C_RESET}), then opens a pull request with the result. It runs fully
automatically by default; pass ${C_BOLD}--manual${C_RESET} to review the diff and
confirm before anything is pushed.

${C_CYAN}Requirements${C_RESET}
  ${C_GREEN}*${C_RESET} A ${C_BOLD}paid Claude plan${C_RESET} (Claude Pro/Max, or API credits) - the
    free tier can't run Claude Code.
  ${C_GREEN}*${C_RESET} A ${C_BOLD}GitHub account${C_RESET} (to fork Physlib and open the PR).
  ${C_GREEN}*${C_RESET} ${C_BOLD}git${C_RESET} and ${C_BOLD}curl${C_RESET} already installed; ${C_BOLD}macOS (Homebrew)${C_RESET} or
    ${C_BOLD}Debian/Ubuntu (apt)${C_RESET} for the auto-installers.
  ${C_GREEN}*${C_RESET} Everything else (${C_BOLD}elan/lake, gh, uv, Claude Code${C_RESET}) is installed
    automatically if missing.
  ${C_GREEN}*${C_RESET} Disk space and time for a full Mathlib build on the first run.

${C_CYAN}Examples${C_RESET}
  ${C_DIM}# default: fully automatic, default task (Golf)${C_RESET}
  ./$SELF_NAME

  ${C_DIM}# automatic, a specific task${C_RESET}
  ./$SELF_NAME Golf

  ${C_DIM}# interactive instead: pick a task, review & confirm before pushing${C_RESET}
  ./$SELF_NAME --manual

  ${C_DIM}# one-liner straight from GitHub (automatic, default task)${C_RESET}
  curl -fsSL $SELF_RAW_URL | bash

${C_CYAN}Tips${C_RESET}
  ${C_GREEN}*${C_RESET} ${C_BOLD}Automatic by default${C_RESET}: no prompts, PR pushed for you - needs GitHub
    and Claude Code already signed in. Use ${C_BOLD}--manual${C_RESET} (or ${C_BOLD}AUTO=0${C_RESET}) to review
    and confirm each step yourself.
  ${C_GREEN}*${C_RESET} ${C_BOLD}Pick a task${C_RESET} with an argument or ${C_BOLD}TASK=Golf${C_RESET} (default ${C_BOLD}Golf${C_RESET});
    in manual mode you're asked. Tasks live in ${C_BOLD}Tasks/<Name>.md${C_RESET} (Physlib) or
    ${C_BOLD}Tasks/<Name>.yaml${C_RESET} (which names its own repo + checkout folder).
  ${C_GREEN}*${C_RESET} ${C_BOLD}Reuses your checkout${C_RESET}: if the task's working folder (e.g.
    ${C_BOLD}./physlib-auto${C_RESET}) already exists, it's reused instead of cloning again.
  ${C_GREEN}*${C_RESET} ${C_BOLD}Good citizen${C_RESET}: won't run if more than ${C_BOLD}$MAX_OPEN_AUTO_PRS${C_RESET} automated PRs
    are already open upstream (override with ${C_BOLD}MAX_OPEN_AUTO_PRS${C_RESET}).
  ${C_DIM}* First build can take 10+ minutes. NO_COLOR=1 disables colour;${C_RESET}
  ${C_DIM}  FORCE_COLOR=1 forces it on.${C_RESET}
EOF
}

welcome

# If no task was specified up front, decide which one to run. In auto mode we pick a
# weighted-random task (so unattended runs spread across the task mix); interactively
# we ask. A non-interactive manual run just keeps the default.
if [ "$TASK_GIVEN" -eq 0 ]; then
  if [ "$AUTO" = "1" ]; then
    TASK="$(pick_weighted_task)"
    log "Auto mode: randomly selected task '$TASK' (weights $TASK_WEIGHTS)."
  elif [ -t 0 ]; then
    choose_task
  fi
fi
# Lower-cased task name, used for the work-branch name and the PR title prefix.
TASK_LC="$(printf '%s' "$TASK" | tr '[:upper:]' '[:lower:]')"

# Resolve the task to its prompt, the repo to fork, and the local checkout folder.
# Markdown tasks are the Physlib default (leanprover-community/physlib in
# physlib-auto); YAML tasks declare their own repo/dir/prompt, all three required.
# Done up front - before the preflight and the slow fork/build - so the rest of the
# run knows exactly which repo and folder it's operating on.
resolve_task "$TASK" || die "Couldn't find task '$TASK' - looked for a local \
Tasks/$TASK.{yaml,yml,md} (and the capitalised name), then the same on GitHub under \
$TASKS_RAW_BASE. Check the task name (see the Tasks/ directory)."

if [ "$TASK_FORMAT" = "yaml" ]; then
  UPSTREAM_REPO="$(yaml_scalar repo "$TASK_FILE")"
  WORK_DIR="$(yaml_scalar dir "$TASK_FILE")"
  PROMPT="$(yaml_block prompt "$TASK_FILE")"
  [ -n "$UPSTREAM_REPO" ] || die "YAML task '$TASK' is missing the required 'repo:' \
field (e.g. repo: ImperialCollegeLondon/FLT)."
  [ -n "$WORK_DIR" ] || die "YAML task '$TASK' is missing the required 'dir:' field \
(the local checkout folder, e.g. dir: flt-auto)."
  [ -n "$PROMPT" ] || die "YAML task '$TASK' is missing the required 'prompt:' block \
('prompt: |' followed by the indented task text)."
else
  UPSTREAM_REPO="leanprover-community/physlib"
  WORK_DIR="physlib-auto"
  PROMPT="$(cat "$TASK_FILE")"
fi
# Human-friendly project name (the repo's basename), used in build/log messages.
PROJECT_NAME="${UPSTREAM_REPO##*/}"

# --- 0. Preflight: report the status of every prerequisite ------------------

log "Prerequisite check (anything unchecked will be installed/set up below):"

have git    && check ok "git installed"                 || check missing "git installed (REQUIRED - install it and re-run)"
have curl   && check ok "curl installed"                || check missing "curl installed (REQUIRED - install it and re-run)"
have lake   && check ok "Lean toolchain (elan/lake)"    || check missing "Lean toolchain (elan/lake)"
have gh     && check ok "GitHub CLI (gh)"               || check missing "GitHub CLI (gh)"
{ have uv || have uvx; } && check ok "uv (for lean-lsp-mcp)" || check missing "uv (for lean-lsp-mcp)"
have claude && check ok "Claude Code (claude)"          || check missing "Claude Code (claude)"

# Is this script itself up to date with GitHub?
check_for_updates

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

# Working checkout folder for this task ($WORK_DIR)
if [ -d "$WORK_DIR" ]; then
  check ok "./$WORK_DIR folder (reusing existing checkout)"
else
  check info "./$WORK_DIR folder not found - that's OK, we'll create one"
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
  if [ "$AUTO" = "1" ]; then
    die "Auto mode needs GitHub already authenticated. Run 'gh auth login' (or set \
GH_TOKEN) and re-run."
  fi
  log "Signing in to GitHub..."
  gh auth login
else
  log "Already signed in to GitHub."
fi

# --- 2b. Cap concurrent automated PRs --------------------------------------
#
# Be a good citizen: if many automated PRs are already queued upstream, don't add
# more. Count open PRs whose title starts with "auto-" (the prefix every task here
# uses) and refuse to run when that exceeds MAX_OPEN_AUTO_PRS. Checked here, right
# after auth, so we bail before the slow fork/clone/build rather than after it.
log "Counting open automated PRs (title starting 'auto-') on $UPSTREAM_REPO..."
if AUTO_PR_TITLES="$(gh pr list --repo "$UPSTREAM_REPO" --state open --limit 1000 \
    --json title --jq '.[].title' 2>/dev/null)"; then
  OPEN_AUTO_PRS="$(printf '%s\n' "$AUTO_PR_TITLES" | grep -c '^auto-' || true)"
  if [ "$OPEN_AUTO_PRS" -gt "$MAX_OPEN_AUTO_PRS" ]; then
    die "There are already $OPEN_AUTO_PRS open automated PRs on $UPSTREAM_REPO \
(limit $MAX_OPEN_AUTO_PRS). Refusing to add more so we don't overwhelm the \
maintainers - try again once some have been merged or closed."
  fi
  log "$OPEN_AUTO_PRS open automated PR(s) on $UPSTREAM_REPO (limit $MAX_OPEN_AUTO_PRS) - OK to proceed."
else
  warn "Couldn't query open PRs on $UPSTREAM_REPO (GitHub API unreachable?); \
skipping the automated-PR limit check and continuing."
fi

# --- 3. Fork + clone --------------------------------------------------------
 
# Always work in a dedicated checkout that this script owns ($WORK_DIR) - reuse it
# if it's already here, otherwise fork + clone it. (We never operate on whatever
# directory you happen to launch from, so a stray lakefile can't redirect the run.)
if [ -d "$WORK_DIR" ]; then
  log "Reusing existing $WORK_DIR checkout (no re-clone)."
  cd "$WORK_DIR"
else
  log "Forking and cloning $UPSTREAM_REPO into $WORK_DIR..."
  # Pin the clone directory via a git-clone arg (after --), so we don't depend on
  # what the fork happens to be named on your account.
  gh repo fork "$UPSTREAM_REPO" --clone -- "$WORK_DIR"
  cd "$WORK_DIR"
fi
CHECKOUT_DIR="$(pwd)"

# Find the upstream's default branch (master, main, ...) so this works for any repo,
# not just ones that use "master". Fall back to "master" if the query fails.
DEFAULT_BRANCH="$(gh repo view "$UPSTREAM_REPO" --json defaultBranchRef \
  --jq '.defaultBranchRef.name' 2>/dev/null || true)"
[ -n "$DEFAULT_BRANCH" ] || DEFAULT_BRANCH="master"

# Start a fresh working branch off the upstream default branch, so edits never land
# on it, don't stack on a leftover branch from a previous run in a reused checkout,
# and start from the latest upstream rather than a possibly-stale fork.
# (gh repo fork --clone adds an "upstream" remote pointing at the source repo.)
BASE="$DEFAULT_BRANCH"
if git remote get-url upstream >/dev/null 2>&1; then
  log "Fetching upstream $DEFAULT_BRANCH..."
  if git fetch upstream "$DEFAULT_BRANCH" 2>/dev/null; then
    BASE="upstream/$DEFAULT_BRANCH"
  else
    warn "Couldn't fetch upstream; basing the branch off local $DEFAULT_BRANCH."
  fi
else
  warn "No 'upstream' remote; basing the branch off local $DEFAULT_BRANCH."
fi
BRANCH="auto-${TASK_LC}-$(date +%Y%m%d-%H%M%S)"
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

# Bail out clearly if the cache fetch or build fails. The usual cause is a corrupt
# or half-written checkout/cache, and the reliable fix is a fresh clone - so point
# the user straight at deleting the checkout we own.
build_die() {
  die "$1

This usually means the existing checkout or its Mathlib cache is in a bad state.
Delete the checkout and re-run this script for a clean clone + build:
  rm -rf \"$CHECKOUT_DIR\""
}

log "Fetching the Mathlib cache..."
lake exe cache get || build_die "Failed to fetch the Mathlib cache (lake exe cache get)."
log "Mathlib cache fetched."
log "Building $PROJECT_NAME (the first build can take 10+ minutes)..."
lake build || build_die "Failed to build $PROJECT_NAME (lake build)."
log "Build complete."
 
# --- 5. Register the Lean LSP MCP server -----------------------------------
 
log "Registering lean-lsp-mcp with Claude Code..."
claude mcp add lean-lsp -- uvx lean-lsp-mcp 2>/dev/null \
  && log "lean-lsp-mcp registered." \
  || warn "lean-lsp may already be registered; continuing."
 
# --- 6. Hand off to Claude --------------------------------------------------
 
# Temp files (outside the repo, so they never get committed) where Claude leaves
# the PR title and description for the script to use in step 7. Registered with the
# cleanup trap set up at the top so they're removed on exit.
PR_TITLE_FILE="$(mktemp)"; CLEANUP_FILES+=("$PR_TITLE_FILE")
PR_BODY_FILE="$(mktemp)";  CLEANUP_FILES+=("$PR_BODY_FILE")

# The task prompt ($PROMPT) was already resolved up front by resolve_task, along
# with the repo and checkout dir; nothing more to load here.
log "Running task '$TASK' on $UPSTREAM_REPO..."

# Standard PR-text handoff - identical for every task, so it lives here rather than
# in the task file. Claude writes the PR title and body to these temp files once the
# work is done and the build is green, or leaves them empty to signal it couldn't
# finish (which step 7 treats as "don't open a PR").
PROMPT="$PROMPT

Finally, once the task is complete and the project still builds, write the
pull-request text so the script can open the PR for me:
  - A PR title in EXACTLY this format: auto-task(<subject>): <description>
    where <subject> is the main declaration or area you changed and <description>
    is a concise summary, e.g.
    'auto-task(inner_mul_le_norm): shorten Cauchy-Schwarz proof'. Write it
    to: $PR_TITLE_FILE
  - A clear PR description (what you changed and why, in Markdown) -> write it to:
    $PR_BODY_FILE
Write nothing else to those two files. If you could NOT complete the task while
keeping the build green, leave both files empty so the script knows not to open a
PR."

# In interactive mode Claude waits in the TUI, so tell the user how to hand control
# back to the script. In auto mode (headless `claude -p`) Claude exits on its own,
# so this note would be misleading - skip it.
if [ "$AUTO" != "1" ]; then
  PROMPT="$PROMPT

Finally, write a short message telling me how to quit Claude and that this script
will continue automatically once I exit Claude."
fi

if [ "$AUTO" = "1" ]; then
  log "Launching Claude headless (auto mode) - it will run the '$TASK' task and exit on its own..."
  set +e
  claude -p "$PROMPT" --permission-mode bypassPermissions
  set -e
else
  log "Launching Claude to run the '$TASK' task..."
  set +e
  claude "$PROMPT"
  set -e
fi
 
# --- 7. Commit, push, and open the pull request ----------------------------
 
log "Reviewing what Claude changed..."
git add -A

if [ -z "$(git diff --cached --name-only)" ]; then
  warn "Claude made no changes; nothing to open a PR for. Stopping here."
  exit 0
fi

# Claude writes the PR title and body only once the task is done and the build is
# green; if it couldn't finish while keeping the build green, it leaves them empty
# (see the handoff appended to the prompt above). Treat empty PR text as that
# "couldn't finish" signal: keep the changes staged on the branch, but don't commit,
# push, or open a PR for unverified work. Verification stays with Claude in-session,
# where build errors can actually be fixed and its explanation is already on screen -
# rather than a post-hoc check that would only strand the user after Claude exits.
TITLE="$(head -n1 "$PR_TITLE_FILE" 2>/dev/null || true)"
if [ -z "$TITLE" ] || [ ! -s "$PR_BODY_FILE" ]; then
  warn "Claude left no PR text - its signal that the task isn't finished. Your
changes are staged on '$BRANCH' but nothing was committed or pushed. Re-run Claude
on this branch to finish the task, then re-run this script."
  exit 0
fi

log "Proposed pull request:"
printf '  Title: %s\n\n' "$TITLE"
git --no-pager diff --cached --stat
printf '\n'

if [ "$AUTO" = "1" ]; then
  log "Auto mode: pushing '$BRANCH' and opening the PR without prompting."
else
  read -r -p "Push '$BRANCH' and open this PR against $UPSTREAM_REPO? [Y/n] " REPLY
  case "$REPLY" in
    [Nn]*) log "No problem - changes are staged on '$BRANCH'. Nothing pushed."; exit 0 ;;
    *) ;;
  esac
fi

log "Committing..."
# Separate -m args become paragraphs (blank line between), so the trailer lands as
# its own block at the end of the message, which is what GitHub needs to attribute
# the co-author.
git commit -m "$TITLE" -m "Co-authored-by: $CLAUDE_COAUTHOR"
log "Pushing '$BRANCH' to your fork..."
git push -u origin "$BRANCH"

ME="$(gh api user --jq .login)"
log "Opening the pull request..."
gh pr create --repo "$UPSTREAM_REPO" --base "$DEFAULT_BRANCH" \
  --head "${ME}:${BRANCH}" --title "$TITLE" --body-file "$PR_BODY_FILE"
log "Done - pull request opened."
 