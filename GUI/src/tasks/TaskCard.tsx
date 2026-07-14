import { Badge } from "../components/Badge";
import { Card } from "../components/Card";
import { Button } from "../components/Button";
import type { ParsedTask } from "../lib/types";

export function TaskCard({ task, onRun }: { task: ParsedTask; onRun: () => void }) {
  return (
    <Card
      interactive
      onClick={onRun}
      style={{ display: "flex", flexDirection: "column", gap: "0.7rem", minHeight: "10rem" }}
    >
      <div style={{ display: "flex", alignItems: "flex-start", justifyContent: "space-between", gap: "0.5rem" }}>
        <h3 className="section-title">{task.name}</h3>
        {task.inputQuestions.length > 0 && <Badge tone="accent">asks first</Badge>}
      </div>
      <p style={{ color: "var(--muted)", fontSize: "0.875rem", lineHeight: 1.55, flex: 1 }}>{task.description}</p>
      <Button size="sm" onClick={onRun} style={{ alignSelf: "flex-start" }}>
        Run this task
      </Button>
    </Card>
  );
}
