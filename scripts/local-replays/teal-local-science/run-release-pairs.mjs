import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { UnavailableSearch } from "./evaluation-transport.mjs";
import { scoreCase, summarizePairs } from "./paired-replay.mjs";
import { cases } from "./release-pair-cases.mjs";

function readFixture(name) {
  return JSON.parse(readFileSync(new URL(name, import.meta.url), "utf8"));
}

assert.deepEqual(cases, readFixture("release-pair-manifest.json"));
const captures = readFixture("release-pair-responses.json");
assert.equal(Object.keys(captures).length, 2 * cases.length);

function replay(url) {
  const response = captures[url];
  if (!response || response.unavailable) {
    throw new UnavailableSearch(response?.unavailable ?? "Fixture response not captured", url, 1);
  }
  if (response.captureUrl) {
    const intended = new URL(url);
    const captured = new URL(response.captureUrl);
    intended.searchParams.sort();
    captured.searchParams.sort();
    assert.equal(captured.href, intended.href);
  }
  assert.ok(Number.isInteger(response.count) && response.count >= 0);
  assert.equal(response.recordings.length, Math.min(5, response.count));
  return response.recordings;
}

function rankLabel(outcome) {
  return outcome.status === "scored" ? outcome.rank ?? "miss" : "unavailable";
}

const rows = [];
for (const example of cases) {
  const comparison = await scoreCase(example, example.recording, {
    baseline: ({ urls }) => replay(urls.name),
    candidate: ({ urls }) => replay(urls.id),
  });
  rows.push({ example, ...comparison });
}

const paired = rows.filter(({ baseline, candidate }) =>
  baseline.status === "scored" && candidate.status === "scored");
const matches = (arm) => ({
  top1: paired.filter((row) => row[arm].rank === 1).length,
  top5: paired.filter((row) => row[arm].rank !== null).length,
});

console.table(rows.map(({ example, baseline, candidate }) => ({
  track: example.title,
  release: example.release,
  nameRank: rankLabel(baseline),
  idRank: rankLabel(candidate),
  nameCandidates: captures[example.urls.name].count ?? "unavailable",
  idCandidates: captures[example.urls.id].count ?? "unavailable",
})));
console.log(JSON.stringify({ ...summarizePairs(rows), releaseName: matches("baseline"), releaseId: matches("candidate") }));

const releases = [...new Map(cases.map(({ releaseId, release }) => [releaseId, release]))];
console.table(releases.map(([id, title]) => ({
  omitted: title,
  top1DeltaPp: summarizePairs(rows.filter(({ example }) => example.releaseId !== id)).top1DeltaPairedPp,
})));

const alternate = readFixture("release-edition-control.json");
const { entry, otherRelease, result } = alternate;
assert.ok(otherRelease.id !== entry.releaseId);
assert.equal(otherRelease.title, entry.release);
assert.ok(new URL(result.url).searchParams.get("query").includes(`reid:${otherRelease.id}`));
const sameTitles = otherRelease.tracklist.filter(({ title }) => title === entry.title);
assert.deepEqual(sameTitles.map(({ format }) => format), ["CD", "DVD"]);
assert.equal(new Set(sameTitles.map(({ recording }) => recording)).size, 2);
assert.deepEqual(new Set(result.recordings.map(({ id }) => id)), new Set(sameTitles.map(({ recording }) => recording)));
assert.equal(result.recordings[0].score, result.recordings[1].score);
console.log(`Alternate ${otherRelease.title} edition has two recordings titled ${entry.title}. The CD and DVD candidates each score ${result.recordings[0].score}.`);
