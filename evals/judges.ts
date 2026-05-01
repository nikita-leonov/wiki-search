import Anthropic from "@anthropic-ai/sdk";

import type { RetrievedContext } from "../src/agent.ts";
import { estimateJudgeCost } from "./cost.ts";
import type { JudgeScore } from "./types.ts";

function judgeUsage(
  response: Anthropic.Messages.Message,
  judgeModel: string,
): { inputTokens: number; outputTokens: number; costUsd: number } {
  const inputTokens = response.usage.input_tokens ?? 0;
  const outputTokens = response.usage.output_tokens ?? 0;
  return {
    inputTokens,
    outputTokens,
    costUsd: estimateJudgeCost(judgeModel, inputTokens, outputTokens),
  };
}

export type JudgeContext = {
  question: string;
  answer: string;
  gold?: string;
  notes?: string;
  /** Snippets retrieved during the agent's run, used by groundedness. */
  retrievedContext?: RetrievedContext[];
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
    const usage = judgeUsage(response, ctx.judgeModel);

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
        usage,
      };
    }

    const raw = Math.max(0, Math.min(4, Math.round(parsed.score)));
    return {
      judgeId: "correctness",
      score: raw / 4,
      rawScore: raw,
      pass: raw >= 3,
      rationale: parsed.rationale,
      usage,
    };
  },
};

// ──────────────────────────────────────────────────────────────────────────────
// Groundedness judge — LLM-as-judge with retrieved snippets as context
// ──────────────────────────────────────────────────────────────────────────────

const GROUNDEDNESS_RUBRIC = `You evaluate whether an AI assistant's answer is GROUNDED in source material — that is, whether every factual claim in the answer can be traced to one of the retrieved Wikipedia snippets shown to you.

The assistant has access to a search_wikipedia tool. You will see each query it ran and the snippets it received. Your job is to check whether the answer's factual claims (dates, names, numbers, identifications, causal claims) are present in those snippets — NOT whether the answer is correct against the world. An answer can be correct yet ungrounded (the model recalled it from training data without retrieval support); that should score low here.

Scoring rubric (0–4):
- 0 = Ungrounded. The answer makes specific factual claims that are NOT present in any retrieved snippet.
- 1 = Mostly ungrounded. A few claims supported, several are not.
- 2 = Partially grounded. Roughly half the factual claims trace to retrieved snippets.
- 3 = Well-grounded. All major factual claims trace to retrieved snippets; minor framing or stylistic content may be unsupported but adds no new facts.
- 4 = Fully grounded. Every factual claim is clearly supported by a specific retrieved snippet, OR the answer correctly states that the retrieved data does not cover the question.

Notes:
- Stylistic or explanatory framing without new facts is fine.
- If multiple snippets cover the same claim, the claim is grounded.
- If a snippet contradicts the answer, that's an error against grounding (the answer didn't follow what was retrieved).

Respond ONLY with a single JSON object on one line:
{"score": <0|1|2|3|4>, "rationale": "<one short sentence>"}`;

function formatRetrievedContext(context: RetrievedContext[]): string {
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

const groundednessJudge: Judge = {
  id: "groundedness",
  description:
    "LLM-as-judge: scores whether the answer's factual claims trace back to retrieved Wikipedia snippets.",
  usesApi: true,
  judge: async (ctx) => {
    // No searches → can't be grounded by definition.
    if (!ctx.retrievedContext || ctx.retrievedContext.length === 0) {
      return {
        judgeId: "groundedness",
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

    const client = new Anthropic({ apiKey: ctx.apiKey });
    const response = await client.messages.create({
      model: ctx.judgeModel,
      max_tokens: 256,
      system: GROUNDEDNESS_RUBRIC,
      messages: [{ role: "user", content: userMessage }],
    });
    const usage = judgeUsage(response, ctx.judgeModel);

    const text = response.content
      .filter((b): b is Anthropic.Messages.TextBlock => b.type === "text")
      .map((b) => b.text)
      .join("");

    const parsed = parseJudgeJson(text);
    if (!parsed) {
      return {
        judgeId: "groundedness",
        score: 0,
        rationale: `judge could not parse JSON; raw: ${text.slice(0, 120)}`,
        usage,
      };
    }

    const raw = Math.max(0, Math.min(4, Math.round(parsed.score)));
    return {
      judgeId: "groundedness",
      score: raw / 4,
      rawScore: raw,
      pass: raw >= 3,
      rationale: parsed.rationale,
      usage,
    };
  },
};

// ──────────────────────────────────────────────────────────────────────────────
// Registry
// ──────────────────────────────────────────────────────────────────────────────

export const JUDGES: Record<string, Judge> = {
  correctness: correctnessJudge,
  citation: citationJudge,
  groundedness: groundednessJudge,
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
export { parseJudgeJson, formatRetrievedContext };
