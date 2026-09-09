//! Orchestrates one task run: the politeness cap, branch creation, spawning
//! `claude -p` in headless JSON-streaming mode, and - once Claude finishes -
//! the diff preview and PR creation. This is the native equivalent of
//! `Scripts/physlib-auto-task.sh`'s steps 2/3/6/7.
//!
//! Claude's stream-json output is intentionally *not* strictly parsed here:
//! each line is forwarded to the frontend as a generic JSON value (or a
//! `{"type":"raw", "text": ...}` wrapper if a line doesn't parse), and the
//! frontend renders known shapes as activity-feed cards and falls back to
//! raw text for anything it doesn't recognize. See GUI/README.md - the exact
//! stream-json schema isn't fully documented, so staying defensive here
//! avoids a schema surprise crashing the run.

use super::workspace;
use crate::process;
use serde::{Deserialize, Serialize};
use std::path::PathBuf;
use std::sync::atomic::{AtomicU32, Ordering};
use tauri::{AppHandle, Emitter};

static TEMP_FILE_COUNTER: AtomicU32 = AtomicU32::new(0);

fn temp_file_path(prefix: &str) -> PathBuf {
    let n = TEMP_FILE_COUNTER.fetch_add(1, Ordering::SeqCst);
    std::env::temp_dir().join(format!("{prefix}-{}-{n}.txt", std::process::id()))
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RunTaskRequest {
    pub workspace_dir: String,
    pub task_name: String,
    /// The task's own prompt, already with any input-question answers
    /// prepended by the frontend (see src/tasks/parseTask.ts) - the
    /// standard PR-handoff footer is appended here, once, for every task.
    pub prompt: String,
    pub max_open_auto_prs: u32,
    /// Set if the user signed in through this app's own OAuth flow (see
    /// auth_claude.rs); unset if an existing Claude Code subscription login
    /// was detected instead, in which case `claude` picks its own
    /// credentials up automatically and needs nothing from us here.
    pub claude_oauth_token: Option<String>,
}

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct RunTaskStarted {
    pub branch: String,
}

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct RunTaskFinished {
    pub could_finish: bool,
    pub branch: String,
    pub diff: Option<workspace::StagedDiff>,
    pub pr_title: Option<String>,
    pub pr_body: Option<String>,
    pub error: Option<String>,
}

/// Refuses to start if too many `auto-`-prefixed PRs are already open
/// upstream, so a fleet of GUI users can't flood the maintainers - the same
/// politeness cap `physlib-auto-task.sh` enforces.
async fn check_open_pr_cap(max_open_auto_prs: u32) -> Result<(), String> {
    let (ok, stdout, _) = process::run_captured(
        "gh",
        &["pr", "list", "--repo", workspace::UPSTREAM_REPO, "--state", "open", "--limit", "1000", "--json", "title"],
        None,
    )
    .await
    .map_err(|e| e.to_string())?;
    if !ok {
        return Ok(()); // best-effort - don't block a run just because the query failed
    }
    let Ok(list) = serde_json::from_str::<Vec<serde_json::Value>>(&stdout) else { return Ok(()) };
    let open_auto = list
        .iter()
        .filter(|v| v.get("title").and_then(|t| t.as_str()).map(|s| s.starts_with("auto-")).unwrap_or(false))
        .count() as u32;
    if open_auto > max_open_auto_prs {
        return Err(format!(
            "There are already {open_auto} open automated PRs on {} (limit {max_open_auto_prs}). \
             Try again once some have been merged or closed.",
            workspace::UPSTREAM_REPO
        ));
    }
    Ok(())
}

#[tauri::command]
pub async fn start_task_run(app: AppHandle, req: RunTaskRequest) -> Result<RunTaskStarted, String> {
    check_open_pr_cap(req.max_open_auto_prs).await?;

    let dir = PathBuf::from(&req.workspace_dir);
    workspace::ensure_cloned(app.clone(), &dir).await?;
    let task_lc = req.task_name.to_lowercase();
    let branch = workspace::create_task_branch(&dir, &task_lc).await?;

    let pr_title_file = temp_file_path("physlib-gui-pr-title");
    let pr_body_file = temp_file_path("physlib-gui-pr-body");
    std::fs::write(&pr_title_file, "").map_err(|e| e.to_string())?;
    std::fs::write(&pr_body_file, "").map_err(|e| e.to_string())?;

    let full_prompt = format!(
        "{prompt}\n\n\
         {one_shot_note}\n\n\
         Finally, once the task is complete and the project still builds, write the \
         pull-request text so the app can open the PR for me:\n\
         \x20 - A PR title in EXACTLY this format: auto-task(<subject>): <description>\n\
         \x20   where <subject> is the main declaration or area you changed and \
         <description> is a concise summary. Write it to: {title_path}\n\
         \x20 - A clear PR description (what you changed and why, in Markdown) -> write it to: {body_path}\n\
         Write nothing else to those two files. If you could NOT complete the task while \
         keeping the build green, leave both files empty so the app knows not to open a PR.",
        prompt = req.prompt,
        one_shot_note = process::ONE_SHOT_SESSION_NOTE,
        title_path = pr_title_file.display(),
        body_path = pr_body_file.display(),
    );

    spawn_claude_run(app, dir, branch.clone(), full_prompt, pr_title_file, pr_body_file, req.claude_oauth_token);
    Ok(RunTaskStarted { branch })
}

fn spawn_claude_run(
    app: AppHandle,
    dir: PathBuf,
    branch: String,
    prompt: String,
    pr_title_file: PathBuf,
    pr_body_file: PathBuf,
    claude_oauth_token: Option<String>,
) {
    tokio::spawn(async move {
        let (mut child, stdout_task) =
            match process::spawn_claude_streaming(app.clone(), "task-run", &prompt, &dir, claude_oauth_token.as_deref(), None) {
                Ok(v) => v,
                Err(e) => {
                    let _ = app.emit(
                        "task-run:finished",
                        RunTaskFinished {
                            could_finish: false,
                            branch,
                            diff: None,
                            pr_title: None,
                            pr_body: None,
                            error: Some(format!("Couldn't start Claude: {e}")),
                        },
                    );
                    return;
                }
            };

        let _ = child.wait().await;
        let _ = stdout_task.await;

        let title = std::fs::read_to_string(&pr_title_file).unwrap_or_default();
        let body = std::fs::read_to_string(&pr_body_file).unwrap_or_default();
        let _ = std::fs::remove_file(&pr_title_file);
        let _ = std::fs::remove_file(&pr_body_file);

        if title.trim().is_empty() || body.trim().is_empty() {
            let _ = app.emit(
                "task-run:finished",
                RunTaskFinished { could_finish: false, branch, diff: None, pr_title: None, pr_body: None, error: None },
            );
            return;
        }

        let diff = workspace::staged_diff(&dir).await.ok();
        let _ = app.emit(
            "task-run:finished",
            RunTaskFinished {
                could_finish: true,
                branch,
                diff,
                pr_title: Some(title.lines().next().unwrap_or("").trim().to_string()),
                pr_body: Some(body),
                error: None,
            },
        );
    });
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ConfirmPrRequest {
    pub workspace_dir: String,
    pub branch: String,
    pub title: String,
    /// The PR body, with any challenge-question verdicts already appended
    /// by the frontend (mirroring the script's "## Human review" section).
    pub body: String,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PrResult {
    pub url: String,
}

#[tauri::command]
pub async fn confirm_and_open_pr(app: AppHandle, req: ConfirmPrRequest) -> Result<PrResult, String> {
    let dir = PathBuf::from(&req.workspace_dir);

    let (ok, _, stderr) = process::run_captured(
        "git",
        &["commit", "-m", &req.title, "-m", "Co-authored-by: Claude <noreply@anthropic.com>"],
        Some(&dir),
    )
    .await
    .map_err(|e| e.to_string())?;
    if !ok {
        return Err(format!("git commit failed: {}", stderr.trim()));
    }

    let push_status = process::run_streamed_to_completion(app.clone(), "task-run:push", "git", &["push", "-u", "origin", &req.branch], Some(&dir))
        .await
        .map_err(|e| e.to_string())?;
    if !push_status.success() {
        return Err("Failed to push the branch (see the log above).".into());
    }

    let (ok, me, _) = process::run_captured("gh", &["api", "user", "--jq", ".login"], None)
        .await
        .map_err(|e| e.to_string())?;
    if !ok {
        return Err("Couldn't determine your GitHub username.".into());
    }
    let me = me.trim();

    let body_file = temp_file_path("physlib-gui-pr-body-final");
    std::fs::write(&body_file, &req.body).map_err(|e| e.to_string())?;
    let default_branch = workspace::default_branch().await;
    let head = format!("{me}:{}", req.branch);
    let body_file_str = body_file.to_string_lossy().into_owned();

    let (ok, stdout, stderr) = process::run_captured(
        "gh",
        &[
            "pr", "create", "--repo", workspace::UPSTREAM_REPO, "--base", &default_branch, "--head", &head, "--title", &req.title,
            "--body-file", &body_file_str,
        ],
        Some(&dir),
    )
    .await
    .map_err(|e| e.to_string())?;
    let _ = std::fs::remove_file(&body_file);

    if !ok {
        return Err(format!(
            "Failed to open the pull request: {}\nYour branch is pushed; you can open it manually at \
             https://github.com/{}/pulls",
            stderr.trim(),
            workspace::UPSTREAM_REPO
        ));
    }
    Ok(PrResult { url: stdout.trim().to_string() })
}
