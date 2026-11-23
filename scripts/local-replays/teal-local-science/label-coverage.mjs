import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const read = async (p) => readFile(new URL(p, import.meta.url), "utf8");
const json = async (p) => JSON.parse(await read(p));
const catalog = "../teal-catalog-exploration/";
const inputs = (await read(catalog + "listenbrainz-expanded-candidates.jsonl")).trim().split("\n").map(JSON.parse);
const direct = await json(catalog + "expanded-label-audit.json");
const earlier = await json(catalog + "confirmed-labels.json");
const drive = await json(catalog + "expanded-edition-check.json");
const expectedByEdition = drive.map((entry) => entry.label[0][2]);

const byTier = Object.groupBy(inputs, (row) => row.label_tier);
assert.equal(inputs.length, 108);
assert.equal(direct.length, byTier.client_id_needs_validation.length);
assert.equal(expectedByEdition[0], expectedByEdition[1]);
assert.notEqual(expectedByEdition[0], drive[0].indexedCandidate);

const rows = direct.map(({ input, recordingId, releaseMatches }) => {
  assert.equal(input.client_recording_id, recordingId);
  return {
    track: input.track,
    evidence: recordingId === drive[0].indexedCandidate
      ? "differs from two inspected editions"
      : releaseMatches?.length
        ? "submitted ID and release title agree"
        : "release unresolved",
  };
});
const groups = Object.groupBy(rows, (row) => row.evidence);
console.log("New 108-query seed, label candidates (before catalog checks)");
console.table(Object.entries(byTier).map(([tier, rows]) => ({ tier, count: rows.length })));
console.log("Album provenance for the 15 client-supplied IDs");
console.table(Object.entries(groups).map(([evidence, rows]) => ({ evidence, count: rows.length })));

const releases = Object.groupBy(earlier, (row) => row.evidence);
console.log("Tracklist-confirmed seed (separate earlier sample)");
console.table(Object.values(releases).map((rows) => ({ release: rows[0].release, recordings: rows.length })));
assert.equal(earlier.length, 12);
assert.equal(Math.max(...Object.values(releases).map((rows) => rows.length)), 10);
console.log("Use the independently verified cases as canaries. Compare aggregate metrics after broader album and artist coverage.");
