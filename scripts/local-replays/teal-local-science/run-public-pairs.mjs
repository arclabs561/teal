import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { createEvaluationTransport, UnavailableSearch } from "./evaluation-transport.mjs";
import { makeReplaySearch, scoreCase, summarizePairs } from "./paired-replay.mjs";

const fixture = JSON.parse(await readFile(new URL(
  "../teal-public-eval/musicbrainz-fixtures.json", import.meta.url,
)));
const captured = new Map(fixture.responses.map((entry) => [entry.query, entry.recordings]));
const client = createEvaluationTransport({
  intervalMs: 0,
  retryMs: 0,
  fetcher: async (input) => {
    const url = new URL(input);
    const query = url.searchParams.get("query");
    if (
      url.pathname !== "/ws/2/recording" ||
      url.searchParams.get("limit") !== String(fixture.searchLimit) ||
      !captured.has(query)
    ) throw new UnavailableSearch("Fixture response not captured", String(url), 1);
    return Response.json({ recordings: captured.get(query) });
  },
});

const systems = makeReplaySearch(client);
const results = [];
for (const example of fixture.cases) {
  const label = fixture.labels[example.label].recordingId;
  const result = await scoreCase(example.input, label, systems);
  results.push({ name: example.name, ...result });
}

const summary = summarizePairs(results);
assert.equal(summary.comparablePairs, 4);
assert.equal(summary.baselineUnavailable + summary.candidateUnavailable, 0);
assert.equal(results.find((row) => row.name.includes("English title")).candidate.rank, null);
console.table(results.map((row) => ({
  name: row.name,
  rawQueryRank: row.baseline.rank ?? "miss",
  candidateRank: row.candidate.rank ?? "miss",
})));
console.log(JSON.stringify(summary));
console.log("Four curated queries over three recordings. No population accuracy claim.");
