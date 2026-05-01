import { test, describe } from "node:test";
import assert from "node:assert/strict";

import {
  listDatasetIds,
  loadDataset,
  parseJsonl,
} from "./registry.ts";

describe("dataset loader", () => {
  test("listDatasetIds returns all known datasets", () => {
    const ids = listDatasetIds();
    assert.ok(ids.includes("factual"));
    assert.ok(ids.includes("ambiguous"));
    assert.ok(ids.includes("multihop"));
  });

  test("loadDataset returns a populated dataset", () => {
    const ds = loadDataset("factual");
    assert.equal(ds.id, "factual");
    assert.ok(ds.items.length >= 5);
    for (const item of ds.items) {
      assert.equal(typeof item.id, "string");
      assert.ok(item.id.length > 0);
      assert.equal(typeof item.question, "string");
      assert.ok(item.question.length > 0);
    }
  });

  test("loadDataset throws for an unknown id", () => {
    assert.throws(
      () => loadDataset("nonexistent-dataset"),
      /Unknown dataset id "nonexistent-dataset"/,
    );
  });

  test("loadDataset caches results (same reference on repeat calls)", () => {
    const a = loadDataset("ambiguous");
    const b = loadDataset("ambiguous");
    assert.equal(a, b);
  });
});

describe("parseJsonl", () => {
  test("parses well-formed lines", () => {
    const items = parseJsonl(
      [
        '{"id": "a", "question": "q1"}',
        '{"id": "b", "question": "q2", "gold": "g2"}',
      ].join("\n"),
      "(test)",
    );
    assert.equal(items.length, 2);
    assert.equal(items[0]?.id, "a");
    assert.equal(items[1]?.gold, "g2");
  });

  test("ignores blank lines and # comments", () => {
    const items = parseJsonl(
      [
        "# header comment",
        "",
        '{"id": "x", "question": "q"}',
        "",
      ].join("\n"),
      "(test)",
    );
    assert.equal(items.length, 1);
    assert.equal(items[0]?.id, "x");
  });

  test("throws on invalid JSON with line number", () => {
    assert.throws(
      () =>
        parseJsonl(
          ['{"id": "a", "question": "q"}', "{not valid json"].join("\n"),
          "test.jsonl",
        ),
      /test\.jsonl:2/,
    );
  });

  test("throws on missing id or question", () => {
    assert.throws(
      () => parseJsonl('{"question": "q"}', "test.jsonl"),
      /missing string "id"/,
    );
    assert.throws(
      () => parseJsonl('{"id": "a"}', "test.jsonl"),
      /missing string "question"/,
    );
  });

  test("throws on duplicate ids within the dataset", () => {
    assert.throws(
      () =>
        parseJsonl(
          [
            '{"id": "a", "question": "q1"}',
            '{"id": "a", "question": "q2"}',
          ].join("\n"),
          "test.jsonl",
        ),
      /duplicate item id "a"/,
    );
  });
});
