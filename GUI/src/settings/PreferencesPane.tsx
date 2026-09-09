import { Button } from "../components/Button";
import { WorkspacePicker } from "./WorkspacePicker";
import { useTheme } from "../theme/ThemeProvider";
import { MODEL_CHOICES } from "../missions/missionStore";
import { saveConfig } from "../lib/tauri";
import type { AppConfig } from "../lib/types";
import type { ThemeMode } from "../theme/tokens";

const THEMES: { id: ThemeMode; label: string }[] = [
  { id: "light", label: "Light" },
  { id: "dark", label: "Dark" },
  { id: "system", label: "System" },
];

/** The handful of settings that aren't credentials: which model new missions
 *  start on, how many automated PRs this app is willing to have open at once,
 *  and the theme. */
export function PreferencesPane({
  config,
  onConfigChange,
}: {
  config: AppConfig;
  onConfigChange: (config: AppConfig) => void;
}) {
  const { mode, setMode } = useTheme();

  const persist = (patch: Partial<AppConfig>) => {
    const next = { ...config, ...patch };
    onConfigChange(next);
    void saveConfig(next);
  };

  return (
    <section className="pane">
      <h2>Preferences</h2>

      <label className="pane__field">
        <span className="pane__label">Default model for new missions</span>
        <select
          className="mfield__input"
          value={config.defaultMissionModel ?? ""}
          onChange={(e) => persist({ defaultMissionModel: e.target.value || null })}
        >
          {MODEL_CHOICES.map((choice) => (
            <option key={choice.label} value={choice.id ?? ""}>
              {choice.label} — {choice.hint}
            </option>
          ))}
        </select>
        <span className="pane__muted">
          Only the starting point. Each mission carries its own model, changeable from its toolbar before any run.
        </span>
      </label>

      <label className="pane__field">
        <span className="pane__label">Open automated pull requests to allow</span>
        <input
          type="number"
          className="mfield__input pane__number"
          min={1}
          max={100}
          value={config.maxOpenAutoPrs}
          onChange={(e) => {
            const n = Number(e.target.value);
            if (Number.isFinite(n) && n >= 1) persist({ maxOpenAutoPrs: Math.min(100, Math.round(n)) });
          }}
        />
        <span className="pane__muted">
          A task run refuses to start if more than this many <code>auto-</code> pull requests are already open on
          Physlib. It's a courtesy limit shared with the command-line harness, so a lot of people running this at
          once can't bury the maintainers. Missions never open pull requests and ignore it.
        </span>
      </label>

      <div className="pane__field">
        <span className="pane__label">Theme</span>
        <div className="pane__choices">
          {THEMES.map((t) => (
            <Button
              key={t.id}
              size="sm"
              variant={mode === t.id ? "primary" : "secondary"}
              onClick={() => setMode(t.id)}
            >
              {t.label}
            </Button>
          ))}
        </div>
      </div>

      <WorkspacePicker current={config.workspaceDir} onChoose={(dir) => persist({ workspaceDir: dir })} />
      <p className="pane__muted">
        Where Physlib and Mathlib are checked out and built. You don't need a clone of the app's own — any Physlib
        working copy you already have will do, and pointing at a built one skips the wait entirely.
      </p>
    </section>
  );
}
