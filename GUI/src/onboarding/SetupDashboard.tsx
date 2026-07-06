import { useEffect, useState } from "react";
import { SetupSection, type SectionStatus } from "./SetupSection";
import { ClaudeLoginStep } from "./ClaudeLoginStep";
import { GitHubLoginStep } from "./GitHubLoginStep";
import { EnvSetupStep } from "./EnvSetupStep";
import { Badge } from "../components/Badge";
import { Button } from "../components/Button";
import { Spinner } from "../components/Spinner";
import { LogPane } from "../components/LogPane";
import { BranchIcon, FolderIcon, SparkIcon } from "../components/icons";
import { isClaudeReady, isEnvReady, isGithubReady } from "../lib/readiness";
import { checkWorkspaceHealth, claudeLogout, detectTools, githubLogout, installedWorkspaceDir, saveConfig } from "../lib/tauri";
import { useWorkspaceSync } from "../lib/useWorkspaceSync";
import type { AppConfig, ToolStatus, WorkspaceHealth } from "../lib/types";
import { ActivityFeed } from "../tasks/ActivityFeed";

type ConfigPatch = Partial<Omit<AppConfig, "onboarding">> & { onboarding?: Partial<AppConfig["onboarding"]> };

export function SetupDashboard({
  toolStatus,
  config,
  workspaceHealth,
  onConfigChange,
  onToolStatusChange,
  onWorkspaceHealthChange,
  onComplete,
  autoAdvance,
}: {
  toolStatus: ToolStatus;
  config: AppConfig;
  workspaceHealth: WorkspaceHealth | null;
  onConfigChange: (config: AppConfig) => void;
  onToolStatusChange: (tools: ToolStatus) => void;
  onWorkspaceHealthChange: (health: WorkspaceHealth | null) => void;
  /** Called with whether Claude/GitHub/workspace are all actually ready -
   * always true when `autoAdvance` triggers it, but the manual "Back to
   * tasks" button (shown when `!autoAdvance`) can fire it with `false` if
   * the user signed out of something and didn't sign back in, so the
   * caller can route to full onboarding instead of the task dashboard. */
  onComplete: (allReady: boolean) => void;
  /** True for first-time onboarding (auto-advances to the task dashboard the
   * moment all three sections are done); false when reopened from the
   * settings gear icon, where everything already being done is the normal
   * case, not a reason to immediately leave - a "Back to tasks" button is
   * shown instead so the user leaves when they're ready. */
  autoAdvance: boolean;
}) {
  const [workspaceDir, setWorkspaceDir] = useState(config.workspaceDir);
  const [healthLoading, setHealthLoading] = useState(!workspaceHealth);

  const refreshHealth = (dir: string) => {
    setHealthLoading(true);
    checkWorkspaceHealth(dir)
      .then(onWorkspaceHealthChange)
      .catch(() => onWorkspaceHealthChange(null))
      .finally(() => setHealthLoading(false));
  };

  useEffect(() => {
    if (workspaceDir) {
      if (!workspaceHealth) refreshHealth(workspaceDir);
      return;
    }
    installedWorkspaceDir()
      .then((dir) => {
        setWorkspaceDir(dir);
        persist({ workspaceDir: dir });
        refreshHealth(dir);
      })
      .catch(() => setHealthLoading(false));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const persist = (patch: ConfigPatch) => {
    const next = { ...config, ...patch, onboarding: { ...config.onboarding, ...patch.onboarding } };
    onConfigChange(next);
    void saveConfig(next);
  };

  // `claudeDone`/`githubDone` below are derived from `toolStatus`, which is
  // only fetched once on app launch (see App.tsx) - a login step completing
  // updates the *config* (via `persist`) but never that snapshot on its
  // own, so without this a successful sign-in would never actually flip
  // the section to "done". `onboarding.*Done` above is otherwise vestigial
  // (nothing reads it - see readiness.ts); this is the thing that matters.
  const refreshToolStatus = () => {
    detectTools().then(onToolStatusChange).catch(() => {});
  };

  const claudeDone = isClaudeReady(config, toolStatus);
  const githubDone = isGithubReady(toolStatus);
  const envDone = isEnvReady(workspaceHealth);

  const allReady = claudeDone && githubDone && envDone;

  useEffect(() => {
    if (autoAdvance && allReady) onComplete(true);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [autoAdvance, allReady]);

  const signOutClaude = async () => {
    await claudeLogout().catch(() => {});
    persist({ claudeOauthToken: null });
    refreshToolStatus();
  };

  const signOutGithub = async () => {
    await githubLogout().catch(() => {});
    refreshToolStatus();
  };

  const claudeStatus: SectionStatus = claudeDone ? "done" : "active";
  const githubStatus: SectionStatus = githubDone ? "done" : "active";
  const envStatus: SectionStatus = envDone ? "done" : claudeDone && githubDone ? "active" : "pending";

  return (
    <div className="page">
      <div style={{ display: "flex", alignItems: "flex-start", justifyContent: "space-between", gap: "1rem" }}>
        <div>
          <p className="eyebrow" style={{ marginBottom: "0.6rem" }}>
            {autoAdvance ? "Get started" : "Settings"}
          </p>
          <h1 className="page-title" style={{ marginBottom: "0.5rem" }}>
            Connect your accounts
          </h1>
          <p className="page-subtitle" style={{ marginBottom: "2.25rem" }}>
            Checked fresh every time the app opens, so a logout or an out-of-date workspace never goes unnoticed.
          </p>
        </div>
        {!autoAdvance && (
          <Button variant="ghost" size="sm" onClick={() => onComplete(allReady)}>
            ← Back to tasks
          </Button>
        )}
      </div>

      <div className="timeline">
        <SetupSection icon={<SparkIcon />} title="Claude Code" description="Runs the task for you." status={claudeStatus}>
          {claudeDone ? (
            <DoneRow label="Signed in" onSignOut={signOutClaude} />
          ) : (
            <ClaudeLoginStep
              onDone={(token) => {
                persist({ onboarding: { claudeDone: true }, claudeOauthToken: token ?? config.claudeOauthToken });
                refreshToolStatus();
              }}
            />
          )}
        </SetupSection>

        <SetupSection icon={<BranchIcon />} title="GitHub" description="Forks Physlib and opens your pull request." status={githubStatus}>
          {githubDone ? (
            <DoneRow label="Signed in" onSignOut={signOutGithub} />
          ) : (
            <GitHubLoginStep
              onDone={() => {
                persist({ onboarding: { githubDone: true } });
                refreshToolStatus();
              }}
            />
          )}
        </SetupSection>

        <SetupSection
          icon={<FolderIcon />}
          title="Physlib workspace"
          description="Installs Lean and the other tools, then downloads and builds Physlib."
          status={envStatus}
          isLast
          disabledReason="Sign in to Claude and GitHub above first."
        >
          {healthLoading ? (
            <Spinner label="Checking…" />
          ) : envDone ? (
            <div>
              <DoneRow label="Ready" />
              {workspaceHealth && workspaceHealth.behindUpstream > 0 && workspaceDir && (
                <SyncNudge
                  workspaceDir={workspaceDir}
                  claudeOauthToken={config.claudeOauthToken}
                  behind={workspaceHealth.behindUpstream}
                  onSynced={() => refreshHealth(workspaceDir)}
                />
              )}
            </div>
          ) : workspaceDir ? (
            <EnvSetupStep
              workspaceDir={workspaceDir}
              onWorkspaceDirChange={(dir) => {
                setWorkspaceDir(dir);
                persist({ workspaceDir: dir });
              }}
              onDone={() => {
                persist({ onboarding: { envDone: true } });
                refreshHealth(workspaceDir);
              }}
            />
          ) : null}
        </SetupSection>
      </div>
    </div>
  );
}

function DoneRow({ label, onSignOut }: { label: string; onSignOut?: () => Promise<void> }) {
  const [signingOut, setSigningOut] = useState(false);

  const handleSignOut = async () => {
    if (!onSignOut) return;
    setSigningOut(true);
    try {
      await onSignOut();
    } finally {
      setSigningOut(false);
    }
  };

  return (
    <div className="setup-done-row">
      <Badge tone="success">{label}</Badge>
      {onSignOut && (
        <Button variant="ghost" size="sm" onClick={handleSignOut} busy={signingOut}>
          Sign out
        </Button>
      )}
    </div>
  );
}

/** A non-blocking nudge shown once the workspace is behind upstream - purely
 * a speed optimization (every task run already fetches and branches off
 * upstream fresh regardless), so it's a suggestion rather than a gate. If
 * the cache/build step fails, a Claude session automatically tries to
 * diagnose and fix it (see `useWorkspaceSync` / `workspace.rs`); its
 * progress is shown here as an activity feed while that's happening. */
function SyncNudge({
  workspaceDir,
  claudeOauthToken,
  behind,
  onSynced,
}: {
  workspaceDir: string;
  claudeOauthToken: string | null;
  behind: number;
  onSynced: () => void;
}) {
  const { phase, lines, fixItems, error, sync } = useWorkspaceSync(workspaceDir, claudeOauthToken);
  const syncing = phase !== "idle";

  const handleSync = async () => {
    await sync();
    onSynced();
  };

  const statusText =
    phase === "cache"
      ? "Fetching the Mathlib cache…"
      : phase === "build"
        ? "Building Physlib…"
        : phase === "fixing"
          ? "That failed - Claude is diagnosing the problem…"
          : `${behind} commit${behind === 1 ? "" : "s"} behind upstream - syncing keeps your next task run fast`;

  return (
    <div style={{ marginTop: "0.6rem", display: "flex", flexDirection: "column", gap: "0.5rem" }}>
      <div style={{ display: "flex", alignItems: "center", gap: "0.6rem" }}>
        <span className="caption">{statusText}</span>
        <Button size="sm" variant="secondary" onClick={handleSync} busy={syncing}>
          Sync now
        </Button>
      </div>
      {error && <p style={{ color: "var(--danger)", fontSize: "0.8125rem" }}>{error}</p>}
      {phase === "fixing" ? <ActivityFeed items={fixItems} /> : lines.length > 0 && <LogPane lines={lines} maxHeight="8rem" />}
    </div>
  );
}
