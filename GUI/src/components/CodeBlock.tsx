/** Renders a unified git diff with +/- line highlighting, in Geist Mono. */
export function DiffBlock({ diff }: { diff: string }) {
  const lines = diff.split("\n");
  return (
    <div className="code-block">
      {lines.map((line, i) => {
        const cls = line.startsWith("+") && !line.startsWith("+++")
          ? "code-block__line--add"
          : line.startsWith("-") && !line.startsWith("---")
            ? "code-block__line--del"
            : "";
        return (
          <div key={i} className={cls}>
            {line.length ? line : " "}
          </div>
        );
      })}
    </div>
  );
}

export function CodeBlock({ children }: { children: string }) {
  return <pre className="code-block">{children}</pre>;
}
