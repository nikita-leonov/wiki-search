import { test, describe } from "node:test";
import assert from "node:assert/strict";

import { estimateCost, estimateJudgeCost, PRICING } from "./cost.ts";

const ZERO_USAGE = {
  inputTokens: 0,
  cacheReadTokens: 0,
  cacheCreationTokens: 0,
  outputTokens: 0,
  thinkTokensApprox: 0,
  totalTokens: 0,
  cacheHitRate: 0,
};

describe("cost estimation", () => {
  test("returns 0 for unknown model id", () => {
    const cost = estimateCost("not-a-model", {
      ...ZERO_USAGE,
      inputTokens: 1_000_000,
      outputTokens: 1_000_000,
    });
    assert.equal(cost, 0);
  });

  test("computes Haiku cost from per-token rates", () => {
    const haiku = PRICING["claude-haiku-4-5-20251001"]!;
    const cost = estimateCost("claude-haiku-4-5-20251001", {
      ...ZERO_USAGE,
      inputTokens: 1_000_000,
      outputTokens: 1_000_000,
    });
    // 1M input + 1M output = $1 + $5 = $6 (at our hard-coded rates)
    assert.equal(cost, haiku.input + haiku.output);
  });

  test("includes cache-read and cache-write tokens at their distinct rates", () => {
    const cost = estimateCost("claude-haiku-4-5-20251001", {
      ...ZERO_USAGE,
      cacheReadTokens: 1_000_000,
      cacheCreationTokens: 1_000_000,
    });
    const haiku = PRICING["claude-haiku-4-5-20251001"]!;
    assert.equal(cost, haiku.cacheRead + haiku.cacheWrite);
  });

  test("zero usage → zero cost", () => {
    assert.equal(estimateCost("claude-haiku-4-5-20251001", ZERO_USAGE), 0);
  });

  test("estimateJudgeCost only charges input + output", () => {
    const cost = estimateJudgeCost("claude-sonnet-4-6", 1_000_000, 1_000_000);
    const sonnet = PRICING["claude-sonnet-4-6"]!;
    assert.equal(cost, sonnet.input + sonnet.output);
  });
});
