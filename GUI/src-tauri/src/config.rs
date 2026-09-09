//! Small JSON config store in the OS app-data directory (never inside the
//! repo/workspace). Holds everything the GUI needs to remember between runs:
//! the workspace folder location, which setup steps are done, and a couple
//! of preferences.
//!
//! Every field here is camelCase on the JSON/JS side
//! (`#[serde(rename_all = "camelCase")]`) - matching normal TypeScript
//! convention - while staying idiomatic snake_case on the Rust side. This is
//! applied consistently across every struct that crosses the JS boundary
//! (see the other `commands/*.rs` modules); mixing conventions between them
//! was the root cause of a "missing field" bug in the task-run command.

use serde::{Deserialize, Serialize};
use std::path::{Path, PathBuf};
use tauri::{AppHandle, Manager};

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct OnboardingFlags {
    #[serde(default)]
    pub claude_done: bool,
    #[serde(default)]
    pub github_done: bool,
    #[serde(default)]
    pub env_done: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AppConfig {
    #[serde(default)]
    pub workspace_dir: Option<String>,
    #[serde(default)]
    pub onboarding: OnboardingFlags,
    #[serde(default = "default_max_open_auto_prs")]
    pub max_open_auto_prs: u32,
    #[serde(default)]
    pub last_task: Option<String>,
    /// `claude setup-token` deliberately doesn't save this anywhere itself
    /// (see auth_claude.rs) - we hold it and pass it as
    /// `CLAUDE_CODE_OAUTH_TOKEN` to every `claude` invocation. Stored here as
    /// a documented, deliberate fallback (see GUI/README.md) - OS-keychain
    /// storage is a reasonable follow-up, not required for v1.
    #[serde(default)]
    pub claude_oauth_token: Option<String>,
    /// `--model` value new missions start with (see the mission workbench).
    /// `None` means "whatever Claude Code is configured with"; the field is
    /// absent in configs written before missions existed, hence `default`.
    #[serde(default)]
    pub default_mission_model: Option<String>,
}

fn default_max_open_auto_prs() -> u32 {
    10
}

impl Default for AppConfig {
    fn default() -> Self {
        Self {
            workspace_dir: None,
            onboarding: OnboardingFlags::default(),
            max_open_auto_prs: default_max_open_auto_prs(),
            last_task: None,
            claude_oauth_token: None,
            default_mission_model: Some("claude-opus-5".into()),
        }
    }
}

fn config_path(app: &AppHandle) -> Result<PathBuf, String> {
    let dir = app.path().app_config_dir().map_err(|e| e.to_string())?;
    std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    Ok(dir.join("config.json"))
}

#[tauri::command]
pub fn load_config(app: AppHandle) -> Result<AppConfig, String> {
    let path = config_path(&app)?;
    if !path.exists() {
        return Ok(AppConfig::default());
    }
    let text = std::fs::read_to_string(&path).map_err(|e| e.to_string())?;
    serde_json::from_str(&text).map_err(|e| e.to_string())
}

#[tauri::command]
pub fn save_config(app: AppHandle, config: AppConfig) -> Result<(), String> {
    let path = config_path(&app)?;
    let text = serde_json::to_string_pretty(&config).map_err(|e| e.to_string())?;
    std::fs::write(&path, text).map_err(|e| e.to_string())
}

/// True if we can actually create files in `dir` - used to decide whether an
/// install-adjacent folder is usable, or whether it's e.g. a
/// permissions-locked `Program Files` install that needs the fallback below.
fn is_writable(dir: &Path) -> bool {
    let probe = dir.join(".physlib-gui-write-test");
    match std::fs::File::create(&probe) {
        Ok(_) => {
            let _ = std::fs::remove_file(&probe);
            true
        }
        Err(_) => false,
    }
}

/// Where the Physlib workspace lives - never asked of the user. Prefers a
/// `Physlib` folder right next to the installed app (so everything the app
/// manages stays in one obvious place), falling back to the OS's per-user
/// app-data directory if that location isn't writable (e.g. a per-machine
/// install under `Program Files` without elevation).
///
/// **Except on macOS**, where "next to the executable" means *inside*
/// `PhyslibAITools.app/Contents/MacOS`. A macOS app update replaces the whole
/// bundle, which would silently take the workspace with it - and this is not a
/// small thing to lose: a real one measured 11 GB, and re-creating it means a
/// fresh clone plus a full Mathlib fetch and build. The per-user app-data
/// directory survives app updates, so that is used unconditionally there.
///
/// Only affects setups that have not chosen a location yet; an existing
/// `workspace_dir` in the config is always honoured.
#[tauri::command]
pub fn installed_workspace_dir(app: AppHandle) -> Result<String, String> {
    if !cfg!(target_os = "macos") {
        if let Ok(exe) = std::env::current_exe() {
            if let Some(dir) = exe.parent() {
                if is_writable(dir) {
                    return Ok(dir.join("Physlib").to_string_lossy().into_owned());
                }
            }
        }
    }
    let data_dir = app.path().app_local_data_dir().map_err(|e| e.to_string())?;
    Ok(data_dir.join("Physlib").to_string_lossy().into_owned())
}
