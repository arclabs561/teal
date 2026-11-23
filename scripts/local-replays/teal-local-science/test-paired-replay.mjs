import assert from "node:assert/strict";
import { createEvaluationTransport } from "./evaluation-transport.mjs";
import { makeReplaySearch, scoreCase, summarizePairs } from "./paired-replay.mjs";

let aliasUnavailable = true;
const attempted = [];
const client = createEvaluationTransport({
  intervalMs: 0, retryMs: 0,
  fetcher: async (input) => {
    const url = new URL(input);
    const query = url.searchParams.get("query");
    attempted.push(query);
    if (url.pathname.endsWith("/artist")) {
      if (aliasUnavailable) return new Response(null, { status: 503 });
      return Response.json({ artists: [{ id: "hisaishi", name: "Joe Hisaishi" }] });
    }
    const result = query.includes('artist:"Joe Hisaishi"')
      ? [{ id: "studio", title: "Summer", score: 100, "artist-credit": [{ name: "Joe Hisaishi" }] }]
      : [];
    return Response.json({ recordings: result });
  },
});
const search = makeReplaySearch(client);
const input = { track: "Summer", artist: "久石譲" };
const failed = await scoreCase(input, "studio", search);
assert.equal(failed.baseline.status, "scored");
assert.equal(failed.baseline.rank, null);
assert.equal(failed.candidate.status, "unavailable");
assert.match(failed.candidate.url, /\/artist\?/);
assert.equal(attempted.filter((query) => query.startsWith("alias:")).length, 3);
aliasUnavailable = false;
const repaired = await scoreCase(input, "studio", search);
assert.equal(repaired.candidate.rank, 1);
assert.equal(attempted.filter((query) => query.startsWith("alias:")).length, 4);
assert.equal(attempted.filter((query) => query.includes('artist:"久石譲"')).length, 1);
console.log("Alias 503 was unavailable. The recovered alias found the recording and reused the healthy exact miss.");

const scored = (rank) => ({ status: "scored", rank });
const unavailable = { status: "unavailable" };
const comparison = summarizePairs([
  { baseline: scored(1), candidate: scored(1) },
  { baseline: scored(null), candidate: scored(1) },
  { baseline: scored(null), candidate: scored(null) },
  { baseline: scored(1), candidate: unavailable },
  { baseline: unavailable, candidate: unavailable },
]);
assert.equal(comparison.comparablePairs, 3);
assert.deepEqual(comparison.top1DeltaAllQueriesBoundsPp, [-20, 40]);
assert.ok(Math.abs(comparison.top1DeltaPairedPp - 33.333333333333336) < 0.0001);
assert.equal(summarizePairs([{ baseline: unavailable, candidate: unavailable }]).top1DeltaPairedPp, null);
console.log("Synthetic comparison with 2 unavailable pairs:", JSON.stringify(comparison));

const uncapturedTransport = createEvaluationTransport({
  intervalMs: 0,
  fetcher: async (url) => {
    const { UnavailableSearch } = await import("./evaluation-transport.mjs");
    throw new UnavailableSearch("Fixture response not captured", String(url), 1);
  },
});
const uncaptured = await scoreCase(input, "studio", makeReplaySearch(uncapturedTransport));
assert.equal(uncaptured.baseline.status, "unavailable");
assert.equal(uncaptured.candidate.status, "unavailable");
assert.match(uncaptured.baseline.reason, /not captured/);
assert.equal(summarizePairs([uncaptured]).comparablePairs, 0);
console.log("An absent cassette entry cannot enter the paired denominator.");
