import { readFileSync } from "node:fs";

import Anthropic from "@anthropic-ai/sdk";
import { parse as parseYaml } from "yaml";

import type { RetrievedContext } from "../../src/agent.ts";
import { shortHash } from "../../src/hash.ts";
import { estimateJudgeCost } from "../cost.ts";
import type { JudgeScore } from "../types.ts";

// Shared types and helpers for both LLM-backed judges (YAML in ./llm/) and
// deterministic judges (TS in ./deterministic/). All LLM judges use the same
// generic runner — they differ only in their YAML rubric. There is no
// per-judge wiring code under ./llm/ anymore.

export type JudgeContext = {
  question: string;
  answer: string;
  gold?: string;
  notes?: string;
  /** Snippets retrieved during the agent's run, for use in the judge prompt. */
  retrievedContext?: RetrievedContext[];
  apiKey: string;
  judgeModel: string;
  /** SDK retries on 429 / 5xx; defaults to 5. */
  maxApiRetries?: number;
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
// Rubric (LLM-judge YAML schema)
// ──────────────────────────────────────────────────────────────────────────────

export type RubricRequirement = {
  /** Name of the field in JudgeContext (e.g. "gold", "retrievedContext"). */
  field: string;
  /** Rationale string used in the JudgeScore when the field is missing. */
  skipRationale: string;
  /** For arrays/strings: empty value also counts as missing. Default false. */
  nonEmpty?: boolean;
};

export type Rubric = {
  id: string;
  description: string;
  systemPrompt: string;
  /** Mustache-ish user-message template (see renderTemplate). */
  userMessage: string;
  maxTokens: number;
  requires: RubricRequirement[];
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
  if (typeof data.userMessage !== "string" || !data.userMessage) {
    throw new Error(`${absolutePath}: missing string "userMessage"`);
  }
  if (typeof data.description !== "string") {
    throw new Error(`${absolutePath}: missing string "description"`);
  }
  return {
    id: data.id,
    description: data.description,
    systemPrompt: data.systemPrompt,
    userMessage: data.userMessage,
    maxTokens: typeof data.maxTokens === "number" ? data.maxTokens : 256,
    requires: Array.isArray(data.requires) ? data.requires : [],
    hash: shortHash(content),
  };
}

// ──────────────────────────────────────────────────────────────────────────────
// Template rendering: {{var}} substitution + {{#var}}...{{/var}} sections.
// Sections are included iff vars[var] is truthy (non-empty string). After
// section removal, runs of >=3 consecutive newlines are collapsed to 2 to
// keep the rendered prompt tidy.
// ──────────────────────────────────────────────────────────────────────────────

export function renderTemplate(
  template: string,
  vars: Record<string, string | undefined>,
): string {
  let out = template.replace(
    /\{\{#(\w+)\}\}([\s\S]*?)\{\{\/\1\}\}/g,
    (_, field, body) => (vars[field] ? body : ""),
  );
  out = out.replace(/\{\{(\w+)\}\}/g, (_, field) => vars[field] ?? "");
  out = out.replace(/\n\n\n+/g, "\n\n");
  return out;
}

// ──────────────────────────────────────────────────────────────────────────────
// Retrieved-context formatter — substituted as {{retrievedContext}}.
// ──────────────────────────────────────────────────────────────────────────────

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

// ──────────────────────────────────────────────────────────────────────────────
// LLM-judge plumbing
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

const DEFAULT_MAX_API_RETRIES = 5;

async function callApi(
  rubric: Rubric,
  userMessage: string,
  ctx: JudgeContext,
): Promise<{ text: string; usage: JudgeUsage }> {
  const client = new Anthropic({
    apiKey: ctx.apiKey,
    maxRetries: ctx.maxApiRetries ?? DEFAULT_MAX_API_RETRIES,
  });
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

function isRequiredFieldMissing(
  ctx: JudgeContext,
  req: RubricRequirement,
): boolean {
  const value = (ctx as unknown as Record<string, unknown>)[req.field];
  if (value === undefined || value === null) return true;
  if (req.nonEmpty) {
    if (Array.isArray(value) && value.length === 0) return true;
    if (typeof value === "string" && value.trim().length === 0) return true;
  }
  return false;
}

/**
 * Build a Judge from a Rubric YAML. The judge:
 *   1. Validates `requires` against the JudgeContext. If any required
 *      field is missing, returns score=0 with the rubric's skipRationale —
 *      no API call is made.
 *   2. Renders `userMessage` with substitutions for {{question}},
 *      {{answer}}, {{gold}}, {{notes}}, and {{retrievedContext}}
 *      (auto-formatted from the array). Conditional sections via
 *      {{#field}}...{{/field}} are included iff the field is truthy.
 *   3. Calls Anthropic with the rubric's system prompt + the rendered
 *      user message, parses the JSON response, returns a JudgeScore.
 */
export function makeLlmJudge(rubric: Rubric): Judge {
  return {
    id: rubric.id,
    description: rubric.description,
    usesApi: true,
    hash: rubric.hash,
    judge: async (ctx) => {
      for (const req of rubric.requires) {
        if (isRequiredFieldMissing(ctx, req)) {
          return {
            judgeId: rubric.id,
            score: 0,
            rawScore: 0,
            pass: false,
            rationale: req.skipRationale,
          };
        }
      }

      const vars: Record<string, string> = {
        question: ctx.question,
        answer: ctx.answer || "(empty)",
        gold: ctx.gold ?? "",
        notes: ctx.notes ?? "",
        retrievedContext:
          ctx.retrievedContext && ctx.retrievedContext.length > 0
            ? formatRetrievedContext(ctx.retrievedContext)
            : "",
      };

      const userMessage = renderTemplate(rubric.userMessage, vars);
      const { text, usage } = await callApi(rubric, userMessage, ctx);
      return buildJudgeScore(rubric.id, text, usage);
    },
  };
}
