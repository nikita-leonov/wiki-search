import { answerQuestion, DEFAULT_MODEL, type AgentEvent } from "./agent.ts";
import { loadEnv } from "./loadEnv.ts";
import {
  DEFAULT_PROMPT_ID,
  getPrompt,
  listPromptIds,
} from "./prompts/index.ts";

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

const DEMO_QUESTIONS: string[] = [
  "When was the Eiffel Tower completed and how tall is it?",
  "Who is generally credited with inventing the telephone, and is there controversy about it?",
  "What is mercury's atomic number, and is the element named after the planet or vice versa?",
  "What were the main causes of the Great Fire of London in 1666?",
];

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

function makeVerboseLogger(): (event: AgentEvent) => void {
  return (event) => {
    switch (event.type) {
      case "search":
        process.stderr.write(`[search] "${event.query}"\n`);
        break;
      case "search_result": {
        const preview = event.titles.slice(0, 3).join(", ");
        const more = event.titles.length > 3 ? ", …" : "";
        process.stderr.write(
          `[search]   → ${event.resultCount} hits: ${preview}${more}\n`,
        );
        break;
      }
      case "thinking":
        process.stderr.write(
          `[think] ${event.text.split("\n").join("\n        ")}\n`,
        );
        break;
      case "turn_complete": {
        const u = event.usage;
        process.stderr.write(
          `[turn ${event.turnIdx}]   in:${u.inputTokens} cache_r:${u.cacheReadTokens} cache_w:${u.cacheCreationTokens} out:${u.outputTokens} think~${u.thinkTokensApprox}  ${event.latencyMs}ms\n`,
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
  const onEvent = args.verbose ? makeVerboseLogger() : undefined;
  const promptConfig = args.promptId ? getPrompt(args.promptId) : undefined;
  const thinking =
    args.thinkingBudget && args.thinkingBudget > 0
      ? { budgetTokens: args.thinkingBudget }
      : undefined;

  const result = await answerQuestion(question, {
    prompt: promptConfig,
    model: args.model,
    maxTurns: args.maxTurns,
    apiKey,
    thinking,
    onEvent,
  });

  process.stdout.write(`${result.answer}\n`);
  const u = result.usage;
  process.stdout.write(
    `\n— ${result.searches} search${result.searches === 1 ? "" : "es"}, ${result.turns} turn${result.turns === 1 ? "" : "s"}, stopped: ${result.stopped}\n` +
      `  tokens: in=${u.inputTokens} cache_r=${u.cacheReadTokens} cache_w=${u.cacheCreationTokens} out=${u.outputTokens} think~${u.thinkTokensApprox} (total=${u.totalTokens})\n` +
      `  latency: ${result.latencyMs}ms, answer: ${result.answerChars} chars\n`,
  );
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

  if (args.demo) {
    for (const q of DEMO_QUESTIONS) {
      await runOne(q, args, apiKey);
    }
  } else if (args.question) {
    await runOne(args.question, args, apiKey);
  }
}

main().catch((err: unknown) => {
  const message = err instanceof Error ? err.message : String(err);
  process.stderr.write(`Error: ${message}\n`);
  process.exit(1);
});
