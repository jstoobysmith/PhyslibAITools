// TypeScript mirrors of the Rust structs in src-tauri/src/**. Keep these in
// sync by hand when the backend shapes change - there's no codegen here.
//
// Every field is camelCase, matching what actually comes over the wire: the
// Rust side tags every cross-boundary struct with
// `#[serde(rename_all = "camelCase")]`, so these must stay camelCase too.

export interface ToolStatus {
  git: boolean;
  gh: boolean;
  lake: boolean;
  uv: boolean;
  claude: boolean;
  claudeSignedIn: boolean;
  ghSignedIn: boolean;
  gitBash: boolean;
}

export interface OnboardingFlags {
  claudeDone: boolean;
  githubDone: boolean;
  envDone: boolean;
}

export interface AppConfig {
  workspaceDir: string | null;
  onboarding: OnboardingFlags;
  maxOpenAutoPrs: number;
  lastTask: string | null;
  claudeOauthToken: string | null;
}

export interface TaskFile {
  name: string;
  format: "md" | "yaml";
  content: string;
  source: "local" | "github" | "bundled";
}

export interface ParsedTask {
  name: string;
  description: string;
  prompt: string;
  inputQuestions: string[];
  challengeQuestions: string[];
  source: TaskFile["source"];
}

export interface StagedDiff {
  stat: string;
  full: string;
  hasChanges: boolean;
}

export interface RunTaskStarted {
  branch: string;
}

export interface RunTaskFinished {
  couldFinish: boolean;
  branch: string;
  diff: StagedDiff | null;
  prTitle: string | null;
  prBody: string | null;
  error: string | null;
}

export interface PrResult {
  url: string;
}

export interface WorkspaceHealth {
  exists: boolean;
  built: boolean;
  behindUpstream: number;
}

export interface SetupStepEvent {
  id: string;
  label: string;
  status: "skipped" | "running" | "done" | "failed";
  detail: string | null;
}

export interface ProcessLine {
  stream: "stdout" | "stderr";
  text: string;
}

export type ClaudeLoginEvent =
  | { kind: "url"; url: string }
  | { kind: "done"; token: string }
  | { kind: "error"; message: string };
