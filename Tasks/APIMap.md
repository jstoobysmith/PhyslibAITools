# Task: Build the API tracker (API-map.yaml)

You're working in the Physlib repository (leanprover-community/physlib, a Lean 4
physics library). Physlib tracks the "APIs" it wants to build (e.g. Galilean group,
harmonic oscillator, electromagnetic potential) - each API being a key data
structure plus the definitions and lemmas around it. Today that tracking lives in
GitHub issues labelled `API`; we are moving it into the repository itself as a small
`API-map.yaml` file placed at the top of each API's directory. Your task is to
create or update EXACTLY ONE such `API-map.yaml`. The map must describe what
ACTUALLY exists in that directory: generate it from the directory's own Lean files,
and treat any corresponding GitHub `API` issue as a REFERENCE for the API's intended
scope - not as text to copy. If Lean LSP tools (from lean-lsp-mcp) are available, use
them to confirm declarations exist rather than guessing.

1. Choose a directory to map - but FIRST, before you claim anything, check it is not
   already being worked on. Run
     gh pr list --repo leanprover-community/physlib --state open --limit 1000
   and inspect likely candidates' changed files (gh pr view <n> --json files, or
   gh pr diff <n>). Do NOT pick a directory an open PR is already adding or editing
   an `API-map.yaml` in; if gh cannot reach the API, say so and carry on. Tell me
   which open PRs you saw.

   Then pick EXACTLY ONE API directory anywhere in the library - any real directory
   under Physlib/ (or QuantumInfo/) that forms a coherent API, i.e.
   is built around a key data structure and its surrounding definitions and lemmas
   (e.g. Physlib/ClassicalMechanics/HarmonicOscillator, Physlib/Electromagnetism/
   Kinematics). You are NOT limited to directories named in GitHub issues. A
   directory is eligible if EITHER:
     (a) it has no `API-map.yaml` yet (you will create one), OR
     (b) it already has an `API-map.yaml` that is out of date - i.e. a Lean file in
         the directory has changed since the map was last updated. Filesystem
         timestamps are unreliable in a fresh clone, so use git: compare the map's
         last-commit time,
           git log -1 --format=%cI -- <dir>/API-map.yaml
         against the directory's Lean files,
           git log -1 --format=%cI -- <dir>/*.lean
         and treat the directory as stale (eligible) when the Lean files are newer.
   Skip directories whose `API-map.yaml` is already up to date (no Lean file newer
   than the map). This whole run is about that one directory and its single
   `API-map.yaml` - you never create or edit a second one.

2. Place the file and find a reference. The `API-map.yaml` lives at the TOP of the
   chosen directory (e.g.
   Physlib/ClassicalMechanics/HarmonicOscillator/API-map.yaml). Then look for a
   corresponding GitHub `API` issue to use as a reference for the API's intended
   scope:
     gh issue list --repo leanprover-community/physlib --label API --limit 1000
   and read the most relevant one (gh issue view <n>). If one matches the directory,
   use it as a REFERENCE per step 3; if none exists, that's fine - generate the map
   from the directory alone.

3. Write `API-map.yaml` in EXACTLY this format, and with no other top-level fields:

     version: v0.1

     Title: <the API title, e.g. "Harmonic oscillator">

     Overview: |
         <a short overview of the API as it ACTUALLY exists in this directory -
          summarise from the directory's module docstrings and the key data
          structure(s) defined there; use the GitHub issue only to frame it, do not
          paste its prose>

     ParentAPIs:
       - <an API this one builds on, by Title or directory path; use [] if none>

     References:
       - <a reference for the API as a whole; use [] if none found>

     Requirements:

       - description: <a requirement this directory actually satisfies>
         done: true
         location: <path (and key declaration) that satisfies it, e.g.
                    Physlib/ClassicalMechanics/HarmonicOscillator/Basic.lean
                    (HarmonicOscillator)>

       - description: <a requirement that is not yet met>
         done: false
         location: N/A

   Rules for the fields:
     - Generate the file from what the directory ACTUALLY contains. The GitHub `API`
       issue is a REFERENCE for the API's intended scope, naming and the things still
       to build - it is NOT something to copy. Where the issue and the code disagree,
       the code is the source of truth.
     - `Overview`: write it from what the directory actually provides - summarise the
       files' module docstrings and the key data structure(s) defined there. Use the
       issue only to frame it; do not paste its prose.
     - `ParentAPIs`: the other APIs this one builds on. Determine them from the
       directory's imports and usages of other API directories (e.g. it imports and
       uses another physics API, or a Mathematics/ API). List them by Title or
       directory path; use `[]` if there are none.
     - `References`: a single top-level list of literature/source references for the
       API as a whole. Take these ONLY from references actually cited in the
       directory (e.g. a module-docstring References section) or from the GitHub
       issue - NEVER invent a citation (humans have to verify references). Use `[]`
       if you can't find a real reference.
     - Requirements: a `done: true` requirement must be one this directory genuinely
       satisfies (with a real `location`). For the `done: false` requirements - the
       things still to build - use the issue's requirement list as a guide if there
       is one, plus any obvious gaps you can see in the directory; with no issue,
       derive them from the directory and the obvious next steps for the API.
     - For EVERY requirement, decide `done` by CHECKING THE CODE, not by trusting
       the issue's checkboxes. Use lean-lsp / grep / the files to confirm the
       declaration exists and does what the requirement says.
     - `done: true` MUST have a real `location`: a path relative to the repo root
       plus the key declaration name(s). `done: false` MUST have `location: N/A`.
     - Keep it valid YAML. If `python`/`uv` is available, sanity-check with
       `python -c "import yaml; yaml.safe_load(open('<path>'))"`.

4. Do NOT change any Lean source. You only add or edit the single `API-map.yaml`.
   Do not touch any `.lean` file, any other directory's map, imports, docstrings, or
   the GitHub issue itself.

5. Verify:
     - The file is valid YAML and follows the schema above exactly.
     - Every `done: true` location points at a declaration that really exists (open
       it / confirm with lean-lsp or grep).
     - The project still builds: `lake build`. A `.yaml`-only change must not affect
       the build, so this should stay green; if it doesn't, you've touched something
       you shouldn't have.

Iterate until the `API-map.yaml` is accurate, valid, and the build is green - that
is the bar for this PR. If you genuinely can't ground the map in the code (e.g. the
directory isn't really a coherent API), stop and tell me why - don't leave a
half-written or guessed map. Do NOT commit, push, or open a pull request yourself - the script does
that after you exit. When you're done, tell me which API you mapped (and the
directory), paste the final API-map.yaml, and note which requirements you marked
done vs not and how you verified each.
