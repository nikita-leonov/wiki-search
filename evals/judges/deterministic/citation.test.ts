import { test, describe } from "node:test";
import assert from "node:assert/strict";

import { citationJudge, countCitations } from "./citation.ts";

describe("countCitations", () => {
  test("returns 0 when no wikipedia URLs are present", () => {
    assert.equal(countCitations("just a plain answer"), 0);
    assert.equal(
      countCitations("see https://example.com for details"),
      0,
    );
  });

  test("counts inline wikipedia URLs", () => {
    const text = `The Eiffel Tower was completed in 1889 ([source](https://en.wikipedia.org/wiki/Eiffel_Tower)).`;
    assert.equal(countCitations(text), 1);
  });

  test("counts multiple distinct URLs", () => {
    const text = `Per https://en.wikipedia.org/wiki/Marie_Curie and https://fr.wikipedia.org/wiki/Pierre_Curie.`;
    assert.equal(countCitations(text), 2);
  });

  test("ignores trailing punctuation in URLs", () => {
    const text = `(https://en.wikipedia.org/wiki/Telephone). And again [https://en.wikipedia.org/wiki/Telephone].`;
    assert.equal(countCitations(text), 2);
  });
});

describe("citation judge", () => {
  test("score=0 and pass=false when no URLs", async () => {
    const score = await citationJudge.judge({
      question: "q",
      answer: "no urls here",
      apiKey: "irrelevant",
      judgeModel: "irrelevant",
    });
    assert.equal(score.score, 0);
    assert.equal(score.pass, false);
    assert.equal(score.rawScore, 0);
  });

  test("score=1 and pass=true when at least one URL", async () => {
    const score = await citationJudge.judge({
      question: "q",
      answer: "see https://en.wikipedia.org/wiki/Telephone",
      apiKey: "irrelevant",
      judgeModel: "irrelevant",
    });
    assert.equal(score.score, 1);
    assert.equal(score.pass, true);
    assert.equal(score.rawScore, 1);
  });

  test("does not call the API", () => {
    assert.equal(citationJudge.usesApi, false);
  });

  test("has no artifact hash (code-only judge)", () => {
    assert.equal(citationJudge.hash, undefined);
  });
});
