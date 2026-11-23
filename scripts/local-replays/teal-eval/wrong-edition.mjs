import assert from "node:assert/strict";
process.env.MB_RATE_LIMIT_MS = "0";
const track = "Moonrise";
const artist = "Evening Ensemble";
const release = "Original Album";
const credit = [{ name: artist, artist: { id: "artist", name: artist } }];
const live = { id: "live", title: track, score: 100, "artist-credit": credit, releases: [{ title: "Live Album" }] };
const studio = { id: "studio", title: track, score: 100, "artist-credit": credit, releases: [{ title: release }] };
for (const version of ["rewrite-patched", "rewrite-shortlist"]) {
  const { searchMusicbrainz } = await import(`./${version}/searchOrchestrator.ts`);
  const queries = [];
  globalThis.fetch = async (input) => {
    const query = new URL(input).searchParams.get("query");
    queries.push(query);
    const recordings = query.includes("~") ? [live] : query.includes("artist:") ? [] : [studio];
    return Response.json({ recordings });
  };
  const [first] = await searchMusicbrainz({ track, artist, release }, { throwOnError: true });
  assert.equal(first.id, version === "rewrite-patched" ? "studio" : "live");
  console.log(version, "first result:", first.id, "requests:", queries.length);
}
