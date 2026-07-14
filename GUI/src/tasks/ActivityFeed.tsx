import { useEffect, useRef } from "react";
import type { FeedItem } from "./describeEvent";

const toneColor: Record<FeedItem["tone"], string> = {
  default: "var(--foreground)",
  muted: "var(--muted)",
  success: "var(--success)",
  danger: "var(--danger)",
};

export function ActivityFeed({ items }: { items: FeedItem[] }) {
  const bottomRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ block: "end" });
  }, [items.length]);

  return (
    <div
      style={{
        display: "flex",
        flexDirection: "column",
        gap: "0.5rem",
        maxHeight: "24rem",
        overflowY: "auto",
        padding: "0.25rem",
      }}
    >
      {items.length === 0 && <p style={{ color: "var(--muted)", fontSize: "0.875rem" }}>Waiting for Claude…</p>}
      {items.map((item) => (
        <div key={item.id} style={{ display: "flex", gap: "0.5rem", fontSize: "0.875rem", color: toneColor[item.tone] }}>
          <span aria-hidden="true">{item.icon}</span>
          <span style={{ whiteSpace: "pre-wrap", wordBreak: "break-word" }}>{item.text}</span>
        </div>
      ))}
      <div ref={bottomRef} />
    </div>
  );
}
