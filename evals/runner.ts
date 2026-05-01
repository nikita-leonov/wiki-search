import { answerQuestion, type AgentResult, type AgentUsage } from "../src/agent.ts";

import { estimateCost } from "./cost.ts";
import {
  getJudge,
  getPrompt,
  loadDataset,
  type Judge,
  type PromptConfig,
} from "./registry.ts";
import { countCitations } from "./judges.ts";
import type {
  DatasetItem,
  EvalRow,
  EvalRunConfig,
  JudgeScore,
  MatrixCell,
} from "./types.ts";

export type ResolvedMatrix = {
  cells: MatrixCell[];
  prompts: PromptConfig[];
  datasets: { id: string; items: DatasetItem[] }[];
  judges: Judge[];
};

export function buildMatrix(config: EvalRunConfig): ResolvedMatrix {
  const prompts = config.prompts.map(getPrompt);
  const datasets = config.datasets.map((id) => {
    const ds = loadDataset(id);
    return { id, items: ds.items };
  });
  const judges = config.judges.map(getJudge);

  const cells: MatrixCell[] = [];
  for (const prompt of prompts) {
    for (const ds of datasets) {
      for (const item of ds.items) {
        for (let i = 0; i < config.iterations; i++) {
          cells.push({
            promptId: prompt.id,
            datasetId: ds.id,
            itemId: item.id,
            iterationIdx: i,
          });
        }
      }
    }
  }

  return { cells, prompts, datasets, judges };
}

const EMPTY_USAGE: AgentUsage = {
  inputTokens: 0,
  cacheReadTokens: 0,
  cacheCreationTokens: 0,
  outputTokens: 0,
  thinkTokensApprox: 0,
  totalTokens: 0,
  cacheHitRate: 0,
};

async function runOneCell(
  cell: MatrixCell,
  matrix: ResolvedMatrix,
  config: EvalRunConfig,
  apiKey: string,
): Promise<EvalRow> {
  const prompt = matrix.prompts.find((p) => p.id === cell.promptId)!;
  const dataset = matrix.datasets.find((d) => d.id === cell.datasetId)!;
  const item = dataset.items.find((i) => i.id === cell.itemId)!;

  const start = Date.now();
  let agentResult: AgentResult | null = null;
  let error: string | null = null;

  try {
    agentResult = await answerQuestion(item.question, {
      prompt,
      model: config.model,
      maxTurns: config.maxTurns,
      apiKey,
      thinking: config.thinking,
    });
  } catch (err) {
    error = err instanceof Error ? err.message : String(err);
  }

  const judgeScores: JudgeScore[] = [];
  if (agentResult && !error) {
    for (const judge of matrix.judges) {
      try {
        const score = await judge.judge({
          question: item.question,
          answer: agentResult.answer,
          gold: item.gold,
          notes: item.notes,
          apiKey,
          judgeModel: config.judgeModel,
        });
        judgeScores.push(score);
      } catch (err) {
        judgeScores.push({
          judgeId: judge.id,
          score: 0,
          rationale: `judge "${judge.id}" failed: ${err instanceof Error ? err.message : String(err)}`,
        });
      }
    }
  }

  return {
    promptId: cell.promptId,
    datasetId: cell.datasetId,
    itemId: cell.itemId,
    question: item.question,
    iterationIdx: cell.iterationIdx,
    answer: agentResult?.answer ?? "",
    answerChars: agentResult?.answerChars ?? 0,
    turns: agentResult?.turns ?? 0,
    searches: agentResult?.searches ?? 0,
    stopped: agentResult?.stopped ?? "error",
    usage: agentResult?.usage ?? EMPTY_USAGE,
    latencyMs: agentResult?.latencyMs ?? Date.now() - start,
    costUsd: agentResult ? estimateCost(config.model, agentResult.usage) : 0,
    citationCount: agentResult ? countCitations(agentResult.answer) : 0,
    judgeScores,
    error,
  };
}

export type RunnerOptions = {
  apiKey: string;
  onRow?: (row: EvalRow, completed: number, total: number) => void;
};

export async function runMatrix(
  config: EvalRunConfig,
  matrix: ResolvedMatrix,
  options: RunnerOptions,
): Promise<EvalRow[]> {
  const total = matrix.cells.length;
  const results: EvalRow[] = new Array(total);
  let nextIdx = 0;
  let completed = 0;

  const concurrency = Math.max(1, Math.min(config.concurrency, total));
  const workers = Array.from({ length: concurrency }, async () => {
    while (true) {
      const myIdx = nextIdx++;
      if (myIdx >= total) return;
      const cell = matrix.cells[myIdx]!;
      const row = await runOneCell(cell, matrix, config, options.apiKey);
      results[myIdx] = row;
      completed++;
      options.onRow?.(row, completed, total);
    }
  });

  await Promise.all(workers);
  return results;
}

// ──────────────────────────────────────────────────────────────────────────────
// Live progress display (stderr) — overwrites a single line, with milestone
// summaries every ~10% so the log isn't lost on rolling output.
// ──────────────────────────────────────────────────────────────────────────────

export class ProgressDisplay {
  private startTime = Date.now();
  private cumulativeTokens = 0;
  private cumulativeCost = 0;
  private lastMilestone = 0;

  constructor(private total: number) {}

  update(row: EvalRow, completed: number): void {
    this.cumulativeTokens += row.usage.totalTokens;
    this.cumulativeCost += row.costUsd;

    const cell =
      `${row.promptId}/${row.datasetId}/${row.itemId} i${row.iterationIdx + 1}`.padEnd(
        38,
      );
    const u = row.usage;
    const elapsedSec = (Date.now() - this.startTime) / 1000;
    const rate = completed / elapsedSec;
    const etaSec = rate > 0 ? Math.max(0, (this.total - completed) / rate) : 0;
    const judgeSummary =
      row.judgeScores.length > 0
        ? row.judgeScores
            .map(
              (s) =>
                `${s.judgeId}=${s.rawScore !== undefined ? s.rawScore : s.score.toFixed(2)}`,
            )
            .join(" ")
        : "no-judges";
    const errMark = row.error ? " ERR" : "";

    const line =
      `[${String(completed).padStart(String(this.total).length)}/${this.total}] ${cell}` +
      ` | in:${u.inputTokens} cache_r:${u.cacheReadTokens} out:${u.outputTokens} think~${u.thinkTokensApprox}` +
      ` | ${row.latencyMs}ms | ${judgeSummary}${errMark}` +
      ` | ETA ${formatDuration(etaSec)}`;

    process.stderr.write("\r\x1b[2K" + line);

    const stepPct = Math.max(1, Math.floor(this.total / 10));
    const crossedMilestone = Math.floor(completed / stepPct);
    if (
      (crossedMilestone > this.lastMilestone && completed < this.total) ||
      completed === this.total
    ) {
      this.lastMilestone = crossedMilestone;
      const pct = Math.floor((completed * 100) / this.total);
      process.stderr.write(
        `\n  ─── ${pct}% (${completed}/${this.total}) — total tokens ${this.cumulativeTokens}, est cost $${this.cumulativeCost.toFixed(4)}, elapsed ${formatDuration(elapsedSec)} ───\n`,
      );
    }
  }

  finish(): void {
    process.stderr.write("\n");
  }
}

function formatDuration(seconds: number): string {
  if (!Number.isFinite(seconds) || seconds < 0) return "?";
  if (seconds < 60) return `${Math.round(seconds)}s`;
  if (seconds < 3600) {
    const m = Math.floor(seconds / 60);
    const s = Math.round(seconds % 60);
    return `${m}m${s}s`;
  }
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  return `${h}h${m}m`;
}

export { formatDuration };
