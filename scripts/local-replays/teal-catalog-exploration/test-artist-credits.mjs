import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const fixture = JSON.parse(await readFile(new URL("./artist-credit-fixtures.json", import.meta.url)));
process.env.MB_RATE_LIMIT_MS = "0";
const { searchMusicbrainz } = await import("../teal-pr-updates/verification/search/searchOrchestrator.ts");
const results = [];

for (const example of fixture.normal) {
  assert.ok(example.data, "Missing exact response for " + example.input.track);
  const variant = fixture.separate.find((row) => row.track === example.input.track);
  // These two examples have independently inspected, distinct artist credits.
  // The experiment does not infer credits by splitting arbitrary display names.
  if (variant) assert.equal(example.data.recordings.length, 0);
  const response = variant ?? example;
  assert.ok(response.data);

  let requests = 0;
  const missing = [];
  globalThis.fetch = async (input) => {
    requests++;
    const requested = new URL(input);
    const originalQuery = new URL(example.url).searchParams.get("query");
    if (requested.searchParams.get("query") !== originalQuery) {
      missing.push(requested.href);
      return new Response(null, { status: 400 });
    }
    return Response.json({ recordings: response.data.recordings });
  };
  const ranked = await searchMusicbrainz(example.input);
  assert.deepEqual(missing, []);
  assert.equal(requests, 1);
  assert.equal(ranked[0]?.id, example.expected);
  results.push({
    track: example.input.track,
    currentExact: example.data.recordings.length,
    structuredCreditsExact: variant ? variant.data.recordings.length : "unchanged",
    testedFirst: ranked[0].id,
    requests,
  });
}
assert.equal(results.length, 6);
console.table(results);
console.log("The base exact query found neither collaborative recording. Replaying the separate-credit response put both first in one lookup.");
console.log("Some current fallback responses could not be captured. This is a first-stage comparison.");
