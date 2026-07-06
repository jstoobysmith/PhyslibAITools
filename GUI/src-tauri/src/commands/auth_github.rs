//! GitHub login via `gh auth login --web` over plain piped stdio. This reuses
//! `gh`'s own OAuth device-flow end to end - no custom OAuth App needed. The
//! flow's only required keypress is a single Enter to open the browser, which
//! we send automatically as soon as the process starts; `--git-protocol
//! https` avoids the separate SSH-key prompt so nothing else needs input.

use crate::process;
use regex::Regex;
use serde::Serialize;
use std::process::Stdio;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use tauri::{AppHandle, Emitter};
use tokio::io::{AsyncRead, AsyncReadExt, AsyncWriteExt};

#[tauri::command]
pub async fn github_status() -> bool {
    process::run_captured("gh", &["auth", "status"], None)
        .await
        .map(|(ok, _, _)| ok)
        .unwrap_or(false)
}

/// Signs out of GitHub on this machine (settings gear icon → "Sign out"),
/// so the next `start_github_login` can sign in as a different account.
/// Best-effort - if `gh` was never logged in this just no-ops.
#[tauri::command]
pub async fn github_logout() {
    let _ = process::run_captured("gh", &["auth", "logout", "--hostname", "github.com"], None).await;
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct GithubLoginCode {
    code: String,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct GithubLoginDone {
    success: bool,
}

/// Reads one of `gh`'s piped streams to completion, emitting
/// `github-login:line` for each complete line and `github-login:code` as
/// soon as a device code appears - same as a plain `.lines()` reader would -
/// but checks for `gh`'s final success text against the *raw, accumulating*
/// buffer rather than waiting for a complete line first. This matters
/// because that text has been observed to arrive without ever being
/// followed by a newline (and the stream not reaching EOF promptly either -
/// plausibly a spawned browser-launcher helper on Windows inheriting `gh`'s
/// piped handles and keeping them open), which would make a `.lines()`based
/// check never fire at all, not just fire late.
async fn watch_stream<R: AsyncRead + Unpin>(
    app: AppHandle,
    mut reader: R,
    code_re: Regex,
    success_re: Regex,
    done_emitted: Arc<AtomicBool>,
) {
    let mut buf: Vec<u8> = Vec::new();
    let mut chunk = [0u8; 4096];

    loop {
        let n = match reader.read(&mut chunk).await {
            Ok(0) | Err(_) => break,
            Ok(n) => n,
        };
        buf.extend_from_slice(&chunk[..n]);

        while let Some(pos) = buf.iter().position(|&b| b == b'\n') {
            let line_bytes: Vec<u8> = buf.drain(..=pos).collect();
            let line = String::from_utf8_lossy(&line_bytes).trim_end_matches(['\r', '\n']).to_string();
            emit_line(&app, &code_re, &line);
        }

        // Whatever's left in `buf` is the not-yet-newline-terminated tail -
        // check it (not just completed lines) for the success marker.
        let tail = String::from_utf8_lossy(&buf);
        if success_re.is_match(&tail) && !done_emitted.swap(true, Ordering::SeqCst) {
            let _ = app.emit("github-login:done", GithubLoginDone { success: true });
        }
    }

    if !buf.is_empty() {
        let line = String::from_utf8_lossy(&buf).trim_end_matches(['\r', '\n']).to_string();
        if !line.is_empty() {
            emit_line(&app, &code_re, &line);
        }
    }
}

fn emit_line(app: &AppHandle, code_re: &Regex, line: &str) {
    let _ = app.emit("github-login:line", line);
    if let Some(m) = code_re.find(line) {
        let _ = app.emit("github-login:code", GithubLoginCode { code: m.as_str().to_string() });
    }
}

/// Starts `gh auth login --web`, streams its output as `github-login:line`,
/// emits `github-login:code` as soon as the one-time code appears, and
/// `github-login:done` when the flow finishes (the device flow polls
/// automatically after the browser step - no further input needed).
#[tauri::command]
pub async fn start_github_login(app: AppHandle) -> Result<(), String> {
    let mut cmd = process::command(
        "gh",
        &["auth", "login", "--hostname", "github.com", "--web", "--git-protocol", "https"],
        None,
    );
    cmd.stdin(Stdio::piped()).stdout(Stdio::piped()).stderr(Stdio::piped());
    let mut child = cmd.spawn().map_err(|e| format!("Couldn't start `gh auth login`: {e}"))?;

    // `gh auth login --web` prints the device code and a prompt to press
    // Enter to open the browser - to both stderr and stdout depending on
    // version, so send the newline right away rather than waiting to see it.
    if let Some(mut stdin) = child.stdin.take() {
        tokio::spawn(async move {
            let _ = stdin.write_all(b"\n").await;
            let _ = stdin.flush().await;
            // Keep the handle open briefly in case gh reads it lazily, then
            // let it drop (closing stdin, which is fine - gh needs nothing
            // further from us for the rest of the device-flow poll).
            tokio::time::sleep(std::time::Duration::from_millis(500)).await;
        });
    }

    let stdout = child.stdout.take().expect("piped stdout");
    let stderr = child.stderr.take().expect("piped stderr");
    // GitHub's device codes look like "ABCD-1234".
    let code_re = Regex::new(r"\b[A-Z0-9]{4}-[A-Z0-9]{4}\b").unwrap();

    // `gh`'s process exit isn't a reliable "it's done" signal here (observed
    // in practice: the CLI's own output clearly reaches "Logged in as
    // <user>", but `child.wait()` below can take a very long time to
    // resolve, or never does). So treat `gh`'s own final success line as
    // authoritative the moment it appears in either stream - see
    // `watch_stream` for why that check happens against raw, not
    // line-buffered, text. `done_emitted` makes sure only one
    // `github-login:done` goes out, whichever source notices first.
    let done_emitted = Arc::new(AtomicBool::new(false));
    let success_re = Regex::new(r"Logged in as").unwrap();

    tokio::spawn(watch_stream(app.clone(), stdout, code_re.clone(), success_re.clone(), done_emitted.clone()));
    tokio::spawn(watch_stream(app.clone(), stderr, code_re, success_re, done_emitted.clone()));

    tokio::spawn(async move {
        let status = child.wait().await.ok();
        let success = status.map(|s| s.success()).unwrap_or(false);
        if !done_emitted.swap(true, Ordering::SeqCst) {
            let _ = app.emit("github-login:done", GithubLoginDone { success });
        }
    });

    Ok(())
}
