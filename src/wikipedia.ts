const ENDPOINT = "https://en.wikipedia.org/w/api.php";

const USER_AGENT =
  "wiki-search/0.1 (contact: nikita.leonov@gmail.com)";

export type WikipediaHit = {
  title: string;
  url: string;
  extract: string;
};

export type SearchOptions = {
  limit?: number;
  extractChars?: number;
};

export async function searchWikipedia(
  query: string,
  options: SearchOptions = {},
): Promise<WikipediaHit[]> {
  const limit = options.limit ?? 5;
  const extractChars = options.extractChars ?? 1500;

  const params = new URLSearchParams({
    action: "query",
    format: "json",
    formatversion: "2",
    redirects: "1",
    generator: "search",
    gsrsearch: query,
    gsrlimit: String(limit),
    gsrnamespace: "0",
    prop: "extracts|info",
    exintro: "1",
    explaintext: "1",
    exlimit: "max",
    exchars: String(extractChars),
    inprop: "url",
  });

  const res = await fetch(`${ENDPOINT}?${params.toString()}`, {
    headers: {
      "User-Agent": USER_AGENT,
      Accept: "application/json",
    },
  });

  if (!res.ok) {
    throw new Error(
      `Wikipedia API request failed: ${res.status} ${res.statusText}`,
    );
  }

  const data = (await res.json()) as MediaWikiResponse;

  if (data.error) {
    throw new Error(
      `Wikipedia API error: ${data.error.code} — ${data.error.info}`,
    );
  }

  const pages = data.query?.pages ?? [];

  // generator=search does not preserve search ranking in output order;
  // each page carries an `index` field that does. Sort by it.
  return [...pages]
    .sort((a, b) => (a.index ?? 0) - (b.index ?? 0))
    .map((p) => ({
      title: p.title,
      url: p.fullurl ?? buildFallbackUrl(p.title),
      extract: (p.extract ?? "").trim(),
    }));
}

function buildFallbackUrl(title: string): string {
  return `https://en.wikipedia.org/wiki/${encodeURIComponent(title.replace(/ /g, "_"))}`;
}

type MediaWikiPage = {
  pageid: number;
  title: string;
  index?: number;
  extract?: string;
  fullurl?: string;
};

type MediaWikiResponse = {
  query?: {
    pages?: MediaWikiPage[];
  };
  error?: {
    code: string;
    info: string;
  };
};
