import { test, describe } from "node:test";
import assert from "node:assert/strict";

import {
  getJudge,
  listJudgeIds,
  parseJudgeJson,
  JUDGES,
} from "./index.ts";

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
    assert.ok(ids.includes("groundedness"));
  });

  test("getJudge throws helpfully for unknown id", () => {
    assert.throws(() => getJudge("nope"), /Unknown judge id "nope".*Available:/);
  });

  test("LLM judges expose hashes; deterministic judges do not", () => {
    assert.match(JUDGES.correctness!.hash ?? "", /^[0-9a-f]{12}$/);
    assert.match(JUDGES.groundedness!.hash ?? "", /^[0-9a-f]{12}$/);
    assert.equal(JUDGES.citation!.hash, undefined);
  });
});
