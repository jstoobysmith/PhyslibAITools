import { useEffect, useState } from "react";
import { Badge } from "./Badge";
import { Button } from "./Button";
import { SyncDialog } from "./SyncDialog";
import { useWorkspaceSync } from "../lib/useWorkspaceSync";
import type { DependencyHealth } from "../lib/types";

/**
 * The Physlib/Mathlib checkout, shown on every working screen.
 *
 * It lives in the app shell rather than on a page because it is equally
 * relevant to both halves of the app and means the same thing in each: Tasks
 * branches off this checkout, and Missions typechecks every statement against
 * it. A mission whose graph won't verify and a task run that won't build very
 * often have the same cause, and it is this.
 *
 * Collapsed it is one line - the headline state plus a Sync button. Expanded
 * it shows what a Lean user actually needs to diagnose a bad build: the
 * toolchain, the branch and revision, and for each dependency whether it is
 * present, compiled, and at the revision the lakefile pins.
 */
export function WorkspaceStatus({
  workspaceDir,
  claudeOauthToken,
}: {
  workspaceDir: string | null;
  claudeOauthToken: string | null;
}) {
  const { health, phase, lines, fixItems, notes, error, startedAt, sync } = useWorkspaceSync(
    workspaceDir,
    claudeOauthToken,
  );
  const [expanded, setExpanded] = useState(false);
  const [dialogOpen, setDialogOpen] = useState(false);
  const syncing = phase !== "idle";

  // Reopen the dialog if a sync starts from somewhere else (the setup
  // dashboard's own nudge shares this hook), so a build never runs unexplained.
  useEffect(() => {
    if (syncing) setDialogOpen(true);
  }, [syncing]);

  if (!workspaceDir) return null;
  const headline = describe(health, phase);

  return (
    <div className={`wsbar wsbar--${headline.tone}`}>
      <button className="wsbar__toggle" onClick={() => setExpanded((v) => !v)} aria-expanded={expanded}>
        <span className="wsbar__chevron">{expanded ? "▾" : "▸"}</span>
        <span className="wsbar__name">Physlib</span>
        <Badge tone={headline.tone}>{headline.text}</Badge>
        {health?.toolchain && <span className="wsbar__detail">{health.toolchain}</span>}
        {health?.dependencies.map((dep) => (
          <span key={dep.name} className="wsbar__detail">
            {dep.name} {dep.requiredRev ?? dep.rev ?? "?"}
            {dep.present && !dep.built ? " (not built)" : ""}
            {!dep.present ? " (missing)" : ""}
          </span>
        ))}
      </button>

      <div className="wsbar__spacer" />

      {health?.exists && !syncing && (
        <Button variant="secondary" size="sm" onClick={sync} title="Fetch the caches and rebuild">
          Sync
        </Button>
      )}
      {syncing && (
        // While a sync is running the button becomes a way back into the
        // dialog rather than a second trigger. Starting a second `lake build`
        // over the same checkout makes both slower, not faster - the backend
        // refuses it outright, and this makes that impossible to try.
        <Button variant="secondary" size="sm" onClick={() => setDialogOpen(true)}>
          Show progress
        </Button>
      )}

      {expanded && (
        <div className="wsbar__panel">
          {!health ? (
            <p className="wsbar__muted">Checking the workspace…</p>
          ) : !health.exists ? (
            <p className="wsbar__muted">
              No Physlib checkout at <code>{health.path}</code>. Open Settings to run setup.
            </p>
          ) : (
            <>
              <dl className="wsbar__facts">
                <Fact label="Location" value={<code>{health.path}</code>} />
                <Fact label="Toolchain" value={health.toolchain ?? "unknown"} />
                <Fact
                  label="Checkout"
                  value={`${health.branch ?? "detached"}${health.rev ? ` @ ${health.rev}` : ""}`}
                />
                <Fact
                  label="Build"
                  value={health.built ? "compiled" : "not built — run Sync, or Tasks and Missions will both fail"}
                />
                <Fact
                  label="Upstream"
                  value={
                    health.behindUpstream === 0
                      ? "up to date"
                      : `${health.behindUpstream} commit${health.behindUpstream === 1 ? "" : "s"} behind`
                  }
                />
              </dl>
              {health.dependencies.length > 0 && (
                <table className="wsbar__deps">
                  <thead>
                    <tr>
                      <th>Dependency</th>
                      <th>Checked out</th>
                      <th>Pinned by lakefile</th>
                      <th>State</th>
                    </tr>
                  </thead>
                  <tbody>
                    {health.dependencies.map((dep) => (
                      <tr key={dep.name}>
                        <td>{dep.name}</td>
                        <td>
                          <code>{dep.rev ?? "—"}</code>
                        </td>
                        <td>
                          <code>{dep.requiredRev ?? "—"}</code>
                        </td>
                        <td>{dependencyState(dep)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              )}
              <p className="wsbar__muted">
                Sync runs <code>lake exe get_cache</code> then <code>lake build</code>. The first fetches both
                Physlib's own prebuilt artifacts and Mathlib's, so the build only has to compile what actually
                changed.
              </p>
            </>
          )}

          {error && <p className="wsbar__error">{error}</p>}
        </div>
      )}

      {dialogOpen && (
        <SyncDialog
          phase={phase}
          lines={lines}
          fixItems={fixItems}
          notes={notes}
          error={error}
          startedAt={startedAt}
          onClose={() => setDialogOpen(false)}
        />
      )}
    </div>
  );
}

function Fact({ label, value }: { label: string; value: React.ReactNode }) {
  return (
    <>
      <dt>{label}</dt>
      <dd>{value}</dd>
    </>
  );
}

function dependencyState(dep: DependencyHealth): string {
  if (!dep.present) return "missing";
  if (!dep.built) return "not compiled";
  // Lake checks a dependency out at the pinned rev, so a mismatch means
  // something moved it by hand - worth flagging, since the errors it causes
  // otherwise look like the project's own.
  if (dep.rev && dep.requiredRev && !dep.requiredRev.includes(dep.rev) && !dep.rev.includes(dep.requiredRev)) {
    return "compiled, but not at the pinned revision";
  }
  return "compiled";
}

type Tone = "success" | "warning" | "danger" | "neutral";

function describe(
  health: { exists: boolean; built: boolean; behindUpstream: number } | null,
  phase: string,
): { text: string; tone: Tone } {
  if (phase === "git") return { text: "checking upstream…", tone: "neutral" };
  if (phase === "cache") return { text: "fetching caches…", tone: "neutral" };
  if (phase === "build") return { text: "building…", tone: "neutral" };
  if (phase === "fixing") return { text: "build failed — diagnosing", tone: "danger" };
  if (!health) return { text: "checking…", tone: "neutral" };
  if (!health.exists) return { text: "not set up", tone: "danger" };
  if (!health.built) return { text: "not built", tone: "danger" };
  if (health.behindUpstream > 0) {
    return {
      text: `${health.behindUpstream} commit${health.behindUpstream === 1 ? "" : "s"} behind`,
      tone: "warning",
    };
  }
  return { text: "ready", tone: "success" };
}
