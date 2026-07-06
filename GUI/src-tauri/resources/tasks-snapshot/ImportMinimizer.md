# Task: Minimize a file's imports

You're working in the Physlib repository (leanprover-community/physlib, a Lean 4
physics library). Your task is to minimize the imports of EXACTLY ONE file - remove
the `import` lines it doesn't actually need, or reduce the imports 
to more basic imports. If Lean LSP tools (from lean-lsp-mcp)
are available, use them to check what each file really depends on rather than
guessing.

Do ONLY the following - nothing more. No golfing, no renaming, no refactoring, no
docstring edits, no changes to any code (`theorem`/`lemma`/`def`/`instance`/...).
You only ever touch `import` lines.

1. Choose a file - but FIRST, before you claim anything, check it is not already
   being worked on. Run
     gh pr list --repo leanprover-community/physlib --state open --limit 1000
   and inspect likely candidates' changed files (gh pr view <n> --json files, or
   gh pr diff <n>). Do NOT pick a file that an open PR is already editing; if gh
   cannot reach the API, say so and carry on. Tell me which open PRs you saw, then
   claim your file: pick a single `.lean` file under `./Physlib` or `./QuantumInfo`,
   with a PREFERENCE for `./QuantumInfo`. This whole run is about that one file's
   imports and nothing else.

2. Minimize that file's imports:
     - Remove every `import` at the top of the file that the file does not actually
       need (directly or to state/prove its own declarations). 
     - Do not add new imports to this file to "replace" a removed one unless the
       file genuinely uses that more specific module directly; the goal is a
       smaller, honest import list, not a reshuffle.
     - Change nothing else in the file - not the order of unrelated lines, not the
       code, not the docstrings. Only delete (and, where strictly necessary,
       narrow) `import` lines.

3. Fix ONLY downstream breakage caused by your removals, and nothing else:
     - Some files may have been relying on getting a module transitively through the
       file you trimmed. If removing an import here makes another file fail to build,
       add the now-missing `import` to that downstream file (and only that). Do not
       change anything else in those files.
     - Keep such downstream edits to the minimum needed for a green build, and list
       every file you had to touch and why.

4. Verify: build the project (`lake build`, or the relevant `lake build Physlib`
   / `lake build QuantumInfo` target) and confirm it succeeds. Everything must
   still build with no `sorry`, no new axioms, and no new errors or warnings.

Iterate until the build succeeds with the trimmed imports - that is the bar for
this PR. If you genuinely can't remove any import while keeping the build green,
stop and tell me exactly what's blocking - don't leave anything half-edited or
broken. Do NOT commit, push, or open a pull request yourself - the script does that
after you exit. When you're done, tell me which file you trimmed, which imports you
removed, any downstream imports you had to add and why, and paste the final build
output.
