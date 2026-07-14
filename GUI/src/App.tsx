import { useEffect, useState } from "react";
import { ThemeProvider } from "./theme/ThemeProvider";
import { AppShell } from "./components/AppShell";
import { Spinner } from "./components/Spinner";
import { SetupDashboard } from "./onboarding/SetupDashboard";
import { Dashboard } from "./tasks/Dashboard";
import { TaskRunView } from "./tasks/TaskRunView";
import { RunningTaskBanner } from "./tasks/RunningTaskBanner";
import { checkWorkspaceHealth, detectTools, loadConfig } from "./lib/tauri";
import { isClaudeReady, isEnvReady, isGithubReady } from "./lib/readiness";
import type { AppConfig, ParsedTask, ToolStatus, WorkspaceHealth } from "./lib/types";

type Stage = "loading" | "setup" | "dashboard";

function App() {
  const [stage, setStage] = useState<Stage>("loading");
  const [config, setConfig] = useState<AppConfig | null>(null);
  const [toolStatus, setToolStatus] = useState<ToolStatus | null>(null);
  const [workspaceHealth, setWorkspaceHealth] = useState<WorkspaceHealth | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  // Reopens the same account screen onboarding uses, but without its
  // auto-advance-once-everything's-ready behavior - see SetupDashboard's
  // `autoAdvance` prop - since everything already being ready is the normal
  // case for opening settings, not a reason to immediately bounce back out.
  const [showSettings, setShowSettings] = useState(false);
  // The task whose run is currently mounted, lifted to the top level so it
  // survives navigating between the task list and settings (which swap out the
  // screen below). `viewingRun` toggles between looking at that run and the
  // rest of the app; while it's false the run stays mounted (and its feed
  // keeps updating), reachable again through the persistent banner.
  const [activeTask, setActiveTask] = useState<ParsedTask | null>(null);
  const [viewingRun, setViewingRun] = useState(false);

  const openTask = (task: ParsedTask) => {
    setActiveTask(task);
    setViewingRun(true);
  };

  useEffect(() => {
    // Every launch re-derives readiness from live checks - not from
    // whatever was true the last time setup finished - so a Claude/GitHub
    // logout or a deleted workspace surfaces immediately instead of being
    // masked by a stale "done" flag.
    Promise.all([loadConfig(), detectTools()])
      .then(async ([cfg, tools]) => {
        setConfig(cfg);
        setToolStatus(tools);
        const health = cfg.workspaceDir ? await checkWorkspaceHealth(cfg.workspaceDir).catch(() => null) : null;
        setWorkspaceHealth(health);
        const ready = isClaudeReady(cfg, tools) && isGithubReady(tools) && isEnvReady(health);
        setStage(ready ? "dashboard" : "setup");
      })
      .catch((e) => setLoadError(String(e)));
  }, []);

  const showAccountScreen = showSettings || stage === "setup";

  return (
    <ThemeProvider>
      <AppShell
        onSettingsClick={stage === "dashboard" && !viewingRun ? () => setShowSettings(true) : undefined}
        banner={
          activeTask && !viewingRun ? (
            <RunningTaskBanner taskName={activeTask.name} onReturn={() => setViewingRun(true)} />
          ) : undefined
        }
      >
        {loadError && (
          <div className="page" style={{ textAlign: "center" }}>
            <p style={{ color: "var(--danger)" }}>Couldn't start up: {loadError}</p>
          </div>
        )}

        {!loadError && stage === "loading" && (
          <div style={{ display: "flex", justifyContent: "center", marginTop: "4rem" }}>
            <Spinner label="Loading…" />
          </div>
        )}

        {/* The active run is kept mounted (so it survives switching to
            settings or the list) and simply hidden unless the user is
            currently viewing it. */}
        {!loadError && activeTask && config?.workspaceDir && (
          <div style={{ display: viewingRun ? "block" : "none" }}>
            <TaskRunView
              key={activeTask.name}
              task={activeTask}
              workspaceDir={config.workspaceDir}
              maxOpenAutoPrs={config.maxOpenAutoPrs}
              claudeOauthToken={config.claudeOauthToken}
              onMinimize={() => setViewingRun(false)}
              onExit={() => {
                setActiveTask(null);
                setViewingRun(false);
              }}
            />
          </div>
        )}

        {/* Everything else is hidden (not unmounted) while the run is on
            screen, so returning to it is instant and never restarts it. */}
        <div style={{ display: viewingRun ? "none" : "block" }}>
          {!loadError && showAccountScreen && config && toolStatus && (
            <SetupDashboard
              toolStatus={toolStatus}
              config={config}
              workspaceHealth={workspaceHealth}
              onConfigChange={setConfig}
              onToolStatusChange={setToolStatus}
              onWorkspaceHealthChange={setWorkspaceHealth}
              onComplete={(allReady) => {
                // Covers both first-time onboarding finishing (always
                // `allReady`) and "Back to tasks" from settings - if the user
                // signed out of something there and didn't sign back in,
                // this correctly routes to full onboarding instead of the
                // task dashboard rather than trusting a stale "done" state.
                setShowSettings(false);
                setStage(allReady ? "dashboard" : "setup");
              }}
              autoAdvance={!showSettings}
            />
          )}

          {!loadError && !showAccountScreen && stage === "dashboard" && config && (
            <Dashboard config={config} onSelectTask={openTask} />
          )}
        </div>
      </AppShell>
    </ThemeProvider>
  );
}

export default App;
