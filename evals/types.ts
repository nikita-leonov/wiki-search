import type { AgentUsage, RetrievedContext } from "../src/agent.ts";

export type EvalRunConfig = {
  prompts: string[];
  datasets: string[];
  judges: string[];
  iterations: number;
  model: string;
  judgeModel: string;
  concurrency: number;
  maxTurns: number;
  thinking?: { budgetTokens: number };
  outDir?: string;
};

export type DatasetItem = {
  id: string;
  question: string;
  gold?: string;
  notes?: string;
};

export type Dataset = {
  id: string;
  description: string;
  items: DatasetItem[];
};

export type JudgeScore = {
  judgeId: string;
  /** Normalized to [0, 1]. */
  score: number;
  /** Optional rubric value (e.g. 0–4) before normalization. */
  rawScore?: number;
  /** Optional binary pass/fail. */
  pass?: boolean;
  rationale?: string;
  /** API token usage and cost when the judge made an API call. */
  usage?: {
    inputTokens: number;
    outputTokens: number;
    costUsd: number;
  };
};

export type EvalRow = {
  promptId: string;
  datasetId: string;
  itemId: string;
  question: string;
  iterationIdx: number;
  answer: string;
  answerChars: number;
  turns: number;
  searches: number;
  stopped: string;
  usage: AgentUsage;
  latencyMs: number;
  /** Cost of the agent's tool-use loop (model calls during the run). */
  costUsd: number;
  /** Sum of API costs across all judges that scored this row. */
  judgeCostUsd: number;
  citationCount: number;
  /** Retrieved snippets per search call. Used by the groundedness judge. */
  retrievedContext: RetrievedContext[];
  judgeScores: JudgeScore[];
  error: string | null;
};

export type MatrixCell = {
  promptId: string;
  datasetId: string;
  itemId: string;
  iterationIdx: number;
};
