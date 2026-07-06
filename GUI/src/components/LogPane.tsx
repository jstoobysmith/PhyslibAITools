import { useEffect, useRef } from "react";

export interface LogLine {
  text: string;
  stream?: "stdout" | "stderr";
}

/** A scrolling monospace log viewer for setup/build output. Auto-scrolls to the
 * newest line unless the user has scrolled up to read history. */
export function LogPane({ lines, maxHeight = "16rem" }: { lines: LogLine[]; maxHeight?: string }) {
  const paneRef = useRef<HTMLDivElement>(null);
  const stickToBottom = useRef(true);

  useEffect(() => {
    const el = paneRef.current;
    if (el && stickToBottom.current) {
      el.scrollTop = el.scrollHeight;
    }
  }, [lines]);

  return (
    <div
      className="log-pane"
      style={{ maxHeight }}
      ref={paneRef}
      onScroll={(e) => {
        const el = e.currentTarget;
        stickToBottom.current = el.scrollHeight - el.scrollTop - el.clientHeight < 24;
      }}
    >
      {lines.length === 0 && <div style={{ opacity: 0.5 }}>Waiting for output…</div>}
      {lines.map((line, i) => (
        <div
          key={i}
          className={line.stream === "stderr" ? "log-pane__line log-pane__line--stderr" : "log-pane__line"}
        >
          {line.text}
        </div>
      ))}
    </div>
  );
}
