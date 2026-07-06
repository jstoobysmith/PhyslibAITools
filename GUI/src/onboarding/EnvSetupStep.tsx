import { useEffect, useState } from "react";
import { Button } from "../components/Button";
import { Badge } from "../components/Badge";
import { LogPane, type LogLine } from "../components/LogPane";
import { onEvent, runSetup } from "../lib/tauri";
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
export function EnvSetupStep({ workspaceDir, onDone }: { workspaceDir: string; onDone: () => void }) {
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
      <p className="caption" style={{ fontFamily: "var(--font-mono)" }}>
        {workspaceDir}
      </p>

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
