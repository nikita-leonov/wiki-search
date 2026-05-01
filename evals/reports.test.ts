import { test, describe } from "node:test";
import assert from "node:assert/strict";

import { aggregate, renderReport } from "./reports.ts";
import type { EvalRow } from "./types.ts";

const baseUsage = {
  inputTokens: 100,
  cacheReadTokens: 0,
  cacheCreationTokens: 0,
  outputTokens: 50,
  thinkTokensApprox: 0,
  totalTokens: 150,
  cacheHitRate: 0,
};

function makeRow(opts: Partial<EvalRow> & {
  promptId: string;
  datasetId: string;
  itemId: string;
  judgeScores?: { judgeId: string; score: number; pass?: boolean }[];
}): EvalRow {
  return {
    promptId: opts.promptId,
    datasetId: opts.datasetId,
    itemId: opts.itemId,
    question: opts.question ?? "q",
    iterationIdx: opts.iterationIdx ?? 0,
    answer: opts.answer ?? "an answer",
    answerChars: opts.answerChars ?? 9,
    turns: opts.turns ?? 1,
    searches: opts.searches ?? 1,
    stopped: opts.stopped ?? "end_turn",
    usage: opts.usage ?? baseUsage,
    latencyMs: opts.latencyMs ?? 1000,
    costUsd: opts.costUsd ?? 0.001,
    citationCount: opts.citationCount ?? 1,
    judgeScores: (opts.judgeScores ?? []).map((s) => ({
      judgeId: s.judgeId,
      score: s.score,
      pass: s.pass,
    })),
    error: opts.error ?? null,
  };
}

describe("aggregate", () => {
  test("returns zeros for an empty input", () => {
    const a = aggregate([]);
    assert.equal(a.count, 0);
    assert.equal(a.errorCount, 0);
    assert.equal(a.meanScore, 0);
    assert.equal(a.totalCostUsd, 0);
  });

  test("computes mean score across all judges", () => {
    const rows = [
      makeRow({
        promptId: "v1",
        datasetId: "d",
        itemId: "x",
        judgeScores: [
          { judgeId: "a", score: 1.0 },
          { judgeId: "b", score: 0.5 },
        ],
      }),
    ];
    const a = aggregate(rows);
    assert.equal(a.meanScore, 0.75);
    assert.equal(a.meanScoreByJudge.a, 1.0);
    assert.equal(a.meanScoreByJudge.b, 0.5);
  });

  test("counts errors separately and excludes them from metrics", () => {
    const rows = [
      makeRow({
        promptId: "v1",
        datasetId: "d",
        itemId: "x",
        judgeScores: [{ judgeId: "a", score: 1.0 }],
        error: null,
      }),
      makeRow({
        promptId: "v1",
        datasetId: "d",
        itemId: "y",
        judgeScores: [],
        error: "boom",
      }),
    ];
    const a = aggregate(rows);
    assert.equal(a.count, 2);
    assert.equal(a.errorCount, 1);
    // mean computed only from the non-error row
    assert.equal(a.meanScore, 1.0);
  });

  test("computes pass rate per judge", () => {
    const rows = [
      makeRow({
        promptId: "v1",
        datasetId: "d",
        itemId: "1",
        judgeScores: [{ judgeId: "a", score: 1, pass: true }],
      }),
      makeRow({
        promptId: "v1",
        datasetId: "d",
        itemId: "2",
        judgeScores: [{ judgeId: "a", score: 0, pass: false }],
      }),
      makeRow({
        promptId: "v1",
        datasetId: "d",
        itemId: "3",
        judgeScores: [{ judgeId: "a", score: 1, pass: true }],
      }),
    ];
    const a = aggregate(rows);
    assert.equal(a.passRateByJudge.a, 2 / 3);
  });

  test("computes p50 and p95 of latency", () => {
    const latencies = [100, 200, 300, 400, 500, 600, 700, 800, 900, 1000];
    const rows = latencies.map((ms, i) =>
      makeRow({
        promptId: "v1",
        datasetId: "d",
        itemId: `i${i}`,
        latencyMs: ms,
        judgeScores: [{ judgeId: "a", score: 1 }],
      }),
    );
    const a = aggregate(rows);
    // Linear interpolation between 5th (500) and 6th (600) values for p50
    assert.ok(Math.abs(a.p50LatencyMs - 550) < 0.01);
    // p95 = interpolation between 900 and 1000
    assert.ok(Math.abs(a.p95LatencyMs - 955) < 0.01);
  });
});

describe("renderReport", () => {
  test("produces a markdown header and sections per primary group", () => {
    const rows = [
      makeRow({
        promptId: "v1",
        datasetId: "d",
        itemId: "1",
        judgeScores: [{ judgeId: "a", score: 1 }],
      }),
      makeRow({
        promptId: "v0",
        datasetId: "d",
        itemId: "1",
        judgeScores: [{ judgeId: "a", score: 0 }],
      }),
    ];
    const md = renderReport("Test", rows, "promptId", [
      "promptId",
      "datasetId",
      "judgeId",
    ]);
    assert.match(md, /# Test/);
    assert.match(md, /Grouping: promptId → datasetId → judgeId/);
    assert.match(md, /prompt: v1/);
    assert.match(md, /prompt: v0/);
    // v1 should come first because it has higher meanScore
    const v1Idx = md.indexOf("prompt: v1");
    const v0Idx = md.indexOf("prompt: v0");
    assert.ok(v1Idx >= 0 && v0Idx >= 0 && v1Idx < v0Idx);
  });

  test("renders an empty-rows placeholder gracefully", () => {
    const md = renderReport("Empty", [], "promptId", ["promptId"]);
    assert.match(md, /no rows/);
  });
});
