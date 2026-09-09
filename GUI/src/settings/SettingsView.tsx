import { useState } from "react";
import { SetupDashboard } from "../onboarding/SetupDashboard";
import { ApiTokenPane } from "./ApiTokenPane";
import { PreferencesPane } from "./PreferencesPane";
import { Button } from "../components/Button";
import { KeyIcon, ProfileIcon, SlidersIcon } from "../components/icons";
import { isClaudeReady, isEnvReady, isGithubReady } from "../lib/readiness";
import type { AppConfig, ToolStatus, WorkspaceHealth } from "../lib/types";

type Pane = "accounts" | "token" | "preferences";

const PANES: { id: Pane; label: string; hint: string; icon: React.ReactNode }[] = [
  { id: "accounts", label: "Accounts", hint: "Claude, GitHub, workspace", icon: <ProfileIcon width={16} height={16} /> },
  { id: "token", label: "API token", hint: "The credential runs use", icon: <KeyIcon width={16} height={16} /> },
  { id: "preferences", label: "Preferences", hint: "Model, theme, limits", icon: <SlidersIcon width={16} height={16} /> },
];

/**
 * Everything behind the profile icon.
 *
 * The Accounts pane is the same `SetupDashboard` that onboarding uses, embedded
 * without its own page header - deliberately, rather than a second sign-in UI
 * that could drift from the real one. The other two panes are new surfaces
 * onboarding has no reason to show.
 */
export function SettingsView({
  config,
  toolStatus,
  workspaceHealth,
  onConfigChange,
  onToolStatusChange,
  onWorkspaceHealthChange,
  onClose,
}: {
  config: AppConfig;
  toolStatus: ToolStatus;
  workspaceHealth: WorkspaceHealth | null;
  onConfigChange: (config: AppConfig) => void;
  onToolStatusChange: (tools: ToolStatus) => void;
  onWorkspaceHealthChange: (health: WorkspaceHealth | null) => void;
  /** Called with whether everything is actually ready, so the caller can route
   *  back to onboarding if the user signed out of something in here. */
  onClose: (allReady: boolean) => void;
}) {
  const [pane, setPane] = useState<Pane>("accounts");

  // Leaving settings has to report whether things are *actually* ready, not
  // assume they are: signing out of Claude in the Accounts pane and then
  // hitting Back should land on onboarding, not on a dashboard whose runs
  // would all fail.
  const allReady =
    isClaudeReady(config, toolStatus) && isGithubReady(toolStatus) && isEnvReady(workspaceHealth);

  return (
    <div className="page settings">
      <header className="settings__head">
        <div>
          <p className="eyebrow">Profile</p>
          <h1 className="page-title">Your settings</h1>
        </div>
        <Button variant="ghost" size="sm" onClick={() => onClose(allReady)}>
          ← Back
        </Button>
      </header>

      <div className="settings__body">
        <nav className="settings__nav">
          {PANES.map((p) => (
            <button
              key={p.id}
              className={`settings__navitem ${pane === p.id ? "settings__navitem--on" : ""}`}
              onClick={() => setPane(p.id)}
            >
              <span className="settings__navicon">{p.icon}</span>
              <span>
                <strong>{p.label}</strong>
                <span className="settings__navhint">{p.hint}</span>
              </span>
            </button>
          ))}
        </nav>

        <div className="settings__pane">
          {pane === "accounts" && (
            <SetupDashboard
              embedded
              toolStatus={toolStatus}
              config={config}
              workspaceHealth={workspaceHealth}
              onConfigChange={onConfigChange}
              onToolStatusChange={onToolStatusChange}
              onWorkspaceHealthChange={onWorkspaceHealthChange}
              onComplete={onClose}
              autoAdvance={false}
            />
          )}
          {pane === "token" && <ApiTokenPane config={config} onConfigChange={onConfigChange} />}
          {pane === "preferences" && <PreferencesPane config={config} onConfigChange={onConfigChange} />}
        </div>
      </div>
    </div>
  );
}
