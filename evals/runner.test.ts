import { test, describe } from "node:test";
import assert from "node:assert/strict";

import {
  formatCost,
  formatDuration,
  formatLatency,
  formatTokens,
} from "./runner.ts";

describe("progress formatters", () => {
  test("formatTokens uses K and M suffixes", () => {
    assert.equal(formatTokens(0), "0t");
    assert.equal(formatTokens(999), "999t");
    assert.equal(formatTokens(1000), "1.0Kt");
    assert.equal(formatTokens(14523), "14.5Kt");
    assert.equal(formatTokens(1_500_000), "1.50Mt");
  });

  test("formatCost scales precision with magnitude", () => {
    assert.equal(formatCost(0), "$0.0000");
    assert.equal(formatCost(0.0034), "$0.0034");
    assert.equal(formatCost(0.5), "$0.500");
    assert.equal(formatCost(12.345), "$12.35");
  });

  test("formatLatency switches to seconds at 1s+", () => {
    assert.equal(formatLatency(500), "500ms");
    assert.equal(formatLatency(999), "999ms");
    assert.equal(formatLatency(1000), "1.0s");
    assert.equal(formatLatency(2345), "2.3s");
  });

  test("formatDuration rolls up minutes and hours", () => {
    assert.equal(formatDuration(45), "45s");
    assert.equal(formatDuration(125), "2m5s");
    assert.equal(formatDuration(3725), "1h2m");
    assert.equal(formatDuration(-1), "?");
    assert.equal(formatDuration(NaN), "?");
  });
});
