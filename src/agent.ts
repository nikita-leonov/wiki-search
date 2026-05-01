import Anthropic from "@anthropic-ai/sdk";

import { searchWikipedia, type WikipediaHit } from "./wikipedia.ts";

export type RetrievedContext = {
  query: string;
  hits: WikipediaHit[];
};
import {
  DEFAULT_PROMPT_ID,
  getPrompt,
  type PromptConfig,
} from "./prompts/index.ts";

export type AgentEvent =
  | { type: "search"; query: string }
  | {
      type: "search_result";
      query: string;
      resultCount: number;
      titles: string[];
    }
  | { type: "thinking"; text: string }
  | {
      type: "turn_complete";
      turnIdx: number;
      usage: TurnUsage;
      latencyMs: number;
    }
  | { type: "answer"; text: string }
  | { type: "max_turns_reached" };

export type TurnUsage = {
  inputTokens: number;
  cacheReadTokens: number;
  cacheCreationTokens: number;
  outputTokens: number;
  thinkTokensApprox: number;
};

export type AgentUsage = TurnUsage & {
  totalTokens: number;
};

export type AgentResult = {
  answer: string;
  answerChars: number;
  turns: number;
  searches: number;
  stopped: "end_turn" | "max_turns" | "other";
  usage: AgentUsage;
  latencyMs: number;
  /**
   * Every successful search_wikipedia call made during the run, in order.
   * Failed searches are not included. Used by the groundedness judge to verify
   * that claims in the answer trace back to retrieved data.
   */
  retrievedContext: RetrievedContext[];
};

export type ThinkingConfig = { budgetTokens: number };

export type AgentOptions = {
  prompt?: PromptConfig;
  model?: string;
  maxTurns?: number;
  apiKey?: string;
  thinking?: ThinkingConfig;
  /**
   * Max retries the Anthropic SDK performs on 429 / 5xx errors with
   * exponential backoff. Higher values absorb more rate-limit pressure
   * before a request fails outright. Defaults to 5 (SDK default is 2).
   */
  maxApiRetries?: number;
  onEvent?: (event: AgentEvent) => void;
};

export const DEFAULT_MODEL = "claude-haiku-4-5-20251001";
const DEFAULT_MAX_TURNS = 6;
const DEFAULT_MAX_API_RETRIES = 5;
const MAX_TOKENS = 2048;

export async function answerQuestion(
  question: string,
  options: AgentOptions = {},
): Promise<AgentResult> {
  const maxRetries = options.maxApiRetries ?? DEFAULT_MAX_API_RETRIES;
  const client = new Anthropic({
    ...(options.apiKey ? { apiKey: options.apiKey } : {}),
    maxRetries,
  });
  const model = options.model ?? DEFAULT_MODEL;
  const maxTurns = options.maxTurns ?? DEFAULT_MAX_TURNS;
  const emit = options.onEvent ?? (() => {});
  const prompt = options.prompt ?? getPrompt(DEFAULT_PROMPT_ID);
  const thinking = options.thinking;

  const messages: Anthropic.Messages.MessageParam[] = [
    { role: "user", content: question },
  ];

  let searches = 0;
  let lastAssistantText = "";
  const retrievedContext: RetrievedContext[] = [];

  const cumulative: TurnUsage = {
    inputTokens: 0,
    cacheReadTokens: 0,
    cacheCreationTokens: 0,
    outputTokens: 0,
    thinkTokensApprox: 0,
  };

  const startTime = Date.now();

  for (let turn = 1; turn <= maxTurns; turn++) {
    const turnStart = Date.now();

    const requestParams: Anthropic.Messages.MessageCreateParams = {
      model,
      max_tokens: MAX_TOKENS,
      system: prompt.systemPrompt,
      tools: [prompt.tool],
      messages,
    };
    if (thinking) {
      requestParams.thinking = {
        type: "enabled",
        budget_tokens: thinking.budgetTokens,
      };
    }

    const response = await client.messages.create(requestParams);
    const turnUsage = computeTurnUsage(response);
    accumulate(cumulative, turnUsage);

    emit({
      type: "turn_complete",
      turnIdx: turn,
      usage: turnUsage,
      latencyMs: Date.now() - turnStart,
    });

    const textBlocks = response.content.filter(
      (b): b is Anthropic.Messages.TextBlock => b.type === "text",
    );
    const toolUseBlocks = response.content.filter(
      (b): b is Anthropic.Messages.ToolUseBlock => b.type === "tool_use",
    );
    const thinkingBlocks = response.content.filter(
      (b): b is Anthropic.Messages.ThinkingBlock => b.type === "thinking",
    );

    lastAssistantText = textBlocks.map((b) => b.text).join("\n").trim();

    for (const tb of thinkingBlocks) {
      if (tb.thinking.trim().length > 0) {
        emit({ type: "thinking", text: tb.thinking });
      }
    }

    if (response.stop_reason === "end_turn") {
      emit({ type: "answer", text: lastAssistantText });
      return finalize({
        answer: lastAssistantText,
        turns: turn,
        searches,
        stopped: "end_turn",
        cumulative,
        startTime,
        retrievedContext,
      });
    }

    if (response.stop_reason !== "tool_use") {
      return finalize({
        answer: lastAssistantText,
        turns: turn,
        searches,
        stopped: "other",
        cumulative,
        startTime,
        retrievedContext,
      });
    }

    // Append the entire response (including thinking blocks) so Claude
    // retains its prior reasoning across turns.
    messages.push({ role: "assistant", content: response.content });

    const toolResults: Anthropic.Messages.ToolResultBlockParam[] = [];
    for (const tu of toolUseBlocks) {
      if (tu.name !== prompt.tool.name) {
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
          content:
            "Error: search_wikipedia requires a non-empty `query` string.",
          is_error: true,
        });
        continue;
      }

      searches++;
      emit({ type: "search", query });

      try {
        const hits = await searchWikipedia(query, { limit: 5 });
        retrievedContext.push({ query, hits });
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
  return finalize({
    answer:
      lastAssistantText ||
      "(I exhausted my search budget without producing a final answer.)",
    turns: maxTurns,
    searches,
    stopped: "max_turns",
    cumulative,
    startTime,
    retrievedContext,
  });
}

function computeTurnUsage(response: Anthropic.Messages.Message): TurnUsage {
  const u = response.usage;
  const thinkingChars = response.content
    .filter((b): b is Anthropic.Messages.ThinkingBlock => b.type === "thinking")
    .reduce((s, b) => s + b.thinking.length, 0);
  return {
    inputTokens: u.input_tokens ?? 0,
    cacheReadTokens: u.cache_read_input_tokens ?? 0,
    cacheCreationTokens: u.cache_creation_input_tokens ?? 0,
    outputTokens: u.output_tokens ?? 0,
    thinkTokensApprox: Math.ceil(thinkingChars / 4),
  };
}

function accumulate(target: TurnUsage, delta: TurnUsage): void {
  target.inputTokens += delta.inputTokens;
  target.cacheReadTokens += delta.cacheReadTokens;
  target.cacheCreationTokens += delta.cacheCreationTokens;
  target.outputTokens += delta.outputTokens;
  target.thinkTokensApprox += delta.thinkTokensApprox;
}

function finalize(args: {
  answer: string;
  turns: number;
  searches: number;
  stopped: AgentResult["stopped"];
  cumulative: TurnUsage;
  startTime: number;
  retrievedContext: RetrievedContext[];
}): AgentResult {
  const { cumulative } = args;
  const totalTokens =
    cumulative.inputTokens +
    cumulative.cacheReadTokens +
    cumulative.cacheCreationTokens +
    cumulative.outputTokens;
  return {
    answer: args.answer,
    answerChars: args.answer.length,
    turns: args.turns,
    searches: args.searches,
    stopped: args.stopped,
    usage: {
      ...cumulative,
      totalTokens,
    },
    latencyMs: Date.now() - args.startTime,
    retrievedContext: args.retrievedContext,
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
