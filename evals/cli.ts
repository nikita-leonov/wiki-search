import { mkdirSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import { join, resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

import { loadEnv } from "../src/loadEnv.ts";

import {
  buildMatrix,
  ProgressDisplay,
  runMatrix,
} from "./runner.ts";
import { Aggregator, renderAllReports } from "./reports.ts";
import {
  getJudge,
  getPrompt,
  listDatasetIds,
  listJudgeIds,
  listPromptIds,
  loadDataset,
} from "./registry.ts";
import type { EvalRunConfig } from "./types.ts";

type ArtifactHashes = {
  prompts: Record<string, string>;
  judges: Record<string, string>;
  datasets: Record<string, string>;
};

function collectArtifactHashes(config: EvalRunConfig): ArtifactHashes {
  const prompts: Record<string, string> = {};
  for (const id of config.prompts) prompts[id] = getPrompt(id).hash;

  const judges: Record<string, string> = {};
  for (const id of config.judges) {
    const h = getJudge(id).hash;
    // Code-only judges (e.g. citation) have no artifact file → no hash.
    if (h) judges[id] = h;
  }

  const datasets: Record<string, string> = {};
  for (const id of config.datasets) datasets[id] = loadDataset(id).hash;

  return { prompts, judges, datasets };
}

const __dirname = dirname(fileURLToPath(import.meta.url));
const DEFAULT_CONFIG_PATH = join(__dirname, "config.json");

type CliArgs = {
  configPath: string;
  dryRun: boolean;
  apiKey?: string;
  outDir?: string;
  // overrides
  prompts?: string[];
  datasets?: string[];
  judges?: string[];
  iterations?: number;
  model?: string;
  judgeModel?: string;
  concurrency?: number;
  maxTurns?: number;
  maxApiRetries?: number;
  thinkingBudget?: number;
  help: boolean;
};

const HELP = `evals — run prompt × dataset × judge matrix evaluations

Usage:
  npm run eval -- [options]

Options:
  --config PATH         Path to JSON config file (default: evals/config.json)
  --dry-run             Print the resolved matrix and exit (no API calls)
  --out DIR             Output directory (default: evals/runs/<ISO timestamp>)
  --api-key KEY         Anthropic API key (highest precedence)

Overrides for any field in the config:
  --prompts ID,ID,...   Comma-separated prompt ids
  --datasets ID,ID,...  Comma-separated dataset ids
  --judges ID,ID,...    Comma-separated judge ids
  --iterations N        Iterations per (prompt × item) cell
  --model ID            Agent model (e.g. claude-haiku-4-5-20251001)
  --judge-model ID      Judge model (e.g. claude-sonnet-4-6)
  --concurrency N       Parallel cells in flight (default: 8)
  --max-turns N         Agent search budget (default: 6)
  --max-api-retries N   SDK retries on 429 / 5xx (default: 5; raise for tier 1)
  --thinking N          Enable extended thinking with N budget tokens
  --help, -h

API key resolution (in order of precedence):
  1. --api-key flag
  2. ANTHROPIC_API_KEY in shell environment
  3. ANTHROPIC_API_KEY in .env file at the project root`;

function parseList(s: string): string[] {
  return s
    .split(",")
    .map((x) => x.trim())
    .filter(Boolean);
}

function parseArgs(argv: string[]): CliArgs {
  const args: CliArgs = {
    configPath: DEFAULT_CONFIG_PATH,
    dryRun: false,
    help: false,
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    if (a === "--help" || a === "-h") args.help = true;
    else if (a === "--dry-run") args.dryRun = true;
    else if (a === "--config") args.configPath = argv[++i] ?? "";
    else if (a === "--out") args.outDir = argv[++i] ?? "";
    else if (a === "--api-key") args.apiKey = argv[++i] ?? "";
    else if (a === "--prompts") args.prompts = parseList(argv[++i] ?? "");
    else if (a === "--datasets") args.datasets = parseList(argv[++i] ?? "");
    else if (a === "--judges") args.judges = parseList(argv[++i] ?? "");
    else if (a === "--iterations") args.iterations = Number(argv[++i]);
    else if (a === "--model") args.model = argv[++i];
    else if (a === "--judge-model") args.judgeModel = argv[++i];
    else if (a === "--concurrency") args.concurrency = Number(argv[++i]);
    else if (a === "--max-turns") args.maxTurns = Number(argv[++i]);
    else if (a === "--max-api-retries")
      args.maxApiRetries = Number(argv[++i]);
    else if (a === "--thinking") args.thinkingBudget = Number(argv[++i]);
    else {
      process.stderr.write(`Unknown argument: ${a}\n`);
      process.exit(1);
    }
  }
  return args;
}

function loadConfig(path: string): EvalRunConfig {
  if (!existsSync(path)) {
    throw new Error(`Config file not found: ${path}`);
  }
  const raw = readFileSync(path, "utf-8");
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    throw new Error(
      `Invalid JSON in ${path}: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
  return parsed as EvalRunConfig;
}

function applyOverrides(config: EvalRunConfig, args: CliArgs): EvalRunConfig {
  const out: EvalRunConfig = { ...config };
  if (args.prompts) out.prompts = args.prompts;
  if (args.datasets) out.datasets = args.datasets;
  if (args.judges) out.judges = args.judges;
  if (args.iterations !== undefined && Number.isFinite(args.iterations))
    out.iterations = args.iterations;
  if (args.model) out.model = args.model;
  if (args.judgeModel) out.judgeModel = args.judgeModel;
  if (args.concurrency !== undefined && Number.isFinite(args.concurrency))
    out.concurrency = args.concurrency;
  if (args.maxTurns !== undefined && Number.isFinite(args.maxTurns))
    out.maxTurns = args.maxTurns;
  if (
    args.maxApiRetries !== undefined &&
    Number.isFinite(args.maxApiRetries)
  )
    out.maxApiRetries = args.maxApiRetries;
  if (args.thinkingBudget && args.thinkingBudget > 0)
    out.thinking = { budgetTokens: args.thinkingBudget };
  return out;
}

function resolveApiKey(args: CliArgs): string | null {
  if (args.apiKey && args.apiKey.trim()) return args.apiKey.trim();
  loadEnv();
  const fromEnv = process.env.ANTHROPIC_API_KEY?.trim();
  return fromEnv && fromEnv.length > 0 ? fromEnv : null;
}

function defaultOutDir(): string {
  return join(__dirname, "runs");
}

function safeTimestamp(iso: string): string {
  return iso.replace(/[:.]/g, "-");
}

function describeRegistry(): string {
  return [
    `available prompts:  ${listPromptIds().join(", ")}`,
    `available datasets: ${listDatasetIds().join(", ")}`,
    `available judges:   ${listJudgeIds().join(", ")}`,
  ].join("\n");
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));

  if (args.help) {
    process.stdout.write(HELP + "\n\n" + describeRegistry() + "\n");
    process.exit(0);
  }

  const baseConfig = loadConfig(args.configPath);
  const config = applyOverrides(baseConfig, args);

  // Build matrix; this also validates ids early.
  const matrix = buildMatrix(config);

  if (args.dryRun) {
    process.stdout.write(
      [
        "Resolved eval matrix (dry run — no API calls):",
        "",
        `  config:        ${args.configPath}`,
        `  model:         ${config.model}`,
        `  judge model:   ${config.judgeModel}`,
        `  prompts:       ${config.prompts.join(", ")}`,
        `  datasets:      ${config.datasets.map((d) => `${d} (${matrix.datasets.find((x) => x.id === d)!.items.length} items)`).join(", ")}`,
        `  judges:        ${config.judges.join(", ")}`,
        `  iterations:    ${config.iterations}`,
        `  concurrency:   ${config.concurrency}`,
        `  max turns:     ${config.maxTurns}`,
        `  api retries:   ${config.maxApiRetries ?? 5}`,
        `  thinking:      ${config.thinking ? `${config.thinking.budgetTokens} tokens` : "off"}`,
        "",
        `  → total cells: ${matrix.cells.length}`,
        "",
      ].join("\n"),
    );
    process.exit(0);
  }

  const apiKey = resolveApiKey(args);
  if (!apiKey) {
    process.stderr.write(
      [
        "Error: no Anthropic API key found.",
        "",
        "Provide one of:",
        "  • --api-key sk-ant-...",
        "  • export ANTHROPIC_API_KEY=sk-ant-... in your shell",
        "  • copy .env.example to .env and fill in ANTHROPIC_API_KEY",
        "",
      ].join("\n"),
    );
    process.exit(1);
  }

  const outDir = resolve(args.outDir ?? defaultOutDir());
  mkdirSync(outDir, { recursive: true });

  const runAt = new Date().toISOString();
  const startedAt = Date.now();
  const ts = safeTimestamp(runAt);

  const reportJsonPath = join(outDir, `report-${ts}.json`);
  const logPath = join(outDir, `log-${ts}.jsonl`);

  process.stderr.write(
    `Running ${matrix.cells.length} cells (${config.prompts.length} prompts × ${config.datasets.reduce((s, d) => s + matrix.datasets.find((x) => x.id === d)!.items.length, 0)} items × ${config.iterations} iterations) with concurrency=${config.concurrency}.\n`,
  );
  process.stderr.write(
    `Run id: ${ts}\nArtifacts will be written to:\n` +
      `  ${reportJsonPath}\n  ${logPath}\n\n`,
  );

  const progress = new ProgressDisplay(matrix.cells.length);
  // Truncate the log; we'll append per row.
  writeFileSync(logPath, "");

  // Stream every completed row into the aggregator so the summary is fully
  // computed by the time the run finishes — no big sweep at the end.
  const aggregator = new Aggregator();

  const rows = await runMatrix(config, matrix, {
    apiKey,
    onRow: (row, completed) => {
      progress.update(row, completed);
      aggregator.add(row);
      writeFileSync(logPath, JSON.stringify(row) + "\n", { flag: "a" });
    },
  });
  progress.finish();

  const runDurationMs = Date.now() - startedAt;
  const artifacts = collectArtifactHashes(config);
  const meta = { runAt, runDurationMs, artifacts };

  // Write structured results. `runAt` lives both in the filename (so the
  // file is self-identifying when shared) and inside the JSON (so tooling
  // can correlate runs without depending on filenames). `artifacts`
  // records the hash of every prompt / judge YAML and dataset JSON used,
  // so a future tool can pin a run to the exact artifact versions it
  // consumed — even if the files have since been edited.
  // Not pretty-printed: pretty-printing 1–10 MB of rows is needlessly slow,
  // and tooling can reformat on demand. log-<ts>.jsonl is the human-tail-
  // friendly view.
  writeFileSync(
    reportJsonPath,
    JSON.stringify({ runAt, runDurationMs, artifacts, config, rows }),
  );

  // Render the report for stdout only — the JSON is the persistent artifact;
  // markdown is for human consumption right now. Capture via shell redirect
  // (`npm run eval > report.md`) if you want to keep it.
  const md = renderAllReports(config, aggregator, meta);
  process.stdout.write("\n" + md + "\n");
  process.stderr.write(`\nResults written to: ${reportJsonPath}\n`);
}

main().catch((err: unknown) => {
  const message = err instanceof Error ? err.message : String(err);
  process.stderr.write(`\nError: ${message}\n`);
  process.exit(1);
});
