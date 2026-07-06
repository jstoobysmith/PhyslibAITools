import type { ReactNode } from "react";
import physlibLogo from "../assets/physlib-logo.jpeg";
import { useTheme } from "../theme/ThemeProvider";
import { GearIcon } from "./icons";

function ThemeToggle() {
  const { mode, resolved, setMode } = useTheme();
  const next = resolved === "dark" ? "light" : "dark";
  return (
    <button
      className="btn btn--ghost btn--sm"
      title={`Theme: ${mode} (click to switch to ${next})`}
      onClick={() => setMode(next)}
      style={{ fontSize: "1rem", padding: "0.4rem 0.55rem" }}
    >
      {resolved === "dark" ? "🌙" : "☀️"}
    </button>
  );
}

/** Shared app chrome: a slim header carrying the Physlib mark, and a content
 * area. Every screen (setup dashboard, task dashboard, task run) renders
 * inside this shell. The settings gear (only shown once there's somewhere
 * useful for it to go) opens the same account screen onboarding used, so
 * users can sign out and switch their Claude/GitHub account on their own
 * without reinstalling or hunting for credential files. */
export function AppShell({ children, onSettingsClick }: { children: ReactNode; onSettingsClick?: () => void }) {
  return (
    <div style={{ display: "flex", flexDirection: "column", minHeight: "100vh" }}>
      <header
        style={{
          display: "flex",
          alignItems: "center",
          justifyContent: "space-between",
          padding: "0.7rem 1.5rem",
          borderBottom: "1px solid var(--border)",
          background: "var(--surface)",
          boxShadow: "var(--shadow-surface)",
          position: "sticky",
          top: 0,
          zIndex: 10,
        }}
      >
        <div style={{ display: "flex", alignItems: "center", gap: "0.7rem" }}>
          {/* The mark is a JPEG on a plain white background, so it gets a
              fixed-white chip rather than sitting bare on a dark surface. */}
          <div
            style={{
              background: "#fff",
              borderRadius: "0.4rem",
              padding: "0.25rem 0.5rem",
              display: "flex",
              alignItems: "center",
              lineHeight: 0,
            }}
          >
            <img src={physlibLogo} alt="Physlib" style={{ height: "1.1rem", width: "auto", display: "block" }} />
          </div>
          <span
            style={{
              fontWeight: 600,
              fontSize: "0.8125rem",
              color: "var(--muted)",
              borderLeft: "1px solid var(--border)",
              paddingLeft: "0.7rem",
            }}
          >
            PhyslibAITools
          </span>
        </div>
        <div style={{ display: "flex", alignItems: "center", gap: "0.4rem" }}>
          {onSettingsClick && (
            <button
              className="btn btn--ghost btn--sm"
              title="Settings - sign out or switch your Claude/GitHub account"
              onClick={onSettingsClick}
              style={{ padding: "0.4rem 0.55rem", display: "flex" }}
            >
              <GearIcon width={17} height={17} />
            </button>
          )}
          <ThemeToggle />
        </div>
      </header>
      <main
        style={{
          flex: 1,
          background: "radial-gradient(ellipse 900px 420px at 50% -8%, var(--accent-wash), transparent 70%)",
        }}
      >
        {children}
      </main>
    </div>
  );
}
