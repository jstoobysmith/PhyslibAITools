import type { ReactNode } from "react";

type BadgeTone = "neutral" | "success" | "warning" | "danger" | "accent";

export function Badge({ tone = "neutral", children }: { tone?: BadgeTone; children: ReactNode }) {
  return <span className={`badge badge--${tone}`}>{children}</span>;
}
