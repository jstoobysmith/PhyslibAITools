import { parse as parseYaml } from "yaml";
import type { ParsedTask, TaskFile } from "../lib/types";

function firstLine(text: string): string {
  const line = text.split("\n").find((l) => l.trim().length > 0);
  return line?.trim() ?? "";
}

/** Parses a raw task file exactly like `Scripts/physlib-auto-task.sh` does:
 * YAML tasks carry `prompt:`/`description:`/`input_questions:`/
 * `challenge_questions:`; Markdown tasks are the prompt verbatim, with the
 * description taken from the first meaningful line. */
export function parseTask(file: TaskFile): ParsedTask {
  if (file.format === "yaml") {
    let doc: Record<string, unknown> = {};
    try {
      doc = (parseYaml(file.content) as Record<string, unknown>) ?? {};
    } catch {
      // Malformed YAML - surface as an empty/unusable task rather than throwing,
      // so one bad file doesn't take down the whole task list.
    }
    const prompt = typeof doc.prompt === "string" ? doc.prompt.trim() : "";
    const description =
      typeof doc.description === "string" && doc.description.trim() ? doc.description.trim() : firstLine(prompt);
    const inputQuestions = Array.isArray(doc.input_questions) ? doc.input_questions.map(String) : [];
    const challengeQuestions = Array.isArray(doc.challenge_questions) ? doc.challenge_questions.map(String) : [];
    return { name: file.name, description, prompt, inputQuestions, challengeQuestions, source: file.source };
  }

  const prompt = file.content.trim();
  let description = firstLine(prompt)
    .replace(/^#\s*Task:\s*/i, "")
    .replace(/^#\s*/, "")
    .replace(/^Task:\s*/i, "");
  if (description.length > 120) description = description.slice(0, 119) + "…";
  return { name: file.name, description, prompt, inputQuestions: [], challengeQuestions: [], source: file.source };
}

/** Prepends the user's answers to a task's `input_questions` as a Markdown
 * bullet list, exactly like the script's `ask_questions` does, so Claude
 * sees them as context before the task prompt itself. */
export function buildPromptWithAnswers(basePrompt: string, answers: { question: string; answer: string }[]): string {
  if (answers.length === 0) return basePrompt;
  const bullets = answers
    .map(({ question, answer }) => `- **${question}**\n  ${answer.trim() || "(no answer)"}`)
    .join("\n");
  return `Before the task below, here is the input I provided - take it into account as you carry out the task:\n\n${bullets}\n\n${basePrompt}`;
}

/** Appends challenge-question verdicts to a PR body under a "## Human
 * review" section, matching the script's PR-body convention. */
export function appendChallengeVerdicts(body: string, verdicts: { question: string; verdict: "Yes" | "No" }[]): string {
  if (verdicts.length === 0) return body;
  const lines = verdicts.map(({ question, verdict }) => `- **${question}** ${verdict}`).join("\n");
  return `${body}\n\n---\n\n## Human review\n\n${lines}\n`;
}
