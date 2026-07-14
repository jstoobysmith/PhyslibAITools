import { useState } from "react";
import { Button } from "../components/Button";
import { DiffBlock } from "../components/CodeBlock";
import { appendChallengeVerdicts } from "./parseTask";
import type { StagedDiff } from "../lib/types";

export function DiffReview({
  diff,
  prTitle,
  prBody,
  challengeQuestions,
  busy,
  onConfirm,
  onStop,
}: {
  diff: StagedDiff;
  prTitle: string;
  prBody: string;
  challengeQuestions: string[];
  busy: boolean;
  onConfirm: (finalBody: string) => void;
  onStop: () => void;
}) {
  const [verdicts, setVerdicts] = useState<(("Yes" | "No") | null)[]>(() => challengeQuestions.map(() => null));

  const allAnswered = verdicts.every((v) => v !== null);
  const anyNo = verdicts.some((v) => v === "No");

  const confirm = () => {
    const withVerdicts = appendChallengeVerdicts(
      prBody,
      challengeQuestions.map((q, i) => ({ question: q, verdict: verdicts[i]! })),
    );
    onConfirm(withVerdicts);
  };

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: "1rem" }}>
      <div>
        <h3 style={{ fontSize: "0.95rem", marginBottom: "0.25rem" }}>Proposed pull request</h3>
        <p style={{ fontFamily: "var(--font-mono)", fontSize: "0.85rem", color: "var(--muted)" }}>{prTitle}</p>
      </div>

      <div>
        <p style={{ fontSize: "0.8125rem", color: "var(--muted)", marginBottom: "0.4rem" }}>{diff.stat.trim()}</p>
        <DiffBlock diff={diff.full} />
      </div>

      {challengeQuestions.length > 0 && (
        <div style={{ display: "flex", flexDirection: "column", gap: "0.75rem" }}>
          <h3 style={{ fontSize: "0.95rem" }}>Review checks</h3>
          {challengeQuestions.map((q, i) => (
            <div key={i} style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: "1rem" }}>
              <span style={{ fontSize: "0.875rem" }}>{q}</span>
              <div style={{ display: "flex", gap: "0.4rem" }}>
                <Button
                  size="sm"
                  variant={verdicts[i] === "Yes" ? "primary" : "secondary"}
                  onClick={() => setVerdicts((v) => v.map((x, j) => (j === i ? "Yes" : x)))}
                >
                  Yes
                </Button>
                <Button
                  size="sm"
                  variant={verdicts[i] === "No" ? "danger" : "secondary"}
                  onClick={() => setVerdicts((v) => v.map((x, j) => (j === i ? "No" : x)))}
                >
                  No
                </Button>
              </div>
            </div>
          ))}
        </div>
      )}

      {anyNo && allAnswered && (
        <p style={{ color: "var(--warning)", fontSize: "0.875rem" }}>
          You answered "No" to a review check - stopping here won't open a pull request. Your changes stay on the
          branch so you (or another run) can revise them.
        </p>
      )}

      <div style={{ display: "flex", gap: "0.6rem" }}>
        {anyNo && allAnswered ? (
          <Button variant="secondary" onClick={onStop} busy={busy}>
            Stop without opening a PR
          </Button>
        ) : (
          <Button onClick={confirm} disabled={!allAnswered} busy={busy}>
            Push branch & open pull request
          </Button>
        )}
      </div>
    </div>
  );
}
