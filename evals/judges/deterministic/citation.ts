import type { Judge } from "../shared.ts";

const WIKI_URL_RE = /https?:\/\/[a-z]{2,3}\.wikipedia\.org\/wiki\/[^\s)\]>"']+/gi;

export function countCitations(answer: string): number {
  const matches = answer.match(WIKI_URL_RE);
  return matches ? matches.length : 0;
}

export const citationJudge: Judge = {
  id: "citation",
  description:
    "Heuristic: pass if the answer cites at least one wikipedia.org URL. No API call.",
  usesApi: false,
  judge: async (ctx) => {
    const count = countCitations(ctx.answer);
    return {
      judgeId: "citation",
      score: count > 0 ? 1 : 0,
      rawScore: count,
      pass: count > 0,
      rationale:
        count > 0
          ? `${count} wikipedia.org URL${count === 1 ? "" : "s"} cited`
          : "no wikipedia.org URLs in answer",
    };
  },
};
