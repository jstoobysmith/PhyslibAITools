# PhyslibAITools (GUI)

A desktop app (Tauri v2 + React/TypeScript + Rust) that walks someone with no
coding/GitHub/AI-tooling experience through contributing to
[Physlib](https://github.com/leanprover-community/physlib): sign in to Claude
Code, sign in to GitHub, get a Lean/Mathlib workspace set up, then pick a task
from [`../Tasks`](../Tasks) and watch Claude carry it out, ending in a real
pull request.

Everything for the GUI lives in this folder. Nothing outside `GUI/` is
changed by it, and this app never invokes `../Scripts/physlib-auto-task.sh` -
see [Why native, not the bash script](#why-native-not-the-bash-script) below.

## Installing

Download the installer for your platform from the
[releases page](https://github.com/jstoobysmith/PhyslibAITools/releases)
(or build one yourself - see [Running it](#running-it) below). Since none of
these are code-signed, the OS will warn you the first time - that's expected,
not a sign something's wrong, but it's worth knowing before you hit it.

**Windows**

1. Get `PhyslibAITools_<version>_x64-setup.exe` (or the `.msi` - both work
   the same way; the releases page has both, and `npm run tauri build`
   produces both under `src-tauri/target/release/bundle/`).
2. Run it. Because it isn't code-signed, Windows SmartScreen will likely show
   *"Windows protected your PC"*. Click **More info**, then **Run anyway**.
3. Follow the installer through its default prompts - it creates a Start
   Menu entry and an uninstaller, same as any Windows app.
4. Launch **PhyslibAITools** from the Start Menu.

Requires the WebView2 runtime, which comes preinstalled on Windows 11 and
most up-to-date Windows 10 machines - if it's somehow missing, the
[Microsoft Edge WebView2 page](https://developer.microsoft.com/microsoft-edge/webview2/)
has the standalone installer.

**macOS**

Get the `.dmg` for your Mac from the releases page - `aarch64` for Apple
Silicon, `x64` for Intel (`npm run tauri build` on a Mac produces the same
`.app` bundle and `.dmg` under `src-tauri/target/release/bundle/`). Running
the app on macOS is untested by this project
(no Mac was available while building it - see "Known limitations" below for
exactly what's been reviewed vs. actually run), but the steps follow
standard Tauri/macOS conventions:

1. Open the `.dmg` and drag **PhyslibAITools.app** into **Applications**.
2. Because it isn't signed with an Apple Developer certificate or
   notarized, Gatekeeper will block the first launch (*"cannot be opened
   because the developer cannot be verified"*, or *"is damaged and can't be
   opened"* on newer macOS versions - a misleading message for the same
   cause). Right-click (or Control-click) the app in Finder, choose **Open**,
   then confirm **Open** in the dialog - this only needs doing once. If that
   doesn't work, System Settings → Privacy & Security has an "Open Anyway"
   button that appears after the first blocked attempt.
3. Launch **PhyslibAITools** from Applications or Spotlight from then on.

## Running it

```bash
npm install
npm run tauri dev     # launches the app in dev mode
npm run tauri build   # produces a native installer/binary for this OS
```

Requirements to build: Node.js, and Rust (`rustup`) with a recent stable
toolchain (Tauri v2's dependencies need rustc 1.88+; run `rustup update
stable` if `cargo check` complains about an old compiler). On Windows you
also need the WebView2 runtime (preinstalled on Windows 11 and most Windows
10 machines) and the MSVC build tools that `rustup`'s default Windows
toolchain already expects.

Running from inside a checkout of this repo (as above) makes task discovery
read `../Tasks` directly off disk, so editing a task file and restarting the
app picks it up immediately - useful for developing the GUI itself. A
*packaged* build (the thing an end user downloads) has no such sibling
folder, so it fetches the current task list from GitHub instead, with a
snapshot bundled at build time as an offline fallback (see
[Task discovery](#task-discovery) below).

## Architecture

```
src/                     React + TypeScript frontend
  theme/                 design tokens + light/dark theme (see Visual design)
  components/            shared UI: Button, Card, Spinner, LogPane, CodeBlock, Badge
  onboarding/             the 3-step wizard (Claude login, GitHub login, env setup)
  tasks/                  task discovery, run flow, activity feed, diff review
  lib/                    typed wrappers around Tauri's invoke/listen + shared types
src-tauri/                Rust backend
  src/
    lib.rs                command registration, tool-detection status
    process.rs             shared subprocess-streaming helper (used everywhere)
    paths.rs                OS tool detection + PATH augmentation
    config.rs               JSON config store in the OS app-data dir
    commands/
      auth_claude.rs         opens a real terminal for Claude subscription sign-in
      auth_github.rs          `gh auth login --web` login flow
      setup_env.rs             native per-OS installers + clone/build/mcp-register
      workspace.rs              git fork/clone/branch/diff helpers
      tasks.rs                  task discovery (local / GitHub / bundled)
      run_task.rs                spawns `claude -p`, parses stream-json, PR creation
  resources/tasks-snapshot/  offline fallback copy of Tasks/, refreshed by hand
                             from ../Tasks when it's meaningfully out of date
```

### Why native, not the bash script

`Scripts/physlib-auto-task.sh` already does this end-to-end from a terminal,
but only auto-installs on macOS (Homebrew) and Debian/Ubuntu (apt), and
relies on bash's `/dev/tty` reads for its prompts. Since this GUI exists
specifically for people who aren't comfortable with a terminal, the decision
(made explicitly, not by default) was to **not** wrap that script and instead
re-implement the equivalent orchestration natively:

- Every external tool (`git`, `gh`, `lake`, `claude`, `uv`) is invoked
  directly as a subprocess - never through bash. On Windows, native installs
  go through `winget` and each tool's own PowerShell/`.exe` installer; on
  macOS/Linux through Homebrew/apt and each tool's official install
  one-liner (invoked via `sh -c`, the OS's own default shell, not a
  dependency we're adding).
- Claude runs in headless JSON-streaming mode (`claude -p --output-format
  stream-json`) instead of its interactive TUI, so the GUI can render a real
  activity feed (tool calls, edits, commentary) instead of a raw terminal.
- `gh auth login --web`'s single "press Enter" prompt is handled over plain
  piped stdin/stdout - see `commands/auth_github.rs`. `gh` normally opens the
  browser itself once that's confirmed, but doesn't when its stdio is piped
  like this (not a real TTY), so `GitHubLoginStep.tsx` opens
  `github.com/login/device` itself as soon as the device code appears -
  that URL is fixed and not session-specific, unlike Claude's OAuth URL, so
  there's nothing to parse out of the CLI's output first. Completion is also
  detected from `gh`'s own "Logged in as `<user>`" success line rather than
  waiting on the process to exit - observed in practice, the process can
  keep running (or `child.wait()` can take a long time to resolve) well
  after that line prints, plausibly a Windows browser-launcher helper
  inheriting `gh`'s piped handles. Whichever signal (the text or the actual
  exit) arrives first wins; the other is a no-op.
- Claude Code login (`commands/auth_claude.rs`) uses the CLI's own
  subscription OAuth flow, `claude setup-token` - no API billing - run fully
  automatically on Windows: no visible window, no manual copy-paste. Getting
  there took three tries. First, plain piped stdio: hangs immediately, since
  the CLI opens by sending a `\x1b[6n` "where's the cursor?" terminal query
  and waits for an answer only a real terminal sends. Second, a
  `portable-pty` pseudo-console with that one query auto-answered
  transparently in Rust: this unblocked the initial output and the OAuth
  URL, but completion itself - a background check the CLI does after the
  browser step - stayed unreliable in ways that couldn't be pinned down from
  outside the CLI. Only a genuine, unwrapped terminal window was confirmed
  to complete reliably every time - which pointed at the real difference:
  not "visible vs. hidden" but "real Win32 console vs. from-scratch
  pseudo-console emulation". `conhost.exe` answers every terminal query
  itself, correctly, for a real console, hidden or not - window visibility
  is purely a window-manager property and doesn't touch how the console API
  behaves. So the current version gives the child a real console
  (`CREATE_NEW_CONSOLE`, confirmed with a standalone test to print its full
  banner and OAuth URL with zero query-answering on our part) but hides its
  window, then borrows that console's output buffer from our own process
  just long enough to copy its text (`AttachConsole` + `CONOUT$` +
  `ReadConsoleOutputCharacterW`, polled a few times a second) to pull out the
  sign-in link (the CLI already opens this itself, so the app only shows it
  as a manual "click here" fallback - having the app *also* open it
  produced a visible duplicate browser tab) and the final printed token
  (verified automatically before being saved). Not available on macOS/Linux yet, and
  if it ever fails on Windows too, "sign in with a terminal instead" falls
  back to the previous version: a real visible terminal
  (`open_claude_login_terminal`) with the token pasted back in by hand. A
  subscription login done that same way (typing `claude` and `/login`
  instead) is picked up automatically too (`claude_credentials_exist()`),
  with a "check again" button since the app can't know that finished on its
  own.

The tradeoff: `setup_env.rs`, `workspace.rs`, and `run_task.rs` duplicate
logic that already exists in `physlib-auto-task.sh` (fork/clone/branch
naming, the PR-text handoff convention, the politeness cap on open `auto-`
PRs, etc.), adapted for structured native execution instead of terminal
text. That duplication is intentional, not an oversight - see the plan this
was built from for the full reasoning.

One exception worth knowing about: Claude Code's own **Bash tool** looks for
Git Bash on Windows (without it, Claude Code falls back to a PowerShell
tool). Installing `git` via `winget install --id Git.Git` already includes
Git Bash, so this is satisfied as a side effect of installing git at all -
the GUI's *own* orchestration still never touches bash.

### Task discovery

`commands/tasks.rs` tries, in order: (1) a local `../Tasks` folder (running
from inside a checkout - the dev-mode path), (2) the live listing from
`Tasks/` on `jstoobysmith/PhyslibAITools` via `gh api` (reusing the `gh`
login onboarding already set up, so this runs at the normal 5000/hour
authenticated rate limit), (3) the snapshot bundled into the app at build
time in `resources/tasks-snapshot/`. This means a packaged app always shows
newly-added tasks without a new release, but still works offline with
whatever was bundled last. Parsing (`description:`/`prompt:`/question lists
for YAML, first line for Markdown) happens in `src/tasks/parseTask.ts` -
deliberately on the frontend, in one place, rather than duplicated in Rust.

`TaskList.tsx`'s top-right corner shows whether the local
Physlib checkout is behind upstream (`WorkspaceSyncStatus`, sharing the
`useWorkspaceSync` hook - `src/lib/useWorkspaceSync.ts` - and underlying
`check_workspace_health` / `sync_workspace` commands with the setup
dashboard's own sync nudge - see "Keeping builds fast" below), with a "Sync"
button that re-fetches the Mathlib cache and rebuilds, and a badge that
swaps to a live "Fetching Mathlib cache…" / "Building Physlib…" readout
while that's running. Like the onboarding version, this is a speed
optimization, not a correctness gate.

If either sync step fails, `sync_workspace` doesn't just report the
failure: `run_step_with_auto_fix` (`workspace.rs`) spawns a headless Claude
session to diagnose and fix it - a wrong Lean toolchain version, a
corrupted `.lake` cache, disk space, a flaky network call - then retries
that one step once. Its progress renders as the same activity feed a task
run uses (`describeEvent`/`ActivityFeed`, reused via
`process::spawn_claude_streaming`, the same helper `run_task.rs` uses). This
is deliberately scoped to *environment* problems, not Physlib source bugs:
the prompt explicitly tells Claude not to patch `.lean` files to work around
a real compile error, because every task branch is created fresh from
`upstream/<default>` (`create_task_branch`) regardless of what this sync
workspace's own working tree contains - a source-level fix made here
wouldn't carry over to any future task run anyway, so if the upstream code
genuinely doesn't build, the right outcome is Claude saying so clearly, not
guessing at a patch. Only one fix attempt is made per failure; if it's still
broken afterward, that's surfaced as a normal error rather than retried
forever.

### Setup is re-checked on every launch

Nothing about "setup is done" is trusted from a stale flag. On every launch
(`App.tsx`), and on the setup dashboard itself, readiness is derived live
(`src/lib/readiness.ts`): Claude from a stored token or Claude Code's own
credentials file, GitHub from a real `gh auth status` call, and the
workspace from `check_workspace_health` actually checking the folder still
exists *and* that Physlib has actually finished building
(`WorkspaceHealth.built`, `workspace.rs::is_built`) - not just that `.git`
is there. That distinction matters: a `run_setup` whose clone step succeeded
but whose `lake exe cache get`/`lake build` step failed or got interrupted
would otherwise still report `exists: true` on the next launch and skip
straight past onboarding into a task list backed by a Physlib that doesn't
build. `is_built` checks for the compiled `.olean` output of each of
`lakefile.toml`'s `defaultTargets` (`Physlib`, `QuantumInfo`) rather than
re-running `lake build` to verify, since Lean only writes a module's
`.olean` once that module (and everything it imports) has actually compiled
- cheap, no-rebuild-needed evidence the last build really finished, at the
cost of not catching a build that's since been broken by an external edit
outside this app (a real full rebuild would, but defeats the point of a
fast live check on every launch). If any of these regress - a `claude`/`gh`
logout, a deleted or half-built workspace folder - the relevant section
reverts to "needs attention" instead of being silently masked, the bug the
very first version of this had.
`config.onboarding.*Done` is still written on each step's completion but
deliberately unread by any of this - it's a leftover from an earlier
version, kept only because nothing depends on removing it.

That "derived live" state (`toolStatus`) is fetched once per launch and
handed down as a prop, though - a login step completing doesn't change that
snapshot on its own. `SetupDashboard.tsx` explicitly re-calls `detectTools()`
after `ClaudeLoginStep`/`GitHubLoginStep` report success and pushes the
fresh result back up to `App.tsx` (`onToolStatusChange`); skipping this was
a real bug (GitHub login would complete for real - confirmed by `gh`'s own
"Logged in as `<user>`" - but the dashboard never noticed and stayed stuck
on that step, since `isGithubReady` has no other signal to fall back to the
way `isClaudeReady` does with a stored token).

### Switching accounts

The gear icon in the header (`AppShell.tsx`, only shown once the task
dashboard is reached - `App.tsx`'s `showSettings` state) reopens the exact
same account screen onboarding used, so signing out or switching a
Claude/GitHub account doesn't need a reinstall or manually hunting down
credential files. It's the same `SetupDashboard` component in both places,
distinguished by one prop: `autoAdvance`. Onboarding (`autoAdvance={true}`)
auto-advances to the task dashboard the instant all three sections are
ready; settings (`autoAdvance={false}`) doesn't - everything already being
ready is the *normal* case for opening settings, not a reason to instantly
bounce back out - so it shows a manual "← Back to tasks" button instead. A
signed-in section's row grows a "Sign out" button (`claude_logout` deletes
Claude Code's credentials file; `github_logout` runs `gh auth logout`),
which flips that section back to its normal sign-in step so a different
account can be used. "Back to tasks" still works if something's left
signed out, but routes to full onboarding instead of the task dashboard
(`App.tsx` checks readiness itself rather than trusting the click) - so
leaving settings mid-switch can't strand the app on a task list backed by
an account that's no longer signed in.

### Keeping builds fast

The first build is unavoidably slow (fetching the Mathlib cache and
compiling Physlib's own files, easily 10+ minutes) - but it should be the
*only* slow one. Two things keep later runs fast:

- **The workspace is reused, never re-cloned or `lake clean`ed** - Lean's
  incremental compiler only rebuilds what actually changed.
- **`check_workspace_health` / `sync_workspace`** (`commands/workspace.rs`)
  detect when the local checkout has fallen behind upstream Physlib and let
  the user pull + rebuild in one click from the setup dashboard, so a task
  run starts from an already-warm cache instead of a cold one. This is
  offered as a nudge, not forced automatically, since a stale local default
  branch doesn't affect correctness - every task run already fetches and
  branches off `upstream/<default>` fresh regardless.
- **Clicking "Sync" checks first and does nothing else if there's nothing to
  do.** `sync_workspace` fetches `upstream/<default>` and checks
  `behind_upstream`/`is_built` (the shared `compute_behind_upstream` helper,
  also used by `check_workspace_health`) *before* touching the Mathlib cache
  or running `lake build` - both real, non-free work even when nothing
  actually changed - and returns immediately if the workspace is already
  current and built.

Beyond that, the single biggest lever - especially on Windows - is
excluding the workspace folder from real-time antivirus scanning. Windows
Defender scanning every one of the many small `.olean`/build files Lean
writes is a well-known, often 2x+ slowdown for Lean/Mathlib builds. This
needs an admin PowerShell prompt and isn't something the app does for you
(changing security settings isn't something to automate silently):

```powershell
Add-MpPreference -ExclusionPath "<your workspace folder>"
```

`lake build` itself has no manual parallelism flag to tune (`lake --help`
confirms this in the installed version) - it already schedules jobs across
available cores on its own.

### Known limitations / honest gaps

- **`claude -p --output-format stream-json`'s exact event schema isn't
  fully documented.** `src/tasks/describeEvent.ts` handles the shapes
  confirmed by a real test run (`system`/`init`, `assistant` with
  `text`/`tool_use` content blocks, `user` with `tool_result`, `result`,
  `rate_limit_event`) and falls back to a de-emphasized raw-JSON line for
  anything else, so an unrecognized event degrades gracefully instead of
  breaking the feed.
- **`claude setup-token`'s OAuth completion was, under a `portable-pty`
  pseudo-console, observed to hang for reasons that couldn't be fully
  diagnosed from outside the CLI.** Real, currently-open issues on Claude
  Code's own tracker describe similar symptoms -
  e.g. [anthropics/claude-code#9376](https://github.com/anthropics/claude-code/issues/9376)
  documents an older local-callback-server mechanism with a
  Windows-specific IPv6-binding bug (confirmed **not** present in the
  currently-installed CLI version here, by spawning it under a PTY and
  polling for a listening port throughout the whole flow - none ever
  appeared). The current version sidesteps this by not using a pseudo-console
  at all - `claude setup-token` runs in a genuine Win32 console
  (`CREATE_NEW_CONSOLE`, window hidden), the same kind every other Claude
  Code user authenticates in successfully, just not shown on screen. This
  was confirmed empirically (a standalone test watched it print its full
  banner, "Opening browser to sign in…", and the OAuth URL correctly with no
  query-answering on our part) before being wired in, but the full OAuth
  round-trip itself still depends on the CLI's own background completion
  check, which is outside this app's control either way - if sign-in ever
  seems stuck, "sign in with a terminal instead" (a real, visible terminal)
  is the fallback and also a good way to check whether the same thing
  happens completely independent of this app.
- **The Claude OAuth token is stored in the plain JSON config file**
  (`config.rs`), not an OS keychain. Wiring up proper OS-keychain storage
  (e.g. the `keyring` crate) is a reasonable follow-up, not required to
  demonstrate the architecture.
- **The terminal-launch command is Windows-first** (`cmd /K`); the
  macOS (`osascript`/Terminal.app) and Linux (tries `x-terminal-emulator`,
  `gnome-terminal`, `konsole`, `xterm` in turn) branches in
  `open_claude_login_terminal` follow the same idea. The frontend checks
  `current_platform()` up front so macOS/Linux go straight to this flow
  instead of first calling the Windows-only automatic one and showing its
  guaranteed failure as an error.
- **Windows is the best-tested platform** (it's what this was built,
  compiled, and manually run against) - the macOS/Linux code paths have only
  been reviewed and, where possible, checked in isolation, never actually
  run on those OSes (this machine can't cross-compile Tauri's macOS backend
  at all - `wry`/`tao`'s Objective-C build scripts need real Apple SDK
  frameworks). Two real bugs were caught this way and fixed without being
  able to confirm the fix on real hardware, so treat macOS as "reviewed, not
  verified" until someone runs it there:
  - `open_claude_login_terminal`'s macOS branch set `PATH` on the `osascript`
    process itself, which does nothing - "tell Terminal to do script" runs
    in a brand new Terminal.app session that doesn't inherit osascript's
    environment. Fixed by baking `export PATH=...` directly into the shell
    command that actually runs in that session instead; the string-escaping
    for that (`shell_single_quote` / `applescript_escape`) was verified by
    cross-checking the file against the `x86_64-apple-darwin` target and by
    round-tripping the generated shell commands through a real POSIX `sh`
    (spaces, embedded `'`, and embedded `"` in the path all survive intact).
    The AppleScript-quoting half of that couldn't be verified the same way
    (no `osascript` outside macOS) but follows AppleScript's documented
    string-escaping rule (only `\` and `"` need escaping).
  - `setup_env.rs`'s `gh` install on macOS called `brew install gh`
    unconditionally, with no check that Homebrew is even present (unlike
    every other tool here, `gh` has no dependency-free curl one-liner) -
    fixed to fail with an actionable message instead of a confusing shell
    error when Homebrew is missing. Separately, `xcode-select --install`
    (the no-Homebrew path for installing git) only opens a GUI dialog and
    returns immediately - it does not wait for the user to click through
    it - so treating its exit code as "git is now installed" was wrong;
    fixed to poll for `git` actually appearing on `PATH` (up to 20 minutes)
    instead.
- **A task run can end prematurely if Claude backgrounds a long command
  (like `lake build`) and doesn't wait for it.** Observed in practice on a
  linting task: Claude's last message described a build still running in
  the background, and the headless session then simply ended there -
  `claude -p` is one-shot, so nothing wakes it back up when a backgrounded
  job finishes the way this interactive harness would. The PR-text-handoff
  footer in `run_task.rs` now explicitly says so (run long commands to
  completion synchronously, or actively poll a backgrounded one before
  ending the turn), but this is prompting guidance, not something the code
  can strictly enforce - and the same gap exists unfixed in
  `physlib-auto-task.sh`'s identical prompt footer, since it was copied
  from there. A run that ends this way leaves its branch/staged changes
  behind locally (nothing is pushed) rather than losing the work.
- **The sync auto-fix (`run_step_with_auto_fix`) hasn't been exercised
  against a real failing `lake exe cache get`/`lake build`** - reviewed and
  built on the same `spawn_claude_streaming` path already proven by task
  runs, but reproducing an actual environment failure to watch it diagnose
  and fix one end-to-end wasn't practical to set up here. If it doesn't
  manage to fix something, the original failure is still reported normally
  (it only replaces silent failure with one extra attempt, never makes
  things worse), but the "diagnoses and fixes it well" part is unverified.
  One real bug this surfaced in early testing: the diagnostic session's
  `child.wait()` had no timeout, so if that headless `claude -p` call hung -
  a real failure mode already seen elsewhere in this app, see
  `auth_claude.rs`'s history - the whole `sync_workspace` call never
  returned, leaving the frontend stuck showing "Claude is diagnosing…"
  forever (`await syncWorkspace(...)` never resolving means its `finally`
  never runs either). Fixed with a bounded timeout
  (`DIAGNOSTIC_FIX_TIMEOUT`, 15 minutes - generous, since the diagnostic
  session may legitimately need to run a full `lake build` itself to
  verify a fix) that kills the session and reports a clear error instead of
  hanging indefinitely.
- **No live back-and-forth chat with Claude mid-task.** Every run is the
  headless, review-before-push flow (matching the script's own recommended
  `AUTO=1` default) - resuming a headless session for a follow-up message
  isn't confirmed to be supported by the CLI, so it's not built.
- **No auto-updater or run-history browser yet** - v1 focuses on the
  onboarding → task → PR path working end-to-end. Installers are built and
  published by `.github/workflows/release.yml` (pushing a `v*` tag, or
  running the workflow manually, drafts a GitHub release with Windows and
  macOS installers), but installing a newer version is still a manual
  download.

## Visual design

The color palette, fonts, and shape language are pulled directly from
[physlib.io](https://physlib.io)'s shipped CSS, not guessed: **Geist** /
**Geist Mono** (self-hosted via `@fontsource`, so the packaged app doesn't
depend on network fonts), a light theme (`#f5f5f5` background, `#0485f7`
accent) and dark theme (`#060607` background, `#00b5f3` accent), `0.5rem`
base corner radius, and soft layered shadows. See `src/theme/theme.css` for
the full token set. The header uses the existing
`physlib-auto/docs/Physlib-logo.jpeg` mark rather than re-fetching anything
from the website.
