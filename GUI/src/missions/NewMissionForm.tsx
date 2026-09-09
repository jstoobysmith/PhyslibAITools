import { useState } from "react";
import { Button } from "../components/Button";
import { Card } from "../components/Card";
import { SourceEditor } from "./SourceEditor";
import { MODEL_CHOICES, newMission, saveMission } from "./missionStore";
import type { Mission, MissionSource } from "./missionTypes";

const KNOWN_STATUS: { value: Mission["knownStatus"]; label: string; hint: string }[] = [
  {
    value: "unknown",
    label: "I'm not sure",
    hint: "The agent works it out from the literature. Safest choice.",
  },
  {
    value: "solved",
    label: "It has a known solution",
    hint: "The graph is decomposed all the way down to Mathlib and Physlib, connected to the goal.",
  },
  {
    value: "open",
    label: "It's an open problem",
    hint: "The graph is built as far as the literature supports, then stops. The space up to the goal is left empty.",
  },
];

/**
 * Creating a mission. The record is saved as soon as there's a title, because
 * attached files are copied into the mission's own folder and that folder
 * needs to exist first — which also means an abandoned draft leaves a mission
 * behind, so attaching sources is made part of creating it rather than a
 * separate later action. Sources can still be edited afterwards, from the
 * mission itself.
 */
export function NewMissionForm({
  defaultModel,
  onCancel,
  onCreate,
}: {
  defaultModel: string | null;
  onCancel: () => void;
  onCreate: (mission: Mission) => void;
}) {
  const [draft, setDraft] = useState<Mission | null>(null);
  const [title, setTitle] = useState("");
  const [problem, setProblem] = useState("");
  const [knownStatus, setKnownStatus] = useState<Mission["knownStatus"]>("unknown");
  const [sources, setSources] = useState<MissionSource[]>([]);
  const [model, setModel] = useState<string | null>(defaultModel);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const ready = title.trim().length > 2 && problem.trim().length > 20;

  /** Attached files need somewhere to land, so the first attachment is what
   *  actually brings the mission folder into being. */
  const ensureDraft = async (): Promise<Mission> => {
    if (draft) return draft;
    const mission = { ...newMission(title, problem, knownStatus) };
    await saveMission(mission);
    setDraft(mission);
    return mission;
  };

  // The source editor needs a mission id before it can copy a file in, so the
  // draft is created lazily the first time this panel is touched.
  const [sourceMission, setSourceMission] = useState<Mission | null>(null);
  const openSources = async () => {
    try {
      setSourceMission(await ensureDraft());
    } catch (e) {
      setError(String(e));
    }
  };

  const create = async () => {
    setBusy(true);
    setError(null);
    try {
      const base = await ensureDraft();
      onCreate({
        ...base,
        title: title.trim(),
        problem: problem.trim(),
        knownStatus,
        openProblem: knownStatus === "open",
        sources,
        model,
        updatedAt: new Date().toISOString(),
      });
    } catch (e) {
      setError(String(e));
      setBusy(false);
    }
  };

  return (
    <div className="page mnew">
      <button className="btn btn--ghost btn--sm" onClick={onCancel}>
        ← Missions
      </button>
      <h1>New mission</h1>
      <p className="mhome__lede">
        Everything here goes to the agent as-is. The more precisely you state what you want proved — and what
        "proved" would mean — the better the decomposition it comes back with.
      </p>

      {error && <div className="mbanner mbanner--bad">{error}</div>}

      <Card className="mnew__card">
        <label className="mfield">
          <span className="mfield__label">Title</span>
          <input
            className="mfield__input"
            value={title}
            placeholder="e.g. Huang's Sensitivity Conjecture"
            onChange={(e) => setTitle(e.target.value)}
          />
        </label>

        <label className="mfield">
          <span className="mfield__label">
            The problem, in your own words — what the goal theorem says, what it's about, any definitions or
            conventions that matter, and how faithful the formalization has to be
          </span>
          <textarea
            className="mfield__input"
            rows={10}
            value={problem}
            placeholder={
              "For every integer n ≥ 1, let H be an arbitrary (2^(n−1) + 1)-vertex induced subgraph of the " +
              "n-dimensional hypercube Q_n. Then the maximum degree of H is at least √n.\n\n" +
              "I want the goal stated for a Finset of Boolean vectors rather than a SimpleGraph, because…"
            }
            onChange={(e) => setProblem(e.target.value)}
          />
        </label>

        <fieldset className="mfield mfield--group">
          <span className="mfield__label">What do you know about it?</span>
          {KNOWN_STATUS.map((option) => (
            <label key={option.value} className={`mradio ${knownStatus === option.value ? "mradio--on" : ""}`}>
              <input
                type="radio"
                name="knownStatus"
                checked={knownStatus === option.value}
                onChange={() => setKnownStatus(option.value)}
              />
              <span>
                <strong>{option.label}</strong>
                <span className="minspect__muted"> — {option.hint}</span>
              </span>
            </label>
          ))}
        </fieldset>

        <label className="mfield">
          <span className="mfield__label">
            Model — which Claude model runs the agent. You can change it per run later.
          </span>
          <select className="mfield__input" value={model ?? ""} onChange={(e) => setModel(e.target.value || null)}>
            {MODEL_CHOICES.map((choice) => (
              <option key={choice.label} value={choice.id ?? ""}>
                {choice.label} — {choice.hint}
              </option>
            ))}
          </select>
        </label>

        <div className="mfield">
          <span className="mfield__label">
            Sources (optional) — papers, notes and links. The agent reads every one before it starts.
          </span>
          {sourceMission ? (
            <SourceEditor mission={{ ...sourceMission, sources }} onChange={setSources} />
          ) : (
            <>
              <Button variant="secondary" size="sm" busy={busy} onClick={openSources} disabled={!title.trim()}>
                Add papers or links
              </Button>
              {!title.trim() && <p className="minspect__muted">Give the mission a title first.</p>}
            </>
          )}
        </div>
      </Card>

      <div className="mnew__actions">
        <Button disabled={!ready} busy={busy} onClick={create}>
          Create and generate the graph
        </Button>
        <Button variant="ghost" onClick={onCancel}>
          Cancel
        </Button>
      </div>
      <p className="minspect__muted">
        Generation runs an agent that reads your papers, researches the problem, and typechecks every statement it
        writes with Lean. Expect it to take a while.
      </p>
    </div>
  );
}
