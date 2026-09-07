# Naming: conclusion-describing names, conventional notation

One question: can a reader guess what a declaration says from its name? This angle does not block.

- **Follow the Mathlib/Physlib naming convention.** A lemma name describes its conclusion, in
  order, in the library's vocabulary: `deriv_smul`, `lagrangian_eq_space`, `norm_le`. Report a
  name that describes the proof, the author's intent, or the physical story instead.
- **Namespaces.** New declarations belong in the namespace of the object they are about
  (`SimplePendulum.lagrangian`, not a bare `lagrangian`). Report a declaration placed in a
  namespace that does not own it, and a namespace invented where an existing one fits.
- **`lemma` versus `theorem`.** Physlib uses `lemma` unless the result is well known in the
  physics literature. A new `theorem` needs to be a named result; say which one it is meant to be.
- **Notation.** New notation must follow the conventions of the surrounding API and should not
  collide with Mathlib's. Physlib's API maps write notation entries as `notation ∂ₜ`, `notation 𝐱`.
  Report notation introduced for something used twice, and notation whose glyph already means
  something else nearby.
- **Physics terms.** Use the term the physics literature uses. A new term that trips the
  spell-checker goes in `scripts/MetaPrograms/spellingWords.txt` — CI enforces that, so do not
  re-report it; do report a term that is simply not what physicists call the thing.

## Verdict

- `request_changes` when a name misdescribes its conclusion, sits in the wrong namespace, or uses
  `theorem` for a result that is not a named theorem.
- `approve` when names read correctly.
