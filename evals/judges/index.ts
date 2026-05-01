// Public registry for all judges. Imports concrete judges from llm/ and
// deterministic/ subfolders and exposes them by id. This file is what
// callers (runner, registry, tests) import from.

import { citationJudge, countCitations } from "./deterministic/citation.ts";
import { correctnessJudge } from "./llm/correctness.ts";
import {
  formatRetrievedContext,
  groundednessJudge,
} from "./llm/groundedness.ts";

import type { Judge } from "./shared.ts";

export const JUDGES: Record<string, Judge> = {
  correctness: correctnessJudge,
  citation: citationJudge,
  groundedness: groundednessJudge,
};

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

// Re-exports so callers can pull everything they need from one path.
export type { Judge, JudgeContext, JudgeFn } from "./shared.ts";
export { parseJudgeJson } from "./shared.ts";
export { countCitations };
export { formatRetrievedContext };
