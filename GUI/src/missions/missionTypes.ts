// The mission-workbench schema. Unlike the rest of `lib/types.ts`, this one
// has no mirrored Rust struct to stay in sync with: `commands/missions.rs`
// stores the document as opaque JSON on purpose, so this file is the single
// definition of what a mission is.
//
// Vocabulary follows the Prove2Me paper, since the whole model is borrowed
// from it: a mission has a headline *goal*, a curated core of *milestones*,
// and everything else is a *lemma*. A *sketch* proves one node while
// importing others, which is what creates the edges of the graph.

/** How a node earns its place in the graph. */
export type NodeKind = "goal" | "milestone" | "lemma" | "definition";

export type NodeStatus =
  /** Written by the agent, not yet typechecked. */
  | "draft"
  /** Typechecked: it compiles and is correctly left open (`:= by sorry`). */
  | "open"
  /** A sorry-free, axiom-clean proof has been accepted for it. */
  | "proved"
  /** Lean rejected it, or it broke one of the statement rules. */
  | "failed";

/**
 * The exact context a check ran in — which Physlib, which Mathlib, which
 * toolchain. Mirrors Prove2Me's pinned verification environments: a result is
 * only meaningful together with the environment that produced it.
 *
 * Missions verify in place, against whatever the workspace has checked out and
 * built, so this is what stops a green tick from silently meaning "compiled
 * against some Physlib, once".
 */
export interface LeanEnv {
  physlibRev: string | null;
  physlibBranch: string | null;
  mathlibRev: string | null;
  toolchain: string | null;
  /** Read from the local `upstream/HEAD` ref, so nothing has to assume
   *  "master". Null when the ref isn't set. */
  defaultBranch: string | null;
}

/** One `lake env lean` run, as reported by `commands/lean.rs`. */
export interface LeanCheck {
  id: string;
  module: string;
  ok: boolean;
  hasSorry: boolean;
  axioms: string | null;
  diagnostics: string;
  ruleError: string | null;
  durationMs: number;
  env: LeanEnv;
}

export interface MissionNode {
  id: string;
  /** Lean declaration name, unique across the mission. */
  name: string;
  kind: NodeKind;
  /** Natural-language account of the mathematics — the audited object. */
  description: string;
  /** The same statement written as LaTeX, rendered in the inspector. */
  latex: string;
  /** Imports and `open`/`variable` lines. */
  preamble: string;
  /** One declaration, terminating in `:= by sorry` (except definitions). */
  statement: string;
  /** Where it came from — a paper section, a textbook, a URL. */
  source: string | null;
  tags: string[];
  /**
   * Declared dependencies, by node id. These are the agent's *stated*
   * decomposition and are drawn as provisional edges; a sketch that actually
   * compiles is what turns an edge solid (see `sketchEdges` in graph.ts).
   */
  dependsOn: string[];
  status: NodeStatus;
  check: LeanCheck | null;
  /** Set once a sorry-free proof is accepted. */
  proof: NodeProof | null;
  createdBy: "generate" | "extend" | "prove" | "user";
}

export interface NodeProof {
  /** The complete Lean file, declaring `theorem solution`. */
  body: string;
  /** The proof idea in plain English — required of every submission. */
  explanation: string;
  /** Node names or Mathlib lemmas the proof leaned on. */
  reuses: string[];
  check: LeanCheck | null;
  acceptedAt: string | null;
}

/**
 * A proof of one node that imports others, including still-open ones. This is
 * the decomposition mechanism: the target is established *conditional on* the
 * imports, so each import becomes a child edge and can be attacked
 * independently. A sketch must be free of `sorry` itself — every gap belongs
 * in a child node, not in the sketch.
 */
export interface ProofSketch {
  id: string;
  /** Node id this sketch proves. */
  targetId: string;
  /** Node ids it imports — the children it creates. */
  imports: string[];
  explanation: string;
  body: string;
  status: "draft" | "verified" | "failed";
  check: LeanCheck | null;
  createdBy: "generate" | "extend" | "prove" | "user";
}

/**
 * Something the user attached for the agent to work from. Files are copied
 * into the mission folder so the record stays self-contained; links are just
 * stored and fetched by the agent at run time, which is the honest model - a
 * URL's content isn't ours and can change under us.
 */
export type MissionSource = FileSource | LinkSource;

export interface FileSource {
  id: string;
  kind: "file";
  /** Filename, shown in the UI and given to the agent as the label. */
  label: string;
  /** Absolute path inside the mission's `sources/` folder. */
  path: string;
  /** `pdf` | `tex` | `text` | `bib` | `other`. */
  fileKind: string;
  bytes: number;
  /** The user's own note on why this source matters. */
  note: string;
}

export interface LinkSource {
  id: string;
  kind: "link";
  /** A human title, defaulting to the URL's host + path. */
  label: string;
  url: string;
  note: string;
}

export interface Reference {
  title: string;
  url: string;
  note: string;
}

export interface Mission {
  id: string;
  title: string;
  /** The user's own natural-language description of the problem. */
  problem: string;
  sources: MissionSource[];
  /**
   * `--model` value passed to `claude` for this mission's agent runs, or null
   * to use whatever the CLI is configured with. Per-mission rather than global
   * because the right model is a property of the problem's difficulty - and
   * changing it before starting a run makes it effectively per-run.
   */
  model: string | null;
  /**
   * Whether the problem is open. Set by the agent from the literature (the
   * user's belief is only a hint). Drives the gap rendering: an open
   * problem's graph deliberately stops short of the goal.
   */
  openProblem: boolean;
  /**
   * What the *user* said they believe when creating the mission. Only ever a
   * hint to the generator — `openProblem` is the agent's finding from the
   * literature, and the two are allowed to disagree.
   */
  knownStatus: "open" | "solved" | "unknown";
  /** The agent's account of what stands between the frontier and the goal. */
  gapNote: string;
  summary: string;
  nodes: MissionNode[];
  sketches: ProofSketch[];
  references: Reference[];
  /** Free-text log of what each agent run did, newest last. */
  runLog: RunLogEntry[];
  createdAt: string;
  updatedAt: string;
}

export interface RunLogEntry {
  at: string;
  kind: "generate" | "prove" | "extend" | "verify";
  summary: string;
}

export interface MissionSummary {
  id: string;
  title: string;
  problem: string;
  openProblem: boolean;
  nodeCount: number;
  provedCount: number;
  updatedAt: string;
}

// --- what the agent hands back -------------------------------------------
// Deliberately name-keyed rather than id-keyed: the agent invents names, the
// app assigns ids. `mergeGraph`/`applyWork` in missionStore.ts do the join.

export interface AgentNode {
  name: string;
  kind?: NodeKind;
  description?: string;
  latex?: string;
  preamble?: string;
  statement?: string;
  dependsOn?: string[];
  source?: string | null;
  tags?: string[];
}

export interface AgentSketch {
  target: string;
  imports?: string[];
  explanation?: string;
  body?: string;
}

export interface AgentGraph {
  openProblem?: boolean;
  summary?: string;
  gapNote?: string;
  definitions?: AgentNode[];
  nodes?: AgentNode[];
  sketches?: AgentSketch[];
  references?: Reference[];
}

export interface AgentProof {
  target: string;
  body?: string;
  explanation?: string;
  reuses?: string[];
}

export interface AgentWork {
  proofs?: AgentProof[];
  sketches?: AgentSketch[];
  newNodes?: AgentNode[];
  problems?: { node: string; issue: string }[];
  gapNote?: string;
  references?: Reference[];
  summary?: string;
}

export interface MissionAgentFinished {
  runId: string;
  kind: RunKind;
  result: AgentGraph | AgentWork | null;
  error: string | null;
}

export type RunKind = "generate" | "prove" | "extend";

/**
 * One agent session. Several can be live at once - across missions always,
 * and within a mission when their writes don't collide (see `canStart` in
 * missionRuns.ts). Runs live outside React so switching mission, or leaving
 * the Missions tab entirely, never kills or loses one.
 */
export interface MissionRun {
  id: string;
  missionId: string;
  missionTitle: string;
  kind: RunKind;
  /** Node names this run was pointed at; empty means "you choose". */
  targets: string[];
  model: string | null;
  status: "running" | "finished" | "failed" | "stopped";
  startedAt: string;
  endedAt: string | null;
  /** Streamed activity, rendered by the shared ActivityFeed. */
  feed: FeedLine[];
  error: string | null;
  /** One-line account of what it did, once it has finished. */
  summary: string | null;
}

export interface FeedLine {
  id: string;
  icon: string;
  text: string;
  tone: "default" | "muted" | "success" | "danger";
}

export interface VerifyProgress {
  /** Two missions can verify at once, so progress says whose it is. */
  missionId: string;
  index: number;
  total: number;
  id: string;
  module: string;
  phase: "checking" | "done";
}
