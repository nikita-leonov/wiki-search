import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import type { RetrievedContext } from "../../../src/agent.ts";
import {
  buildJudgeScore,
  callLlmJudge,
  loadRubric,
  type Judge,
} from "../shared.ts";

const __dirname = dirname(fileURLToPath(import.meta.url));
const rubric = loadRubric(join(__dirname, "groundedness.yaml"));

/**
 * Render the agent's retrieved snippets as a single string for the judge to
 * read. Separates each search call with its query and lists hits beneath.
 */
export function formatRetrievedContext(context: RetrievedContext[]): string {
  if (context.length === 0) return "(no searches performed)";
  return context
    .map((entry, i) => {
      const hits =
        entry.hits.length === 0
          ? "  (no results)"
          : entry.hits
              .map(
                (h, j) =>
                  `  [${j + 1}] ${h.title}\n      ${h.extract.replace(/\n/g, " ")}`,
              )
              .join("\n\n");
      return `### Search ${i + 1}: "${entry.query}"\n${hits}`;
    })
    .join("\n\n");
}

export const groundednessJudge: Judge = {
  id: rubric.id,
  description: rubric.description,
  usesApi: true,
  hash: rubric.hash,
  judge: async (ctx) => {
    // No searches → can't be grounded by definition.
    if (!ctx.retrievedContext || ctx.retrievedContext.length === 0) {
      return {
        judgeId: rubric.id,
        score: 0,
        rawScore: 0,
        pass: false,
        rationale:
          "no searches performed; answer cannot be grounded in retrieved data",
      };
    }

    const userMessage = [
      `QUESTION: ${ctx.question}`,
      ``,
      `RETRIEVED CONTEXT (from search_wikipedia tool calls during the agent's run):`,
      formatRetrievedContext(ctx.retrievedContext),
      ``,
      `CANDIDATE ANSWER:`,
      ctx.answer || "(empty)",
    ].join("\n");

    const { text, usage } = await callLlmJudge(rubric, userMessage, ctx);
    return buildJudgeScore(rubric.id, text, usage);
  },
};
