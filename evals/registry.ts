import { readFileSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import {
  PROMPTS,
  getPrompt,
  listPromptIds,
  type PromptConfig,
} from "../src/prompts/index.ts";
import { shortHash } from "../src/hash.ts";

import type { Dataset, DatasetItem } from "./types.ts";
import { JUDGES, getJudge, listJudgeIds, type Judge } from "./judges/index.ts";

const __dirname = dirname(fileURLToPath(import.meta.url));
const DATASETS_DIR = join(__dirname, "datasets");

function discoverDatasets(): Map<string, Dataset> {
  const out = new Map<string, Dataset>();
  const files = readdirSync(DATASETS_DIR).filter((f) => f.endsWith(".json"));
  for (const file of files) {
    const ds = parseDatasetFile(join(DATASETS_DIR, file));
    if (out.has(ds.id)) {
      throw new Error(
        `duplicate dataset id "${ds.id}" (defined in ${file} and another file)`,
      );
    }
    out.set(ds.id, ds);
  }
  return out;
}

export function parseDatasetFile(path: string): Dataset {
  const content = readFileSync(path, "utf-8");
  let parsed: unknown;
  try {
    parsed = JSON.parse(content);
  } catch (err) {
    throw new Error(
      `${path}: invalid JSON: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
  return normalizeDataset(parsed, path, content);
}

export function normalizeDataset(
  raw: unknown,
  source: string,
  contentForHash: string,
): Dataset {
  const data = raw as Partial<Dataset> & { items?: unknown };
  if (typeof data.id !== "string" || !data.id) {
    throw new Error(`${source}: dataset missing string "id"`);
  }
  if (typeof data.description !== "string") {
    throw new Error(`${source}: dataset missing string "description"`);
  }
  if (!Array.isArray(data.items)) {
    throw new Error(`${source}: dataset missing array "items"`);
  }

  const items: DatasetItem[] = [];
  const seen = new Set<string>();
  data.items.forEach((rawItem, idx) => {
    const it = rawItem as Partial<DatasetItem>;
    if (typeof it.id !== "string" || !it.id) {
      throw new Error(
        `${source}: item at index ${idx} missing string "id"`,
      );
    }
    if (typeof it.question !== "string" || !it.question) {
      throw new Error(
        `${source}: item "${it.id}" (index ${idx}) missing string "question"`,
      );
    }
    if (seen.has(it.id)) {
      throw new Error(`${source}: duplicate item id "${it.id}"`);
    }
    seen.add(it.id);
    items.push({
      id: it.id,
      question: it.question,
      gold: typeof it.gold === "string" ? it.gold : undefined,
      notes: typeof it.notes === "string" ? it.notes : undefined,
    });
  });

  return {
    id: data.id,
    description: data.description,
    items,
    hash: shortHash(contentForHash),
  };
}

const DATASETS = discoverDatasets();

export function loadDataset(id: string): Dataset {
  const ds = DATASETS.get(id);
  if (!ds) {
    throw new Error(
      `Unknown dataset id "${id}". Available: ${listDatasetIds().join(", ")}`,
    );
  }
  return ds;
}

export function listDatasetIds(): string[] {
  return [...DATASETS.keys()].sort();
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
