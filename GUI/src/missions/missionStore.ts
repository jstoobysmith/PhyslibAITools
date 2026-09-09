// Tauri bindings for the mission workbench, plus the join between what an
// agent hands back (name-keyed) and what the app stores (id-keyed).
//
// Everything an agent produces goes through `mergeGraph` / `applyWork`. Both
// are deliberately additive and idempotent: a node that already exists under
// the same name is updated in place rather than duplicated, so re-running the
// generator or a prove pass refines the mission instead of forking it. Ids are
// never taken from the agent — it invents names, the app owns identity.

import { invoke } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import { open } from "@tauri-apps/plugin-dialog";
import { moduleForNode, solutionModule, topoOrder } from "./graph";
import type {
  AgentGraph,
  AgentNode,
  AgentProof,
  AgentSketch,
  AgentWork,
  FileSource,
  LeanCheck,
  LeanEnv,
  LinkSource,
  Mission,
  MissionNode,
  MissionSource,
  MissionSummary,
  NodeKind,
  ProofSketch,
} from "./missionTypes";

// --- models --------------------------------------------------------------

/**
 * What the model picker offers. These are passed straight to `claude --model`,
 * so which ones actually work depends on the signed-in account's plan - an
 * unavailable one fails at run time with the CLI's own error rather than
 * anything we can check up front.
 */
export const MODEL_CHOICES: { id: string | null; label: string; hint: string }[] = [
  { id: null, label: "Default", hint: "Whatever Claude Code is already configured to use." },
  { id: "claude-opus-5", label: "Opus 5", hint: "Strongest reasoning. The right default for generating a graph." },
  { id: "claude-fable-5-1", label: "Fable 5.1", hint: "Most capable, slowest and priciest. For a genuinely hard decomposition." },
  { id: "claude-sonnet-5", label: "Sonnet 5", hint: "Faster and cheaper. Good for grinding through routine proofs." },
  { id: "claude-haiku-4-5", label: "Haiku 4.5", hint: "Cheapest. Only worth it for the easiest leaf lemmas." },
];

export const modelLabel = (id: string | null) => MODEL_CHOICES.find((m) => m.id === id)?.label ?? id ?? "Default";

// --- ids -----------------------------------------------------------------

/** `crypto.randomUUID` needs a secure context, which the webview normally is
 *  — but a packaged build served over a custom protocol isn't guaranteed to
 *  be, and a mission losing identity is not worth the risk of finding out. */
function uid(prefix: string): string {
  const random =
    typeof crypto !== "undefined" && "randomUUID" in crypto
      ? crypto.randomUUID().replace(/-/g, "").slice(0, 12)
      : Math.random().toString(36).slice(2, 14);
  return `${prefix}-${random}`;
}

/** Mission ids are used as a folder name, so they're restricted to what
 *  `sanitize_id` in commands/missions.rs accepts. */
function missionId(title: string): string {
  const slug = title
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 48);
  return `${slug || "mission"}-${Date.now().toString(36)}`;
}

const nowIso = () => new Date().toISOString();

// --- commands ------------------------------------------------------------

export const listMissions = () => invoke<MissionSummary[]>("list_missions");
export const loadMission = (missionId: string) => invoke<Mission>("load_mission", { missionId });
export const saveMission = (mission: Mission) => invoke<void>("save_mission", { mission });
export const deleteMission = (missionId: string, workspaceDir: string | null) =>
  invoke<void>("delete_mission", { missionId, workspaceDir });

// --- sources -------------------------------------------------------------

interface FileSourceRef {
  id: string;
  filename: string;
  path: string;
  fileKind: string;
  bytes: number;
}

/** Copies files into the mission folder and returns them as sources. */
export async function importFileSources(missionId: string, paths: string[]): Promise<FileSource[]> {
  const refs = await invoke<FileSourceRef[]>("import_source_files", { missionId, paths });
  return refs.map((r) => ({
    id: r.id,
    kind: "file" as const,
    label: r.filename,
    path: r.path,
    fileKind: r.fileKind,
    bytes: r.bytes,
    note: "",
  }));
}

export const removeFileSource = (missionId: string, path: string) =>
  invoke<void>("remove_source_file", { req: { missionId, path } });

export const pickSourceFiles = () =>
  open({
    multiple: true,
    title: "Add papers and notes for this mission",
    filters: [{ name: "Papers and notes", extensions: ["pdf", "tex", "txt", "md", "bib"] }],
  }) as Promise<string[] | null>;

/**
 * Turns typed text into a link source. Accepts a bare host ("arxiv.org/abs/…")
 * by assuming https, which is what people actually paste, and rejects anything
 * that still isn't a URL rather than handing the agent something unfetchable.
 */
export function makeLinkSource(raw: string, note = ""): LinkSource | null {
  const text = raw.trim();
  if (!text) return null;
  const candidate = /^[a-z][a-z0-9+.-]*:\/\//i.test(text) ? text : `https://${text}`;
  let parsed: URL;
  try {
    parsed = new URL(candidate);
  } catch {
    return null;
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return null;
  if (!parsed.hostname.includes(".")) return null;
  const label = `${parsed.hostname.replace(/^www\./, "")}${parsed.pathname === "/" ? "" : parsed.pathname}`;
  return { id: uid("src"), kind: "link", label: label.length > 70 ? `${label.slice(0, 69)}…` : label, url: parsed.toString(), note };
}

/** The shape `mission_agent.rs` expects for each attached source. */
export const toSourceInput = (s: MissionSource) =>
  s.kind === "file"
    ? { kind: "file", label: s.label, path: s.path, fileKind: s.fileKind, note: s.note }
    : { kind: "link", label: s.label, url: s.url, note: s.note };

export interface LeanUnit {
  id: string;
  module: string;
  source: string;
  kind: "statement" | "definition" | "sketch" | "proof";
}

export const materializeLean = (workspaceDir: string, missionId: string, units: LeanUnit[]) =>
  invoke<string>("materialize_lean", { workspaceDir, missionId, units });

export const verifyLean = (req: {
  workspaceDir: string;
  missionId: string;
  units: LeanUnit[];
  /** Verify against a checkout that isn't on the default branch. Only ever set
   *  from a deliberate user override — see `verify_lean` in lean.rs. */
  allowNonDefaultBranch?: boolean;
}) => invoke<LeanCheck[]>("verify_lean", { req });

/** The workspace's current verification environment, for comparing against the
 *  one a check was recorded under. */
export const workspaceLeanEnv = (workspaceDir: string) => invoke<LeanEnv>("workspace_lean_env", { workspaceDir });

export const generateGraph = (req: {
  runId: string;
  workspaceDir: string;
  missionId: string;
  title: string;
  problem: string;
  sources: ReturnType<typeof toSourceInput>[];
  knownStatus: "open" | "solved" | "unknown";
  model: string | null;
  claudeOauthToken: string | null;
}) => invoke<void>("generate_graph", { req });

export const runProveAgent = (req: {
  runId: string;
  workspaceDir: string;
  missionId: string;
  mission: Mission;
  targets: string[];
  model: string | null;
  claudeOauthToken: string | null;
}) => invoke<void>("run_prove_agent", { req });

export const runExtendAgent = (req: {
  runId: string;
  workspaceDir: string;
  missionId: string;
  mission: Mission;
  targets: string[];
  model: string | null;
  claudeOauthToken: string | null;
}) => invoke<void>("run_extend_agent", { req });

export const cancelMissionAgent = (runId: string) => invoke<void>("cancel_mission_agent", { runId });

/** Run ids the backend still has processes for - used to prune runs the store
 *  thinks are live but whose process is gone. */
export const listMissionRuns = () => invoke<string[]>("list_mission_runs");

export const newRunId = () => uid("run");

export function onMissionEvent<T>(event: string, handler: (payload: T) => void): Promise<UnlistenFn> {
  return listen<T>(event, (e) => handler(e.payload));
}

// --- construction --------------------------------------------------------

export function newMission(title: string, problem: string, knownStatus: Mission["knownStatus"]): Mission {
  return {
    id: missionId(title),
    title: title.trim(),
    problem: problem.trim(),
    sources: [],
    model: "claude-opus-5",
    openProblem: knownStatus === "open",
    knownStatus,
    gapNote: "",
    summary: "",
    nodes: [],
    sketches: [],
    references: [],
    runLog: [],
    createdAt: nowIso(),
    updatedAt: nowIso(),
  };
}

/** The Lean file for a node: its preamble, then its statement. */
export const nodeSource = (node: MissionNode) => `${node.preamble.trim()}\n\n${node.statement.trim()}\n`;

/**
 * Everything in the mission that Lean can check, in an order where a unit's
 * dependencies are compiled (and have oleans) before it. Definitions and
 * statements first — via `topoOrder` — then the sketches and proofs that
 * import them.
 */
export function unitsFor(mission: Mission, only?: Set<string>): LeanUnit[] {
  const units: LeanUnit[] = [];
  for (const node of topoOrder(mission)) {
    if (only && !only.has(node.id)) continue;
    units.push({
      id: node.id,
      module: moduleForNode(node),
      source: nodeSource(node),
      kind: node.kind === "definition" ? "definition" : "statement",
    });
  }
  const byId = new Map(mission.nodes.map((n) => [n.id, n]));
  for (const sketch of mission.sketches) {
    if (only && !only.has(sketch.id)) continue;
    const target = byId.get(sketch.targetId);
    if (!target) continue;
    units.push({ id: sketch.id, module: solutionModule(`${target.name}_sketch`), source: sketch.body, kind: "sketch" });
  }
  for (const node of mission.nodes) {
    if (!node.proof?.body) continue;
    if (only && !only.has(node.id)) continue;
    units.push({ id: `${node.id}:proof`, module: solutionModule(node.name), source: node.proof.body, kind: "proof" });
  }
  return units;
}

// --- merging agent output ------------------------------------------------

const nodeIdByName = (mission: Mission) => new Map(mission.nodes.map((n) => [n.name, n.id]));

/** Resolves agent-written names to node ids, dropping anything that doesn't
 *  correspond to a real node. Validation reports dangling references; silently
 *  keeping a name that resolves to nothing would put a broken edge on the
 *  canvas instead. */
function resolveNames(names: string[] | undefined, byName: Map<string, string>): string[] {
  return (names ?? []).map((n) => byName.get(n)).filter((id): id is string => Boolean(id));
}

function nodeFromAgent(raw: AgentNode, kind: NodeKind, createdBy: MissionNode["createdBy"]): MissionNode {
  return {
    id: uid("node"),
    name: raw.name,
    kind: raw.kind ?? kind,
    description: raw.description ?? "",
    latex: raw.latex ?? "",
    preamble: (raw.preamble ?? "").trim(),
    statement: (raw.statement ?? "").trim(),
    source: raw.source ?? null,
    tags: raw.tags ?? [],
    dependsOn: [],
    status: "draft",
    check: null,
    proof: null,
    createdBy,
  };
}

/** Updates an existing node from a fresh agent version, keeping its identity,
 *  proof and verification unless the statement itself changed — a changed
 *  statement invalidates both. */
function updateNode(node: MissionNode, raw: AgentNode, kind: NodeKind): MissionNode {
  const statement = (raw.statement ?? node.statement).trim();
  const preamble = (raw.preamble ?? node.preamble).trim();
  const changed = statement !== node.statement || preamble !== node.preamble;
  return {
    ...node,
    kind: raw.kind ?? kind,
    description: raw.description ?? node.description,
    latex: raw.latex ?? node.latex,
    preamble,
    statement,
    source: raw.source ?? node.source,
    tags: raw.tags ?? node.tags,
    status: changed ? "draft" : node.status,
    check: changed ? null : node.check,
    proof: changed ? null : node.proof,
  };
}

function sketchFromAgent(
  raw: AgentSketch,
  targetId: string,
  byName: Map<string, string>,
  createdBy: ProofSketch["createdBy"],
): ProofSketch {
  return {
    id: uid("sketch"),
    targetId,
    imports: resolveNames(raw.imports, byName).filter((id) => id !== targetId),
    explanation: raw.explanation ?? "",
    body: (raw.body ?? "").trim(),
    status: "draft",
    check: null,
    createdBy,
  };
}

/**
 * Folds a generated graph into a mission. Nodes arrive name-keyed and with
 * name-valued `dependsOn`, so ids have to exist for every node before any
 * edge can be resolved — hence the two passes.
 */
export function mergeGraph(mission: Mission, graph: AgentGraph, createdBy: MissionNode["createdBy"] = "generate"): Mission {
  let nodes = [...mission.nodes];

  const upsert = (raw: AgentNode, kind: NodeKind) => {
    if (!raw?.name) return;
    const index = nodes.findIndex((n) => n.name === raw.name);
    if (index >= 0) nodes[index] = updateNode(nodes[index], raw, kind);
    else nodes.push(nodeFromAgent(raw, kind, createdBy));
  };

  for (const raw of graph.definitions ?? []) upsert(raw, "definition");
  for (const raw of graph.nodes ?? []) upsert(raw, raw.kind ?? "lemma");

  // Pass two: every node now has an id, so names in `dependsOn` can resolve.
  const byName = new Map(nodes.map((n) => [n.name, n.id]));
  const declared = new Map<string, string[]>();
  for (const raw of [...(graph.nodes ?? []), ...(graph.definitions ?? [])]) {
    if (raw?.name) declared.set(raw.name, resolveNames(raw.dependsOn, byName));
  }
  nodes = nodes.map((n) => (declared.has(n.name) ? { ...n, dependsOn: declared.get(n.name)! } : n));

  const sketches = [...mission.sketches];
  for (const raw of graph.sketches ?? []) {
    const targetId = byName.get(raw?.target ?? "");
    if (!targetId) continue;
    const fresh = sketchFromAgent(raw, targetId, byName, createdBy);
    // One sketch per target: a new one supersedes the old rather than
    // stacking two competing decompositions of the same node on the canvas.
    const index = sketches.findIndex((s) => s.targetId === targetId);
    if (index >= 0) sketches[index] = { ...fresh, id: sketches[index].id };
    else sketches.push(fresh);
  }

  return {
    ...mission,
    nodes,
    sketches,
    openProblem: graph.openProblem ?? mission.openProblem,
    gapNote: graph.gapNote ?? mission.gapNote,
    summary: graph.summary ?? mission.summary,
    references: [...mission.references, ...(graph.references ?? [])],
    updatedAt: nowIso(),
  };
}

/** Folds a prove/extend run's output in: new nodes and sketches the same way
 *  `mergeGraph` does, plus proofs attached to their targets. */
export function applyWork(mission: Mission, work: AgentWork, createdBy: MissionNode["createdBy"]): Mission {
  let next = mergeGraph(
    mission,
    { nodes: work.newNodes, sketches: work.sketches, gapNote: work.gapNote, references: work.references },
    createdBy,
  );

  const byName = nodeIdByName(next);
  const proofs = new Map<string, AgentProof>();
  for (const proof of work.proofs ?? []) {
    const id = byName.get(proof.target);
    if (id) proofs.set(id, proof);
  }

  next = {
    ...next,
    nodes: next.nodes.map((node) => {
      const proof = proofs.get(node.id);
      if (!proof?.body) return node;
      return {
        ...node,
        // Still `draft`-equivalent until Lean says otherwise: an unverified
        // proof must never move a node to `proved`.
        proof: {
          body: proof.body.trim(),
          explanation: proof.explanation ?? "",
          reuses: proof.reuses ?? [],
          check: null,
          acceptedAt: null,
        },
      };
    }),
    updatedAt: nowIso(),
  };
  return next;
}

/** Writes a batch of Lean results back onto the mission, promoting nodes to
 *  `proved` only when a *proof* passed — a statement passing means it is
 *  correctly open, which is a different thing. */
export function applyChecks(mission: Mission, checks: LeanCheck[]): Mission {
  const byId = new Map(checks.map((c) => [c.id, c]));

  const nodes = mission.nodes.map((node) => {
    const statementCheck = byId.get(node.id);
    const proofCheck = byId.get(`${node.id}:proof`);
    let next = node;

    if (statementCheck) {
      next = { ...next, check: statementCheck, status: statementCheck.ok ? "open" : "failed" };
    }
    if (proofCheck && next.proof) {
      const acceptedAt = proofCheck.ok ? nowIso() : null;
      next = { ...next, proof: { ...next.proof, check: proofCheck, acceptedAt } };
      // A proof only counts once the statement itself has passed too:
      // a proof of an unverified statement proves nothing checkable.
      const statementOk = (next.check ?? statementCheck)?.ok ?? false;
      if (proofCheck.ok && statementOk) next = { ...next, status: "proved" };
    }
    return next;
  });

  const sketches = mission.sketches.map((sketch) => {
    const check = byId.get(sketch.id);
    return check ? { ...sketch, check, status: check.ok ? ("verified" as const) : ("failed" as const) } : sketch;
  });

  return { ...mission, nodes, sketches, updatedAt: nowIso() };
}

export function withLog(mission: Mission, kind: Mission["runLog"][number]["kind"], summary: string): Mission {
  return { ...mission, runLog: [...mission.runLog, { at: nowIso(), kind, summary }], updatedAt: nowIso() };
}
