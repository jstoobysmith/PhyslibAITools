//! Real Lean verification for mission graphs, run entirely offline against
//! the Physlib checkout the app already sets up and builds.
//!
//! The trick that makes this cheap: we never add a lake target or touch the
//! lakefile. Each node is written as a standalone file under
//! `<workspace>/.p2m/<missionId>/` and typechecked with
//! `lake env lean <file>`, which hands the file the project's full
//! `LEAN_PATH` - Mathlib, Physlib and every other package - from the
//! already-warm build. A cold node importing a chunk of Mathlib takes
//! seconds, not the 10+ minutes a project build does.
//!
//! Two constraints discovered the hard way, both encoded below:
//!
//!  * `lake env lean -o <out>.olean <in>.lean` refuses an input file outside
//!    the lake project root ("must be contained in root directory"), which is
//!    why the scratch tree lives inside the checkout rather than beside the
//!    mission record.
//!  * Lean will not create the parent directory of `-o`, so every olean's
//!    folder is created first.
//!
//! Node statements compile to oleans under `.p2m/<id>/build`, and that folder
//! is put on `LEAN_PATH` for later units. That is exactly what lets a
//! proof-sketch `import Theorems.Thm_child` and be checked against a child
//! lemma that is itself still open - the Prove2Me decomposition mechanism
//! (paper §4.2), reproduced locally.

use crate::process;
use serde::{Deserialize, Serialize};
use std::path::{Path, PathBuf};
use std::process::Stdio;
use tauri::{AppHandle, Emitter};

/// Per-file ceiling. Generous, because a statement pulling in a heavy Mathlib
/// import on a cold cache legitimately takes minutes, but bounded so one
/// pathological node can't wedge a whole-graph verification forever.
const UNIT_TIMEOUT: std::time::Duration = std::time::Duration::from_secs(10 * 60);

/// Axioms Lean's standard library rests on. Anything else in a finished
/// proof's `#print axioms` means the agent introduced a new assumption, which
/// is exactly the escape hatch Prove2Me blocks (paper §3.2: a proof must have
/// "no sorry or any other new axioms").
const STANDARD_AXIOMS: [&str; 3] = ["propext", "Classical.choice", "Quot.sound"];

pub fn scratch_dir(workspace: &Path, mission_id: &str) -> Result<PathBuf, String> {
    let id = super::missions::sanitize_id(mission_id)?;
    Ok(workspace.join(".p2m").join(id))
}

/// Creates the scratch tree and keeps it out of git. The workspace is a real
/// Physlib checkout that the task flow runs `git diff --cached` against, so
/// an untracked `.p2m/` full of generated Lean would show up in - and could
/// end up committed to - somebody's pull request. `.git/info/exclude` is used
/// rather than `.gitignore` because that file belongs to upstream.
pub fn ensure_scratch(workspace: &Path, mission_id: &str) -> Result<PathBuf, String> {
    let dir = scratch_dir(workspace, mission_id)?;
    for sub in ["Theorems", "Definitions", "Solutions", "build"] {
        std::fs::create_dir_all(dir.join(sub)).map_err(|e| e.to_string())?;
    }
    let exclude = workspace.join(".git").join("info").join("exclude");
    if let Ok(text) = std::fs::read_to_string(&exclude) {
        if !text.lines().any(|l| l.trim() == ".p2m/") {
            let _ = std::fs::write(&exclude, format!("{}\n# Mission workbench scratch (regenerated on demand)\n.p2m/\n", text.trim_end()));
        }
    } else if exclude.parent().map(|p| p.is_dir()).unwrap_or(false) {
        let _ = std::fs::write(&exclude, "# Mission workbench scratch (regenerated on demand)\n.p2m/\n");
    }
    Ok(dir)
}

/// `Theorems.Thm_foo` -> `Theorems/Thm_foo`. Every segment must be a plain
/// Lean identifier; this is the only thing standing between an agent-authored
/// module name and an arbitrary path write.
fn module_to_relpath(module: &str) -> Result<PathBuf, String> {
    let mut path = PathBuf::new();
    let segments: Vec<&str> = module.split('.').collect();
    if segments.is_empty() || segments.len() > 8 {
        return Err(format!("Invalid module name: {module:?}"));
    }
    for seg in segments {
        let valid = !seg.is_empty()
            && seg.len() <= 128
            && seg.chars().next().map(|c| c.is_ascii_alphabetic() || c == '_').unwrap_or(false)
            && seg.chars().all(|c| c.is_ascii_alphanumeric() || c == '_' || c == '\'');
        if !valid {
            return Err(format!("Invalid module name: {module:?}"));
        }
        path.push(seg);
    }
    Ok(path)
}

/// One file to check. `kind` decides both what gets written where and which
/// rules the result is judged against - see `judge`.
#[derive(Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct LeanUnit {
    /// Echoed back untouched so the frontend can match results to the node or
    /// sketch they came from.
    pub id: String,
    /// Full Lean module name, e.g. `Theorems.Thm_cauchy_interlacing`.
    pub module: String,
    /// The complete file: preamble (imports) followed by the declaration.
    pub source: String,
    /// `"statement"` | `"definition"` | `"sketch"` | `"proof"`.
    pub kind: String,
}

/// The exact context a check was run in.
///
/// Prove2Me pins every result to a verification environment ("a result always
/// carries the exact context needed to reproduce it", paper §3.1) and this is
/// the offline equivalent. It matters here more than it looks: missions verify
/// *in place*, against whatever the workspace currently has checked out and
/// built - so without recording this, a green tick means "compiled against
/// some Physlib, at some point", which guarantees nothing. With it, a check
/// whose environment no longer matches the workspace can be shown as stale
/// instead of quietly believed.
#[derive(Serialize, Deserialize, Clone, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct LeanEnv {
    /// Short sha of the Physlib checkout.
    pub physlib_rev: Option<String>,
    /// The branch it was on, for the common "this was a task branch" case.
    pub physlib_branch: Option<String>,
    /// Short sha of the Mathlib package actually on disk.
    pub mathlib_rev: Option<String>,
    /// Contents of `lean-toolchain`.
    pub toolchain: Option<String>,
    /// The repo's default branch, read from the local `upstream/HEAD` ref so
    /// the frontend doesn't have to hardcode "master" to decide whether the
    /// checkout is somewhere it shouldn't be.
    pub default_branch: Option<String>,
}

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct LeanCheck {
    pub id: String,
    pub module: String,
    /// Passed every rule for its kind - not merely "the compiler exited 0".
    pub ok: bool,
    /// True if Lean reported the file's declaration as using `sorry`.
    /// *Required* of a statement, *forbidden* in a finished proof.
    pub has_sorry: bool,
    /// Whatever `#print axioms solution` reported, for proofs and sketches.
    pub axioms: Option<String>,
    /// Compiler stdout+stderr, shown verbatim in the node inspector - Lean's
    /// own errors are far more useful to the agent (and the user) than
    /// anything we could paraphrase.
    pub diagnostics: String,
    /// Set when a rule failed rather than the compiler: the one-line reason.
    pub rule_error: Option<String>,
    pub duration_ms: u64,
    /// What this result is a result *about*. Compared against the workspace's
    /// current environment to decide whether it still stands.
    pub env: LeanEnv,
}

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
struct VerifyProgress {
    /// Two missions can be verifying at once, so progress carries the mission
    /// it belongs to - without it the UI can't tell whose bar to move.
    mission_id: String,
    index: usize,
    total: usize,
    id: String,
    module: String,
    phase: &'static str,
}

/// Reads the workspace's current verification environment. Cheap enough to do
/// once per verify batch, which is also the right granularity - every unit in
/// one batch is checked against the same tree.
pub async fn read_env(workspace: &Path) -> LeanEnv {
    let short = |out: String| {
        let t = out.trim().to_string();
        if t.is_empty() { None } else { Some(t) }
    };
    let git = |args: &'static [&'static str], dir: PathBuf| async move {
        process::run_captured("git", args, Some(&dir)).await.ok().filter(|(ok, _, _)| *ok).map(|(_, out, _)| out)
    };
    LeanEnv {
        physlib_rev: git(&["rev-parse", "--short", "HEAD"], workspace.to_path_buf()).await.and_then(short),
        physlib_branch: git(&["symbolic-ref", "--short", "HEAD"], workspace.to_path_buf()).await.and_then(short),
        mathlib_rev: git(&["rev-parse", "--short", "HEAD"], workspace.join(".lake").join("packages").join("mathlib"))
            .await
            .and_then(short),
        toolchain: std::fs::read_to_string(workspace.join("lean-toolchain")).ok().map(|t| t.trim().to_string()),
        // Local ref only - no network. `upstream/HEAD` is set by the clone;
        // when it's absent this is left unset and callers fall back.
        default_branch: git(&["symbolic-ref", "--short", "refs/remotes/upstream/HEAD"], workspace.to_path_buf())
            .await
            .and_then(short)
            .and_then(|r| r.rsplit('/').next().map(str::to_string)),
    }
}

#[tauri::command]
pub async fn workspace_lean_env(workspace_dir: String) -> Result<LeanEnv, String> {
    Ok(read_env(&PathBuf::from(workspace_dir)).await)
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct VerifyRequest {
    pub workspace_dir: String,
    pub mission_id: String,
    /// Checked in the order given. The frontend sorts them topologically
    /// (definitions, then statements, then the sketches/proofs that import
    /// them) so a unit's dependencies already have oleans by the time it runs.
    pub units: Vec<LeanUnit>,
    /// Set to verify against a checkout that isn't on the default branch. Off
    /// by default and deliberately awkward - see the check in `verify_lean`.
    #[serde(default)]
    pub allow_non_default_branch: bool,
}

/// Strips `--` line comments and `/- -/` blocks so the literal-`sorry` check
/// below doesn't trip over the word appearing in prose - agents write "the
/// remaining proof, sorry-free" in comments constantly. Deliberately crude;
/// its one blind spot is a `sorry` inside a string literal, which is harmless
/// because a string can't discharge a goal.
fn strip_comments(src: &str) -> String {
    let mut out = String::with_capacity(src.len());
    let bytes: Vec<char> = src.chars().collect();
    let mut i = 0;
    let mut block_depth = 0usize;
    while i < bytes.len() {
        if block_depth == 0 && bytes[i] == '-' && bytes.get(i + 1) == Some(&'-') {
            while i < bytes.len() && bytes[i] != '\n' {
                i += 1;
            }
            continue;
        }
        if bytes[i] == '/' && bytes.get(i + 1) == Some(&'-') {
            block_depth += 1;
            i += 2;
            continue;
        }
        if block_depth > 0 && bytes[i] == '-' && bytes.get(i + 1) == Some(&'/') {
            block_depth -= 1;
            i += 2;
            continue;
        }
        if block_depth == 0 {
            out.push(bytes[i]);
        }
        i += 1;
    }
    out
}

fn contains_sorry_token(src: &str) -> bool {
    let stripped = strip_comments(src);
    stripped.split(|c: char| !(c.is_alphanumeric() || c == '_' || c == '\'')).any(|w| w == "sorry" || w == "sorryAx")
}

fn parse_axioms(diagnostics: &str) -> Option<String> {
    diagnostics
        .lines()
        .find(|l| l.contains("depends on axioms:"))
        .and_then(|l| l.split_once('[').map(|(_, rest)| rest.trim_end_matches(']').trim().to_string()))
}

/// Applies the per-kind rules to a finished compile. Kept separate from
/// running the compiler so the rules read as one list.
fn judge(kind: &str, exit_ok: bool, diagnostics: &str, source: &str) -> (bool, Option<String>) {
    let compiler_sorry_warning = diagnostics.contains("declaration uses");
    let axioms = parse_axioms(diagnostics);

    if !exit_ok {
        return (false, None); // the diagnostics already say why
    }
    match kind {
        // A statement is the audited object: it must typecheck and must be
        // left open. A statement that compiles *without* `sorry` means the
        // agent smuggled a proof into the statement field.
        "statement" => {
            if !compiler_sorry_warning {
                return (false, Some("A statement must end in `:= by sorry` and be left unproved.".into()));
            }
            (true, None)
        }
        // Definitions carry no proof obligation, and must not be left open.
        "definition" => {
            if compiler_sorry_warning {
                return (false, Some("A definition must not contain `sorry`.".into()));
            }
            (true, None)
        }
        // A sketch establishes its target *conditional on* the open lemmas it
        // imports, so inherited `sorryAx` is expected and fine. What is not
        // fine is the sketch writing `sorry` itself - that would close the
        // gap with nothing instead of decomposing it into child nodes.
        // `#print axioms` cannot tell those two apart (both surface as
        // `sorryAx`), which is why the source-token check carries this rule.
        "sketch" => {
            if contains_sorry_token(source) {
                return (
                    false,
                    Some("A proof-sketch may import open lemmas, but must not write `sorry` itself.".into()),
                );
            }
            (true, None)
        }
        // A finished proof must be sorry-free all the way down and introduce
        // no new axioms.
        "proof" => {
            if contains_sorry_token(source) {
                return (false, Some("A proof must not contain `sorry`.".into()));
            }
            match axioms {
                None => (false, Some("Couldn't read `#print axioms solution` - is the declaration named `solution`?".into())),
                Some(list) => {
                    let offenders: Vec<&str> = list
                        .split(',')
                        .map(|a| a.trim())
                        .filter(|a| !a.is_empty() && !STANDARD_AXIOMS.contains(a))
                        .collect();
                    if offenders.is_empty() {
                        (true, None)
                    } else {
                        (false, Some(format!("Proof depends on non-standard axioms: {}", offenders.join(", "))))
                    }
                }
            }
        }
        other => (false, Some(format!("Unknown unit kind {other:?}"))),
    }
}

/// Writes every unit's file into the scratch tree without compiling anything.
/// Used before an agent run so Claude opens a mission that already looks like
/// a Lean project on disk - it can read, edit and re-check the same files the
/// app checks.
#[tauri::command]
pub fn materialize_lean(workspace_dir: String, mission_id: String, units: Vec<LeanUnit>) -> Result<String, String> {
    let workspace = PathBuf::from(&workspace_dir);
    let scratch = ensure_scratch(&workspace, &mission_id)?;
    for unit in &units {
        let rel = module_to_relpath(&unit.module)?;
        let file = scratch.join(&rel).with_extension("lean");
        if let Some(parent) = file.parent() {
            std::fs::create_dir_all(parent).map_err(|e| e.to_string())?;
        }
        std::fs::write(&file, source_for(unit)).map_err(|e| e.to_string())?;
    }
    Ok(scratch.to_string_lossy().into_owned())
}

/// Proofs and sketches get `#print axioms solution` appended, which is how
/// the sorry-free / no-new-axioms rules are actually enforced. Appended at
/// check time rather than stored, so the user never sees it in the editor.
fn source_for(unit: &LeanUnit) -> String {
    let src = unit.source.trim_end();
    if unit.kind == "proof" || unit.kind == "sketch" {
        format!("{src}\n\n#print axioms solution\n")
    } else {
        format!("{src}\n")
    }
}

#[tauri::command]
pub async fn verify_lean(app: AppHandle, req: VerifyRequest) -> Result<Vec<LeanCheck>, String> {
    let workspace = PathBuf::from(&req.workspace_dir);
    if !workspace.join(".git").is_dir() {
        return Err("The Physlib workspace isn't set up yet - Lean can't verify anything without it.".into());
    }
    let scratch = ensure_scratch(&workspace, &req.mission_id)?;
    let build_dir = scratch.join("build");
    let env = read_env(&workspace).await;

    // Missions verify *in place*: `lake env lean` resolves imports against
    // whatever this checkout currently has built. That makes the checked-out
    // branch part of what a result means - a statement that compiles against a
    // months-old task branch says nothing about whether it compiles against
    // Physlib. Tasks are immune to this (every run branches off freshly
    // fetched `upstream/<default>`), which is exactly why this only guards
    // here.
    //
    // Refused rather than warned: a green tick that quietly meant "against
    // some arbitrary branch" is worse than no tick at all.
    if !req.allow_non_default_branch {
        let default = super::workspace::default_branch().await;
        match env.physlib_branch.as_deref() {
            Some(branch) if branch != default => {
                return Err(format!(
                    "The workspace is on branch `{branch}`, not `{default}`, so anything verified here would be \
                     checked against that branch's Physlib rather than the real one. Switch the checkout to \
                     `{default}` (and sync) before verifying."
                ));
            }
            None => {
                return Err(
                    "The workspace is on a detached HEAD, so there is no telling which Physlib a result would be \
                     verified against. Check out the default branch and sync first."
                        .into(),
                );
            }
            _ => {}
        }
    }

    let total = req.units.len();
    let mut results = Vec::with_capacity(total);

    for (index, unit) in req.units.iter().enumerate() {
        let _ = app.emit(
            "mission-verify:progress",
            VerifyProgress {
                mission_id: req.mission_id.clone(),
                index,
                total,
                id: unit.id.clone(),
                module: unit.module.clone(),
                phase: "checking",
            },
        );

        // A proof or sketch that never declares `solution` can't be checked
        // against its target's type at all, so say so plainly instead of
        // letting `#print axioms` fail with something cryptic.
        if (unit.kind == "proof" || unit.kind == "sketch") && !declares_solution(&unit.source) {
            results.push(LeanCheck {
                id: unit.id.clone(),
                module: unit.module.clone(),
                ok: false,
                has_sorry: false,
                axioms: None,
                diagnostics: String::new(),
                rule_error: Some("A proof must declare `theorem solution ...` with exactly the target's type.".into()),
                duration_ms: 0,
                env: env.clone(),
            });
            continue;
        }

        let rel = module_to_relpath(&unit.module)?;
        let lean_file = scratch.join(&rel).with_extension("lean");
        if let Some(parent) = lean_file.parent() {
            std::fs::create_dir_all(parent).map_err(|e| e.to_string())?;
        }
        let full_source = source_for(unit);
        std::fs::write(&lean_file, &full_source).map_err(|e| e.to_string())?;

        // Only statements and definitions become importable modules; a proof
        // is checked, not imported by anything.
        let olean = (unit.kind == "statement" || unit.kind == "definition").then(|| {
            let out = build_dir.join(&rel).with_extension("olean");
            if let Some(parent) = out.parent() {
                let _ = std::fs::create_dir_all(parent);
            }
            out
        });

        let started = std::time::Instant::now();
        let (exit_ok, diagnostics) =
            run_lean(&workspace, &build_dir, &lean_file, olean.as_deref()).await.unwrap_or_else(|e| (false, e));
        let duration_ms = started.elapsed().as_millis() as u64;

        let (ok, rule_error) = judge(&unit.kind, exit_ok, &diagnostics, &unit.source);
        results.push(LeanCheck {
            id: unit.id.clone(),
            module: unit.module.clone(),
            ok,
            has_sorry: diagnostics.contains("declaration uses"),
            axioms: parse_axioms(&diagnostics),
            diagnostics,
            rule_error,
            duration_ms,
            env: env.clone(),
        });
    }

    let _ = app.emit(
        "mission-verify:progress",
        VerifyProgress {
            mission_id: req.mission_id.clone(),
            index: total,
            total,
            id: String::new(),
            module: String::new(),
            phase: "done",
        },
    );
    Ok(results)
}

fn declares_solution(source: &str) -> bool {
    strip_comments(source)
        .lines()
        .any(|l| {
            let t = l.trim_start();
            (t.starts_with("theorem ") || t.starts_with("lemma ") || t.starts_with("def "))
                && t.split_whitespace().nth(1).map(|n| n.trim_end_matches(|c: char| !(c.is_alphanumeric() || c == '_')) == "solution").unwrap_or(false)
        })
}

/// One `lake env lean` invocation. Returns (exit-was-success, combined
/// stdout+stderr). Lean writes most diagnostics to stdout, warnings and
/// panics to stderr, and the caller wants both in the order the user would
/// see them in a terminal.
async fn run_lean(
    workspace: &Path,
    build_dir: &Path,
    lean_file: &Path,
    olean: Option<&Path>,
) -> Result<(bool, String), String> {
    let file_str = lean_file.to_string_lossy().into_owned();
    let mut args: Vec<String> = vec!["env".into(), "lean".into()];
    if let Some(out) = olean {
        args.push("-o".into());
        args.push(out.to_string_lossy().into_owned());
    }
    args.push(file_str);
    let arg_refs: Vec<&str> = args.iter().map(|s| s.as_str()).collect();

    let mut cmd = process::command("lake", &arg_refs, Some(workspace));
    // `lake env` appends the project's own LEAN_PATH to whatever it inherits,
    // so setting ours here makes the mission's already-built statements
    // importable by later units without disturbing Mathlib/Physlib lookup.
    cmd.env("LEAN_PATH", build_dir);
    cmd.stdin(Stdio::null()).stdout(Stdio::piped()).stderr(Stdio::piped());

    let child = cmd.output();
    match tokio::time::timeout(UNIT_TIMEOUT, child).await {
        Err(_) => Ok((false, format!("Timed out after {} minutes.", UNIT_TIMEOUT.as_secs() / 60))),
        Ok(Err(e)) => Err(format!("Couldn't run `lake env lean`: {e}")),
        Ok(Ok(output)) => {
            let mut text = String::from_utf8_lossy(&output.stdout).into_owned();
            let stderr = String::from_utf8_lossy(&output.stderr);
            if !stderr.trim().is_empty() {
                if !text.is_empty() && !text.ends_with('\n') {
                    text.push('\n');
                }
                text.push_str(&stderr);
            }
            Ok((output.status.success(), text))
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn module_paths_reject_traversal() {
        assert!(module_to_relpath("Theorems.Thm_foo").is_ok());
        assert!(module_to_relpath("Definitions.Def_hypercube'").is_ok());
        for bad in ["../etc/passwd", "Theorems..Thm_foo", "Theorems./foo", "", "Theorems.9lives", "Theorems.a-b"] {
            assert!(module_to_relpath(bad).is_err(), "{bad:?} should be rejected");
        }
    }

    #[test]
    fn sorry_in_a_comment_is_not_a_sorry() {
        assert!(!contains_sorry_token("-- remaining proof, sorry-free\ntheorem solution : True := trivial"));
        assert!(!contains_sorry_token("/- we could sorry this -/\ntheorem solution : True := trivial"));
        assert!(contains_sorry_token("theorem solution : True := by sorry"));
        // Substrings of longer identifiers must not trip it.
        assert!(!contains_sorry_token("theorem solution : sorrylike = 1 := rfl"));
    }

    #[test]
    fn a_statement_must_be_left_open() {
        let src = "theorem foo : True := by sorry";
        let (ok, _) = judge("statement", true, "warning: declaration uses `sorry`", src);
        assert!(ok);

        // Compiles, but with no `sorry` warning: the agent proved it in the
        // statement field instead of stating it.
        let (ok, err) = judge("statement", true, "", "theorem foo : True := trivial");
        assert!(!ok);
        assert!(err.unwrap().contains(":= by sorry"));
    }

    #[test]
    fn a_proof_must_be_sorry_free_and_axiom_clean() {
        let clean = "'solution' depends on axioms: [propext, Classical.choice, Quot.sound]";
        let (ok, _) = judge("proof", true, clean, "theorem solution : True := trivial");
        assert!(ok);

        let (ok, err) = judge("proof", true, "'solution' depends on axioms: [sorryAx]", "theorem solution : True := trivial");
        assert!(!ok);
        assert!(err.unwrap().contains("sorryAx"));

        let (ok, err) = judge("proof", true, clean, "theorem solution : True := by sorry");
        assert!(!ok);
        assert!(err.unwrap().contains("must not contain"));

        // A genuinely new axiom is the escape hatch this rule exists to block.
        let (ok, err) = judge("proof", true, "'solution' depends on axioms: [propext, myAxiom]", "theorem solution : True := trivial");
        assert!(!ok);
        assert!(err.unwrap().contains("myAxiom"));
    }

    #[test]
    fn a_sketch_may_inherit_sorry_but_not_write_one() {
        // sorryAx inherited from the open lemmas it imports: expected.
        let (ok, _) = judge("sketch", true, "'solution' depends on axioms: [sorryAx]", "import Theorems.Thm_child\ntheorem solution : True := by exact child");
        assert!(ok);

        let (ok, err) = judge("sketch", true, "'solution' depends on axioms: [sorryAx]", "theorem solution : True := by sorry");
        assert!(!ok);
        assert!(err.unwrap().contains("must not write"));
    }

    #[test]
    fn solution_declaration_is_detected() {
        assert!(declares_solution("theorem solution (n : Nat) : n = n := by rfl"));
        assert!(declares_solution("  lemma solution : True := trivial"));
        assert!(!declares_solution("theorem my_lemma : True := trivial"));
        assert!(!declares_solution("-- theorem solution : True := trivial"));
    }
}
