//! Claude Code login: a real subscription OAuth flow (`claude setup-token`),
//! run fully automatically with no visible window and no manual copy-paste.
//!
//! This is the third design. The first two, in order:
//!
//! 1. Plain piped stdio - hung immediately. The CLI opens by sending a
//!    `\x1b[6n` "where's the cursor?" terminal query and waits for an
//!    answer only a real terminal sends.
//! 2. A `portable-pty`-backed pseudo-console, with that one query
//!    auto-answered transparently in Rust. This unblocked the initial
//!    output and the OAuth URL, but completion itself - a background check
//!    the CLI does after the browser step - stayed unreliable in ways that
//!    couldn't be pinned down from the outside (see git history / old
//!    README revisions). A visible, genuinely native terminal (`cmd /K`)
//!    was the only thing confirmed to complete reliably every time, but it
//!    required the user to copy a printed token back into the app by hand.
//!
//! The insight that unlocked full automation: the reliability difference
//! wasn't "real terminal vs. hidden terminal", it was "real console vs.
//! ConPTY". A genuine Win32 console (backed by `conhost.exe`) answers `\x1b[6n`
//! and every other terminal query itself, correctly, with zero help from
//! us - that's *why* the visible-terminal version worked unmodified. A
//! `portable-pty` pseudo-console is a from-scratch reimplementation of that
//! same protocol, and evidently an incomplete one for this CLI's purposes.
//!
//! So: give the child a real console (`CREATE_NEW_CONSOLE`), exactly like
//! the visible-terminal version, but hand the resulting console window
//! `SW_HIDE` instead of `SW_SHOW`. Window visibility is purely a
//! window-manager property - it doesn't change how `conhost.exe` services
//! the child's console API calls. Then, from our own process, borrow that
//! console's output buffer just long enough to copy its text
//! (`AttachConsole` + `CONOUT$` + `ReadConsoleOutputCharacterW`), poll it a
//! few times a second, and regex out the sign-in URL (the CLI already opens
//! this itself - we only surface it as a "click here" fallback link, since
//! also opening it ourselves opened a second, duplicate browser tab) and the
//! final printed token (to verify and save automatically). This was
//! confirmed empirically before being wired in here: a standalone test
//! spawned `claude setup-token` this way and watched it print its full
//! banner, "Opening browser to sign in…", and the OAuth URL with no DSR
//! answering of any kind on our part - conhost handled it natively, same as
//! it does for a normal visible terminal.
//!
//! Not available on macOS/Linux (this technique is Windows-specific); those
//! platforms keep the older visible-terminal-plus-paste flow, exposed here
//! as `open_claude_login_terminal` / `verify_claude_oauth_token`, which
//! Windows also falls back to via a "sign in with a terminal instead" link
//! if the automatic flow ever fails.

use crate::commands::setup_env;
use crate::paths;
use crate::process;
use serde::Serialize;
use std::process::Stdio;
use std::sync::Mutex;
use tauri::{AppHandle, State};

#[tauri::command]
pub fn claude_status() -> bool {
    paths::claude_credentials_exist()
}

/// Signs out of Claude Code on this machine (settings gear icon → "Sign
/// out"), so the next sign-in - possibly a different account - starts
/// clean. Only clears Claude Code's own credentials file; the app's
/// separately-stored OAuth token (`config.claudeOauthToken`) is the
/// frontend's responsibility to clear via `save_config`, same as it's the
/// frontend's job to persist a new one after signing back in.
#[tauri::command]
pub fn claude_logout() {
    paths::clear_claude_credentials();
}

/// Tracks the PID of the hidden console currently running `claude
/// setup-token`, if any, so a second attempt (or an explicit cancel) can
/// clean up the previous one instead of leaking it.
#[derive(Default)]
pub struct ClaudeLoginState(pub Mutex<Option<u32>>);

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase", tag = "kind")]
pub enum ClaudeLoginEvent {
    Url { url: String },
    Done { token: String },
    Error { message: String },
}

fn kill_pid(pid: u32) {
    let _ = std::process::Command::new("taskkill").args(["/PID", &pid.to_string(), "/T", "/F"]).output();
}

/// Starts the automatic, hidden sign-in flow. Only implemented on Windows -
/// see module docs. Emits `claude-login` events as it progresses; the
/// frontend does not need to (and should not) poll anything itself.
#[tauri::command]
pub async fn start_claude_login(app: AppHandle, state: State<'_, ClaudeLoginState>) -> Result<(), String> {
    setup_env::ensure_claude_code(app.clone()).await?;

    #[cfg(target_os = "windows")]
    {
        windows_impl::start(app, state).await
    }
    #[cfg(not(target_os = "windows"))]
    {
        let _ = (app, state);
        Err("Automatic sign-in isn't available on this OS - use \"sign in with a terminal instead\" below.".into())
    }
}

/// Stops an in-progress automatic sign-in (user cancelled, or the step
/// unmounted) and forgets its PID.
#[tauri::command]
pub fn cancel_claude_login(state: State<'_, ClaudeLoginState>) -> Result<(), String> {
    if let Some(pid) = state.0.lock().map_err(|e| e.to_string())?.take() {
        kill_pid(pid);
    }
    Ok(())
}

/// Opens a real terminal window running `claude setup-token`, native to the
/// OS - the fallback path when the automatic flow isn't available or fails.
#[tauri::command]
pub async fn open_claude_login_terminal(app: AppHandle) -> Result<(), String> {
    setup_env::ensure_claude_code(app).await?;
    let path = paths::augmented_path_env();

    #[cfg(target_os = "windows")]
    {
        std::process::Command::new("cmd")
            .args(["/C", "start", "", "cmd", "/K", "claude setup-token"])
            .env("PATH", &path)
            .spawn()
            .map_err(|e| format!("Couldn't open a terminal: {e}"))?;
    }
    #[cfg(target_os = "macos")]
    {
        // `osascript` telling Terminal.app to "do script" runs it in a brand
        // new Terminal session that does NOT inherit osascript's own
        // environment (unlike spawning a terminal emulator directly, as the
        // Linux branch below does) - so `.env("PATH", ...)` on this Command
        // would silently have no effect on what `claude setup-token` sees.
        // Instead, bake the PATH into the shell command that actually runs
        // inside that new session.
        let shell_cmd = format!("export PATH={}:\"$PATH\"; claude setup-token", shell_single_quote(&path.to_string_lossy()));
        let script = format!("tell application \"Terminal\" to do script \"{}\"", applescript_escape(&shell_cmd));
        std::process::Command::new("osascript")
            .args(["-e", &script])
            .spawn()
            .map_err(|e| format!("Couldn't open a terminal: {e}"))?;
    }
    #[cfg(all(unix, not(target_os = "macos")))]
    {
        let candidates: &[(&str, &[&str])] = &[
            ("x-terminal-emulator", &["-e", "bash", "-lc", "claude setup-token; exec bash"]),
            ("gnome-terminal", &["--", "bash", "-lc", "claude setup-token; exec bash"]),
            ("konsole", &["-e", "bash", "-lc", "claude setup-token; exec bash"]),
            ("xterm", &["-e", "bash", "-lc", "claude setup-token; exec bash"]),
        ];
        let mut launched = false;
        for (bin, args) in candidates {
            if paths::has_tool(bin) {
                if std::process::Command::new(bin).args(*args).env("PATH", &path).spawn().is_ok() {
                    launched = true;
                    break;
                }
            }
        }
        if !launched {
            return Err(
                "Couldn't find a terminal to open automatically - run `claude setup-token` yourself in a terminal instead.".into(),
            );
        }
    }
    Ok(())
}

/// Wraps `s` in single quotes for safe use as one word in a POSIX shell
/// command (handles embedded single quotes via the standard `'\''` trick).
#[cfg(target_os = "macos")]
fn shell_single_quote(s: &str) -> String {
    format!("'{}'", s.replace('\'', r"'\''"))
}

/// Escapes `s` for embedding inside an AppleScript double-quoted string
/// literal (used to pass a shell command through `osascript -e`).
#[cfg(target_os = "macos")]
fn applescript_escape(s: &str) -> String {
    s.replace('\\', "\\\\").replace('"', "\\\"")
}

/// Confirms a token actually works before it's saved, with one cheap, real
/// request. Used both by the automatic flow (on the token it captures) and
/// the manual fallback (on what the user pastes).
#[tauri::command]
pub async fn verify_claude_oauth_token(token: String) -> Result<(), String> {
    verify_token(token.trim()).await
}

async fn verify_token(token: &str) -> Result<(), String> {
    if token.is_empty() {
        return Err("No token to verify.".into());
    }

    let mut cmd = process::command("claude", &["-p", "Reply with just: OK", "--max-turns", "1"], None);
    cmd.env("CLAUDE_CODE_OAUTH_TOKEN", token);
    cmd.stdin(Stdio::null()).stdout(Stdio::piped()).stderr(Stdio::piped());

    let output = cmd.output().await.map_err(|e| format!("Couldn't run Claude Code: {e}"))?;
    if output.status.success() {
        Ok(())
    } else {
        let last_line = |bytes: &[u8]| -> Option<String> {
            String::from_utf8_lossy(bytes).lines().map(str::trim).filter(|l| !l.is_empty()).last().map(str::to_string)
        };
        let detail = last_line(&output.stdout).or_else(|| last_line(&output.stderr)).unwrap_or_else(|| "no error detail returned".into());
        Err(format!("That token didn't work: {detail}"))
    }
}

#[cfg(target_os = "windows")]
mod windows_impl {
    use super::{kill_pid, verify_token, ClaudeLoginEvent, ClaudeLoginState};
    use crate::paths;
    use regex::Regex;
    use std::sync::LazyLock;
    use std::time::Duration;
    use tauri::{AppHandle, Emitter, Manager, State};
    use windows::core::{PCWSTR, PWSTR};
    use windows::Win32::Foundation::{CloseHandle, GENERIC_READ, GENERIC_WRITE, HANDLE};
    use windows::Win32::Storage::FileSystem::{CreateFileW, FILE_SHARE_READ, FILE_SHARE_WRITE, OPEN_EXISTING};
    use windows::Win32::System::Console::{
        AttachConsole, FreeConsole, GetConsoleScreenBufferInfo, ReadConsoleOutputCharacterW,
        CONSOLE_SCREEN_BUFFER_INFO, COORD,
    };
    use windows::Win32::System::Threading::{
        CreateProcessW, CREATE_NEW_CONSOLE, CREATE_UNICODE_ENVIRONMENT, PROCESS_INFORMATION, STARTUPINFOW,
        STARTF_USESHOWWINDOW,
    };
    use windows::Win32::UI::WindowsAndMessaging::SW_HIDE;

    /// Special value for `AttachConsole` meaning "reattach to whatever
    /// console my parent process has" - used to restore this process's own
    /// console (if any - only relevant in `npm run tauri dev`, where this
    /// binary keeps the normal console subsystem) after each borrow. A
    /// release build never has one to begin with, so this is a no-op there.
    const ATTACH_PARENT_PROCESS: u32 = 0xFFFF_FFFF;

    const TIMEOUT: Duration = Duration::from_secs(180);
    const POLL_INTERVAL: Duration = Duration::from_millis(750);
    const STABLE_POLLS_REQUIRED: u8 = 2;

    static URL_RE: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"https://\S+").unwrap());
    static TOKEN_RE: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"sk-ant-\S+").unwrap());

    fn to_wide(s: &str) -> Vec<u16> {
        s.encode_utf16().chain(std::iter::once(0)).collect()
    }

    /// Builds a CreateProcessW-style environment block: the current
    /// process's environment with PATH replaced by `path_override`, so the
    /// hidden console finds `claude` even if it was only installed earlier
    /// this session (see `paths::augmented_path_env`).
    fn build_environment_block(path_override: &str) -> Vec<u16> {
        let mut entries: Vec<(String, String)> = std::env::vars().collect();
        match entries.iter_mut().find(|(k, _)| k.eq_ignore_ascii_case("PATH")) {
            Some(entry) => entry.1 = path_override.to_string(),
            None => entries.push(("PATH".to_string(), path_override.to_string())),
        }
        // CreateProcess expects a caller-provided environment block to use
        // Windows' case-insensitive alphabetical ordering.
        entries.sort_by_key(|(key, _)| key.to_lowercase());
        let mut block: Vec<u16> = Vec::new();
        for (k, v) in entries {
            block.extend(format!("{k}={v}\0").encode_utf16());
        }
        block.push(0); // second, block-terminating NUL
        block
    }

    pub async fn start(app: AppHandle, state: State<'_, ClaudeLoginState>) -> Result<(), String> {
        {
            let mut guard = state.0.lock().map_err(|e| e.to_string())?;
            if let Some(old_pid) = guard.take() {
                kill_pid(old_pid);
            }
        }

        let path_env = paths::augmented_path_env();
        let path_str = path_env.to_string_lossy().into_owned();
        let mut env_block = build_environment_block(&path_str);
        // Keep cmd.exe (and therefore the console buffer) alive after Claude
        // exits. With /C, Claude could print the token and tear down the
        // console between two polls, making a successful sign-in look like a
        // failure. The poller kills this hidden /K shell once it has captured
        // and verified the token, or on cancel/timeout.
        let mut cmdline = to_wide("cmd.exe /D /K claude setup-token");

        let mut si = STARTUPINFOW::default();
        si.cb = std::mem::size_of::<STARTUPINFOW>() as u32;
        si.dwFlags = STARTF_USESHOWWINDOW;
        si.wShowWindow = SW_HIDE.0 as u16;
        let mut pi = PROCESS_INFORMATION::default();

        unsafe {
            CreateProcessW(
                PCWSTR::null(),
                Some(PWSTR(cmdline.as_mut_ptr())),
                None,
                None,
                false,
                CREATE_NEW_CONSOLE | CREATE_UNICODE_ENVIRONMENT,
                Some(env_block.as_mut_ptr().cast()),
                PCWSTR::null(),
                &si,
                &mut pi,
            )
            .map_err(|e| format!("Couldn't start Claude Code sign-in: {e}"))?;
        }

        let pid = pi.dwProcessId;
        *state.0.lock().map_err(|e| e.to_string())? = Some(pid);
        unsafe {
            let _ = CloseHandle(pi.hProcess);
            let _ = CloseHandle(pi.hThread);
        }

        tokio::spawn(poll_loop(app, pid));
        Ok(())
    }

    async fn poll_loop(app: AppHandle, pid: u32) {
        let deadline = tokio::time::Instant::now() + TIMEOUT;
        let mut url_sent = false;
        let mut consecutive_failures = 0u32;
        let mut url_candidate: Option<(String, u8)> = None;
        let mut token_candidate: Option<(String, u8)> = None;

        loop {
            // Cancellation and a newer login attempt both retire this poller.
            // Returning silently is important: an error from an obsolete PID
            // must not be delivered to the next attempt's event listener.
            if !is_current(&app, pid) {
                return;
            }

            if tokio::time::Instant::now() >= deadline {
                kill_pid(pid);
                if finish_if_current(&app, pid) {
                    emit_error(&app, "Signing in took too long (over 3 minutes) and was cancelled. Try again, or use a terminal instead.");
                }
                return;
            }

            match read_console_text(pid) {
                Ok(text) => {
                    consecutive_failures = 0;

                    if !url_sent {
                        let observed = URL_RE.find(&text).map(|m| m.as_str().to_string());
                        if let Some(url) = observe_stable(&mut url_candidate, observed) {
                            url_sent = true;
                            if is_current(&app, pid) {
                                let _ = app.emit("claude-login", ClaudeLoginEvent::Url { url });
                            }
                        }
                    }

                    // A console snapshot can land in the middle of a write.
                    // Do not accept the first `sk-ant-...` prefix we see;
                    // require the exact candidate to remain unchanged across
                    // consecutive polls before stopping Claude and verifying.
                    let observed = TOKEN_RE.find(&text).map(|m| m.as_str().to_string());
                    if let Some(token) = observe_stable(&mut token_candidate, observed) {
                        kill_pid(pid);
                        let result = verify_token(&token).await;
                        if !finish_if_current(&app, pid) {
                            return;
                        }
                        match result {
                            Ok(()) => {
                                let _ = app.emit("claude-login", ClaudeLoginEvent::Done { token });
                            }
                            Err(message) => {
                                let _ = app.emit("claude-login", ClaudeLoginEvent::Error { message });
                            }
                        }
                        return;
                    }
                }
                Err(_) => {
                    consecutive_failures += 1;
                    // A couple of transient failures can happen right around
                    // process start; only treat it as "the process is gone"
                    // once that's persisted for a bit.
                    if consecutive_failures >= 3 {
                        if finish_if_current(&app, pid) {
                            emit_error(&app, "Sign-in closed before finishing. Try again, or use a terminal instead.");
                        }
                        return;
                    }
                }
            }

            tokio::time::sleep(POLL_INTERVAL).await;
        }
    }

    /// Returns whether `pid` still owns the active login attempt.
    fn is_current(app: &AppHandle, pid: u32) -> bool {
        let state = app.state::<ClaudeLoginState>();
        let current = state
            .0
            .lock()
            .map(|guard| *guard == Some(pid))
            .unwrap_or(false);
        current
    }

    /// Marks `pid` finished only if it still owns the active attempt. The
    /// boolean lets obsolete pollers suppress their events.
    fn finish_if_current(app: &AppHandle, pid: u32) -> bool {
        let state = app.state::<ClaudeLoginState>();
        if let Ok(mut guard) = state.0.lock() {
            if *guard == Some(pid) {
                *guard = None;
                return true;
            }
        }
        false
    }

    /// Returns a value only after the exact same observation has appeared in
    /// enough consecutive console snapshots. This prevents a mid-write token
    /// prefix from being mistaken for the completed credential.
    fn observe_stable(
        candidate: &mut Option<(String, u8)>,
        observed: Option<String>,
    ) -> Option<String> {
        let Some(observed) = observed else {
            *candidate = None;
            return None;
        };

        if let Some((value, count)) = candidate.as_mut() {
            if *value == observed {
                *count = (*count).saturating_add(1);
                if *count >= STABLE_POLLS_REQUIRED {
                    return Some(value.clone());
                }
                return None;
            }
        }

        *candidate = Some((observed, 1));
        None
    }

    fn emit_error(app: &AppHandle, message: &str) {
        let _ = app.emit("claude-login", ClaudeLoginEvent::Error { message: message.to_string() });
    }

    /// Borrows `pid`'s console just long enough to copy its visible text,
    /// via the standard "attach to another process's console" trick:
    /// `AttachConsole` + an explicit `CONOUT$` handle (needed because this
    /// process's own `STD_OUTPUT_HANDLE` may already point somewhere else -
    /// notably, always the case when launched from Claude Code's own Bash
    /// tool during development). Never touches the child's input or output
    /// streams - purely a passive read of what's already on screen.
    fn read_console_text(pid: u32) -> windows::core::Result<String> {
        unsafe {
            let _ = FreeConsole();
            AttachConsole(pid)?;
            let result = (|| -> windows::core::Result<String> {
                let conout = to_wide("CONOUT$");
                let handle: HANDLE = CreateFileW(
                    PCWSTR(conout.as_ptr()),
                    (GENERIC_READ | GENERIC_WRITE).0,
                    FILE_SHARE_READ | FILE_SHARE_WRITE,
                    None,
                    OPEN_EXISTING,
                    Default::default(),
                    None,
                )?;
                let mut info = CONSOLE_SCREEN_BUFFER_INFO::default();
                GetConsoleScreenBufferInfo(handle, &mut info)?;
                let width = info.dwSize.X.max(1) as u32;
                let height = (info.dwCursorPosition.Y + 1).max(1) as u32;
                let mut buf = vec![0u16; (width * height) as usize];
                let mut read: u32 = 0;
                ReadConsoleOutputCharacterW(handle, &mut buf, COORD { X: 0, Y: 0 }, &mut read)?;
                let text = String::from_utf16_lossy(&buf[..read as usize]);
                let _ = CloseHandle(handle);
                Ok(text)
            })();
            let _ = FreeConsole();
            let _ = AttachConsole(ATTACH_PARENT_PROCESS);
            result
        }
    }

    #[cfg(test)]
    mod tests {
        use super::observe_stable;

        #[test]
        fn token_must_be_unchanged_across_consecutive_polls() {
            let mut candidate = None;

            assert_eq!(observe_stable(&mut candidate, Some("sk-ant-oat01-part".into())), None);
            assert_eq!(observe_stable(&mut candidate, Some("sk-ant-oat01-partial".into())), None);
            assert_eq!(
                observe_stable(&mut candidate, Some("sk-ant-oat01-partial".into())),
                Some("sk-ant-oat01-partial".into())
            );
        }
    }
}
