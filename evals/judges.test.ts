import { test, describe } from "node:test";
import assert from "node:assert/strict";

import {
  countCitations,
  getJudge,
  listJudgeIds,
  parseJudgeJson,
  JUDGES,
} from "./judges.ts";

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
    const judge = getJudge("citation");
    const score = await judge.judge({
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
    const judge = getJudge("citation");
    const score = await judge.judge({
      question: "q",
      answer: "see https://en.wikipedia.org/wiki/Telephone",
      apiKey: "irrelevant",
      judgeModel: "irrelevant",
    });
    assert.equal(score.score, 1);
    assert.equal(score.pass, true);
    assert.equal(score.rawScore, 1);
  });

  test("citation judge does not call the API", () => {
    assert.equal(JUDGES.citation!.usesApi, false);
  });
});

describe("parseJudgeJson", () => {
  test("parses a clean object", () => {
    const r = parseJudgeJson('{"score": 3, "rationale": "looks good"}');
    assert.deepEqual(r, { score: 3, rationale: "looks good" });
  });

  test("extracts JSON embedded in surrounding text", () => {
    const r = parseJudgeJson(
      'Some preamble. {"score": 4, "rationale": "perfect"} trailing junk.',
    );
    assert.deepEqual(r, { score: 4, rationale: "perfect" });
  });

  test("returns null when there is no score-shaped object", () => {
    assert.equal(parseJudgeJson("no json here"), null);
    assert.equal(parseJudgeJson('{"name": "no score field"}'), null);
  });

  test("returns null on malformed JSON", () => {
    assert.equal(parseJudgeJson('{"score": not-a-number}'), null);
  });
});

describe("judge registry", () => {
  test("lists all registered judges", () => {
    const ids = listJudgeIds();
    assert.ok(ids.includes("correctness"));
    assert.ok(ids.includes("citation"));
  });

  test("getJudge throws helpfully for unknown id", () => {
    assert.throws(() => getJudge("nope"), /Unknown judge id "nope".*Available:/);
  });
});
