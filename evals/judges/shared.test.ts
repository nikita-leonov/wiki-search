import { test, describe } from "node:test";
import assert from "node:assert/strict";

import {
  formatRetrievedContext,
  makeLlmJudge,
  renderTemplate,
  type Rubric,
} from "./shared.ts";

describe("renderTemplate", () => {
  test("substitutes simple {{var}} tokens", () => {
    const out = renderTemplate("Hello {{name}}!", { name: "world" });
    assert.equal(out, "Hello world!");
  });

  test("missing {{var}} renders as empty string", () => {
    const out = renderTemplate("a={{a}} b={{b}}", { a: "1" });
    assert.equal(out, "a=1 b=");
  });

  test("conditional {{#var}}...{{/var}} included when truthy", () => {
    const t = "X {{#flag}}included{{/flag}} Y";
    assert.equal(renderTemplate(t, { flag: "yes" }), "X included Y");
    assert.equal(renderTemplate(t, { flag: "" }), "X  Y");
    assert.equal(renderTemplate(t, {}), "X  Y");
  });

  test("conditional sections support nested {{var}}", () => {
    const t = "{{#notes}}Notes: {{notes}}{{/notes}}";
    assert.equal(renderTemplate(t, { notes: "important" }), "Notes: important");
    assert.equal(renderTemplate(t, {}), "");
  });

  test("collapses runs of >=3 newlines to 2 (cosmetic cleanup)", () => {
    const out = renderTemplate("a\n\n\n\nb", {});
    assert.equal(out, "a\n\nb");
  });
});

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

describe("makeLlmJudge — required-field handling", () => {
  function rubric(requires: Rubric["requires"]): Rubric {
    return {
      id: "test-judge",
      description: "test",
      systemPrompt: "you are a test judge",
      userMessage: "Q={{question}} A={{answer}} G={{gold}}",
      maxTokens: 64,
      requires,
      hash: "abcd1234abcd",
    };
  }

  test("skips API call and returns score=0 when a required field is missing", async () => {
    const judge = makeLlmJudge(
      rubric([{ field: "gold", skipRationale: "no gold provided" }]),
    );
    const score = await judge.judge({
      question: "q",
      answer: "a",
      // gold intentionally omitted
      apiKey: "irrelevant",
      judgeModel: "irrelevant",
    });
    assert.equal(score.score, 0);
    assert.equal(score.pass, false);
    assert.equal(score.rationale, "no gold provided");
    assert.equal(score.usage, undefined); // no API call → no usage
  });

  test("nonEmpty: empty array also counts as missing", async () => {
    const judge = makeLlmJudge(
      rubric([
        {
          field: "retrievedContext",
          skipRationale: "no retrieved context",
          nonEmpty: true,
        },
      ]),
    );
    const score = await judge.judge({
      question: "q",
      answer: "a",
      retrievedContext: [],
      apiKey: "irrelevant",
      judgeModel: "irrelevant",
    });
    assert.equal(score.score, 0);
    assert.equal(score.rationale, "no retrieved context");
  });

  test("nonEmpty: whitespace-only string counts as missing", async () => {
    const judge = makeLlmJudge(
      rubric([
        {
          field: "gold",
          skipRationale: "no gold provided",
          nonEmpty: true,
        },
      ]),
    );
    const score = await judge.judge({
      question: "q",
      answer: "a",
      gold: "   ",
      apiKey: "irrelevant",
      judgeModel: "irrelevant",
    });
    assert.equal(score.rationale, "no gold provided");
  });

  test("rubric with no requires: passes the gate (would call API in a real run)", async () => {
    const judge = makeLlmJudge(rubric([]));
    // We don't actually invoke the API here; we just assert the judge doesn't
    // short-circuit on the requires gate.
    assert.equal(judge.id, "test-judge");
    assert.equal(judge.usesApi, true);
    assert.equal(judge.hash, "abcd1234abcd");
  });
});
