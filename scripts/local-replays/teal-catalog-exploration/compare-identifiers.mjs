import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const read = async (path) => JSON.parse(await readFile(new URL(path, import.meta.url), "utf8"));
const evidence = await read("./identifier-comparison.json");
const fixture = await read("../teal-public-eval/musicbrainz-fixtures.json");

const expected = evidence.album.tracks[0][2];
const input = evidence.durationObservations.find((row) => row.release === "La Folie");
const duration = input.details.duration;
const ranking = evidence.catalogRecordings.map((item) => ({
  id: item.id,
  differenceMs: Math.abs(item.length - duration),
  onLabelRelease: item.releases.some((release) => evidence.album.url.includes(release.id)),
})).sort((a, b) => a.differenceMs - b.differenceMs);
assert.notEqual(ranking[0].id, expected);
assert.equal(ranking.find((item) => item.onLabelRelease)?.id, expected);
console.log("Golden Brown: source duration", duration, "ms; album-confirmed recording", expected);
console.table(ranking);

const bjork = fixture.cases.find((item) => item.name.includes("Björk"));
const label = fixture.labels[bjork.label];
const candidates = fixture.responses.find((item) => item.query.includes('release:"Homogenic"')).recordings;
const titleMatches = candidates.filter((r) => r.releases.some((x) => x.title === label.release));
const idMatches = titleMatches.filter((r) => r.releases.some((x) => x.id === label.releaseId));
assert.equal(titleMatches.length, 4);
assert.deepEqual(idMatches.filter((r) => r.title === bjork.input.track).map((r) => r.id), [label.recordingId]);
console.log("Bachelorette: 4 candidates match Homogenic title; title + release ID identify the track.");

assert.ok(evidence.hanabi.aliases.includes("Hanabi"));
assert.deepEqual(evidence.hanabi.recordings, ["9eacbbd7-65ca-4154-ae76-9a1866ff6bcd"]);
console.log("Ado: catalog alias Hanabi works with album context; the English title Fireworks is absent from the recorded aliases.");
