import { invoke } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import { openUrl } from "@tauri-apps/plugin-opener";
import { open } from "@tauri-apps/plugin-dialog";
import type {
  AppConfig,
  PrResult,
  RunTaskFinished,
  RunTaskStarted,
  TaskFile,
  ToolStatus,
  WorkspaceHealth,
} from "./types";

// --- one-shot commands -------------------------------------------------

export const currentPlatform = () => invoke<string>("current_platform");
export const detectTools = () => invoke<ToolStatus>("detect_tools");
export const loadConfig = () => invoke<AppConfig>("load_config");
export const saveConfig = (config: AppConfig) => invoke<void>("save_config", { config });
export const installedWorkspaceDir = () => invoke<string>("installed_workspace_dir");

/** Opens a native folder picker so the user can choose where Physlib is
 * cloned. Returns the selected directory, or null if they cancelled. */
export const pickDirectory = (defaultPath?: string) =>
  open({ directory: true, multiple: false, title: "Choose a folder to keep Physlib in", defaultPath }) as Promise<
    string | null
  >;

export const claudeStatus = () => invoke<boolean>("claude_status");
export const startClaudeLogin = () => invoke<void>("start_claude_login");
export const cancelClaudeLogin = () => invoke<void>("cancel_claude_login");
export const openClaudeLoginTerminal = () => invoke<void>("open_claude_login_terminal");
export const verifyClaudeOauthToken = (token: string) => invoke<void>("verify_claude_oauth_token", { token });
export const claudeLogout = () => invoke<void>("claude_logout");

export const githubStatus = () => invoke<boolean>("github_status");
export const startGithubLogin = () => invoke<void>("start_github_login");
export const githubLogout = () => invoke<void>("github_logout");

export const runSetup = (workspaceDir: string) => invoke<void>("run_setup", { workspaceDir });
export const checkWorkspaceHealth = (workspaceDir: string) =>
  invoke<WorkspaceHealth>("check_workspace_health", { workspaceDir });
export const syncWorkspace = (workspaceDir: string, claudeOauthToken: string | null) =>
  invoke<void>("sync_workspace", { workspaceDir, claudeOauthToken });

export const fetchTasks = () => invoke<TaskFile[]>("fetch_tasks");

export const startTaskRun = (req: {
  workspaceDir: string;
  taskName: string;
  prompt: string;
  maxOpenAutoPrs: number;
  claudeOauthToken: string | null;
}) => invoke<RunTaskStarted>("start_task_run", { req });

export const confirmAndOpenPr = (req: { workspaceDir: string; branch: string; title: string; body: string }) =>
  invoke<PrResult>("confirm_and_open_pr", { req });

export const openInBrowser = (url: string) => openUrl(url);

// --- event subscriptions -------------------------------------------------

export function onEvent<T>(event: string, handler: (payload: T) => void): Promise<UnlistenFn> {
  return listen<T>(event, (e) => handler(e.payload));
}

export { type UnlistenFn };
export type { RunTaskFinished };
