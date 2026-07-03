# Task: Fix an incorrect comment

You're working in the Physlib repository (leanprover-community/physlib, a Lean 4
physics library). Your task is to find EXACTLY ONE comment that is factually
incorrect, make the minimal change needed to make it correct, and give clear evidence
in the PR that your change is right. If Lean LSP tools (from lean-lsp-mcp) are
available, use them to read declarations, types, goal states, and hover info as
evidence rather than guessing.

By "comment" we mean any explanatory prose in the source: a declaration doc-string
(`/-- ... -/`), a module doc-string (`/-! ... -/`), or an ordinary line/block comment
(`-- ...`, `/- ... -/`). By "incorrect" we mean the prose makes a claim that is
actually FALSE about the code or mathematics it describes - e.g. it states the wrong
hypotheses, conclusion, type, or definition of a declaration; gives a wrong formula,
sign, bound, or direction of an inequality; names the wrong object; describes
behaviour the code does not have; or refers to something that does not exist or has
been renamed. A comment that is merely unclear, awkwardly worded, incomplete, or a
pure style nit is NOT in scope - only one that is demonstrably wrong.

1. Find and claim a wrong comment - but FIRST, before you claim anything, check it is
   not already being worked on. Run
     gh pr list --repo leanprover-community/physlib --state open --limit 1000
   and inspect likely candidates' changed files (gh pr view <n> --json files, or
   gh pr diff <n>). Do NOT pick a comment in a file an open PR is already editing; if
   gh cannot reach the API, say so and carry on. Tell me which open PRs you saw. Then
   claim ONE comment, anywhere in the Lean source (under `Physlib/`, `PhyslibAlpha/`,
   or `QuantumInfo/`), that you can PROVE is incorrect by pointing at the code it
   describes. This whole run is about that one comment and nothing else. If the
   comment you first pick turns out to be defensible (merely unclear, or actually
   correct on a closer read), drop it and find another - do not talk yourself into a
   change.

2. Establish the error rigorously, BEFORE editing. Identify the exact declaration or
   section the comment is about, read the actual Lean (the statement / definition /
   proof), and pin down precisely:
     - the comment, quoted verbatim, and what it claims;
     - what the code ACTUALLY says; and
     - why the two conflict - the specific, checkable discrepancy.
   If you cannot state a concrete, verifiable discrepancy, you have not found an
   incorrect comment: pick a different one.

3. Make the MINIMAL correction. Edit ONLY the incorrect comment, and change as little
   as possible to make it accurate - fix the false claim and nothing else. Do NOT
   rewrite the whole comment, restyle it, "improve" surrounding prose, or fix other
   comments. Do NOT change any code (definitions, statements, proofs, imports): the
   fix is to the words, not the maths. Keep the wording consistent with the
   surrounding style and within the line length the text linter allows.

4. Verify: build the project (`lake build`, or the relevant `lake build Physlib` /
   `lake build QuantumInfo` target) and confirm it still succeeds - a comment-only
   change must not break it (if it does, you have edited more than a comment, or
   malformed a doc-string). If your edit touches a doc-string or could affect the text
   linter (e.g. line length), run the required linters and confirm they stay clean:
     - `lake exe runPhyslibLinters`
     - `./scripts/lint-style.sh`
   Introduce no `sorry`, no new axioms, and no new errors or warnings.

Iterate until the comment is accurate and the build (and any affected linter) is
green - that is the bar for this PR. If you genuinely cannot find a comment that is
DEMONSTRABLY incorrect (as opposed to merely unclear), stop and tell me so - do NOT
invent an error, fix a style nit, or change code to make a comment true. Do NOT
commit, push, or open a pull request yourself - the script does that after you exit.

In your PR give a short summary (<10 lines) of:
- The comment you changed (file and location) and its before -> after.
- The EVIDENCE that the original was incorrect: cite the exact declaration and code
  (name and file:line) whose statement/behaviour contradicts the old wording, and
  show why the new wording matches it. Prefer a permalink to the lines, e.g.
  https://github.com/leanprover-community/physlib/blob/<sha>/Physlib/.../Basic.lean#L10-L14
- How a reviewer can confirm it in one step: exactly what to compare (the corrected
  comment against which lines of code) to see that the old text was wrong and the new
  text is right.
