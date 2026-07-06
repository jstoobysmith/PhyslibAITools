import { useState } from "react";
import { TaskList } from "./TaskList";
import { TaskRunView } from "./TaskRunView";
import type { AppConfig, ParsedTask } from "../lib/types";

export function Dashboard({ config }: { config: AppConfig }) {
  const [selected, setSelected] = useState<ParsedTask | null>(null);

  if (selected && config.workspaceDir) {
    return (
      <TaskRunView
        task={selected}
        workspaceDir={config.workspaceDir}
        maxOpenAutoPrs={config.maxOpenAutoPrs}
        claudeOauthToken={config.claudeOauthToken}
        onExit={() => setSelected(null)}
      />
    );
  }

  return <TaskList onSelect={setSelected} workspaceDir={config.workspaceDir} claudeOauthToken={config.claudeOauthToken} />;
}
