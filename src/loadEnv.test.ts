import { test, describe, afterEach, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { loadEnv } from "./loadEnv.ts";

const TRACKED_KEYS = [
  "WIKI_TEST_PLAIN",
  "WIKI_TEST_QUOTED",
  "WIKI_TEST_SINGLE",
  "WIKI_TEST_EMPTY",
  "WIKI_TEST_OVERRIDE",
];

function clearTracked(): void {
  for (const k of TRACKED_KEYS) delete process.env[k];
}

describe("loadEnv", () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "loadenv-"));
    clearTracked();
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
    clearTracked();
  });

  test("returns loaded:false when .env is missing", () => {
    const result = loadEnv(dir);
    assert.equal(result.loaded, false);
    assert.equal(result.path, join(dir, ".env"));
  });

  test("parses KEY=value pairs into process.env", () => {
    writeFileSync(
      join(dir, ".env"),
      "WIKI_TEST_PLAIN=hello\nWIKI_TEST_EMPTY=\n",
    );
    const result = loadEnv(dir);
    assert.equal(result.loaded, true);
    assert.equal(process.env.WIKI_TEST_PLAIN, "hello");
    assert.equal(process.env.WIKI_TEST_EMPTY, "");
  });

  test("skips comments and blank lines", () => {
    writeFileSync(
      join(dir, ".env"),
      "# a comment\n\nWIKI_TEST_PLAIN=ok\n  # indented comment is NOT skipped (starts with space, not #)\n",
    );
    loadEnv(dir);
    assert.equal(process.env.WIKI_TEST_PLAIN, "ok");
  });

  test("strips surrounding double and single quotes", () => {
    writeFileSync(
      join(dir, ".env"),
      `WIKI_TEST_QUOTED="double quoted"\nWIKI_TEST_SINGLE='single quoted'\n`,
    );
    loadEnv(dir);
    assert.equal(process.env.WIKI_TEST_QUOTED, "double quoted");
    assert.equal(process.env.WIKI_TEST_SINGLE, "single quoted");
  });

  test("does not override variables already set in process.env", () => {
    process.env.WIKI_TEST_OVERRIDE = "from-shell";
    writeFileSync(join(dir, ".env"), "WIKI_TEST_OVERRIDE=from-file\n");
    loadEnv(dir);
    assert.equal(process.env.WIKI_TEST_OVERRIDE, "from-shell");
  });

  test("ignores malformed lines without an `=` separator", () => {
    writeFileSync(
      join(dir, ".env"),
      "this is not a valid line\nWIKI_TEST_PLAIN=set\n",
    );
    loadEnv(dir);
    assert.equal(process.env.WIKI_TEST_PLAIN, "set");
  });
});
