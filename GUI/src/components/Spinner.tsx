export function Spinner({ label }: { label?: string }) {
  return (
    <span style={{ display: "inline-flex", alignItems: "center", gap: "0.5rem" }}>
      <span className="spinner" aria-hidden="true" />
      {label && <span style={{ color: "var(--muted)", fontSize: "0.875rem" }}>{label}</span>}
    </span>
  );
}
