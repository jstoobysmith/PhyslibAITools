import { useEffect, useState } from "react";
import { Spinner } from "../components/Spinner";
import { TaskCard } from "./TaskCard";
import { parseTask } from "./parseTask";
import { fetchTasks } from "../lib/tauri";
import type { ParsedTask } from "../lib/types";

/** The task list. The Physlib/Mathlib status that used to sit in this header
 * now lives in the app shell (`WorkspaceStatus`), so it shows on the Missions
 * side too rather than only here - and is polled once instead of per screen. */
export function TaskList({ onSelect }: { onSelect: (task: ParsedTask) => void }) {
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
