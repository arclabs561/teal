import assert from "node:assert/strict";

process.env.MB_RATE_LIMIT_MS = "0";
const artist = "Evening Ensemble";
const cases = [
  { track: "Northlight", scores: [], top: true },
  { track: "Moonrise", scores: [10] },
  { track: "Sunrise", scores: [10, 12, 15] },
  { track: "Daybreak", scores: [], noMatch: true },
];

async function replay(version) {
  const { searchMusicbrainz } = await import(`./${version}/searchOrchestrator.ts`);
  const rows = [];
  for (const { track, scores, top, noMatch } of cases) {
    const target = {
      id: "target",
      title: track,
      score: 100,
      "artist-credit": [{ name: artist, artist: { id: "artist", name: artist } }],
    };
    const weak = scores.map((score) => ({ id: String(score), title: "Unrelated", score }));
    const responses = new Map([
      [`title:"${track}" AND artist:"${artist}"`, top ? [target] : weak],
      [`title:${track}~ AND artist:"${artist}"~3`, noMatch ? [] : [target]],
      [`title:"${track}"`, []],
    ]);
    let requests = 0;
    const missing = new Set();
    globalThis.fetch = async (input) => {
      requests++;
      const url = new URL(input);
      const query = url.searchParams.get("query");
      if (url.pathname !== "/ws/2/recording" || !responses.has(query)) {
        missing.add(url.href);
        // The transport turns failed requests into empty results. Record misses
        // out of band so a missing fixture cannot be scored as a real no-hit.
        return new Response(null, { status: 400 });
      }
      return Response.json({ recordings: responses.get(query) });
    };
    const results = await searchMusicbrainz({ track, artist });
    assert.equal(missing.size, 0, [...missing].join(", "));
    rows.push({ track, top: results[0]?.id ?? "(none)", requests });
  }
  return rows;
}

const baseline = await replay("baseline");
const candidate = await replay("candidate");
assert.deepEqual(baseline.map((row) => row.top), ["target", "10", "10", "(none)"]);
assert.deepEqual(candidate.map((row) => row.top), ["target", "target", "target", "(none)"]);
assert.equal(candidate[0].requests, baseline[0].requests);
console.table(candidate.map((row, index) => ({
  track: row.track,
  baseline: baseline[index].top,
  candidate: row.top,
  requests: `${baseline[index].requests} → ${row.requests}`,
})));

const rewrite = await replay("rewrite");
const patched = await replay("rewrite-patched");
assert.deepEqual(rewrite, baseline);
assert.deepEqual(patched, candidate);
console.log("Rewrite reproduces both misses. Local port matches #253.");

for (const version of ["rewrite", "rewrite-patched"]) {
  const { searchMusicbrainz } = await import(`./${version}/searchOrchestrator.ts`);
  globalThis.fetch = async () => new Response(null, { status: 502 });
  const oldError = console.error;
  console.error = () => {};
  try {
    await assert.rejects(
      searchMusicbrainz({ track: "Outage", artist }, { throwOnError: true }),
      /MusicBrainz returned 502/,
    );
  } finally {
    console.error = oldError;
  }
}
console.log("Both rewrite versions still distinguish a total outage from no results.");
