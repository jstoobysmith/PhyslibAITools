import { TaskList } from "./TaskList";
import type { ParsedTask } from "../lib/types";

/** The task list. The run view itself is mounted one level up (in `App`) so
 * an in-progress run survives navigating to settings and back - see the
 * persistent RunningTaskBanner. */
export function Dashboard({ onSelectTask }: { onSelectTask: (task: ParsedTask) => void }) {
  return <TaskList onSelect={onSelectTask} />;
}
