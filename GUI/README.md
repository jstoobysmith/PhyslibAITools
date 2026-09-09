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

## Missions

A second, independent interface in the same app, modelled on
[Prove2Me](https://prove2.me) and its
[paper](https://arxiv.org/abs/2608.28433) - but entirely offline and
single-user. Nothing is uploaded, there is no account, no server and no other
contributors; the only thing it borrows from the rest of the app is the Claude
credential and the Physlib workspace.

**The flow.** Describe a problem in natural language, attach any sources -
papers as files, and links the agent fetches at run time - and an agent
researches it (your sources, plus its own web research) and produces a
*decomposition graph*: a DAG whose root is the goal theorem and whose branches
bottom out in Mathlib and Physlib - the **origins**. Each node is a theorem
card carrying a natural-language description, the same statement in LaTeX, a
preamble of imports, and the formal Lean statement, which always terminates in
`:= by sorry`. A node is stated, never proved.

Nodes are joined by **proof-sketches**: one Lean file that proves a parent
*conditional on* the children it imports, including children that are still
open. That is the whole decomposition mechanism - the parent resolves once its
children do, and each child is an independent problem some later run can attack
on its own. Sketches are drawn on the canvas as their own box between a parent
and its children, because a parent's children are only jointly sufficient
*through* the sketch.

**Solved vs. open problems.** If the problem has a known solution, the graph
connects the origins to the goal. If it is open, the graph is built as far as
the literature genuinely supports and then stops: the goal is stated, the space
below it is left empty, and that gap is drawn explicitly with the agent's
account of what stands in it. An honest empty space is the mission's result,
not a failure to render one.

**Sources.** Files are copied into the mission's own folder so the record stays
self-contained; links are stored as URLs and fetched when a run starts, which is
the honest model - a page's content isn't ours and can change under us. Each
source takes an optional note, passed to the agent verbatim: "this is the paper
the proof is from" and "this is background" should not be treated alike, and
that one line is the cheapest way to say which. Sources are editable after
creation, because which paper actually matters is usually something you learn
from the first generated graph.

**Model.** Each mission carries the model its agent runs use - passed straight
to `claude --model`, or left unset to use whatever Claude Code is already
configured with. It's changeable from the mission toolbar, so in practice it's
per-run: generate the graph with Opus 5 or Fable 5.1, then grind through routine
leaf lemmas on Sonnet 5. Which ids work depends on the signed-in account's plan;
an unavailable one fails when the run starts, with the CLI's own error.

**Working the graph.** Once a graph is valid, two agent actions are available:

- **Work on proofs** - close open nodes on the *frontier* (open nodes with
  nothing unproved beneath them). A proof is a Lean file declaring
  `theorem solution` with exactly the node's type.
- **Extend toward goal** - add new intermediate statements that reduce the
  distance to the goal, plus sketches connecting them where they honestly can
  be connected.

### Runs

Runs are concurrent, and each has its own Stop button. They live outside React
(`missionRuns.ts`, an external store read through `useSyncExternalStore`),
because a run takes minutes to hours and you are expected to switch mission,
switch to the Tasks tab, and come back - state held in a component would die
with the first unmount. Every run is listed both on its mission and on the
Missions list, so one left going elsewhere is always findable.

What may overlap is decided by what would actually collide on disk, not by a
blanket rule:

- **Different missions** never collide - separate scratch trees, separate
  records - so they always run together.
- **`generate` and `extend`** both rewrite a mission's statements, so only one
  of them may touch a given mission at a time.
- **`prove` runs** write one `Solutions/Sol_<node>.lean` per target, so any
  number can run at once as long as no two are aimed at the same node. One
  open-ended prove run (no targets, agent picks from the frontier) is allowed
  at a time, since two would pick the same nodes.

Two further races are handled in the store rather than by refusing work.
Several runs finishing at once each want to read-modify-write `mission.json`
and then verify over shared scratch files, so both go through a per-mission
promise chain: the second finish queues, re-reads what the first just wrote,
and merges onto that instead of clobbering it. And a run's event listeners are
attached *before* its process starts, so a fast run cannot emit `finished` into
a void and appear to hang forever.

**Stopping is not destructive.** The result file is read whenever the process
exits, including when you stop it, and every prompt instructs the agent to keep
that file complete and valid as it goes rather than writing it once at the end.
So a stopped run keeps whatever it had finished: the store leaves its listeners
attached, merges the salvaged JSON, and marks the run stopped rather than
finished. Nothing is saved *during* a run beyond that file - the agent's
in-progress reasoning is gone - but completed nodes and proofs survive.

### How a graph is verified

Every statement is typechecked by the real Lean compiler on your machine. No
lake target is added and the lakefile is never touched: each node is written to
`<workspace>/.p2m/<missionId>/` and checked with `lake env lean`, which hands it
the project's full `LEAN_PATH` from the already-built workspace. A node
importing a chunk of Mathlib takes seconds, not the 10+ minutes a project build
does.

```
<workspace>/.p2m/<missionId>/
  Definitions/Def_<name>.lean    module Definitions.Def_<name>
  Theorems/Thm_<name>.lean       module Theorems.Thm_<name>   (one open statement each)
  Solutions/Sol_<name>.lean      proofs and proof-sketches
  build/                         oleans, put on LEAN_PATH so nodes can import each other
```

Statements compile to oleans under `build/`, and that folder goes on
`LEAN_PATH` for everything checked after them - which is precisely what lets a
proof-sketch `import Theorems.Thm_child` and be checked against a child lemma
that is itself still open.

Two constraints are worth knowing, both found the hard way and both encoded in
`lean.rs`: `lake env lean -o` refuses an input file outside the lake project
root (hence the scratch tree living *inside* the checkout, while the durable
mission record lives in the app-data dir beside `config.json`), and Lean will
not create the parent directory of `-o` for you. `lake` also only resolves the
project from its root, so agent runs are started there rather than in the
mission folder.

The scratch tree is added to `.git/info/exclude` (not `.gitignore`, which
belongs to upstream) the first time it's created, so generated Lean can never
turn up in a task run's staged diff or a pull request.

### Exporting and importing a mission

A mission's toolbar has **Export JSON**, and the new-mission screen offers
**Open mission JSON…** as an alternative to the blank form. Together they make
a graph a portable artifact: shareable, reviewable, checked into a repo
alongside the Lean it describes.

The export is read back from disk rather than taken from the UI, so a file is
always of what was actually saved, never of unsaved state. It's re-serialized
on the way out, so an export is provably valid, pretty-printed JSON.

Import makes two deliberate choices:

- **A fresh mission id, but node and sketch ids are kept.** Every internal
  reference (`dependsOn`, a sketch's `targetId` and `imports`) is expressed in
  node ids, so keeping them preserves the graph exactly; only the mission's own
  identity changes, which means importing the same file twice gives two
  independent missions rather than one silently overwriting the other.
- **Verification results are dropped unless they were produced here.** A check
  is a claim about one Physlib/Mathlib/toolchain combination, and a mission
  from somebody else's machine carries claims this app cannot vouch for.
  Anything whose recorded environment doesn't match the current workspace on
  *all* of Physlib revision, Mathlib revision and toolchain is reset to
  unchecked - and an absent revision on either side counts as a mismatch,
  because "cannot tell" is not "matches". No node arrives wearing a green tick
  it hasn't earned here; re-verifying is one click.

Attached *files* are referenced by absolute path, so a mission imported from
elsewhere will usually not find them. That is reported by name rather than
treated as a failure - the graph is unaffected, and links (which are just URLs)
always survive.

### The verification environment

A mission verifies **in place** — `lake env lean` resolves imports against
whatever this checkout currently has built. That makes the checked-out revision
part of what a result *means*, and it is the one way missions differ sharply
from tasks: a task run always branches off freshly-fetched `upstream/<default>`
(`create_task_branch`), so it is correct no matter what state the workspace is
parked in. A mission inherits that state completely.

Two things follow, both borrowed from Prove2Me's pinned environments ("a result
always carries the exact context needed to reproduce it", paper §3.1):

- **Verification is refused when the checkout isn't on the default branch.**
  Not warned — refused, in `verify_lean`. A statement that compiles against a
  months-old `auto-*` task branch says nothing about whether it compiles
  against Physlib, and a green tick that quietly meant *that* is worse than no
  tick at all. There is an explicit `allowNonDefaultBranch` override for when
  somebody genuinely means it.
- **Every check records the environment it ran in** — Physlib revision and
  branch, the Mathlib revision actually on disk, and the toolchain. When the
  workspace later moves (a sync, a task run, a manual checkout), those results
  were true of something else, and the mission says so and offers to re-verify
  rather than carrying on displaying them.

This is also why the task flow leaving the workspace parked on its `auto-*`
branch matters: harmless for tasks, quietly corrosive for missions.

### The rules

Checked statically in `src/missions/graph.ts` for an instant answer, and then
for real by the compiler in `commands/lean.rs`. The static pass exists to be
fast and precise about *why*, not to replace Lean.

*Graph rules* - exactly one goal node; unique, valid, lowercase Lean
identifiers; the dependency relation is acyclic; everything is reachable from
the goal.

Dependencies are read from three places, not one: a verified proof-sketch (the
strongest - a file the compiler accepted), a node's declared `dependsOn`, and
**the preamble's imports of this mission's own modules**. That third source is
easy to overlook and its absence is very visible: definitions are never named
in a `dependsOn` and never imported by a sketch, so without reading preambles
they have no edges at all - and dagre puts an edgeless node on rank 0, which
means every definition lands on the top row *beside the goal theorem*. On a
real 19-node mission that buried the goal among six definition cards. Import
edges are drawn as hairlines, distinct from proof edges, since "is built on
that vocabulary" is a weaker claim than "is proved from that".

A definition also counts as satisfied once it merely *compiles* - it carries no
proof obligation and so never reaches `proved`. Requiring that of it would hold
back every statement importing it and leave the frontier permanently empty.

*Lean rules* - a statement is one declaration whose name matches the node's,
terminating in `:= by sorry`; a preamble holds imports and `open`/`variable`
lines and nothing else; imports come only from the origins or this mission's
own modules; a definition contains no `sorry`.

*Proof rules* - a finished proof declares `theorem solution` with the target's
exact type, contains no `sorry`, and `#print axioms solution` reports nothing
beyond `propext`, `Classical.choice` and `Quot.sound`. Anything else is a new
axiom, which is the escape hatch this is here to close.

*Sketch rules* - a sketch may inherit `sorryAx` through the open lemmas it
imports (that is what makes it a decomposition), but must not write `sorry`
itself. `#print axioms` cannot tell those two apart, so the source-token check
carries that rule; `cargo test` covers this case and the others in `lean.rs`.

**Nothing an agent claims is taken on trust.** Every agent result is merged as
a *proposal* and then put through Lean by the app itself. An agent compiling
its own work is a good sign, not a verdict - a node only reads `proved` when
this app has compiled a sorry-free, axiom-clean proof of a statement it also
compiled.

## Architecture

```
src/                     React + TypeScript frontend
  theme/                 design tokens + light/dark theme (see Visual design)
  components/            shared UI: Button, Card, Spinner, LogPane, CodeBlock, Badge,
                         and WorkspaceStatus (the Physlib/Mathlib bar in the shell)
  onboarding/             the 3-step wizard (Claude login, GitHub login, env setup)
  settings/               everything behind the profile icon - API token, preferences
  tasks/                  task discovery, run flow, activity feed, diff review
  missions/               the mission workbench (see Missions above) - graph canvas,
                          theorem cards, DAG/Lean rules, sources, and the run
                          store that keeps concurrent agent runs alive across
                          screens
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
      missions.rs                 mission records on disk (JSON + attached files)
      lean.rs                     offline `lake env lean` verification of a graph
      mission_agent.rs             the generate / prove / extend agent runs,
                                   keyed by run id so they go in parallel
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
but whose `lake exe get_cache`/`lake build` step failed or got interrupted
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

### The profile menu

The header's profile icon opens a settings screen with three panes:

- **Accounts** - the same `SetupDashboard` onboarding uses, embedded without
  its own page header. Deliberately the same component rather than a second
  sign-in UI that could drift from the real one.
- **API token** - view, replace or remove the Claude credential every run uses.
  A pasted token is verified against the API *before* it is saved, since this
  config is the only copy (`claude setup-token` stores nothing itself) and a
  bad one would break every run with an error that looks unrelated. The stored
  token is only ever shown masked; there is nothing to recover from here, so
  the honest options are keep or replace.
- **Preferences** - the default model new missions start on, the open-PR
  courtesy limit, the theme, and where the workspace lives.

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

### The workspace status bar

The Physlib/Mathlib checkout is shown on every working screen, from the app
shell rather than from either page. It means the same thing to both halves of
the app - Tasks branches off that checkout, Missions typechecks every statement
against it - and a mission whose graph won't verify and a task run that won't
build very often have the same cause. Collapsed it is one line: the headline
state, the toolchain, and Mathlib's pinned revision. Expanded it shows the
location, branch and revision, whether the build actually produced oleans, how
far behind upstream it is, and per dependency whether it is present, compiled,
and at the revision the lakefile pins (parsed out of `lakefile.toml`; a
dependency that has drifted from its pin produces errors that otherwise look
like the project's own).

`Sync` opens a progress dialog: which of the three steps (upstream check,
cache fetch, build) is live, elapsed time, the live command output, and - the
part that matters - any note the backend has about *why* this run will be slow.
A sync can take five seconds or twenty minutes depending entirely on whether
the prebuilt caches could be used, and without that on screen a long build is
indistinguishable from a hang. The dialog is dismissable; the sync carries on
and the status bar keeps tracking it.

Two notes it will raise, both learned from a real 19-minute sync:

- **The checkout is not on the default branch.** Sync fast-forwards the working
  tree only when it is already on that branch; parked on a leftover `auto-*`
  task branch it updates the ref and leaves the tree alone, so it can be run
  forever without the code ever changing. It now says so instead of silently
  doing nothing useful.
- **The checkout predates the artifact cache.** Checked by looking for a
  `get_cache` target in its `lakefile.toml` before running it, so the answer is
  "there is nothing to download and all 554 files must compile from source"
  rather than an opaque command failure followed by a very long wait.

**Only one sync runs at a time**, enforced in `workspace.rs` rather than only
by disabling the button - button state dies on a reload, and the failure mode
is bad: two `lake build`s over one checkout compile the same modules and write
the same `.olean` paths, so they fight each other and both take longer. Seen in
practice: two builds three minutes apart, seven modules being compiled twice
simultaneously.

### Where the workspace lives

`installed_workspace_dir` picks the default. On Windows and Linux that is a
`Physlib` folder next to the installed app, falling back to the per-user
app-data directory when that isn't writable. **On macOS it is always the
app-data directory**, because "next to the executable" there means *inside*
`PhyslibAITools.app/Contents/MacOS`, and a macOS app update replaces the whole
bundle - silently taking the workspace with it. That is not a small loss: a
real one measured 11 GB, and re-creating it means a fresh clone plus a full
Mathlib fetch and build.

This only affects setups that have not chosen a location yet; an existing
`workspaceDir` in the config is always honoured.

**You do not need the app to have its own clone.** `ensure_cloned` returns
immediately when the directory is already a git checkout, so any Physlib
working copy has always been usable - what was missing was a way to say so.
Settings → Preferences → *Use a folder I already have…* picks one, inspects it,
and reports what it found before accepting it:

- Not a git checkout, or a lakefile that isn't Physlib's - refused.
- Not built, behind upstream, or missing an `upstream` remote - shown as
  caveats, not blocks. A checkout without `upstream` is perfectly good for
  missions and no good for task runs (which branch off `upstream/<default>`
  and open pull requests against it), and that is the user's call.

Pointing at a checkout that is already built skips setup entirely. Worth
knowing the other way round too: task runs create `auto-*` branches and commits
in whatever workspace is selected, and missions write scratch Lean under
`.p2m/`, so a checkout you actively work in yourself is a deliberate choice
rather than an obvious one.

### Fetching the caches

Setup and sync run **`lake exe get_cache`**, which is Physlib's own script
(`scripts/get_cache.lean`) and the command its install instructions give. It
fetches both halves: Mathlib's prebuilt oleans *and* Physlib's own artifacts
from the project's cache bucket. The obvious-looking `lake exe cache get` is
Mathlib's command and fetches only the first, leaving Physlib itself to compile
from source - which is the expensive half. `lakefile.toml` enables
`enableArtifactCache`/`restoreAllArtifacts` precisely so that second half can
be restored rather than rebuilt.

A failed fetch is **not fatal**, again following Physlib's own docs ("Do not
worry if it fails, you can still run `lake build`, it will just be much
slower"). It is reported as skipped and the build carries on, because a network
blip is a slow build, not a broken setup. The build itself is still treated as
a real failure, and still gets the auto-fix pass described below.

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

- **The mission workbench has not been exercised on a full end-to-end agent
  run.** Its verification path *has* been: writing a definition, two open
  statements and a proof-sketch that imports one of the open ones, then
  checking all four against a real built Physlib/Mathlib workspace with the
  exact commands and `LEAN_PATH` the app uses - the sketch compiled and
  reported the inherited `sorryAx`, as designed. What hasn't been observed is
  a real `generate`/`prove`/`extend` run producing a graph, so the prompts in
  `mission_agent.rs` should be treated as a first draft rather than tuned.
- **A stopped run only keeps what the agent had written to its result file.**
  The prompts ask for incremental saves, but that is an instruction, not an
  enforced protocol - an agent that ignores it and writes once at the end still
  loses everything when stopped. The Lean files it wrote into
  `.p2m/<missionId>/` survive on disk either way, but are not folded back into
  `mission.json`.
- **A mission's graph is verified serially, one file at a time.** Fine for the
  tens of nodes a fresh graph has; a mission that grows to Prove2Me's scale
  (hundreds of statements) would want the independent branches checked in
  parallel and unchanged nodes skipped on a re-verify.
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
  against a real failing `lake exe get_cache`/`lake build`** - reviewed and
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
