import assert from "node:assert/strict";
import { readFixture, searchCases, tracklist } from "./search-cases.mjs";

const pages = [1, 2, 3, 4].map((number) => readFixture(`page-${number}.json`));
const rows = pages.flatMap(({ rows }) => rows);
const releasePairs = Map.groupBy(rows.filter(({ submitted, mapped }) =>
  submitted.release_mbid && mapped.release_mbid && submitted.release_mbid !== mapped.release_mbid),
({ submitted, mapped }) => `${submitted.release_mbid}/${mapped.release_mbid}`);

console.table([...releasePairs].map(([pair, affected]) => {
  const [sourceId, mappedId] = pair.split("/");
  const source = tracklist(sourceId);
  const mapped = tracklist(mappedId);
  const members = (release) => new Set(release.media.flatMap(({ tracks }) => tracks.map(({ recording }) => recording)));
  const sourceRecordings = members(source);
  const mappedRecordings = members(mapped);
  assert.ok(affected.every((row) => row.submitted.recording_mbid === row.mapped.recording_mbid));
  assert.ok(affected.every(({ submitted }) =>
    sourceRecordings.has(submitted.recording_mbid) && mappedRecordings.has(submitted.recording_mbid)));
  return {
    release: source.title,
    sourceFormat: source.media.map(({ format }) => format).join(" + "),
    mappedFormat: mapped.media.map(({ format }) => format).join(" + "),
    rows: affected.length,
    submittedRecordingOnBoth: affected.length,
  };
}));

const sparkle = searchCases.find(({ input }) => input.track === "Sparkle - movie ver.");
const alternate = searchCases.find(({ input }) => input.track === "Golden Brown - Slowed Down Version");
const duration = ({ submitted }) => submitted.duration_ms ?? submitted.duration * 1000;
const catalogTracks = ({ input }) => tracklist(input.releaseId).media.flatMap(({ position, tracks }) =>
  tracks.map((track) => ({ medium: position, ...track })));
const candidates = catalogTracks(sparkle).filter(({ title }) => /^sparkle\b/i.test(title));
const supplied = duration(sparkle.input);
assert.equal(supplied, 534120);
assert.equal(candidates.length, 2);
console.table(candidates.map(({ medium, number, title, recording, length }) => ({
  medium, number, title, catalogMs: length, suppliedMs: supplied, distanceMs: Math.abs(length - supplied),
  mapperPicked: recording === sparkle.input.mapped.recording_mbid,
  independentlySupported: recording === sparkle.label,
})));
const slowdown = catalogTracks(alternate).find(({ recording }) => recording === alternate.input.mapped.recording_mbid);
assert.ok(slowdown);
assert.equal(alternate.label, null);
console.log(JSON.stringify({
  input: alternate.input.track,
  mappedTitle: slowdown.title,
  suppliedMs: duration(alternate.input),
  catalogMs: slowdown.length,
  distanceMs: Math.abs(slowdown.length - duration(alternate.input)),
}));
