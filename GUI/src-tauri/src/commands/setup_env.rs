//! Native, per-OS environment setup: install git/elan/gh/uv/claude if
//! they're missing, then fork+clone Physlib, fetch the Mathlib cache, build,
//! and register `lean-lsp-mcp`. This is the native-installer equivalent of
//! `Scripts/physlib-auto-task.sh`'s steps 1/3/4/5 - re-implemented here
//! (rather than shelling to that script) because the whole point of this GUI
//! is to need no bash/WSL on Windows. Each sub-step streams under its own
//! `setup:<id>` event so the frontend can show a live checklist.
//!
//! Install commands are centralized in `install_commands` below so they're
//! easy to spot-check/update if a tool changes its recommended install
//! method - see GUI/README.md for which of these are high-confidence
//! (winget package IDs) vs. one-liner URLs worth re-verifying occasionally.

use crate::commands::workspace;
use crate::paths;
use crate::process;
use serde::Serialize;
use std::path::PathBuf;
use tauri::{AppHandle, Emitter};

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct SetupStep {
    id: &'static str,
    label: &'static str,
    status: &'static str, // "skipped" | "running" | "done" | "failed"
    detail: Option<String>,
}

fn emit_step(app: &AppHandle, id: &'static str, label: &'static str, status: &'static str, detail: Option<String>) {
    let _ = app.emit("setup:step", SetupStep { id, label, status, detail });
}

/// One shell-out to run an *officially provided* install one-liner. This is
/// the one place we invoke a shell at all: PowerShell on Windows (native,
/// not bash) and `sh` on macOS/Linux (the OS's own default shell, always
/// present) - narrowly scoped to running a single vendor-provided installer
/// command, not to our own orchestration. Windows uses a process-scoped
/// execution-policy bypass so these official scripts work on the default
/// Restricted policy without changing the user's persistent policy.
async fn run_installer_line(app: AppHandle, event: &str, line: &str) -> Result<(), String> {
    #[cfg(target_os = "windows")]
    let (program, args): (&str, Vec<&str>) = (
        "powershell.exe",
        vec![
            "-NoProfile",
            "-NonInteractive",
            "-ExecutionPolicy",
            "Bypass",
            "-Command",
            line,
        ],
    );
    #[cfg(not(target_os = "windows"))]
    let (program, args): (&str, Vec<&str>) = ("sh", vec!["-c", line]);

    let status = process::run_streamed_to_completion(app, event, program, &args, None)
        .await
        .map_err(|e| e.to_string())?;
    if status.success() {
        Ok(())
    } else {
        Err(format!("Installer exited with status {status}"))
    }
}

#[cfg(target_os = "windows")]
async fn winget_install(app: AppHandle, event: &str, package_id: &str) -> Result<(), String> {
    if !paths::has_tool("winget") {
        return Err(
            "winget isn't available. Install \"App Installer\" from the Microsoft Store, then retry."
                .into(),
        );
    }
    let status = process::run_streamed_to_completion(
        app,
        event,
        "winget",
        &[
            "install",
            "--id",
            package_id,
            "-e",
            "--source",
            "winget",
            "--accept-package-agreements",
            "--accept-source-agreements",
            "--silent",
        ],
        None,
    )
    .await
    .map_err(|e| e.to_string())?;
    if status.success() {
        Ok(())
    } else {
        Err(format!("winget install {package_id} exited with status {status}"))
    }
}

/// Ensures `gh` is available before the GitHub onboarding step tries to log
/// in. GitHub login intentionally comes before the full workspace setup, so
/// installing `gh` only from `install_prereqs` creates a circular dependency:
/// login needs `gh`, while the step that installs `gh` is gated on login.
pub async fn ensure_github_cli(app: AppHandle) -> Result<(), String> {
    if paths::has_tool("gh") {
        return Ok(());
    }

    #[cfg(target_os = "windows")]
    winget_install(app.clone(), "github-cli-install", "GitHub.cli").await?;

    #[cfg(target_os = "macos")]
    {
        if paths::has_tool("brew") {
            run_installer_line(app.clone(), "github-cli-install", "brew install gh").await?;
        } else {
            return Err(
                "GitHub CLI is required. Install Homebrew from https://brew.sh or install gh from https://cli.github.com/, then try again."
                    .into(),
            );
        }
    }

    #[cfg(all(unix, not(target_os = "macos")))]
    {
        if paths::has_tool("apt-get") {
            run_installer_line(
                app.clone(),
                "github-cli-install",
                "curl -fsSL https://cli.github.com/packages/githubcli-archive-keyring.gpg | sudo dd of=/usr/share/keyrings/githubcli-archive-keyring.gpg && \
                 sudo chmod go+r /usr/share/keyrings/githubcli-archive-keyring.gpg && \
                 echo \"deb [arch=$(dpkg --print-architecture) signed-by=/usr/share/keyrings/githubcli-archive-keyring.gpg] https://cli.github.com/packages stable main\" | sudo tee /etc/apt/sources.list.d/github-cli.list >/dev/null && \
                 sudo apt-get update -y && sudo apt-get install -y gh",
            )
            .await?;
        } else {
            return Err(
                "GitHub CLI is required. Install it from https://cli.github.com/, then try again."
                    .into(),
            );
        }
    }

    if paths::has_tool("gh") {
        Ok(())
    } else {
        Err(
            "GitHub CLI installation finished, but `gh` still couldn't be found. Restart the app and try again."
                .into(),
        )
    }
}

/// Ensures Claude Code is installed before either the automatic Windows login
/// or the visible-terminal fallback tries to run `claude setup-token`. Like
/// GitHub CLI, Claude Code was originally installed only by the later
/// workspace step, which is unreachable until account login has completed.
pub async fn ensure_claude_code(app: AppHandle) -> Result<(), String> {
    if paths::has_tool("claude") {
        return Ok(());
    }

    #[cfg(target_os = "windows")]
    let native = run_installer_line(
        app.clone(),
        "claude-cli-install",
        "irm https://claude.ai/install.ps1 | iex",
    )
    .await;

    #[cfg(not(target_os = "windows"))]
    let native = run_installer_line(
        app.clone(),
        "claude-cli-install",
        "curl -fsSL https://claude.ai/install.sh | sh",
    )
    .await;

    if native.is_err() {
        if paths::has_tool("npm") {
            let status = process::run_streamed_to_completion(
                app.clone(),
                "claude-cli-install",
                "npm",
                &["install", "-g", "@anthropic-ai/claude-code"],
                None,
            )
            .await
            .map_err(|e| e.to_string())?;
            if !status.success() {
                return Err(
                    "Failed to install Claude Code with both the native installer and npm."
                        .into(),
                );
            }
        } else {
            return Err(format!(
                "Claude Code's native installer failed ({}) and npm isn't available as a fallback.",
                native.unwrap_err()
            ));
        }
    }

    if paths::has_tool("claude") {
        Ok(())
    } else {
        Err(
            "Claude Code installation finished, but `claude` still couldn't be found. Restart the app and try again."
                .into(),
        )
    }
}

#[cfg(target_os = "windows")]
async fn install_prereqs(app: AppHandle) -> Result<(), String> {
    // git (winget's Git.Git is Git for Windows, which bundles bash.exe -
    // this is also what satisfies Claude Code's own Bash-tool requirement
    // on Windows, as a side effect of installing git at all).
    if !paths::has_tool("git") {
        emit_step(&app, "git", "Install Git", "running", None);
        winget_install(app.clone(), "setup:git", "Git.Git").await?;
    } else {
        emit_step(&app, "git", "Install Git", "skipped", None);
    }

    // elan (Lean toolchain). elan-init.exe is a self-contained installer
    // published on elan's GitHub releases.
    if !paths::has_tool("lake") {
        emit_step(&app, "elan", "Install the Lean toolchain (elan)", "running", None);
        run_installer_line(
            app.clone(),
            "setup:elan",
            "$exe = Join-Path $env:TEMP 'elan-init.exe'; \
             Invoke-WebRequest -UseBasicParsing \
               -Uri 'https://github.com/leanprover/elan/releases/latest/download/elan-init.exe' \
               -OutFile $exe; \
             & $exe -y --default-toolchain none",
        )
        .await?;
    } else {
        emit_step(&app, "elan", "Install the Lean toolchain (elan)", "skipped", None);
    }

    // GitHub CLI (may already be present if GitHub login ran first).
    if !paths::has_tool("gh") {
        emit_step(&app, "gh", "Install the GitHub CLI", "running", None);
        ensure_github_cli(app.clone()).await?;
    } else {
        emit_step(&app, "gh", "Install the GitHub CLI", "skipped", None);
    }

    // uv (runs lean-lsp-mcp via `uvx`).
    if !paths::has_tool("uv") && !paths::has_tool("uvx") {
        emit_step(&app, "uv", "Install uv", "running", None);
        run_installer_line(app.clone(), "setup:uv", "irm https://astral.sh/uv/install.ps1 | iex").await?;
    } else {
        emit_step(&app, "uv", "Install uv", "skipped", None);
    }

    // Claude Code: prefer the native installer; fall back to npm if that
    // fails and npm is available.
    if !paths::has_tool("claude") {
        emit_step(&app, "claude", "Install Claude Code", "running", None);
        ensure_claude_code(app.clone()).await?;
    } else {
        emit_step(&app, "claude", "Install Claude Code", "skipped", None);
    }

    Ok(())
}

#[cfg(target_os = "macos")]
async fn install_prereqs(app: AppHandle) -> Result<(), String> {
    if !paths::has_tool("git") {
        emit_step(&app, "git", "Install Git", "running", None);
        // Triggers the Xcode Command Line Tools installer dialog if Xcode
        // isn't already present; if Homebrew is available, prefer that
        // since it doesn't need a GUI dialog confirmation.
        if paths::has_tool("brew") {
            run_installer_line(app.clone(), "setup:git", "brew install git").await?;
        } else {
            // Unlike every other installer here, `xcode-select --install`
            // only opens a GUI dialog and returns immediately - its exit
            // code says nothing about whether the user actually finished
            // it (that can take several minutes). Wait for `git` to
            // actually show up instead of trusting the exit code.
            emit_step(
                &app,
                "git",
                "Install Git",
                "running",
                Some("Finish the Xcode Command Line Tools dialog that just opened - this can take a few minutes.".into()),
            );
            let _ = run_installer_line(app.clone(), "setup:git", "xcode-select --install").await;
            let step = std::time::Duration::from_secs(3);
            let limit = std::time::Duration::from_secs(20 * 60);
            let mut waited = std::time::Duration::ZERO;
            while !paths::has_tool("git") && waited < limit {
                tokio::time::sleep(step).await;
                waited += step;
            }
            if !paths::has_tool("git") {
                return Err(
                    "The Xcode Command Line Tools installation didn't finish in time - finish it yourself (or install Homebrew and retry), then come back.".into(),
                );
            }
        }
    } else {
        emit_step(&app, "git", "Install Git", "skipped", None);
    }

    if !paths::has_tool("lake") {
        emit_step(&app, "elan", "Install the Lean toolchain (elan)", "running", None);
        run_installer_line(app.clone(), "setup:elan", "curl https://elan.lean-lang.org/elan-init.sh -sSf | sh -s -- -y").await?;
    } else {
        emit_step(&app, "elan", "Install the Lean toolchain (elan)", "skipped", None);
    }

    if !paths::has_tool("gh") {
        emit_step(&app, "gh", "Install the GitHub CLI", "running", None);
        ensure_github_cli(app.clone()).await?;
    } else {
        emit_step(&app, "gh", "Install the GitHub CLI", "skipped", None);
    }

    if !paths::has_tool("uv") && !paths::has_tool("uvx") {
        emit_step(&app, "uv", "Install uv", "running", None);
        run_installer_line(app.clone(), "setup:uv", "curl -LsSf https://astral.sh/uv/install.sh | sh").await?;
    } else {
        emit_step(&app, "uv", "Install uv", "skipped", None);
    }

    if !paths::has_tool("claude") {
        emit_step(&app, "claude", "Install Claude Code", "running", None);
        ensure_claude_code(app.clone()).await?;
    } else {
        emit_step(&app, "claude", "Install Claude Code", "skipped", None);
    }

    Ok(())
}

#[cfg(all(unix, not(target_os = "macos")))]
async fn install_prereqs(app: AppHandle) -> Result<(), String> {
    let apt = paths::has_tool("apt-get");

    if !paths::has_tool("git") {
        emit_step(&app, "git", "Install Git", "running", None);
        if apt {
            run_installer_line(app.clone(), "setup:git", "sudo apt-get update -y && sudo apt-get install -y git").await?;
        } else {
            return Err("Couldn't auto-install git on this Linux distribution; install it and retry.".into());
        }
    } else {
        emit_step(&app, "git", "Install Git", "skipped", None);
    }

    if !paths::has_tool("lake") {
        emit_step(&app, "elan", "Install the Lean toolchain (elan)", "running", None);
        run_installer_line(app.clone(), "setup:elan", "curl https://elan.lean-lang.org/elan-init.sh -sSf | sh -s -- -y").await?;
    } else {
        emit_step(&app, "elan", "Install the Lean toolchain (elan)", "skipped", None);
    }

    if !paths::has_tool("gh") {
        emit_step(&app, "gh", "Install the GitHub CLI", "running", None);
        ensure_github_cli(app.clone()).await?;
    } else {
        emit_step(&app, "gh", "Install the GitHub CLI", "skipped", None);
    }

    if !paths::has_tool("uv") && !paths::has_tool("uvx") {
        emit_step(&app, "uv", "Install uv", "running", None);
        run_installer_line(app.clone(), "setup:uv", "curl -LsSf https://astral.sh/uv/install.sh | sh").await?;
    } else {
        emit_step(&app, "uv", "Install uv", "skipped", None);
    }

    if !paths::has_tool("claude") {
        emit_step(&app, "claude", "Install Claude Code", "running", None);
        ensure_claude_code(app.clone()).await?;
    } else {
        emit_step(&app, "claude", "Install Claude Code", "skipped", None);
    }

    Ok(())
}

/// Runs the full environment setup: install prerequisites, fork+clone
/// Physlib into `workspace_dir`, fetch the Mathlib cache, build, and
/// register `lean-lsp-mcp`.
#[tauri::command]
pub async fn run_setup(app: AppHandle, workspace_dir: String) -> Result<(), String> {
    install_prereqs(app.clone()).await?;

    let dir = PathBuf::from(&workspace_dir);
    emit_step(&app, "clone", "Fork and clone Physlib", "running", None);
    workspace::ensure_cloned(app.clone(), &dir).await?;
    emit_step(&app, "clone", "Fork and clone Physlib", "done", None);

    // `lake exe get_cache` is Physlib's own script (scripts/get_cache.lean).
    // It fetches Mathlib's prebuilt oleans *and* Physlib's own artifacts from
    // the project's cache bucket, where `lake exe cache get` fetches only the
    // former - leaving Physlib itself to compile from source, which is the
    // expensive half. This is the command Physlib's install docs give.
    //
    // Non-fatal by design, again following those docs: "Do not worry if it
    // fails, you can still run `lake build`, it will just be much slower." A
    // failed download is a slow build, not a broken setup, so it is reported
    // as skipped and the build carries on.
    emit_step(&app, "cache", "Fetch the Physlib and Mathlib caches", "running", None);
    let cache_status = process::run_streamed_to_completion(app.clone(), "setup:cache", "lake", &["exe", "get_cache"], Some(&dir))
        .await
        .map_err(|e| e.to_string())?;
    if cache_status.success() {
        emit_step(&app, "cache", "Fetch the Physlib and Mathlib caches", "done", None);
    } else {
        emit_step(
            &app,
            "cache",
            "Fetch the Physlib and Mathlib caches",
            "skipped",
            Some("Couldn't download the caches. The build below will still work, but will take a lot longer.".into()),
        );
    }

    emit_step(&app, "build", "Build Physlib", "running", None);
    let build_status = process::run_streamed_to_completion(app.clone(), "setup:build", "lake", &["build"], Some(&dir))
        .await
        .map_err(|e| e.to_string())?;
    if !build_status.success() {
        emit_step(&app, "build", "Build Physlib", "failed", None);
        return Err("Failed to build Physlib (`lake build`). See the log above.".into());
    }
    emit_step(&app, "build", "Build Physlib", "done", None);

    emit_step(&app, "mcp", "Connect Lean tools (lean-lsp-mcp)", "running", None);
    let mcp_status = process::run_streamed_to_completion(
        app.clone(),
        "setup:mcp",
        "claude",
        &["mcp", "add", "lean-lsp", "--", "uvx", "lean-lsp-mcp"],
        None,
    )
    .await
    .map_err(|e| e.to_string())?;
    // Non-fatal if it's already registered (claude mcp add errors on a
    // duplicate name) - the script treats this the same way.
    emit_step(&app, "mcp", "Connect Lean tools (lean-lsp-mcp)", if mcp_status.success() { "done" } else { "skipped" }, None);

    Ok(())
}
