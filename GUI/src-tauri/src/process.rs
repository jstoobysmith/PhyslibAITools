//! Shared helper for spawning a native subprocess and streaming its
//! stdout/stderr to the frontend as Tauri events, line by line. Used by every
//! long-running step (installs, build, login flows, task runs) so they all
//! behave consistently.
//!
//! Every process is spawned directly (no shell in between) with PATH
//! augmented via `paths::augmented_path_env` so tools installed earlier this
//! session are found reliably.

use crate::paths;
use serde::Serialize;
use std::path::Path;
use std::process::Stdio;
use tauri::{AppHandle, Emitter};
use tokio::io::{AsyncBufReadExt, BufReader};
use tokio::process::{Child, ChildStdin, Command};

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ProcessLine {
    pub stream: &'static str, // "stdout" | "stderr"
    pub text: String,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ProcessDone {
    pub code: Option<i32>,
    pub success: bool,
}

/// Builds a `Command` with PATH augmented and (on Windows) no console window
/// popping up - the same preparation `spawn_streamed` does, exposed for
/// callers that need custom stdio handling (e.g. inspecting stdout lines for
/// a login URL as they arrive, rather than just forwarding them).
pub fn command(program: &str, args: &[&str], cwd: Option<&Path>) -> Command {
    base_command(program, args, cwd)
}

fn base_command(program: &str, args: &[&str], cwd: Option<&Path>) -> Command {
    let mut cmd = Command::new(program);
    cmd.args(args);
    cmd.env("PATH", paths::augmented_path_env());
    if let Some(dir) = cwd {
        cmd.current_dir(dir);
    }
    #[cfg(windows)]
    {
        const CREATE_NO_WINDOW: u32 = 0x0800_0000;
        cmd.creation_flags(CREATE_NO_WINDOW);
    }
    cmd
}

/// Spawns `program`, forwarding every stdout/stderr line as a `{event}:line`
/// Tauri event and emitting one `{event}:done` when it exits. `stdin` chooses
/// whether the child's stdin is left open for the caller to write to
/// (interactive flows like `gh auth login --web`) or closed immediately
/// (everything else - the child sees EOF right away, same as `Stdio::null()`
/// would give it, but still piped so we can hand back a `ChildStdin` when the
/// caller does need it).
pub fn spawn_streamed(
    app: AppHandle,
    event: impl Into<String>,
    program: &str,
    args: &[&str],
    cwd: Option<&Path>,
    keep_stdin_open: bool,
) -> std::io::Result<(Child, Option<ChildStdin>)> {
    let event = event.into();
    let mut cmd = base_command(program, args, cwd);
    cmd.stdin(Stdio::piped()).stdout(Stdio::piped()).stderr(Stdio::piped());

    let mut child = cmd.spawn()?;
    let mut stdin = child.stdin.take();
    let stdout = child.stdout.take().expect("piped stdout");
    let stderr = child.stderr.take().expect("piped stderr");

    if !keep_stdin_open {
        // Drop it: the child sees EOF on stdin immediately, which is what we
        // want for non-interactive commands (build, clone, etc.) so they
        // never hang waiting on input we're never going to send.
        stdin = None;
    }

    let app_out = app.clone();
    let ev_out = event.clone();
    tokio::spawn(async move {
        let mut lines = BufReader::new(stdout).lines();
        while let Ok(Some(line)) = lines.next_line().await {
            let _ = app_out.emit(&format!("{ev_out}:line"), ProcessLine { stream: "stdout", text: line });
        }
    });

    let app_err = app.clone();
    let ev_err = event.clone();
    tokio::spawn(async move {
        let mut lines = BufReader::new(stderr).lines();
        while let Ok(Some(line)) = lines.next_line().await {
            let _ = app_err.emit(&format!("{ev_err}:line"), ProcessLine { stream: "stderr", text: line });
        }
    });

    Ok((child, stdin))
}

/// Runs `spawn_streamed` to completion (non-interactive) and emits the final
/// `{event}:done`. Returns the exit status.
pub async fn run_streamed_to_completion(
    app: AppHandle,
    event: impl Into<String>,
    program: &str,
    args: &[&str],
    cwd: Option<&Path>,
) -> std::io::Result<std::process::ExitStatus> {
    let event = event.into();
    let (mut child, _stdin) = spawn_streamed(app.clone(), event.clone(), program, args, cwd, false)?;
    let status = child.wait().await?;
    let _ = app.emit(
        &format!("{event}:done"),
        ProcessDone { code: status.code(), success: status.success() },
    );
    Ok(status)
}

/// Runs a command to completion without streaming (small, fast checks like
/// `gh auth status`) and returns its captured stdout as a `String`.
pub async fn run_captured(
    program: &str,
    args: &[&str],
    cwd: Option<&Path>,
) -> std::io::Result<(bool, String, String)> {
    let mut cmd = base_command(program, args, cwd);
    cmd.stdin(Stdio::null()).stdout(Stdio::piped()).stderr(Stdio::piped());
    let output = cmd.output().await?;
    Ok((
        output.status.success(),
        String::from_utf8_lossy(&output.stdout).into_owned(),
        String::from_utf8_lossy(&output.stderr).into_owned(),
    ))
}

/// Every headless `claude -p` prompt built by this app should include this:
/// it's a one-shot, non-interactive session, so anything Claude starts in
/// the background and doesn't wait for is simply lost once the session
/// ends. Learned the hard way - see `run_task.rs`'s module docs for the real
/// run this was observed on (a `lake build` left running in the background
/// while the session ended having never come back to check on it).
pub const ONE_SHOT_SESSION_NOTE: &str = "This is a ONE-SHOT, non-interactive session - once you stop calling \
     tools, nothing resumes or re-invokes you later, even if your last message says you'll check back once \
     something finishes. If you run a long command like `lake build` in the background, you must actively \
     poll it until it actually completes before ending your turn - do not end your turn assuming you'll be \
     woken up when it's done. If you're not confident a background job will finish before you run out of \
     turns, run it in the foreground (a blocking call) instead, even if that one call takes a long time to \
     return.";

/// Spawns `claude -p` in headless JSON-streaming mode, forwarding each
/// stdout line as `{event}:event` (parsed JSON, or a `{"type":"raw",...}`
/// wrapper if a line doesn't parse - the exact stream-json schema isn't
/// fully documented, see GUI/README.md, so staying defensive here avoids a
/// schema surprise crashing a run) and each stderr line as `{event}:stderr`.
/// Doesn't wait for the child - callers that need the exit status call
/// `.wait()` on the returned `Child` themselves, and can additionally await
/// the returned stdout-forwarding task afterward if they need every event
/// guaranteed emitted first (e.g. before reading files Claude was told to
/// write, so the activity feed doesn't visibly cut off early).
pub fn spawn_claude_streaming(
    app: AppHandle,
    event: impl Into<String>,
    prompt: &str,
    cwd: &Path,
    claude_oauth_token: Option<&str>,
    model: Option<&str>,
) -> std::io::Result<(Child, tokio::task::JoinHandle<()>)> {
    let event = event.into();
    let mut args: Vec<&str> =
        vec!["-p", prompt, "--permission-mode", "bypassPermissions", "--output-format", "stream-json", "--verbose"];
    // Omitted entirely when unset, so the CLI keeps whatever model the user
    // has configured for themselves - that, not a hardcoded default, is the
    // right "no preference" behavior. Accepts an alias (`opus`) or a full id
    // (`claude-opus-5`); which ids actually work depends on the signed-in
    // account's plan, so an unavailable one surfaces as a run-time error from
    // `claude` rather than something we can validate up front.
    if let Some(model) = model {
        args.push("--model");
        args.push(model);
    }
    let mut cmd = base_command("claude", &args, Some(cwd));
    cmd.stdin(Stdio::null()).stdout(Stdio::piped()).stderr(Stdio::piped());
    if let Some(token) = claude_oauth_token {
        cmd.env("CLAUDE_CODE_OAUTH_TOKEN", token);
    }

    let mut child = cmd.spawn()?;
    let stdout = child.stdout.take().expect("piped stdout");
    let stderr = child.stderr.take().expect("piped stderr");

    let app_out = app.clone();
    let ev_out = event.clone();
    let stdout_task = tokio::spawn(async move {
        let mut lines = BufReader::new(stdout).lines();
        while let Ok(Some(line)) = lines.next_line().await {
            if line.trim().is_empty() {
                continue;
            }
            let value: serde_json::Value =
                serde_json::from_str(&line).unwrap_or_else(|_| serde_json::json!({"type": "raw", "text": line}));
            let _ = app_out.emit(&format!("{ev_out}:event"), value);
        }
    });

    let app_err = app.clone();
    let ev_err = event.clone();
    tokio::spawn(async move {
        let mut lines = BufReader::new(stderr).lines();
        while let Ok(Some(line)) = lines.next_line().await {
            let _ = app_err.emit(&format!("{ev_err}:stderr"), line);
        }
    });

    Ok((child, stdout_task))
}
