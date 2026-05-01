import type Anthropic from "@anthropic-ai/sdk";

export type PromptConfig = {
  id: string;
  description: string;
  systemPrompt: string;
  tool: Anthropic.Messages.Tool;
  /** SHA-256 fingerprint (12 hex chars) of the source YAML. */
  hash: string;
};
