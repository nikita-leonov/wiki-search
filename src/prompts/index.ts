import { readFileSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { parse as parseYaml } from "yaml";

import { shortHash } from "../hash.ts";
import type { PromptConfig } from "./types.ts";

export type { PromptConfig } from "./types.ts";

const __dirname = dirname(fileURLToPath(import.meta.url));

function loadPromptYaml(filename: string): PromptConfig {
  const path = join(__dirname, filename);
  const content = readFileSync(path, "utf-8");
  const data = parseYaml(content) as Partial<PromptConfig> & { id?: unknown };

  if (typeof data.id !== "string" || !data.id) {
    throw new Error(`${filename}: missing string "id"`);
  }
  if (typeof data.systemPrompt !== "string" || !data.systemPrompt) {
    throw new Error(`${filename}: missing string "systemPrompt"`);
  }
  if (typeof data.description !== "string") {
    throw new Error(`${filename}: missing string "description"`);
  }
  if (!data.tool || typeof data.tool !== "object") {
    throw new Error(`${filename}: missing "tool" object`);
  }

  return {
    id: data.id,
    description: data.description,
    systemPrompt: data.systemPrompt,
    tool: data.tool as PromptConfig["tool"],
    hash: shortHash(content),
  };
}

function discoverPrompts(): Record<string, PromptConfig> {
  const files = readdirSync(__dirname).filter(
    (f) => f.endsWith(".yaml") || f.endsWith(".yml"),
  );
  const prompts: Record<string, PromptConfig> = {};
  for (const file of files) {
    const cfg = loadPromptYaml(file);
    if (prompts[cfg.id]) {
      throw new Error(
        `duplicate prompt id "${cfg.id}" (defined in ${file} and another file)`,
      );
    }
    prompts[cfg.id] = cfg;
  }
  return prompts;
}

export const PROMPTS: Record<string, PromptConfig> = discoverPrompts();

export const DEFAULT_PROMPT_ID = "v3";

export function getPrompt(id: string): PromptConfig {
  const p = PROMPTS[id];
  if (!p) {
    const available = listPromptIds().join(", ");
    throw new Error(`Unknown prompt id "${id}". Available: ${available}`);
  }
  return p;
}

export function listPromptIds(): string[] {
  return Object.keys(PROMPTS).sort();
}
