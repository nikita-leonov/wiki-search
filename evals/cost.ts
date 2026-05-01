import type { AgentUsage } from "../src/agent.ts";

export type ModelPricing = {
  /** USD per 1M input tokens (uncached). */
  input: number;
  /** USD per 1M cache-read tokens. */
  cacheRead: number;
  /** USD per 1M cache-write tokens (5-minute TTL). */
  cacheWrite: number;
  /** USD per 1M output tokens. */
  output: number;
};

/**
 * Approximate published pricing as of late 2025. Hard-coded so the eval can
 * report cost without external configuration. If a model id is missing from
 * this table the eval reports cost as 0 — it does not throw.
 */
export const PRICING: Record<string, ModelPricing> = {
  "claude-haiku-4-5-20251001": {
    input: 1.0,
    cacheRead: 0.1,
    cacheWrite: 1.25,
    output: 5.0,
  },
  "claude-sonnet-4-6": {
    input: 3.0,
    cacheRead: 0.3,
    cacheWrite: 3.75,
    output: 15.0,
  },
  "claude-opus-4-7": {
    input: 15.0,
    cacheRead: 1.5,
    cacheWrite: 18.75,
    output: 75.0,
  },
};

export function estimateCost(model: string, usage: AgentUsage): number {
  const p = PRICING[model];
  if (!p) return 0;
  return (
    (usage.inputTokens / 1_000_000) * p.input +
    (usage.cacheReadTokens / 1_000_000) * p.cacheRead +
    (usage.cacheCreationTokens / 1_000_000) * p.cacheWrite +
    (usage.outputTokens / 1_000_000) * p.output
  );
}

export function estimateJudgeCost(
  model: string,
  inputTokens: number,
  outputTokens: number,
): number {
  const p = PRICING[model];
  if (!p) return 0;
  return (
    (inputTokens / 1_000_000) * p.input +
    (outputTokens / 1_000_000) * p.output
  );
}
