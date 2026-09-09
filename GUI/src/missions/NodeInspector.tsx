import { useEffect, useState } from "react";
import { Badge } from "../components/Badge";
import { Button } from "../components/Button";
import { CodeBlock } from "../components/CodeBlock";
import { Latex } from "./Latex";
import { moduleForNode } from "./graph";
import type { Issue } from "./graph";
import type { LeanCheck, Mission, MissionNode, ProofSketch } from "./missionTypes";

/**
 * The theorem card: everything Prove2Me puts on one (description, preamble,
 * formal statement, source, tags) plus what an offline workbench can add —
 * the compiler's own output, and the proof once there is one.
 *
 * The Lean fields are editable. A statement is the audited object, and the
 * whole point of auditing is that a human can correct it; an edit resets the
 * node to unchecked so nothing keeps a green tick it no longer earns.
 */

type Tab = "maths" | "lean" | "proof" | "checks";

function CheckReport({ check, label }: { check: LeanCheck | null; label: string }) {
  if (!check) return <p className="minspect__muted">{label} hasn't been through Lean yet.</p>;
  return (
    <div className="mcheck">
      <div className="mcheck__head">
        <Badge tone={check.ok ? "success" : "danger"}>{check.ok ? "Lean accepted" : "Lean rejected"}</Badge>
        <span className="minspect__muted">
          {check.module} · {(check.durationMs / 1000).toFixed(1)}s
        </span>
      </div>
      {check.ruleError && <p className="mcheck__rule">{check.ruleError}</p>}
      {check.axioms && (
        <p className="minspect__muted">
          Axioms: <code>{check.axioms}</code>
        </p>
      )}
      {check.diagnostics.trim() ? (
        <CodeBlock>{check.diagnostics.trim()}</CodeBlock>
      ) : (
        <p className="minspect__muted">No compiler output.</p>
      )}
    </div>
  );
}

export function NodeInspector({
  mission,
  node,
  issues,
  busy,
  proveBlocked,
  onChange,
  onVerify,
  onProve,
  onClose,
}: {
  mission: Mission;
  node: MissionNode;
  issues: Issue[];
  busy: boolean;
  /** Why a prove run can't start for this node right now, if it can't. */
  proveBlocked?: string;
  onChange: (node: MissionNode) => void;
  onVerify: () => void;
  onProve: () => void;
  onClose: () => void;
}) {
  const [tab, setTab] = useState<Tab>("maths");
  const [draft, setDraft] = useState(node);
  const dirty = draft.statement !== node.statement || draft.preamble !== node.preamble || draft.description !== node.description;

  // Switching node in the canvas has to reset the editor, or the previous
  // node's unsaved text would silently follow the selection onto a new one.
  useEffect(() => setDraft(node), [node.id, node]);

  const children = mission.sketches
    .filter((s) => s.targetId === node.id)
    .flatMap((s) => s.imports)
    .map((id) => mission.nodes.find((n) => n.id === id))
    .filter((n): n is MissionNode => Boolean(n));
  const declared = node.dependsOn
    .map((id) => mission.nodes.find((n) => n.id === id))
    .filter((n): n is MissionNode => Boolean(n));

  return (
    <aside className="minspect">
      <header className="minspect__head">
        <div>
          <div className="minspect__kind">{node.kind}</div>
          <h3 className="minspect__title">{node.name}</h3>
          <code className="minspect__module">{moduleForNode(node)}</code>
        </div>
        <button className="btn btn--ghost btn--sm" onClick={onClose} title="Close">
          ✕
        </button>
      </header>

      {issues.length > 0 && (
        <ul className="missues missues--inline">
          {issues.map((issue, i) => (
            <li key={i} className={`missues__item missues__item--${issue.severity}`}>
              {issue.message}
            </li>
          ))}
        </ul>
      )}

      <nav className="mtabs">
        {(["maths", "lean", "proof", "checks"] as Tab[]).map((t) => (
          <button key={t} className={`mtabs__tab ${tab === t ? "mtabs__tab--on" : ""}`} onClick={() => setTab(t)}>
            {t === "maths" ? "Mathematics" : t === "lean" ? "Lean" : t === "proof" ? "Proof" : "Checks"}
          </button>
        ))}
      </nav>

      <div className="minspect__body">
        {tab === "maths" && (
          <>
            <label className="mfield">
              <span className="mfield__label">Description — what this asserts, in words</span>
              <textarea
                className="mfield__input"
                rows={7}
                value={draft.description}
                onChange={(e) => setDraft({ ...draft, description: e.target.value })}
              />
            </label>
            {node.latex.trim() && (
              <section className="minspect__section">
                <h4>Statement</h4>
                <div className="mlatex-box">
                  <Latex>{node.latex}</Latex>
                </div>
              </section>
            )}
            {node.source && (
              <section className="minspect__section">
                <h4>Source</h4>
                <p>{node.source}</p>
              </section>
            )}
            {node.tags.length > 0 && (
              <div className="mtags">
                {node.tags.map((tag) => (
                  <Badge key={tag}>{tag}</Badge>
                ))}
              </div>
            )}
            {(children.length > 0 || declared.length > 0) && (
              <section className="minspect__section">
                <h4>Depends on</h4>
                <ul className="mdeps">
                  {(children.length ? children : declared).map((child) => (
                    <li key={child.id}>
                      <span className={`mdot mdot--${child.status}`} /> {child.name}
                    </li>
                  ))}
                </ul>
                {children.length === 0 && declared.length > 0 && (
                  <p className="minspect__muted">Declared, but no verified proof-sketch connects them yet.</p>
                )}
              </section>
            )}
          </>
        )}

        {tab === "lean" && (
          <>
            <label className="mfield">
              <span className="mfield__label">Preamble — imports only</span>
              <textarea
                className="mfield__input mfield__input--mono"
                rows={5}
                spellCheck={false}
                value={draft.preamble}
                onChange={(e) => setDraft({ ...draft, preamble: e.target.value })}
              />
            </label>
            <label className="mfield">
              <span className="mfield__label">
                Formal statement — one declaration, ending in <code>:= by sorry</code>
              </span>
              <textarea
                className="mfield__input mfield__input--mono"
                rows={14}
                spellCheck={false}
                value={draft.statement}
                onChange={(e) => setDraft({ ...draft, statement: e.target.value })}
              />
            </label>
          </>
        )}

        {tab === "proof" &&
          (node.proof ? (
            <>
              <section className="minspect__section">
                <h4>Proof idea</h4>
                <p>{node.proof.explanation || "No explanation was recorded."}</p>
              </section>
              {node.proof.reuses.length > 0 && (
                <section className="minspect__section">
                  <h4>Builds on</h4>
                  <ul className="mdeps">
                    {node.proof.reuses.map((r) => (
                      <li key={r}>{r}</li>
                    ))}
                  </ul>
                </section>
              )}
              <section className="minspect__section">
                <h4>Lean</h4>
                <CodeBlock>{node.proof.body}</CodeBlock>
              </section>
            </>
          ) : (
            <p className="minspect__muted">
              No proof yet. This node is part of the frontier an agent can work on.
            </p>
          ))}

        {tab === "checks" && (
          <>
            <section className="minspect__section">
              <h4>Statement</h4>
              <CheckReport check={node.check} label="This statement" />
            </section>
            {node.proof && (
              <section className="minspect__section">
                <h4>Proof</h4>
                <CheckReport check={node.proof.check} label="This proof" />
              </section>
            )}
          </>
        )}
      </div>

      <footer className="minspect__foot">
        {dirty && (
          <Button
            size="sm"
            onClick={() => onChange({ ...draft, status: "draft", check: null, proof: null })}
            title="Saving a changed statement clears its verification and any proof of it"
          >
            Save changes
          </Button>
        )}
        <Button size="sm" variant="secondary" busy={busy} onClick={onVerify}>
          Verify with Lean
        </Button>
        {node.status !== "proved" && node.kind !== "definition" && (
          <Button size="sm" variant="secondary" disabled={Boolean(proveBlocked)} title={proveBlocked} onClick={onProve}>
            Prove this node
          </Button>
        )}
      </footer>
    </aside>
  );
}

export function SketchInspector({
  mission,
  sketch,
  issues,
  busy,
  onVerify,
  onClose,
}: {
  mission: Mission;
  sketch: ProofSketch;
  issues: Issue[];
  busy: boolean;
  onVerify: () => void;
  onClose: () => void;
}) {
  const target = mission.nodes.find((n) => n.id === sketch.targetId);
  const children = sketch.imports
    .map((id) => mission.nodes.find((n) => n.id === id))
    .filter((n): n is MissionNode => Boolean(n));

  return (
    <aside className="minspect">
      <header className="minspect__head">
        <div>
          <div className="minspect__kind">proof-sketch</div>
          <h3 className="minspect__title">{target?.name ?? "unknown target"}</h3>
          <span className="minspect__muted">
            proves the target conditional on {children.length} {children.length === 1 ? "lemma" : "lemmas"}
          </span>
        </div>
        <button className="btn btn--ghost btn--sm" onClick={onClose} title="Close">
          ✕
        </button>
      </header>

      {issues.length > 0 && (
        <ul className="missues missues--inline">
          {issues.map((issue, i) => (
            <li key={i} className={`missues__item missues__item--${issue.severity}`}>
              {issue.message}
            </li>
          ))}
        </ul>
      )}

      <div className="minspect__body">
        <section className="minspect__section">
          <h4>Proof idea</h4>
          <p>{sketch.explanation || "No explanation was recorded."}</p>
        </section>
        <section className="minspect__section">
          <h4>Imports — the child lemmas this defers to</h4>
          <ul className="mdeps">
            {children.map((child) => (
              <li key={child.id}>
                <span className={`mdot mdot--${child.status}`} /> {child.name}
              </li>
            ))}
            {children.length === 0 && <li className="minspect__muted">None — this sketch closes the target outright.</li>}
          </ul>
        </section>
        <section className="minspect__section">
          <h4>Lean</h4>
          <CodeBlock>{sketch.body}</CodeBlock>
        </section>
        <section className="minspect__section">
          <h4>Checks</h4>
          <CheckReport check={sketch.check} label="This sketch" />
        </section>
      </div>

      <footer className="minspect__foot">
        <Button size="sm" variant="secondary" busy={busy} onClick={onVerify}>
          Verify with Lean
        </Button>
      </footer>
    </aside>
  );
}
