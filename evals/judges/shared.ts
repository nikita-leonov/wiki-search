import { readFileSync } from "node:fs";

import Anthropic from "@anthropic-ai/sdk";
import { parse as parseYaml } from "yaml";

import { shortHash } from "../../src/hash.ts";
import { estimateJudgeCost } from "../cost.ts";
import type { JudgeScore } from "../types.ts";
import type { RetrievedContext } from "../../src/agent.ts";

// Shared types and helpers for both LLM-backed judges (./llm/) and
// deterministic judges (./deterministic/). Each kind imports from here.

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
// Rubric (LLM judge YAML) loader
// ──────────────────────────────────────────────────────────────────────────────

export type Rubric = {
  id: string;
  description: string;
  systemPrompt: string;
  maxTokens: number;
  hash: string;
};

export function loadRubric(absolutePath: string): Rubric {
  const content = readFileSync(absolutePath, "utf-8");
  const data = parseYaml(content) as Partial<Rubric>;
  if (typeof data.id !== "string" || !data.id) {
    throw new Error(`${absolutePath}: missing string "id"`);
  }
  if (typeof data.systemPrompt !== "string" || !data.systemPrompt) {
    throw new Error(`${absolutePath}: missing string "systemPrompt"`);
  }
  if (typeof data.description !== "string") {
    throw new Error(`${absolutePath}: missing string "description"`);
  }
  return {
    id: data.id,
    description: data.description,
    systemPrompt: data.systemPrompt,
    maxTokens: typeof data.maxTokens === "number" ? data.maxTokens : 256,
    hash: shortHash(content),
  };
}

// ──────────────────────────────────────────────────────────────────────────────
// LLM judge plumbing
// ──────────────────────────────────────────────────────────────────────────────

export type JudgeUsage = {
  inputTokens: number;
  outputTokens: number;
  costUsd: number;
};

function judgeUsage(
  response: Anthropic.Messages.Message,
  judgeModel: string,
): JudgeUsage {
  const inputTokens = response.usage.input_tokens ?? 0;
  const outputTokens = response.usage.output_tokens ?? 0;
  return {
    inputTokens,
    outputTokens,
    costUsd: estimateJudgeCost(judgeModel, inputTokens, outputTokens),
  };
}

export function parseJudgeJson(
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

export async function callLlmJudge(
  rubric: Rubric,
  userMessage: string,
  ctx: JudgeContext,
): Promise<{ text: string; usage: JudgeUsage }> {
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

export function buildJudgeScore(
  judgeId: string,
  text: string,
  usage: JudgeUsage,
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
