// Turns one line of Claude's `--output-format stream-json` output into a
// short, human-friendly activity-feed item. Deliberately defensive: the
// exact stream-json schema isn't fully documented (see GUI/README.md), so
// anything unrecognized falls through to a raw, de-emphasized line rather
// than being dropped or crashing the feed.

export interface FeedItem {
  id: string;
  icon: string;
  text: string;
  tone: "default" | "muted" | "success" | "danger";
}

let counter = 0;
const nextId = () => `evt-${counter++}`;

function truncate(text: string, max = 160): string {
  const oneLine = text.replace(/\s+/g, " ").trim();
  return oneLine.length > max ? `${oneLine.slice(0, max - 1)}…` : oneLine;
}

function summarizeToolUse(name: string, input: unknown): string {
  const obj = (input ?? {}) as Record<string, unknown>;
  if (typeof obj.command === "string") return `${name}: ${truncate(obj.command)}`;
  if (typeof obj.file_path === "string") return `${name}: ${obj.file_path}`;
  if (typeof obj.pattern === "string") return `${name}: ${truncate(obj.pattern)}`;
  try {
    return `${name}: ${truncate(JSON.stringify(obj))}`;
  } catch {
    return name;
  }
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function describeEvent(value: any): FeedItem | null {
  if (!value || typeof value !== "object") return null;

  switch (value.type) {
    case "system":
      if (value.subtype === "init") {
        return { id: nextId(), icon: "▶", text: "Claude started working…", tone: "muted" };
      }
      return null;

    case "assistant": {
      const content = value.message?.content;
      if (!Array.isArray(content)) return null;
      for (const block of content) {
        if (block?.type === "text" && typeof block.text === "string" && block.text.trim()) {
          return { id: nextId(), icon: "💬", text: block.text.trim(), tone: "default" };
        }
        if (block?.type === "tool_use" && typeof block.name === "string") {
          return { id: nextId(), icon: "🔧", text: summarizeToolUse(block.name, block.input), tone: "default" };
        }
      }
      return null;
    }

    case "user": {
      const content = value.message?.content;
      if (!Array.isArray(content)) return null;
      for (const block of content) {
        if (block?.type === "tool_result") {
          const isError = block.is_error === true;
          return {
            id: nextId(),
            icon: isError ? "⚠" : "↳",
            text: isError ? "Tool reported an error" : "Done",
            tone: isError ? "danger" : "muted",
          };
        }
      }
      return null;
    }

    case "result":
      return {
        id: nextId(),
        icon: value.subtype === "success" ? "✅" : "⚠",
        text: value.subtype === "success" ? "Claude finished this task run." : "Claude stopped without finishing.",
        tone: value.subtype === "success" ? "success" : "danger",
      };

    case "rate_limit_event":
      return null;

    case "raw":
      return typeof value.text === "string" ? { id: nextId(), icon: "·", text: value.text, tone: "muted" } : null;

    default:
      // Unknown event shape - still surface it, de-emphasized, rather than
      // silently dropping information the schema uncertainty might hide.
      try {
        return { id: nextId(), icon: "·", text: truncate(JSON.stringify(value)), tone: "muted" };
      } catch {
        return null;
      }
  }
}
