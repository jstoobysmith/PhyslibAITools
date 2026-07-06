//! Task discovery. Prefers, in order:
//!   1. A local `../Tasks` next to the GUI folder (i.e. running from within a
//!      checkout of this repo) - lets GUI development iterate on task files
//!      without touching the network, and always reflects local edits.
//!   2. The live `Tasks/` listing on GitHub (via `gh api`, reusing the same
//!      `gh` login the onboarding wizard already set up - so this runs at
//!      the normal 5000/hour authenticated rate limit, not the 60/hour
//!      anonymous one), so a packaged app always shows newly-added tasks
//!      without needing a new release.
//!   3. The snapshot bundled into the app at build time, if both of the
//!      above are unavailable (offline, or the repo/API is unreachable).
//!
//! Parsing each file's `description:`/`prompt:` (YAML) or first line
//! (Markdown) happens on the frontend (see src/tasks/parseTask.ts) - this
//! command's job is just to get the raw text home reliably.

use crate::process;
use base64::{engine::general_purpose::STANDARD, Engine};
use serde::{Deserialize, Serialize};
use std::path::{Path, PathBuf};
use tauri::{AppHandle, Manager};

const OWNER: &str = "jstoobysmith";
const REPO: &str = "PhyslibAITools";

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct TaskFile {
    pub name: String,
    pub format: String, // "md" | "yaml"
    pub content: String,
    pub source: String, // "local" | "github" | "bundled"
}

fn classify(file_name: &str) -> Option<(String, &'static str)> {
    let (stem, ext) = file_name.rsplit_once('.')?;
    match ext {
        "md" => Some((stem.to_string(), "md")),
        "yaml" | "yml" => Some((stem.to_string(), "yaml")),
        _ => None,
    }
}

fn read_tasks_dir(dir: &Path, source: &'static str) -> Vec<TaskFile> {
    let mut out = Vec::new();
    let Ok(entries) = std::fs::read_dir(dir) else { return out };
    for entry in entries.flatten() {
        let path = entry.path();
        let Some(file_name) = path.file_name().and_then(|n| n.to_str()) else { continue };
        let Some((name, format)) = classify(file_name) else { continue };
        let Ok(content) = std::fs::read_to_string(&path) else { continue };
        out.push(TaskFile { name, format: format.to_string(), content, source: source.to_string() });
    }
    out.sort_by(|a, b| a.name.cmp(&b.name));
    out
}

/// A `Tasks/` directory next to this checkout, if the GUI is being run from
/// inside a clone of `PhyslibAITools` (dev mode, or a power user's checkout).
fn local_tasks_dir() -> Option<PathBuf> {
    let mut candidates = Vec::new();
    if let Ok(cwd) = std::env::current_dir() {
        candidates.push(cwd.join("..").join("Tasks"));
        candidates.push(cwd.join("Tasks"));
    }
    if let Ok(exe) = std::env::current_exe() {
        if let Some(dir) = exe.parent() {
            candidates.push(dir.join("Tasks"));
        }
    }
    candidates.into_iter().find(|p| p.is_dir())
}

#[derive(Deserialize)]
struct GhContentEntry {
    name: String,
    #[serde(rename = "type")]
    kind: String,
}

async fn fetch_github_tasks() -> Result<Vec<TaskFile>, String> {
    let list_path = format!("repos/{OWNER}/{REPO}/contents/Tasks");
    let (ok, stdout, stderr) = process::run_captured("gh", &["api", &list_path], None)
        .await
        .map_err(|e| e.to_string())?;
    if !ok {
        return Err(format!("Couldn't list tasks from GitHub: {}", stderr.trim()));
    }
    let entries: Vec<GhContentEntry> = serde_json::from_str(&stdout).map_err(|e| e.to_string())?;

    let mut out = Vec::new();
    for entry in entries {
        if entry.kind != "file" {
            continue;
        }
        let Some((name, format)) = classify(&entry.name) else { continue };
        let file_path = format!("repos/{OWNER}/{REPO}/contents/Tasks/{}", entry.name);
        let Ok((ok, stdout, _)) =
            process::run_captured("gh", &["api", &file_path, "--jq", ".content"], None).await
        else {
            continue;
        };
        if !ok {
            continue;
        }
        let cleaned: String = stdout.chars().filter(|c| !c.is_whitespace()).collect();
        let Ok(bytes) = STANDARD.decode(cleaned) else { continue };
        let Ok(content) = String::from_utf8(bytes) else { continue };
        out.push(TaskFile { name, format: format.to_string(), content, source: "github".to_string() });
    }
    out.sort_by(|a, b| a.name.cmp(&b.name));
    Ok(out)
}

fn read_bundled_tasks(app: &AppHandle) -> Vec<TaskFile> {
    match app.path().resource_dir() {
        Ok(dir) => read_tasks_dir(&dir.join("resources").join("tasks-snapshot"), "bundled")
            .into_iter()
            .chain(read_tasks_dir(&dir.join("tasks-snapshot"), "bundled"))
            .collect(),
        Err(_) => Vec::new(),
    }
}

#[tauri::command]
pub async fn fetch_tasks(app: AppHandle) -> Result<Vec<TaskFile>, String> {
    if let Some(dir) = local_tasks_dir() {
        let local = read_tasks_dir(&dir, "local");
        if !local.is_empty() {
            return Ok(local);
        }
    }

    match fetch_github_tasks().await {
        Ok(tasks) if !tasks.is_empty() => Ok(tasks),
        _ => {
            let bundled = read_bundled_tasks(&app);
            if bundled.is_empty() {
                Err("Couldn't reach GitHub to list tasks, and no offline copy was bundled with this app.".into())
            } else {
                Ok(bundled)
            }
        }
    }
}
