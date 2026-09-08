# Placement: canonical home, direct and minimal imports

One question: could a reader who knows the file structure find this material without searching?
This angle does not block.

## Mirroring

`PhyslibAlpha/` mirrors `Physlib/`. A result about the simple pendulum belongs at the Alpha path
matching its Physlib home, not wherever the PR happened to start. Physlib's own review checklist
asks: for every definition and lemma added, could I determine from the file structure alone where
to find it?

## The general-result rule

Physlib is explicit: if you need a general result about derivatives on space in order to prove
something in classical mechanics, that result goes in the space-derivatives file, not the
classical-mechanics file. Look for general lemmas parked in the physics file that needed them,
and say where each belongs.

## New files

- Physlib asks that results go in the appropriate existing file and that new files not be created
  without good reason. A new file needs a reason; say so if you cannot see one.
- A new file's name should let a reader guess its contents.
- Every new Alpha file must be imported in `PhyslibAlpha.lean`, sorted — CI checks this
  (`lake exe alphaFileImports`), so do not re-report it; do report a file whose *placement in the
  import graph* is wrong, e.g. an Alpha module importing a sibling only to reach one lemma that
  should have been upstream.

## Imports

- Import the module that actually provides what is used, not a convenience umbrella that drags in
  half the library.
- An Alpha file importing another Alpha file is fine; a `Physlib/` or `QuantumInfo/` file
  importing Alpha is forbidden and CI catches it.

## Within a file

Physlib numbers sections `# A. ...`, `## A.1. ...`. Results sitting next to each other should be
relevant to each other. Report material dropped into a file whose theme it does not share.

## Verdict

- `request_changes` for material in the wrong file, a general result parked in a physics file, or
  an unjustified new file.
- `approve` when each declaration is where a reader would look for it.
