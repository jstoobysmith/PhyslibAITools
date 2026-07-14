import type { ReactNode } from "react";
import { CheckIcon } from "../components/icons";

export type SectionStatus = "pending" | "active" | "done";

/** One row in the setup timeline: an icon/vertex on the left connected by a
 * trace to the next step, and the step's own content on the right. Status
 * drives the vertex's fill (open outline → accent outline → solid accent
 * with a check) and whether the connecting line below has "filled in". */
export function SetupSection({
  icon,
  title,
  description,
  status,
  isLast = false,
  disabledReason,
  children,
}: {
  icon: ReactNode;
  title: string;
  description: string;
  status: SectionStatus;
  isLast?: boolean;
  disabledReason?: string;
  children: ReactNode;
}) {
  return (
    <div className="timeline-item">
      <div className="timeline-rail">
        <div
          className={
            status === "done"
              ? "timeline-node timeline-node--done"
              : status === "active"
                ? "timeline-node timeline-node--active"
                : "timeline-node"
          }
        >
          {status === "done" ? <CheckIcon width={16} height={16} /> : icon}
        </div>
        {!isLast && <div className={status === "done" ? "timeline-connector timeline-connector--filled" : "timeline-connector"} />}
      </div>
      <div className="timeline-content">
        <h3 className="section-title" style={{ marginBottom: "0.2rem" }}>
          {title}
        </h3>
        <p className="page-subtitle" style={{ marginBottom: status === "pending" ? 0 : "0.9rem" }}>
          {description}
        </p>
        {status === "pending" ? (
          disabledReason && <p className="caption" style={{ marginTop: "0.5rem" }}>{disabledReason}</p>
        ) : (
          children
        )}
      </div>
    </div>
  );
}
