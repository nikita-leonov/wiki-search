import { test, describe } from "node:test";
import assert from "node:assert/strict";

import {
  aggregate,
  aggregateForJudge,
  Aggregator,
  buildSection,
  renderAllReports,
  renderTable,
} from "./reports.ts";
import type { EvalRow, EvalRunConfig } from "./types.ts";

const baseUsage = {
  inputTokens: 100,
  cacheReadTokens: 0,
  cacheCreationTokens: 0,
  outputTokens: 50,
  thinkTokensApprox: 0,
  totalTokens: 150,
  cacheHitRate: 0,
};

function makeRow(
  opts: Partial<EvalRow> & {
    promptId: string;
    datasetId: string;
    itemId: string;
    judgeScores?: { judgeId: string; score: number; pass?: boolean }[];
  },
): EvalRow {
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
    judgeCostUsd: opts.judgeCostUsd ?? 0,
    citationCount: opts.citationCount ?? 1,
    retrievedContext: [],
    judgeScores: (opts.judgeScores ?? []).map((s) => ({
      judgeId: s.judgeId,
      score: s.score,
      pass: s.pass,
    })),
    error: opts.error ?? null,
  };
}

const SMALL_CONFIG: EvalRunConfig = {
  prompts: ["v0", "v1"],
  datasets: ["factual"],
  judges: ["correctness", "citation"],
  iterations: 1,
  model: "claude-haiku-4-5-20251001",
  judgeModel: "claude-sonnet-4-6",
  concurrency: 1,
  maxTurns: 6,
};

describe("aggregate", () => {
  test("returns zeros for empty input", () => {
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

  test("computes p50 and p95 latency via interpolation", () => {
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
    assert.ok(Math.abs(a.p50LatencyMs - 550) < 0.01);
    assert.ok(Math.abs(a.p95LatencyMs - 955) < 0.01);
  });
});

describe("aggregate cost breakdown", () => {
  test("splits agent cost from judge cost; total is the sum", () => {
    const rows = [
      makeRow({
        promptId: "v1",
        datasetId: "d",
        itemId: "1",
        costUsd: 0.01,
        judgeCostUsd: 0.005,
        judgeScores: [{ judgeId: "a", score: 1.0 }],
      }),
      makeRow({
        promptId: "v1",
        datasetId: "d",
        itemId: "2",
        costUsd: 0.02,
        judgeCostUsd: 0.003,
        judgeScores: [{ judgeId: "a", score: 1.0 }],
      }),
    ];
    const a = aggregate(rows);
    assert.ok(Math.abs(a.agentCostUsd - 0.03) < 1e-9);
    assert.ok(Math.abs(a.judgeCostUsd - 0.008) < 1e-9);
    assert.ok(Math.abs(a.totalCostUsd - 0.038) < 1e-9);
  });

  test("aggregateForJudge filters judge cost to the pinned judge", () => {
    const rows = [
      makeRow({
        promptId: "v1",
        datasetId: "d",
        itemId: "1",
        costUsd: 0.01,
        judgeCostUsd: 0.008, // sum of correctness (0.005) + groundedness (0.003)
        judgeScores: [
          {
            judgeId: "correctness",
            score: 1.0,
          },
          {
            judgeId: "groundedness",
            score: 0.5,
          },
        ],
      }),
    ];
    // Set per-judge usage so aggregateForJudge can attribute cost
    rows[0]!.judgeScores[0]!.usage = {
      inputTokens: 100,
      outputTokens: 10,
      costUsd: 0.005,
    };
    rows[0]!.judgeScores[1]!.usage = {
      inputTokens: 200,
      outputTokens: 20,
      costUsd: 0.003,
    };

    const correctnessAgg = aggregateForJudge(rows, "correctness");
    assert.ok(Math.abs(correctnessAgg.judgeCostUsd - 0.005) < 1e-9);
    assert.ok(Math.abs(correctnessAgg.agentCostUsd - 0.01) < 1e-9);
    assert.ok(Math.abs(correctnessAgg.totalCostUsd - 0.015) < 1e-9);

    const groundednessAgg = aggregateForJudge(rows, "groundedness");
    assert.ok(Math.abs(groundednessAgg.judgeCostUsd - 0.003) < 1e-9);
    assert.ok(Math.abs(groundednessAgg.totalCostUsd - 0.013) < 1e-9);
  });
});

describe("aggregateForJudge", () => {
  test("filters scores to the specified judge", () => {
    const rows = [
      makeRow({
        promptId: "v1",
        datasetId: "d",
        itemId: "x",
        judgeScores: [
          { judgeId: "correctness", score: 1.0 },
          { judgeId: "citation", score: 0.0 },
        ],
      }),
    ];
    assert.equal(aggregateForJudge(rows, "correctness").meanScore, 1.0);
    assert.equal(aggregateForJudge(rows, "citation").meanScore, 0.0);
  });
});

describe("buildSection", () => {
  function makeMatrixRows(): EvalRow[] {
    // 2 prompts × 1 dataset × 2 items, each with two judges.
    // v1 dominates; correctness varies; citation always passes.
    const cells: Array<[string, string, string, number, number]> = [
      // [promptId, itemId, datasetId, correctnessScore, citationScore]
      ["v1", "i1", "d", 1.0, 1.0],
      ["v1", "i2", "d", 1.0, 1.0],
      ["v0", "i1", "d", 0.5, 1.0],
      ["v0", "i2", "d", 0.0, 1.0],
    ];
    return cells.map(([p, i, d, c, ci]) =>
      makeRow({
        promptId: p,
        datasetId: d,
        itemId: i,
        judgeScores: [
          { judgeId: "correctness", score: c },
          { judgeId: "citation", score: ci },
        ],
      }),
    );
  }

  function aggregatorFor(rows: EvalRow[]): Aggregator {
    const agg = new Aggregator();
    for (const r of rows) agg.add(r);
    return agg;
  }

  test("Judges section: primary aggregate followed by leaves, sorted by mean desc", () => {
    const agg = aggregatorFor(makeMatrixRows());
    const section = buildSection(agg, "judgeId", "promptId", "datasetId");

    // citation should rank above correctness (1.0 vs 0.625)
    const primaryRows = section.filter((r) => r.secondary === undefined);
    assert.equal(primaryRows.length, 2);
    assert.equal(primaryRows[0]?.primary, "citation");
    assert.equal(primaryRows[1]?.primary, "correctness");

    // Within the citation primary group, leaves include both prompts
    const citationLeaves = section.filter(
      (r) => r.primary === "citation" && r.secondary !== undefined,
    );
    assert.equal(citationLeaves.length, 2);
  });

  test("Prompts section: v1 ranks above v0", () => {
    const agg = aggregatorFor(makeMatrixRows());
    const section = buildSection(agg, "promptId", "datasetId", "judgeId");
    const primaryRows = section.filter((r) => r.secondary === undefined);
    assert.equal(primaryRows[0]?.primary, "v1");
    assert.equal(primaryRows[1]?.primary, "v0");
  });
});

describe("Aggregator parity with row-based aggregate", () => {
  function makeRows(): EvalRow[] {
    return [
      makeRow({
        promptId: "v1",
        datasetId: "factual",
        itemId: "1",
        latencyMs: 1000,
        costUsd: 0.01,
        judgeCostUsd: 0.005,
        judgeScores: [
          { judgeId: "correctness", score: 1.0, pass: true },
          { judgeId: "citation", score: 1.0, pass: true },
        ],
      }),
      makeRow({
        promptId: "v0",
        datasetId: "factual",
        itemId: "1",
        latencyMs: 2000,
        costUsd: 0.02,
        judgeCostUsd: 0.003,
        judgeScores: [
          { judgeId: "correctness", score: 0.5, pass: false },
          { judgeId: "citation", score: 1.0, pass: true },
        ],
      }),
    ];
  }

  test("overall() matches aggregate(rows) for the same input", () => {
    const rows = makeRows();
    const direct = aggregate(rows);
    const a = new Aggregator();
    for (const r of rows) a.add(r);
    const streaming = a.overall();

    assert.ok(Math.abs(direct.meanScore - streaming.meanScore) < 1e-9);
    assert.equal(direct.count, streaming.count);
    assert.equal(direct.errorCount, streaming.errorCount);
    assert.equal(direct.totalTokens, streaming.totalTokens);
    assert.ok(
      Math.abs(direct.agentCostUsd - streaming.agentCostUsd) < 1e-9,
      "agentCost mismatch",
    );
    assert.ok(
      Math.abs(direct.judgeCostUsd - streaming.judgeCostUsd) < 1e-9,
      "judgeCost mismatch",
    );
    assert.ok(
      Math.abs(direct.p50LatencyMs - streaming.p50LatencyMs) < 1e-9,
    );
  });

  test("bucket(prompt) matches aggregate of filtered rows", () => {
    const rows = makeRows();
    const v1Rows = rows.filter((r) => r.promptId === "v1");
    const direct = aggregate(v1Rows);

    const a = new Aggregator();
    for (const r of rows) a.add(r);
    const streaming = a.bucket("v1");

    assert.ok(Math.abs(direct.meanScore - streaming.meanScore) < 1e-9);
    assert.equal(direct.count, streaming.count);
  });

  test("bucket(prompt, dataset, judge) matches aggregateForJudge of filtered rows", () => {
    const rows = makeRows();
    const direct = aggregateForJudge(rows, "correctness");

    const a = new Aggregator();
    for (const r of rows) a.add(r);
    // The aggregator's "all rows + correctness pin" bucket is bucket(undefined, undefined, "correctness")
    const streaming = a.bucket(undefined, undefined, "correctness");

    assert.ok(Math.abs(direct.meanScore - streaming.meanScore) < 1e-9);
    assert.equal(direct.count, streaming.count);
    assert.ok(
      Math.abs(direct.judgeCostUsd - streaming.judgeCostUsd) < 1e-9,
    );
  });
});

describe("renderTable", () => {
  test("primary appears once per group; continuation rows are blanked", () => {
    const rows = [
      {
        primary: "alpha",
        agg: aggregate([
          makeRow({
            promptId: "x",
            datasetId: "y",
            itemId: "z",
            judgeScores: [{ judgeId: "j", score: 0.8 }],
          }),
        ]),
      },
      {
        primary: "alpha",
        secondary: "v1",
        tertiary: "factual",
        agg: aggregate([
          makeRow({
            promptId: "v1",
            datasetId: "factual",
            itemId: "i1",
            judgeScores: [{ judgeId: "j", score: 0.9 }],
          }),
        ]),
      },
      {
        primary: "alpha",
        secondary: "v0",
        tertiary: "factual",
        agg: aggregate([
          makeRow({
            promptId: "v0",
            datasetId: "factual",
            itemId: "i1",
            judgeScores: [{ judgeId: "j", score: 0.5 }],
          }),
        ]),
      },
    ];
    const out = renderTable(rows);
    const lines = out.split("\n");
    // Header + rule + 3 data rows = 5 lines
    assert.equal(lines.length, 5);
    // First data row contains the primary verbatim
    assert.match(lines[2]!, /alpha/);
    // Continuation rows hide the primary (don't contain "alpha", only the path)
    assert.match(lines[3]!, /\\ v1 \\ factual/);
    assert.doesNotMatch(lines[3]!, /alpha/);
    assert.match(lines[4]!, /\\ v0 \\ factual/);
    assert.doesNotMatch(lines[4]!, /alpha/);
  });

  test("renders a placeholder for empty input", () => {
    assert.match(renderTable([]), /no data/);
  });
});

describe("renderAllReports", () => {
  test("includes section labels, plain-text headers, and run metadata", () => {
    const rows = [
      makeRow({
        promptId: "v1",
        datasetId: "factual",
        itemId: "x",
        judgeScores: [{ judgeId: "correctness", score: 1.0, pass: true }],
      }),
    ];
    const md = renderAllReports(SMALL_CONFIG, rows, {
      runAt: "2026-04-30T12:00:00.000Z",
      runDurationMs: 12_345,
    });
    assert.match(md, /^Eval Report/);
    assert.match(md, /run at:\s+2026-04-30T12:00:00\.000Z/);
    assert.match(md, /Judges:/);
    assert.match(md, /Prompts:/);
    assert.match(md, /Datasets:/);
    // Plain text — no markdown headings or pipe-table syntax aside from our
    // single Group/data separator
    assert.doesNotMatch(md, /^#/m);
  });
});
