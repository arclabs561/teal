import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { buildQueryPart } from "./matcher/musicbrainzSearchUtils.ts";
import { searchRecordings } from "./matcher/searchOrchestrator.ts";

function readFixture(name) {
  return JSON.parse(readFileSync(new URL(name, import.meta.url), "utf8"));
}

const raw = readFixture("release-pair-responses.json");
const credits = readFixture("release-credit-responses.json");
const config = { enableCleaning: true, enableFuzzy: true, enableMultiStage: true };

function rank(capture, expected) {
  if (capture.unavailable) return "unavailable";
  assert.equal(capture.recordings.length, Math.min(5, capture.count));
  return capture.recordings.findIndex(({ id }) => id === expected) + 1 || "miss";
}

const rows = [];
for (const probe of Object.values(credits)) {
  const { label } = probe;
  const expected = label.recording;
  assert.equal(probe.credits.map(({ name, joinphrase }) => name + joinphrase).join(""), label.artist);
  const input = { track: label.title, artist: label.artist, release: label.release };
  const replay = probe.leadOnlyWithReleaseName;
  assert.equal(rank(replay, expected), 1);
  let stages = 0;
  const results = await searchRecordings(input, config, async (track, artist, release, strategy) => {
    stages++;
    assert.equal(strategy, "exact");
    const actual = Object.entries({ title: track, artist, release })
      .map(([field, value]) => buildQueryPart(field, value, strategy)).join(" AND ");
    assert.equal(actual, new URL(replay.url).searchParams.get("query"));
    return replay.recordings;
  }, {
    resolveAlias: async () => assert.fail("Unexpected alias lookup in recording-only replay"),
  });
  assert.equal(stages, 1);
  assert.equal(results[0].id, expected);
  assert.equal(probe.differentKnownGuestWithReleaseId.count, 0);
  rows.push({
    track: label.title,
    rawName: rank(raw[label.urls.name], expected),
    rawId: rank(raw[label.urls.id], expected),
    appStageOne: 1,
    leadWithId: rank(probe.leadOnly, expected),
    creditsWithName: rank(probe.separateCreditsWithReleaseName, expected),
    creditsWithId: rank(probe.separateCredits, expected),
    wrongGuestWithId: rank(probe.differentKnownGuestWithReleaseId, expected),
  });
}

console.table(rows);
