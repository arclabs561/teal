import assert from "node:assert/strict";

process.env.MB_RATE_LIMIT_MS ??= "1100";

const artist = "Evening Ensemble";
const cases = [
  { track: "Strong", exact: true, want: "right", calls: [1, 1] },
  { track: "Recover", fuzzy: "right", want: "right", calls: [3, 2] },
  { track: "Need title only", fuzzy: "wrong", partial: true, want: "right", calls: [3, 3] },
  { track: "Genuine miss", want: undefined, calls: [3, 3] },
  { track: "Outage", outage: true, calls: [3, 3] },
];

for (const [index, version] of ["rewrite-patched", "rewrite-shortlist"].entries()) {
  const { searchMusicbrainz } = await import(`./${version}/searchOrchestrator.ts`);
  const results = [];
  for (const scenario of cases) {
    const { track } = scenario;
    const target = {
      id: "right", title: track, score: 100,
      "artist-credit": [{ name: artist, artist: { id: "artist", name: artist } }],
    };
    let count = 0;
    let firstRequest;
    let lastRequest;
    globalThis.fetch = async (input) => {
      count++;
      firstRequest ??= performance.now();
      lastRequest = performance.now();
      const query = new URL(input).searchParams.get("query");
      if (scenario.outage) return new Response(null, { status: 502 });
      if (query.includes("~")) {
        if (scenario.fuzzy === "right") return Response.json({ recordings: [target] });
        if (scenario.fuzzy === "wrong") {
          return Response.json({ recordings: [{ ...target, id: "wrong", title: "Other song" }] });
        }
        return Response.json({ recordings: [] });
      }
      return Response.json({
        recordings: scenario.exact || (scenario.partial && !query.includes("artist:")) ? [target] : [],
      });
    };
    const result = searchMusicbrainz({ track, artist }, { throwOnError: true });
    if (scenario.outage) await assert.rejects(result, /MusicBrainz returned 502/);
    else assert.equal((await result)[0]?.id, scenario.want);
    assert.equal(count, scenario.calls[index]);
    results.push({ version, track, requests: count, requestSpanMs: Math.round(lastRequest - firstRequest) });
  }
  console.table(results);
}
