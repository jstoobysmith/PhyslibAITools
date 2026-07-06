import { useEffect, useState } from "react";
import { Button } from "../components/Button";
import { Spinner } from "../components/Spinner";
import { Badge } from "../components/Badge";
import { TaskCard } from "./TaskCard";
import { ActivityFeed } from "./ActivityFeed";
import { parseTask } from "./parseTask";
import { fetchTasks } from "../lib/tauri";
import { useWorkspaceSync } from "../lib/useWorkspaceSync";
import type { ParsedTask } from "../lib/types";

export function TaskList({
  onSelect,
  workspaceDir,
  claudeOauthToken,
}: {
  onSelect: (task: ParsedTask) => void;
  workspaceDir: string | null;
  claudeOauthToken: string | null;
}) {
  const [tasks, setTasks] = useState<ParsedTask[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  const load = () => {
    setLoading(true);
    setError(null);
    fetchTasks()
      .then((files) => setTasks(files.map(parseTask)))
      .catch((e) => setError(String(e)))
      .finally(() => setLoading(false));
  };

  useEffect(load, []);

  return (
    <div className="page page--wide">
      <div style={{ display: "flex", alignItems: "flex-start", justifyContent: "space-between", marginBottom: "2rem", gap: "1.5rem" }}>
        <div>
          <p className="eyebrow" style={{ marginBottom: "0.5rem" }}>
            Pick a task
          </p>
          <h1 className="page-title" style={{ marginBottom: "0.4rem" }}>
            What should Claude work on?
          </h1>
          <p className="page-subtitle" style={{ maxWidth: 520 }}>
            Each task is one small, focused contribution to Physlib. Claude carries it out; you review the result
            before anything is opened as a pull request.
          </p>
        </div>
        <div style={{ display: "flex", alignItems: "center", gap: "0.6rem", flexWrap: "wrap", justifyContent: "flex-end", flexShrink: 0 }}>
          {workspaceDir && <WorkspaceSyncStatus workspaceDir={workspaceDir} claudeOauthToken={claudeOauthToken} />}
        </div>
      </div>

      {loading && !tasks && (
        <div style={{ display: "flex", justifyContent: "center", marginTop: "3rem" }}>
          <Spinner label="Loading tasks…" />
        </div>
      )}

      {error && <p style={{ color: "var(--danger)" }}>{error}</p>}

      {tasks && tasks.length === 0 && !error && <p style={{ color: "var(--muted)" }}>No tasks found.</p>}

      {tasks && tasks.length > 0 && (
        <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(260px, 1fr))", gap: "1.1rem" }}>
          {tasks.map((task) => (
            <TaskCard key={task.name} task={task} onRun={() => onSelect(task)} />
          ))}
        </div>
      )}
    </div>
  );
}

/** Whether the local Physlib checkout is behind upstream, with a one-click
 * re-sync (fetch the Mathlib cache + rebuild) - a speed optimization, not a
 * gate: every task run already fetches and branches off upstream fresh
 * regardless. Mirrors the same `useWorkspaceSync` hook and underlying
 * `sync_workspace` command the onboarding dashboard's own sync nudge uses
 * (see SetupDashboard.tsx), including the auto-fix Claude spawns if a step
 * fails, shown here as an activity feed while that's running. */
function WorkspaceSyncStatus({ workspaceDir, claudeOauthToken }: { workspaceDir: string; claudeOauthToken: string | null }) {
  const { health, phase, fixItems, error, sync } = useWorkspaceSync(workspaceDir, claudeOauthToken);

  if (!health || !health.exists) return null;

  const syncing = phase !== "idle";

  return (
    <div style={{ display: "flex", flexDirection: "column", alignItems: "flex-end", gap: "0.3rem" }}>
      <div style={{ display: "flex", alignItems: "center", gap: "0.5rem" }}>
        {syncing ? (
          <Badge tone="neutral">
            {phase === "cache" ? "Fetching Mathlib cache…" : phase === "build" ? "Building Physlib…" : "Build failed - Claude is diagnosing…"}
          </Badge>
        ) : (
          <Badge tone={health.behindUpstream === 0 ? "success" : "warning"}>
            {health.behindUpstream === 0
              ? "Physlib up to date"
              : `${health.behindUpstream} commit${health.behindUpstream === 1 ? "" : "s"} behind`}
          </Badge>
        )}
        <Button variant="secondary" size="sm" onClick={sync} busy={syncing}>
          Sync
        </Button>
      </div>
      {phase === "fixing" && (
        <div style={{ width: "22rem", maxWidth: "80vw" }}>
          <ActivityFeed items={fixItems} />
        </div>
      )}
      {error && <span style={{ color: "var(--danger)", fontSize: "0.75rem" }}>{error}</span>}
    </div>
  );
}
