// Back-fill `artifacts: { prompts, judges, datasets }` into report-*.json
// files that were generated before artifact hashing was added.
//
// CAVEAT: hashes are computed from the CURRENT artifact files on disk, not
// from whatever the artifacts looked like when the run was generated. If a
// YAML/JSON has been edited since the run, the back-filled hash reflects
// the current contents, not historical contents. There is no way to
// reconstruct historical state.
//
// Usage:
//   npm run backfill:hashes               (writes in place, default dir = evals/runs/)
//   npm run backfill:hashes -- --dry-run  (prints what would change, no writes)
//   npm run backfill:hashes -- path/to/dir

import { readdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { getPrompt, listPromptIds } from "../src/prompts/index.ts";
import {
  getJudge,
  listJudgeIds,
} from "../evals/judges/index.ts";
import { listDatasetIds, loadDataset } from "../evals/registry.ts";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, "..");

const DEFAULT_DIR = join(ROOT, "evals", "runs");

const args = process.argv.slice(2);
const dryRun = args.includes("--dry-run");
const positional = args.find((a) => !a.startsWith("--"));
const targetDir = positional ? resolve(positional) : DEFAULT_DIR;

const reportFiles = readdirSync(targetDir)
  .filter((f) => f.startsWith("report-") && f.endsWith(".json"))
  .map((f) => join(targetDir, f))
  .sort();

if (reportFiles.length === 0) {
  process.stderr.write(`No report-*.json files found in ${targetDir}\n`);
  process.exit(0);
}

process.stderr.write(
  `Scanning ${reportFiles.length} report file(s) in ${targetDir}${dryRun ? " (dry run)" : ""}\n\n`,
);

const knownPrompts = new Set(listPromptIds());
const knownJudges = new Set(listJudgeIds());
const knownDatasets = new Set(listDatasetIds());

let backfilled = 0;
let alreadyHadHashes = 0;
let errored = 0;

for (const path of reportFiles) {
  const filename = path.split("/").pop()!;
  let parsed: {
    runAt?: string;
    runDurationMs?: number;
    artifacts?: unknown;
    config?: {
      prompts?: string[];
      judges?: string[];
      datasets?: string[];
    };
    rows?: unknown;
  };
  try {
    parsed = JSON.parse(readFileSync(path, "utf-8"));
  } catch (err) {
    process.stderr.write(
      `  ${filename}: parse error: ${err instanceof Error ? err.message : String(err)}\n`,
    );
    errored++;
    continue;
  }

  if (parsed.artifacts) {
    process.stderr.write(`  ${filename}: already has artifacts → skipping\n`);
    alreadyHadHashes++;
    continue;
  }

  const config = parsed.config;
  if (!config) {
    process.stderr.write(`  ${filename}: no config field → skipping\n`);
    errored++;
    continue;
  }

  const artifacts = {
    prompts: {} as Record<string, string>,
    judges: {} as Record<string, string>,
    datasets: {} as Record<string, string>,
  };
  const missing: string[] = [];

  for (const id of config.prompts ?? []) {
    if (knownPrompts.has(id)) {
      artifacts.prompts[id] = getPrompt(id).hash;
    } else {
      missing.push(`prompt:${id}`);
    }
  }

  for (const id of config.judges ?? []) {
    if (knownJudges.has(id)) {
      const h = getJudge(id).hash;
      if (h) artifacts.judges[id] = h;
      // Code-only judges (e.g. citation) have no hash; skip.
    } else {
      missing.push(`judge:${id}`);
    }
  }

  for (const id of config.datasets ?? []) {
    if (knownDatasets.has(id)) {
      artifacts.datasets[id] = loadDataset(id).hash;
    } else {
      missing.push(`dataset:${id}`);
    }
  }

  const summary = `${Object.keys(artifacts.prompts).length}p ${Object.keys(artifacts.judges).length}j ${Object.keys(artifacts.datasets).length}d`;
  const missingNote = missing.length > 0 ? ` (missing: ${missing.join(", ")})` : "";

  // Rebuild the document with `artifacts` slotted between runDurationMs and
  // config — matches the layout produced by the live eval CLI.
  const out = {
    runAt: parsed.runAt,
    runDurationMs: parsed.runDurationMs,
    artifacts,
    config: parsed.config,
    rows: parsed.rows,
  };

  if (dryRun) {
    process.stderr.write(
      `  ${filename}: would back-fill ${summary}${missingNote}\n`,
    );
  } else {
    writeFileSync(path, JSON.stringify(out));
    process.stderr.write(`  ${filename}: back-filled ${summary}${missingNote}\n`);
  }
  backfilled++;
}

process.stderr.write(
  `\n${backfilled} ${dryRun ? "would be back-filled" : "back-filled"}, ${alreadyHadHashes} already had hashes, ${errored} errored.\n`,
);
