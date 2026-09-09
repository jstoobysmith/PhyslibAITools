import { useCallback, useEffect, useMemo, useState } from "react";
import { Badge } from "../components/Badge";
import { Button } from "../components/Button";
import { Spinner } from "../components/Spinner";
import { GraphCanvas, type CanvasSelection } from "./GraphCanvas";
import { NodeInspector, SketchInspector } from "./NodeInspector";
import { Latex } from "./Latex";
import { RunPanel } from "./RunPanel";
import { SourceEditor } from "./SourceEditor";
import { frontier, goalGap, staleChecks, stats, validate } from "./graph";
import { MODEL_CHOICES, exportMission, pickExportPath } from "./missionStore";
import {
  canStart,
  editMission,
  primeMission,
  refreshLeanEnv,
  startRun,
  useLeanEnv,
  useMission,
  useRuns,
  useVerifying,
  verifyMission,
} from "./missionRuns";
import type { Mission, MissionNode, RunKind } from "./missionTypes";

/**
 * One mission: the graph, the inspector, and the agent runs working on it.
 *
 * The mission document and the runs both live in `missionRuns.ts`, not in this
 * component - a run outlives any particular screen, and closing the mission
 * (or leaving the Missions tab entirely) must not disturb one. This view is a
 * reader of that store plus the controls for starting and stopping work.
 *
 * Every agent result is treated as a *proposal*: the store merges it and then
 * puts it straight through Lean. Nothing an agent claims moves a node to
 * `proved` on its own.
 */
export function MissionView({
  mission: initial,
  workspaceDir,
  claudeOauthToken,
  autoGenerate,
  importNotes,
  onBack,
}: {
  mission: Mission;
  workspaceDir: string | null;
  claudeOauthToken: string | null;
  /** Set when the mission was just created, so generation starts on its own. */
  autoGenerate: boolean;
  /** What an import did to this mission, shown once on arrival. */
  importNotes?: string[];
  onBack: () => void;
}) {
  primeMission(initial);
  const mission = useMission(initial.id, initial);
  const runs = useRuns(initial.id);
  const verifying = useVerifying(initial.id);
  const leanEnv = useLeanEnv();

  // The checkout can move underneath a mission - a sync, a task run, a manual
  // checkout - and everything verified here is only true of the Physlib that
  // was present at the time.
  // Keyed on *whether* a verification is running, not on its progress object -
  // that changes identity on every emitted line, which would re-read the
  // environment hundreds of times per run.
  const leanBusy = Boolean(verifying);
  useEffect(() => {
    void refreshLeanEnv(workspaceDir);
  }, [workspaceDir, leanBusy]);

  const [selection, setSelection] = useState<CanvasSelection | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [showIssues, setShowIssues] = useState(false);
  const [showSources, setShowSources] = useState(false);
  const [focusFrontier, setFocusFrontier] = useState(false);
  const [exported, setExported] = useState<string | null>(null);
  const [notesShown, setNotesShown] = useState(true);

  // Exports what is actually saved on disk, not this component's state, so the
  // file can never be a snapshot of something that was never persisted.
  const exportJson = useCallback(async () => {
    setError(null);
    try {
      const dest = await pickExportPath(mission.title);
      if (!dest) return;
      await exportMission(mission.id, dest);
      setExported(dest);
    } catch (e) {
      setError(String(e));
    }
  }, [mission.id, mission.title]);

  const validation = useMemo(() => validate(mission), [mission]);
  const missionStats = useMemo(() => stats(mission), [mission]);
  const frontierNodes = useMemo(() => frontier(mission), [mission]);

  const liveRuns = runs.filter((r) => r.status === "running");
  const busyWithLean = leanBusy;
  const stale = staleChecks(mission, leanEnv);
  // Verification resolves imports against whatever is checked out, so a
  // non-default branch makes every result meaningless. The backend refuses it;
  // this says so before the user hits the wall.
  const defaultBranch = leanEnv?.defaultBranch ?? "master";
  const offCanonical = Boolean(leanEnv?.physlibBranch && leanEnv.physlibBranch !== defaultBranch);

  const begin = useCallback(
    async (kind: RunKind, targets: string[] = []) => {
      if (!workspaceDir) {
        setError("This needs the Physlib workspace, which isn't set up yet.");
        return;
      }
      setError(null);
      try {
        await startRun({ mission, kind, workspaceDir, claudeOauthToken, targets });
      } catch (e) {
        setError(e instanceof Error ? e.message : String(e));
      }
    },
    [claudeOauthToken, mission, workspaceDir],
  );

  // Generation for a freshly created mission fires once, and only while it's
  // still empty - never on reopening one.
  const [autoStarted, setAutoStarted] = useState(false);
  useEffect(() => {
    if (!autoGenerate || autoStarted || mission.nodes.length > 0) return;
    setAutoStarted(true);
    void begin("generate");
  }, [autoGenerate, autoStarted, begin, mission.nodes.length]);

  const verify = useCallback(
    async (only?: Set<string>) => {
      if (!workspaceDir) {
        setError("Lean verification needs the Physlib workspace, which isn't set up yet.");
        return;
      }
      try {
        await verifyMission(mission.id, workspaceDir, only);
      } catch (e) {
        setError(String(e));
      }
    },
    [mission.id, workspaceDir],
  );

  const selectedNode = selection?.kind === "node" ? mission.nodes.find((n) => n.id === selection.id) : undefined;
  const selectedSketch = selection?.kind === "sketch" ? mission.sketches.find((s) => s.id === selection.id) : undefined;
  const issuesFor = (id: string) => validation.issues.filter((i) => i.subjectId === id);

  const updateNode = useCallback(
    (next: MissionNode) =>
      editMission(mission.id, (m) => ({ ...m, nodes: m.nodes.map((n) => (n.id === next.id ? next : n)) })).catch((e) =>
        setError(String(e)),
      ),
    [mission.id],
  );

  const focusIds = useMemo(
    () => (focusFrontier ? new Set(frontierNodes.map((n) => n.id)) : null),
    [focusFrontier, frontierNodes],
  );

  const errorCount = validation.issues.filter((i) => i.severity === "error").length;
  const warningCount = validation.issues.length - errorCount;

  const proveBlock = canStart(mission.id, "prove", frontierNodes.map((n) => n.name));
  const extendBlock = canStart(mission.id, "extend");
  const generateBlock = canStart(mission.id, "generate");

  return (
    <div className="mview">
      <header className="mview__head">
        <div className="mview__title">
          <button className="btn btn--ghost btn--sm" onClick={onBack}>
            ← Missions
          </button>
          <h2>{mission.title}</h2>
          {mission.openProblem ? <Badge tone="warning">open problem</Badge> : <Badge tone="accent">known solution</Badge>}
        </div>
        <div className="mview__stats">
          <span>
            <strong>{missionStats.proved}</strong>/{missionStats.total} proved
          </span>
          <span>{missionStats.open} open</span>
          {missionStats.failed > 0 && <span className="mview__stat--bad">{missionStats.failed} failed</span>}
          {missionStats.draft > 0 && <span className="mview__stat--warn">{missionStats.draft} unchecked</span>}
          <span>
            {missionStats.verifiedSketches}/{missionStats.sketches} sketches verified
          </span>
        </div>
      </header>

      <div className="mview__bar">
        {mission.nodes.length === 0 && (
          <Button size="sm" disabled={!generateBlock.ok} title={generateBlock.reason} onClick={() => begin("generate")}>
            Generate decomposition graph
          </Button>
        )}
        <Button
          size="sm"
          variant="secondary"
          busy={busyWithLean}
          disabled={busyWithLean || mission.nodes.length === 0}
          onClick={() => verify()}
        >
          Verify graph with Lean
        </Button>
        <Button
          size="sm"
          disabled={frontierNodes.length === 0 || !proveBlock.ok}
          title={proveBlock.reason ?? "Work on proofs for the open nodes at the frontier"}
          onClick={() => begin("prove", frontierNodes.map((n) => n.name))}
        >
          Work on proofs ({frontierNodes.length})
        </Button>
        <Button
          size="sm"
          variant="secondary"
          disabled={!extendBlock.ok}
          title={extendBlock.reason ?? "Add new statements that push the graph toward the goal"}
          onClick={() => begin("extend")}
        >
          Extend toward goal
        </Button>

        <label className="mmodel" title="Model used for this mission's agent runs. Change it before starting a run.">
          <span>Model</span>
          <select
            value={mission.model ?? ""}
            onChange={(e) => {
              const value = e.target.value || null;
              void editMission(mission.id, (m) => ({ ...m, model: value }));
            }}
          >
            {MODEL_CHOICES.map((choice) => (
              <option key={choice.label} value={choice.id ?? ""} title={choice.hint}>
                {choice.label}
              </option>
            ))}
          </select>
        </label>

        <label className="mtoggle">
          <input type="checkbox" checked={focusFrontier} onChange={(e) => setFocusFrontier(e.target.checked)} />
          Highlight frontier
        </label>

        <div className="mview__spacer" />

        <button className="btn btn--ghost btn--sm" onClick={() => setShowSources((v) => !v)}>
          Sources ({mission.sources.length})
        </button>
        <button className="btn btn--ghost btn--sm" onClick={exportJson} title="Save this mission's JSON to a file">
          ⤓ Export JSON
        </button>
        <button
          className={`mvalid mvalid--${errorCount ? "bad" : warningCount ? "warn" : "ok"}`}
          onClick={() => setShowIssues((v) => !v)}
        >
          {errorCount === 0 && warningCount === 0
            ? "✓ Valid graph"
            : `${errorCount} error${errorCount === 1 ? "" : "s"}, ${warningCount} warning${warningCount === 1 ? "" : "s"}`}
        </button>
      </div>

      {error && <div className="mbanner mbanner--bad">{error}</div>}

      {importNotes && importNotes.length > 0 && notesShown && (
        <div className="mbanner mbanner--gap">
          <span>
            <strong>Imported.</strong> {importNotes.join(" ")}
          </span>
          <div className="mview__spacer" />
          <button className="btn btn--ghost btn--sm" onClick={() => setNotesShown(false)}>
            Dismiss
          </button>
        </div>
      )}

      {exported && (
        <div className="mbanner">
          <span>
            Saved to <code>{exported}</code>
          </span>
          <div className="mview__spacer" />
          <button className="btn btn--ghost btn--sm" onClick={() => setExported(null)}>
            Dismiss
          </button>
        </div>
      )}

      {offCanonical && (
        <div className="mbanner mbanner--bad">
          <span>
            <strong>
              The workspace is on branch <code>{leanEnv?.physlibBranch}</code>, not <code>{defaultBranch}</code>.
            </strong>{" "}
            Statements are typechecked against whatever this checkout has built, so nothing verified here would say
            anything about real Physlib. Switch it to <code>{defaultBranch}</code> and sync before working on this
            mission.
          </span>
        </div>
      )}

      {!offCanonical && stale > 0 && (
        <div className="mbanner mbanner--gap">
          <strong>
            {stale} {stale === 1 ? "result was" : "results were"} verified against a different Physlib.
          </strong>{" "}
          The workspace has moved since (now <code>{leanEnv?.physlibRev ?? "unknown"}</code>
          {leanEnv?.toolchain ? `, ${leanEnv.toolchain}` : ""}). Re-verify to bring them up to date.
        </div>
      )}

      {showSources && (
        <SourceEditor
          mission={mission}
          onChange={(sources) => void editMission(mission.id, (m) => ({ ...m, sources }))}
          onClose={() => setShowSources(false)}
        />
      )}

      {verifying && (
        <div className="mbanner">
          <Spinner />
          <span>
            Typechecking {verifying.done}/{verifying.total}
            {verifying.module ? ` — ${verifying.module}` : ""}
          </span>
        </div>
      )}

      {showIssues && validation.issues.length > 0 && (
        <ul className="missues">
          {validation.issues.map((issue, i) => (
            <li
              key={i}
              className={`missues__item missues__item--${issue.severity}`}
              onClick={() => issue.subjectId && setSelection({ kind: "node", id: issue.subjectId })}
            >
              {issue.message}
            </li>
          ))}
        </ul>
      )}

      {mission.openProblem && goalGap(mission) && mission.gapNote && (
        <div className="mbanner mbanner--gap">
          <strong>The gap.</strong> {mission.gapNote}
        </div>
      )}

      <div className="mview__body">
        <GraphCanvas mission={mission} selection={selection} onSelect={setSelection} focusIds={focusIds} />

        {selectedNode && (
          <NodeInspector
            mission={mission}
            node={selectedNode}
            issues={issuesFor(selectedNode.id)}
            busy={busyWithLean}
            proveBlocked={canStart(mission.id, "prove", [selectedNode.name]).reason}
            onChange={updateNode}
            onVerify={() => verify(new Set([selectedNode.id]))}
            onProve={() => begin("prove", [selectedNode.name])}
            onClose={() => setSelection(null)}
          />
        )}
        {selectedSketch && (
          <SketchInspector
            mission={mission}
            sketch={selectedSketch}
            issues={issuesFor(selectedSketch.id)}
            busy={busyWithLean}
            onVerify={() => verify(new Set([selectedSketch.id]))}
            onClose={() => setSelection(null)}
          />
        )}
      </div>

      {runs.length > 0 && (
        <section className="mruns">
          <h3>
            Agent runs
            {liveRuns.length > 0 && <span className="mruns__count">{liveRuns.length} running</span>}
          </h3>
          <div className="mruns__list">
            {runs.map((run) => (
              <RunPanel key={run.id} run={run} />
            ))}
          </div>
        </section>
      )}

      {mission.summary && (
        <section className="mpanel">
          <h3>What this graph encodes</h3>
          <p>
            <Latex>{mission.summary}</Latex>
          </p>
        </section>
      )}

      {mission.references.length > 0 && (
        <section className="mpanel">
          <h3>References the agent used</h3>
          <ul className="mrefs">
            {mission.references.map((ref, i) => (
              <li key={i}>
                <strong>{ref.title}</strong>
                {ref.url && (
                  <>
                    {" — "}
                    <code>{ref.url}</code>
                  </>
                )}
                {ref.note && <div className="minspect__muted">{ref.note}</div>}
              </li>
            ))}
          </ul>
        </section>
      )}
    </div>
  );
}
