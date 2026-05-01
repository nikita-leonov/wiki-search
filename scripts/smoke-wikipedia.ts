import { searchWikipedia } from "../src/wikipedia.ts";

const query = process.argv.slice(2).join(" ").trim();

if (!query) {
  console.error('Usage: npm run smoke:wiki -- "your search query"');
  process.exit(1);
}

const hits = await searchWikipedia(query, { limit: 5 });

if (hits.length === 0) {
  console.log(`(no results for "${query}")`);
  process.exit(0);
}

console.log(`Top ${hits.length} results for "${query}":\n`);

for (const [i, hit] of hits.entries()) {
  const preview = hit.extract.length > 240
    ? hit.extract.slice(0, 240).trimEnd() + "…"
    : hit.extract;
  console.log(`${i + 1}. ${hit.title}`);
  console.log(`   ${hit.url}`);
  console.log(`   ${preview || "(no extract)"}`);
  console.log();
}
