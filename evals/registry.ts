import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

import {
  PROMPTS,
  getPrompt,
  listPromptIds,
  type PromptConfig,
} from "../src/prompts/index.ts";

import type { Dataset, DatasetItem } from "./types.ts";
import { JUDGES, getJudge, listJudgeIds, type Judge } from "./judges.ts";

const __dirname = dirname(fileURLToPath(import.meta.url));
const DATASETS_DIR = join(__dirname, "datasets");

const KNOWN_DATASETS: Record<string, { description: string; file: string }> = {
  factual: {
    description: "Clear-gold factual lookups (single-answer questions).",
    file: "factual.jsonl",
  },
  ambiguous: {
    description:
      "Questions about ambiguous terms — agent must pick the right sense.",
    file: "ambiguous.jsonl",
  },
  multihop: {
    description:
      "Multi-part questions that require combining or comparing facts.",
    file: "multihop.jsonl",
  },
};

const datasetCache = new Map<string, Dataset>();

export function loadDataset(id: string): Dataset {
  const cached = datasetCache.get(id);
  if (cached) return cached;

  const meta = KNOWN_DATASETS[id];
  if (!meta) {
    throw new Error(
      `Unknown dataset id "${id}". Available: ${listDatasetIds().join(", ")}`,
    );
  }

  const path = join(DATASETS_DIR, meta.file);
  const content = readFileSync(path, "utf-8");
  const items = parseJsonl(content, path);

  const dataset: Dataset = {
    id,
    description: meta.description,
    items,
  };
  datasetCache.set(id, dataset);
  return dataset;
}

export function listDatasetIds(): string[] {
  return Object.keys(KNOWN_DATASETS);
}

export function parseJsonl(content: string, path: string): DatasetItem[] {
  const items: DatasetItem[] = [];
  const seen = new Set<string>();
  const lines = content.split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!.trim();
    if (!line || line.startsWith("#")) continue;
    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch (err) {
      throw new Error(
        `${path}:${i + 1} — invalid JSON: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
    const item = parsed as Partial<DatasetItem>;
    if (typeof item.id !== "string" || !item.id) {
      throw new Error(`${path}:${i + 1} — item missing string "id"`);
    }
    if (typeof item.question !== "string" || !item.question) {
      throw new Error(
        `${path}:${i + 1} — item "${item.id}" missing string "question"`,
      );
    }
    if (seen.has(item.id)) {
      throw new Error(
        `${path}:${i + 1} — duplicate item id "${item.id}" within dataset`,
      );
    }
    seen.add(item.id);
    items.push({
      id: item.id,
      question: item.question,
      gold: typeof item.gold === "string" ? item.gold : undefined,
      notes: typeof item.notes === "string" ? item.notes : undefined,
    });
  }
  return items;
}

// Re-export the prompt + judge resolution helpers so the runner has one place
// to ask for "give me the resource for this id".
export {
  getPrompt,
  listPromptIds,
  PROMPTS,
  getJudge,
  listJudgeIds,
  JUDGES,
  type PromptConfig,
  type Judge,
};
