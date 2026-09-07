# Generality: weakest assumptions, natural level

One question: is each result stated at the level it naturally lives at? This angle does not block.

- **Unused hypotheses.** A hypothesis the proof never needs is a finding: name it and say which
  part of the proof you checked. Physlib asks that hypotheses be minimal and necessary.
- **Over-specialization.** A result proved for `Space 3` that holds for `Space d`, for a
  particular potential that holds for any smooth one, for `ℝ` that holds for any complete field.
  Report it when generalizing is a change of statement and not of proof.
- **Do not over-generalize.** Physics context is the point of this library. A result stated so
  abstractly that it no longer reads as the physical statement it encodes is worse, not better.
  If the general form exists in Mathlib, the right move is to cite it and state the physical
  specialization here — say so rather than asking for the abstraction to be rebuilt.
- **The weaker hypothesis split.** Where part of a proof uses only the weaker form of a
  hypothesis (continuity, not smoothness), that part usually wants to be its own lemma under the
  weaker assumption. Raise it here when the consequence is the statement's generality; leave the
  mechanics of splitting to proof quality.

## Verdict

- `request_changes` for unused hypotheses, or for a specialization that costs nothing to remove.
- `approve` when the level is natural and the hypotheses are used.
