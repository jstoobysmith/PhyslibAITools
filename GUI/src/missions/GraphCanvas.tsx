import { useCallback, useEffect, useMemo, useRef } from "react";
import {
  Background,
  BackgroundVariant,
  Controls,
  Handle,
  MarkerType,
  MiniMap,
  Position,
  ReactFlow,
  ReactFlowProvider,
  useEdgesState,
  useNodesState,
  useReactFlow,
  type Edge,
  type Node,
  type NodeProps,
} from "@xyflow/react";
import "@xyflow/react/dist/style.css";
import dagre from "dagre";
import { edgesOf, goalGap, moduleForNode } from "./graph";
import type { Mission, MissionNode, ProofSketch } from "./missionTypes";

/**
 * The decomposition graph, laid out top-down with the goal theorem at the
 * root and the origins (Mathlib/Physlib) implicitly at the bottom of every
 * branch.
 *
 * Three kinds of thing are drawn, mirroring what they mean:
 *
 *  - **Theorem nodes** — one statement each, coloured by status.
 *  - **Sketch nodes** — the proof that joins a parent to its children. Drawn
 *    as a distinct box *between* them rather than as a plain edge, because
 *    that is what it is: a single proof establishing the parent conditional
 *    on all of the children at once. A parent's children are only jointly
 *    sufficient through the sketch, and separate edges would imply otherwise.
 *  - **The gap** — for an open problem, the deliberate empty space between the
 *    literature frontier and the goal. It is drawn, not hidden, because "we
 *    know how far this can be pushed and no further" is the mission's actual
 *    result.
 */

const NODE_W = 280;
const NODE_H = 118;
const SKETCH_W = 210;
const SKETCH_H = 56;
const GAP_W = 320;
const GAP_H = 104;

export interface CanvasSelection {
  kind: "node" | "sketch";
  id: string;
}

interface TheoremData extends Record<string, unknown> {
  node: MissionNode;
  selected: boolean;
  dimmed: boolean;
}

interface SketchData extends Record<string, unknown> {
  sketch: ProofSketch;
  targetName: string;
  selected: boolean;
}

function statusLabel(node: MissionNode): { text: string; tone: string } {
  switch (node.status) {
    case "proved":
      return { text: "proved", tone: "proved" };
    case "open":
      return { text: "open", tone: "open" };
    case "failed":
      return { text: "failed", tone: "failed" };
    default:
      return { text: "unchecked", tone: "draft" };
  }
}

function TheoremNodeView({ data }: NodeProps<Node<TheoremData>>) {
  const { node, selected, dimmed } = data;
  const status = statusLabel(node);
  return (
    <div
      className={[
        "mnode",
        `mnode--${node.kind}`,
        `mnode--status-${status.tone}`,
        selected ? "mnode--selected" : "",
        dimmed ? "mnode--dimmed" : "",
      ]
        .filter(Boolean)
        .join(" ")}
      style={{ width: NODE_W, minHeight: NODE_H }}
    >
      <Handle type="target" position={Position.Top} className="mnode__handle" />
      {node.kind === "goal" && <div className="mnode__ribbon">◆ Goal theorem</div>}
      <div className="mnode__head">
        <span className="mnode__kind">{node.kind}</span>
        <span className={`mnode__status mnode__status--${status.tone}`}>{status.text}</span>
      </div>
      <div className="mnode__name" title={moduleForNode(node)}>
        {node.name}
      </div>
      <div className="mnode__desc">{node.description || "No description yet."}</div>
      {node.proof?.check?.ok && <div className="mnode__foot">✓ sorry-free proof accepted</div>}
      <Handle type="source" position={Position.Bottom} className="mnode__handle" />
    </div>
  );
}

function SketchNodeView({ data }: NodeProps<Node<SketchData>>) {
  const { sketch, targetName, selected } = data;
  return (
    <div
      className={["msketch", `msketch--${sketch.status}`, selected ? "msketch--selected" : ""].filter(Boolean).join(" ")}
      style={{ width: SKETCH_W, minHeight: SKETCH_H }}
    >
      <Handle type="target" position={Position.Top} className="mnode__handle" />
      <div className="msketch__label">proof-sketch</div>
      <div className="msketch__target">
        {targetName} ← {sketch.imports.length} {sketch.imports.length === 1 ? "lemma" : "lemmas"}
      </div>
      <Handle type="source" position={Position.Bottom} className="mnode__handle" />
    </div>
  );
}

function GapNodeView({ data }: NodeProps<Node<{ note: string }>>) {
  return (
    <div className="mgap" style={{ width: GAP_W, minHeight: GAP_H }}>
      <Handle type="target" position={Position.Top} className="mnode__handle" />
      <div className="mgap__label">open — no known path to the goal</div>
      <div className="mgap__note">{data.note || "The literature does not bridge the frontier and the goal."}</div>
      <Handle type="source" position={Position.Bottom} className="mnode__handle" />
    </div>
  );
}

/** Builds the React Flow graph, then hands it to dagre for a layered layout.
 *  Everything is derived from the mission — nothing about position is stored,
 *  so a re-generated graph never opens with stale coordinates. */
function buildGraph(mission: Mission, selection: CanvasSelection | null, focusIds: Set<string> | null) {
  const nodes: Node[] = [];
  const edges: Edge[] = [];
  const byId = new Map(mission.nodes.map((n) => [n.id, n]));

  for (const node of mission.nodes) {
    nodes.push({
      id: node.id,
      type: "theorem",
      position: { x: 0, y: 0 },
      data: {
        node,
        selected: selection?.kind === "node" && selection.id === node.id,
        dimmed: Boolean(focusIds && !focusIds.has(node.id)),
      } satisfies TheoremData,
      width: NODE_W,
      height: NODE_H,
    });
  }

  for (const sketch of mission.sketches) {
    const target = byId.get(sketch.targetId);
    if (!target) continue;
    nodes.push({
      id: sketch.id,
      type: "sketch",
      position: { x: 0, y: 0 },
      data: {
        sketch,
        targetName: target.name,
        selected: selection?.kind === "sketch" && selection.id === sketch.id,
      } satisfies SketchData,
      width: SKETCH_W,
      height: SKETCH_H,
    });
    edges.push({
      id: `${sketch.targetId}->${sketch.id}`,
      source: sketch.targetId,
      target: sketch.id,
      type: "smoothstep",
      className: `medge medge--sketch medge--${sketch.status}`,
      markerEnd: { type: MarkerType.ArrowClosed },
    });
    for (const childId of sketch.imports) {
      if (!byId.has(childId)) continue;
      edges.push({
        id: `${sketch.id}->${childId}`,
        source: sketch.id,
        target: childId,
        type: "smoothstep",
        className: `medge medge--sketch medge--${sketch.status}`,
        markerEnd: { type: MarkerType.ArrowClosed },
      });
    }
  }

  // Declared dependencies (the agent's stated intent, no sketch yet) and
  // import dependencies (this statement is built on that definition's
  // vocabulary) come from `edgesOf`, which reads all three sources. Sketch
  // edges are drawn above via their sketch node, so they're skipped here.
  for (const edge of edgesOf(mission)) {
    if (edge.kind === "sketch") continue;
    edges.push({
      id: `${edge.from}~${edge.kind}~${edge.to}`,
      source: edge.from,
      target: edge.to,
      type: "smoothstep",
      className: `medge medge--${edge.kind}`,
      markerEnd: { type: MarkerType.ArrowClosed },
    });
  }

  // The gap: only for an open problem whose goal genuinely has nothing under
  // it. Wired goal → gap → frontier so the layout puts it in the empty space
  // rather than floating loose.
  if (mission.openProblem && goalGap(mission)) {
    const goal = mission.nodes.find((n) => n.kind === "goal");
    if (goal) {
      nodes.push({
        id: "gap",
        type: "gap",
        position: { x: 0, y: 0 },
        data: { note: mission.gapNote },
        width: GAP_W,
        height: GAP_H,
      });
      edges.push({
        id: `${goal.id}->gap`,
        source: goal.id,
        target: "gap",
        type: "smoothstep",
        className: "medge medge--gap",
      });
      const hasParent = new Set(edges.map((e) => e.target));
      for (const node of mission.nodes) {
        if (node.id === goal.id || node.kind === "definition") continue;
        if (hasParent.has(node.id)) continue;
        edges.push({ id: `gap->${node.id}`, source: "gap", target: node.id, type: "smoothstep", className: "medge medge--gap" });
      }
    }
  }

  return layout(nodes, edges);
}

function layout(nodes: Node[], edges: Edge[]): { nodes: Node[]; edges: Edge[] } {
  const g = new dagre.graphlib.Graph();
  g.setDefaultEdgeLabel(() => ({}));
  g.setGraph({ rankdir: "TB", nodesep: 46, ranksep: 62, marginx: 40, marginy: 40 });

  for (const node of nodes) {
    g.setNode(node.id, { width: node.width ?? NODE_W, height: node.height ?? NODE_H });
  }
  for (const edge of edges) g.setEdge(edge.source, edge.target);
  dagre.layout(g);

  return {
    nodes: nodes.map((node) => {
      const positioned = g.node(node.id);
      // dagre centres nodes; React Flow positions by top-left corner.
      const width = node.width ?? NODE_W;
      const height = node.height ?? NODE_H;
      return {
        ...node,
        position: positioned
          ? { x: positioned.x - width / 2, y: positioned.y - height / 2 }
          : { x: 0, y: 0 },
      };
    }),
    edges,
  };
}

interface CanvasProps {
  mission: Mission;
  selection: CanvasSelection | null;
  onSelect: (selection: CanvasSelection | null) => void;
  /** When set, everything outside this set is dimmed — used to highlight
   *  the frontier or a validation issue's subject. */
  focusIds?: Set<string> | null;
}

function Canvas({ mission, selection, onSelect, focusIds }: CanvasProps) {
  const nodeTypes = useMemo(() => ({ theorem: TheoremNodeView, sketch: SketchNodeView, gap: GapNodeView }), []);
  const built = useMemo(() => buildGraph(mission, selection, focusIds ?? null), [mission, selection, focusIds]);

  const [nodes, setNodes, onNodesChange] = useNodesState(built.nodes);
  const [edges, setEdges, onEdgesChange] = useEdgesState(built.edges);
  const { fitView } = useReactFlow();

  // Relayout whenever the mission changes. Positions aren't user state here —
  // the graph is regenerated from the document, so dragging a node is a
  // transient nicety that a real change is allowed to discard.
  //
  // The refit matters: `fitView` as a prop only runs at mount, so a graph that
  // grows (an extend run adding nodes below the old frontier) or a pane that
  // resizes would otherwise leave the viewport parked where the *old* layout
  // was — in the worst case looking at empty space. Deferred a frame so the
  // new node sizes are measured before it fits to them.
  useEffect(() => {
    setNodes(built.nodes);
    setEdges(built.edges);
    const frame = requestAnimationFrame(() => void fitView({ padding: 0.18, duration: 220 }));
    return () => cancelAnimationFrame(frame);
  }, [built, fitView, setNodes, setEdges]);

  // Selection alone must not move the viewport — refitting on every click
  // would yank the graph around while the user reads the inspector.
  const paneRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const pane = paneRef.current;
    if (!pane || typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(() => void fitView({ padding: 0.18 }));
    observer.observe(pane);
    return () => observer.disconnect();
  }, [fitView]);

  const handleNodeClick = useCallback(
    (_: unknown, node: Node) => {
      if (node.type === "gap") onSelect(null);
      else onSelect({ kind: node.type === "sketch" ? "sketch" : "node", id: node.id });
    },
    [onSelect],
  );

  if (mission.nodes.length === 0) {
    return (
      <div className="mcanvas mcanvas--empty">
        <p>No graph yet. Generate one to see the decomposition.</p>
      </div>
    );
  }

  return (
    <div className="mcanvas" ref={paneRef}>
      <ReactFlow
        nodes={nodes}
        edges={edges}
        nodeTypes={nodeTypes}
        onNodesChange={onNodesChange}
        onEdgesChange={onEdgesChange}
        onNodeClick={handleNodeClick}
        onPaneClick={() => onSelect(null)}
        fitView
        fitViewOptions={{ padding: 0.18 }}
        minZoom={0.1}
        maxZoom={1.6}
        proOptions={{ hideAttribution: false }}
        nodesConnectable={false}
        edgesFocusable={false}
      >
        <Background variant={BackgroundVariant.Dots} gap={18} size={1} />
        <Controls showInteractive={false} />
        <MiniMap pannable zoomable className="mminimap" nodeStrokeWidth={2} />
      </ReactFlow>
    </div>
  );
}

/** React Flow's viewport hooks (used for the refits above) only work inside a
 *  provider, so the canvas always supplies its own. */
export function GraphCanvas(props: CanvasProps) {
  return (
    <ReactFlowProvider>
      <Canvas {...props} />
    </ReactFlowProvider>
  );
}
