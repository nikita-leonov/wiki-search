import Anthropic from "@anthropic-ai/sdk";

import type { JudgeScore } from "./types.ts";

export type JudgeContext = {
  question: string;
  answer: string;
  gold?: string;
  notes?: string;
  apiKey: string;
  judgeModel: string;
};

export type JudgeFn = (ctx: JudgeContext) => Promise<JudgeScore>;

export type Judge = {
  id: string;
  description: string;
  /** True if this judge calls the Anthropic API (used for cost reporting). */
  usesApi: boolean;
  judge: JudgeFn;
};

// ──────────────────────────────────────────────────────────────────────────────
// Citation judge — deterministic heuristic, no API call
// ──────────────────────────────────────────────────────────────────────────────

const WIKI_URL_RE = /https?:\/\/[a-z]{2,3}\.wikipedia\.org\/wiki\/[^\s)\]>"']+/gi;

export function countCitations(answer: string): number {
  const matches = answer.match(WIKI_URL_RE);
  return matches ? matches.length : 0;
}

const citationJudge: Judge = {
  id: "citation",
  description:
    "Heuristic: pass if the answer cites at least one wikipedia.org URL. No API call.",
  usesApi: false,
  judge: async (ctx) => {
    const count = countCitations(ctx.answer);
    return {
      judgeId: "citation",
      score: count > 0 ? 1 : 0,
      rawScore: count,
      pass: count > 0,
      rationale:
        count > 0
          ? `${count} wikipedia.org URL${count === 1 ? "" : "s"} cited`
          : "no wikipedia.org URLs in answer",
    };
  },
};

// ──────────────────────────────────────────────────────────────────────────────
// Correctness judge — LLM-as-judge against gold answer
// ──────────────────────────────────────────────────────────────────────────────

const CORRECTNESS_RUBRIC = `You evaluate whether an AI assistant's answer to a question is factually correct, using a reference "gold" answer as ground truth.

Score the candidate answer on a 0–4 rubric:
- 0 = Wrong. Contradicts the gold answer or is meaningfully incorrect.
- 1 = Mostly wrong. Some correct elements but significant errors.
- 2 = Partially correct. Core fact roughly right but details off, missing, or hedged in misleading ways.
- 3 = Correct. Core fact matches the gold answer; minor stylistic differences are fine.
- 4 = Correct and complete. Core fact right AND adds appropriate nuance, citations, or context beyond the gold answer.

Be strict but fair. Do not penalize a candidate for adding correct extra detail. Do penalize hallucinated facts even if the main answer is right.

Respond ONLY with a single JSON object on one line:
{"score": <0|1|2|3|4>, "rationale": "<one short sentence>"}`;

function parseJudgeJson(
  text: string,
): { score: number; rationale: string } | null {
  // Tolerant parser: find the first JSON object containing "score".
  const match = text.match(/\{[^{}]*"score"[^{}]*\}/);
  if (!match) return null;
  try {
    const parsed = JSON.parse(match[0]) as {
      score?: unknown;
      rationale?: unknown;
    };
    const score = Number(parsed.score);
    if (!Number.isFinite(score)) return null;
    const rationale =
      typeof parsed.rationale === "string" ? parsed.rationale : "";
    return { score, rationale };
  } catch {
    return null;
  }
}

const correctnessJudge: Judge = {
  id: "correctness",
  description:
    "LLM-as-judge: scores candidate against gold answer on a 0–4 factual-correctness rubric.",
  usesApi: true,
  judge: async (ctx) => {
    if (!ctx.gold) {
      return {
        judgeId: "correctness",
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

    const client = new Anthropic({ apiKey: ctx.apiKey });
    const response = await client.messages.create({
      model: ctx.judgeModel,
      max_tokens: 256,
      system: CORRECTNESS_RUBRIC,
      messages: [{ role: "user", content: userMessage }],
    });

    const text = response.content
      .filter((b): b is Anthropic.Messages.TextBlock => b.type === "text")
      .map((b) => b.text)
      .join("");

    const parsed = parseJudgeJson(text);
    if (!parsed) {
      return {
        judgeId: "correctness",
        score: 0,
        rationale: `judge could not parse JSON; raw: ${text.slice(0, 120)}`,
      };
    }

    const raw = Math.max(0, Math.min(4, Math.round(parsed.score)));
    return {
      judgeId: "correctness",
      score: raw / 4,
      rawScore: raw,
      pass: raw >= 3,
      rationale: parsed.rationale,
    };
  },
};

// ──────────────────────────────────────────────────────────────────────────────
// Registry
// ──────────────────────────────────────────────────────────────────────────────

export const JUDGES: Record<string, Judge> = {
  correctness: correctnessJudge,
  citation: citationJudge,
};

export function getJudge(id: string): Judge {
  const j = JUDGES[id];
  if (!j) {
    throw new Error(
      `Unknown judge id "${id}". Available: ${Object.keys(JUDGES).join(", ")}`,
    );
  }
  return j;
}

export function listJudgeIds(): string[] {
  return Object.keys(JUDGES);
}

// Exposed for tests.
export { parseJudgeJson };
