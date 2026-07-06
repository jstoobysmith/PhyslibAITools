import { Spinner } from "../components/Spinner";

/** A slim, always-present bar shown under the header whenever a task run is
 * still mounted in the background (the user stepped away from it). It sits
 * above every screen - task list and settings alike - so an in-progress run
 * is never lost or hidden. Clicking it returns to the live run view. */
export function RunningTaskBanner({ taskName, onReturn }: { taskName: string; onReturn: () => void }) {
  return (
    <button
      type="button"
      onClick={onReturn}
      style={{
        display: "flex",
        alignItems: "center",
        justifyContent: "space-between",
        gap: "1rem",
        width: "100%",
        textAlign: "left",
        padding: "0.6rem 1.5rem",
        border: "none",
        borderBottom: "1px solid var(--accent)",
        background: "var(--accent-wash)",
        cursor: "pointer",
        position: "sticky",
        top: 0,
        zIndex: 9,
      }}
    >
      <span style={{ display: "flex", alignItems: "center", gap: "0.7rem", minWidth: 0 }}>
        <Spinner />
        <span style={{ fontSize: "0.8125rem", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
          <span style={{ fontWeight: 600 }}>Task in progress: {taskName}</span>
          <span style={{ color: "var(--muted)" }}> — Claude is still working in the background.</span>
        </span>
      </span>
      <span style={{ fontWeight: 600, color: "var(--accent)", flexShrink: 0, fontSize: "0.8125rem" }}>Return →</span>
    </button>
  );
}
