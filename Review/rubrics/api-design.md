# API design: minimal public surface, complete characteristic API

One question: is the interface the right size — nothing exposed that need not be, nothing missing
that a user will immediately need? This angle does not block.

## A definition with no lemmas is not a contribution

Mario's rule, which Physlib inherits: when you make a definition, it is your job to make it
usable, and that means the right amount of API. For each new definition, ask what a downstream
user must be able to do with it and check those lemmas are here:

- the simp lemmas that unfold it in the normal direction,
- the extensionality / injectivity / congruence lemmas its shape calls for,
- the interaction with the operations it is stated over (addition, scalar action, the derivative,
  the time evolution, the group action),
- the instances that make it usable at all (`AddCommGroup`, `Module`, `ContinuousLinearMap`,
  measurability, differentiability), where they are true and cheap.

Missing characteristic API is a finding. Say which lemma is missing and why a user needs it.

## Minimal surface

- Helper definitions used only inside one proof should be `private`, or should not be definitions.
- A `let`/`set` that constructs an object and proves things about it inline should be promoted to
  a `def` with its properties as lemmas — but only if the object is used more than once.
- Do not expose an implementation detail (a coordinate representation, an auxiliary index type)
  as the public way to talk about the object when a coordinate-free statement is available.

## Structure

- A definition stated for a special case where the general case costs nothing more is an API
  problem as well as a generality one; report the interface consequence here and leave the
  generality judgment to that agent.
- Bundled versus unbundled: follow what Physlib and Mathlib already do for the neighbouring
  objects. Say which neighbour you compared against.

## Verdict

- `request_changes` when a new definition ships without the API needed to use it, or when
  internals are exposed as the public interface.
- `approve` when the surface is minimal and the characteristic lemmas are present.
