import type { EvalRow, EvalRunConfig } from "./types.ts";

// ──────────────────────────────────────────────────────────────────────────────
// Aggregation
// ──────────────────────────────────────────────────────────────────────────────

export type Aggregate = {
  count: number;
  errorCount: number;
  meanScore: number;
  meanScoreByJudge: Record<string, number>;
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
  /** Cost of the agent's tool-use loop only (sum of EvalRow.costUsd). */
  agentCostUsd: number;
  /** Cost of LLM judges that scored the rows in scope. */
  judgeCostUsd: number;
  /** agentCostUsd + judgeCostUsd. */
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
    agentCostUsd: ok.reduce((s, r) => s + r.costUsd, 0),
    judgeCostUsd: ok.reduce((s, r) => s + r.judgeCostUsd, 0),
    totalCostUsd: ok.reduce((s, r) => s + r.costUsd + r.judgeCostUsd, 0),
  };
}

export function aggregateForJudge(
  rows: EvalRow[],
  judgeId: string,
): Aggregate {
  const filtered = rows.map((r) => {
    const judgeScores = r.judgeScores.filter((s) => s.judgeId === judgeId);
    const judgeCostUsd = judgeScores.reduce(
      (sum, s) => sum + (s.usage?.costUsd ?? 0),
      0,
    );
    return { ...r, judgeScores, judgeCostUsd };
  });
  return aggregate(filtered);
}

// ──────────────────────────────────────────────────────────────────────────────
// Section building — one flat table per primary dimension. Rows are leaves
// (primary × secondary × tertiary), preceded by a primary aggregate row.
// ──────────────────────────────────────────────────────────────────────────────

type Dimension = "promptId" | "datasetId" | "judgeId";

type RenderRow = {
  primary: string;
  secondary?: string;
  tertiary?: string;
  agg: Aggregate;
};

function distinctValues(rows: EvalRow[], dim: Dimension): string[] {
  const set = new Set<string>();
  if (dim === "judgeId") {
    for (const r of rows) for (const s of r.judgeScores) set.add(s.judgeId);
  } else if (dim === "promptId") {
    for (const r of rows) set.add(r.promptId);
  } else {
    for (const r of rows) set.add(r.datasetId);
  }
  return [...set];
}

function filterByDim(
  rows: EvalRow[],
  dim: Dimension,
  value: string,
): EvalRow[] {
  if (dim === "judgeId") {
    return rows.filter((r) =>
      r.judgeScores.some((s) => s.judgeId === value),
    );
  }
  if (dim === "promptId") return rows.filter((r) => r.promptId === value);
  return rows.filter((r) => r.datasetId === value);
}

function pickJudgePin(
  primary: Dimension,
  secondary: Dimension,
  tertiary: Dimension,
  pVal: string,
  sVal: string,
  tVal: string,
): string | undefined {
  if (primary === "judgeId") return pVal;
  if (secondary === "judgeId") return sVal;
  if (tertiary === "judgeId") return tVal;
  return undefined;
}

function aggForCell(rows: EvalRow[], judgePin: string | undefined): Aggregate {
  return judgePin ? aggregateForJudge(rows, judgePin) : aggregate(rows);
}

function buildSection(
  rows: EvalRow[],
  primary: Dimension,
  secondary: Dimension,
  tertiary: Dimension,
): RenderRow[] {
  const out: RenderRow[] = [];

  const primaryEntries = distinctValues(rows, primary)
    .map((pVal) => {
      const pRows = filterByDim(rows, primary, pVal);
      const judgePin = primary === "judgeId" ? pVal : undefined;
      return { pVal, pRows, agg: aggForCell(pRows, judgePin) };
    })
    .sort((a, b) => b.agg.meanScore - a.agg.meanScore);

  for (const { pVal, pRows, agg: pAgg } of primaryEntries) {
    out.push({ primary: pVal, agg: pAgg });

    const secondaryEntries = distinctValues(pRows, secondary)
      .map((sVal) => {
        const sRows = filterByDim(pRows, secondary, sVal);
        const judgePin =
          primary === "judgeId"
            ? pVal
            : secondary === "judgeId"
              ? sVal
              : undefined;
        return { sVal, sRows, agg: aggForCell(sRows, judgePin) };
      })
      .sort((a, b) => b.agg.meanScore - a.agg.meanScore);

    for (const { sVal, sRows } of secondaryEntries) {
      const tertiaryEntries = distinctValues(sRows, tertiary)
        .map((tVal) => {
          const tRows = filterByDim(sRows, tertiary, tVal);
          const judgePin = pickJudgePin(
            primary,
            secondary,
            tertiary,
            pVal,
            sVal,
            tVal,
          );
          return { tVal, agg: aggForCell(tRows, judgePin) };
        })
        .sort((a, b) => b.agg.meanScore - a.agg.meanScore);

      for (const { tVal, agg: leafAgg } of tertiaryEntries) {
        out.push({
          primary: pVal,
          secondary: sVal,
          tertiary: tVal,
          agg: leafAgg,
        });
      }
    }
  }

  return out;
}

// ──────────────────────────────────────────────────────────────────────────────
// Plain-text rendering
// ──────────────────────────────────────────────────────────────────────────────

function fmtNum(n: number, digits = 2): string {
  if (!Number.isFinite(n)) return "—";
  return n.toFixed(digits);
}

function fmtPct(n: number): string {
  if (!Number.isFinite(n)) return "—";
  return `${(n * 100).toFixed(1)}%`;
}

function fmtCost(n: number): string {
  if (!Number.isFinite(n)) return "—";
  if (n < 0.01) return `$${n.toFixed(4)}`;
  if (n < 1) return `$${n.toFixed(3)}`;
  return `$${n.toFixed(2)}`;
}

function fmtMs(ms: number): string {
  if (!Number.isFinite(ms)) return "—";
  if (ms < 1000) return `${Math.round(ms)}ms`;
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)}s`;
  const totalSec = Math.round(ms / 1000);
  return `${Math.floor(totalSec / 60)}m${totalSec % 60}s`;
}

function fmtTokens(n: number): string {
  if (!Number.isFinite(n) || n === 0) return "0";
  if (n < 1000) return `${n}`;
  if (n < 1_000_000) return `${(n / 1000).toFixed(1)}K`;
  return `${(n / 1_000_000).toFixed(2)}M`;
}

const TABLE_COLUMNS = [
  { header: "Group", align: "left" as const },
  { header: "n", align: "right" as const },
  { header: "mean", align: "right" as const },
  { header: "p50", align: "right" as const },
  { header: "tokens", align: "right" as const },
  { header: "srch", align: "right" as const },
  { header: "cost", align: "right" as const },
];

function rowToCells(row: RenderRow, primaryPad: number): string[] {
  let groupCell: string;
  if (row.secondary === undefined) {
    groupCell = row.primary;
  } else {
    const path =
      row.tertiary !== undefined
        ? `\\ ${row.secondary} \\ ${row.tertiary}`
        : `\\ ${row.secondary}`;
    groupCell = `${" ".repeat(primaryPad)} ${path}`;
  }

  const a = row.agg;
  const errSuffix = a.errorCount > 0 ? ` (${a.errorCount} err)` : "";
  return [
    groupCell,
    `${a.count}${errSuffix}`,
    fmtNum(a.meanScore, 2),
    fmtMs(a.p50LatencyMs),
    fmtTokens(Math.round(a.meanInputTokens + a.meanOutputTokens)),
    fmtNum(a.meanSearches, 1),
    fmtCost(a.totalCostUsd),
  ];
}

function renderTable(rows: RenderRow[]): string {
  if (rows.length === 0) return "  (no data)";

  // Width of the longest primary key (used to pad the blanked-primary on
  // continuation rows so the "\ secondary" column is visually aligned).
  const primaryPad = Math.max(...rows.map((r) => r.primary.length));

  const headers = TABLE_COLUMNS.map((c) => c.header);
  const dataRows = rows.map((r) => rowToCells(r, primaryPad));
  const widths = headers.map((h, i) =>
    Math.max(h.length, ...dataRows.map((dr) => dr[i]!.length)),
  );

  const fmt = (cell: string, idx: number) => {
    const c = TABLE_COLUMNS[idx]!;
    return c.align === "right"
      ? cell.padStart(widths[idx]!)
      : cell.padEnd(widths[idx]!);
  };

  const formatLine = (cells: string[]) => {
    const first = fmt(cells[0]!, 0);
    const rest = cells.slice(1).map((c, i) => fmt(c, i + 1)).join("   ");
    return `  ${first}  |  ${rest}`;
  };

  const headerLine = formatLine(headers);
  const ruleLine = "  " + "-".repeat(headerLine.length - 2);
  const lines = [headerLine, ruleLine, ...dataRows.map(formatLine)];
  return lines.join("\n");
}

// ──────────────────────────────────────────────────────────────────────────────
// Top-level report
// ──────────────────────────────────────────────────────────────────────────────

export type ReportMeta = {
  runAt: string;
  runDurationMs: number;
};

export function renderAllReports(
  config: EvalRunConfig,
  rows: EvalRow[],
  meta?: ReportMeta,
): string {
  const overall = aggregate(rows);
  const lines: string[] = [];

  lines.push("Eval Report");
  lines.push("===========");
  lines.push("");

  if (meta) {
    lines.push(`run at:       ${meta.runAt}`);
    lines.push(`duration:     ${fmtMs(meta.runDurationMs)}`);
  }
  lines.push(`model:        ${config.model}`);
  lines.push(`judge model:  ${config.judgeModel}`);
  lines.push(`prompts:      ${config.prompts.join(", ")}`);
  lines.push(`datasets:     ${config.datasets.join(", ")}`);
  lines.push(`judges:       ${config.judges.join(", ")}`);
  lines.push(`iterations:   ${config.iterations}`);
  lines.push(
    `thinking:     ${config.thinking ? `enabled (${config.thinking.budgetTokens} budget tokens)` : "off"}`,
  );
  lines.push("");

  lines.push("Overall");
  lines.push("-------");
  const errSuffix =
    overall.errorCount > 0 ? ` (${overall.errorCount} errors)` : "";
  lines.push(`  rows:           ${overall.count}${errSuffix}`);
  lines.push(`  mean score:     ${fmtNum(overall.meanScore)}`);
  const perJudge =
    Object.entries(overall.meanScoreByJudge)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([j, v]) => `${j}=${fmtNum(v)}`)
      .join(", ") || "—";
  lines.push(`  per-judge mean: ${perJudge}`);
  lines.push(
    `  latency:        ${fmtMs(overall.meanLatencyMs)} mean, ${fmtMs(overall.p50LatencyMs)} p50, ${fmtMs(overall.p95LatencyMs)} p95`,
  );
  lines.push(`  total tokens:   ${overall.totalTokens.toLocaleString()}`);
  lines.push(`  cache hit rate: ${fmtPct(overall.meanCacheHitRate)}`);
  lines.push(`  searches/run:   ${fmtNum(overall.meanSearches, 2)}`);
  const agentPct =
    overall.totalCostUsd > 0
      ? (overall.agentCostUsd / overall.totalCostUsd) * 100
      : 0;
  const judgePct =
    overall.totalCostUsd > 0
      ? (overall.judgeCostUsd / overall.totalCostUsd) * 100
      : 0;
  lines.push(
    `  cost (agent):   ${fmtCost(overall.agentCostUsd)} (${agentPct.toFixed(1)}%)`,
  );
  lines.push(
    `  cost (judges):  ${fmtCost(overall.judgeCostUsd)} (${judgePct.toFixed(1)}%)`,
  );
  lines.push(`  cost (total):   ${fmtCost(overall.totalCostUsd)}`);
  lines.push("");

  const sections: Array<[string, RenderRow[]]> = [
    ["Judges", buildSection(rows, "judgeId", "promptId", "datasetId")],
    ["Prompts", buildSection(rows, "promptId", "datasetId", "judgeId")],
    ["Datasets", buildSection(rows, "datasetId", "judgeId", "promptId")],
  ];

  for (const [name, sectionRows] of sections) {
    lines.push(`${name}:`);
    lines.push("");
    lines.push(renderTable(sectionRows));
    lines.push("");
  }

  return lines.join("\n");
}

// Exposed for tests.
export { buildSection, renderTable };
