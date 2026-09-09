import { useState } from "react";
import { Badge } from "../components/Badge";
import { Button } from "../components/Button";
import { Spinner } from "../components/Spinner";
import { checkWorkspaceHealth, pickDirectory } from "../lib/tauri";
import type { WorkspaceHealth } from "../lib/types";

/**
 * Point the app at a Physlib checkout you already have.
 *
 * Worth having because nothing in the app ever required its own clone -
 * `ensure_cloned` returns immediately when the directory is already a git
 * checkout, so any working copy has always been usable. What was missing was a
 * way to *say so*: the location was chosen automatically on first run and
 * never asked about again, which is how a stale one ends up being rebuilt from
 * source for half an hour.
 *
 * The chosen folder is inspected before it is accepted, and the result is
 * shown rather than silently judged - a checkout missing an `upstream` remote
 * is perfectly good for missions and no good for tasks, and that is the user's
 * call to make, not something to block on.
 */
export function WorkspacePicker({
  current,
  onChoose,
}: {
  current: string | null;
  onChoose: (dir: string) => void;
}) {
  const [candidate, setCandidate] = useState<{ dir: string; health: WorkspaceHealth } | null>(null);
  const [checking, setChecking] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const browse = async () => {
    setError(null);
    const chosen = await pickDirectory(current ?? undefined).catch(() => null);
    if (!chosen) return;
    setChecking(true);
    try {
      setCandidate({ dir: chosen, health: await checkWorkspaceHealth(chosen) });
    } catch (e) {
      setError(String(e));
    } finally {
      setChecking(false);
    }
  };

  const health = candidate?.health;
  // Only a folder that isn't a Physlib checkout at all is refused outright.
  // Everything else - unbuilt, behind, no upstream - is a caveat to show, not
  // a reason to stop someone using their own working copy.
  const usable = Boolean(health?.exists && health.isPhyslib);

  return (
    <div className="pane__field">
      <span className="pane__label">Physlib workspace</span>
      <code className="pane__path">{current ?? "not set"}</code>

      <div className="pane__actions">
        <Button variant="secondary" size="sm" busy={checking} onClick={browse}>
          Use a folder I already have…
        </Button>
        {checking && <Spinner label="Inspecting…" />}
      </div>

      {error && <p className="pane__error">{error}</p>}

      {candidate && !checking && (
        <div className="wspick">
          <code className="pane__path">{candidate.dir}</code>
          {!health?.exists ? (
            <p className="pane__error">That folder isn't a git checkout.</p>
          ) : !health.isPhyslib ? (
            <p className="pane__error">
              That's a git checkout, but its <code>lakefile.toml</code> isn't Physlib's.
            </p>
          ) : (
            <>
              <ul className="wspick__facts">
                <Check ok label={`Physlib checkout on ${health.branch ?? "a detached HEAD"}`} />
                <Check
                  ok={health.built}
                  label={health.built ? "Already built" : "Not built yet — the first sync will build it"}
                />
                <Check
                  ok={health.behindUpstream === 0}
                  label={
                    health.behindUpstream === 0
                      ? "Up to date with upstream"
                      : `${health.behindUpstream} commit${health.behindUpstream === 1 ? "" : "s"} behind upstream`
                  }
                />
                <Check
                  ok={health.hasUpstreamRemote}
                  label={
                    health.hasUpstreamRemote
                      ? "Has an upstream remote — tasks and pull requests will work"
                      : "No upstream remote — missions will work, but task runs can't open pull requests"
                  }
                />
              </ul>
              <p className="pane__muted">
                Task runs create <code>auto-*</code> branches and commits here, and missions write Lean scratch
                files under <code>.p2m/</code> (kept out of git). Fine for a checkout you keep for this; worth
                knowing if it's one you work in yourself.
              </p>
            </>
          )}

          <div className="pane__actions">
            <Button
              size="sm"
              disabled={!usable}
              onClick={() => {
                onChoose(candidate.dir);
                setCandidate(null);
              }}
            >
              Use this folder
            </Button>
            <Button variant="ghost" size="sm" onClick={() => setCandidate(null)}>
              Cancel
            </Button>
          </div>
        </div>
      )}
    </div>
  );
}

function Check({ ok, label }: { ok: boolean; label: string }) {
  return (
    <li>
      <Badge tone={ok ? "success" : "warning"}>{ok ? "✓" : "!"}</Badge>
      {label}
    </li>
  );
}
