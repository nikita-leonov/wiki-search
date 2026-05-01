import { test, describe } from "node:test";
import assert from "node:assert/strict";

import { listDatasetIds, loadDataset, normalizeDataset } from "./registry.ts";

describe("dataset loader", () => {
  test("listDatasetIds returns all known datasets", () => {
    const ids = listDatasetIds();
    assert.ok(ids.includes("factual"));
    assert.ok(ids.includes("ambiguous"));
    assert.ok(ids.includes("multihop"));
    assert.ok(ids.includes("unanswerable"));
  });

  test("loadDataset returns a populated dataset with hash", () => {
    const ds = loadDataset("factual");
    assert.equal(ds.id, "factual");
    assert.ok(ds.items.length >= 5);
    assert.match(ds.hash, /^[0-9a-f]{12}$/);
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

  test("loadDataset returns the same object on repeat calls", () => {
    const a = loadDataset("ambiguous");
    const b = loadDataset("ambiguous");
    assert.equal(a, b);
  });
});

describe("normalizeDataset", () => {
  const validJson = (extra: object = {}) => ({
    id: "test",
    description: "test dataset",
    items: [
      { id: "a", question: "q1" },
      { id: "b", question: "q2", gold: "g2", notes: "n2" },
    ],
    ...extra,
  });

  function content(obj: unknown): string {
    return JSON.stringify(obj);
  }

  test("normalizes a well-formed dataset and computes a hash", () => {
    const raw = validJson();
    const ds = normalizeDataset(raw, "test.json", content(raw));
    assert.equal(ds.id, "test");
    assert.equal(ds.items.length, 2);
    assert.equal(ds.items[1]?.gold, "g2");
    assert.equal(ds.items[1]?.notes, "n2");
    assert.match(ds.hash, /^[0-9a-f]{12}$/);
  });

  test("throws on missing id", () => {
    const raw = { description: "x", items: [] };
    assert.throws(
      () => normalizeDataset(raw, "test.json", content(raw)),
      /missing string "id"/,
    );
  });

  test("throws on missing description", () => {
    const raw = { id: "x", items: [] };
    assert.throws(
      () => normalizeDataset(raw, "test.json", content(raw)),
      /missing string "description"/,
    );
  });

  test("throws on missing items array", () => {
    const raw = { id: "x", description: "y" };
    assert.throws(
      () => normalizeDataset(raw, "test.json", content(raw)),
      /missing array "items"/,
    );
  });

  test("throws on item without id or question", () => {
    const noId = {
      id: "x",
      description: "y",
      items: [{ question: "q" }],
    };
    assert.throws(
      () => normalizeDataset(noId, "test.json", content(noId)),
      /index 0 missing string "id"/,
    );

    const noQuestion = {
      id: "x",
      description: "y",
      items: [{ id: "a" }],
    };
    assert.throws(
      () => normalizeDataset(noQuestion, "test.json", content(noQuestion)),
      /missing string "question"/,
    );
  });

  test("throws on duplicate item ids", () => {
    const raw = {
      id: "x",
      description: "y",
      items: [
        { id: "a", question: "q1" },
        { id: "a", question: "q2" },
      ],
    };
    assert.throws(
      () => normalizeDataset(raw, "test.json", content(raw)),
      /duplicate item id "a"/,
    );
  });

  test("identical content yields identical hash", () => {
    const raw = validJson();
    const a = normalizeDataset(raw, "x.json", content(raw));
    const b = normalizeDataset(raw, "y.json", content(raw));
    assert.equal(a.hash, b.hash);
  });
});
