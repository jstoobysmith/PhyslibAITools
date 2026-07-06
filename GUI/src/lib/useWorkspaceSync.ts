import { useEffect, useState } from "react";
import type { LogLine } from "../components/LogPane";
import { describeEvent, type FeedItem } from "../tasks/describeEvent";
import { checkWorkspaceHealth, onEvent, syncWorkspace } from "./tauri";
import type { WorkspaceHealth } from "./types";

export type WorkspaceSyncPhase = "idle" | "cache" | "build" | "fixing";

/** Shared logic behind every "is Physlib up to date, and let me sync it"
 * control in the app (the setup dashboard's nudge, the task list's status
 * badge) - live health, running the sync, and tracking which phase it's in:
 * raw output lines while fetching the cache/rebuilding, or an activity feed
 * while the auto-fix Claude spawns on a failed step is running (see
 * `workspace.rs::run_step_with_auto_fix`). Each caller renders its own UI
 * around this; only the state and the sync action are shared. */
export function useWorkspaceSync(workspaceDir: string | null, claudeOauthToken: string | null) {
  const [health, setHealth] = useState<WorkspaceHealth | null>(null);
  const [phase, setPhase] = useState<WorkspaceSyncPhase>("idle");
  const [lines, setLines] = useState<LogLine[]>([]);
  const [fixItems, setFixItems] = useState<FeedItem[]>([]);
  const [error, setError] = useState<string | null>(null);

  const checkHealth = () => {
    if (!workspaceDir) return;
    checkWorkspaceHealth(workspaceDir)
      .then(setHealth)
      .catch(() => setHealth(null));
  };

  useEffect(checkHealth, [workspaceDir]);

  useEffect(() => {
    const onLine = (p: { stream: "stdout" | "stderr"; text: string }) => setLines((l) => [...l, p]);
    const subs = [
      onEvent<{ stream: "stdout" | "stderr"; text: string }>("sync:cache:line", (p) => {
        setPhase("cache");
        onLine(p);
      }),
      onEvent<{ stream: "stdout" | "stderr"; text: string }>("sync:build:line", (p) => {
        setPhase("build");
        onLine(p);
      }),
      onEvent("sync:cache:fix:start", () => {
        setPhase("fixing");
        setFixItems([]);
      }),
      onEvent("sync:build:fix:start", () => {
        setPhase("fixing");
        setFixItems([]);
      }),
      onEvent<unknown>("sync:cache:fix:event", (value) => {
        const item = describeEvent(value);
        if (item) setFixItems((l) => [...l, item]);
      }),
      onEvent<unknown>("sync:build:fix:event", (value) => {
        const item = describeEvent(value);
        if (item) setFixItems((l) => [...l, item]);
      }),
    ];
    return () => {
      subs.forEach((p) => p.then((unlisten) => unlisten()));
    };
  }, []);

  const sync = async () => {
    if (!workspaceDir) return;
    setError(null);
    setLines([]);
    setFixItems([]);
    setPhase("cache");
    try {
      await syncWorkspace(workspaceDir, claudeOauthToken);
      checkHealth();
    } catch (e) {
      setError(String(e));
    } finally {
      setPhase("idle");
    }
  };

  return { health, phase, lines, fixItems, error, sync };
}
