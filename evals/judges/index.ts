// Public registry for all judges.
//
// LLM judges are auto-discovered from YAML rubrics under ./llm/. Each YAML
// is converted to a Judge by makeLlmJudge(), so adding a new LLM judge is a
// pure-data change: drop a <id>.yaml in ./llm/.
//
// Deterministic judges live as TS files under ./deterministic/ and are
// imported explicitly here.

import { readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { citationJudge, countCitations } from "./deterministic/citation.ts";
import {
  formatRetrievedContext,
  loadRubric,
  makeLlmJudge,
  parseJudgeJson,
  type Judge,
} from "./shared.ts";

const __dirname = dirname(fileURLToPath(import.meta.url));
const LLM_DIR = join(__dirname, "llm");

function discoverLlmJudges(): Judge[] {
  const files = readdirSync(LLM_DIR).filter(
    (f) => f.endsWith(".yaml") || f.endsWith(".yml"),
  );
  return files.map((f) => makeLlmJudge(loadRubric(join(LLM_DIR, f))));
}

const allJudges: Judge[] = [...discoverLlmJudges(), citationJudge];

export const JUDGES: Record<string, Judge> = {};
for (const j of allJudges) {
  if (JUDGES[j.id]) {
    throw new Error(`duplicate judge id "${j.id}"`);
  }
  JUDGES[j.id] = j;
}

export function getJudge(id: string): Judge {
  const j = JUDGES[id];
  if (!j) {
    throw new Error(
      `Unknown judge id "${id}". Available: ${Object.keys(JUDGES).join(", ")}`,
    );
  }
  return j;
}

export function listJudgeIds(): string[] {
  return Object.keys(JUDGES);
}

export type { Judge, JudgeContext, JudgeFn } from "./shared.ts";
export { parseJudgeJson, formatRetrievedContext };
export { countCitations };
