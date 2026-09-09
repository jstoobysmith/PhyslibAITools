mod commands;
mod config;
mod paths;
mod process;

use serde::Serialize;

/// Snapshot of which required tools are already on PATH (or in one of our
/// known extra install locations) - drives onboarding's "already done"
/// skip logic and the environment-setup step's checklist.
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct ToolStatus {
    git: bool,
    gh: bool,
    lake: bool,
    uv: bool,
    claude: bool,
    claude_signed_in: bool,
    gh_signed_in: bool,
    git_bash: bool,
}

/// `"windows"` / `"macos"` / `"linux"` - lets the frontend skip straight to
/// the terminal-based Claude sign-in fallback on platforms where the
/// automatic (Windows-only, see `auth_claude.rs`) flow always fails, instead
/// of flashing an error first.
#[tauri::command]
fn current_platform() -> &'static str {
    std::env::consts::OS
}

#[tauri::command]
async fn detect_tools() -> ToolStatus {
    let gh_signed_in = process::run_captured("gh", &["auth", "status"], None)
        .await
        .map(|(ok, _, _)| ok)
        .unwrap_or(false);

    #[cfg(target_os = "windows")]
    let git_bash = paths::find_git_bash().is_some();
    #[cfg(not(target_os = "windows"))]
    let git_bash = true; // bash is native on macOS/Linux

    ToolStatus {
        git: paths::has_tool("git"),
        gh: paths::has_tool("gh"),
        lake: paths::has_tool("lake"),
        uv: paths::has_tool("uv") || paths::has_tool("uvx"),
        claude: paths::has_tool("claude"),
        claude_signed_in: paths::claude_credentials_exist(),
        gh_signed_in,
        git_bash,
    }
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_dialog::init())
        .manage(commands::auth_claude::ClaudeLoginState::default())
        .manage(commands::mission_agent::MissionAgentState::default())
        .manage(commands::workspace::SyncState::default())
        .invoke_handler(tauri::generate_handler![
            current_platform,
            detect_tools,
            config::load_config,
            config::save_config,
            config::installed_workspace_dir,
            commands::auth_claude::claude_status,
            commands::auth_claude::start_claude_login,
            commands::auth_claude::cancel_claude_login,
            commands::auth_claude::open_claude_login_terminal,
            commands::auth_claude::verify_claude_oauth_token,
            commands::auth_claude::claude_logout,
            commands::auth_github::github_status,
            commands::auth_github::start_github_login,
            commands::auth_github::github_logout,
            commands::setup_env::run_setup,
            commands::workspace::workspace_status,
            commands::workspace::check_workspace_health,
            commands::workspace::sync_workspace,
            commands::tasks::fetch_tasks,
            commands::run_task::start_task_run,
            commands::run_task::confirm_and_open_pr,
            commands::missions::list_missions,
            commands::missions::load_mission,
            commands::missions::save_mission,
            commands::missions::delete_mission,
            commands::missions::import_source_files,
            commands::missions::remove_source_file,
            commands::lean::materialize_lean,
            commands::lean::verify_lean,
            commands::lean::workspace_lean_env,
            commands::mission_agent::generate_graph,
            commands::mission_agent::run_prove_agent,
            commands::mission_agent::run_extend_agent,
            commands::mission_agent::cancel_mission_agent,
            commands::mission_agent::list_mission_runs,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
