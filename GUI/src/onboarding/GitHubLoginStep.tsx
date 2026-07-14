import { useEffect, useState } from "react";
import { Button } from "../components/Button";
import { LogPane, type LogLine } from "../components/LogPane";
import { onEvent, openInBrowser, startGithubLogin } from "../lib/tauri";

type Phase = "idle" | "starting" | "waiting" | "error";

// GitHub's device-flow verification page is a fixed, well-known URL (not
// session-specific like Claude's OAuth URL) - the user enters the printed
// code there themselves.
const DEVICE_LOGIN_URL = "https://github.com/login/device";

/** The active GitHub login flow. Only rendered while signing in isn't done
 * yet - once it is, the parent dashboard shows a compact "connected" row
 * instead of mounting this.
 *
 * `gh auth login --web` normally opens the browser itself once you confirm
 * the prompt, but it does that check against its own stdio, which we've
 * piped (not a real TTY) - in practice it doesn't fire there, so this
 * component opens the verification page itself as soon as the code shows
 * up, rather than leaving the user staring at a code with no browser. */
export function GitHubLoginStep({ onDone }: { onDone: () => void }) {
  const [phase, setPhase] = useState<Phase>("idle");
  const [code, setCode] = useState<string | null>(null);
  const [lines, setLines] = useState<LogLine[]>([]);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const subs = [
      onEvent<string>("github-login:line", (text) => setLines((l) => [...l, { text }])),
      onEvent<{ code: string }>("github-login:code", ({ code }) => {
        setCode(code);
        setPhase("waiting");
        openInBrowser(DEVICE_LOGIN_URL).catch(() => {});
      }),
      onEvent<{ success: boolean }>("github-login:done", ({ success }) => {
        if (success) {
          onDone();
        } else {
          setError("GitHub login didn't finish successfully. Check the log below, or try again.");
          setPhase("error");
        }
      }),
    ];
    return () => {
      subs.forEach((p) => p.then((unlisten) => unlisten()));
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const start = async () => {
    setPhase("starting");
    setLines([]);
    setError(null);
    setCode(null);
    try {
      await startGithubLogin();
    } catch (e) {
      setError(String(e));
      setPhase("error");
    }
  };

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: "0.85rem" }}>
      {(phase === "idle" || phase === "starting") && (
        <Button onClick={start} busy={phase === "starting"}>
          Sign in to GitHub
        </Button>
      )}

      {phase === "waiting" && code && (
        <div className="card" style={{ padding: "0.9rem", textAlign: "center", background: "var(--accent-wash)" }}>
          <p className="caption" style={{ marginBottom: "0.35rem" }}>
            Confirm this code in the browser window that just opened:
          </p>
          <p style={{ fontFamily: "var(--font-mono)", fontSize: "1.4rem", letterSpacing: "0.05em", fontWeight: 600 }}>
            {code}
          </p>
        </div>
      )}

      {phase === "error" && (
        <div style={{ display: "flex", flexDirection: "column", gap: "0.5rem" }}>
          <p style={{ color: "var(--danger)" }}>{error}</p>
          <Button variant="secondary" onClick={start}>
            Try again
          </Button>
        </div>
      )}

      {lines.length > 0 && <LogPane lines={lines} maxHeight="8rem" />}
    </div>
  );
}
