import { useState } from "react";
import { Button } from "../components/Button";
import { importFileSources, makeLinkSource, pickSourceFiles, removeFileSource } from "./missionStore";
import type { Mission, MissionSource } from "./missionTypes";

const humanSize = (bytes: number) =>
  bytes > 1_000_000 ? `${(bytes / 1_000_000).toFixed(1)} MB` : `${Math.max(1, Math.round(bytes / 1000))} KB`;

/**
 * The mission's sources: files copied into its folder, and links the agent
 * fetches at run time. Both are editable after creation, because which paper
 * actually matters is usually something you learn from the first generated
 * graph rather than up front.
 *
 * The per-source note is passed to the agent verbatim. It is the cheapest way
 * to say "this is the paper the proof is from" versus "this is background",
 * which otherwise the agent has to guess.
 */
export function SourceEditor({
  mission,
  onChange,
  onClose,
}: {
  mission: Mission;
  onChange: (sources: MissionSource[]) => void;
  onClose?: () => void;
}) {
  const [linkText, setLinkText] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const addFiles = async () => {
    setError(null);
    try {
      const picked = await pickSourceFiles();
      if (!picked?.length) return;
      setBusy(true);
      const added = await importFileSources(mission.id, picked);
      onChange([...mission.sources, ...added]);
    } catch (e) {
      setError(String(e));
    } finally {
      setBusy(false);
    }
  };

  const addLink = () => {
    const link = makeLinkSource(linkText);
    if (!link) {
      setError("That doesn't look like a web address.");
      return;
    }
    if (mission.sources.some((s) => s.kind === "link" && s.url === link.url)) {
      setError("That link is already attached.");
      return;
    }
    setError(null);
    setLinkText("");
    onChange([...mission.sources, link]);
  };

  const remove = async (source: MissionSource) => {
    if (source.kind === "file") {
      await removeFileSource(mission.id, source.path).catch(() => undefined);
    }
    onChange(mission.sources.filter((s) => s.id !== source.id));
  };

  const setNote = (id: string, note: string) =>
    onChange(mission.sources.map((s) => (s.id === id ? { ...s, note } : s)));

  return (
    <section className="msources">
      <header className="msources__head">
        <h3>Sources</h3>
        <p className="minspect__muted">
          Papers, notes and links the agent reads before it starts. It also researches on its own — these are what it
          must not miss.
        </p>
        {onClose && (
          <button className="btn btn--ghost btn--sm" onClick={onClose} title="Close">
            ✕
          </button>
        )}
      </header>

      {error && <div className="mbanner mbanner--bad">{error}</div>}

      {mission.sources.length > 0 && (
        <ul className="msources__list">
          {mission.sources.map((source) => (
            <li key={source.id}>
              <div className="msources__row">
                <span className={`msources__kind msources__kind--${source.kind}`}>
                  {source.kind === "file" ? source.fileKind : "link"}
                </span>
                <span className="msources__label" title={source.kind === "file" ? source.path : source.url}>
                  {source.label}
                </span>
                <span className="minspect__muted">{source.kind === "file" ? humanSize(source.bytes) : ""}</span>
                <button className="btn btn--ghost btn--sm" onClick={() => remove(source)}>
                  Remove
                </button>
              </div>
              <input
                className="mfield__input msources__note"
                value={source.note}
                placeholder="Optional: what this is, and why it matters"
                onChange={(e) => setNote(source.id, e.target.value)}
              />
            </li>
          ))}
        </ul>
      )}

      <div className="msources__add">
        <div className="msources__link">
          <input
            className="mfield__input"
            value={linkText}
            placeholder="Paste a link — arxiv.org/abs/1907.00847, a blog post, a Lean repo…"
            onChange={(e) => setLinkText(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") {
                e.preventDefault();
                addLink();
              }
            }}
          />
          <Button variant="secondary" size="sm" disabled={!linkText.trim()} onClick={addLink}>
            Add link
          </Button>
        </div>
        <Button variant="secondary" size="sm" busy={busy} onClick={addFiles}>
          Add files
        </Button>
      </div>
    </section>
  );
}
