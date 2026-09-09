import { useCallback, useEffect, useState } from "react";
import { Badge } from "../components/Badge";
import { Button } from "../components/Button";
import { Card } from "../components/Card";
import { Spinner } from "../components/Spinner";
import { MissionView } from "./MissionView";
import { NewMissionForm } from "./NewMissionForm";
import { RunPanel } from "./RunPanel";
import { reconcileRuns, useRuns } from "./missionRuns";
import { deleteMission, listMissions, loadMission, saveMission } from "./missionStore";
import type { Mission, MissionSummary } from "./missionTypes";

type Screen =
  | { name: "list" }
  | { name: "new" }
  | { name: "mission"; mission: Mission; autoGenerate: boolean };

/**
 * The mission workbench's own root. Deliberately self-contained: it shares
 * nothing with the task dashboard except the Claude credentials and the
 * Physlib workspace path, both handed in as props.
 */
export function MissionsHome({
  workspaceDir,
  claudeOauthToken,
  defaultModel,
}: {
  workspaceDir: string | null;
  claudeOauthToken: string | null;
  /** Model new missions start on, from Settings → Preferences. */
  defaultModel: string | null;
}) {
  const [screen, setScreen] = useState<Screen>({ name: "list" });
  const [missions, setMissions] = useState<MissionSummary[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  // Every run, not just this mission's - runs outlive the screen that started
  // them, so the list is where you find one you left going elsewhere.
  const allRuns = useRuns();

  // A hot-reload or a crash can leave the store believing runs are live that
  // the backend has no process for; drop those on the way in.
  useEffect(() => {
    void reconcileRuns();
  }, []);

  const refresh = useCallback(() => {
    listMissions()
      .then(setMissions)
      .catch((e) => setError(String(e)));
  }, []);

  useEffect(refresh, [refresh]);

  const openMission = async (id: string) => {
    try {
      const mission = await loadMission(id);
      setScreen({ name: "mission", mission, autoGenerate: false });
    } catch (e) {
      setError(String(e));
    }
  };

  const onCreated = async (mission: Mission) => {
    await saveMission(mission);
    setScreen({ name: "mission", mission, autoGenerate: true });
  };

  const liveRuns = allRuns.filter((r) => r.status === "running");

  const remove = async (id: string, title: string) => {
    if (allRuns.some((r) => r.missionId === id && r.status === "running")) {
      setError("That mission has an agent running. Stop it before deleting the mission.");
      return;
    }
    if (!confirm(`Delete the mission "${title}"? Its graph, proofs and sources are removed for good.`)) return;
    try {
      await deleteMission(id, workspaceDir);
      refresh();
    } catch (e) {
      setError(String(e));
    }
  };

  if (screen.name === "mission") {
    return (
      <MissionView
        key={screen.mission.id}
        mission={screen.mission}
        workspaceDir={workspaceDir}
        claudeOauthToken={claudeOauthToken}
        autoGenerate={screen.autoGenerate}
        onBack={() => {
          refresh();
          setScreen({ name: "list" });
        }}
      />
    );
  }

  if (screen.name === "new") {
    return (
      <NewMissionForm defaultModel={defaultModel} onCancel={() => setScreen({ name: "list" })} onCreate={onCreated} />
    );
  }

  return (
    <div className="page mhome">
      <header className="mhome__head">
        <div>
          <h1>Missions</h1>
          <p className="mhome__lede">
            Describe a problem, hand over any papers, and an agent builds its decomposition graph — natural-language
            statements paired with formal Lean, rooted at a goal theorem and grounded in Mathlib and Physlib. Then work
            the graph: prove what's stated, or push it further toward the goal.
          </p>
        </div>
        <Button onClick={() => setScreen({ name: "new" })} disabled={!workspaceDir}>
          New mission
        </Button>
      </header>

      {!workspaceDir && (
        <div className="mbanner mbanner--bad">
          Missions need the Physlib workspace — every statement is typechecked against it with Lean. Finish setup first.
        </div>
      )}
      {error && <div className="mbanner mbanner--bad">{error}</div>}

      {allRuns.length > 0 && (
        <section className="mruns">
          <h3>
            Agent runs
            {liveRuns.length > 0 && <span className="mruns__count">{liveRuns.length} running</span>}
          </h3>
          <div className="mruns__list">
            {allRuns.map((run) => (
              <RunPanel key={run.id} run={run} showMission />
            ))}
          </div>
        </section>
      )}

      {missions === null && <Spinner label="Loading missions…" />}

      {missions?.length === 0 && (
        <Card className="mhome__empty">
          <h3>Nothing here yet</h3>
          <p>
            A mission is one formalization project — a paper, a chapter, or an open problem. The graph it produces is
            checked by Lean on this machine; nothing is uploaded anywhere.
          </p>
          <Button onClick={() => setScreen({ name: "new" })} disabled={!workspaceDir}>
            Create your first mission
          </Button>
        </Card>
      )}

      <div className="mhome__grid">
        {missions?.map((m) => (
          <Card key={m.id} interactive onClick={() => openMission(m.id)} className="mcardm">
            <div className="mcardm__head">
              <h3>{m.title}</h3>
              {liveRuns.some((r) => r.missionId === m.id) && <Badge tone="accent">running</Badge>}
              {m.openProblem ? <Badge tone="warning">open</Badge> : <Badge tone="accent">solved</Badge>}
            </div>
            <p className="mcardm__problem">{m.problem}</p>
            <div className="mcardm__foot">
              <span>
                <strong>{m.provedCount}</strong>/{m.nodeCount} proved
              </span>
              <span className="minspect__muted">{new Date(m.updatedAt).toLocaleDateString()}</span>
              <button
                className="btn btn--ghost btn--sm"
                onClick={(e) => {
                  e.stopPropagation();
                  remove(m.id, m.title);
                }}
                title="Delete this mission"
              >
                Delete
              </button>
            </div>
          </Card>
        ))}
      </div>
    </div>
  );
}
