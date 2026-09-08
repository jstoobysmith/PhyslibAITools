# Reuse: does it reuse Mathlib and Physlib instead of reinventing?

One question: does this PR rebuild something that already exists? This angle may `block` on
outright duplication.

PhyslibAlpha is downstream of `Physlib/`, `QuantumInfo/`, and Mathlib, and all three are in your
workspace (Mathlib at the pinned revision, unless the runner reports it was skipped). Grep before
you assert anything.

## What to look for

- **Outright duplication.** A definition or lemma that already exists in Mathlib, `Physlib/`,
  `QuantumInfo/`, or elsewhere in `PhyslibAlpha/`, under a different name. `block`.
- **A private dialect.** A new predicate or abbreviation wrapping something the upstream
  libraries already say. Physlib's rule is to use the library's vocabulary rather than a local
  version: a standard notion said in our own dialect drifts from the library it builds on and
  grows a redundant theory of lemmas that are already proved upstream. A one-line bound does not
  need a new predicate.
- **Trivial rewrites.** Physlib forbids lemmas that are trivial rewrites of existing Mathlib or
  Physlib results unless they add genuine physics context. A restatement with the arguments in a
  different order, or with `simp` normal form applied, is a trivial rewrite. Say which upstream
  declaration it restates.
- **Reproving.** A proof that rebuilds a general fact inline instead of citing the upstream lemma
  that already has it.
- **Duplication within the PR.** Two new declarations that are the same statement at different
  levels of generality, where the specific one is not needed as a convenience corollary.

## Evidence

A duplication finding must name the existing declaration and show the grep hit that found it,
with its file. "Something like this probably exists" is not a finding. If you cannot find the
upstream declaration, do not file it.

If the runner reports Mathlib source was **not** fetched (`--no-mathlib`), say so in your summary
and confine your claims to `Physlib/`, `QuantumInfo/`, and `PhyslibAlpha/`, which are always
present.

## Verdict

- `block` on outright duplication of an existing declaration.
- `request_changes` for a private dialect, a trivial rewrite, or an inline reproof of an upstream
  result.
- `approve` when the material is genuinely new and builds on what exists.
