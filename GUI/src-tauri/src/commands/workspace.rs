//! Git operations on the user's Physlib checkout - fork/clone, branch
//! creation, and the small status queries the task-run flow needs. These are
//! plain `git`/`gh` subprocess calls (no bash), reused by both the
//! environment-setup step and each task run, matching what
//! `Scripts/physlib-auto-task.sh` does in its "fork & clone" step.

use crate::process;
use serde::Serialize;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use tauri::{AppHandle, Emitter, State};

/// Whether a workspace sync is currently running. A second `lake build` over
/// the same checkout does not just waste CPU - both processes compile the same
/// modules and write the same `.olean` paths, so they actively fight each
/// other and the whole thing takes far longer than one build would. Observed
/// in the wild: two builds three minutes apart, seven modules being compiled
/// twice at once.
///
/// The frontend also disables its own button while syncing, but that state
/// dies on a reload, so the authoritative guard has to live here.
#[derive(Default)]
pub struct SyncState(pub AtomicBool);

/// Clears the running flag however `sync_workspace` returns - early error,
/// success, or a panic unwinding through it.
struct SyncGuard<'a>(&'a AtomicBool);

impl Drop for SyncGuard<'_> {
    fn drop(&mut self) {
        self.0.store(false, Ordering::SeqCst);
    }
}

/// What the sync is doing right now, for the progress dialog. Emitted as
/// `sync:phase`; the raw command output still arrives on `sync:cache:line` /
/// `sync:build:line` as before.
#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct SyncPhase {
    /// `"git"` | `"cache"` | `"build"` | `"fixing"` | `"done"`.
    pub phase: &'static str,
    /// One line of human explanation, shown under the phase.
    pub detail: Option<String>,
    /// True when `detail` is a warning the user should actually read - e.g.
    /// the cache could not be fetched, so the build is about to be slow.
    pub warning: bool,
}

fn emit_phase(app: &AppHandle, phase: &'static str, detail: Option<String>, warning: bool) {
    let _ = app.emit("sync:phase", SyncPhase { phase, detail, warning });
}

pub const UPSTREAM_REPO: &str = "leanprover-community/physlib";

/// How long the auto-fix diagnostic session (see `run_step_with_auto_fix`)
/// is allowed to run before it's cancelled. Generous - it may legitimately
/// need to run a full `lake build` itself to verify a fix, and this repo's
/// own docs already note cold builds can take 10+ minutes - but bounded, so
/// a hung `claude -p` session (a real, previously-observed failure mode,
/// see auth_claude.rs) can't wedge the sync forever.
const DIAGNOSTIC_FIX_TIMEOUT: std::time::Duration = std::time::Duration::from_secs(15 * 60);

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct WorkspaceStatus {
    pub exists: bool,
    pub path: String,
}

#[tauri::command]
pub fn workspace_status(workspace_dir: String) -> WorkspaceStatus {
    let path = PathBuf::from(&workspace_dir);
    WorkspaceStatus { exists: path.join(".git").is_dir(), path: workspace_dir }
}

/// Reported on every app launch (not just the first time) so a deleted
/// workspace or a Physlib that's drifted behind upstream gets surfaced
/// instead of silently trusted from a stale "setup done" flag.
/// One lake dependency's state. Only Mathlib is reported today, but the shape
/// is generic because Physlib pulls several and the same questions apply to
/// each: is it there, is it compiled, and is it the revision the lakefile asks
/// for.
#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct DependencyHealth {
    pub name: String,
    pub present: bool,
    /// Its root `.olean` exists, i.e. it has actually been compiled.
    pub built: bool,
    /// Short sha of the checked-out revision.
    pub rev: Option<String>,
    /// The `rev` the lakefile pins. Shown next to `rev` so a dependency that
    /// has drifted from what the project expects is visible rather than
    /// silently producing confusing build errors.
    pub required_rev: Option<String>,
}

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct WorkspaceHealth {
    pub exists: bool,
    /// Whether Physlib has actually finished building, not just been cloned
    /// - see `is_built`. Without this, a `run_setup` that cloned fine but
    /// had `lake exe get_cache`/`lake build` fail or get interrupted would
    /// still report `exists: true` on the next launch (only `.git` was
    /// checked), letting the app skip straight past onboarding into a task
    /// list backed by a Physlib that doesn't actually build.
    pub built: bool,
    /// How many commits upstream's default branch is ahead of the local
    /// copy of it. Not a correctness gate - every task run already fetches
    /// and branches off `upstream/<default>` fresh regardless - but a
    /// workspace that's badly behind means a colder cache and a slower
    /// build the next time a task runs, so it's worth surfacing.
    pub behind_upstream: u32,
    /// Where the checkout is, so the status bar can show it without the
    /// caller having to thread the config through.
    pub path: String,
    /// Checked-out branch and short sha of the Physlib working copy.
    pub branch: Option<String>,
    pub rev: Option<String>,
    /// Contents of `lean-toolchain`, e.g. `leanprover/lean4:v4.33.0`.
    pub toolchain: Option<String>,
    /// The lakefile declares `name = "Physlib"`. False for a directory that is
    /// a git checkout of something else entirely - the one check worth making
    /// when the user picks a folder by hand.
    pub is_physlib: bool,
    /// An `upstream` remote exists. The task flow branches off
    /// `upstream/<default>` and opens pull requests against it, so a checkout
    /// without one can still run missions but not tasks.
    pub has_upstream_remote: bool,
    /// Lake dependencies worth reporting - Mathlib, in practice.
    pub dependencies: Vec<DependencyHealth>,
}

/// Cheap, no-rebuild-required proxy for "did the last `lake build` actually
/// finish successfully": Lean only writes a module's `.olean` after that
/// module (and everything it transitively imports) compiles without error,
/// so the root `.olean` for each of `lakefile.toml`'s `defaultTargets`
/// existing is good evidence the whole default build succeeded at some
/// point. Hardcoded to Physlib's current two default targets (`Physlib`,
/// `QuantumInfo` - see `lakefile.toml`; `PhyslibAlpha` is a lean_lib but not
/// a default target) rather than parsed generically, matching how this GUI
/// already hardcodes other Physlib-specific assumptions (e.g.
/// `UPSTREAM_REPO`) - revisit if the lakefile's `defaultTargets` ever change.
fn is_built(dir: &Path) -> bool {
    ["Physlib", "QuantumInfo"]
        .iter()
        .all(|lib| dir.join(".lake").join("build").join("lib").join("lean").join(format!("{lib}.olean")).is_file())
}

/// Fetches `upstream/<default>` and counts how far ahead of the local copy
/// it is. Shared by `check_workspace_health` (just reporting it) and
/// `sync_workspace` (deciding whether there's anything to do at all).
async fn compute_behind_upstream(dir: &Path, default: &str) -> u32 {
    let _ = process::run_captured("git", &["fetch", "upstream", default], Some(dir)).await;
    process::run_captured("git", &["rev-list", "--count", &format!("{default}..upstream/{default}")], Some(dir))
        .await
        .ok()
        .and_then(|(ok, out, _)| if ok { out.trim().parse::<u32>().ok() } else { None })
        .unwrap_or(0)
}

/// Reads the `rev` a lakefile pins for one `[[require]]` entry. Deliberately a
/// small hand-rolled scan rather than a TOML dependency: the file is tiny, the
/// shape is fixed, and a parse failure here should degrade to "unknown"
/// rather than fail the whole health check.
///
/// `name` is matched against the *unquoted* package name - Lake writes some
/// names with guillemets (`name = "«doc-gen4»"`) but checks the package out
/// into a plain `.lake/packages/doc-gen4`, and callers pass the directory
/// name, so the guillemets are stripped before comparing.
fn required_rev(lakefile: &str, name: &str) -> Option<String> {
    let mut in_block = false;
    for line in lakefile.lines() {
        let trimmed = line.trim();
        if trimmed == "[[require]]" {
            in_block = false;
            continue;
        }
        if trimmed.starts_with('[') && trimmed != "[[require]]" {
            in_block = false;
        }
        if let Some(value) = trimmed.strip_prefix("name = ") {
            in_block = value.trim().trim_matches(['"', '«', '»']) == name;
        }
        if in_block {
            if let Some(value) = trimmed.strip_prefix("rev = ") {
                return Some(value.trim().trim_matches('"').to_string());
            }
        }
    }
    None
}

async fn dependency_health(dir: &Path, name: &str, root_module: &str, lakefile: &str) -> DependencyHealth {
    let pkg = dir.join(".lake").join("packages").join(name);
    let present = pkg.is_dir();
    let built = pkg.join(".lake").join("build").join("lib").join("lean").join(format!("{root_module}.olean")).is_file();
    let rev = if present {
        process::run_captured("git", &["rev-parse", "--short", "HEAD"], Some(&pkg))
            .await
            .ok()
            .filter(|(ok, _, _)| *ok)
            .map(|(_, out, _)| out.trim().to_string())
    } else {
        None
    };
    DependencyHealth { name: name.to_string(), present, built, rev, required_rev: required_rev(lakefile, name) }
}

#[tauri::command]
pub async fn check_workspace_health(workspace_dir: String) -> WorkspaceHealth {
    let dir = PathBuf::from(&workspace_dir);
    if !dir.join(".git").is_dir() {
        return WorkspaceHealth {
            exists: false,
            built: false,
            behind_upstream: 0,
            path: workspace_dir,
            branch: None,
            rev: None,
            toolchain: None,
            is_physlib: false,
            has_upstream_remote: false,
            dependencies: Vec::new(),
        };
    }
    let built = is_built(&dir);
    let default = default_branch().await;
    let behind_upstream = compute_behind_upstream(&dir, &default).await;

    let branch = process::run_captured("git", &["symbolic-ref", "--short", "HEAD"], Some(&dir))
        .await
        .ok()
        .filter(|(ok, _, _)| *ok)
        .map(|(_, out, _)| out.trim().to_string());
    let rev = process::run_captured("git", &["rev-parse", "--short", "HEAD"], Some(&dir))
        .await
        .ok()
        .filter(|(ok, _, _)| *ok)
        .map(|(_, out, _)| out.trim().to_string());
    let toolchain = std::fs::read_to_string(dir.join("lean-toolchain")).ok().map(|t| t.trim().to_string());
    let lakefile = std::fs::read_to_string(dir.join("lakefile.toml")).unwrap_or_default();
    let dependencies = vec![dependency_health(&dir, "mathlib", "Mathlib", &lakefile).await];
    let is_physlib = lakefile.lines().any(|l| l.trim() == r#"name = "Physlib""#);
    let has_upstream_remote = process::run_captured("git", &["remote", "get-url", "upstream"], Some(&dir))
        .await
        .map(|(ok, _, _)| ok)
        .unwrap_or(false);

    WorkspaceHealth {
        exists: true,
        built,
        behind_upstream,
        path: workspace_dir,
        branch,
        rev,
        toolchain,
        is_physlib,
        has_upstream_remote,
        dependencies,
    }
}

/// Fast-forwards the local default branch to match upstream (best-effort -
/// this is a speed optimization, not required for correctness, so a failure
/// here doesn't abort the sync) and re-warms the build: fetching the Mathlib
/// cache and rebuilding, so the next task run starts from a hot cache
/// instead of a cold one. If either step fails, tries once to have Claude
/// diagnose and fix it (see `run_step_with_auto_fix`) before giving up.
///
/// Does nothing beyond the initial fetch-and-check if the workspace is
/// already up to date and built - no point re-downloading the Mathlib cache
/// or re-running `lake build` (which still isn't free even when there's
/// nothing to actually recompile) when nothing has changed.
#[tauri::command]
pub async fn sync_workspace(
    app: AppHandle,
    state: State<'_, SyncState>,
    workspace_dir: String,
    claude_oauth_token: Option<String>,
) -> Result<(), String> {
    if state.0.swap(true, Ordering::SeqCst) {
        return Err("A sync is already running. Wait for it to finish - starting a second one makes both slower, \
                    because two `lake build`s compile the same files at the same time."
            .into());
    }
    let _guard = SyncGuard(&state.0);

    let dir = PathBuf::from(&workspace_dir);
    if !dir.join(".git").is_dir() {
        return Err("No workspace found to sync - run setup first.".into());
    }

    emit_phase(&app, "git", Some("Checking for upstream changes…".into()), false);
    let default = default_branch().await;
    let behind_upstream = compute_behind_upstream(&dir, &default).await;

    if behind_upstream == 0 && is_built(&dir) {
        emit_phase(&app, "done", Some("Already up to date and built - nothing to do.".into()), false);
        return Ok(());
    }

    let (_, current_branch, _) = process::run_captured("git", &["symbolic-ref", "--short", "HEAD"], Some(&dir))
        .await
        .unwrap_or((false, String::new(), String::new()));
    let current_branch = current_branch.trim().to_string();
    if current_branch == default {
        // `compute_behind_upstream` already fetched `upstream/<default>`.
        let _ = process::run_captured("git", &["merge", "--ff-only", &format!("upstream/{default}")], Some(&dir)).await;
    } else {
        // Not checked out, so we can update the branch ref directly without
        // touching the working tree. Worth saying out loud: the *working tree*
        // stays where it is, so a checkout parked on an old task branch will
        // keep building that old code no matter how often this is run. Silently
        // doing nothing useful is the worst outcome here.
        let refspec = format!("{default}:{default}");
        let _ = process::run_captured("git", &["fetch", "upstream", &refspec], Some(&dir)).await;
        if behind_upstream > 0 {
            emit_phase(
                &app,
                "git",
                Some(format!(
                    "This checkout is on branch `{current_branch}`, not `{default}`, and is {behind_upstream} \
                     commits behind. Syncing updates `{default}` but leaves your working tree alone, so the build \
                     below is of the older code. Switch to `{default}` to pick up upstream's changes."
                )),
                true,
            );
        }
    }

    // Physlib's own `get_cache` (scripts/get_cache.lean) fetches both halves:
    // Mathlib's prebuilt oleans *and* Physlib's own artifacts from the
    // project's cache bucket. `lake exe cache get` only ever gets the first,
    // leaving Physlib itself to compile from source - which is the slow part.
    //
    // Deliberately not run through `run_step_with_auto_fix`: Physlib's own
    // install docs say a failed cache fetch is not a problem ("you can still
    // run `lake build`, it will just be much slower"), so a network blip here
    // is not worth spending a Claude session on. The build below still gets
    // the auto-fix treatment, because a failure there is a real one.
    // A checkout from before `get_cache` was added has no such target, and
    // `lake exe get_cache` there fails with an unhelpful error. Checking the
    // lakefile first turns that into a straight answer about why the build is
    // about to take a long time, instead of a silent fall-through to a full
    // from-source compile.
    let lakefile = std::fs::read_to_string(dir.join("lakefile.toml")).unwrap_or_default();
    if lakefile.contains(r#"name = "get_cache""#) {
        emit_phase(&app, "cache", Some("Fetching the Physlib and Mathlib caches…".into()), false);
        let cached =
            process::run_streamed_to_completion(app.clone(), "sync:cache", "lake", &["exe", "get_cache"], Some(&dir))
                .await
                .map(|s| s.success())
                .unwrap_or(false);
        if !cached {
            emit_phase(
                &app,
                "cache",
                Some(
                    "Couldn't fetch the caches. The build below still works, but has to compile from source, \
                     which takes a lot longer."
                        .into(),
                ),
                true,
            );
        }
    } else {
        emit_phase(
            &app,
            "cache",
            Some(
                "This checkout predates Physlib's prebuilt-artifact cache (no `get_cache` target in its \
                 lakefile), so there is nothing to download and every file has to be compiled from source. \
                 Updating the checkout to current Physlib is what makes this fast."
                    .into(),
            ),
            true,
        );
    }

    emit_phase(&app, "build", Some("Building — only files that changed, plus anything importing them.".into()), false);
    let result = run_step_with_auto_fix(
        app.clone(),
        &dir,
        "sync:build",
        "lake",
        &["build"],
        "Failed to rebuild Physlib (`lake build`)",
        claude_oauth_token.as_deref(),
    )
    .await;

    emit_phase(
        &app,
        "done",
        Some(match &result {
            Ok(()) => "Build finished.".to_string(),
            Err(e) => e.clone(),
        }),
        result.is_err(),
    );
    result
}

/// Runs `program args` under `event`, streamed as usual. If it fails, this
/// is a routine environment sync, not a task, so instead of just surfacing
/// the failure it spawns a headless Claude session (`{event}:fix` - a
/// `spawn_claude_streaming` stream, renderable with the same activity feed
/// as a task run) to diagnose and fix *environment/tooling* problems - wrong
/// Lean toolchain, corrupted `.lake` cache, disk/network issues - then
/// retries the same command once. Deliberately does not retry more than
/// once or loop: if it's still broken after one fix attempt, that's worth
/// surfacing to the user rather than silently retrying forever.
///
/// This intentionally does not try to fix real compile errors in Physlib's
/// own source: every task branch is created fresh from `upstream/<default>`
/// (see `create_task_branch`), never from whatever this sync workspace's
/// working tree happens to contain, so patching source here wouldn't help
/// any future task anyway - the prompt tells Claude as much and asks it to
/// just report that case clearly instead of guessing at a source fix.
async fn run_step_with_auto_fix(
    app: AppHandle,
    dir: &Path,
    event: &str,
    program: &str,
    args: &[&str],
    failure_summary: &str,
    claude_oauth_token: Option<&str>,
) -> Result<(), String> {
    let status = process::run_streamed_to_completion(app.clone(), event, program, args, Some(dir))
        .await
        .map_err(|e| e.to_string())?;
    if status.success() {
        return Ok(());
    }

    let fix_event = format!("{event}:fix");
    let _ = app.emit(&format!("{fix_event}:start"), ());

    let prompt = format!(
        "Running `{command}` in this Physlib checkout just failed. This is a routine environment \
         sync (refreshing the Physlib/Mathlib cache and rebuilding so the next task starts warm), \
         not a task - the only goal is a clean, passing `lake build` again, nothing else.\n\n\
         Diagnose why `{command}` is failing and fix it. Common causes worth checking: the installed \
         Lean toolchain not matching this checkout's `lean-toolchain` file (fix via `elan`), a stale \
         or corrupted `.lake` build cache (try `lake clean` then `lake exe get_cache` again), \
         insufficient disk space, or a transient network failure (just retry the command).\n\n\
         Do NOT edit any Physlib source (`.lean`) files to work around a real compile error in the \
         checked-out code itself - every task run branches fresh from upstream regardless of this \
         checkout's state, so a source-level workaround here wouldn't help anyway. If the upstream \
         code genuinely doesn't build, stop and say so clearly instead of guessing at a fix.\n\n\
         When you believe it's fixed, verify by running `{command}` yourself before finishing.\n\n\
         {one_shot_note}",
        command = format!("{program} {}", args.join(" ")),
        one_shot_note = process::ONE_SHOT_SESSION_NOTE,
    );

    let (mut child, stdout_task) = process::spawn_claude_streaming(app.clone(), &fix_event, &prompt, dir, claude_oauth_token, None)
        .map_err(|e| format!("{failure_summary}, and couldn't start Claude to fix it: {e}"))?;
    // `claude -p` sessions have been observed elsewhere in this app to hang
    // (see auth_claude.rs's history). Without a bound here, that would wedge
    // this whole command forever - the frontend's `await syncWorkspace(...)`
    // never resolves, so its "syncing"/"fixing" UI state never clears either.
    if tokio::time::timeout(DIAGNOSTIC_FIX_TIMEOUT, child.wait()).await.is_err() {
        let _ = child.kill().await;
        let _ = stdout_task.await;
        return Err(format!(
            "{failure_summary} - the automatic fix attempt didn't finish within {} minutes and was cancelled. See the log above.",
            DIAGNOSTIC_FIX_TIMEOUT.as_secs() / 60
        ));
    }
    let _ = stdout_task.await;

    let retry_status = process::run_streamed_to_completion(app, event, program, args, Some(dir))
        .await
        .map_err(|e| e.to_string())?;
    if retry_status.success() {
        Ok(())
    } else {
        Err(format!("{failure_summary} - still failing after an automatic fix attempt. See the log above."))
    }
}

/// Forks + clones `leanprover-community/physlib` into `workspace_dir` if it
/// isn't already a checkout there (reusing an existing one, exactly like the
/// script does), streaming progress under the `workspace:clone` event.
pub async fn ensure_cloned(app: AppHandle, workspace_dir: &Path) -> Result<(), String> {
    if workspace_dir.join(".git").is_dir() {
        return Ok(());
    }
    if let Some(parent) = workspace_dir.parent() {
        std::fs::create_dir_all(parent).map_err(|e| e.to_string())?;
    }
    let dir_str = workspace_dir.to_string_lossy().into_owned();
    let status = process::run_streamed_to_completion(
        app,
        // Must be "setup:clone" (not "workspace:clone") so the onboarding
        // EnvSetupStep, which subscribes to `setup:<id>:line`, actually shows
        // this step's git/gh output - every other setup step already uses the
        // `setup:*` prefix. With the old name the clone step streamed to an
        // event nobody listened to, so a failure (e.g. "no space left on
        // device") surfaced only as the generic error below, with no log.
        "setup:clone",
        "gh",
        // No `--remote`: gh rejects it when a repository argument is given
        // ("the --remote flag is unsupported when a repository argument is
        // provided"), and it's redundant here anyway - `--clone` already adds
        // an `upstream` remote pointing at the source repo. This matches the
        // bash harness exactly (`gh repo fork <repo> --clone -- <dir>`).
        &["repo", "fork", UPSTREAM_REPO, "--clone", "--", &dir_str],
        None,
    )
    .await
    .map_err(|e| e.to_string())?;
    if !status.success() {
        return Err("Failed to fork/clone Physlib (see the log above).".into());
    }
    Ok(())
}

/// The upstream default branch name (usually `master`), falling back to
/// `master` if the query fails - same fallback the script uses.
pub async fn default_branch() -> String {
    match process::run_captured(
        "gh",
        &["repo", "view", UPSTREAM_REPO, "--json", "defaultBranchRef", "--jq", ".defaultBranchRef.name"],
        None,
    )
    .await
    {
        Ok((true, stdout, _)) if !stdout.trim().is_empty() => stdout.trim().to_string(),
        _ => "master".to_string(),
    }
}

/// Creates and checks out a fresh work branch off `upstream/<default>`,
/// named like the script's own `auto-<task>-<timestamp>`.
pub async fn create_task_branch(workspace_dir: &Path, task_lc: &str) -> Result<String, String> {
    let branch = format!("auto-{task_lc}-{}", chrono::Local::now().format("%Y%m%d-%H%M%S"));
    let default = default_branch().await;

    // Fetch upstream/<default> if we have an "upstream" remote (added by `gh
    // repo fork --clone`); otherwise base off the local default branch.
    let (fetch_ok, _, _) =
        process::run_captured("git", &["fetch", "upstream", &default], Some(workspace_dir))
            .await
            .unwrap_or((false, String::new(), String::new()));
    let base = if fetch_ok { format!("upstream/{default}") } else { default.clone() };

    let (ok, _, stderr) =
        process::run_captured("git", &["checkout", "-b", &branch, &base], Some(workspace_dir))
            .await
            .map_err(|e| e.to_string())?;
    if !ok {
        return Err(format!("Failed to create branch {branch}: {stderr}"));
    }
    Ok(branch)
}

/// Staged diff stat + full diff text, used for the pre-PR review screen.
#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct StagedDiff {
    pub stat: String,
    pub full: String,
    pub has_changes: bool,
}

pub async fn staged_diff(workspace_dir: &Path) -> Result<StagedDiff, String> {
    process::run_captured("git", &["add", "-A"], Some(workspace_dir))
        .await
        .map_err(|e| e.to_string())?;
    let (_, stat, _) = process::run_captured("git", &["diff", "--cached", "--stat"], Some(workspace_dir))
        .await
        .map_err(|e| e.to_string())?;
    let (_, full, _) = process::run_captured("git", &["diff", "--cached"], Some(workspace_dir))
        .await
        .map_err(|e| e.to_string())?;
    Ok(StagedDiff { has_changes: !stat.trim().is_empty(), stat, full })
}

#[cfg(test)]
mod tests {
    use super::required_rev;

    /// Verbatim shape of Physlib's own lakefile.toml, including the top-level
    /// `name` that a naive scan would mistake for a dependency's, and the
    /// guillemet-quoted package name above the one we want.
    const LAKEFILE: &str = r#"
name = "Physlib"
defaultTargets = ["Physlib", "QuantumInfo"]

[[require]]
name = "«doc-gen4»"
git = "https://github.com/leanprover/doc-gen4"
rev = "v4.33.0"

[[require]]
name = "mathlib"
git = "https://github.com/leanprover-community/mathlib4.git"
rev = "v4.34.0"

[[lean_lib]]
name = "Physlib"
"#;

    #[test]
    fn finds_the_pinned_revision_of_a_dependency() {
        assert_eq!(required_rev(LAKEFILE, "mathlib").as_deref(), Some("v4.34.0"));
        // Guillemet-quoted in the lakefile, plain on disk - callers pass the
        // directory name, which is what this has to match.
        assert_eq!(required_rev(LAKEFILE, "doc-gen4").as_deref(), Some("v4.33.0"));
    }

    #[test]
    fn ignores_names_that_are_not_dependencies() {
        // The top-level project name and the lean_lib block share the project's
        // own name; neither is a `[[require]]`, so neither has a rev.
        assert_eq!(required_rev(LAKEFILE, "Physlib"), None);
        assert_eq!(required_rev(LAKEFILE, "nonexistent"), None);
        assert_eq!(required_rev("", "mathlib"), None);
    }
}
