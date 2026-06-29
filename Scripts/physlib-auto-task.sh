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
# Installing anything that's missing, it walks through seven numbered steps:
#   1. Install Lean (elan), the GitHub CLI (gh), uv, and Claude Code
#   2. Sign you in to GitHub if needed (and check the automated-PR limit)
#   3. Fork + clone the repo
#   4. Fetch the Mathlib cache and build the project (slow the first time)
#   5. Register the lean-lsp-mcp server with Claude Code
#   6. Load the task and launch Claude to carry it out
#   7. Commit the change and open a pull request (Claude writes the title + body)
#
# It shows you the staged diff and asks for confirmation before pushing and
# opening the PR, so nothing leaves your machine without your OK.
#
# Usage:
#   ./physlib-auto-task.sh [Task] [--manual]   # e.g. ./physlib-auto-task.sh Golf
#   ./physlib-auto-task.sh --help              # requirements, examples, options
#   TASK=Golf ./physlib-auto-task.sh
#   curl -fsSL <raw-url> | bash                # runs the default task (Golf)
#
# Tasks come in two flavours, both under Tasks/:
#   * Markdown (Tasks/<Task>.md)  - just the prompt; always run against Physlib,
#     in a ./physlib-auto checkout. This is the default.
#   * YAML     (Tasks/<Task>.yaml) - the prompt PLUS the repo to fork and the local
#     checkout folder, so the same harness can target any Lean repo. A YAML task
#     must set three fields: 'repo:' (e.g. ImperialCollegeLondon/FLT), 'dir:' (the
#     checkout folder, e.g. flt-auto), and 'prompt: |' (the task text). It MAY also
#     set two optional question lists (see the YAML schema note further down):
#       - 'input_questions:'     asked before Claude runs; the answers are prepended
#         to the prompt as context (e.g. "what TODO item should I add?").
#       - 'challenge_questions:' yes/no checks asked after Claude finishes, with its
#         diff shown; the verdicts are recorded in the PR description, and a "no" to
#         any of them stops the run before anything is committed or pushed.
#     Both need an interactive terminal; headless runs skip them. See the example
#     task files.
# When both Tasks/<Task>.yaml and Tasks/<Task>.md exist, the YAML one wins.
#
# Auto-install paths are tested for macOS (Homebrew) and Debian/Ubuntu (apt).
# On other systems, install gh and Claude Code yourself first, then re-run.

set -euo pipefail

# Total wall-clock timer for the run (reported in the closing summary).
SECONDS=0

# ===========================================================================
#  Presentation toolkit
# ===========================================================================
# A small, consistent vocabulary of output helpers so every message looks like it
# came from the same tool: a banner, numbered step headers, status icons, aligned
# key/value rows, and a spinner that shows elapsed time for long, quiet steps.

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

# Use Unicode glyphs only when we have both colour and a UTF-8 locale; otherwise
# fall back to plain ASCII so nothing renders as mojibake in a basic terminal.
use_unicode=0
case "${LC_ALL:-${LC_CTYPE:-${LANG:-}}}" in
  *[Uu][Tt][Ff]*8* | *[Uu][Tt][Ff]8*) [ "$use_color" = 1 ] && use_unicode=1 ;;
esac
if [ "$use_unicode" = 1 ]; then
  SYM_OK='✓'; SYM_NO='✗'; SYM_DOT='•'; SYM_ARROW='▸'; SYM_WARN='⚠'
  RULE_CH='─'; HDR='━━'; SPIN_FRAMES='⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏'
else
  SYM_OK='[x]'; SYM_NO='[ ]'; SYM_DOT='*'; SYM_ARROW='>'; SYM_WARN='!'
  RULE_CH='-'; HDR='=='; SPIN_FRAMES='|/-\'
fi

# Numbered-step state. STEP_TOTAL is the number of phases the user lives through;
# step() prints a "[n/N] Title" header and advances the counter.
STEP_TOTAL=7
STEP_NO=0

# A dim horizontal rule, $1 chars wide (default 64).
hr() {
  local w="${1:-64}" line=''
  while [ "${#line}" -lt "$w" ]; do line="$line$RULE_CH"; done
  printf '%s%s%s\n' "$C_DIM" "${line:0:$w}" "$C_RESET"
}

# A numbered phase header, e.g.  "━━ [3/7] Fork & clone".
step() {
  STEP_NO=$((STEP_NO + 1))
  printf '\n%s%s [%d/%d] %s%s\n' "$C_BOLD$C_BLUE" "$HDR" "$STEP_NO" "$STEP_TOTAL" "$*" "$C_RESET"
}

# An unnumbered section header (for the welcome, the setup check, summaries).
section() { printf '\n%s%s %s%s\n' "$C_BOLD$C_CYAN" "$HDR" "$*" "$C_RESET"; }

# Intra-step messages, all indented two spaces under their header.
log()  { printf '  %s%s%s %s\n' "$C_BLUE"   "$SYM_ARROW" "$C_RESET" "$*"; }
ok()   { printf '  %s%s%s %s\n' "$C_GREEN"  "$SYM_OK"    "$C_RESET" "$*"; }
warn() { printf '  %s%s%s %s\n' "$C_YELLOW" "$SYM_WARN"  "$C_RESET" "$*"; }
info() { printf '  %s%s%s %s\n' "$C_DIM"    "$SYM_DOT"   "$C_RESET" "$*"; }
note() { printf '    %s%s%s\n'  "$C_DIM"    "$*"         "$C_RESET"; }

# A clear, fatal error block, then exit. Accepts a single (possibly multi-line)
# message; the first line carries the icon and the rest is printed as given.
die() {
  printf '\n%s%s Error%s\n' "$C_BOLD$C_RED" "$SYM_NO" "$C_RESET" >&2
  printf '%s\n' "$1" | while IFS= read -r _l; do printf '  %s\n' "$_l" >&2; done
  exit 1
}

have() { command -v "$1" >/dev/null 2>&1; }

# True when we can actually prompt the user - i.e. a controlling terminal is open
# for reading. We test by trying to open /dev/tty rather than checking `[ -t 0 ]`,
# because the script's own stdin (fd 0) is unreliable here: it may be a pipe (when
# run via `curl | bash`) or, crucially, get drained to EOF by `claude -p` in auto
# mode. All interactive reads below come from /dev/tty for the same reason.
interactive() { (exec </dev/tty) 2>/dev/null; }

# An aligned "label   value" row, used by the plan and summary blocks.
kv() { printf '  %s%-13s%s %s\n' "$C_DIM" "$1" "$C_RESET" "$2"; }

# Checkbox line for the setup report:  check <ok|missing|info> <label>
#   ok      -> green check    (ready)
#   missing -> red cross      (the script will install / set this up below)
#   info    -> yellow dot     (couldn't determine, or nothing needs doing)
check() {
  local state="$1"; shift
  case "$state" in
    ok)      printf '  %s%s%s %s\n' "$C_GREEN"  "$SYM_OK"  "$C_RESET" "$*";;
    missing) printf '  %s%s%s %s\n' "$C_RED"    "$SYM_NO"  "$C_RESET" "$*";;
    *)       printf '  %s%s%s %s\n' "$C_YELLOW" "$SYM_DOT" "$C_RESET" "$*";;
  esac
}

# Render a number of seconds as "12s" or "3m 05s".
fmt_duration() {
  local s="$1"
  if [ "$s" -lt 60 ]; then printf '%ds' "$s"
  else printf '%dm %02ds' "$((s / 60))" "$((s % 60))"; fi
}

# Run a command behind a single status line that animates while it works and shows
# how long it took - for long steps whose own output is noise (downloads, clone,
# push). On a colour TTY it shows a spinner + elapsed time, hides the command's
# output, and on failure prints the tail of it. Without a colour TTY it falls back
# to a plain "==> message" line and lets the command stream normally. Returns the
# command's own exit status, so callers can still chain `|| die ...`.
SPIN_LOG=""
spin() {
  local msg="$1"; shift
  if [ "$use_color" != 1 ] || [ ! -t 1 ]; then
    log "$msg"
    "$@"
    return $?
  fi
  local logf; logf="$(mktemp)"; CLEANUP_FILES+=("$logf"); SPIN_LOG="$logf"
  "$@" >"$logf" 2>&1 &
  local pid=$! i=0 start=$SECONDS fr
  printf '\033[?25l'                                   # hide cursor
  while kill -0 "$pid" 2>/dev/null; do
    fr="${SPIN_FRAMES:i % ${#SPIN_FRAMES}:1}"; i=$((i + 1))
    printf '\r  %s%s%s %s %s(%s)%s' "$C_BLUE" "$fr" "$C_RESET" "$msg" \
      "$C_DIM" "$(fmt_duration $((SECONDS - start)))" "$C_RESET"
    sleep 0.1
  done
  printf '\033[?25h'                                   # show cursor
  local rc=0; if wait "$pid"; then rc=0; else rc=$?; fi
  local dur; dur="$(fmt_duration $((SECONDS - start)))"
  printf '\r\033[K'                                    # clear the spinner line
  if [ "$rc" -eq 0 ]; then
    printf '  %s%s%s %s %s(%s)%s\n' "$C_GREEN" "$SYM_OK" "$C_RESET" "$msg" "$C_DIM" "$dur" "$C_RESET"
  else
    printf '  %s%s%s %s %s(failed after %s)%s\n' "$C_RED" "$SYM_NO" "$C_RESET" "$msg" "$C_DIM" "$dur" "$C_RESET"
    printf '%s' "$C_DIM"; tail -n 30 "$logf" | sed 's/^/      /'; printf '%s\n' "$C_RESET"
  fi
  return $rc
}

# Temp files to delete when the script exits - a downloaded task file (resolve_task)
# and the PR-text handoff files (step 6). Also make sure the cursor is restored if we
# are interrupted mid-spinner. Registered once so any temp we make is cleaned up no
# matter where we leave off.
CLEANUP_FILES=()
cleanup() {
  [ "$use_color" = 1 ] && printf '\033[?25h' 2>/dev/null || true   # restore cursor
  [ "${#CLEANUP_FILES[@]}" -gt 0 ] && rm -f "${CLEANUP_FILES[@]}"
  return 0
}
trap cleanup EXIT

OS="$(uname -s)"

# ===========================================================================
#  Configuration and argument parsing
# ===========================================================================

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
WANT_HELP=0
for arg in "$@"; do
  case "$arg" in
    --help|-h)                 WANT_HELP=1 ;;
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
# downgrades to an info line. Emits a check() line so it fits the setup report.
check_for_updates() {
  local remote
  if [ -z "$SCRIPT_DIR" ] || [ ! -r "$SELF_PATH" ]; then
    check info "Update check skipped (running from a pipe; re-fetch the URL for the latest)"
    return 0
  fi
  remote="$(curl -fsSL --max-time 10 "$SELF_RAW_URL" 2>/dev/null || true)"
  if [ -z "$remote" ]; then
    check info "Update check: couldn't reach GitHub (offline?); continuing with this copy"
  elif [ "$remote" = "$(cat "$SELF_PATH")" ]; then
    check ok "$SELF_NAME is up to date"
  else
    check missing "$SELF_NAME is OUT OF DATE - a newer version is on GitHub"
    note "Update with: git pull   (or re-download: $SELF_RAW_URL)"
  fi
}

# --- YAML task helpers ------------------------------------------------------
# A YAML task file carries three required fields and two optional question lists:
#   repo: user/repo            # upstream repo to fork, build, and PR against
#   dir:  some-auto            # local checkout folder this script owns
#   prompt: |                  # the task prompt (a literal block scalar)
#     ...indented prompt...
#   input_questions:           # optional; asked first, answers prepended to prompt
#     - "a question to ask the user before Claude runs"
#   challenge_questions:       # optional; yes/no checks asked after, diff shown -
#     - "a yes/no question; a 'no' stops the run before any PR is opened"
# It may also carry an optional one-line 'description:' scalar, shown in the plan.
# These readers handle exactly that shape - not arbitrary YAML.

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

# Print each item of a top-level YAML list "key:" from file $2, one per line, with
# surrounding quotes and indentation stripped. Handles both indented items and items
# at column 0; stops at the next top-level key. Used for the optional question lists:
#   input_questions:
#     - "first question"
#     - second question
# Items are assumed to be single-line scalars (questions), not nested structures.
yaml_list() {
  local key="$1" file="$2"
  awk -v k="$key" '
    function trim(s){ sub(/^[ \t]+/,"",s); sub(/[ \t]+$/,"",s); return s }
    function unquote(s){
      if (s ~ /^".*"$/)   return substr(s, 2, length(s) - 2)
      if (s ~ /^'\''.*'\''$/) return substr(s, 2, length(s) - 2)
      return s
    }
    BEGIN { inblock = 0 }
    inblock == 0 { if ($0 ~ ("^" k ":[ \t]*$")) inblock = 1; next }
    {
      if ($0 ~ /^[^ \t-]/) exit                 # a new top-level key -> list ended
      if ($0 ~ /^[ \t]*$/) next                 # blank line -> skip
      if (match($0, /^[ \t]*-[ \t]*/)) print unquote(trim(substr($0, RLENGTH + 1)))
    }
  ' "$file"
}

# Ask the user a list of questions (one per line in $1) and collect the answers into
# the global ASK_RESULT as a Markdown bullet list ("- **<question>**" then the
# indented answer) - a form that reads cleanly both inside Claude's prompt and in a
# PR description. Questions are fed on FD 3 and answers are read from /dev/tty, so the
# prompt works even when fd 0 is a pipe or has been drained. Callers guard with
# `interactive`; with no question or no tty, ASK_RESULT is left empty.
ask_questions() {
  local questions="$1" q ans n=0 total
  ASK_RESULT=""
  [ -n "$questions" ] || return 0
  total="$(printf '%s\n' "$questions" | grep -c .)"
  while IFS= read -r q <&3; do
    [ -n "$q" ] || continue
    n=$((n + 1))
    printf '\n  %s%s Question %d of %d%s\n' "$C_BOLD$C_CYAN" "$SYM_ARROW" "$n" "$total" "$C_RESET"
    printf '    %s\n' "$q"
    read -r -p "    > " ans </dev/tty || ans=""
    ASK_RESULT="${ASK_RESULT:+$ASK_RESULT
}- **$q**
  ${ans:-(no answer)}"
  done 3<<EOF
$questions
EOF
  return 0   # never let a bare call trip `set -e`
}

# Ask a list of challenge questions (one per line in $1) as strict yes/no gates,
# with Claude's diff already on screen. Each question is re-prompted until answered
# y or n. The verdicts are recorded in ASK_RESULT (Markdown) for the PR body, and if
# ANY answer is "no" - or the input ends (EOF) - CHALLENGE_FAILED is set to 1 so the
# caller can stop without opening a PR. Questions are fed on FD 3 and answers read
# from /dev/tty (robust to a drained fd 0); callers guard with `interactive`.
ask_challenge_questions() {
  local questions="$1" q ans verdict n=0 total
  ASK_RESULT=""
  CHALLENGE_FAILED=0
  [ -n "$questions" ] || return 0
  total="$(printf '%s\n' "$questions" | grep -c .)"
  while IFS= read -r q <&3; do
    [ -n "$q" ] || continue
    n=$((n + 1))
    printf '\n  %s%s Question %d of %d%s\n' "$C_BOLD$C_CYAN" "$SYM_ARROW" "$n" "$total" "$C_RESET"
    printf '    %s\n' "$q"
    verdict=""
    while [ -z "$verdict" ]; do
      if ! read -r -p "    [y/n] > " ans </dev/tty; then verdict="No"; break; fi  # EOF -> stop
      case "$ans" in
        [Yy] | [Yy][Ee][Ss]) verdict="Yes" ;;
        [Nn] | [Nn][Oo])     verdict="No" ;;
        *) printf '    %sPlease answer y or n.%s\n' "$C_YELLOW" "$C_RESET" ;;
      esac
    done
    ASK_RESULT="${ASK_RESULT:+$ASK_RESULT
}- **$q** $verdict"
    if [ "$verdict" = "No" ]; then CHALLENGE_FAILED=1; fi
  done 3<<EOF
$questions
EOF
  # Always succeed: the caller reads CHALLENGE_FAILED, not our exit status, and a
  # non-zero return here (e.g. from the last test above) would trip `set -e`.
  return 0
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

# List the task names we can see in a local Tasks/ directory (one per line), or
# nothing if there's no local Tasks/ (e.g. piped from curl). Used by choose_task and
# by the help text.
list_local_tasks() {
  local d f base
  for d in "${SCRIPT_DIR:+$SCRIPT_DIR/../Tasks}" "./Tasks" "${SCRIPT_DIR:+$SCRIPT_DIR/Tasks}"; do
    [ -n "$d" ] && [ -d "$d" ] || continue
    for f in "$d"/*.md "$d"/*.yaml "$d"/*.yml; do
      [ -e "$f" ] || continue
      base="$(basename "$f")"; printf '%s\n' "${base%.*}"
    done
    return 0
  done
}

# Ask an interactive user which task to run when none was given in advance. Lists
# the task files we can see in a local Tasks/ directory as a numbered menu; if there
# is no local Tasks/ (e.g. piped from curl) it just asks for a name. A blank answer
# keeps the current default ("$TASK").
choose_task() {
  local reply names=() i
  while IFS= read -r i; do [ -n "$i" ] && names+=("$i"); done < <(list_local_tasks)
  if [ "${#names[@]}" -gt 0 ]; then
    section "Choose a task"
    for i in "${!names[@]}"; do
      printf '  %s%2d%s  %s\n' "$C_BOLD" "$((i + 1))" "$C_RESET" "${names[$i]}"
    done
    printf '\n'
    read -r -p "  $SYM_ARROW Enter a number or task name [$TASK]: " reply </dev/tty || true
    case "$reply" in
      '')          : ;;                                  # blank -> keep default
      *[!0-9]*)    TASK="$reply" ;;                      # has a non-digit -> a name
      *)           TASK="${names[$((reply - 1))]:-$TASK}" ;;  # all digits -> menu index
    esac
  else
    read -r -p "  $SYM_ARROW Which task should Claude run? [$TASK]: " reply </dev/tty || true
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

# ===========================================================================
#  Welcome, help, and the run plan
# ===========================================================================

# Compact banner, shown on every run.
banner() {
  printf '\n'
  hr
  printf '  %sPhyslib Auto-Task%s  %s-  run an automated Claude task, open a PR%s\n' \
    "$C_BOLD$C_BLUE" "$C_RESET" "$C_DIM" "$C_RESET"
  hr
}

# The essentials, kept short so it doesn't bury the run. Full details: --help.
essentials() {
  printf '\n  %sBefore you start, you need:%s\n' "$C_BOLD" "$C_RESET"
  info "A paid Claude plan (Pro/Max or API credits) - the free tier can't run Claude Code."
  info "A GitHub account (to fork the repo and open the PR)."
  info "git + curl installed. Everything else is installed for you if missing."
  printf '\n  %sRun %s%s --help%s%s for requirements, examples, and all options.%s\n' \
    "$C_DIM" "$C_RESET$C_BOLD" "./$SELF_NAME" "$C_RESET" "$C_DIM" "$C_RESET"
}

# Full help: requirements, examples, options, available tasks. Shown on --help.
show_help() {
  banner
  cat <<EOF

It forks & builds a Lean repo (Physlib by default), has Claude carry out a
task, then opens a pull request with the result. It runs fully automatically
by default; pass ${C_BOLD}--manual${C_RESET} to review the diff and confirm before anything
is pushed.

${C_CYAN}${HDR} Requirements${C_RESET}
  ${C_GREEN}${SYM_DOT}${C_RESET} A ${C_BOLD}paid Claude plan${C_RESET} (Claude Pro/Max, or API credits) - the
    free tier can't run Claude Code.
  ${C_GREEN}${SYM_DOT}${C_RESET} A ${C_BOLD}GitHub account${C_RESET} (to fork the repo and open the PR).
  ${C_GREEN}${SYM_DOT}${C_RESET} ${C_BOLD}git${C_RESET} and ${C_BOLD}curl${C_RESET} already installed; ${C_BOLD}macOS (Homebrew)${C_RESET} or
    ${C_BOLD}Debian/Ubuntu (apt)${C_RESET} for the auto-installers.
  ${C_GREEN}${SYM_DOT}${C_RESET} Everything else (${C_BOLD}elan/lake, gh, uv, Claude Code${C_RESET}) is installed
    automatically if missing.
  ${C_GREEN}${SYM_DOT}${C_RESET} Disk space and time for a full Mathlib build on the first run.

${C_CYAN}${HDR} Usage${C_RESET}
  ${C_BOLD}./$SELF_NAME [Task] [options]${C_RESET}

  ${C_DIM}# default: fully automatic, default task (Golf)${C_RESET}
  ./$SELF_NAME

  ${C_DIM}# automatic, a specific task${C_RESET}
  ./$SELF_NAME Golf

  ${C_DIM}# interactive: pick a task, review & confirm before pushing${C_RESET}
  ./$SELF_NAME --manual

  ${C_DIM}# one-liner straight from GitHub (automatic, default task)${C_RESET}
  curl -fsSL $SELF_RAW_URL | bash

${C_CYAN}${HDR} Options${C_RESET}
  ${C_BOLD}--manual${C_RESET}, ${C_BOLD}-i${C_RESET}    Interactive: pick the task, watch Claude work, and
                  confirm before anything is pushed.
  ${C_BOLD}--auto${C_RESET}, ${C_BOLD}-y${C_RESET}      Unattended (the default): no prompts, PR pushed for
                  you. Needs GitHub and Claude Code already signed in.
  ${C_BOLD}--help${C_RESET}, ${C_BOLD}-h${C_RESET}      Show this help and exit.

${C_CYAN}${HDR} Environment${C_RESET}
  ${C_BOLD}TASK${C_RESET}=Golf             Task to run (same as the first argument).
  ${C_BOLD}MAX_OPEN_AUTO_PRS${C_RESET}=$MAX_OPEN_AUTO_PRS    Don't run if more automated PRs are already open.
  ${C_BOLD}NO_COLOR${C_RESET}=1            Disable colour. ${C_BOLD}FORCE_COLOR${C_RESET}=1 forces it on.
EOF
  local tasks; tasks="$(list_local_tasks | sort | paste -sd, - 2>/dev/null | sed 's/,/, /g' || true)"
  if [ -n "$tasks" ]; then
    printf '\n%s%s Available tasks%s\n  %s\n' "$C_CYAN" "$HDR" "$C_RESET" "$tasks"
  fi
  printf '\n  %sTasks live in Tasks/<Name>.md or Tasks/<Name>.yaml.%s\n' "$C_DIM" "$C_RESET"
  printf '  %sThe first build can take 10+ minutes; later runs reuse the cache.%s\n\n' "$C_DIM" "$C_RESET"
}

# Print the run plan: exactly what's about to happen and what (if anything) the user
# needs to do. Shown after the task is resolved, before the slow work begins.
print_plan() {
  local mode_line end_line checkout_note ask_before ask_after
  if [ "$AUTO" = "1" ]; then
    mode_line="Automatic ${C_DIM}(unattended; Claude runs headless)${C_RESET}"
    end_line="Opens the pull request automatically"
  else
    mode_line="Manual ${C_DIM}(you watch Claude, then confirm before pushing)${C_RESET}"
    end_line="Shows you the diff, then asks before opening the PR"
  fi
  if [ -d "$WORK_DIR" ]; then checkout_note="${C_DIM}(reusing existing checkout)${C_RESET}"
  else checkout_note="${C_DIM}(will be created)${C_RESET}"; fi
  ask_before="$(printf '%s\n' "$INPUT_QUESTIONS" | grep -c . || true)"
  ask_after="$(printf '%s\n' "$CHALLENGE_QUESTIONS" | grep -c . || true)"

  section "Plan"
  kv "Task"       "$TASK${TASK_DESC:+ ${C_DIM}-${C_RESET} $TASK_DESC}"
  kv "Repository" "$UPSTREAM_REPO"
  kv "Checkout"   "./$WORK_DIR $checkout_note"
  kv "Mode"       "$mode_line"
  if [ "$ask_before" -gt 0 ] || [ "$ask_after" -gt 0 ]; then
    kv "Questions" "$ask_before before Claude runs, $ask_after after"
  fi
  kv "At the end" "$end_line"

  # "What you need to do" - tailored to the actual run so the path is obvious. Track
  # whether we listed any action; if not (a truly unattended run) say so explicitly.
  local todo=0
  printf '\n  %sWhat you need to do%s\n' "$C_BOLD" "$C_RESET"
  if [ "$ask_before" -gt 0 ] && interactive; then
    info "Answer $ask_before question(s) coming up next, then you can step away during the build."
    todo=1
  fi
  if [ "$AUTO" != "1" ]; then
    info "Watch Claude do the task, then exit it to hand control back to this script."
    info "Review the diff and confirm before the PR is opened."
    todo=1
  elif [ "$ask_after" -gt 0 ] && interactive; then
    info "Answer $ask_after yes/no check(s) on Claude's diff near the end (a 'no' stops the run)."
    todo=1
  fi
  [ "$todo" -eq 0 ] && info "Nothing - sit back; this runs unattended and opens the PR for you."
  note "Heads-up: the first build can take 10+ minutes (later runs are quick)."
}

# --- Help short-circuit: print and exit before doing any work ---------------
if [ "$WANT_HELP" = "1" ]; then
  show_help
  exit 0
fi

banner
essentials

# ===========================================================================
#  Resolve the task and show the plan
# ===========================================================================

# If no task was specified up front, decide which one to run. In auto mode we pick a
# weighted-random task (so unattended runs spread across the task mix); interactively
# we ask. A non-interactive manual run just keeps the default.
if [ "$TASK_GIVEN" -eq 0 ]; then
  if [ "$AUTO" = "1" ]; then
    TASK="$(pick_weighted_task)"
  elif interactive; then
    choose_task
  fi
fi
# Lower-cased task name, used for the work-branch name and the PR title prefix.
TASK_LC="$(printf '%s' "$TASK" | tr '[:upper:]' '[:lower:]')"

# Resolve the task to its prompt, the repo to fork, and the local checkout folder.
# Markdown tasks are the Physlib default (leanprover-community/physlib in
# physlib-auto); YAML tasks declare their own repo/dir/prompt, all three required.
# Done up front - before the setup check and the slow fork/build - so the rest of the
# run knows exactly which repo and folder it's operating on.
resolve_task "$TASK" || die "Couldn't find task '$TASK'.
Looked for a local Tasks/$TASK.{yaml,yml,md} (and the capitalised name), then the
same on GitHub under $TASKS_RAW_BASE.
Check the task name - run with --help to see the available tasks."

# Optional question lists a YAML task may carry (both default to none):
#   input_questions:     asked BEFORE Claude runs; answers are prepended to the prompt.
#   challenge_questions:  asked AFTER, with Claude's diff shown; answers go in the PR.
# Only YAML tasks can define them; Markdown tasks never have questions.
INPUT_QUESTIONS=""
CHALLENGE_QUESTIONS=""
TASK_DESC=""
if [ "$TASK_FORMAT" = "yaml" ]; then
  UPSTREAM_REPO="$(yaml_scalar repo "$TASK_FILE")"
  WORK_DIR="$(yaml_scalar dir "$TASK_FILE")"
  PROMPT="$(yaml_block prompt "$TASK_FILE")"
  TASK_DESC="$(yaml_scalar description "$TASK_FILE")"
  INPUT_QUESTIONS="$(yaml_list input_questions "$TASK_FILE")"
  CHALLENGE_QUESTIONS="$(yaml_list challenge_questions "$TASK_FILE")"
  [ -n "$UPSTREAM_REPO" ] || die "YAML task '$TASK' is missing the required 'repo:' field (e.g. repo: ImperialCollegeLondon/FLT)."
  [ -n "$WORK_DIR" ] || die "YAML task '$TASK' is missing the required 'dir:' field (the local checkout folder, e.g. dir: flt-auto)."
  [ -n "$PROMPT" ] || die "YAML task '$TASK' is missing the required 'prompt:' block ('prompt: |' followed by the indented task text)."
else
  UPSTREAM_REPO="leanprover-community/physlib"
  WORK_DIR="physlib-auto"
  PROMPT="$(cat "$TASK_FILE")"
fi
# Human-friendly project name (the repo's basename), used in build/log messages.
PROJECT_NAME="${UPSTREAM_REPO##*/}"

# A short, one-line task description for the plan: an explicit YAML 'description:',
# else the first meaningful line of the prompt (stripped of a leading "# Task:"
# heading), trimmed so the plan stays tidy.
if [ -z "$TASK_DESC" ]; then
  TASK_DESC="$(printf '%s\n' "$PROMPT" | grep -m1 . || true)"
  TASK_DESC="${TASK_DESC#\# Task: }"; TASK_DESC="${TASK_DESC#\# }"; TASK_DESC="${TASK_DESC#Task: }"
fi
[ "${#TASK_DESC}" -gt 64 ] && TASK_DESC="${TASK_DESC:0:63}…"

print_plan

# Input questions: ask them now - before the slow fork/build - so the user can answer
# up front and then walk away. Their answers are prepended to the prompt as context
# Claude must take into account (for the TODO task, this is the TODO item itself).
# They need a terminal; with none (e.g. piped `curl | bash`) we warn and carry on.
if [ -n "$INPUT_QUESTIONS" ]; then
  if interactive; then
    section "A few questions before we start"
    ask_questions "$INPUT_QUESTIONS"
    if [ -n "$ASK_RESULT" ]; then
      PROMPT="Before the task below, here is the input I provided - take it into \
account as you carry out the task:

$ASK_RESULT

$PROMPT"
    fi
  else
    warn "Task '$TASK' has input questions but there's no interactive terminal to ask them; proceeding without answers."
  fi
fi

# ===========================================================================
#  Setup check: report the status of every prerequisite
# ===========================================================================

section "Setup check"
note "Anything not ready will be installed or set up automatically below."
printf '\n'

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

# ===========================================================================
#  Step 1. Prerequisites
# ===========================================================================

step "Install prerequisites"
have git  || die "git is required. Install it and re-run."
have curl || die "curl is required. Install it and re-run."

# Lean toolchain (elan / lake)
if ! have lake; then
  spin "Installing Lean (elan)" bash -c 'curl https://elan.lean-lang.org/elan-init.sh -sSf | sh -s -- -y'
else
  ok "Lean (lake) already installed."
fi
export PATH="$HOME/.elan/bin:$PATH"
have lake || die "lake not found after installing elan; open a new shell and re-run."

# GitHub CLI (gh)
if ! have gh; then
  if [ "$OS" = "Darwin" ] && have brew; then
    spin "Installing the GitHub CLI (gh)" brew install gh
  elif have apt-get; then
    log "Installing the GitHub CLI (gh)..."
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
  ok "GitHub CLI (gh) already installed."
fi

# uv (runner used by lean-lsp-mcp)
if ! have uv && ! have uvx; then
  spin "Installing uv" bash -c 'curl -LsSf https://astral.sh/uv/install.sh | sh'
else
  ok "uv already installed."
fi
export PATH="$HOME/.local/bin:$PATH"

# Claude Code
if ! have claude; then
  if have npm; then
    spin "Installing Claude Code" npm install -g @anthropic-ai/claude-code
    export PATH="$(npm prefix -g)/bin:$PATH"
  else
    die "Claude Code not found and npm unavailable. Install it from
https://docs.claude.com/en/docs/claude-code/overview and re-run."
  fi
else
  ok "Claude Code already installed."
fi

# ===========================================================================
#  Step 2. GitHub auth and the automated-PR limit
# ===========================================================================

step "Sign in to GitHub"
if ! gh auth status >/dev/null 2>&1; then
  if [ "$AUTO" = "1" ]; then
    die "Auto mode needs GitHub already authenticated. Run 'gh auth login' (or set
GH_TOKEN) and re-run."
  fi
  log "Signing in to GitHub (follow the prompts)..."
  gh auth login
else
  ok "Already signed in to GitHub."
fi

# Be a good citizen: if many automated PRs are already queued upstream, don't add
# more. Count open PRs whose title starts with "auto-" (the prefix every task here
# uses) and refuse to run when that exceeds MAX_OPEN_AUTO_PRS. Checked here, right
# after auth, so we bail before the slow fork/clone/build rather than after it.
if AUTO_PR_TITLES="$(gh pr list --repo "$UPSTREAM_REPO" --state open --limit 1000 \
    --json title --jq '.[].title' 2>/dev/null)"; then
  OPEN_AUTO_PRS="$(printf '%s\n' "$AUTO_PR_TITLES" | grep -c '^auto-' || true)"
  if [ "$OPEN_AUTO_PRS" -gt "$MAX_OPEN_AUTO_PRS" ]; then
    die "There are already $OPEN_AUTO_PRS open automated PRs on $UPSTREAM_REPO
(limit $MAX_OPEN_AUTO_PRS). Refusing to add more so we don't overwhelm the
maintainers - try again once some have been merged or closed."
  fi
  ok "$OPEN_AUTO_PRS open automated PR(s) on $UPSTREAM_REPO (limit $MAX_OPEN_AUTO_PRS) - OK to proceed."
else
  warn "Couldn't query open PRs on $UPSTREAM_REPO (GitHub API unreachable?); skipping the automated-PR limit check."
fi

# ===========================================================================
#  Step 3. Fork + clone
# ===========================================================================

step "Fork & clone $PROJECT_NAME"

# Always work in a dedicated checkout that this script owns ($WORK_DIR) - reuse it
# if it's already here, otherwise fork + clone it. (We never operate on whatever
# directory you happen to launch from, so a stray lakefile can't redirect the run.)
if [ -d "$WORK_DIR" ]; then
  ok "Reusing existing ./$WORK_DIR checkout (no re-clone)."
  cd "$WORK_DIR"
else
  spin "Forking and cloning $UPSTREAM_REPO into ./$WORK_DIR" \
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
  if git fetch upstream "$DEFAULT_BRANCH" 2>/dev/null; then
    BASE="upstream/$DEFAULT_BRANCH"
  else
    warn "Couldn't fetch upstream; basing the branch off local $DEFAULT_BRANCH."
  fi
else
  warn "No 'upstream' remote; basing the branch off local $DEFAULT_BRANCH."
fi
BRANCH="auto-${TASK_LC}-$(date +%Y%m%d-%H%M%S)"
git checkout -b "$BRANCH" "$BASE" 2>/dev/null \
  || { warn "Branch $BRANCH exists; checking it out."; git checkout "$BRANCH"; }
ok "Working on branch $BRANCH (off $BASE)."

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
info "Commit identity: $(git config user.name) <$(git config user.email)>"

# ===========================================================================
#  Step 4. Build (slow the first time)
# ===========================================================================

step "Build $PROJECT_NAME"
note "The first build can take 10+ minutes; later runs reuse the cache and are quick."

# Bail out clearly if the cache fetch or build fails. The usual cause is a corrupt
# or half-written checkout/cache, and the reliable fix is a fresh clone - so point
# the user straight at deleting the checkout we own.
build_die() {
  die "$1

This usually means the existing checkout or its Mathlib cache is in a bad state.
Delete the checkout and re-run this script for a clean clone + build:
  rm -rf \"$CHECKOUT_DIR\""
}

spin "Fetching the Mathlib cache" lake exe cache get \
  || build_die "Failed to fetch the Mathlib cache (lake exe cache get)."

# Stream the build itself: lake prints per-module progress, which is the most
# reassuring signal during the long first build, and report how long it took.
build_start=$SECONDS
log "Building (output below)..."
lake build || build_die "Failed to build $PROJECT_NAME (lake build)."
ok "Build complete in $(fmt_duration $((SECONDS - build_start)))."

# ===========================================================================
#  Step 5. Register the Lean LSP MCP server
# ===========================================================================

step "Connect Lean tools"
if claude mcp add lean-lsp -- uvx lean-lsp-mcp >/dev/null 2>&1; then
  ok "lean-lsp-mcp registered with Claude Code."
else
  info "lean-lsp may already be registered; continuing."
fi

# ===========================================================================
#  Step 6. Hand off to Claude
# ===========================================================================

step "Run the task with Claude"

# Temp files (outside the repo, so they never get committed) where Claude leaves
# the PR title and description for the script to use in step 7. Registered with the
# cleanup trap set up at the top so they're removed on exit.
PR_TITLE_FILE="$(mktemp)"; CLEANUP_FILES+=("$PR_TITLE_FILE")
PR_BODY_FILE="$(mktemp)";  CLEANUP_FILES+=("$PR_BODY_FILE")

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
  log "Launching Claude headless on the '$TASK' task; it will work and exit on its own."
  note "Sit tight - this can take a while. Output from Claude follows."
  printf '\n'
  set +e
  claude -p "$PROMPT" --permission-mode bypassPermissions
  set -e
else
  log "Launching Claude on the '$TASK' task."
  warn "When Claude is done, exit it (Ctrl-D or /exit) to hand control back to this script."
  printf '\n'
  set +e
  claude "$PROMPT"
  set -e
fi

# ===========================================================================
#  Step 7. Commit, push, and open the pull request
# ===========================================================================

step "Review & open the pull request"
git add -A

if [ -z "$(git diff --cached --name-only)" ]; then
  warn "Claude made no changes - there's nothing to open a PR for. Stopping here."
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
  warn "Claude left no PR text - its signal that the task isn't finished."
  note "Your changes are staged on '$BRANCH' but nothing was committed or pushed."
  note "Re-run Claude on this branch to finish the task, then re-run this script."
  exit 0
fi

# Challenge questions: a human-in-the-loop gate on Claude's work. Show the full
# staged diff (the change the PR will carry) and ask the task's challenge questions
# as yes/no checks; the verdicts are recorded in the PR body so the human assessment
# travels with the PR. A "no" to any question stops the run here - nothing is
# committed or pushed. Interactive only - with no terminal (headless auto runs) we
# skip them. CHALLENGE_FAILED defaults to 0 so the check below is safe either way.
CHALLENGE_FAILED=0
if [ -n "$CHALLENGE_QUESTIONS" ]; then
  if interactive; then
    log "Review Claude's changes - the diff this PR will carry:"
    printf '\n'
    git --no-pager diff --cached
    printf '\n'
    section "Review checks (answer y or n)"
    ask_challenge_questions "$CHALLENGE_QUESTIONS"
    if [ -n "$ASK_RESULT" ]; then
      printf '\n---\n\n## Human review\n\n%s\n' "$ASK_RESULT" >>"$PR_BODY_FILE"
    fi
    if [ "$CHALLENGE_FAILED" = "1" ]; then
      warn "You answered 'no' to a review check - stopping without opening a PR."
      note "Your changes are staged on '$BRANCH' but nothing was committed or pushed."
      note "Re-run Claude on this branch to revise, then re-run this script."
      exit 0
    fi
  else
    warn "Task '$TASK' has challenge questions but there's no interactive terminal; skipping the review."
  fi
fi

# Summarise the proposed pull request so it's clear what's about to be opened.
section "Proposed pull request"
kv "Title" "$TITLE"
kv "Into"  "$UPSTREAM_REPO ${C_DIM}($DEFAULT_BRANCH)${C_RESET}"
kv "From"  "$BRANCH"
printf '\n'
git --no-pager diff --cached --stat
printf '\n'

if [ "$AUTO" = "1" ]; then
  log "Auto mode: pushing '$BRANCH' and opening the PR."
else
  read -r -p "  $SYM_ARROW Push and open this pull request? [Y/n] " REPLY </dev/tty || REPLY=""
  case "$REPLY" in
    [Nn]*) warn "Stopped - your changes are staged on '$BRANCH'. Nothing was pushed."; exit 0 ;;
    *) ;;
  esac
fi

# Separate -m args become paragraphs (blank line between), so the trailer lands as
# its own block at the end of the message, which is what GitHub needs to attribute
# the co-author.
spin "Committing the change" git commit -m "$TITLE" -m "Co-authored-by: $CLAUDE_COAUTHOR"
spin "Pushing '$BRANCH' to your fork" git push -u origin "$BRANCH"

ME="$(gh api user --jq .login)"
log "Opening the pull request..."
PR_URL="$(gh pr create --repo "$UPSTREAM_REPO" --base "$DEFAULT_BRANCH" \
  --head "${ME}:${BRANCH}" --title "$TITLE" --body-file "$PR_BODY_FILE")" \
  || die "Failed to open the pull request. Your branch is pushed; you can open it
manually at https://github.com/$UPSTREAM_REPO/pulls"

# Closing summary: the headline result, the clickable PR link, and total time.
section "Done"
ok "Pull request opened."
kv "PR"   "$PR_URL"
kv "Task" "$TASK"
kv "Time" "$(fmt_duration "$SECONDS")"
printf '\n'
