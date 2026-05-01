import { test, describe } from "node:test";
import assert from "node:assert/strict";

import {
  formatRetrievedContext,
  groundednessJudge,
} from "./groundedness.ts";

describe("formatRetrievedContext", () => {
  test("placeholder text when no searches were performed", () => {
    assert.match(formatRetrievedContext([]), /no searches performed/);
  });

  test("renders search queries and hit titles + extracts", () => {
    const out = formatRetrievedContext([
      {
        query: "Eiffel Tower",
        hits: [
          {
            title: "Eiffel Tower",
            url: "https://en.wikipedia.org/wiki/Eiffel_Tower",
            extract: "Tall iron tower in Paris.",
          },
        ],
      },
    ]);
    assert.match(out, /Search 1: "Eiffel Tower"/);
    assert.match(out, /\[1\] Eiffel Tower/);
    assert.match(out, /Tall iron tower in Paris\./);
  });

  test('flags "no results" when a search returned nothing', () => {
    const out = formatRetrievedContext([{ query: "asdkjfhqwer", hits: [] }]);
    assert.match(out, /Search 1: "asdkjfhqwer"/);
    assert.match(out, /no results/);
  });
});

describe("groundedness judge", () => {
  test("score=0 when no retrievedContext (agent did not search)", async () => {
    const result = await groundednessJudge.judge({
      question: "When was the Eiffel Tower completed?",
      answer: "1889.",
      apiKey: "irrelevant",
      judgeModel: "irrelevant",
      retrievedContext: [],
    });
    assert.equal(result.score, 0);
    assert.equal(result.pass, false);
    assert.match(result.rationale ?? "", /no searches/);
  });

  test("score=0 when retrievedContext is undefined", async () => {
    const result = await groundednessJudge.judge({
      question: "x",
      answer: "y",
      apiKey: "irrelevant",
      judgeModel: "irrelevant",
    });
    assert.equal(result.score, 0);
    assert.equal(result.pass, false);
  });

  test("declares it uses the API and carries a rubric hash", () => {
    assert.equal(groundednessJudge.usesApi, true);
    assert.match(groundednessJudge.hash ?? "", /^[0-9a-f]{12}$/);
  });
});
