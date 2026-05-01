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

## Design notes

- **One tool only: `search_wikipedia(query: str)`.** Per the spec. The tool returns up to 5 ranked hits with intro extracts (≤1500 chars each) in a single MediaWiki API call (`generator=search` + `prop=extracts`). The agent does follow-up searches for depth instead of needing a separate `fetch_article` tool.
- **Search budget: 6 turns.** Most questions need 1–2; complex multi-part or ambiguous ones may need more. Capped to bound latency and cost.
- **Disambiguation handled in the prompt.** When the top result is a disambiguation page (e.g. for "Mercury"), the agent is instructed to recognize it, pick the right sense, and re-search with a more specific query.
- **No production-grade search.** Live MediaWiki API calls only. No caching, no offline index, no embeddings. Trade-off: cheap and simple; subject to MediaWiki rate limits and content drift.

## Project layout

```
src/
  wikipedia.ts       MediaWiki API client (search → ranked hits with intros)
  prompts.ts         System prompt + tool schema (single source of truth)
  agent.ts           Tool-use loop
  cli.ts             CLI entry point
  loadEnv.ts         Tiny .env parser (zero deps)
scripts/
  smoke-wikipedia.ts  Standalone Wikipedia search test
.env.example
package.json
tsconfig.json
```
