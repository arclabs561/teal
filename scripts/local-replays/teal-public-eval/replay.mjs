import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { isMainThread, parentPort, Worker, workerData } from "node:worker_threads";

const fixture = JSON.parse(await readFile(new URL("./musicbrainz-fixtures.json", import.meta.url)));
const matchers = {
  "Upstream base": "../teal-eval/baseline/searchOrchestrator.ts",
  "#253": "../teal-pr-updates/verification/search/searchOrchestrator.ts",
  "Rewrite": "../teal-eval/rewrite/searchOrchestrator.ts",
  "Rewrite with local fix": "../teal-eval/rewrite-patched/searchOrchestrator.ts",
};

if (isMainThread) {
  const results = [];
  const check = process.argv.includes("--check");
  for (const name of Object.keys(matchers)) {
    for (const testCase of fixture.cases) {
      const result = await new Promise((resolve, reject) => {
        const worker = new Worker(new URL(import.meta.url), { workerData: { name, testCase } });
        worker.once("message", resolve);
        worker.once("error", reject);
      });
      if (check && !testCase.knownMiss) {
        assert.equal(result.position, 1, `${name} / ${testCase.name}`);
        assert.equal(result.requests, 1, `Unexpected fallback for ${testCase.name}`);
      }
      results.push(result);
    }
  }
  console.table(results.map(({ caseName, matcher, position, requests }) => ({
    case: caseName,
    matcher,
    position: position ?? "miss",
    requests,
  })));
  for (const result of results.filter((result) => result.position !== 1)) {
    console.log(`${result.matcher} / ${result.caseName}: first = ${result.first ?? "none"}`);
  }
} else {
  const { name, testCase } = workerData;
  const responses = new Map(fixture.responses.map((response) => [response.query, response]));
  const queries = [];
  const missing = [];
  globalThis.fetch = async (input) => {
    const url = new URL(input);
    const query = url.searchParams.get("query");
    queries.push(query);
    const snapshot = responses.get(query);
    if (
      url.origin !== "https://musicbrainz.org" ||
      url.pathname !== "/ws/2/recording" ||
      url.searchParams.get("limit") !== String(fixture.searchLimit) ||
      !snapshot
    ) {
      missing.push(url.href);
      return new Response(null, { status: 400 });
    }
    return Response.json({ recordings: snapshot.recordings });
  };

  // The transport is stubbed. Each case runs in a new Worker with an empty cache.
  process.env.MB_RATE_LIMIT_MS = "0";
  const { searchMusicbrainz } = await import(matchers[name]);
  const results = await searchMusicbrainz(testCase.input);
  assert.deepEqual(missing, [], "Missing MusicBrainz response for replay");
  const expected = fixture.labels[testCase.label].recordingId;
  const index = results.findIndex((recording) => recording.id === expected);
  const first = results[0];
  parentPort.postMessage({
    caseName: testCase.name,
    matcher: name,
    position: index < 0 ? null : index + 1,
    first: first && `${first.title} (${first.disambiguation || first.releases?.[0]?.title || first.id})`,
    requests: queries.length,
  });
}
