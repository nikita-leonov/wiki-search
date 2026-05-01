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

# Crank concurrency on a higher rate-limit tier; raise SDK retries if you hit 429s
npm run eval -- --concurrency 16 --max-api-retries 8
```

**Rate limits.** Default `concurrency` is 8 and `maxApiRetries` is 5. The Anthropic SDK retries 429 / 5xx responses with exponential backoff, so transient rate-limit bursts don't fail cells; they just slow the run. On API tier 1 the default RPM is tight — drop `concurrency` to 2-4 if you see sustained 429-storms in the logs. On tier 2+ (1000+ RPM) you can comfortably push `concurrency` to 16 or higher.

Each run writes two files into `evals/runs/`, both suffixed with the same ISO timestamp so they identify the specific execution:

- `report-<ts>.json` — raw rows + config + `runAt` + `runDurationMs`. This is the persistent artifact; downstream tooling re-aggregates from it.
- `log-<ts>.jsonl` — one JSON line per cell as it completes (live-tail-friendly).

The full rendered report (overall summary + the three rotating-primary-key reports) is printed to **stdout** at the end of the run. Capture it with a shell redirect if you want a saved markdown file:

```bash
npm run eval > evals/runs/last-report.md
```

### Interactive HTML comparison

For ad-hoc cohort comparisons (e.g. "is v0 better than v1 by groundedness on each item of the unanswerable dataset?"), generate a self-contained HTML page that ingests every `report-*.json` in a directory:

```bash
# Default: scan evals/runs/, take the 50 most recent reports by runAt
npm run report:html

# Custom limit, custom directory, custom output path
npm run report:html -- evals/runs --limit 30 --out comparison.html
```

The chart's X-axis is **data point index**, not run timestamps or item ids — each X is the Nth bucketed metric value, gathered newest-first. Run dates aren't surfaced.

How it works:

- Toggle **Pin** checkboxes for prompt / dataset / judge — each cohort fixes the pinned dims; unpinned dims aggregate.
- For each pinned dim, the cohort dropdown lists `id (hash)` options. The **hash makes cohorts hash-aware**: data from a report only counts toward a cohort if the report's artifact hash for that pinned id matches. So measurements accumulate across runs only when the pinned artifacts are byte-identical.
- **Sample size** picker: each chart point is the mean of N consecutive raw metric values (newest-first). `1` = each iteration is its own point; `3` = each point is the mean of 3 consecutive iterations (e.g., one full set of iterations for a single item under default config); larger values give coarser-but-smoother points.
- The chart shows **at most 25 points**. If a cohort has fewer raw values, its line ends naturally where the data does — it is not padded to match longer cohorts.
- **Metrics** (multi-select): mean score, pass rate, p50/p95 latency, mean tokens, mean searches, mean cost, error rate. Each metric gets its own chart, all sharing the same cohort lines.

Newest-first collection means: walking the loaded reports from most-recent runAt down, append every matching iteration's metric value to a flat list, then bucket the first `sampleSize × 25` of that list into the chart's points. Reports that don't pass the hash gate contribute zero values.

If you edit a prompt YAML and re-run, the new hash gives you a separate cohort option (`v1 (newhash)`) so you can compare old-v1 vs new-v1 directly without mixing them. Toggling Pin resets the cohort list (the shape changed).

Adding a new prompt, dataset, or judge:
- **Prompt**: drop a `<id>.yaml` file under `src/prompts/`. It's auto-discovered. The YAML carries `id`, `description`, `systemPrompt`, and the full `tool` schema.
- **Dataset**: drop an `<id>.json` file under `evals/datasets/`. Auto-discovered. Format: `{ "id": "...", "description": "...", "items": [{"id": "...", "question": "...", "gold": "..." (optional), "notes": "..." (optional)}, ...] }`.
- **LLM judge**: drop a `<id>.yaml` rubric under `evals/judges/llm/`. The YAML carries `id`, `description`, `systemPrompt`, `userMessage` (template with `{{question}}` / `{{answer}}` / `{{gold}}` / `{{notes}}` / `{{retrievedContext}}` substitutions and `{{#field}}…{{/field}}` conditional sections), `maxTokens`, and an optional `requires` list that short-circuits the judge with a custom rationale when a needed field is absent. Auto-discovered — no code change needed.
- **Deterministic judge** (e.g. citation): pure code in `evals/judges/deterministic/<id>.ts`, registered explicitly in `evals/judges/index.ts`.

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
