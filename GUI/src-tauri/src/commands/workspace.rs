//! Git operations on the user's Physlib checkout - fork/clone, branch
//! creation, and the small status queries the task-run flow needs. These are
//! plain `git`/`gh` subprocess calls (no bash), reused by both the
//! environment-setup step and each task run, matching what
//! `Scripts/physlib-auto-task.sh` does in its "fork & clone" step.

use crate::process;
use serde::Serialize;
use std::path::{Path, PathBuf};
use tauri::{AppHandle, Emitter};

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
#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct WorkspaceHealth {
    pub exists: bool,
    /// Whether Physlib has actually finished building, not just been cloned
    /// - see `is_built`. Without this, a `run_setup` that cloned fine but
    /// had `lake exe cache get`/`lake build` fail or get interrupted would
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

#[tauri::command]
pub async fn check_workspace_health(workspace_dir: String) -> WorkspaceHealth {
    let dir = PathBuf::from(&workspace_dir);
    if !dir.join(".git").is_dir() {
        return WorkspaceHealth { exists: false, built: false, behind_upstream: 0 };
    }
    let built = is_built(&dir);
    let default = default_branch().await;
    let behind_upstream = compute_behind_upstream(&dir, &default).await;
    WorkspaceHealth { exists: true, built, behind_upstream }
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
pub async fn sync_workspace(app: AppHandle, workspace_dir: String, claude_oauth_token: Option<String>) -> Result<(), String> {
    let dir = PathBuf::from(&workspace_dir);
    if !dir.join(".git").is_dir() {
        return Err("No workspace found to sync - run setup first.".into());
    }
    let default = default_branch().await;
    let behind_upstream = compute_behind_upstream(&dir, &default).await;

    if behind_upstream == 0 && is_built(&dir) {
        return Ok(());
    }

    let (_, current_branch, _) = process::run_captured("git", &["symbolic-ref", "--short", "HEAD"], Some(&dir))
        .await
        .unwrap_or((false, String::new(), String::new()));
    if current_branch.trim() == default {
        // `compute_behind_upstream` already fetched `upstream/<default>`.
        let _ = process::run_captured("git", &["merge", "--ff-only", &format!("upstream/{default}")], Some(&dir)).await;
    } else {
        // Not checked out, so we can update the branch ref directly without
        // touching the working tree.
        let refspec = format!("{default}:{default}");
        let _ = process::run_captured("git", &["fetch", "upstream", &refspec], Some(&dir)).await;
    }

    run_step_with_auto_fix(
        app.clone(),
        &dir,
        "sync:cache",
        "lake",
        &["exe", "cache", "get"],
        "Failed to refresh the Mathlib cache (`lake exe cache get`)",
        claude_oauth_token.as_deref(),
    )
    .await?;

    run_step_with_auto_fix(
        app,
        &dir,
        "sync:build",
        "lake",
        &["build"],
        "Failed to rebuild Physlib (`lake build`)",
        claude_oauth_token.as_deref(),
    )
    .await
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
         sync (refreshing the Mathlib cache / rebuilding so the next task starts from a warm cache), \
         not a task - the only goal is a clean, passing `lake build` again, nothing else.\n\n\
         Diagnose why `{command}` is failing and fix it. Common causes worth checking: the installed \
         Lean toolchain not matching this checkout's `lean-toolchain` file (fix via `elan`), a stale \
         or corrupted `.lake` build cache (try `lake clean` then `lake exe cache get` again), \
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

    let (mut child, stdout_task) = process::spawn_claude_streaming(app.clone(), &fix_event, &prompt, dir, claude_oauth_token)
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
        "workspace:clone",
        "gh",
        &["repo", "fork", UPSTREAM_REPO, "--clone", "--remote", "--", &dir_str],
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
