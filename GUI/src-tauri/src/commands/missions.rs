//! Storage for the mission workbench - the Prove2Me-style decomposition-graph
//! side of the app. Completely independent of the task/PR flow: a mission
//! never touches GitHub, never branches Physlib, and produces nothing outside
//! its own folder.
//!
//! Two locations are involved, deliberately:
//!
//!  * **The mission record** (`mission.json` plus any uploaded papers) lives
//!    in the OS app-config dir, next to `config.json`. That's the durable
//!    source of truth - it survives the Physlib workspace being deleted,
//!    re-cloned or moved by `setup_env`.
//!  * **The Lean scratch tree** lives *inside* the Physlib checkout, under
//!    `.p2m/<missionId>/`. It has to: `lake env lean -o` refuses to write an
//!    olean for an input file outside the lake project root, and putting the
//!    files there is also what lets a node `import Mathlib...` /
//!    `import Physlib...` resolve against the already-built workspace. It is
//!    pure derived state - everything in it is regenerated from
//!    `mission.json` on demand (see `lean.rs`), so losing it costs only
//!    recompilation.
//!
//! Unlike every other cross-boundary struct in this app, the mission document
//! itself is handled as an opaque `serde_json::Value` rather than a mirrored
//! Rust struct. The schema is large, still moving, and owned by the frontend
//! (`src/missions/missionTypes.ts`); duplicating it here would double the
//! hand-sync burden the README already warns about, for no benefit - nothing
//! in Rust needs to understand a node beyond the handful of fields `lean.rs`
//! is handed explicitly.

use serde::{Deserialize, Serialize};
use std::path::{Path, PathBuf};
use tauri::{AppHandle, Manager};

/// Everything a mission's Lean scratch tree needs, resolved once.
pub struct MissionPaths {
    /// `<app-config>/missions/<id>` - the durable record.
    pub record_dir: PathBuf,
    /// `<app-config>/missions/<id>/sources` - the files the user attached.
    pub source_files_dir: PathBuf,
}

pub fn missions_root(app: &AppHandle) -> Result<PathBuf, String> {
    let dir = app.path().app_config_dir().map_err(|e| e.to_string())?.join("missions");
    std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    Ok(dir)
}

pub fn mission_paths(app: &AppHandle, mission_id: &str) -> Result<MissionPaths, String> {
    let id = sanitize_id(mission_id)?;
    let record_dir = missions_root(app)?.join(&id);
    let source_files_dir = record_dir.join("sources");
    Ok(MissionPaths { record_dir, source_files_dir })
}

/// Mission ids come from the frontend and are used as a path segment, so
/// they're validated rather than trusted: lowercase alphanumerics, `-` and
/// `_` only. Rejects `..`, separators and anything else that could escape the
/// missions folder.
pub fn sanitize_id(id: &str) -> Result<String, String> {
    let ok = !id.is_empty()
        && id.len() <= 128
        && id.chars().all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_');
    if ok {
        Ok(id.to_string())
    } else {
        Err(format!("Invalid mission id: {id:?}"))
    }
}

fn mission_file(app: &AppHandle, mission_id: &str) -> Result<PathBuf, String> {
    Ok(mission_paths(app, mission_id)?.record_dir.join("mission.json"))
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MissionSummary {
    pub id: String,
    pub title: String,
    pub problem: String,
    pub open_problem: bool,
    pub node_count: usize,
    pub proved_count: usize,
    pub updated_at: String,
}

/// Lists every mission on disk, newest-updated first. A mission folder whose
/// `mission.json` is missing or unparseable is skipped rather than failing
/// the whole listing - one corrupt record shouldn't hide the rest.
#[tauri::command]
pub fn list_missions(app: AppHandle) -> Result<Vec<MissionSummary>, String> {
    let root = missions_root(&app)?;
    let mut out = Vec::new();
    let Ok(entries) = std::fs::read_dir(&root) else { return Ok(out) };
    for entry in entries.flatten() {
        if !entry.path().is_dir() {
            continue;
        }
        let Ok(text) = std::fs::read_to_string(entry.path().join("mission.json")) else { continue };
        let Ok(doc) = serde_json::from_str::<serde_json::Value>(&text) else { continue };
        let str_field = |k: &str| doc.get(k).and_then(|v| v.as_str()).unwrap_or("").to_string();
        let nodes = doc.get("nodes").and_then(|v| v.as_array()).map(|a| a.as_slice()).unwrap_or(&[]);
        out.push(MissionSummary {
            id: str_field("id"),
            title: str_field("title"),
            problem: str_field("problem"),
            open_problem: doc.get("openProblem").and_then(|v| v.as_bool()).unwrap_or(false),
            node_count: nodes.len(),
            proved_count: nodes
                .iter()
                .filter(|n| n.get("status").and_then(|s| s.as_str()) == Some("proved"))
                .count(),
            updated_at: str_field("updatedAt"),
        });
    }
    out.sort_by(|a, b| b.updated_at.cmp(&a.updated_at));
    Ok(out)
}

#[tauri::command]
pub fn load_mission(app: AppHandle, mission_id: String) -> Result<serde_json::Value, String> {
    let path = mission_file(&app, &mission_id)?;
    let text = std::fs::read_to_string(&path).map_err(|e| format!("Couldn't read that mission: {e}"))?;
    serde_json::from_str(&text).map_err(|e| format!("That mission's file is corrupt: {e}"))
}

/// Writes the mission document. Written to a sibling temp file and renamed so
/// a crash mid-write can't leave a half-serialized `mission.json` behind -
/// this file is the only record of a graph that may have taken an agent (and
/// a lot of tokens) a long while to produce.
#[tauri::command]
pub fn save_mission(app: AppHandle, mission: serde_json::Value) -> Result<(), String> {
    let id = mission
        .get("id")
        .and_then(|v| v.as_str())
        .ok_or_else(|| "That mission has no id.".to_string())?
        .to_string();
    let paths = mission_paths(&app, &id)?;
    std::fs::create_dir_all(&paths.record_dir).map_err(|e| e.to_string())?;
    let final_path = paths.record_dir.join("mission.json");
    let tmp_path = paths.record_dir.join("mission.json.tmp");
    let text = serde_json::to_string_pretty(&mission).map_err(|e| e.to_string())?;
    std::fs::write(&tmp_path, text).map_err(|e| e.to_string())?;
    std::fs::rename(&tmp_path, &final_path).map_err(|e| e.to_string())
}

#[tauri::command]
pub fn delete_mission(app: AppHandle, mission_id: String, workspace_dir: Option<String>) -> Result<(), String> {
    let paths = mission_paths(&app, &mission_id)?;
    if paths.record_dir.exists() {
        std::fs::remove_dir_all(&paths.record_dir).map_err(|e| e.to_string())?;
    }
    // The Lean scratch tree is derived state, but it's also the bulkiest part
    // of a mission (oleans), so clear it too rather than orphaning it inside
    // the user's Physlib checkout.
    if let Some(ws) = workspace_dir {
        let scratch = super::lean::scratch_dir(&PathBuf::from(ws), &mission_id)?;
        if scratch.exists() {
            let _ = std::fs::remove_dir_all(&scratch);
        }
    }
    Ok(())
}

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct FileSourceRef {
    pub id: String,
    pub filename: String,
    /// Absolute path inside the mission's `papers/` folder. Handed to the
    /// agent verbatim so it can read the file itself (Claude Code reads PDFs
    /// natively), which is why papers are copied in rather than referenced
    /// where the user happened to leave them.
    pub path: String,
    pub file_kind: String,
    pub bytes: u64,
}

fn file_kind(name: &str) -> &'static str {
    match name.rsplit('.').next().map(|e| e.to_ascii_lowercase()).as_deref() {
        Some("pdf") => "pdf",
        Some("tex") | Some("latex") => "tex",
        Some("md") | Some("markdown") | Some("txt") => "text",
        Some("bib") => "bib",
        _ => "other",
    }
}

/// Copies the user's chosen files into the mission folder. Name collisions get
/// a numeric suffix rather than silently overwriting an earlier upload.
#[tauri::command]
pub fn import_source_files(
    app: AppHandle,
    mission_id: String,
    paths: Vec<String>,
) -> Result<Vec<FileSourceRef>, String> {
    let mission = mission_paths(&app, &mission_id)?;
    std::fs::create_dir_all(&mission.source_files_dir).map_err(|e| e.to_string())?;

    let mut out = Vec::new();
    for (i, src) in paths.iter().enumerate() {
        let src_path = Path::new(src);
        let stem = src_path.file_stem().map(|s| s.to_string_lossy().into_owned()).unwrap_or_else(|| "paper".into());
        let ext = src_path.file_name().and_then(|n| n.to_str()).and_then(|n| n.rsplit_once('.')).map(|(_, e)| e.to_string());

        let mut filename = src_path.file_name().map(|n| n.to_string_lossy().into_owned()).unwrap_or_else(|| format!("paper-{i}"));
        let mut dest = mission.source_files_dir.join(&filename);
        let mut n = 2;
        while dest.exists() {
            filename = match &ext {
                Some(e) => format!("{stem}-{n}.{e}"),
                None => format!("{stem}-{n}"),
            };
            dest = mission.source_files_dir.join(&filename);
            n += 1;
        }

        std::fs::copy(src_path, &dest).map_err(|e| format!("Couldn't copy {filename}: {e}"))?;
        let bytes = std::fs::metadata(&dest).map(|m| m.len()).unwrap_or(0);
        out.push(FileSourceRef {
            id: format!("src-{}-{}", now_millis(), i),
            file_kind: file_kind(&filename).to_string(),
            path: dest.to_string_lossy().into_owned(),
            filename,
            bytes,
        });
    }
    Ok(out)
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RemoveSourceFileRequest {
    pub mission_id: String,
    pub path: String,
}

/// Deletes an uploaded file. Refuses any path that isn't actually inside this
/// mission's `sources/` folder, so a malformed (or agent-supplied) mission
/// document can't turn this into an arbitrary-file delete.
#[tauri::command]
pub fn remove_source_file(app: AppHandle, req: RemoveSourceFileRequest) -> Result<(), String> {
    let mission = mission_paths(&app, &req.mission_id)?;
    let target = PathBuf::from(&req.path);
    let (Ok(canon_target), Ok(canon_sources)) = (target.canonicalize(), mission.source_files_dir.canonicalize()) else {
        return Err("That file is no longer where the mission expects it.".into());
    };
    if !canon_target.starts_with(&canon_sources) {
        return Err("Refusing to delete a file outside this mission's sources folder.".into());
    }
    std::fs::remove_file(&canon_target).map_err(|e| e.to_string())
}

pub fn now_millis() -> u128 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis())
        .unwrap_or(0)
}
