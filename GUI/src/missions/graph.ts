// The rules a decomposition graph has to satisfy, plus the derived views the
// canvas and the verifier need (edges, topological order, frontier).
//
// Two families of rule, both from Prove2Me's design:
//
//  * **Graph rules** — one goal, unique names, acyclic, everything reachable
//    from the goal. These are what make the decomposition composable: a cycle
//    or an orphan means some branch can never actually discharge the goal.
//  * **Lean rules** — a statement is one declaration terminating in
//    `:= by sorry`, its preamble is imports only, and it may only import the
//    origins (Mathlib/Physlib) or this mission's own modules. These are
//    checked statically here *and* by the real compiler in `commands/lean.rs`;
//    this pass exists to give an instant, precise answer without waiting on
//    Lean, not to replace it.

import type { LeanCheck, LeanEnv, Mission, MissionNode, NodeStatus, ProofSketch } from "./missionTypes";

/** The origins: everything a graph is allowed to bottom out in. */
export const ORIGIN_PREFIXES = ["Mathlib", "Physlib", "PhyslibAlpha", "QuantumInfo", "Batteries", "Aesop", "Init", "Std"];

/** Module prefixes for a mission's own generated files. */
export const MISSION_PREFIXES = ["Theorems", "Definitions"];

export const theoremModule = (name: string) => `Theorems.Thm_${name}`;
export const definitionModule = (name: string) => `Definitions.Def_${name}`;
export const solutionModule = (name: string) => `Solutions.Sol_${name}`;

export const moduleForNode = (node: MissionNode) =>
  node.kind === "definition" ? definitionModule(node.name) : theoremModule(node.name);

export interface Issue {
  severity: "error" | "warning";
  /** Node or sketch id this is about, when it's about one thing. */
  subjectId: string | null;
  message: string;
}

export interface GraphValidation {
  issues: Issue[];
  /** No errors — the graph obeys every rule and can be worked on. */
  valid: boolean;
  goalId: string | null;
}

const LEAN_IDENT = /^[a-z][A-Za-z0-9_']*$/;
const PREAMBLE_LINE = /^\s*(import\s+\S+|open\s+.+|open\s+scoped\s+.+|variable\s+.+|set_option\s+.+|namespace\s+\S+|end(\s+\S+)?|universe\s+.+|noncomputable\s+section|section(\s+\S+)?|--.*)?\s*$/;

/** Declaration keywords a node's statement is allowed to start with. */
const DECL_KEYWORDS = ["theorem", "lemma", "def", "abbrev", "structure", "inductive", "class", "instance", "noncomputable def"];

/** Strips `--` comments and `/- -/` blocks so text checks don't read prose. */
export function stripComments(src: string): string {
  let out = "";
  let depth = 0;
  for (let i = 0; i < src.length; i++) {
    if (depth === 0 && src[i] === "-" && src[i + 1] === "-") {
      while (i < src.length && src[i] !== "\n") i++;
      out += "\n";
      continue;
    }
    if (src[i] === "/" && src[i + 1] === "-") {
      depth++;
      i++;
      continue;
    }
    if (depth > 0 && src[i] === "-" && src[i + 1] === "/") {
      depth--;
      i++;
      continue;
    }
    if (depth === 0) out += src[i];
  }
  return out;
}

export function importsOf(preamble: string): string[] {
  return stripComments(preamble)
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => l.startsWith("import "))
    .map((l) => l.slice("import ".length).trim())
    .filter(Boolean);
}

const rootOf = (module: string) => module.split(".")[0];

/** The name a statement actually declares, e.g. `theorem foo ...` -> `foo`. */
export function declaredName(statement: string): string | null {
  const body = stripComments(statement).trim();
  for (const kw of DECL_KEYWORDS) {
    if (body.startsWith(`${kw} `)) {
      const rest = body.slice(kw.length).trim();
      const match = rest.match(/^[A-Za-z_][A-Za-z0-9_'.]*/);
      return match ? match[0] : null;
    }
  }
  return null;
}

function countDeclarations(statement: string): number {
  const body = stripComments(statement);
  return body
    .split("\n")
    .filter((line) => DECL_KEYWORDS.some((kw) => line.startsWith(`${kw} `) || line.startsWith(`private ${kw} `)))
    .length;
}

/** How one node comes to depend on another. */
export type EdgeKind =
  /** A proof-sketch proves the parent from this child. Backed by a compiled file. */
  | "sketch"
  /** The agent's stated decomposition, not yet backed by a sketch. */
  | "declared"
  /** The parent's preamble imports the child's module — it is built on that
   *  vocabulary. Weaker than a proof dependency, but a real one. */
  | "import";

export interface Edge {
  from: string;
  to: string;
  kind: EdgeKind;
  viaSketch: string | null;
}

/**
 * Every dependency in the mission, from all three places one can be recorded.
 *
 * The third source matters more than it looks. A node's preamble names the
 * mission modules it imports, and that *is* a dependency — it was just never
 * read here, so definitions (which nothing declares a `dependsOn` for, and no
 * sketch imports) came out with no edges at all. Dagre gives an edgeless node
 * rank 0, so all six definitions of a real mission landed on the top row
 * *beside the goal theorem*, burying it. Reading the imports puts them
 * underneath the statements that use them, where they belong.
 */
export function edgesOf(mission: Mission): Edge[] {
  const nodeIds = new Set(mission.nodes.map((n) => n.id));
  const byModule = new Map(mission.nodes.map((n) => [moduleForNode(n), n.id]));
  const out: Edge[] = [];
  const seen = new Set<string>();

  const add = (from: string, to: string, kind: EdgeKind, viaSketch: string | null) => {
    if (!nodeIds.has(from) || !nodeIds.has(to) || from === to) return;
    // A pair can be both proved-from and imported; the stronger one is kept,
    // and since sketches are added first that is what `seen` preserves.
    const key = `${from}->${to}`;
    if (seen.has(key)) return;
    seen.add(key);
    out.push({ from, to, kind, viaSketch });
  };

  const sketched = new Set<string>();
  for (const sketch of mission.sketches) {
    if (!nodeIds.has(sketch.targetId)) continue;
    sketched.add(sketch.targetId);
    for (const child of sketch.imports) add(sketch.targetId, child, "sketch", sketch.id);
  }
  for (const node of mission.nodes) {
    if (sketched.has(node.id)) continue;
    for (const child of node.dependsOn) add(node.id, child, "declared", null);
  }
  for (const node of mission.nodes) {
    for (const imported of importsOf(node.preamble)) {
      const child = byModule.get(imported);
      if (child) add(node.id, child, "import", null);
    }
  }
  return out;
}

/** Depth-first cycle hunt over the dependency edges. Returns the node ids on
 *  the first cycle found, or null. */
function findCycle(nodeIds: string[], edges: { from: string; to: string }[]): string[] | null {
  const adjacency = new Map<string, string[]>();
  for (const id of nodeIds) adjacency.set(id, []);
  for (const e of edges) adjacency.get(e.from)?.push(e.to);

  const state = new Map<string, 0 | 1 | 2>();
  const stack: string[] = [];

  const visit = (id: string): string[] | null => {
    state.set(id, 1);
    stack.push(id);
    for (const next of adjacency.get(id) ?? []) {
      if (state.get(next) === 1) return stack.slice(stack.indexOf(next)).concat(next);
      if (!state.get(next)) {
        const found = visit(next);
        if (found) return found;
      }
    }
    stack.pop();
    state.set(id, 2);
    return null;
  };

  for (const id of nodeIds) {
    if (!state.get(id)) {
      const found = visit(id);
      if (found) return found;
    }
  }
  return null;
}

/** Node ids reachable from the goal by walking dependencies downward. */
export function reachableFromGoal(mission: Mission): Set<string> {
  const goal = mission.nodes.find((n) => n.kind === "goal");
  const seen = new Set<string>();
  if (!goal) return seen;
  const adjacency = new Map<string, string[]>();
  for (const e of edgesOf(mission)) {
    if (!adjacency.has(e.from)) adjacency.set(e.from, []);
    adjacency.get(e.from)!.push(e.to);
  }
  const queue = [goal.id];
  while (queue.length) {
    const id = queue.pop()!;
    if (seen.has(id)) continue;
    seen.add(id);
    for (const next of adjacency.get(id) ?? []) queue.push(next);
  }
  return seen;
}

/**
 * The nodes an agent can start on right now: open, and with nothing unproved
 * beneath them. Prove2Me calls this the mission's frontier.
 */
export function frontier(mission: Mission): MissionNode[] {
  const byId = new Map(mission.nodes.map((n) => [n.id, n]));
  const children = new Map<string, string[]>();
  for (const e of edgesOf(mission)) {
    if (!children.has(e.from)) children.set(e.from, []);
    children.get(e.from)!.push(e.to);
  }
  return mission.nodes.filter((node) => {
    if (node.status === "proved" || node.kind === "definition") return false;
    const kids = children.get(node.id) ?? [];
    return kids.every((id) => {
      const child = byId.get(id);
      if (!child) return true;
      // A definition carries no proof obligation - once it compiles there is
      // nothing further to do with it, so it never reaches `proved`. Requiring
      // that of it would hold back every statement importing it and leave the
      // frontier permanently empty.
      if (child.kind === "definition") return child.status === "open" || child.status === "proved";
      return child.status === "proved";
    });
  });
}

/**
 * Dependencies before dependents, so the verifier compiles a child's olean
 * before anything that imports it. Falls back to input order for whatever a
 * cycle leaves unresolved — validation reports the cycle separately, and
 * refusing to verify anything at all would be less useful than verifying what
 * can be ordered.
 */
export function topoOrder(mission: Mission): MissionNode[] {
  const byId = new Map(mission.nodes.map((n) => [n.id, n]));
  const children = new Map<string, string[]>();
  for (const e of edgesOf(mission)) {
    if (!children.has(e.from)) children.set(e.from, []);
    children.get(e.from)!.push(e.to);
  }
  const out: MissionNode[] = [];
  const seen = new Set<string>();
  const visiting = new Set<string>();

  const visit = (id: string) => {
    if (seen.has(id) || visiting.has(id)) return;
    visiting.add(id);
    for (const child of children.get(id) ?? []) visit(child);
    visiting.delete(id);
    seen.add(id);
    const node = byId.get(id);
    if (node) out.push(node);
  };

  // Definitions first: statements import them, and nothing imports a statement
  // from a definition.
  for (const node of mission.nodes) if (node.kind === "definition") visit(node.id);
  for (const node of mission.nodes) visit(node.id);
  return out;
}

export function validate(mission: Mission): GraphValidation {
  const issues: Issue[] = [];
  const add = (severity: Issue["severity"], subjectId: string | null, message: string) =>
    issues.push({ severity, subjectId, message });

  const statements = mission.nodes.filter((n) => n.kind !== "definition");
  const goals = mission.nodes.filter((n) => n.kind === "goal");

  // --- graph shape ---
  if (goals.length === 0) add("error", null, "The mission has no goal theorem.");
  if (goals.length > 1) {
    for (const g of goals) add("error", g.id, `More than one node is marked as the goal (${goals.map((n) => n.name).join(", ")}).`);
  }

  const seenNames = new Map<string, string>();
  for (const node of mission.nodes) {
    if (!LEAN_IDENT.test(node.name)) {
      add("error", node.id, `"${node.name}" isn't a valid lowercase Lean identifier.`);
    }
    const prior = seenNames.get(node.name);
    if (prior) add("error", node.id, `Two nodes share the name "${node.name}".`);
    else seenNames.set(node.name, node.id);
  }

  const edges = edgesOf(mission);
  const cycle = findCycle(mission.nodes.map((n) => n.id), edges);
  if (cycle) {
    const names = cycle.map((id) => mission.nodes.find((n) => n.id === id)?.name ?? id);
    add("error", cycle[0], `The dependencies form a cycle: ${names.join(" → ")}. A decomposition has to be acyclic.`);
  }

  if (goals.length === 1 && !cycle) {
    const reachable = reachableFromGoal(mission);
    for (const node of statements) {
      if (!reachable.has(node.id)) {
        add("warning", node.id, `"${node.name}" isn't reachable from the goal — nothing above it depends on it.`);
      }
    }
  }

  // --- Lean rules, per node ---
  const nodeIds = new Set(mission.nodes.map((n) => n.id));
  for (const node of mission.nodes) {
    const declared = declaredName(node.statement);
    if (!declared) {
      add("error", node.id, `"${node.name}" has no recognizable declaration — a statement starts with theorem/lemma/def.`);
    } else if (declared !== node.name) {
      add("error", node.id, `"${node.name}" declares "${declared}" instead. The node name and the declaration have to match.`);
    }
    if (countDeclarations(node.statement) > 1) {
      add("error", node.id, `"${node.name}" contains more than one declaration. Split it into separate nodes.`);
    }
    if (node.kind !== "definition" && !/:=\s*by\s+sorry\s*$/.test(stripComments(node.statement).trim())) {
      add("error", node.id, `"${node.name}" must end in \`:= by sorry\` — a node states a result, it never proves it.`);
    }
    if (node.kind === "definition" && /\bsorry\b/.test(stripComments(node.statement))) {
      add("error", node.id, `Definition "${node.name}" contains \`sorry\`.`);
    }

    for (const line of node.preamble.split("\n")) {
      if (!PREAMBLE_LINE.test(line)) {
        add("error", node.id, `"${node.name}"'s preamble has a line that isn't an import or an open/variable: "${line.trim()}".`);
        break;
      }
    }
    for (const imported of importsOf(node.preamble)) {
      const root = rootOf(imported);
      if (ORIGIN_PREFIXES.includes(root)) continue;
      if (MISSION_PREFIXES.includes(root)) {
        const known = mission.nodes.some((n) => moduleForNode(n) === imported);
        if (!known) add("error", node.id, `"${node.name}" imports ${imported}, which no node in this mission provides.`);
        continue;
      }
      add("error", node.id, `"${node.name}" imports ${imported}, which is outside Mathlib/Physlib and this mission.`);
    }

    for (const dep of node.dependsOn) {
      if (!nodeIds.has(dep)) add("warning", node.id, `"${node.name}" depends on a node that no longer exists.`);
    }
  }

  // --- Lean rules, per sketch ---
  for (const sketch of mission.sketches) {
    const target = mission.nodes.find((n) => n.id === sketch.targetId);
    if (!target) {
      add("warning", sketch.id, "A proof-sketch points at a node that no longer exists.");
      continue;
    }
    if (sketch.imports.includes(sketch.targetId)) {
      add("error", sketch.id, `The sketch for "${target.name}" imports the very statement it's supposed to prove.`);
    }
    if (/\bsorry\b/.test(stripComments(sketch.body))) {
      add("error", sketch.id, `The sketch for "${target.name}" writes \`sorry\`. Gaps belong in child nodes, not in the sketch.`);
    }
    if (!/\b(theorem|lemma)\s+solution\b/.test(stripComments(sketch.body))) {
      add("error", sketch.id, `The sketch for "${target.name}" must declare \`theorem solution\` with the target's type.`);
    }
    for (const child of sketch.imports) {
      if (!nodeIds.has(child)) add("warning", sketch.id, `The sketch for "${target.name}" imports a node that no longer exists.`);
    }
  }

  // --- proofs ---
  for (const node of mission.nodes) {
    if (node.status === "proved" && !node.proof?.check?.ok) {
      add("warning", node.id, `"${node.name}" is marked proved but its proof hasn't passed Lean.`);
    }
  }

  return {
    issues,
    valid: !issues.some((i) => i.severity === "error"),
    goalId: goals.length === 1 ? goals[0].id : null,
  };
}

/** Whether the goal is currently disconnected from the rest of the graph —
 *  the deliberate empty space an open problem is supposed to leave. */
/**
 * Whether a check still stands in the workspace as it is now.
 *
 * A check is a statement about one Physlib/Mathlib/toolchain combination. If
 * the workspace has moved since — a sync pulled new commits, someone changed
 * branch, the toolchain was bumped — the result was true of something else and
 * has to be re-run before it can be believed again. Missing revisions compare
 * equal rather than stale, so an older mission record doesn't light up
 * everything red for no reason.
 */
export function isCheckStale(check: LeanCheck | null | undefined, current: LeanEnv | null): boolean {
  if (!check || !current) return false;
  const differs = (a: string | null, b: string | null) => Boolean(a) && Boolean(b) && a !== b;
  return (
    differs(check.env.physlibRev, current.physlibRev) ||
    differs(check.env.mathlibRev, current.mathlibRev) ||
    differs(check.env.toolchain, current.toolchain)
  );
}

/** Every check in the mission that no longer matches the workspace. */
export function staleChecks(mission: Mission, current: LeanEnv | null): number {
  if (!current) return 0;
  let n = 0;
  for (const node of mission.nodes) {
    if (isCheckStale(node.check, current)) n++;
    if (isCheckStale(node.proof?.check, current)) n++;
  }
  for (const sketch of mission.sketches) if (isCheckStale(sketch.check, current)) n++;
  return n;
}

export function goalGap(mission: Mission): boolean {
  const goal = mission.nodes.find((n) => n.kind === "goal");
  if (!goal) return false;
  return !edgesOf(mission).some((e) => e.from === goal.id);
}

export function statusOf(node: MissionNode): NodeStatus {
  return node.status;
}

export function checkToStatus(node: MissionNode, check: LeanCheck): NodeStatus {
  if (!check.ok) return "failed";
  return node.proof?.check?.ok ? "proved" : "open";
}

export function sketchStatus(check: LeanCheck): ProofSketch["status"] {
  return check.ok ? "verified" : "failed";
}

export interface MissionStats {
  total: number;
  proved: number;
  open: number;
  failed: number;
  draft: number;
  definitions: number;
  sketches: number;
  verifiedSketches: number;
}

export function stats(mission: Mission): MissionStats {
  const s: MissionStats = {
    total: 0,
    proved: 0,
    open: 0,
    failed: 0,
    draft: 0,
    definitions: 0,
    sketches: mission.sketches.length,
    verifiedSketches: mission.sketches.filter((k) => k.status === "verified").length,
  };
  for (const node of mission.nodes) {
    if (node.kind === "definition") {
      s.definitions++;
      continue;
    }
    s.total++;
    s[node.status]++;
  }
  return s;
}
