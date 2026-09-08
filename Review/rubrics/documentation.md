# Documentation: accurate module and declaration docstrings

One question: does the documentation help a reader, and is it true? This angle does not block.

- **Every definition has a docstring** — CI's Alpha linters enforce the presence, so do not
  re-report a missing one. Report a docstring that is *padding*: one that restates the name, or
  describes the Lean encoding instead of the physics.
- **Important lemmas should have docstrings.** Say which new lemma is important enough to need
  one and does not have it.
- **Module docstrings** should let a reader understand the flow of the file: what it builds, in
  what order, and what it assumes. Physlib's checklist asks whether the module documentation
  actually helps or is just padding.
- **Truth.** A docstring that misdescribes what a declaration means is a correctness problem —
  file it there, not here. A docstring that is merely vague, out of date with respect to a
  renamed argument, or describes a stronger result than is proved belongs here.
- **Sections.** Physlib numbers sections `# A. ...`, `## A.1. ...`. Report a long new file with no
  section structure.
- **Conventions.** Where a file fixes a convention a reader could not guess (a sign, a metric
  signature, a choice of units, an ordering of tensor indices), the module docstring should say
  so. This is the most valuable documentation finding in this library; look for it specifically.

## Verdict

- `request_changes` for padding docstrings, an undocumented convention, or a module with no
  usable orientation.
- `approve` when the documentation earns its place.
