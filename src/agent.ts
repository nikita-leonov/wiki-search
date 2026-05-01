import Anthropic from "@anthropic-ai/sdk";

import { searchWikipedia, type WikipediaHit } from "./wikipedia.ts";
import { SEARCH_WIKIPEDIA_TOOL, SYSTEM_PROMPT } from "./prompts.ts";

export type AgentEvent =
  | { type: "search"; query: string }
  | {
      type: "search_result";
      query: string;
      resultCount: number;
      titles: string[];
    }
  | { type: "thinking"; text: string }
  | { type: "answer"; text: string }
  | { type: "max_turns_reached" };

export type AgentOptions = {
  model?: string;
  maxTurns?: number;
  apiKey?: string;
  onEvent?: (event: AgentEvent) => void;
};

export type AgentResult = {
  answer: string;
  turns: number;
  searches: number;
  stopped: "end_turn" | "max_turns" | "other";
};

export const DEFAULT_MODEL = "claude-haiku-4-5-20251001";
const DEFAULT_MAX_TURNS = 6;
const MAX_TOKENS = 2048;

export async function answerQuestion(
  question: string,
  options: AgentOptions = {},
): Promise<AgentResult> {
  const client = new Anthropic(
    options.apiKey ? { apiKey: options.apiKey } : undefined,
  );
  const model = options.model ?? DEFAULT_MODEL;
  const maxTurns = options.maxTurns ?? DEFAULT_MAX_TURNS;
  const emit = options.onEvent ?? (() => {});

  const messages: Anthropic.Messages.MessageParam[] = [
    { role: "user", content: question },
  ];

  let searches = 0;
  let lastAssistantText = "";

  for (let turn = 1; turn <= maxTurns; turn++) {
    const response = await client.messages.create({
      model,
      max_tokens: MAX_TOKENS,
      system: SYSTEM_PROMPT,
      tools: [SEARCH_WIKIPEDIA_TOOL],
      messages,
    });

    const textBlocks = response.content.filter(
      (b): b is Anthropic.Messages.TextBlock => b.type === "text",
    );
    const toolUseBlocks = response.content.filter(
      (b): b is Anthropic.Messages.ToolUseBlock => b.type === "tool_use",
    );

    lastAssistantText = textBlocks.map((b) => b.text).join("\n").trim();

    if (response.stop_reason === "end_turn") {
      emit({ type: "answer", text: lastAssistantText });
      return {
        answer: lastAssistantText,
        turns: turn,
        searches,
        stopped: "end_turn",
      };
    }

    if (response.stop_reason !== "tool_use") {
      // Unexpected (e.g., max_tokens). Return what we have.
      return {
        answer: lastAssistantText,
        turns: turn,
        searches,
        stopped: "other",
      };
    }

    // Model wants to use tools. Emit any "thinking" text it produced alongside.
    for (const tb of textBlocks) {
      if (tb.text.trim().length > 0) {
        emit({ type: "thinking", text: tb.text });
      }
    }

    messages.push({ role: "assistant", content: response.content });

    const toolResults: Anthropic.Messages.ToolResultBlockParam[] = [];
    for (const tu of toolUseBlocks) {
      if (tu.name !== "search_wikipedia") {
        toolResults.push({
          type: "tool_result",
          tool_use_id: tu.id,
          content: `Unknown tool: ${tu.name}`,
          is_error: true,
        });
        continue;
      }

      const input = tu.input as { query?: unknown };
      const query = typeof input.query === "string" ? input.query.trim() : "";
      if (!query) {
        toolResults.push({
          type: "tool_result",
          tool_use_id: tu.id,
          content: "Error: search_wikipedia requires a non-empty `query` string.",
          is_error: true,
        });
        continue;
      }

      searches++;
      emit({ type: "search", query });

      try {
        const hits = await searchWikipedia(query, { limit: 5 });
        emit({
          type: "search_result",
          query,
          resultCount: hits.length,
          titles: hits.map((h) => h.title),
        });
        toolResults.push({
          type: "tool_result",
          tool_use_id: tu.id,
          content: formatSearchResults(query, hits),
        });
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        toolResults.push({
          type: "tool_result",
          tool_use_id: tu.id,
          content: `Wikipedia search failed: ${message}`,
          is_error: true,
        });
      }
    }

    messages.push({ role: "user", content: toolResults });
  }

  emit({ type: "max_turns_reached" });
  return {
    answer:
      lastAssistantText ||
      "(I exhausted my search budget without producing a final answer.)",
    turns: maxTurns,
    searches,
    stopped: "max_turns",
  };
}

function formatSearchResults(query: string, hits: WikipediaHit[]): string {
  if (hits.length === 0) {
    return `No Wikipedia articles found for "${query}". Try a different phrasing or a more specific term.`;
  }
  const blocks = hits.map((h, i) => {
    const extract = h.extract.length > 0 ? h.extract : "(no extract available)";
    return `[${i + 1}] ${h.title}\nURL: ${h.url}\nExtract: ${extract}`;
  });
  return `Wikipedia results for "${query}" (${hits.length} hits):\n\n${blocks.join("\n\n")}`;
}
