// Render an eval report's text view to stdout.
//
//   npm run report:console                    → newest report-*.json under evals/runs/
//   npm run report:console -- <report.json>   → a specific file
//   npm run report:console -- --help          → usage
//
// Re-uses the same renderAllReports() that the eval CLI prints at end-of-run,
// so the formatting is byte-identical. Useful for re-displaying an older run
// without re-executing the eval.

import { existsSync, readFileSync, readdirSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { renderAllReports } from "../evals/reports.ts";
import type { EvalRow, EvalRunConfig } from "../evals/types.ts";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, "..");
const DEFAULT_RUNS_DIR = join(ROOT, "evals", "runs");

const HELP = `Usage:
  npm run report:console                    Render the newest report under evals/runs/
  npm run report:console -- <report.json>   Render the specified report file
  npm run report:console -- --help          This message
`;

function findNewestReport(dir: string): string | null {
  if (!existsSync(dir)) return null;
  const files = readdirSync(dir).filter(
    (f) => f.startsWith("report-") && f.endsWith(".json"),
  );
  if (files.length === 0) return null;
  // report-<ISO>.json — lexicographic sort matches chronological for ISO.
  files.sort();
  return join(dir, files[files.length - 1]!);
}

function resolveTargetPath(): string {
  const arg = process.argv[2];
  if (arg === "--help" || arg === "-h") {
    process.stdout.write(HELP);
    process.exit(0);
  }
  if (arg) {
    const p = resolve(arg);
    if (!existsSync(p)) {
      process.stderr.write(`File not found: ${p}\n`);
      process.exit(1);
    }
    return p;
  }
  const newest = findNewestReport(DEFAULT_RUNS_DIR);
  if (!newest) {
    process.stderr.write(
      `No report-*.json files found in ${DEFAULT_RUNS_DIR}.\n` +
        `Run \`npm run eval\` first, or pass a specific report path.\n`,
    );
    process.exit(1);
  }
  return newest;
}

const path = resolveTargetPath();

let raw: {
  runAt?: string;
  runDurationMs?: number;
  artifacts?: {
    prompts: Record<string, string>;
    judges: Record<string, string>;
    datasets: Record<string, string>;
  };
  config?: EvalRunConfig;
  rows?: EvalRow[];
};
try {
  raw = JSON.parse(readFileSync(path, "utf-8"));
} catch (err) {
  process.stderr.write(
    `Failed to parse JSON at ${path}: ${err instanceof Error ? err.message : String(err)}\n`,
  );
  process.exit(1);
}
if (!raw.config) {
  process.stderr.write(
    `${path}: missing "config" field — does not look like a report-*.json.\n`,
  );
  process.exit(1);
}

const meta =
  raw.runAt !== undefined && raw.runDurationMs !== undefined
    ? {
        runAt: raw.runAt,
        runDurationMs: raw.runDurationMs,
        artifacts: raw.artifacts,
      }
    : undefined;

process.stderr.write(`Rendering: ${path}\n\n`);
process.stdout.write(renderAllReports(raw.config, raw.rows ?? [], meta) + "\n");
