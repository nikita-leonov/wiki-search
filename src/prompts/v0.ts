import type Anthropic from "@anthropic-ai/sdk";
import type { PromptConfig } from "./types.ts";

// Deliberately bare-minimum baseline. No disambiguation guidance, no
// multi-search refinement, no answer-format scaffolding. Used to validate
// that the eval suite surfaces the regression vs. v1.

const SYSTEM_PROMPT = `You answer factual questions using the search_wikipedia tool. Search Wikipedia when you need information, then provide an answer. Cite Wikipedia in your answer.`;

const TOOL: Anthropic.Messages.Tool = {
  name: "search_wikipedia",
  description: "Search Wikipedia. Returns article hits with title and intro extract.",
  input_schema: {
    type: "object",
    properties: {
      query: {
        type: "string",
        description: "The search query.",
      },
    },
    required: ["query"],
  },
};

export const v0: PromptConfig = {
  id: "v0",
  description:
    "Bare-minimum baseline. No disambiguation guidance, no multi-search guidance, no answer-format scaffolding. Used to validate the eval suite.",
  systemPrompt: SYSTEM_PROMPT,
  tool: TOOL,
};
