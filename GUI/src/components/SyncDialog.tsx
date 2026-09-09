import { useEffect, useState } from "react";
import { Button } from "./Button";
import { LogPane, type LogLine } from "./LogPane";
import { Spinner } from "./Spinner";
import { ActivityFeed } from "../tasks/ActivityFeed";
import type { FeedItem } from "../tasks/describeEvent";
import type { SyncNote, WorkspaceSyncPhase } from "../lib/useWorkspaceSync";

/**
 * What a sync is actually doing, while it does it.
 *
 * A sync can take anywhere from a few seconds to twenty minutes, and the
 * difference is entirely down to whether the prebuilt caches could be used.
 * Without something on screen saying so, a long build is indistinguishable
 * from a hang - which is exactly what happened. The backend emits a `detail`
 * line whenever it knows something the user would want (the checkout is on the
 * wrong branch; this checkout has no artifact cache so everything must be
 * compiled), and those show here as notes above the live command output.
 *
 * It is dismissable, not modal-with-no-exit: the sync keeps running in the
 * background and the status bar still reflects it.
 */

const PHASE_LABEL: Record<WorkspaceSyncPhase, string> = {
  idle: "Finished",
  git: "Checking for upstream changes",
  cache: "Fetching prebuilt caches",
  build: "Building",
  fixing: "Build failed — Claude is diagnosing it",
};

const PHASE_ORDER: WorkspaceSyncPhase[] = ["git", "cache", "build"];

function useElapsed(startedAt: number | null, running: boolean): string {
  const [, tick] = useState(0);
  useEffect(() => {
    if (!running) return;
    const id = setInterval(() => tick((n) => n + 1), 1000);
    return () => clearInterval(id);
  }, [running]);

  if (!startedAt) return "";
  const seconds = Math.max(0, Math.round((Date.now() - startedAt) / 1000));
  if (seconds < 60) return `${seconds}s`;
  return `${Math.floor(seconds / 60)}m ${String(seconds % 60).padStart(2, "0")}s`;
}

export function SyncDialog({
  phase,
  lines,
  fixItems,
  notes,
  error,
  startedAt,
  onClose,
}: {
  phase: WorkspaceSyncPhase;
  lines: LogLine[];
  fixItems: FeedItem[];
  notes: SyncNote[];
  error: string | null;
  startedAt: number | null;
  onClose: () => void;
}) {
  const running = phase !== "idle";
  const elapsed = useElapsed(startedAt, running);

  // How far the sync actually got. Needed once it stops: `phase` goes back to
  // "idle", and without a memory of the furthest step reached a failed sync
  // would draw every step as still pending - including the ones that plainly
  // succeeded before the failure.
  const [reached, setReached] = useState(0);
  useEffect(() => {
    if (phase === "idle") return;
    const index = phase === "fixing" ? PHASE_ORDER.indexOf("build") : PHASE_ORDER.indexOf(phase);
    setReached((r) => Math.max(r, index));
  }, [phase]);

  // Escape closes it - the sync carries on regardless, so there is no reason
  // to trap the user in here.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  const done = !running && !error;

  return (
    <div className="syncdlg__backdrop" onClick={onClose}>
      <div
        className="syncdlg"
        role="dialog"
        aria-modal="true"
        aria-label="Workspace sync"
        onClick={(e) => e.stopPropagation()}
      >
        <header className="syncdlg__head">
          <div>
            <h2>{error ? "Sync failed" : done ? "Sync finished" : "Syncing the workspace"}</h2>
            <p className="syncdlg__sub">
              {running ? PHASE_LABEL[phase] : error ? "See the output below." : "Physlib is up to date and built."}
              {elapsed && ` · ${elapsed}`}
            </p>
          </div>
          {running && <Spinner />}
          <button className="btn btn--ghost btn--sm" onClick={onClose} title="Close (the sync keeps running)">
            ✕
          </button>
        </header>

        <ol className="syncdlg__steps">
          {PHASE_ORDER.map((step, index) => {
            const current = running ? (phase === "fixing" ? PHASE_ORDER.indexOf("build") : PHASE_ORDER.indexOf(phase)) : reached;
            let state: "done" | "now" | "todo" | "failed";
            if (!running && !error) state = "done";
            else if (index < current) state = "done";
            else if (index === current) state = running ? "now" : "failed";
            else state = "todo";
            return (
              <li key={step} className={`syncdlg__step syncdlg__step--${state}`}>
                <span className="syncdlg__dot" />
                {PHASE_LABEL[step]}
              </li>
            );
          })}
        </ol>

        {notes.length > 0 && (
          <ul className="syncdlg__notes">
            {notes.map((note, i) => (
              <li key={i} className={note.warning ? "syncdlg__note--warn" : undefined}>
                {note.text}
              </li>
            ))}
          </ul>
        )}

        {error && <p className="syncdlg__error">{error}</p>}

        <div className="syncdlg__output">
          {phase === "fixing" ? (
            <ActivityFeed items={fixItems} />
          ) : lines.length > 0 ? (
            <LogPane lines={lines} maxHeight="20rem" />
          ) : (
            <p className="syncdlg__muted">
              {running ? "Waiting for the first output…" : "Nothing was run — the workspace was already up to date."}
            </p>
          )}
        </div>

        <footer className="syncdlg__foot">
          <p className="syncdlg__muted">
            {running
              ? "You can close this — the sync keeps going, and the bar at the top of the window tracks it."
              : "Closing this returns you to the app."}
          </p>
          <Button variant={running ? "secondary" : "primary"} size="sm" onClick={onClose}>
            {running ? "Run in background" : "Close"}
          </Button>
        </footer>
      </div>
    </div>
  );
}
