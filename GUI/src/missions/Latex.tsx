import { useMemo } from "react";
import katex from "katex";
import "katex/dist/katex.min.css";

/**
 * Renders a node's `latex` field. Agents write these as ordinary mathematical
 * prose with `$…$` (and occasionally `$$…$$`) mixed in, so this splits on the
 * delimiters and hands only the maths to KaTeX, leaving the words alone.
 *
 * `throwOnError: false` is deliberate: a malformed macro should show up as a
 * red fragment in place, not blank the whole statement or take the inspector
 * down with it.
 */
export function Latex({ children }: { children: string }) {
  const parts = useMemo(() => splitMath(children ?? ""), [children]);

  return (
    <span className="latex">
      {parts.map((part, i) =>
        part.kind === "text" ? (
          <span key={i}>{part.text}</span>
        ) : (
          <span
            key={i}
            className={part.kind === "display" ? "latex__display" : undefined}
            dangerouslySetInnerHTML={{
              __html: katex.renderToString(part.text, {
                throwOnError: false,
                displayMode: part.kind === "display",
                errorColor: "var(--danger)",
              }),
            }}
          />
        ),
      )}
    </span>
  );
}

type Part = { kind: "text" | "inline" | "display"; text: string };

function splitMath(source: string): Part[] {
  const parts: Part[] = [];
  let i = 0;
  let buffer = "";

  const flush = () => {
    if (buffer) parts.push({ kind: "text", text: buffer });
    buffer = "";
  };

  while (i < source.length) {
    // Escaped dollar — literal, never a delimiter.
    if (source[i] === "\\" && source[i + 1] === "$") {
      buffer += "$";
      i += 2;
      continue;
    }
    if (source[i] === "$") {
      const display = source[i + 1] === "$";
      const delim = display ? "$$" : "$";
      const end = source.indexOf(delim, i + delim.length);
      if (end === -1) {
        // Unbalanced: treat the rest as prose rather than swallowing it.
        buffer += source.slice(i);
        break;
      }
      flush();
      parts.push({ kind: display ? "display" : "inline", text: source.slice(i + delim.length, end) });
      i = end + delim.length;
      continue;
    }
    buffer += source[i];
    i++;
  }
  flush();
  return parts;
}
