import type { EvalRow, EvalRunConfig } from "./types.ts";

// ──────────────────────────────────────────────────────────────────────────────
// Aggregation
// ──────────────────────────────────────────────────────────────────────────────

export type Aggregate = {
  count: number;
  errorCount: number;
  /** Mean score across judges + items + iterations (judge scores are normalized 0..1). */
  meanScore: number;
  /** Per-judge mean of normalized score. */
  meanScoreByJudge: Record<string, number>;
  /** Per-judge pass rate (fraction of rows where the judge marked pass=true). */
  passRateByJudge: Record<string, number>;
  meanLatencyMs: number;
  p50LatencyMs: number;
  p95LatencyMs: number;
  totalTokens: number;
  meanInputTokens: number;
  meanOutputTokens: number;
  meanCacheReadTokens: number;
  meanCacheCreationTokens: number;
  meanThinkTokensApprox: number;
  meanCacheHitRate: number;
  meanSearches: number;
  meanTurns: number;
  meanAnswerChars: number;
  meanCitationCount: number;
  totalCostUsd: number;
};

function percentile(sorted: number[], p: number): number {
  if (sorted.length === 0) return 0;
  if (sorted.length === 1) return sorted[0]!;
  const rank = (p / 100) * (sorted.length - 1);
  const lo = Math.floor(rank);
  const hi = Math.ceil(rank);
  if (lo === hi) return sorted[lo]!;
  const frac = rank - lo;
  return sorted[lo]! + (sorted[hi]! - sorted[lo]!) * frac;
}

function mean(values: number[]): number {
  if (values.length === 0) return 0;
  let sum = 0;
  for (const v of values) sum += v;
  return sum / values.length;
}

export function aggregate(rows: EvalRow[]): Aggregate {
  const ok = rows.filter((r) => !r.error);
  const errorCount = rows.length - ok.length;

  const judgeScoreLists: Record<string, number[]> = {};
  const judgePassLists: Record<string, boolean[]> = {};
  const allJudgeScores: number[] = [];

  for (const row of ok) {
    for (const s of row.judgeScores) {
      (judgeScoreLists[s.judgeId] ??= []).push(s.score);
      if (s.pass !== undefined) {
        (judgePassLists[s.judgeId] ??= []).push(s.pass);
      }
      allJudgeScores.push(s.score);
    }
  }

  const meanScoreByJudge: Record<string, number> = {};
  for (const [j, list] of Object.entries(judgeScoreLists)) {
    meanScoreByJudge[j] = mean(list);
  }
  const passRateByJudge: Record<string, number> = {};
  for (const [j, list] of Object.entries(judgePassLists)) {
    const t = list.filter((b) => b).length;
    passRateByJudge[j] = list.length > 0 ? t / list.length : 0;
  }

  const latencies = ok.map((r) => r.latencyMs).sort((a, b) => a - b);

  return {
    count: rows.length,
    errorCount,
    meanScore: mean(allJudgeScores),
    meanScoreByJudge,
    passRateByJudge,
    meanLatencyMs: mean(latencies),
    p50LatencyMs: percentile(latencies, 50),
    p95LatencyMs: percentile(latencies, 95),
    totalTokens: ok.reduce((s, r) => s + r.usage.totalTokens, 0),
    meanInputTokens: mean(ok.map((r) => r.usage.inputTokens)),
    meanOutputTokens: mean(ok.map((r) => r.usage.outputTokens)),
    meanCacheReadTokens: mean(ok.map((r) => r.usage.cacheReadTokens)),
    meanCacheCreationTokens: mean(ok.map((r) => r.usage.cacheCreationTokens)),
    meanThinkTokensApprox: mean(ok.map((r) => r.usage.thinkTokensApprox)),
    meanCacheHitRate: mean(ok.map((r) => r.usage.cacheHitRate)),
    meanSearches: mean(ok.map((r) => r.searches)),
    meanTurns: mean(ok.map((r) => r.turns)),
    meanAnswerChars: mean(ok.map((r) => r.answerChars)),
    meanCitationCount: mean(ok.map((r) => r.citationCount)),
    totalCostUsd: ok.reduce((s, r) => s + r.costUsd, 0),
  };
}

// ──────────────────────────────────────────────────────────────────────────────
// Three rotating-primary-key reports
// ──────────────────────────────────────────────────────────────────────────────

export type Dimension = "promptId" | "datasetId" | "judgeId";

function groupBy<T, K extends string>(
  rows: T[],
  keyFn: (row: T) => K,
): { key: K; rows: T[] }[] {
  const map = new Map<K, T[]>();
  for (const row of rows) {
    const k = keyFn(row);
    let arr = map.get(k);
    if (!arr) {
      arr = [];
      map.set(k, arr);
    }
    arr.push(row);
  }
  return [...map.entries()].map(([key, rows]) => ({ key, rows }));
}

/**
 * For "judge" grouping we synthesize one virtual row per (row × judge),
 * because a single eval row carries multiple judge scores.
 */
function expandRowsByJudge(
  rows: EvalRow[],
): { judgeId: string; row: EvalRow }[] {
  const out: { judgeId: string; row: EvalRow }[] = [];
  for (const row of rows) {
    for (const s of row.judgeScores) {
      out.push({ judgeId: s.judgeId, row });
    }
  }
  return out;
}

function aggregateForJudge(rows: EvalRow[], judgeId: string): Aggregate {
  // Aggregate using only the score from the named judge, but keep all other
  // metrics from the underlying agent runs.
  const filtered = rows.map((r) => ({
    ...r,
    judgeScores: r.judgeScores.filter((s) => s.judgeId === judgeId),
  }));
  return aggregate(filtered);
}

// ──────────────────────────────────────────────────────────────────────────────
// Markdown rendering
// ──────────────────────────────────────────────────────────────────────────────

function fmtNum(n: number, digits = 2): string {
  if (!Number.isFinite(n)) return "—";
  if (n === 0) return "0";
  if (Math.abs(n) >= 100) return n.toFixed(0);
  return n.toFixed(digits);
}

function fmtPct(n: number): string {
  if (!Number.isFinite(n)) return "—";
  return `${(n * 100).toFixed(1)}%`;
}

function fmtCost(n: number): string {
  if (!Number.isFinite(n) || n === 0) return "$0";
  return `$${n.toFixed(4)}`;
}

function fmtMs(ms: number): string {
  if (!Number.isFinite(ms)) return "—";
  if (ms < 1000) return `${Math.round(ms)}ms`;
  return `${(ms / 1000).toFixed(2)}s`;
}

type ReportSection = {
  heading: string;
  agg: Aggregate;
  children: ReportSection[];
};

function makeSection(
  rows: EvalRow[],
  primary: Dimension,
  remaining: Dimension[],
  pinJudge?: string,
): ReportSection[] {
  if (rows.length === 0) return [];

  if (primary === "judgeId") {
    const expanded = expandRowsByJudge(rows);
    const groups = groupBy(expanded, (e) => e.judgeId);
    return groups
      .map(({ key, rows: pairs }) => {
        const judgeRows = pairs.map((p) => p.row);
        const agg = aggregateForJudge(judgeRows, key);
        return {
          heading: `judge: ${key}`,
          agg,
          rows: judgeRows,
          key,
        };
      })
      .sort((a, b) => b.agg.meanScore - a.agg.meanScore)
      .map(({ heading, agg, rows: childRows, key }) => ({
        heading,
        agg,
        children:
          remaining.length === 0
            ? []
            : makeSection(childRows, remaining[0]!, remaining.slice(1), key),
      }));
  }

  const keyFn =
    primary === "promptId"
      ? (r: EvalRow) => r.promptId
      : (r: EvalRow) => r.datasetId;

  const groups = groupBy(rows, keyFn);
  return groups
    .map(({ key, rows: childRows }) => {
      const agg = pinJudge
        ? aggregateForJudge(childRows, pinJudge)
        : aggregate(childRows);
      return { key, agg, childRows };
    })
    .sort((a, b) => b.agg.meanScore - a.agg.meanScore)
    .map(({ key, agg, childRows }) => ({
      heading: `${primary === "promptId" ? "prompt" : "dataset"}: ${key}`,
      agg,
      children:
        remaining.length === 0
          ? []
          : makeSection(childRows, remaining[0]!, remaining.slice(1), pinJudge),
    }));
}

function renderSection(section: ReportSection, depth: number): string {
  const heading = "#".repeat(Math.min(6, depth + 2)) + " " + section.heading;
  const a = section.agg;
  const judgeCols = Object.keys(a.meanScoreByJudge).sort();

  const head = ["n", "errors", "mean", ...judgeCols, "p50 latency", "p95 latency", "mean tokens", "mean searches", "mean cite", "cost"];
  const row = [
    String(a.count),
    String(a.errorCount),
    fmtNum(a.meanScore),
    ...judgeCols.map((j) => fmtNum(a.meanScoreByJudge[j] ?? 0)),
    fmtMs(a.p50LatencyMs),
    fmtMs(a.p95LatencyMs),
    fmtNum((a.meanInputTokens + a.meanOutputTokens) | 0, 0),
    fmtNum(a.meanSearches, 1),
    fmtNum(a.meanCitationCount, 1),
    fmtCost(a.totalCostUsd),
  ];

  const table = [
    `| ${head.join(" | ")} |`,
    `|${head.map(() => "---").join("|")}|`,
    `| ${row.join(" | ")} |`,
  ].join("\n");

  const childMd = section.children
    .map((c) => renderSection(c, depth + 1))
    .join("\n\n");

  return [heading, "", table, childMd].filter(Boolean).join("\n\n");
}

export function renderReport(
  title: string,
  rows: EvalRow[],
  primary: Dimension,
  ordering: Dimension[],
): string {
  if (rows.length === 0) return `# ${title}\n\n_(no rows)_\n`;

  const remaining = ordering.filter((d) => d !== primary);
  const sections = makeSection(rows, primary, remaining);
  return [
    `# ${title}`,
    `Grouping: ${[primary, ...remaining].join(" → ")}`,
    "",
    ...sections.map((s) => renderSection(s, 0)),
  ].join("\n\n");
}

// ──────────────────────────────────────────────────────────────────────────────
// Top-level report assembly
// ──────────────────────────────────────────────────────────────────────────────

export function renderAllReports(
  config: EvalRunConfig,
  rows: EvalRow[],
): string {
  const overall = aggregate(rows);
  const header = [
    "# Eval report",
    "",
    `- model: \`${config.model}\``,
    `- judge model: \`${config.judgeModel}\``,
    `- prompts: ${config.prompts.map((p) => `\`${p}\``).join(", ")}`,
    `- datasets: ${config.datasets.map((d) => `\`${d}\``).join(", ")}`,
    `- judges: ${config.judges.map((j) => `\`${j}\``).join(", ")}`,
    `- iterations: ${config.iterations}`,
    `- thinking: ${config.thinking ? `enabled (budget ${config.thinking.budgetTokens})` : "off"}`,
    "",
    "## Overall",
    "",
    `- rows: ${overall.count} (${overall.errorCount} errors)`,
    `- mean score (across all judges): ${fmtNum(overall.meanScore)}`,
    `- per-judge mean: ${Object.entries(overall.meanScoreByJudge)
      .map(([j, v]) => `${j}=${fmtNum(v)}`)
      .join(", ") || "—"}`,
    `- mean latency: ${fmtMs(overall.meanLatencyMs)} (p50 ${fmtMs(overall.p50LatencyMs)}, p95 ${fmtMs(overall.p95LatencyMs)})`,
    `- total tokens: ${overall.totalTokens.toLocaleString()}`,
    `- mean cache hit rate: ${fmtPct(overall.meanCacheHitRate)}`,
    `- mean searches/run: ${fmtNum(overall.meanSearches, 2)}`,
    `- total estimated cost: ${fmtCost(overall.totalCostUsd)}`,
    "",
    "---",
    "",
  ].join("\n");

  const reportA = renderReport(
    "Report A — by Prompt → Dataset → Judge",
    rows,
    "promptId",
    ["promptId", "datasetId", "judgeId"],
  );
  const reportB = renderReport(
    "Report B — by Dataset → Judge → Prompt",
    rows,
    "datasetId",
    ["datasetId", "judgeId", "promptId"],
  );
  const reportC = renderReport(
    "Report C — by Judge → Prompt → Dataset",
    rows,
    "judgeId",
    ["judgeId", "promptId", "datasetId"],
  );

  return [header, reportA, "\n---\n", reportB, "\n---\n", reportC].join("\n");
}
