import { useState } from "react";
import { ActivityFeed } from "../tasks/ActivityFeed";
import { Spinner } from "../components/Spinner";
import { dismissRun, stopRun } from "./missionRuns";
import { modelLabel } from "./missionStore";
import type { MissionRun } from "./missionTypes";

const KIND_LABEL: Record<MissionRun["kind"], string> = {
  generate: "Generating the graph",
  prove: "Working on proofs",
  extend: "Extending toward the goal",
};

const STATUS_LABEL: Record<MissionRun["status"], string> = {
  running: "running",
  finished: "finished",
  failed: "failed",
  stopped: "stopped",
};

function elapsed(run: MissionRun): string {
  const end = run.endedAt ? new Date(run.endedAt).getTime() : Date.now();
  const seconds = Math.max(0, Math.round((end - new Date(run.startedAt).getTime()) / 1000));
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  return minutes < 60 ? `${minutes}m ${seconds % 60}s` : `${Math.floor(minutes / 60)}h ${minutes % 60}m`;
}

/**
 * One agent run: what it is doing, what it was pointed at, and a control to
 * stop it. Several of these are on screen at once when runs overlap, so each
 * starts collapsed to its header once it is no longer live - a finished run is
 * a record, not something you need to keep watching.
 */
export function RunPanel({ run, showMission = false }: { run: MissionRun; showMission?: boolean }) {
  const live = run.status === "running";
  const [open, setOpen] = useState(live);
  const [stopping, setStopping] = useState(false);

  const targets =
    run.targets.length === 0
      ? run.kind === "prove"
        ? "the frontier, agent's choice"
        : null
      : run.targets.length <= 3
        ? run.targets.join(", ")
        : `${run.targets.slice(0, 3).join(", ")} +${run.targets.length - 3} more`;

  return (
    <article className={`mrun mrun--${run.status}`}>
      <header className="mrun__head">
        <button className="mrun__toggle" onClick={() => setOpen((v) => !v)} aria-expanded={open}>
          <span className="mrun__chevron">{open ? "▾" : "▸"}</span>
          <span className="mrun__kind">
            {KIND_LABEL[run.kind]}
            {showMission && <span className="mrun__mission"> · {run.missionTitle}</span>}
          </span>
        </button>
        <span className={`mrun__status mrun__status--${run.status}`}>{STATUS_LABEL[run.status]}</span>
        <span className="mrun__meta">
          {modelLabel(run.model)} · {elapsed(run)}
          {targets ? ` · ${targets}` : ""}
        </span>
        <div className="mrun__spacer" />
        {live && <Spinner />}
        {live ? (
          <button
            className="btn btn--danger btn--sm"
            disabled={stopping}
            onClick={async () => {
              setStopping(true);
              await stopRun(run.id);
            }}
          >
            {stopping ? "Stopping…" : "Stop"}
          </button>
        ) : (
          <button className="btn btn--ghost btn--sm" onClick={() => dismissRun(run.id)} title="Clear this run">
            Clear
          </button>
        )}
      </header>

      {run.error && <p className="mrun__error">{run.error}</p>}
      {!run.error && run.summary && <p className="mrun__summary">{run.summary}</p>}

      {open && (
        <div className="mrun__feed">
          <ActivityFeed items={run.feed} />
        </div>
      )}
    </article>
  );
}
