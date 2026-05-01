import { test, describe, afterEach } from "node:test";
import assert from "node:assert/strict";

import { searchWikipedia } from "./wikipedia.ts";

type FetchInput = Parameters<typeof fetch>[0];
type FetchInit = Parameters<typeof fetch>[1];

function mockFetch(
  handler: (input: FetchInput, init: FetchInit) => Partial<Response> & {
    ok: boolean;
    json: () => Promise<unknown>;
  },
): { restore: () => void; lastUrl: () => string } {
  const original = globalThis.fetch;
  let lastUrl = "";
  globalThis.fetch = (async (input: FetchInput, init?: FetchInit) => {
    lastUrl = String(input);
    const r = handler(input, init);
    return r as unknown as Response;
  }) as typeof fetch;
  return {
    restore: () => {
      globalThis.fetch = original;
    },
    lastUrl: () => lastUrl,
  };
}

describe("searchWikipedia", () => {
  let restore: () => void = () => {};

  afterEach(() => {
    restore();
  });

  test("returns hits sorted by `index` (preserving search rank)", async () => {
    ({ restore } = mockFetch(() => ({
      ok: true,
      json: async () => ({
        query: {
          pages: [
            {
              pageid: 2,
              title: "Second",
              index: 2,
              extract: "second body",
              fullurl: "https://en.wikipedia.org/wiki/Second",
            },
            {
              pageid: 1,
              title: "First",
              index: 1,
              extract: "  first body  ",
              fullurl: "https://en.wikipedia.org/wiki/First",
            },
          ],
        },
      }),
    })));

    const hits = await searchWikipedia("test");

    assert.equal(hits.length, 2);
    assert.equal(hits[0]?.title, "First");
    assert.equal(hits[1]?.title, "Second");
    assert.equal(hits[0]?.extract, "first body", "extract should be trimmed");
  });

  test("returns [] when there are no results", async () => {
    ({ restore } = mockFetch(() => ({
      ok: true,
      json: async () => ({}),
    })));

    const hits = await searchWikipedia("anything");
    assert.deepEqual(hits, []);
  });

  test("throws on non-OK HTTP status", async () => {
    ({ restore } = mockFetch(() => ({
      ok: false,
      status: 500,
      statusText: "Internal Server Error",
      json: async () => ({}),
    })));

    await assert.rejects(() => searchWikipedia("test"), /500/);
  });

  test("throws on MediaWiki error body", async () => {
    ({ restore } = mockFetch(() => ({
      ok: true,
      json: async () => ({
        error: { code: "badparam", info: "Invalid parameter" },
      }),
    })));

    await assert.rejects(
      () => searchWikipedia("test"),
      /badparam.*Invalid parameter/,
    );
  });

  test("falls back to constructed URL when fullurl is absent", async () => {
    ({ restore } = mockFetch(() => ({
      ok: true,
      json: async () => ({
        query: {
          pages: [
            { pageid: 1, title: "Hello World", index: 1, extract: "" },
          ],
        },
      }),
    })));

    const hits = await searchWikipedia("test");
    assert.equal(hits[0]?.url, "https://en.wikipedia.org/wiki/Hello_World");
  });

  test("sends correct query parameters to MediaWiki", async () => {
    let captured = "";
    ({ restore } = mockFetch((input) => {
      captured = String(input);
      return { ok: true, json: async () => ({}) };
    }));

    await searchWikipedia("Marie Curie", { limit: 7, extractChars: 800 });

    assert.match(captured, /^https:\/\/en\.wikipedia\.org\/w\/api\.php\?/);
    assert.match(captured, /generator=search/);
    assert.match(captured, /gsrsearch=Marie\+Curie/);
    assert.match(captured, /gsrlimit=7/);
    assert.match(captured, /prop=extracts/);
    assert.match(captured, /exintro=1/);
    assert.match(captured, /explaintext=1/);
    assert.match(captured, /exchars=800/);
    assert.match(captured, /redirects=1/);
    assert.match(captured, /formatversion=2/);
  });
});
