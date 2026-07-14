# Task: Fixing the linters on Quantum Info

You're working in the Physlib repository (a Lean 4 physics library). Your task is
to pick one linter-exempted file and fix it. If Lean LSP tools (from
lean-lsp-mcp) are available, use them to read the file's diagnostics, goal states,
and hover info rather than guessing.
 
1. Choose a file - but FIRST, before you claim anything, check it is not already
   being worked on. Run
     gh pr list --repo leanprover-community/physlib --state open --limit 1000
   and inspect likely candidates' changed files (gh pr view <n> --json files, or
   gh pr diff <n>). Do NOT pick a file that already has an open PR removing its
   line from scripts/LinterExemption.txt (or otherwise targeting it); if gh
   cannot reach the API, say so and carry on. Tell me which open PRs you saw, then
   claim your file: read scripts/LinterExemption.txt and pick EXACTLY ONE file from
   it that no open PR is already handling. This whole run is about that single
   file - you fix one file and one file only, and you never start, edit, or lint
   a second file (not even if touching another file would help). 
2. The two linters that MUST pass (these are the ones CI enforces and the only
   ones required for this PR) are:
     - `lake exe runPhyslibLinters`  (the Lean/Physlib linters)
     - `./scripts/lint-style.sh`     (the text/style linter)
   Run both and read scripts/README.md so you understand exactly what each one
   checks. These two are the priority - your file MUST come out clean under both.
   The README may mention other, optional linters; you may also have a go at
   satisfying those, but do not let them block the PR and do not contort the file
   to please a non-required check.
3. Edit ONLY the file you chose to satisfy the two required linters above (and,
   where it's easy, the optional ones), following Mathlib conventions
   (https://leanprover-community.github.io/contribute/naming.html). Do not change
   any other source file, and do not alter the meaning of any proof.
4. Module-docstring: if a linter requires one (or the file would clearly benefit
   from one), add a module-docstring, but make sure it is not too verbose. It
   should make clear the scope and content of the file with an overview, and 
   give any key definitions an understandable description. 
   Where possible, link it back to physics.
5. Remove that file's line from scripts/LinterExemption.txt, so the linters start
   enforcing the rules on it.
6. Verify: build the project (`lake build`, or the relevant `lake build Physlib`
   / `lake build QuantumInfo` target) and re-run `lake exe runPhyslibLinters` and
   `./scripts/lint-style.sh`. Confirm the build succeeds and the file no longer
   trips either required linter.
 
Iterate until the build succeeds and both required linters
(`lake exe runPhyslibLinters` and `./scripts/lint-style.sh`) are clean - that is
the bar for this PR. If you genuinely can't get there, stop and tell me exactly
what's blocking - don't leave the file half-edited. Do NOT commit, push, or open
a pull request yourself - the script does that after you exit. When you're done,
tell me which file you fixed and paste the final build and required-linter output.