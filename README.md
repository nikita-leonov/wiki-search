# wiki-search

A CLI that uses Claude with a single `search_wikipedia` tool to answer questions, citing Wikipedia inline.

The default model is **Claude Haiku 4.5** — a deliberate choice to make the prompt and tool scaffolding the dominant variables that determine answer quality, so the impact of prompt changes is easy to see. Override with `--model` to compare against other Claude models.

## Setup

Requires Node.js 20+ (developed against Node 25). No other system dependencies.

```bash
npm install
```

### Provide an Anthropic API key

The CLI resolves the key in this order (first one wins):

1. `--api-key sk-ant-...` flag on the command line.
2. `ANTHROPIC_API_KEY` exported in your shell.
3. `ANTHROPIC_API_KEY` in a `.env` file in the project root.

Easiest path:

```bash
cp .env.example .env
# then edit .env and paste your key
```

`.env` is gitignored. `--api-key` is convenient but the key will appear in your shell history — prefer the `.env` file or shell env for routine use.

## Usage

```bash
# One-shot question
npm run ask -- "When was the Eiffel Tower completed and how tall is it?"

# Curated demo set (4 questions covering different shapes)
npm run demo

# Show search calls and the agent's reasoning (to stderr)
npm run ask -- --verbose "Who invented the telephone?"

# Compare against a stronger model
npm run ask -- --model claude-sonnet-4-6 "..."

# Cap the search budget
npm run ask -- --max-turns 3 "..."
```

You can also smoke-test the Wikipedia integration alone, which needs no API key:

```bash
npm run smoke:wiki -- "Albert Einstein"
```

## Evals

A standalone eval harness lives under `evals/`. It runs a matrix of `prompt × dataset × judge × iterations`, captures token / latency / cache / cost metrics per cell, and writes three rotating-primary-key markdown reports.

```bash
# See what would run, without calling the API
npm run eval -- --dry-run

# Full run with the default config (evals/config.json)
npm run eval

# Quick subset for iteration
npm run eval -- --prompts v1 --datasets factual --iterations 1

# Compare a different judge model
npm run eval -- --judge-model claude-opus-4-7
```

Each run writes two files into `evals/runs/`, both suffixed with the same ISO timestamp so they identify the specific execution:

- `report-<ts>.json` — raw rows + config + `runAt` + `runDurationMs`. This is the persistent artifact; downstream tooling re-aggregates from it.
- `log-<ts>.jsonl` — one JSON line per cell as it completes (live-tail-friendly).

The full rendered report (overall summary + the three rotating-primary-key reports) is printed to **stdout** at the end of the run. Capture it with a shell redirect if you want a saved markdown file:

```bash
npm run eval > evals/runs/last-report.md
```

Adding a new prompt, dataset, or judge:
- **Prompt**: drop a `<id>.yaml` file under `src/prompts/`. It's auto-discovered. The YAML carries `id`, `description`, `systemPrompt`, and the full `tool` schema.
- **Dataset**: drop an `<id>.json` file under `evals/datasets/`. Auto-discovered. Format: `{ "id": "...", "description": "...", "items": [{"id": "...", "question": "...", "gold": "..." (optional), "notes": "..." (optional)}, ...] }`.
- **LLM judge**: under `evals/judges/llm/`, drop a `<id>.yaml` rubric and a `<id>.ts` that builds the user message (each judge needs different inputs from the row), then add it to `JUDGES` in `evals/judges/index.ts`.
- **Deterministic judge** (e.g. citation): pure code in `evals/judges/deterministic/<id>.ts`; no YAML.

If you have past `report-*.json` files generated before artifact hashing was added, run `npm run backfill:hashes` to populate the `artifacts` block in place. Hashes are computed from the *current* artifact files, so the back-fill only matches historical state if the artifacts haven't been edited since.

Every YAML / JSON artifact gets a SHA-256 short-fingerprint at load time, recorded in `report-<ts>.json` under `artifacts.{prompts,judges,datasets}` so each run is pinned to the exact versions it consumed.

## Design notes

- **One tool only: `search_wikipedia(query: str)`.** Per the spec. The tool returns up to 5 ranked hits with intro extracts (≤1500 chars each) in a single MediaWiki API call (`generator=search` + `prop=extracts`). The agent does follow-up searches for depth instead of needing a separate `fetch_article` tool.
- **Search budget: 6 turns.** Most questions need 1–2; complex multi-part or ambiguous ones may need more. Capped to bound latency and cost.
- **Disambiguation handled in the prompt.** When the top result is a disambiguation page (e.g. for "Mercury"), the agent is instructed to recognize it, pick the right sense, and re-search with a more specific query.
- **No production-grade search.** Live MediaWiki API calls only. No caching, no offline index, no embeddings. Trade-off: cheap and simple; subject to MediaWiki rate limits and content drift.

## Project layout

```
src/
  wikipedia.ts        MediaWiki API client
  prompts/            Prompt registry — auto-discovers YAML files
    *.yaml            Each prompt is its own YAML file
    types.ts          PromptConfig type
    index.ts          Registry + DEFAULT_PROMPT_ID + hash
  hash.ts             SHA-256 short-fingerprint helper for artifact pinning
  agent.ts            Tool-use loop (prompt + thinking config via options)
  cli.ts              CLI entry point
  loadEnv.ts          Tiny .env parser (zero deps)
evals/
  cli.ts              Standalone eval entry point — records artifact hashes per run
  runner.ts           Matrix orchestration, concurrency, live progress
  reports.ts          Aggregation + three rotating-primary-key text reports
  registry.ts         Resolves prompt / dataset / judge ids; auto-discovers JSON datasets
  judges/
    index.ts          Judge registry — imports llm/* and deterministic/*
    shared.ts         Judge types + LLM-call plumbing
    llm/              LLM-backed judges: paired <id>.yaml (rubric) + <id>.ts (wiring)
    deterministic/    Code-only judges (e.g. citation)
  cost.ts             Per-model price table + cost estimation
  types.ts            Shared eval types
  config.json         Default eval matrix
  datasets/           JSON test sets (factual / ambiguous / multihop)
scripts/
  smoke-wikipedia.ts  Standalone Wikipedia search smoke test
.env.example
package.json
tsconfig.json
CLAUDE.md             Project guidance for AI tools (test policy, conventions)
```
