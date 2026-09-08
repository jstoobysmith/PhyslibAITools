# Proof quality: automation-first, robust, and split where it should be

One question: are the proofs ones a maintainer can live with? This angle does not block.

CI has already run the style linters (line length, `simp` versus `simp only`, final tactics,
trailing whitespace). Do not re-report those. Judge structure and robustness.

## Length and splitting

Physlib asks that proofs be short — under 50 lines as a rule — and that long proofs be split.
When a proof is long, say which of these splits applies rather than just noting the length:

**Extract by meaning** — the fragment says something independently true:

- the proof establishes further properties of an existing definition (extract as lemmas);
- a `calc` or `have` carrying physics context that is generally applicable;
- a `have` with no physics content but general mathematical value (an algebraic identity, an
  inequality, a measurability/continuity/differentiability side-goal) — these belong as general
  lemmas, in their general home (see placement);
- the proof proves a general statement then instantiates it (extract the general statement, keep
  the specialization as a corollary);
- part of the proof uses only a weaker form of a hypothesis (extract under the weaker assumption);
- a `let`/`set` constructs an object and proves properties inline (promote to a `def` with lemmas).

**Extract by structure** — the proof breaks into independent pieces:

- substantial `rcases`/`match` branches, each becoming its own lemma;
- the base case and inductive step of a long induction;
- a long `calc` block, where a contiguous run establishing a named equality becomes an equational
  lemma;
- symmetry or duality, where half the proof mirrors the other (`≤` then `≥`, two indices swapped):
  prove one direction and obtain the other by symmetry.

Where a long proof genuinely cannot be split, it must carry comments explaining its structure.
A long uncommented unsplittable proof is a finding.

## Robustness

- **Brittleness.** A proof that depends on the exact form of a `simp` normal form, on goal
  ordering, on `omega`/`linarith` closing something incidental, or on unnamed hypotheses
  (`this`, `h✝`) will break on the next Mathlib bump. Name the step.
- **`set_option` overrides.** An increased `maxHeartbeats` or `synthInstance.maxHeartbeats` in new
  code is a smell: the proof is doing too much work in one step. Say which step.
- **Automation first.** Prefer the library's automation to a hand-rolled term when it closes the
  goal; conversely, a fifty-line `simp` cascade that could be one `field_simp; ring` is worth
  reporting.
- **Dead steps.** `have`s never used, hypotheses introduced and discarded, redundant rewriting.

## Verdict

- `request_changes` for a long proof that should be split, a brittle step, or an unexplained
  `set_option` override.
- `approve` when the proofs are short, structured, and robust.
