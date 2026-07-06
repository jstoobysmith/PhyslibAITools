# Task: Rename a badly-named declaration

You're working in the Physlib repository (leanprover-community/physlib, a Lean 4
physics library). Your task is to rename EXACTLY ONE declaration whose name is
poor, and fix only the breakage that rename causes. If Lean LSP tools (from
lean-lsp-mcp) are available, use them to find the declaration's uses rather than
guessing.

Do ONLY the following - nothing more. No golfing, no generalizing, no statement
changes, no import changes, no docstring rewrites beyond what the rename forces.

1. Choose a declaration to rename - but FIRST, before you claim anything, check it
   is not already being worked on. Run
     gh pr list --repo leanprover-community/physlib --state open --limit 1000
   and inspect likely candidates' changed files (gh pr view <n> --json files, or
   gh pr diff <n>). Do NOT pick a declaration that an open PR is already editing (or
   whose file an open PR is already touching); if gh cannot reach the API, say so
   and carry on. Tell me which open PRs you saw, then claim your declaration: pick a
   single `def` or `lemma`/`theorem` under `./Physlib`, `./PhyslibAlpha`, or
   `./QuantumInfo` whose name either
     - does not follow Mathlib naming conventions
       (https://leanprover-community.github.io/contribute/naming.html), or
     - does not accurately represent the underlying physics content of
       the result.
   This whole run is about that one declaration and nothing else.

2. Rename that single declaration:
     - Change ONLY its name, to one that follows Mathlib conventions and accurately
       describes the result. Keep its statement/type and its proof/body unchanged.
     - Tell me the old name, the new name, and why the new one is better.

3. Fix ONLY what the rename breaks, and nothing else:
     - Update every use of the old name (across all files) to the new name so the
       project builds - references in other proofs, `simp`/`rw` calls, `export`s,
       dot-notation, docstrings/comments that mention it, etc.
     - Make no other change: do not rename anything else, do not touch unrelated
       declarations, imports, statements, or formatting. The only edits anywhere
       are the rename itself and updating references to it.

4. Verify: build the project (`lake build`, or the relevant `lake build Physlib`
   / `lake build QuantumInfo` target) and confirm it succeeds. Everything must
   still build with no `sorry`, no new axioms, and no new errors or warnings (in
   particular, no leftover references to the old name).

Iterate until the build succeeds with the renamed declaration and its updated
references - that is the bar for this PR. If you genuinely can't find a clearly
better name, stop and tell me exactly what's blocking - don't leave anything
half-edited or broken. Do NOT commit, push, or open a pull request yourself - the
script does that after you exit. When you're done, tell me the old and new names
(and the file), list every file you had to touch to update references, and paste
the final build output.
