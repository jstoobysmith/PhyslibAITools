# Correctness: do the statements say what they should?

One question: does each new definition and each new statement mean, in Lean, the physics or
mathematics its name and docstring claim? This angle may `block`.

CI has proved the proofs typecheck and that no `sorry` or `axiom` is present. It cannot tell you
that `SimplePendulum.lagrangian` is the pendulum's Lagrangian. That is your job.

## Mis-formalization

Read each new definition against the physics it names, and each new lemma against the statement
its name and docstring advertise. Look for:

- **A definition that is not the object it names.** A sign convention silently flipped, a factor
  of ½ or `c` dropped, the wrong metric signature, a coordinate frame assumed and not stated, a
  potential defined where the docstring promises an energy.
- **A statement weaker than it reads.** Hypotheses so strong the conclusion is immediate; a
  quantifier scoped so the result is about one instance rather than all; an equation asserted
  only at a point where both sides are trivially zero.
- **Vacuity.** A structure field of type `True`, a lemma returning `True`, `∃ x, ..., True`, a
  variable hypothesis that assumes the conclusion, or hypotheses no object satisfies. Physlib
  bans these forms outright; check the ones CI's syntactic linters cannot see, especially
  hypotheses that are unsatisfiable for semantic rather than syntactic reasons.
- **Units and dimensions.** Physlib carries a units API. A statement that silently equates
  quantities of different dimension, or that hard-codes a unit choice into a result claimed to be
  general, is wrong even when it typechecks.
- **Defeq abuse.** A result that holds only because two things are definitionally equal by
  accident of the encoding, and would break under a reasonable refactor of the definition.

For each, name the declaration, quote the line, and say what the correct statement would be.

## The physics literature

Where a declaration corresponds to a named result in the physics literature, check that it is
that result and not a weaker cousin. If the PR cites Landau & Lifshitz section 5, read what the
statement actually says against what the citation claims. You may not be able to verify a
reference exists — that is the human author's obligation under Physlib's AI policy — but you can
check that the formal statement matches the cited claim as described in the PR.

## Not your lane

Naming, docstring quality, placement, generality, and proof style belong to other agents. Report
a docstring here only when it makes a *false* claim about what the declaration means — that is a
correctness problem, not a documentation one.

## Verdict

- `block` when a new definition or statement is wrong, vacuous, or means something materially
  different from what it claims.
- `request_changes` when a statement is correct but relies on an unstated assumption, or where a
  hypothesis is stronger than the proof needs in a way that changes what the result asserts.
- `approve` when the new statements say what they should.
