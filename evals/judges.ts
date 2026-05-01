import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import Anthropic from "@anthropic-ai/sdk";
import { parse as parseYaml } from "yaml";

import type { RetrievedContext } from "../src/agent.ts";
import { shortHash } from "../src/hash.ts";
import { estimateJudgeCost } from "./cost.ts";
import type { JudgeScore } from "./types.ts";

const __dirname = dirname(fileURLToPath(import.meta.url));
const JUDGES_DIR = join(__dirname, "judges");

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
  /** SHA-256 fingerprint (12 hex chars) of the source YAML; absent for code-only judges. */
  hash?: string;
  judge: JudgeFn;
};

// ──────────────────────────────────────────────────────────────────────────────
// YAML rubric loader for LLM judges
// ──────────────────────────────────────────────────────────────────────────────

type Rubric = {
  id: string;
  description: string;
  systemPrompt: string;
  maxTokens: number;
  hash: string;
};

function loadRubric(filename: string): Rubric {
  const path = join(JUDGES_DIR, filename);
  const content = readFileSync(path, "utf-8");
  const data = parseYaml(content) as Partial<Rubric>;
  if (typeof data.id !== "string" || !data.id) {
    throw new Error(`${filename}: missing string "id"`);
  }
  if (typeof data.systemPrompt !== "string" || !data.systemPrompt) {
    throw new Error(`${filename}: missing string "systemPrompt"`);
  }
  if (typeof data.description !== "string") {
    throw new Error(`${filename}: missing string "description"`);
  }
  return {
    id: data.id,
    description: data.description,
    systemPrompt: data.systemPrompt,
    maxTokens: typeof data.maxTokens === "number" ? data.maxTokens : 256,
    hash: shortHash(content),
  };
}

const correctnessRubric = loadRubric("correctness.yaml");
const groundednessRubric = loadRubric("groundedness.yaml");

// ──────────────────────────────────────────────────────────────────────────────
// Citation judge — deterministic heuristic, no API call, no YAML
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
// Shared LLM-judge helpers
// ──────────────────────────────────────────────────────────────────────────────

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

async function callLlmJudge(
  rubric: Rubric,
  userMessage: string,
  ctx: JudgeContext,
): Promise<{
  text: string;
  usage: ReturnType<typeof judgeUsage>;
}> {
  const client = new Anthropic({ apiKey: ctx.apiKey });
  const response = await client.messages.create({
    model: ctx.judgeModel,
    max_tokens: rubric.maxTokens,
    system: rubric.systemPrompt,
    messages: [{ role: "user", content: userMessage }],
  });
  const usage = judgeUsage(response, ctx.judgeModel);
  const text = response.content
    .filter((b): b is Anthropic.Messages.TextBlock => b.type === "text")
    .map((b) => b.text)
    .join("");
  return { text, usage };
}

function buildJudgeScore(
  judgeId: string,
  text: string,
  usage: ReturnType<typeof judgeUsage>,
): JudgeScore {
  const parsed = parseJudgeJson(text);
  if (!parsed) {
    return {
      judgeId,
      score: 0,
      rationale: `judge could not parse JSON; raw: ${text.slice(0, 120)}`,
      usage,
    };
  }
  const raw = Math.max(0, Math.min(4, Math.round(parsed.score)));
  return {
    judgeId,
    score: raw / 4,
    rawScore: raw,
    pass: raw >= 3,
    rationale: parsed.rationale,
    usage,
  };
}

// ──────────────────────────────────────────────────────────────────────────────
// Correctness judge — needs gold answer
// ──────────────────────────────────────────────────────────────────────────────

const correctnessJudge: Judge = {
  id: correctnessRubric.id,
  description: correctnessRubric.description,
  usesApi: true,
  hash: correctnessRubric.hash,
  judge: async (ctx) => {
    if (!ctx.gold) {
      return {
        judgeId: correctnessRubric.id,
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

    const { text, usage } = await callLlmJudge(
      correctnessRubric,
      userMessage,
      ctx,
    );
    return buildJudgeScore(correctnessRubric.id, text, usage);
  },
};

// ──────────────────────────────────────────────────────────────────────────────
// Groundedness judge — needs retrievedContext
// ──────────────────────────────────────────────────────────────────────────────

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
  id: groundednessRubric.id,
  description: groundednessRubric.description,
  usesApi: true,
  hash: groundednessRubric.hash,
  judge: async (ctx) => {
    if (!ctx.retrievedContext || ctx.retrievedContext.length === 0) {
      return {
        judgeId: groundednessRubric.id,
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

    const { text, usage } = await callLlmJudge(
      groundednessRubric,
      userMessage,
      ctx,
    );
    return buildJudgeScore(groundednessRubric.id, text, usage);
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
