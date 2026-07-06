import { useEffect, useRef, useState, type CSSProperties } from "react";
import { Button } from "../components/Button";
import {
  cancelClaudeLogin,
  claudeStatus,
  currentPlatform,
  onEvent,
  openClaudeLoginTerminal,
  openInBrowser,
  startClaudeLogin,
  verifyClaudeOauthToken,
} from "../lib/tauri";
import type { ClaudeLoginEvent } from "../lib/types";

type Phase = "idle" | "starting" | "waiting-for-approval" | "error";
type FallbackPhase = "hidden" | "waiting" | "verifying" | "fallback-error";

/** Claude Code sign-in. On Windows this is fully automatic: `claude
 * setup-token` runs in a real Windows console (so it gets correct
 * terminal-query handling from `conhost.exe` itself, same as a normal
 * visible terminal) that's simply never shown, and this app reads its
 * printed sign-in link and final token straight out of that console's
 * buffer - no PTY, no manual copy-paste. See `auth_claude.rs` for why
 * earlier PTY-based attempts at this weren't reliable and what's different
 * here.
 *
 * That technique is Windows-only, so elsewhere `start_claude_login` always
 * fails - `currentPlatform()` is checked up front so this component never
 * calls it on macOS/Linux and never shows that as a scary error flash;
 * "Sign in to Claude Code" just goes straight to the terminal-based
 * open-a-terminal-and-paste-the-token flow there. The same fallback is also
 * offered on Windows itself if the automatic flow ever fails there too. */
export function ClaudeLoginStep({ onDone }: { onDone: (token: string | null) => void }) {
  const [phase, setPhase] = useState<Phase>("idle");
  const [error, setError] = useState<string | null>(null);
  const [signInUrl, setSignInUrl] = useState<string | null>(null);

  // Assumed true until `currentPlatform()` resolves (near-instant, and
  // Windows is the common case) so the UI doesn't flash the wrong copy.
  const [automaticAvailable, setAutomaticAvailable] = useState(true);

  const [fallback, setFallback] = useState<FallbackPhase>("hidden");
  const [token, setToken] = useState("");
  const [fallbackError, setFallbackError] = useState<string | null>(null);

  const [checking, setChecking] = useState(false);
  const [checkMessage, setCheckMessage] = useState<string | null>(null);

  const inProgress = useRef(false);

  useEffect(() => {
    currentPlatform()
      .then((p) => setAutomaticAvailable(p === "windows"))
      .catch(() => {});
  }, []);

  useEffect(() => {
    return () => {
      if (inProgress.current) {
        cancelClaudeLogin().catch(() => {});
      }
    };
  }, []);

  const start = async () => {
    if (!automaticAvailable) {
      setPhase("starting");
      await startFallbackTerminal();
      setPhase("idle");
      return;
    }

    setPhase("starting");
    setError(null);
    setSignInUrl(null);

    const unlisten = await onEvent<ClaudeLoginEvent>("claude-login", (ev) => {
      if (ev.kind === "url") {
        setSignInUrl(ev.url);
        setPhase("waiting-for-approval");
      } else if (ev.kind === "done") {
        inProgress.current = false;
        unlisten();
        onDone(ev.token);
      } else if (ev.kind === "error") {
        inProgress.current = false;
        unlisten();
        setError(ev.message);
        setPhase("error");
      }
    });

    try {
      inProgress.current = true;
      await startClaudeLogin();
    } catch (e) {
      inProgress.current = false;
      unlisten();
      setError(String(e));
      setPhase("error");
    }
  };

  const cancel = async () => {
    inProgress.current = false;
    await cancelClaudeLogin().catch(() => {});
    setPhase("idle");
    setSignInUrl(null);
  };

  const useFallback = () => {
    setPhase("idle");
    setFallback("hidden");
    startFallbackTerminal();
  };

  const startFallbackTerminal = async () => {
    setFallbackError(null);
    try {
      await openClaudeLoginTerminal();
      setFallback("waiting");
    } catch (e) {
      setFallbackError(String(e));
      setFallback("fallback-error");
    }
  };

  const saveFallbackToken = async () => {
    setFallback("verifying");
    setFallbackError(null);
    try {
      await verifyClaudeOauthToken(token);
      onDone(token.trim());
    } catch (e) {
      setFallbackError(String(e));
      setFallback("waiting");
    }
  };

  const checkAlreadySignedIn = async () => {
    setChecking(true);
    setCheckMessage(null);
    try {
      const signedIn = await claudeStatus();
      if (signedIn) {
        onDone(null);
      } else {
        setCheckMessage("Not detected yet. If you used /login in a terminal, make sure it fully finished.");
      }
    } finally {
      setChecking(false);
    }
  };

  if (fallback !== "hidden") {
    return (
      <div style={{ display: "flex", flexDirection: "column", gap: "0.6rem" }}>
        <p className="caption">
          A terminal window opened running <code>claude setup-token</code>. Follow its instructions there - open
          the link it shows and approve access. When it finishes, it prints a token starting with{" "}
          <code>sk-ant-</code>. Copy that and paste it below.
        </p>
        <div style={{ display: "flex", gap: "0.5rem" }}>
          <input
            placeholder="Paste your token here"
            value={token}
            onChange={(e) => setToken(e.currentTarget.value)}
            style={inputStyle}
          />
          <Button onClick={saveFallbackToken} disabled={!token.trim()} busy={fallback === "verifying"}>
            Save
          </Button>
        </div>
        {fallbackError && <p style={{ color: "var(--danger)", fontSize: "0.8125rem" }}>{fallbackError}</p>}
        <div style={{ display: "flex", flexDirection: "column", gap: "0.3rem", marginTop: "0.25rem" }}>
          <button type="button" onClick={checkAlreadySignedIn} disabled={checking} style={linkStyle}>
            {checking ? "Checking…" : "I signed in a different way - check again"}
          </button>
          {checkMessage && <p className="caption">{checkMessage}</p>}
        </div>
        <Button variant="ghost" size="sm" onClick={() => setFallback("hidden")} style={{ alignSelf: "flex-start" }}>
          Back
        </Button>
      </div>
    );
  }

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: "0.85rem" }}>
      {(phase === "idle" || phase === "starting") && (
        <>
          <p className="caption">
            {automaticAvailable
              ? "Signs you in with your Claude subscription - opens your browser to approve, then finishes on its own."
              : "Opens a terminal to sign in with your Claude subscription."}
          </p>
          <Button onClick={start} busy={phase === "starting"}>
            Sign in to Claude Code
          </Button>
          <button type="button" onClick={checkAlreadySignedIn} disabled={checking} style={linkStyle}>
            {checking ? "Checking…" : "I already signed in a different way - check again"}
          </button>
          {checkMessage && <p className="caption">{checkMessage}</p>}
        </>
      )}

      {phase === "waiting-for-approval" && (
        <div style={{ display: "flex", flexDirection: "column", gap: "0.6rem" }}>
          <p className="caption">
            Opening your browser to approve access - finish there, and this continues automatically. If nothing
            opened, {" "}
            <button type="button" onClick={() => signInUrl && openInBrowser(signInUrl)} style={linkStyle}>
              click here
            </button>
            .
          </p>
          <Button variant="ghost" size="sm" onClick={cancel} style={{ alignSelf: "flex-start" }}>
            Cancel
          </Button>
        </div>
      )}

      {phase === "error" && (
        <div style={{ display: "flex", flexDirection: "column", gap: "0.5rem" }}>
          <p style={{ color: "var(--danger)" }}>{error}</p>
          <div style={{ display: "flex", gap: "0.5rem" }}>
            <Button variant="secondary" onClick={start}>
              Try again
            </Button>
            <Button variant="ghost" onClick={useFallback}>
              Sign in with a terminal instead
            </Button>
          </div>
        </div>
      )}
    </div>
  );
}

const inputStyle: CSSProperties = {
  flex: 1,
  padding: "0.6rem 0.8rem",
  borderRadius: "var(--radius)",
  border: "1px solid var(--border)",
  background: "var(--background)",
  color: "var(--foreground)",
  fontFamily: "var(--font-mono)",
  fontSize: "0.8125rem",
};

const linkStyle: CSSProperties = {
  background: "none",
  border: "none",
  color: "var(--muted)",
  fontSize: "0.8125rem",
  textAlign: "left",
  cursor: "pointer",
  padding: 0,
};
