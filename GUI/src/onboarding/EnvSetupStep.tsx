import { useEffect, useState } from "react";
import { Button } from "../components/Button";
import { Badge } from "../components/Badge";
import { LogPane, type LogLine } from "../components/LogPane";
import { onEvent, pickDirectory, runSetup } from "../lib/tauri";
import type { SetupStepEvent } from "../lib/types";

const STEP_ORDER: { id: string; label: string }[] = [
  { id: "git", label: "Git" },
  { id: "elan", label: "Lean toolchain (elan)" },
  { id: "gh", label: "GitHub CLI" },
  { id: "uv", label: "uv" },
  { id: "claude", label: "Claude Code" },
  { id: "clone", label: "Fork & clone Physlib" },
  { id: "cache", label: "Fetch the Mathlib cache" },
  { id: "build", label: "Build Physlib" },
  { id: "mcp", label: "Connect Lean tools" },
];

type StepState = "pending" | "running" | "done" | "skipped" | "failed";

/** The active environment-setup flow. Only rendered while it isn't done yet
 * - once it is, the parent dashboard shows a compact "ready" row instead. */
export function EnvSetupStep({
  workspaceDir,
  onWorkspaceDirChange,
  onDone,
}: {
  workspaceDir: string;
  onWorkspaceDirChange: (dir: string) => void;
  onDone: () => void;
}) {
  const [running, setRunning] = useState(false);
  const [steps, setSteps] = useState<Record<string, StepState>>({});
  const [lines, setLines] = useState<LogLine[]>([]);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const subs = [
      onEvent<SetupStepEvent>("setup:step", (e) => {
        setSteps((s) => ({ ...s, [e.id]: e.status as StepState }));
      }),
      ...STEP_ORDER.map(({ id }) =>
        onEvent<{ stream: "stdout" | "stderr"; text: string }>(`setup:${id}:line`, (p) =>
          setLines((l) => [...l, { text: p.text, stream: p.stream }]),
        ),
      ),
    ];
    return () => {
      subs.forEach((p) => p.then((unlisten) => unlisten()));
    };
  }, []);

  const changeLocation = async () => {
    // Open the picker at the parent of the current target (the workspace dir
    // itself ends in ".../Physlib", which usually doesn't exist yet).
    const parent = workspaceDir.replace(/[\\/]+[^\\/]*$/, "");
    const chosen = await pickDirectory(parent || undefined);
    if (!chosen) return;
    // Put a "Physlib" folder inside the chosen directory, matching the
    // default's layout - unless the user pointed straight at one already.
    const sep = chosen.includes("\\") ? "\\" : "/";
    const base = chosen.split(/[\\/]/).pop() ?? "";
    const next = base.toLowerCase() === "physlib" ? chosen : `${chosen}${sep}Physlib`;
    onWorkspaceDirChange(next);
  };

  const start = async () => {
    setRunning(true);
    setError(null);
    setLines([]);
    setSteps({});
    try {
      await runSetup(workspaceDir);
      onDone();
    } catch (e) {
      setError(String(e));
    } finally {
      setRunning(false);
    }
  };

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: "0.9rem" }}>
      <div style={{ display: "flex", flexDirection: "column", gap: "0.3rem" }}>
        <span style={{ fontSize: "0.8125rem", fontWeight: 600 }}>Physlib is cloned to (and re-used from):</span>
        <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: "0.75rem" }}>
          <p className="caption" style={{ fontFamily: "var(--font-mono)", wordBreak: "break-all", margin: 0 }}>
            {workspaceDir}
          </p>
          <Button variant="ghost" size="sm" onClick={changeLocation} disabled={running} style={{ flexShrink: 0 }}>
            Change…
          </Button>
        </div>
        <span className="caption" style={{ color: "var(--muted)" }}>
          A local folder on this computer. Your fork on GitHub always goes to your own account — this only sets where
          it's downloaded.
        </span>
      </div>

      <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: "0.5rem 1rem" }}>
        {STEP_ORDER.map(({ id, label }) => (
          <div key={id} style={{ display: "flex", alignItems: "center", justifyContent: "space-between", fontSize: "0.8125rem" }}>
            <span style={{ color: "var(--muted)" }}>{label}</span>
            <StepBadge state={steps[id] ?? "pending"} />
          </div>
        ))}
      </div>

      <Button onClick={start} busy={running}>
        {running ? "Setting up…" : "Start setup"}
      </Button>

      {error && <p style={{ color: "var(--danger)" }}>{error}</p>}

      {lines.length > 0 && <LogPane lines={lines} maxHeight="14rem" />}
    </div>
  );
}

function StepBadge({ state }: { state: StepState }) {
  switch (state) {
    case "done":
      return <Badge tone="success">done</Badge>;
    case "skipped":
      return <Badge tone="neutral">already installed</Badge>;
    case "running":
      return <Badge tone="accent">running…</Badge>;
    case "failed":
      return <Badge tone="danger">failed</Badge>;
    default:
      return <Badge tone="neutral">waiting</Badge>;
  }
}
