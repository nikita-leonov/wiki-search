import type Anthropic from "@anthropic-ai/sdk";

export type PromptConfig = {
  id: string;
  description: string;
  systemPrompt: string;
  tool: Anthropic.Messages.Tool;
};
