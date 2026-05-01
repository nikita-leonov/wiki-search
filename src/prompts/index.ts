import type { PromptConfig } from "./types.ts";
import { v0 } from "./v0.ts";
import { v1 } from "./v1.ts";

export type { PromptConfig } from "./types.ts";

export const PROMPTS: Record<string, PromptConfig> = {
  v0,
  v1,
};

export const DEFAULT_PROMPT_ID = "v1";

export function getPrompt(id: string): PromptConfig {
  const p = PROMPTS[id];
  if (!p) {
    const available = listPromptIds().join(", ");
    throw new Error(`Unknown prompt id "${id}". Available: ${available}`);
  }
  return p;
}

export function listPromptIds(): string[] {
  return Object.keys(PROMPTS);
}
