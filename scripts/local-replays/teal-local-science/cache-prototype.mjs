import assert from "node:assert/strict";
process.env.MB_RATE_LIMIT_MS = "0";
const { baselineSearch, improvedSearchWithConfig } = await import("./scripts/eval/search-prototype.ts");
const options = { enableCleaning: true, enableFuzzy: true, enableMultiStage: true };
const artist = "Fixture Artist";
const track = "Fixture Recording";
const correct = { id: "gold", title: track, score: 100, "artist-credit": [{ name: artist }] };

const systems = [
  ["legacy baseline", (title, cache) => baselineSearch(title, artist, undefined, cache)],
  ["Amethyst evaluator", (title, cache) => improvedSearchWithConfig(title, artist, undefined, options, cache)],
];

function makeCache() {
  const rows = new Map();
  return {
    get size() { return rows.size; },
    getSearchResults(...key) {
      return rows.get(JSON.stringify(key)) ?? null;
    },
    setSearchResults(title, artist, release, value, ...options) {
      rows.set(JSON.stringify([title, artist, release, ...options]), value);
    },
  };
}

for (const [name, search] of systems) {
  const cache = makeCache();
  let requests = 0;
  globalThis.fetch = async () => {
    requests++;
    return new Response(null, { status: 502 });
  };
  await assert.rejects(search(track, cache), /MusicBrainz returned 502/);
  assert.equal(cache.size, 0);
  const failedRequests = requests;

  globalThis.fetch = async () => {
    requests++;
    return Response.json({ recordings: [correct] });
  };
  assert.equal((await search(track, cache))[0].id, correct.id);
  assert.equal(requests, failedRequests + 1);

  const emptyCache = makeCache();
  globalThis.fetch = async () => {
    requests++;
    return Response.json({ recordings: [] });
  };
  const emptyQuery = "Successful empty " + name;
  assert.deepEqual(await search(emptyQuery, emptyCache), []);
  assert.ok(emptyCache.size > 0);
  const afterEmpty = requests;
  assert.deepEqual(await search(emptyQuery, emptyCache), []);
  assert.equal(requests, afterEmpty);

  console.log(name + ": failure was visible, and recovered without replacing the eval cache.");
  console.log(name + ": successful empty response is also cached, as intended.");
}
