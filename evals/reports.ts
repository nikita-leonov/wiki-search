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
// Streaming aggregator — updates per row so the report is ready as soon as
// the matrix finishes. Avoids building large derived row arrays at render
// time and avoids touching `retrievedContext` (which can be tens of KB per
// row) during aggregation.
// ──────────────────────────────────────────────────────────────────────────────

type Dimension = "promptId" | "datasetId" | "judgeId";

type RenderRow = {
  primary: string;
  secondary?: string;
  tertiary?: string;
  agg: Aggregate;
};

class AccumState {
  count = 0;
  errorCount = 0;
  scoreSum = 0;
  scoreCount = 0;
  scoreSumByJudge = new Map<string, number>();
  scoreCountByJudge = new Map<string, number>();
  passByJudge = new Map<string, { pass: number; total: number }>();
  latencies: number[] = [];
  inputTokensSum = 0;
  cacheReadTokensSum = 0;
  cacheCreationTokensSum = 0;
  outputTokensSum = 0;
  thinkTokensApproxSum = 0;
  totalTokensSum = 0;
  searchesSum = 0;
  turnsSum = 0;
  answerCharsSum = 0;
  citationCountSum = 0;
  agentCostSum = 0;
  judgeCostSum = 0;

  constructor(private readonly pinnedJudge?: string) {}

  add(row: EvalRow): void {
    this.count++;
    if (row.error) {
      this.errorCount++;
      return;
    }

    const scores = this.pinnedJudge
      ? row.judgeScores.filter((s) => s.judgeId === this.pinnedJudge)
      : row.judgeScores;

    for (const s of scores) {
      this.scoreSum += s.score;
      this.scoreCount++;
      this.scoreSumByJudge.set(
        s.judgeId,
        (this.scoreSumByJudge.get(s.judgeId) ?? 0) + s.score,
      );
      this.scoreCountByJudge.set(
        s.judgeId,
        (this.scoreCountByJudge.get(s.judgeId) ?? 0) + 1,
      );
      if (s.pass !== undefined) {
        const cur = this.passByJudge.get(s.judgeId) ?? { pass: 0, total: 0 };
        cur.total++;
        if (s.pass) cur.pass++;
        this.passByJudge.set(s.judgeId, cur);
      }
    }

    this.latencies.push(row.latencyMs);
    this.inputTokensSum += row.usage.inputTokens;
    this.cacheReadTokensSum += row.usage.cacheReadTokens;
    this.cacheCreationTokensSum += row.usage.cacheCreationTokens;
    this.outputTokensSum += row.usage.outputTokens;
    this.thinkTokensApproxSum += row.usage.thinkTokensApprox;
    this.totalTokensSum += row.usage.totalTokens;
    this.searchesSum += row.searches;
    this.turnsSum += row.turns;
    this.answerCharsSum += row.answerChars;
    this.citationCountSum += row.citationCount;
    this.agentCostSum += row.costUsd;

    if (this.pinnedJudge) {
      const score = row.judgeScores.find(
        (s) => s.judgeId === this.pinnedJudge,
      );
      this.judgeCostSum += score?.usage?.costUsd ?? 0;
    } else {
      this.judgeCostSum += row.judgeCostUsd;
    }
  }

  toAggregate(): Aggregate {
    const okCount = this.count - this.errorCount;
    const safeDivOk = (sum: number) => (okCount > 0 ? sum / okCount : 0);

    const meanScore =
      this.scoreCount > 0 ? this.scoreSum / this.scoreCount : 0;

    const meanScoreByJudge: Record<string, number> = {};
    for (const [j, sum] of this.scoreSumByJudge) {
      const cnt = this.scoreCountByJudge.get(j) ?? 1;
      meanScoreByJudge[j] = sum / cnt;
    }
    const passRateByJudge: Record<string, number> = {};
    for (const [j, { pass, total }] of this.passByJudge) {
      passRateByJudge[j] = total > 0 ? pass / total : 0;
    }

    const sortedLatencies = [...this.latencies].sort((a, b) => a - b);
    const meanLatency =
      this.latencies.length > 0
        ? this.latencies.reduce((s, v) => s + v, 0) / this.latencies.length
        : 0;

    return {
      count: this.count,
      errorCount: this.errorCount,
      meanScore,
      meanScoreByJudge,
      passRateByJudge,
      meanLatencyMs: meanLatency,
      p50LatencyMs: percentile(sortedLatencies, 50),
      p95LatencyMs: percentile(sortedLatencies, 95),
      totalTokens: this.totalTokensSum,
      meanInputTokens: safeDivOk(this.inputTokensSum),
      meanOutputTokens: safeDivOk(this.outputTokensSum),
      meanCacheReadTokens: safeDivOk(this.cacheReadTokensSum),
      meanCacheCreationTokens: safeDivOk(this.cacheCreationTokensSum),
      meanThinkTokensApprox: safeDivOk(this.thinkTokensApproxSum),
      meanSearches: safeDivOk(this.searchesSum),
      meanTurns: safeDivOk(this.turnsSum),
      meanAnswerChars: safeDivOk(this.answerCharsSum),
      meanCitationCount: safeDivOk(this.citationCountSum),
      agentCostUsd: this.agentCostSum,
      judgeCostUsd: this.judgeCostSum,
      totalCostUsd: this.agentCostSum + this.judgeCostSum,
    };
  }
}

const EMPTY_AGGREGATE: Aggregate = new AccumState().toAggregate();

export class Aggregator {
  private buckets = new Map<string, AccumState>();
  private prompts = new Set<string>();
  private datasets = new Set<string>();
  private judges = new Set<string>();

  /** Include this row in every bucket it belongs to. */
  add(row: EvalRow): void {
    this.prompts.add(row.promptId);
    this.datasets.add(row.datasetId);
    for (const s of row.judgeScores) this.judges.add(s.judgeId);

    // Build the unique set of (key, pinnedJudge) pairs this row updates.
    // Same key can be reached via multiple report sections; dedupe so each
    // accumulator gets `add(row)` called exactly once.
    const updates = new Map<string, string | undefined>();

    // Cross-judge buckets (judge unpinned).
    updates.set(this.key(), undefined);
    updates.set(this.key(row.promptId), undefined);
    updates.set(this.key(undefined, row.datasetId), undefined);
    updates.set(this.key(row.promptId, row.datasetId), undefined);

    // Judge-pinned buckets — one per judge that scored this row.
    for (const s of row.judgeScores) {
      const j = s.judgeId;
      updates.set(this.key(undefined, undefined, j), j);
      updates.set(this.key(row.promptId, undefined, j), j);
      updates.set(this.key(undefined, row.datasetId, j), j);
      updates.set(this.key(row.promptId, row.datasetId, j), j);
    }

    for (const [key, pin] of updates) {
      let state = this.buckets.get(key);
      if (!state) {
        state = new AccumState(pin);
        this.buckets.set(key, state);
      }
      state.add(row);
    }
  }

  overall(): Aggregate {
    return this.buckets.get(this.key())?.toAggregate() ?? EMPTY_AGGREGATE;
  }

  bucket(promptId?: string, datasetId?: string, judgeId?: string): Aggregate {
    return (
      this.buckets.get(this.key(promptId, datasetId, judgeId))?.toAggregate() ??
      EMPTY_AGGREGATE
    );
  }

  distinctPrompts(): string[] {
    return [...this.prompts];
  }
  distinctDatasets(): string[] {
    return [...this.datasets];
  }
  distinctJudges(): string[] {
    return [...this.judges];
  }

  private key(p?: string, d?: string, j?: string): string {
    return `${p ?? "*"}|${d ?? "*"}|${j ?? "*"}`;
  }
}

function distinctForDim(agg: Aggregator, dim: Dimension): string[] {
  if (dim === "promptId") return agg.distinctPrompts();
  if (dim === "datasetId") return agg.distinctDatasets();
  return agg.distinctJudges();
}

function lookupAgg(
  agg: Aggregator,
  primary: Dimension,
  pVal: string,
  secondary?: Dimension,
  sVal?: string,
  tertiary?: Dimension,
  tVal?: string,
): Aggregate {
  let prompt: string | undefined;
  let dataset: string | undefined;
  let judge: string | undefined;
  const set = (dim: Dimension, val: string) => {
    if (dim === "promptId") prompt = val;
    else if (dim === "datasetId") dataset = val;
    else judge = val;
  };
  set(primary, pVal);
  if (secondary && sVal !== undefined) set(secondary, sVal);
  if (tertiary && tVal !== undefined) set(tertiary, tVal);
  return agg.bucket(prompt, dataset, judge);
}

function buildSection(
  agg: Aggregator,
  primary: Dimension,
  secondary: Dimension,
  tertiary: Dimension,
): RenderRow[] {
  const out: RenderRow[] = [];

  const primaryEntries = distinctForDim(agg, primary)
    .map((pVal) => ({ pVal, agg: lookupAgg(agg, primary, pVal) }))
    .sort((a, b) => b.agg.meanScore - a.agg.meanScore);

  for (const { pVal, agg: pAgg } of primaryEntries) {
    out.push({ primary: pVal, agg: pAgg });

    const secondaryEntries = distinctForDim(agg, secondary)
      .map((sVal) => ({
        sVal,
        agg: lookupAgg(agg, primary, pVal, secondary, sVal),
      }))
      // Drop empty secondary buckets that may exist when a (primary, secondary)
      // combination has no rows (e.g., a dataset with no items).
      .filter((entry) => entry.agg.count > 0)
      .sort((a, b) => b.agg.meanScore - a.agg.meanScore);

    for (const { sVal } of secondaryEntries) {
      const tertiaryEntries = distinctForDim(agg, tertiary)
        .map((tVal) => ({
          tVal,
          agg: lookupAgg(agg, primary, pVal, secondary, sVal, tertiary, tVal),
        }))
        .filter((entry) => entry.agg.count > 0)
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
    fmtNum(a.meanScore, 3),
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
  source: EvalRow[] | Aggregator,
  meta?: ReportMeta,
): string {
  // Accept either a row list (for tests / preview / legacy callers) or a
  // pre-populated Aggregator (cli.ts streams rows into it during the run, so
  // rendering at end-of-run is essentially free).
  const agg =
    source instanceof Aggregator
      ? source
      : (() => {
          const a = new Aggregator();
          for (const r of source) a.add(r);
          return a;
        })();

  const overall = agg.overall();
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
  lines.push(`  mean score:     ${fmtNum(overall.meanScore, 3)}`);
  const perJudge =
    Object.entries(overall.meanScoreByJudge)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([j, v]) => `${j}=${fmtNum(v, 3)}`)
      .join(", ") || "—";
  lines.push(`  per-judge mean: ${perJudge}`);
  lines.push(
    `  latency:        ${fmtMs(overall.meanLatencyMs)} mean, ${fmtMs(overall.p50LatencyMs)} p50, ${fmtMs(overall.p95LatencyMs)} p95`,
  );
  lines.push(`  total tokens:   ${overall.totalTokens.toLocaleString()}`);
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
    ["Judges", buildSection(agg, "judgeId", "promptId", "datasetId")],
    ["Prompts", buildSection(agg, "promptId", "datasetId", "judgeId")],
    ["Datasets", buildSection(agg, "datasetId", "judgeId", "promptId")],
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
