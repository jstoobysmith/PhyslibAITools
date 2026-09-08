# Attribution: does it credit its formal and informal sources?

One question: does the PR credit the work it is built on? This angle may `block` on clear
missing credit.

- **Informal sources.** A formalization that follows a textbook, paper, or lecture notes must say
  so, in the module docstring or the API map's `References`, with enough detail to find the
  argument (author, work, chapter or section). Physlib's own maps cite in this style, e.g.
  "Landau & Lifshitz, Mechanics, 3rd Edition, Chapter 1, Section 5".
- **Formal sources.** Material adapted from another Lean development — Mathlib, another Physlib
  area, an external repository — must name where it came from. Adapting an existing proof and
  presenting it as new is the clear case for `block`.
- **Do not verify the reference exists.** Physlib's AI policy puts bibliographic verification on
  the human author and explicitly forbids delegating it to an AI. Check that a source is *cited*
  and that the citation is specific enough to be checked by a human; do not rule on whether the
  cited claim is accurately reported unless the PR itself gives you the text.
- **Co-authorship trailers** on commits are a human-process matter, not yours.

## Verdict

- `block` when material is clearly taken from an identifiable source with no credit.
- `request_changes` when a source is named too vaguely to find (a book with no chapter, a repo
  with no file), or when a module plainly follows a standard treatment that goes uncited.
- `approve` when sources are credited, or when the material is genuinely elementary and owes
  nothing in particular.
