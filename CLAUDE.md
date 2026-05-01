# Project guidance

A CLI that uses Claude with a single `search_wikipedia` tool to answer questions, citing Wikipedia inline. An eval suite (under `evals/`, when added) measures prompt quality across datasets and judges. Both the CLI and the eval suite import from `src/` — no duplication of prompts, agent logic, or Wikipedia client.

## Test policy

Maintain unit tests as the codebase changes. Treat tests as part of the change, not a follow-up:

- New module → add `<name>.test.ts` next to it.
- Modified behavior → update the affected tests in the same change.
- Test runner: Node's built-in `node:test`. No extra dependency. Assertions via `node:assert/strict`.
- Run: `npm test` (executes every `**/*.test.ts` under `src/` via tsx).
- Tests must be deterministic and offline. Mock `globalThis.fetch` for HTTP. Use `mkdtempSync` for filesystem tests. No tests should require an Anthropic API key.

The agent loop's API integration is verified manually via the smoke flow below — not via mocked end-to-end tests.

## Smoke-test workflow between bigger changes

After any non-trivial change, run the cheap checks before moving on. They take a few seconds and catch the most common regressions:

1. `npm run typecheck` — strict TypeScript.
2. `npm test` — unit tests.
3. `npm run smoke:wiki -- "Albert Einstein"` — verifies the live MediaWiki integration end-to-end (no API key needed).

For changes that touch `src/agent.ts`, `src/prompts/`, or the eval runner, also run a single live agent call with the user's API key:

```bash
npm run ask -- --verbose "When was the Eiffel Tower completed?"
```

This is the only check that costs money and isn't deterministic, so don't loop on it — use it as a final sanity check before committing.

## Code conventions

- **Prompts are externalized YAML.** Each variant is `src/prompts/<id>.yaml` and is auto-discovered by `src/prompts/index.ts`. Add a new YAML file to add a new prompt — no registration step. The CLI and the eval suite both consume this registry; never duplicate prompt strings elsewhere.
- **LLM judges are pure YAML.** Each LLM judge under `evals/judges/llm/` is a single `<id>.yaml` containing `id`, `description`, `systemPrompt`, `userMessage` (a Mustache-ish template with `{{question}}` / `{{answer}}` / `{{gold}}` / `{{notes}}` / `{{retrievedContext}}` substitutions and `{{#field}}…{{/field}}` conditional sections), `maxTokens`, and an optional `requires` list (`{field, skipRationale, nonEmpty?}` — short-circuits to score 0 if a required field is missing). The generic `makeLlmJudge` runner in `evals/judges/shared.ts` reads any rubric and produces a `Judge`. There is **no** per-LLM-judge wiring code under `judges/llm/`. Deterministic judges live under `evals/judges/deterministic/` as code-only `<id>.ts`. The registry at `evals/judges/index.ts` auto-discovers the YAML rubrics and explicitly imports the deterministic judges.
- **Datasets are externalized JSON.** Each dataset is `evals/datasets/<id>.json` and is auto-discovered by `evals/registry.ts`. Each item: `{id, question, gold?, notes?}`.
- **Artifact hashes get recorded per run.** Every prompt YAML, judge YAML, and dataset JSON has a 12-hex-char SHA-256 fingerprint computed at load time. The eval CLI writes these into `report-<ts>.json` under `artifacts.{prompts,judges,datasets}` so a run is pinned to specific artifact versions even if the files later change.
- **Agent stays prompt-agnostic.** `src/agent.ts` accepts a `PromptConfig` via options. Don't embed system prompts or tool schemas in `agent.ts`.
- **Minimal runtime dependencies.** The repo has two (`@anthropic-ai/sdk`, `yaml`). Justify any addition; prefer a tiny hand-rolled module (see `src/loadEnv.ts`, `src/hash.ts`) over a dep.
- **Strict TypeScript.** `noUncheckedIndexedAccess` is on; respect it. No `any` unless interacting with the SDK's loosely-typed tool inputs, and even there narrow as soon as possible.

## Repository tone

This is a public open-source project. Don't introduce framing in committed files (README, code comments, package metadata, User-Agent strings, system prompts) that ties the code to interview, take-home, or assignment context. Project context belongs in commit messages or external docs.

## Workflow notes

- Commit when self-contained pieces of work land cleanly. Don't commit broken state.
- Don't push to the remote unless explicitly asked.
- When introducing a new prompt variant, drop a YAML file in `src/prompts/` (auto-registered) and add the id to `evals/config.json` so the eval matrix picks it up.
