import assert from "node:assert/strict";
import { UnavailableSearch } from "../evaluation-transport.mjs";
import { scoreCase, summarizePairs } from "../paired-replay.mjs";
import { searchRecordings } from "../../teal-public-ci/apps/amethyst/lib/searchOrchestrator.ts";
import { buildQueryPart } from "../../teal-public-ci/apps/amethyst/lib/musicbrainzSearchUtils.ts";
import { readFixture, searchCases } from "./search-cases.mjs";

const captures = readFixture("paired-responses.json");
assert.deepEqual(searchCases, readFixture("search-manifest.json"));

function keyFor(url) {
  const normalized = new URL(url);
  if (normalized.searchParams.get("offset") === "0") normalized.searchParams.delete("offset");
  normalized.searchParams.sort();
  return normalized.href;
}

function replay(key, intended) {
  const capture = captures[key];
  if (!capture || capture.unavailable) throw new UnavailableSearch("Missing capture", intended, capture?.failures.length ?? 0);
  assert.equal(keyFor(intended), keyFor(capture.captureUrl));
  assert.equal(capture.recordings.length, Math.min(capture.count, Number(new URL(intended).searchParams.get("limit"))));
  return capture.recordings;
}

const rows = [];
for (const [index, sample] of searchCases.entries()) {
  const prefix = `${index + 1}-`;
  const pair = sample.label && await scoreCase(sample, sample.label, {
    baseline: () => replay(`${prefix}name`, sample.urls.name),
    candidate: () => replay(`${prefix}id`, sample.urls.id),
  });
  rows.push({ sample, prefix, pair });
}

const displayRank = (result) => result.status === "scored" ? result.rank ?? "miss" : "unavailable";
console.table(rows.map(({ sample, prefix, pair }) => ({
  track: sample.input.track,
  releaseIdFrom: sample.input.provenance,
  label: sample.catalogTrack ?? "unresolved",
  nameRank: pair ? displayRank(pair.baseline) : "excluded",
  idRank: pair ? displayRank(pair.candidate) : "excluded",
  nameHits: captures[`${prefix}name`].count ?? "unavailable",
  idHits: captures[`${prefix}id`].count ?? "unavailable",
})));

const paired = rows.flatMap(({ pair }) => pair ? [pair] : []);
const complete = paired.filter(({ baseline, candidate }) => baseline.status === "scored" && candidate.status === "scored");
function totals(arm) {
  return {
    top1: complete.filter((pair) => pair[arm].rank === 1).length,
    top5: complete.filter((pair) => pair[arm].rank !== null).length,
  };
}
console.log(JSON.stringify({ ...summarizePairs(paired), releaseName: totals("baseline"), releaseId: totals("candidate"), unresolved: rows.length - paired.length }));

const sparkle = searchCases.find(({ input }) => input.track === "Sparkle - movie ver.");
async function runCurrentPr(sample, keys) {
  const { track, artist, release } = sample.input;
  const calls = [];
  const config = { enableCleaning: true, enableFuzzy: true, enableMultiStage: true };
  const results = await searchRecordings({ track, artist, release }, config,
    async (track, artist, release, strategy) => {
      const query = Object.entries({ title: track, artist, release }).filter(([, value]) => value)
        .map(([field, value]) => buildQueryPart(field, value, strategy)).join(" AND ");
      const intended = `https://musicbrainz.org/ws/2/recording?query=${encodeURIComponent(query)}&fmt=json&limit=25`;
      const key = release ? keys.withRelease : keys.withoutRelease;
      calls.push(key);
      return replay(key, intended);
    });
  return { results, calls };
}

const { results: currentPr, calls } = await runCurrentPr(sparkle, {
  withRelease: "pinned-app-with-album", withoutRelease: "pinned-app-without-album",
});
assert.deepEqual(calls, ["pinned-app-with-album", "pinned-app-without-album"]);
assert.equal(currentPr[0].id, sparkle.input.mapped.recording_mbid);
assert.equal(currentPr[1].id, sparkle.label);

function byDuration(results, durationMs) {
  const gap = ({ length }) => Number.isFinite(length) ? Math.abs(length - durationMs) : Infinity;
  return [...results].sort((left, right) => gap(left) - gap(right));
}

const durationTop = byDuration(currentPr, sparkle.input.submitted.duration_ms)[0];
assert.equal(durationTop.id, sparkle.label);
console.log(JSON.stringify({
  track: sparkle.input.track, actualPrRequests: calls.length, actualPrFirst: currentPr[0].title,
  actualPrSecond: currentPr[1].title, durationFirstWithoutMoreRequests: durationTop.title,
  additionalTextProbes: Object.fromEntries(["provider-title-id", "catalog-title-id", "native-title-with-id", "catalog-album-name"]
    .map((key) => {
      const fixture = captures[key];
      return [key, fixture.unavailable ? "unavailable" : replay(key, fixture.intended).map(({ title }) => title)];
    })),
}));

const polyrytmi = searchCases.find(({ input }) => input.track === "Polyrytmi");
const polyrytmiReplay = await runCurrentPr(polyrytmi, { withRelease: "app-25-Polyrytmi" });
assert.equal(polyrytmiReplay.calls.length, 1);
const durationWinner = byDuration(polyrytmiReplay.results, polyrytmi.input.submitted.duration_ms)[0];
assert.notEqual(durationWinner.id, polyrytmi.label);
console.log(JSON.stringify({
  track: polyrytmi.input.track, actualPrRequests: polyrytmiReplay.calls.length,
  tracklistRank: polyrytmiReplay.results.findIndex(({ id }) => id === polyrytmi.label) + 1,
  durationWinner: durationWinner.id, submittedReleaseTracklist: polyrytmi.label,
}));
