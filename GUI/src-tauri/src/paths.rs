//! OS-specific tool detection and PATH resolution.
//!
//! The GUI never shells through bash — every external tool (`git`, `gh`,
//! `lake`, `claude`, `uv`) is invoked directly as a native process. Two
//! problems that follows from that, which this module exists to solve:
//!
//! 1. GUI apps launched from a desktop/dock/Start-menu icon (not a terminal)
//!    often don't inherit the same PATH a login shell would have, so a tool
//!    installed earlier in this same session (e.g. elan, just installed by
//!    `setup_env`) may not show up via a plain PATH lookup until the process
//!    restarts. `augmented_path_dirs` lists the well-known per-tool install
//!    locations so we can prepend them ourselves.
//! 2. We need simple existence checks (`has_tool`) to drive onboarding's
//!    "already done" detection, without needing a shell at all.

use std::path::PathBuf;

pub fn home_dir() -> Option<PathBuf> {
    dirs::home_dir()
}

/// Cross-platform PATH lookup for `program`, without spawning a shell.
pub fn which(program: &str) -> Option<PathBuf> {
    let path_var = std::env::var_os("PATH")?;
    let candidates_from = |dir: PathBuf| -> Vec<PathBuf> {
        if cfg!(windows) {
            let pathext = std::env::var("PATHEXT").unwrap_or_else(|_| ".EXE;.CMD;.BAT".into());
            pathext
                .split(';')
                .map(|ext| dir.join(format!("{program}{ext}")))
                .collect()
        } else {
            vec![dir.join(program)]
        }
    };

    for dir in std::env::split_paths(&path_var) {
        for candidate in candidates_from(dir) {
            if candidate.is_file() {
                return Some(candidate);
            }
        }
    }
    // Fall back to the extra install locations we know about, in case this
    // process's PATH hasn't picked up a tool installed earlier this session.
    for dir in augmented_path_dirs() {
        for candidate in candidates_from(dir) {
            if candidate.is_file() {
                return Some(candidate);
            }
        }
    }
    None
}

pub fn has_tool(program: &str) -> bool {
    which(program).is_some()
}

/// Well-known per-tool install directories that might not yet be reflected
/// in this process's inherited PATH. Returned in priority order.
pub fn augmented_path_dirs() -> Vec<PathBuf> {
    let mut dirs = Vec::new();
    let Some(home) = home_dir() else { return dirs };

    // elan (Lean toolchain) - installs to ~/.elan/bin on every OS.
    dirs.push(home.join(".elan").join("bin"));

    if cfg!(windows) {
        // uv's Windows installer.
        if let Ok(local_app_data) = std::env::var("LOCALAPPDATA") {
            dirs.push(PathBuf::from(&local_app_data).join("Programs").join("uv"));
        }
        dirs.push(home.join(".local").join("bin"));
        // Git for Windows.
        dirs.push(PathBuf::from(r"C:\Program Files\Git\cmd"));
        dirs.push(PathBuf::from(r"C:\Program Files\Git\bin"));
        // GitHub CLI's default winget/MSI install location.
        if let Ok(program_files) = std::env::var("ProgramFiles") {
            dirs.push(PathBuf::from(&program_files).join("GitHub CLI"));
        }
        // npm global bin (if Claude Code was installed via npm).
        if let Ok(app_data) = std::env::var("APPDATA") {
            dirs.push(PathBuf::from(&app_data).join("npm"));
        }
    } else {
        dirs.push(home.join(".local").join("bin"));
        dirs.push(PathBuf::from("/opt/homebrew/bin"));
        dirs.push(PathBuf::from("/usr/local/bin"));
    }
    dirs
}

/// Builds a PATH value for spawned children: the current process's PATH with
/// the known extra install directories prepended (de-duplicated), so a tool
/// installed earlier this session is reliably found even before the app
/// restarts.
pub fn augmented_path_env() -> std::ffi::OsString {
    let mut parts: Vec<PathBuf> = augmented_path_dirs();
    if let Some(existing) = std::env::var_os("PATH") {
        parts.extend(std::env::split_paths(&existing));
    }
    // De-duplicate while preserving order.
    let mut seen = std::collections::HashSet::new();
    let deduped: Vec<PathBuf> = parts.into_iter().filter(|p| seen.insert(p.clone())).collect();
    std::env::join_paths(deduped).unwrap_or_default()
}

/// Best-effort detection of an existing Claude Code login, mirroring the
/// bash harness's own `claude_signed_in()` check (Scripts/physlib-auto-task.sh).
pub fn claude_credentials_exist() -> bool {
    let Some(home) = home_dir() else { return false };
    home.join(".claude").join(".credentials.json").exists()
        || home.join(".config").join("claude").join(".credentials.json").exists()
}

/// Removes Claude Code's own credentials file, if present, so a fresh
/// sign-in (e.g. to switch accounts, via the settings gear icon) starts
/// clean rather than being masked by `claude_credentials_exist()` still
/// seeing the old login. Best-effort: a missing file is not an error.
pub fn clear_claude_credentials() {
    let Some(home) = home_dir() else { return };
    let _ = std::fs::remove_file(home.join(".claude").join(".credentials.json"));
    let _ = std::fs::remove_file(home.join(".config").join("claude").join(".credentials.json"));
}

/// Git for Windows' bash.exe, if installed - needed only because Claude
/// Code's own Bash tool looks for it on Windows (without it, Claude Code
/// falls back to a PowerShell tool). Our own orchestration never uses this.
#[cfg(target_os = "windows")]
pub fn find_git_bash() -> Option<PathBuf> {
    [r"C:\Program Files\Git\bin\bash.exe", r"C:\Program Files (x86)\Git\bin\bash.exe"]
        .iter()
        .map(PathBuf::from)
        .find(|p| p.exists())
}
