import assert from "node:assert/strict";
import { readFile, writeFile } from "node:fs/promises";

const root = new URL("./", import.meta.url);
const read = async (path) => readFile(new URL(path, root), "utf8");
const evidence = JSON.parse(await read("catalog-evidence.json"));
const rows = (await read("../teal-public-ci/local/public-candidates.jsonl"))
  .trim()
  .split("\n")
  .map(JSON.parse);
const searchEvidence = JSON.parse(await read("isrc-search-confirmation.json"));

const confirmed = rows
  .filter((row) => row.client_recording_id)
  .flatMap((row) => evidence.releaseTracklists.flatMap((release) =>
    release.release === row.release
      ? release.tracks.filter((track) => track.recordingId === row.client_recording_id)
        .map((track) => ({
          track: row.track,
          artist: row.artist,
          release: row.release,
          recordingId: track.recordingId,
          trackNumber: track.number,
          evidence: release.source,
        }))
      : [],
  ));
assert.equal(confirmed.length, 12);
assert.equal(new Set(confirmed.map((row) => row.evidence)).size, 2);
const labels = JSON.stringify(confirmed, null, 2) + "\n";
if (process.argv.includes("--write")) {
  await writeFile(new URL("confirmed-labels.json", root), labels);
} else {
  assert.equal(labels, await read("confirmed-labels.json"));
}

const distinctInputs = new Map(evidence.isrcInputs.map((row) => [row.isrc, row]));
const outcomes = evidence.isrcLookups.map((lookup) => {
  const input = distinctInputs.get(lookup.isrc);
  const search = searchEvidence.find((item) => item.source.includes(encodeURIComponent(lookup.isrc)));
  const candidates = lookup.recordings?.map((row) => row.id) ??
    (search?.count === 0 ? [] : null);
  const supplemental = !input;
  const reference = input?.mapped ?? (supplemental ? "9eacbbd7-65ca-4154-ae76-9a1866ff6bcd" : null);
  return {
    track: input?.track ?? "Fireworks / 花火",
    isrc: lookup.isrc,
    candidates: candidates?.length ?? "unavailable",
    referencePresent: reference && candidates ? candidates.includes(reference) : null,
    source: supplemental ? "catalog example" : "public listen",
  };
});
assert.equal(outcomes.find((x) => x.isrc === "GBAYE8100053")?.candidates, 3);
assert.equal(outcomes.find((x) => x.isrc === "JPPO02105117")?.candidates, 1);
assert.equal(outcomes.find((x) => x.isrc === "JPPO02105117")?.referencePresent, true);
console.log("Validated 12 client-supplied labels across 2 releases. 10 are from the same album.");
console.table(outcomes);
