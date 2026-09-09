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

/// Writes a mission's record to a path the user chose. The document is read
/// back from disk rather than taken from the caller, so an export is always of
/// what is actually saved - never of unsaved UI state that might differ.
#[tauri::command]
pub fn export_mission(app: AppHandle, mission_id: String, dest_path: String) -> Result<(), String> {
    let path = mission_file(&app, &mission_id)?;
    let text = std::fs::read_to_string(&path).map_err(|e| format!("Couldn't read that mission: {e}"))?;
    // Reserialized rather than copied so the export is pretty-printed and
    // provably valid JSON, not whatever happens to be on disk.
    let doc: serde_json::Value =
        serde_json::from_str(&text).map_err(|e| format!("That mission's file is corrupt: {e}"))?;
    let pretty = serde_json::to_string_pretty(&doc).map_err(|e| e.to_string())?;
    std::fs::write(&dest_path, pretty).map_err(|e| format!("Couldn't write {dest_path}: {e}"))
}

#[derive(Serialize, Debug)]
#[serde(rename_all = "camelCase")]
pub struct ImportedMission {
    pub doc: serde_json::Value,
    /// Labels of file sources whose path no longer resolves. A mission
    /// exported from another machine (or after its folder was cleared) carries
    /// absolute paths into a `sources/` directory that isn't there any more;
    /// the graph is still perfectly good, so these are reported rather than
    /// treated as a failure.
    pub missing_files: Vec<String>,
}

/// Reads a mission document from an arbitrary path for import. Only checks
/// that it is JSON and mission-shaped - what to do about stale verification
/// results and unresolvable sources is decided by the caller, which knows the
/// current workspace environment.
#[tauri::command]
pub fn read_mission_file(path: String) -> Result<ImportedMission, String> {
    const MAX_BYTES: u64 = 64 * 1024 * 1024;
    let size = std::fs::metadata(&path).map(|m| m.len()).unwrap_or(0);
    if size > MAX_BYTES {
        return Err("That file is far too large to be a mission.".into());
    }
    let text = std::fs::read_to_string(&path).map_err(|e| format!("Couldn't read that file: {e}"))?;
    let doc: serde_json::Value = serde_json::from_str(&text).map_err(|e| format!("That isn't valid JSON: {e}"))?;

    let has = |k: &str| doc.get(k).is_some();
    if !doc.is_object() || !has("title") || !doc.get("nodes").map(|n| n.is_array()).unwrap_or(false) {
        return Err("That JSON doesn't look like a mission - it needs at least a `title` and a `nodes` array.".into());
    }

    let mut missing_files = Vec::new();
    if let Some(sources) = doc.get("sources").and_then(|s| s.as_array()) {
        for source in sources {
            if source.get("kind").and_then(|k| k.as_str()) != Some("file") {
                continue;
            }
            let path = source.get("path").and_then(|p| p.as_str()).unwrap_or("");
            if path.is_empty() || !Path::new(path).is_file() {
                missing_files
                    .push(source.get("label").and_then(|l| l.as_str()).unwrap_or(path).to_string());
            }
        }
    }
    Ok(ImportedMission { doc, missing_files })
}

pub fn now_millis() -> u128 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis())
        .unwrap_or(0)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn write(dir: &std::path::Path, name: &str, body: &str) -> String {
        let p = dir.join(name);
        std::fs::write(&p, body).unwrap();
        p.to_string_lossy().into_owned()
    }

    #[test]
    fn rejects_json_that_is_not_a_mission() {
        let dir = std::env::temp_dir().join(format!("p2m-test-{}", now_millis()));
        std::fs::create_dir_all(&dir).unwrap();

        let not_json = write(&dir, "a.json", "{ this is not json");
        assert!(read_mission_file(not_json).unwrap_err().contains("valid JSON"));

        // Valid JSON, but a different kind of document entirely.
        let wrong_shape = write(&dir, "b.json", r#"{"hello":"world"}"#);
        assert!(read_mission_file(wrong_shape).unwrap_err().contains("look like a mission"));

        // `nodes` present but not an array.
        let bad_nodes = write(&dir, "c.json", r#"{"title":"X","nodes":42}"#);
        assert!(read_mission_file(bad_nodes).is_err());

        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn reports_file_sources_that_no_longer_resolve() {
        let dir = std::env::temp_dir().join(format!("p2m-test-{}", now_millis() + 1));
        std::fs::create_dir_all(&dir).unwrap();
        let real = write(&dir, "paper.pdf", "%PDF-");

        let doc = format!(
            r#"{{"title":"M","nodes":[],"sources":[
                 {{"kind":"file","label":"here.pdf","path":"{real}"}},
                 {{"kind":"file","label":"gone.pdf","path":"/nope/gone.pdf"}},
                 {{"kind":"link","label":"arxiv","url":"https://arxiv.org/abs/1"}}
               ]}}"#
        );
        let path = write(&dir, "m.json", &doc);
        let imported = read_mission_file(path).unwrap();

        // Only the unresolvable *file* is reported; links are never checked,
        // and a present file is not a problem.
        assert_eq!(imported.missing_files, vec!["gone.pdf".to_string()]);
        let _ = std::fs::remove_dir_all(&dir);
    }
}
