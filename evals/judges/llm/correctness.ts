import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import {
  buildJudgeScore,
  callLlmJudge,
  loadRubric,
  type Judge,
} from "../shared.ts";

const __dirname = dirname(fileURLToPath(import.meta.url));
const rubric = loadRubric(join(__dirname, "correctness.yaml"));

export const correctnessJudge: Judge = {
  id: rubric.id,
  description: rubric.description,
  usesApi: true,
  hash: rubric.hash,
  judge: async (ctx) => {
    if (!ctx.gold) {
      return {
        judgeId: rubric.id,
        score: 0,
        rationale: "no gold answer in dataset; correctness judge skipped",
      };
    }

    const userMessage = [
      `QUESTION: ${ctx.question}`,
      ``,
      `GOLD ANSWER: ${ctx.gold}`,
      ctx.notes ? `\nDATASET NOTES: ${ctx.notes}` : "",
      ``,
      `CANDIDATE ANSWER:`,
      ctx.answer || "(empty)",
    ]
      .filter(Boolean)
      .join("\n");

    const { text, usage } = await callLlmJudge(rubric, userMessage, ctx);
    return buildJudgeScore(rubric.id, text, usage);
  },
};
