# Scope: API-map fit and single concept

One question: does this PR belong in PhyslibAlpha now, as a single coherent concept? This angle
may `block`, and should fairly readily.

## The API maps are the roadmap

Physlib records what each API is meant to contain in an `API-map.yaml` at the top of that API's
directory (`Physlib/SpaceAndTime/Time/API-map.yaml`, `Physlib/Relativity/LorentzGroup/API-map.yaml`,
and so on; an Alpha area may carry its own, e.g.
`PhyslibAlpha/QuantumThermodynamics/API-map.yaml`). Each map lists `Requirements`, and each
requirement carries `done: true` (formalized, with a `location` naming the declarations) or
`done: false` (planned, `location: N/A`). The maps are human-written and human-reviewed, and the
guide is explicit that unformalized requirements "still belong in the map, marked as not done, so
the map doubles as the API's roadmap."

**A `done: false` requirement is an open target. That is what this rubric checks material against.**

The runner writes an index of every map, with its open requirements, to `apimaps/INDEX.md` in
your workspace. **That index is built from the base branch, not from the PR head** — the maps as
humans have already merged them. The maps are also in the checkouts at their real paths; read the
actual map, not just the index, before you rule on a claim.

### A map this PR writes is not authority for this PR

The maps live in the same repository as the code, so a PR can add or edit the very requirement
that would authorize it. It does not get to. The runner-verified header lists every
`API-map.yaml` the PR changes; for each one:

- **New material justified only by a requirement the same PR adds or edits is off-map.** `block`,
  and say the map change must be reviewed and merged by a human first. This is the same boundary
  as the rule that agents do not write roadmaps: writing down the target and then satisfying it in
  one move is not authorization, it is self-authorization.
- **A map change on its own is fine and welcome** — recording newly-done requirements, correcting
  a `location`, adding scope for future work. Judge such a PR as a map PR: is it a single coherent
  change to one API's stated scope? Flipping `done: false` to `done: true` for work this PR also
  lands is the normal, expected shape and is not self-authorization, because the requirement was
  already there.
- If the diff's *only* content is a new map with no Lean code, that is a human-facing proposal.
  Say so and leave the judgment of the scope it proposes to a human: `request_changes` asking for
  human sign-off rather than approving new scope yourself.

## API-map fit

**A refactor of already-merged code is in scope a priori.** Everything on `master` was reviewed
for fit when it was merged, so reworking it needs no fresh API-map claim. If the PR only
refactors, relocates, renames, simplifies or re-proves, modestly generalises, or documents
material that — up to those changes — already exists on `master`, API-map fit is automatically
satisfied: do not `request_changes` for a missing or unstated requirement. Judge by whether the
physics already existed, not by whether identifiers or file paths moved. The test below applies
only to genuinely *new* content: a definition, lemma, instance, or file that adds a capability
`master` did not have.

New material is in scope only if it advances a specific API-map requirement, or supplies a
prerequisite a specific requirement needs. A valid claim identifies an `API-map.yaml` path and
quotes the requirement's `description`; read it in the checkout to confirm.

- **The requirement must be real and proximate.** You can see the path from this material to the
  quoted requirement. "Might be useful for", or a long speculative chain, is not a prerequisite.
- **Building what is missing is the point**, so do not reject genuine prerequisite infrastructure.
  Reject material on no path to any requirement, or justified only as interesting; if it is
  off-map but plausibly worthwhile, `block` and say a human must add the requirement to the
  API map first. Agents do not write API maps.
- **Read the path in the map's own order.** `ParentAPIs` and the requirement order are the
  layering. When the quoted requirement presupposes an earlier requirement of the same map, or a
  requirement of a parent API, confirm that earlier requirement is `done: true` or is landing in
  an open PR. Material built on a stage whose stated prerequisite is absent is speculative,
  however proximate the citation reads: `request_changes`, naming the missing requirement.
- **Weigh advancement, not just membership.** Skim what has recently merged citing the same
  requirement. If the requirement itself is no closer while satellites accumulate around it, do
  not keep approving on citation alone: `request_changes`, asking for the requirement itself or
  for what makes this PR necessary to it.
- **Judge the path, not its physical adequacy.** If scope turns on whether a prerequisite is
  strong enough or non-vacuous, leave that to correctness.

### An API with no map

Alpha directories mirror their place in Physlib. If neither the material's Alpha directory nor
its mirror in `Physlib/` has an `API-map.yaml` on the base branch, there is no target to advance
and no human statement that the work is wanted: `block`, and say which directory needs a map. Do
not accept an invention of scope in the PR description as a substitute for a map, and do not
accept a map the PR itself adds. The one exception is material whose only purpose is to serve an
existing mapped requirement from another directory — then cite that requirement, in its own map,
as usual.

### Claiming a requirement in the PR description

Every PR description should carry one standalone attribution line:

```text
API-map: Physlib/SpaceAndTime/Time/API-map.yaml
```

or:

```text
API-map: none
```

This is attribution, not authorization: new material must still quote the exact requirement it
advances, while a refactor needs no fresh claim but should name the map chiefly motivating it.
Use `API-map: none` for genuinely general, cross-cutting, or infrastructure work. Do not infer
the association from the directory the code sits in; file layout and API scope do not coincide.

## Single concept

Physlib asks that a PR add **a single coherent concept**: every definition and lemma should
either *be* that concept or supply the minimal API to state and prove it. `block` and ask for a
split when the PR is more than one: an opportunistic refactor of prerequisite material bundled
with new work, or several unrelated requirements at once. A single refactor that is itself the
topic is fine, as are the file moves `placement.md` requires alongside a new file.

Size is a signal, not a rule — Physlib's guidance treats 200+ changed lines as a PR that should
usually be broken up, while granting that a large documentation or reorganization PR can be
simple. Judge coherence; cite size only when it is evidence of more than one concept.

## Verdict

- `block` when new material has no real path to an API-map requirement on the base branch, when
  it is justified only by a requirement this PR itself adds, when the API has no map at all, or
  when the PR is not a single concept.
- `request_changes` when new material's path is genuine but the description fails to quote it,
  when the PR builds on a requirement whose stated prerequisite is absent, or when it adds
  periphery around a requirement that is not getting closer.
- `approve` when the PR reworks already-merged material as a single concept, or advances one
  requirement or one requirement's genuine prerequisite, as one unit.
