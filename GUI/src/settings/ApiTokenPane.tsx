import { useState } from "react";
import { Badge } from "../components/Badge";
import { Button } from "../components/Button";
import { openClaudeLoginTerminal, saveConfig, verifyClaudeOauthToken } from "../lib/tauri";
import type { AppConfig } from "../lib/types";

/**
 * The Claude credential every agent run uses - both task runs and mission
 * agents. It is passed to `claude` as `CLAUDE_CODE_OAUTH_TOKEN`.
 *
 * A pasted token is *verified before it is saved*: `claude setup-token`
 * doesn't store it anywhere itself (see auth_claude.rs), so this config is the
 * only copy, and saving a bad one would break every run with an error that
 * looks like it came from somewhere else.
 *
 * The stored token is never redisplayed in full. There is no way to recover
 * one from here anyway - the honest options are "keep it" or "replace it" -
 * and a credential sitting in plain text on screen is worth avoiding even on
 * the user's own machine.
 */
export function ApiTokenPane({
  config,
  onConfigChange,
}: {
  config: AppConfig;
  onConfigChange: (config: AppConfig) => void;
}) {
  const [value, setValue] = useState("");
  const [state, setState] = useState<"idle" | "checking" | "saved">("idle");
  const [error, setError] = useState<string | null>(null);

  const stored = config.claudeOauthToken;

  const persist = async (token: string | null) => {
    const next = { ...config, claudeOauthToken: token };
    onConfigChange(next);
    await saveConfig(next);
  };

  const save = async () => {
    const token = value.trim();
    if (!token) return;
    setState("checking");
    setError(null);
    try {
      await verifyClaudeOauthToken(token);
      await persist(token);
      setValue("");
      setState("saved");
    } catch (e) {
      setError(String(e));
      setState("idle");
    }
  };

  const clear = async () => {
    setError(null);
    setState("idle");
    await persist(null);
  };

  return (
    <section className="pane">
      <h2>Claude API token</h2>
      <p className="pane__lede">
        The credential every run uses — the task runner and the mission agents both. It's stored in this app's own
        config file, not inside your Physlib checkout, and is never sent anywhere except to the{" "}
        <code>claude</code> command on this machine.
      </p>

      <div className="pane__row">
        <span className="pane__label">Current</span>
        {stored ? (
          <>
            <Badge tone="success">Set</Badge>
            <code className="pane__masked">{mask(stored)}</code>
          </>
        ) : (
          <Badge tone="warning">Not set</Badge>
        )}
        {stored && (
          <Button variant="ghost" size="sm" onClick={clear}>
            Remove
          </Button>
        )}
      </div>

      {!stored && (
        <p className="pane__muted">
          Without a token here, runs fall back on whatever login the <code>claude</code> CLI already has on this
          machine. That works — this is only needed if you'd rather this app carry its own credential, or the CLI
          isn't signed in.
        </p>
      )}

      <label className="pane__field">
        <span className="pane__label">{stored ? "Replace it" : "Add one"}</span>
        <input
          type="password"
          className="mfield__input"
          value={value}
          placeholder="Paste a token from `claude setup-token`"
          autoComplete="off"
          spellCheck={false}
          onChange={(e) => {
            setValue(e.target.value);
            setState("idle");
          }}
        />
      </label>

      <div className="pane__actions">
        <Button size="sm" busy={state === "checking"} disabled={!value.trim()} onClick={save}>
          {state === "checking" ? "Checking…" : "Verify and save"}
        </Button>
        <Button variant="secondary" size="sm" onClick={() => void openClaudeLoginTerminal()}>
          Get a token
        </Button>
        {state === "saved" && <span className="pane__ok">Saved.</span>}
      </div>

      {error && <p className="pane__error">{error}</p>}

      <p className="pane__muted">
        “Get a token” opens a terminal running <code>claude setup-token</code>. Copy what it prints and paste it
        above — it's checked against the API before anything is saved, so a mistyped token is caught here rather
        than halfway through a run.
      </p>
    </section>
  );
}

/** Enough to tell two tokens apart, not enough to use. */
function mask(token: string): string {
  if (token.length <= 12) return "••••••••";
  return `${token.slice(0, 8)}…${token.slice(-4)}`;
}
