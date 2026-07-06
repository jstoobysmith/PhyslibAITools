import { useEffect, useRef, useState } from "react";
import { Button } from "../components/Button";
import { Card } from "../components/Card";
import { Spinner } from "../components/Spinner";
import { ActivityFeed } from "./ActivityFeed";
import { describeEvent, type FeedItem } from "./describeEvent";
import { InputQuestionsForm } from "./InputQuestionsForm";
import { DiffReview } from "./DiffReview";
import { buildPromptWithAnswers } from "./parseTask";
import { confirmAndOpenPr, onEvent, openInBrowser, startTaskRun } from "../lib/tauri";
import type { ParsedTask, RunTaskFinished } from "../lib/types";

type Phase = "questions" | "starting" | "running" | "review" | "not-finished" | "success" | "error";

let feedCounter = 0;

export function TaskRunView({
  task,
  workspaceDir,
  maxOpenAutoPrs,
  claudeOauthToken,
  onMinimize,
  onExit,
}: {
  task: ParsedTask;
  workspaceDir: string;
  maxOpenAutoPrs: number;
  claudeOauthToken: string | null;
  // Leave the run going and return to the list (the run stays mounted).
  onMinimize: () => void;
  // The run is over (or abandoned) - discard it and return to the list.
  onExit: () => void;
}) {
  const [phase, setPhase] = useState<Phase>(task.inputQuestions.length > 0 ? "questions" : "starting");
  const [items, setItems] = useState<FeedItem[]>([]);
  const [branch, setBranch] = useState<string | null>(null);
  const [finished, setFinished] = useState<RunTaskFinished | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [prUrl, setPrUrl] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  // Tauri doesn't replay events fired before a listener registers, and
  // `claude -p` can start emitting stream-json lines within milliseconds -
  // faster, in the worst case, than the listener-registration round-trip
  // below. Gate the auto-start path (no input questions) on listeners being
  // confirmed ready first, the same fix as the Claude login terminal hang.
  const [listenersReady, setListenersReady] = useState(false);
  const startedRef = useRef(false);

  useEffect(() => {
    const subs = [
      onEvent<unknown>("task-run:event", (value) => {
        const item = describeEvent(value);
        if (item) setItems((l) => [...l, item]);
      }),
      onEvent<string>("task-run:stderr", (text) =>
        setItems((l) => [...l, { id: `stderr-${feedCounter++}`, icon: "⚠", text, tone: "danger" }]),
      ),
      onEvent<RunTaskFinished>("task-run:finished", (f) => {
        setFinished(f);
        if (f.error) {
          setError(f.error);
          setPhase("error");
        } else if (!f.couldFinish) {
          setPhase("not-finished");
        } else {
          setPhase("review");
        }
      }),
    ];
    void Promise.all(subs).then(() => setListenersReady(true));
    return () => {
      subs.forEach((p) => p.then((unlisten) => unlisten()));
    };
  }, []);

  const start = async (answers: { question: string; answer: string }[]) => {
    setPhase("running");
    setItems([]);
    setError(null);
    try {
      const prompt = buildPromptWithAnswers(task.prompt, answers);
      const started = await startTaskRun({ workspaceDir, taskName: task.name, prompt, maxOpenAutoPrs, claudeOauthToken });
      setBranch(started.branch);
    } catch (e) {
      setError(String(e));
      setPhase("error");
    }
  };

  useEffect(() => {
    if (phase === "starting" && listenersReady && !startedRef.current) {
      startedRef.current = true;
      void start([]);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [phase, listenersReady]);

  // Once the run has reached one of these, there's nothing left running to
  // return to, so leaving discards it rather than minimizing.
  const isTerminal = phase === "success" || phase === "error" || phase === "not-finished";

  const confirmPr = async (finalBody: string) => {
    if (!branch || !finished?.prTitle) return;
    setBusy(true);
    try {
      const result = await confirmAndOpenPr({ workspaceDir, branch, title: finished.prTitle, body: finalBody });
      setPrUrl(result.url);
      setPhase("success");
    } catch (e) {
      setError(String(e));
      setPhase("error");
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="page" style={{ display: "flex", flexDirection: "column", gap: "1.25rem" }}>
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between" }}>
        <h2 className="page-title">{task.name}</h2>
        {isTerminal ? (
          <Button variant="ghost" size="sm" onClick={onExit}>
            ← Back to tasks
          </Button>
        ) : (
          // Non-terminal: leave the run mounted and return to the list, where a
          // banner brings you straight back here. While Claude is actively
          // working we call that out so it's clear the run isn't cancelled.
          <Button variant="ghost" size="sm" onClick={onMinimize}>
            {phase === "starting" || phase === "running" ? "← Back to tasks (keeps running)" : "← Back to tasks"}
          </Button>
        )}
      </div>

      <Card>
        {phase === "questions" && (
          <InputQuestionsForm questions={task.inputQuestions} onSubmit={(answers) => start(answers)} onCancel={onExit} />
        )}

        {(phase === "starting" || phase === "running") && (
          <div style={{ display: "flex", flexDirection: "column", gap: "0.75rem" }}>
            <Spinner label={branch ? `Working on branch ${branch}…` : "Starting…"} />
            <ActivityFeed items={items} />
          </div>
        )}

        {phase === "review" && finished?.diff && finished.prTitle && (
          <DiffReview
            diff={finished.diff}
            prTitle={finished.prTitle}
            prBody={finished.prBody ?? ""}
            challengeQuestions={task.challengeQuestions}
            busy={busy}
            onConfirm={confirmPr}
            onStop={onExit}
          />
        )}

        {phase === "not-finished" && (
          <div style={{ display: "flex", flexDirection: "column", gap: "0.75rem" }}>
            <p style={{ color: "var(--warning)" }}>Claude couldn't complete this task while keeping the build green.</p>
            <p style={{ color: "var(--muted)", fontSize: "0.875rem" }}>
              Nothing was pushed{branch ? ` - your branch (${branch}) still has whatever was staged` : ""}, in case
              you want to pick it up by hand.
            </p>
            <ActivityFeed items={items} />
            <Button variant="secondary" onClick={onExit}>
              Back to tasks
            </Button>
          </div>
        )}

        {phase === "success" && prUrl && (
          <div style={{ display: "flex", flexDirection: "column", gap: "0.75rem" }}>
            <p style={{ color: "var(--success)" }}>✓ Pull request opened!</p>
            <div style={{ display: "flex", gap: "0.6rem" }}>
              <Button onClick={() => openInBrowser(prUrl)}>Open the pull request ↗</Button>
              <Button variant="ghost" onClick={onExit}>
                Back to tasks
              </Button>
            </div>
          </div>
        )}

        {phase === "error" && (
          <div style={{ display: "flex", flexDirection: "column", gap: "0.75rem" }}>
            <p style={{ color: "var(--danger)" }}>{error}</p>
            <Button variant="secondary" onClick={onExit}>
              Back to tasks
            </Button>
          </div>
        )}
      </Card>
    </div>
  );
}
