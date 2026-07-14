import { useState } from "react";
import { Button } from "../components/Button";

export function InputQuestionsForm({
  questions,
  onSubmit,
  onCancel,
}: {
  questions: string[];
  onSubmit: (answers: { question: string; answer: string }[]) => void;
  onCancel: () => void;
}) {
  const [answers, setAnswers] = useState<string[]>(() => questions.map(() => ""));

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: "1rem" }}>
      <p style={{ color: "var(--muted)" }}>A couple of quick questions before Claude starts:</p>
      {questions.map((q, i) => (
        <label key={i} style={{ display: "flex", flexDirection: "column", gap: "0.35rem", fontSize: "0.875rem" }}>
          <span>{q}</span>
          <textarea
            value={answers[i]}
            onChange={(e) => {
              const next = [...answers];
              next[i] = e.currentTarget.value;
              setAnswers(next);
            }}
            rows={2}
            style={{
              padding: "0.6rem 0.8rem",
              borderRadius: "var(--radius)",
              border: "1px solid var(--border)",
              background: "var(--background)",
              color: "var(--foreground)",
              fontFamily: "var(--font-sans)",
              fontSize: "0.875rem",
              resize: "vertical",
            }}
          />
        </label>
      ))}
      <div style={{ display: "flex", gap: "0.6rem" }}>
        <Button onClick={() => onSubmit(questions.map((q, i) => ({ question: q, answer: answers[i] })))}>
          Start task
        </Button>
        <Button variant="secondary" onClick={onCancel}>
          Cancel
        </Button>
      </div>
    </div>
  );
}
