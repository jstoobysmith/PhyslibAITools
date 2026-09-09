//! The three agent runs behind the mission workbench: generating a
//! decomposition graph from a problem statement, proving open nodes, and
//! extending the graph toward the goal.
//!
//! All three are `claude -p` in headless stream-json mode - the same
//! mechanism `run_task.rs` uses, for the same reasons: the CLI already has
//! web research (needed for "any research the AI decides to do on its own"),
//! reads the user's PDFs natively, and can run `lake env lean` itself to
//! iterate on a statement until it compiles. A direct Messages-API call would
//! have to reimplement all three.
//!
//! The app/agent contract is a single JSON file per run. Claude is told the
//! exact path to write and the exact schema; when the process exits we read
//! that file, and an empty or missing file means "couldn't do it" rather than
//! an error - identical to how `run_task.rs` treats the PR title/body files.
//! Nothing is parsed out of the conversation itself.
//!
//! Runs are concurrent and independent. Every run carries a frontend-issued
//! `runId` which keys three things: its entry in the live-child registry (so
//! any one run can be stopped without touching the others), its Tauri event
//! prefix (`mission-run:<runId>:*`, so two feeds never interleave), and its
//! result file. Nothing here serializes runs - whether two of them are safe to
//! overlap is a question about the *files they write*, which the frontend
//! answers before it calls (see `missionRuns.ts`).
//!
//! The agent's cwd is the Physlib workspace root, not the mission folder:
//! `lake` only finds the project's lakefile from the root, so a run started
//! anywhere else can't typecheck anything (verified - from a subdirectory,
//! even `import Mathlib` fails to resolve).

use super::lean;
use crate::process;
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::path::PathBuf;
use tauri::{AppHandle, Emitter, Manager, State};
use tokio::sync::Mutex;

/// Every live agent run, keyed by its `runId`. Registered here so each run's
/// Stop button has something to kill, and so a run that finishes on its own
/// can remove itself.
#[derive(Default)]
pub struct MissionAgentState(pub Mutex<HashMap<String, tokio::process::Child>>);

/// Run ids come from the frontend and end up in an event name and a filename,
/// so they are validated rather than trusted.
fn sanitize_run_id(id: &str) -> Result<String, String> {
    let ok = !id.is_empty() && id.len() <= 64 && id.chars().all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_');
    if ok {
        Ok(id.to_string())
    } else {
        Err(format!("Invalid run id: {id:?}"))
    }
}

/// The event prefix a run's stdout, stderr and result are published under.
/// Per-run rather than per-kind, so two concurrent runs can't write into each
/// other's activity feed.
fn run_event(run_id: &str) -> String {
    format!("mission-run:{run_id}")
}

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct MissionAgentFinished {
    pub run_id: String,
    pub kind: String,
    /// The JSON the agent wrote, if it wrote any. `None` means it finished
    /// without producing a result - the frontend surfaces that as "the agent
    /// couldn't complete this", not as a crash.
    pub result: Option<serde_json::Value>,
    pub error: Option<String>,
}

/// One thing the user attached: a file copied into the mission folder, or a
/// link. Both reach the agent as a line in the same list - it reads a file
/// from disk and fetches a URL, and the prompt says which is which.
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SourceInput {
    /// `"file"` | `"link"`.
    pub kind: String,
    /// Filename, or the link's title if the user gave one.
    pub label: String,
    /// Set for files.
    #[serde(default)]
    pub path: Option<String>,
    /// Set for links.
    #[serde(default)]
    pub url: Option<String>,
    /// For files, the detected file type (`pdf`, `tex`, ...).
    #[serde(default)]
    pub file_kind: Option<String>,
    /// The user's own note about why this source matters, if they wrote one.
    #[serde(default)]
    pub note: Option<String>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GenerateGraphRequest {
    pub run_id: String,
    pub workspace_dir: String,
    pub mission_id: String,
    pub title: String,
    pub problem: String,
    pub sources: Vec<SourceInput>,
    /// A `--model` value for `claude`, or unset to use whatever model the CLI
    /// is configured with.
    #[serde(default)]
    pub model: Option<String>,
    /// What the user believes about the problem: `"open"`, `"solved"`, or
    /// `"unknown"` (the default - the agent decides from the literature).
    pub known_status: String,
    pub claude_oauth_token: Option<String>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MissionWorkRequest {
    pub run_id: String,
    #[serde(default)]
    pub model: Option<String>,
    pub workspace_dir: String,
    pub mission_id: String,
    /// The current mission document, written next to the agent so it starts
    /// from exactly what the user is looking at.
    pub mission: serde_json::Value,
    /// For `prove`: the node names the user selected. Empty means "pick from
    /// the frontier yourself".
    pub targets: Vec<String>,
    pub claude_oauth_token: Option<String>,
}

/// Every prompt carries this. The result file is read whenever the process
/// exits - including when the user stops the run - so an agent that only
/// writes at the end loses everything the moment Stop is pressed. Telling it
/// to keep the file current is what makes stopping non-destructive
/// (`stopRun` in missionRuns.ts is the other half).
const INCREMENTAL_SAVE_NOTE: &str = "SAVE AS YOU GO\n\
     Your result file is read when you exit for ANY reason - including the user pressing Stop. So do not hold \
     everything back until the end: write the file as soon as you have your first finished item, and rewrite \
     it (complete, valid JSON every time) each time you finish another. A run that is stopped halfway keeps \
     exactly what the file held at that moment, so keeping it current is what makes your work survivable. \
     Never leave it half-written or invalid.\n";

// --- shared plumbing -----------------------------------------------------

/// Renders the user's attached sources for the prompt. Files get a path to
/// read, links get a URL to fetch; both carry the user's note if they wrote
/// one, since "this is the paper the proof is from" and "this is background"
/// should not be treated alike.
fn describe_sources(sources: &[SourceInput]) -> String {
    if sources.is_empty() {
        return "The user attached no sources. Everything must come from the description above plus your own \
                research."
            .to_string();
    }
    let mut out = String::from(
        "The user attached these sources. Work through ALL of them before anything else - read each file, \
         and fetch each link (follow it to the actual paper; an abstract page is a starting point, not the \
         source):\n",
    );
    for s in sources {
        let note = s.note.as_deref().filter(|n| !n.trim().is_empty()).map(|n| format!(" - the user says: {n}")).unwrap_or_default();
        match s.kind.as_str() {
            "link" => {
                out.push_str(&format!("\x20 - LINK  {}: {}{}\n", s.label, s.url.as_deref().unwrap_or(""), note));
            }
            _ => {
                let kind = s.file_kind.as_deref().unwrap_or("file");
                out.push_str(&format!("\x20 - FILE  {} ({}): {}{}\n", s.label, kind, s.path.as_deref().unwrap_or(""), note));
            }
        }
    }
    out
}

fn agent_dir(app: &AppHandle, mission_id: &str) -> Result<PathBuf, String> {
    let dir = super::missions::mission_paths(app, mission_id)?.record_dir.join("agent");
    std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    Ok(dir)
}

/// Common preamble for every run: where things are, what may be written, and
/// the house rules for Lean statements. Kept in one place so the three
/// prompts can't drift apart on the rules that make graphs interoperable.
fn shared_context(scratch: &str, workspace: &str) -> String {
    format!(
        "You are working inside a local, offline formalization workbench modelled on Prove2Me. \
         There is no server, no account and no other user - everything happens on this machine.\n\n\
         PATHS\n\
         \x20 - Physlib workspace root (your current directory, and the only place `lake` works from): {workspace}\n\
         \x20 - Mission scratch tree: {scratch}\n\
         \x20   `Definitions/Def_<name>.lean`  - definition files, module `Definitions.Def_<name>`\n\
         \x20   `Theorems/Thm_<name>.lean`     - one open statement each, module `Theorems.Thm_<name>`\n\
         \x20   `Solutions/Sol_<name>.lean`    - proofs and proof-sketches\n\
         \x20   `build/`                       - compiled oleans (managed by the app; do not edit)\n\n\
         You may create and edit files ONLY inside the mission scratch tree and the result file you are \
         given below. The surrounding Physlib checkout is the user's own working copy - never modify, \
         stage, commit or branch anything in it.\n\n\
         HOW TO TYPECHECK (do this yourself, repeatedly - do not hand back Lean you have not run)\n\
         From the workspace root:\n\
         \x20 - a statement or definition:\n\
         \x20     LEAN_PATH={scratch}/build lake env lean -o {scratch}/build/Theorems/Thm_<name>.olean \\\n\
         \x20       {scratch}/Theorems/Thm_<name>.lean\n\
         \x20   (create the `build/Theorems` or `build/Definitions` folder first - Lean will not make it \
         for you, and `-o` fails if it is missing)\n\
         \x20 - a proof or proof-sketch:\n\
         \x20     LEAN_PATH={scratch}/build lake env lean {scratch}/Solutions/Sol_<name>.lean\n\
         On Windows PowerShell, set the variable first instead: `$env:LEAN_PATH=\"{scratch}/build\"`.\n\
         A cold file that imports a lot of Mathlib can take a couple of minutes; that is normal, wait for it.\n\n\
         THE ORIGINS\n\
         Mathlib and Physlib are the origins of this graph - the ground everything is built on. Anything \
         already in either of them is available for free: import it and use it. NEVER create a node for a \
         result that Mathlib or Physlib already has. A branch of the graph is finished when it bottoms out \
         in Mathlib/Physlib lemmas, not when it reaches an axiom. Search before you invent: use \
         `lake env lean` with `exact?`/`apply?`, grep the Mathlib source under \
         `{workspace}/.lake/packages/mathlib`, and check Physlib under `{workspace}/Physlib`.\n\n\
         RULES FOR STATEMENTS (these are what makes the graph valid - the app re-checks every one)\n\
         \x20 1. A node's `statement` is ONE declaration and must terminate in `:= by sorry`. It states the \
         result; it never proves it. A statement that compiles without `sorry` is rejected.\n\
         \x20 2. A node's `preamble` holds its imports and `open`/`variable` lines - nothing else. It may \
         import Mathlib modules, Physlib modules, and this mission's own `Definitions.Def_*` and \
         `Theorems.Thm_*` modules. Import only what the statement actually needs.\n\
         \x20 3. Every node `name` is unique across the mission, lowercase `snake_case`, a valid Lean \
         identifier, and descriptive (`cauchy_interlacing_sorted`, not `lemma_3`).\n\
         \x20 4. The statement must be self-contained: it compiles from its own preamble alone, with no \
         hidden context.\n\
         \x20 5. Do not state something vacuous or trivially true to make a branch close. A hypothesis you \
         cannot express faithfully is a reason to say so in `description`, not to weaken the statement.\n\
         \x20 6. `description` is the audited object a human will read: say in plain mathematical English \
         what the statement asserts, spell out every binder and hypothesis, and explain any modelling \
         choice you made (why this formulation, what it deliberately does not say). `latex` is the same \
         statement written as LaTeX (no `$` delimiters around the whole thing; inline math may use `$...$`).\n\n\
         RULES FOR PROOF-SKETCHES (the decomposition mechanism)\n\
         A proof-sketch is a Lean file that proves one node's statement while IMPORTING other nodes - \
         including nodes that are themselves still open. It declares `theorem solution` with exactly the \
         target's type, and must be free of `sorry` itself: every gap must be pushed into an imported \
         child node, never papered over. Each module it imports from `Theorems.` becomes a child edge of \
         the target in the graph. This is how a hard theorem is decomposed into independently provable \
         pieces.\n"
    )
}

/// Spawns one agent run and, when it exits, emits `<runEvent>:finished` with
/// whatever JSON it left in `out_file`. The child is registered under its run
/// id first, so the UI can stop this run - and only this run.
#[allow(clippy::too_many_arguments)]
async fn spawn_agent_run(
    app: AppHandle,
    state: State<'_, MissionAgentState>,
    run_id: String,
    kind: &'static str,
    prompt: String,
    cwd: PathBuf,
    out_file: PathBuf,
    token: Option<String>,
    model: Option<String>,
) -> Result<(), String> {
    // Reusing a live run's id would make its Stop button and its event stream
    // ambiguous, so it's refused rather than silently taking over.
    if state.0.lock().await.contains_key(&run_id) {
        return Err(format!("A run with id {run_id} is already going."));
    }
    let event = run_event(&run_id);
    std::fs::write(&out_file, "").map_err(|e| e.to_string())?;

    let (child, stdout_task) =
        process::spawn_claude_streaming(app.clone(), &event, &prompt, &cwd, token.as_deref(), model.as_deref())
            .map_err(|e| format!("Couldn't start Claude: {e}"))?;
    state.0.lock().await.insert(run_id.clone(), child);

    let app_handle = app.clone();
    let out_path = out_file.clone();
    tokio::spawn(async move {
        let state: State<'_, MissionAgentState> = app_handle.state();
        // Polled through the shared registry rather than awaited directly, so
        // a cancel can take the child out and kill it mid-run.
        loop {
            let mut runs = state.0.lock().await;
            let Some(child) = runs.get_mut(&run_id) else { break };
            match child.try_wait() {
                Ok(Some(_)) | Err(_) => {
                    runs.remove(&run_id);
                    break;
                }
                Ok(None) => {
                    drop(runs);
                    tokio::time::sleep(std::time::Duration::from_millis(250)).await;
                }
            }
        }
        // Let the stdout forwarder drain first, so the activity feed doesn't
        // visibly cut off before the result lands.
        let _ = stdout_task.await;

        let text = std::fs::read_to_string(&out_path).unwrap_or_default();
        let _ = std::fs::remove_file(&out_path);
        let payload = if text.trim().is_empty() {
            MissionAgentFinished { run_id: run_id.clone(), kind: kind.to_string(), result: None, error: None }
        } else {
            match serde_json::from_str::<serde_json::Value>(&text) {
                Ok(value) => {
                    MissionAgentFinished { run_id: run_id.clone(), kind: kind.to_string(), result: Some(value), error: None }
                }
                Err(e) => MissionAgentFinished {
                    run_id: run_id.clone(),
                    kind: kind.to_string(),
                    result: None,
                    error: Some(format!("The agent's result file wasn't valid JSON: {e}")),
                },
            }
        };
        let _ = app_handle.emit(&format!("{event}:finished"), payload);
    });
    Ok(())
}

/// Stops one run. A run id that isn't live is not an error - it usually means
/// the run finished between the UI rendering its Stop button and the click.
#[tauri::command]
pub async fn cancel_mission_agent(state: State<'_, MissionAgentState>, run_id: String) -> Result<(), String> {
    if let Some(mut child) = state.0.lock().await.remove(&run_id) {
        let _ = child.kill().await;
    }
    Ok(())
}

/// The run ids the backend still has processes for. The frontend reconciles
/// its own list against this on mount, so a run whose process died without
/// emitting anything can't sit there looking live forever.
#[tauri::command]
pub async fn list_mission_runs(state: State<'_, MissionAgentState>) -> Result<Vec<String>, String> {
    Ok(state.0.lock().await.keys().cloned().collect())
}

// --- 1. generate the decomposition graph ---------------------------------

#[tauri::command]
pub async fn generate_graph(
    app: AppHandle,
    state: State<'_, MissionAgentState>,
    req: GenerateGraphRequest,
) -> Result<(), String> {
    let run_id = sanitize_run_id(&req.run_id)?;
    let workspace = PathBuf::from(&req.workspace_dir);
    let scratch = lean::ensure_scratch(&workspace, &req.mission_id)?;
    // Result files are per-run so two concurrent runs on one mission can never
    // read each other's output.
    let out_file = agent_dir(&app, &req.mission_id)?.join(format!("{run_id}-graph.json"));
    let sources = describe_sources(&req.sources);

    let status_hint = match req.known_status.as_str() {
        "solved" => "The user believes this problem HAS a known solution. Verify that from the literature, \
                     then decompose that solution all the way to the goal.",
        "open" => "The user believes this problem is OPEN. Verify that from the literature.",
        _ => "The user does not know whether this problem is open or solved. Determine which from the literature.",
    };

    let prompt = format!(
        "{shared}\n\
         =========================================================\n\
         YOUR TASK: build the decomposition graph for a new mission.\n\
         =========================================================\n\n\
         MISSION TITLE: {title}\n\n\
         THE USER'S DESCRIPTION OF THE PROBLEM:\n{problem}\n\n\
         {sources}\n\n\
         {status_hint}\n\n\
         WORK IN THIS ORDER\n\
         \x20 1. Read every attached paper in full.\n\
         \x20 2. Research the problem yourself - search the web for the current state of the literature, the \
         standard proof (if there is one), the key lemmas people actually use, and any existing \
         formalization. Use what you find; cite it.\n\
         \x20 3. Decide whether the problem is SOLVED or OPEN. This decides the shape of the graph:\n\
         \x20    - SOLVED: decompose the known proof into milestone lemmas and their supporting lemmas, so \
         that the graph CONNECTS the origins to the goal theorem. Every node must be reachable from the \
         goal by following sketches/dependencies down, and every branch must bottom out in Mathlib or \
         Physlib.\n\
         \x20    - OPEN: build the graph as far as the existing literature genuinely supports - all the \
         partial results, special cases, reductions and known-necessary conditions that a proof would \
         plausibly rest on. Then STOP. Leave the space between that frontier and the goal theorem EMPTY: \
         state the goal node, but do not invent a sketch or a chain of lemmas that pretends to close it. \
         Set `openProblem` to true and use `gapNote` to explain precisely what is missing between the \
         frontier and the goal, and why the literature does not bridge it.\n\
         \x20 4. Write each definition and statement to its file and typecheck it with the commands above. \
         Iterate until it compiles. A statement you have not compiled must not appear in your output.\n\
         \x20 5. Write a proof-sketch for every node you can decompose, typecheck those too, and keep \
         going down until the leaves rest on Mathlib/Physlib.\n\
         \x20 6. Sanity-check the whole thing: the dependency relation must be a DAG (no cycles), names \
         must be unique, and the goal must be the single root.\n\n\
         {incremental}\
         THE RESULT FILE\n\
         Write ONE JSON object to this exact path, and nothing else to it: {out}\n\n\
         {{\n\
         \x20 \"openProblem\": true | false,\n\
         \x20 \"summary\": \"a few sentences on the problem, the strategy the graph encodes, and how \
         confident you are\",\n\
         \x20 \"gapNote\": \"open problems only: what stands between the frontier and the goal. Empty \
         string otherwise.\",\n\
         \x20 \"definitions\": [\n\
         \x20   {{ \"name\": \"snake_case\", \"description\": \"...\", \"latex\": \"...\", \"preamble\": \
         \"import ...\", \"statement\": \"def ... := ...\", \"source\": \"...\" | null }}\n\
         \x20 ],\n\
         \x20 \"nodes\": [\n\
         \x20   {{ \"name\": \"snake_case\",\n\
         \x20      \"kind\": \"goal\" | \"milestone\" | \"lemma\",\n\
         \x20      \"description\": \"...\", \"latex\": \"...\",\n\
         \x20      \"preamble\": \"import ...\",\n\
         \x20      \"statement\": \"theorem <name> ... := by sorry\",\n\
         \x20      \"dependsOn\": [\"other_node_name\", ...],\n\
         \x20      \"source\": \"paper/section this comes from\" | null,\n\
         \x20      \"tags\": [\"...\"] }}\n\
         \x20 ],\n\
         \x20 \"sketches\": [\n\
         \x20   {{ \"target\": \"node_name_being_proved\",\n\
         \x20      \"imports\": [\"child_node_name\", ...],\n\
         \x20      \"explanation\": \"the proof idea in plain English\",\n\
         \x20      \"body\": \"the complete Lean file: imports, then `theorem solution ... := by ...`\" }}\n\
         \x20 ],\n\
         \x20 \"references\": [ {{ \"title\": \"...\", \"url\": \"...\", \"note\": \"what it gave you\" }} ]\n\
         }}\n\n\
         Exactly ONE node must have `kind: \"goal\"` - the headline theorem the mission is about. \
         `kind: \"milestone\"` marks the handful of results a human reviewer should audit first (the ones \
         a paper would state as named lemmas); everything else is `\"lemma\"`.\n\n\
         If you genuinely cannot produce a usable graph, leave the file empty and say why in your final \
         message. Do not write a graph of statements you never compiled.\n\n\
         {one_shot}",
        shared = shared_context(&scratch.to_string_lossy(), &req.workspace_dir),
        title = req.title,
        problem = req.problem,
        sources = sources,
        status_hint = status_hint,
        incremental = INCREMENTAL_SAVE_NOTE,
        out = out_file.display(),
        one_shot = process::ONE_SHOT_SESSION_NOTE,
    );

    spawn_agent_run(app, state, run_id, "generate", prompt, workspace, out_file, req.claude_oauth_token, req.model).await
}

// --- 2. prove open nodes -------------------------------------------------

#[tauri::command]
pub async fn run_prove_agent(
    app: AppHandle,
    state: State<'_, MissionAgentState>,
    req: MissionWorkRequest,
) -> Result<(), String> {
    let run_id = sanitize_run_id(&req.run_id)?;
    let workspace = PathBuf::from(&req.workspace_dir);
    let scratch = lean::ensure_scratch(&workspace, &req.mission_id)?;
    let dir = agent_dir(&app, &req.mission_id)?;
    let out_file = dir.join(format!("{run_id}-proofs.json"));
    let mission_file = dir.join(format!("{run_id}-mission.json"));
    std::fs::write(&mission_file, serde_json::to_string_pretty(&req.mission).map_err(|e| e.to_string())?)
        .map_err(|e| e.to_string())?;

    let targets = if req.targets.is_empty() {
        "The user did not pick specific nodes. Choose from the mission's frontier - the open nodes whose \
         own dependencies are already proved, or which have no dependencies at all - and work on as many \
         as you can finish properly."
            .to_string()
    } else {
        format!(
            "Work on these nodes, in this order:\n{}",
            req.targets.iter().map(|t| format!("\x20 - {t}\n")).collect::<String>()
        )
    };

    let prompt = format!(
        "{shared}\n\
         =========================================================\n\
         YOUR TASK: prove open nodes in an existing mission graph.\n\
         =========================================================\n\n\
         The mission's current state is here - read it first: {mission}\n\
         Every node's statement is already on disk under `{scratch}/Theorems/`, and the ones that have \
         compiled have oleans under `{scratch}/build/`.\n\n\
         {targets}\n\n\
         FOR EACH NODE YOU TAKE ON\n\
         \x20 1. Write `{scratch}/Solutions/Sol_<node_name>.lean`. It must declare `theorem solution` \
         whose type is EXACTLY the node's statement type - copy the statement verbatim, change only the \
         declaration's name to `solution`, and replace `:= by sorry` with a real proof.\n\
         \x20 2. Import what you need: Mathlib, Physlib, this mission's definitions, and any of this \
         mission's theorems that are ALREADY PROVED. Reusing a proved node is encouraged - that is what \
         the graph is for.\n\
         \x20 3. Typecheck it. Iterate until it compiles with no errors and no `sorry`.\n\
         \x20 4. Confirm it introduces no new axioms: the file is checked with `#print axioms solution`, \
         and only `propext`, `Classical.choice` and `Quot.sound` are allowed. No `axiom`, no \
         `native_decide`, no `sorry`, no editing the statement to make it easier.\n\n\
         If a node turns out to be too hard to close directly, do NOT force it and do NOT weaken it. \
         Either leave it alone, or decompose it: write a proof-sketch that reduces it to new child \
         lemmas, and report those under `newNodes` and `sketches` below.\n\n\
         If a node's statement looks WRONG (false as stated, vacuous, missing a hypothesis), stop and \
         report it under `problems` rather than proving something else.\n\n\
         {incremental}\
         THE RESULT FILE\n\
         Write ONE JSON object to this exact path: {out}\n\n\
         {{\n\
         \x20 \"proofs\": [\n\
         \x20   {{ \"target\": \"node_name\", \"body\": \"the complete Lean file\", \"explanation\": \
         \"the proof idea in plain English\", \"reuses\": [\"node names or Mathlib lemmas you leaned on\"] }}\n\
         \x20 ],\n\
         \x20 \"sketches\": [\n\
         \x20   {{ \"target\": \"node_name\", \"imports\": [\"child_name\", ...], \"explanation\": \"...\", \
         \"body\": \"the complete Lean file\" }}\n\
         \x20 ],\n\
         \x20 \"newNodes\": [ {{ \"name\": \"...\", \"kind\": \"lemma\", \"description\": \"...\", \
         \"latex\": \"...\", \"preamble\": \"...\", \"statement\": \"... := by sorry\", \"dependsOn\": [], \
         \"source\": null, \"tags\": [] }} ],\n\
         \x20 \"problems\": [ {{ \"node\": \"name\", \"issue\": \"what is wrong with the statement\" }} ],\n\
         \x20 \"summary\": \"what you closed, what you did not, and why\"\n\
         }}\n\n\
         Report only proofs you actually compiled. An honest empty result is far more useful than a \
         proof that does not build.\n\n\
         {one_shot}",
        shared = shared_context(&scratch.to_string_lossy(), &req.workspace_dir),
        mission = mission_file.display(),
        scratch = scratch.display(),
        targets = targets,
        incremental = INCREMENTAL_SAVE_NOTE,
        out = out_file.display(),
        one_shot = process::ONE_SHOT_SESSION_NOTE,
    );

    spawn_agent_run(app, state, run_id, "prove", prompt, workspace, out_file, req.claude_oauth_token, req.model).await
}

// --- 3. extend the graph toward the goal ---------------------------------

#[tauri::command]
pub async fn run_extend_agent(
    app: AppHandle,
    state: State<'_, MissionAgentState>,
    req: MissionWorkRequest,
) -> Result<(), String> {
    let run_id = sanitize_run_id(&req.run_id)?;
    let workspace = PathBuf::from(&req.workspace_dir);
    let scratch = lean::ensure_scratch(&workspace, &req.mission_id)?;
    let dir = agent_dir(&app, &req.mission_id)?;
    let out_file = dir.join(format!("{run_id}-extension.json"));
    let mission_file = dir.join(format!("{run_id}-mission.json"));
    std::fs::write(&mission_file, serde_json::to_string_pretty(&req.mission).map_err(|e| e.to_string())?)
        .map_err(|e| e.to_string())?;

    let focus = if req.targets.is_empty() {
        String::from("Work on whatever part of the gap you judge most tractable.")
    } else {
        format!(
            "The user wants you to push from these nodes in particular:\n{}",
            req.targets.iter().map(|t| format!("\x20 - {t}\n")).collect::<String>()
        )
    };

    let prompt = format!(
        "{shared}\n\
         =========================================================\n\
         YOUR TASK: extend an existing mission graph toward its goal.\n\
         =========================================================\n\n\
         The mission's current state is here - read it first: {mission}\n\
         Its statements are on disk under `{scratch}/Theorems/`.\n\n\
         There is a gap between what the graph currently establishes (its frontier) and the goal theorem. \
         Your job is to make that gap smaller by adding new, honest intermediate statements - not to close \
         it by fiat. {focus}\n\n\
         HOW TO DO THIS WELL\n\
         \x20 1. Understand where the frontier actually is: which nodes are proved, which are open, and \
         what the goal still needs that nothing currently supplies.\n\
         \x20 2. Research. Look for partial results, reductions, special cases, and recent work that moves \
         toward the goal. New nodes should correspond to real mathematics somebody has done or that \
         plainly follows, not to wishful waypoints.\n\
         \x20 3. Add statements that genuinely reduce the distance: a reduction of the goal to a weaker \
         claim, a special case that the general one would follow from, a lemma the known partial results \
         need. Each one gets the same treatment as any other node - written to a file, compiled, \
         `:= by sorry`.\n\
         \x20 4. Where you can honestly connect one of them to something above it, write a proof-sketch. \
         A sketch that assumes the very thing it is meant to establish is worthless - the imports must be \
         strictly smaller pieces.\n\
         \x20 5. Keep the graph a DAG. Do not introduce a cycle, and do not restate an existing node under \
         a new name - reuse it.\n\n\
         DO NOT invent a chain of plausible-sounding lemmas that ends in the goal unless each link is real \
         and compiles. If the honest answer is that the gap cannot be narrowed further from the current \
         literature, say exactly that in `summary`, return no new nodes, and stop. That is a useful result.\n\n\
         {incremental}\
         THE RESULT FILE\n\
         Write ONE JSON object to this exact path: {out}\n\n\
         {{\n\
         \x20 \"newNodes\": [ {{ \"name\": \"...\", \"kind\": \"milestone\" | \"lemma\", \"description\": \
         \"...\", \"latex\": \"...\", \"preamble\": \"...\", \"statement\": \"... := by sorry\", \
         \"dependsOn\": [\"existing or new node names\"], \"source\": \"...\" | null, \"tags\": [] }} ],\n\
         \x20 \"sketches\": [ {{ \"target\": \"node_name\", \"imports\": [\"child_name\", ...], \
         \"explanation\": \"...\", \"body\": \"the complete Lean file\" }} ],\n\
         \x20 \"gapNote\": \"an updated account of what still stands between the frontier and the goal\",\n\
         \x20 \"references\": [ {{ \"title\": \"...\", \"url\": \"...\", \"note\": \"...\" }} ],\n\
         \x20 \"summary\": \"what you added and how much closer it gets the mission\"\n\
         }}\n\n\
         {one_shot}",
        shared = shared_context(&scratch.to_string_lossy(), &req.workspace_dir),
        mission = mission_file.display(),
        scratch = scratch.display(),
        focus = focus,
        incremental = INCREMENTAL_SAVE_NOTE,
        out = out_file.display(),
        one_shot = process::ONE_SHOT_SESSION_NOTE,
    );

    spawn_agent_run(app, state, run_id, "extend", prompt, workspace, out_file, req.claude_oauth_token, req.model).await
}
