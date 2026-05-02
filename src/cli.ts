import { spawnSync } from "node:child_process";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";

import { answerQuestion, DEFAULT_MODEL, type AgentEvent } from "./agent.ts";
import { loadEnv } from "./loadEnv.ts";
import {
  DEFAULT_PROMPT_ID,
  getPrompt,
  listPromptIds,
} from "./prompts/index.ts";

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(__dirname, "..");
const DATASETS_DIR = join(REPO_ROOT, "evals", "datasets");

type Args = {
  question?: string;
  demo: boolean;
  verbose: boolean;
  model?: string;
  maxTurns?: number;
  apiKey?: string;
  promptId?: string;
  thinkingBudget?: number;
  help: boolean;
};

const HELP_TEMPLATE = `wiki-search — answer questions using Claude + Wikipedia

Usage:
  npm run ask -- "your question"            One-shot question
  npm run demo                              Run a curated demo set
  npm run ask -- --verbose "your q"         Show search calls and reasoning

Options:
  --demo                Run a small curated demo set
  --verbose, -v         Show search queries, results, reasoning, per-turn token usage (stderr)
  --model MODEL         Claude model id (default: ${DEFAULT_MODEL})
  --prompt ID           Prompt variant id (default: ${DEFAULT_PROMPT_ID}; available: %PROMPTS%)
  --thinking N          Enable extended thinking with N budget tokens (default: off)
  --max-turns N         Maximum search rounds (default: 6)
  --api-key KEY         Provide the Anthropic API key inline (highest precedence)
  --help, -h            Show this help

API key resolution (in order of precedence):
  1. --api-key CLI flag
  2. ANTHROPIC_API_KEY in your shell environment
  3. ANTHROPIC_API_KEY in a .env file in the project root
     (copy .env.example to .env and fill in your key)`;

// Demo questions are sourced from the actual eval datasets so the demo and
// the eval use the same vocabulary.
type DemoQuestion = { dataset: string; question: string };

function loadDemoQuestions(): DemoQuestion[] {
  const out: DemoQuestion[] = [];
  let files: string[] = [];
  try {
    files = readdirSync(DATASETS_DIR).filter((f) => f.endsWith(".json"));
  } catch {
    return out;
  }
  for (const f of files) {
    try {
      const data = JSON.parse(readFileSync(join(DATASETS_DIR, f), "utf-8")) as {
        id?: string;
        items?: Array<{ question?: string }>;
      };
      const datasetId = data.id ?? f.replace(/\.json$/, "");
      for (const item of data.items ?? []) {
        if (typeof item.question === "string" && item.question)
          out.push({ dataset: datasetId, question: item.question });
      }
    } catch {
      // skip malformed datasets
    }
  }
  return out;
}

function pickRandom<T>(arr: T[]): T | undefined {
  if (arr.length === 0) return undefined;
  return arr[Math.floor(Math.random() * arr.length)];
}

function ask(message: string): Promise<string> {
  const rl = createInterface({ input: process.stdin, output: process.stderr });
  return new Promise((resolveAnswer) => {
    rl.question(message, (answer) => {
      rl.close();
      resolveAnswer(answer.trim());
    });
  });
}

async function pressEnter(message: string): Promise<void> {
  await ask(message);
}

function parseArgs(argv: string[]): Args {
  const args: Args = { demo: false, verbose: false, help: false };
  const positional: string[] = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    if (a === "--demo") args.demo = true;
    else if (a === "--verbose" || a === "-v") args.verbose = true;
    else if (a === "--help" || a === "-h") args.help = true;
    else if (a === "--model") args.model = argv[++i];
    else if (a === "--prompt") args.promptId = argv[++i];
    else if (a === "--thinking") args.thinkingBudget = Number(argv[++i]);
    else if (a === "--max-turns") args.maxTurns = Number(argv[++i]);
    else if (a === "--api-key") args.apiKey = argv[++i];
    else positional.push(a);
  }
  if (positional.length > 0) args.question = positional.join(" ");
  return args;
}

function helpText(): string {
  return HELP_TEMPLATE.replace("%PROMPTS%", listPromptIds().join(", "));
}

/**
 * Stderr event logger for the agent loop.
 *
 * Always emits `[search]` lines so the user can see the tool is working in
 * non-verbose mode. Verbose mode adds search-result titles, thinking blocks,
 * per-turn token/latency lines, and zero-valued token types are suppressed
 * to keep lines compact.
 */
function makeProgressLogger(verbose: boolean): (event: AgentEvent) => void {
  return (event) => {
    switch (event.type) {
      case "search":
        process.stderr.write(`[search] "${event.query}"\n`);
        break;
      case "search_result": {
        if (!verbose) break;
        const preview = event.titles.slice(0, 3).join(", ");
        const more = event.titles.length > 3 ? ", …" : "";
        process.stderr.write(
          `[search]   → ${event.resultCount} hits: ${preview}${more}\n`,
        );
        break;
      }
      case "thinking":
        if (!verbose) break;
        process.stderr.write(
          `[think] ${event.text.split("\n").join("\n        ")}\n`,
        );
        break;
      case "turn_complete": {
        if (!verbose) break;
        const u = event.usage;
        const parts = [`in:${u.inputTokens}`];
        if (u.cacheReadTokens > 0) parts.push(`cache_r:${u.cacheReadTokens}`);
        if (u.cacheCreationTokens > 0)
          parts.push(`cache_w:${u.cacheCreationTokens}`);
        parts.push(`out:${u.outputTokens}`);
        if (u.thinkTokensApprox > 0)
          parts.push(`think~${u.thinkTokensApprox}`);
        process.stderr.write(
          `[turn ${event.turnIdx}]   ${parts.join(" ")}  ${event.latencyMs}ms\n`,
        );
        break;
      }
      case "max_turns_reached":
        process.stderr.write(`[!] Max turns reached.\n`);
        break;
      case "answer":
        // Final answer is printed to stdout by runOne — don't double-print.
        break;
    }
  };
}

async function runOne(
  question: string,
  args: Args,
  apiKey: string,
): Promise<void> {
  process.stdout.write(`\n> ${question}\n\n`);
  const promptConfig = args.promptId ? getPrompt(args.promptId) : undefined;
  const thinking =
    args.thinkingBudget && args.thinkingBudget > 0
      ? { budgetTokens: args.thinkingBudget }
      : undefined;

  // Progress signal so the user sees something happening before the first
  // search event lands. Skipped in verbose mode (verbose has its own noisy
  // stream).
  if (!args.verbose) {
    process.stderr.write("[working]\n");
  }

  const result = await answerQuestion(question, {
    prompt: promptConfig,
    model: args.model,
    maxTurns: args.maxTurns,
    apiKey,
    thinking,
    onEvent: makeProgressLogger(args.verbose),
  });

  process.stdout.write(`${result.answer}\n`);

  // Token / latency metrics are verbose-only. Non-verbose runs print just
  // the answer so the output is pipe-friendly (e.g. `npm run ask "..." | tee`).
  if (args.verbose) {
    const u = result.usage;
    const tokenParts = [`in=${u.inputTokens}`];
    if (u.cacheReadTokens > 0) tokenParts.push(`cache_r=${u.cacheReadTokens}`);
    if (u.cacheCreationTokens > 0)
      tokenParts.push(`cache_w=${u.cacheCreationTokens}`);
    tokenParts.push(`out=${u.outputTokens}`);
    if (u.thinkTokensApprox > 0)
      tokenParts.push(`think~${u.thinkTokensApprox}`);
    process.stdout.write(
      `\n— ${result.searches} search${result.searches === 1 ? "" : "es"}, ${result.turns} turn${result.turns === 1 ? "" : "s"}, stopped: ${result.stopped}\n` +
        `  tokens: ${tokenParts.join(" ")} (total=${u.totalTokens})\n` +
        `  latency: ${result.latencyMs}ms, answer: ${result.answerChars} chars\n`,
    );
  }
}

// Demo flow:
//   1. Brief intro, wait for Enter.
//   2. Loop: pick a random dataset question, run it, ask "another? (y/n)".
//   3. On "n": describe the eval that's about to run, wait for Enter.
//   4. Spawn `npm run eval -- --prompts v0,v1,v3 --iterations 5`.
//   5. Spawn `npm run report:html -- --limit 1` so the comparison page only
//      includes the just-finished run.
//   6. Print the file:// URL for the user to open.
async function runDemo(args: Args, apiKey: string): Promise<void> {
  const questions = loadDemoQuestions();
  if (questions.length === 0) {
    process.stderr.write(
      "No demo questions found — evals/datasets/*.json is empty or missing.\n",
    );
    process.exit(1);
  }

  process.stderr.write(
    [
      "",
      "This demo will run the agent on a random question from one of our eval",
      "datasets. After each search, you can run another, or end the interactive",
      "phase to kick off a comprehensive eval comparison across prompts.",
      "",
    ].join("\n"),
  );
  await pressEnter("Press Enter to begin (Ctrl-C to abort)... ");

  let isFirst = true;
  while (true) {
    const pick = pickRandom(questions)!;
    if (!isFirst) process.stderr.write("\n──────\n");
    process.stderr.write(
      `\n(random question — dataset: ${pick.dataset})\n`,
    );
    await runOne(pick.question, args, apiKey);
    isFirst = false;

    const answer = (await ask(
      "\nAnother search? (y/N) [N proceeds to the eval step] ",
    )).toLowerCase();
    if (answer === "y" || answer === "yes") continue;
    break;
  }

  process.stderr.write(
    [
      "",
      "Ready to run a quick eval:",
      "  • prompts:    v0, v1, v3",
      "  • datasets:   all available",
      "  • judges:     all available",
      "  • iterations: 1   (kept low to avoid making you wait)",
      "",
      "Estimated cost: ~$1 in Anthropic API calls. Estimated time: ~1 minute.",
      "",
      "If you skip this step, we'll still show you the prepared big report",
      "as an example of what the eval output looks like.",
      "",
    ].join("\n"),
  );
  const evalAnswer = (
    await ask("Run the eval now? (Y/n) ")
  ).toLowerCase();
  const skipEval = evalAnswer === "n" || evalAnswer === "no";

  const env = { ...process.env, ANTHROPIC_API_KEY: apiKey };
  const htmlPath = join(REPO_ROOT, "evals", "runs", "comparison.html");

  if (!skipEval) {
    const evalArgs = [
      "run", "eval", "--",
      "--prompts", "v0,v1,v3",
      "--iterations", "1",
    ];
    const evalRes = spawnSync("npm", evalArgs, {
      stdio: "inherit",
      cwd: REPO_ROOT,
      env,
    });
    if (evalRes.status !== 0) {
      process.stderr.write(
        "\nEval did not finish successfully — skipping HTML report generation.\n",
      );
      process.exit(evalRes.status ?? 1);
    }

    const htmlRes = spawnSync(
      "npm",
      ["run", "report:html", "--", "--limit", "1"],
      { stdio: "inherit", cwd: REPO_ROOT, env },
    );
    if (htmlRes.status !== 0) {
      process.stderr.write("\nHTML report generation failed.\n");
      process.exit(htmlRes.status ?? 1);
    }

    process.stdout.write(
      [
        "",
        "That's how the report looks for a single-iteration demo run.",
        `Open it in a browser:  file://${htmlPath}`,
        "",
      ].join("\n"),
    );
  } else {
    process.stderr.write(
      "\nSkipping the eval — proceeding directly to the prepared big report.\n",
    );
  }

  const wantBig = (await ask(
    "Want to see the same view for a much bigger pre-prepared run (50 iterations, all prompts × datasets × judges)? (Y/n) ",
  )).toLowerCase();
  if (wantBig === "n" || wantBig === "no") return;

  const biggest = findBiggestReport();
  if (!biggest) {
    process.stderr.write(
      "\nCouldn't find a pre-prepared report under evals/runs/. Skipping.\n",
    );
    return;
  }

  process.stderr.write(
    `\nUsing pre-prepared report:\n  ${biggest}\n\n`,
  );

  // Console (text) report first so the user sees the summary right here.
  const consoleRes = spawnSync(
    "npm",
    ["run", "report:console", "--", biggest],
    { stdio: "inherit", cwd: REPO_ROOT, env },
  );
  if (consoleRes.status !== 0) {
    process.stderr.write("\nreport:console failed.\n");
    return;
  }

  // HTML report scoped to that single big file.
  const bigHtmlRes = spawnSync(
    "npm",
    ["run", "report:html", "--", "--file", biggest],
    { stdio: "inherit", cwd: REPO_ROOT, env },
  );
  if (bigHtmlRes.status !== 0) {
    process.stderr.write("\nreport:html for the big run failed.\n");
    return;
  }

  process.stdout.write(
    [
      "",
      "The text view above is a summary — the HTML view lets you slice the same",
      "data interactively (cohort vs cohort, per-iteration sweeps, hash-aware",
      "filtering). Continue exploring at:",
      `  file://${htmlPath}`,
      "",
    ].join("\n"),
  );
}

// Pick the largest report-*.json under evals/runs/ as the "pre-prepared"
// demo file. Largest is a reasonable proxy for "most data points" in our
// committed run history.
function findBiggestReport(): string | null {
  const dir = join(REPO_ROOT, "evals", "runs");
  let best: { path: string; size: number } | null = null;
  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch {
    return null;
  }
  for (const f of entries) {
    if (!f.startsWith("report-") || !f.endsWith(".json")) continue;
    const p = join(dir, f);
    try {
      const st = statSync(p);
      if (!st.isFile()) continue;
      if (!best || st.size > best.size) best = { path: p, size: st.size };
    } catch {
      // skip unreadable
    }
  }
  return best?.path ?? null;
}

function resolveApiKey(args: Args): string | null {
  if (args.apiKey && args.apiKey.trim()) return args.apiKey.trim();
  loadEnv();
  const fromEnv = process.env.ANTHROPIC_API_KEY?.trim();
  return fromEnv && fromEnv.length > 0 ? fromEnv : null;
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));

  if (args.help) {
    process.stdout.write(helpText() + "\n");
    process.exit(0);
  }

  if (!args.question && !args.demo) {
    process.stderr.write(helpText() + "\n");
    process.exit(1);
  }

  const apiKey = resolveApiKey(args);
  if (!apiKey) {
    const envPath = join(REPO_ROOT, ".env");
    process.stderr.write(
      [
        "Error: no Anthropic API key found.",
        "",
        `Create a .env file at:`,
        `  ${envPath}`,
        ``,
        `with the following line:`,
        `  ANTHROPIC_API_KEY=sk-ant-api03-...`,
        ``,
        `(A template is provided at ${join(REPO_ROOT, ".env.example")} — copy it and edit.)`,
        ``,
        `Alternatively:`,
        `  • pass --api-key sk-ant-... on the command line, or`,
        `  • export ANTHROPIC_API_KEY=sk-ant-... in your shell`,
        ``,
      ].join("\n"),
    );
    process.exit(1);
  }

  if (args.demo) {
    await runDemo(args, apiKey);
  } else if (args.question) {
    await runOne(args.question, args, apiKey);
  }
}

main().catch((err: unknown) => {
  const message = err instanceof Error ? err.message : String(err);
  process.stderr.write(`Error: ${message}\n`);
  process.exit(1);
});
