import { test, describe } from "node:test";
import assert from "node:assert/strict";

import {
  DEFAULT_PROMPT_ID,
  PROMPTS,
  getPrompt,
  listPromptIds,
} from "./index.ts";

describe("prompt registry", () => {
  test("DEFAULT_PROMPT_ID resolves to a real prompt", () => {
    assert.ok(
      PROMPTS[DEFAULT_PROMPT_ID],
      `DEFAULT_PROMPT_ID="${DEFAULT_PROMPT_ID}" must exist in PROMPTS`,
    );
  });

  test("listPromptIds returns the full set of registered prompts", () => {
    const ids = listPromptIds();
    assert.ok(ids.includes("v0"));
    assert.ok(ids.includes("v1"));
    assert.equal(ids.length, Object.keys(PROMPTS).length);
  });

  test("getPrompt returns a complete config for a known id", () => {
    const v1 = getPrompt("v1");
    assert.equal(v1.id, "v1");
    assert.equal(typeof v1.description, "string");
    assert.ok(v1.systemPrompt.length > 0);
    assert.equal(v1.tool.name, "search_wikipedia");
    assert.equal(v1.tool.input_schema.type, "object");
  });

  test("getPrompt throws a helpful error for an unknown id", () => {
    assert.throws(
      () => getPrompt("does-not-exist"),
      /Unknown prompt id "does-not-exist".*Available:/,
    );
  });

  test("every registered prompt has a unique, matching id", () => {
    for (const [key, cfg] of Object.entries(PROMPTS)) {
      assert.equal(
        cfg.id,
        key,
        `registry key "${key}" must match config.id "${cfg.id}"`,
      );
    }
  });
});
