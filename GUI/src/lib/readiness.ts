// Single source of truth for "is this actually set up right now" - used by
// both the startup routing decision (App.tsx) and the setup dashboard, so a
// stale persisted flag can never mask a real problem (a Claude/GitHub logout,
// or a deleted workspace) the way `config.onboarding.*Done` alone used to.
//
// Claude: this app's own login path is a subscription OAuth flow (see
// auth_claude.rs) whose token `claude setup-token` deliberately doesn't save
// anywhere itself, so a stored token in our config is just as valid a
// "signed in" signal as Claude Code's own credentials file - checked via
// `claudeSignedIn` for a subscription login done in the user's own terminal
// at some other time. GitHub: `gh auth status` already performs a real live
// check, so it needs no OR'ing with anything.
import type { AppConfig, ToolStatus, WorkspaceHealth } from "./types";

export function isClaudeReady(config: AppConfig, tools: ToolStatus): boolean {
  return tools.claudeSignedIn || Boolean(config.claudeOauthToken);
}

export function isGithubReady(tools: ToolStatus): boolean {
  return tools.ghSignedIn;
}

export function isEnvReady(health: WorkspaceHealth | null): boolean {
  // `exists` alone isn't enough - a `run_setup` that cloned fine but had
  // `lake exe cache get`/`lake build` fail or get interrupted would leave
  // `.git` present with no working build. `built` (see workspace.rs)
  // checks for actual compiled output, not just a checkout.
  return Boolean(health?.exists && health?.built);
}
