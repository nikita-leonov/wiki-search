// Renders the eval report with synthetic data. No API calls. Useful for
// iterating on report layout without paying for a live eval run.

import { renderAllReports } from "../evals/reports.ts";
import type { EvalRow, EvalRunConfig } from "../evals/types.ts";

const config: EvalRunConfig = {
  prompts: ["v0", "v1"],
  datasets: ["factual", "ambiguous", "multihop"],
  judges: ["correctness", "citation", "groundedness"],
  iterations: 3,
  model: "claude-haiku-4-5-20251001",
  judgeModel: "claude-sonnet-4-6",
  concurrency: 4,
  maxTurns: 6,
};

const ITEMS_PER_DATASET: Record<string, string[]> = {
  factual: ["q1", "q2", "q3", "q4", "q5", "q6", "q7"],
  ambiguous: ["q1", "q2", "q3", "q4", "q5"],
  multihop: ["q1", "q2", "q3", "q4", "q5"],
};

// v1 is the better prompt; correctness varies by dataset; citation is
// near-perfect for v1, weaker for v0.
function syntheticScore(
  promptId: string,
  datasetId: string,
  judgeId: string,
  rng: () => number,
): { score: number; pass: boolean } {
  let base: number;
  if (judgeId === "citation") {
    base = promptId === "v1" ? 0.95 : 0.55;
  } else if (judgeId === "groundedness") {
    // v1 is much more disciplined about grounding answers in retrieved data
    base = promptId === "v1" ? 0.88 : 0.45;
  } else {
    const datasetBias =
      datasetId === "factual" ? 0.0 : datasetId === "ambiguous" ? -0.15 : -0.25;
    base = (promptId === "v1" ? 0.85 : 0.55) + datasetBias;
  }
  const noise = (rng() - 0.5) * 0.15;
  const score = Math.max(0, Math.min(1, base + noise));
  return { score, pass: score >= 0.6 };
}

function makeRng(seed: number): () => number {
  let s = seed;
  return () => {
    s = (s * 9301 + 49297) % 233280;
    return s / 233280;
  };
}

function syntheticRows(): EvalRow[] {
  const rng = makeRng(42);
  const rows: EvalRow[] = [];
  for (const promptId of config.prompts) {
    for (const datasetId of config.datasets) {
      for (const itemId of ITEMS_PER_DATASET[datasetId]!) {
        for (let i = 0; i < config.iterations; i++) {
          const inputTokens = Math.round(800 + rng() * 1200);
          const outputTokens = Math.round(120 + rng() * 200);
          const cacheReadTokens = Math.round(rng() < 0.3 ? rng() * 600 : 0);
          rows.push({
            promptId,
            datasetId,
            itemId,
            iterationIdx: i,
            question: `Q ${itemId}`,
            answer: `A ${itemId}`,
            answerChars: 200,
            turns: Math.round(2 + rng() * 2),
            searches: Math.round(1 + rng() * 2),
            stopped: "end_turn",
            usage: {
              inputTokens,
              cacheReadTokens,
              cacheCreationTokens: 0,
              outputTokens,
              thinkTokensApprox: 0,
              totalTokens: inputTokens + cacheReadTokens + outputTokens,
            },
            latencyMs: Math.round(800 + rng() * 3000),
            costUsd: 0.001 + rng() * 0.005,
            citationCount: rng() > 0.2 ? 1 : 0,
            retrievedContext: [],
            judgeCostUsd: 0, // populated below
            judgeScores: config.judges.map((j) => {
              const s = syntheticScore(promptId, datasetId, j, rng);
              // Synthetic per-judge token usage so the cost breakdown looks
              // realistic. Citation has no API call → no usage.
              const usage =
                j === "citation"
                  ? undefined
                  : j === "groundedness"
                    ? {
                        inputTokens: 2800 + Math.round(rng() * 1500),
                        outputTokens: 60 + Math.round(rng() * 40),
                        costUsd: 0,
                      }
                    : {
                        inputTokens: 550 + Math.round(rng() * 200),
                        outputTokens: 40 + Math.round(rng() * 20),
                        costUsd: 0,
                      };
              if (usage) {
                // Sonnet 4.6 rates from cost.ts
                usage.costUsd =
                  (usage.inputTokens / 1_000_000) * 3.0 +
                  (usage.outputTokens / 1_000_000) * 15.0;
              }
              return {
                judgeId: j,
                score: s.score,
                rawScore:
                  j === "correctness" || j === "groundedness"
                    ? Math.round(s.score * 4)
                    : 1,
                pass: s.pass,
                usage,
              };
            }),
            error: null,
          });
          const last = rows[rows.length - 1]!;
          last.judgeCostUsd = last.judgeScores.reduce(
            (s, j) => s + (j.usage?.costUsd ?? 0),
            0,
          );
        }
      }
    }
  }
  return rows;
}

const rows = syntheticRows();
const out = renderAllReports(config, rows, {
  runAt: new Date().toISOString(),
  runDurationMs: 142_000,
  artifacts: {
    prompts: { v0: "abc123def456", v1: "1234567890ab" },
    judges: { correctness: "fedcba987654", groundedness: "0011223344aa" },
    datasets: {
      factual: "deadbeef0001",
      ambiguous: "deadbeef0002",
      multihop: "deadbeef0003",
    },
  },
});
process.stdout.write(out + "\n");
