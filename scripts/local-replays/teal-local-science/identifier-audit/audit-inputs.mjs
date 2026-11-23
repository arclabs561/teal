import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";

const read = (name) => JSON.parse(readFileSync(new URL(name, import.meta.url), "utf8"));
const pages = [1, 2, 3, 4].map((page) => read(`page-${page}.json`));
const prior = new Set(read("../release-tracklists.json").map(({ title }) => title));
const valid = (id) => typeof id === "string" && /^[\da-f]{8}(-[\da-f]{4}){3}-[\da-f]{12}$/i.test(id);
const has = (side, key) => valid(side[`${key}_mbid`]);
const differs = ({ submitted, mapped }, key) =>
  has(submitted, key) && has(mapped, key) && submitted[`${key}_mbid`] !== mapped[`${key}_mbid`];
const textIdentity = ({ track, artist, release }) => JSON.stringify([track, artist, release]);

function coverage(label, rows) {
  const count = (test) => rows.filter(test).length;
  return {
    sample: label,
    listens: rows.length,
    uniqueInputs: new Set(rows.map(textIdentity)).size,
    sourceRelease: count(({ submitted }) => has(submitted, "release")),
    mappedRelease: count(({ mapped }) => has(mapped, "release")),
    mappedOnlyRelease: count(({ submitted, mapped }) => has(mapped, "release") && !has(submitted, "release")),
    sourceRecording: count(({ submitted }) => has(submitted, "recording")),
    mappedRecording: count(({ mapped }) => has(mapped, "recording")),
    releaseDisagree: count((row) => differs(row, "release")),
    recordingDisagree: count((row) => differs(row, "recording")),
    sourceMultiCredit: count(({ submitted }) => (submitted.artist_names?.length ?? 0) > 1),
    mappedMultiCredit: count(({ mapped }) => mapped.credits.length > 1),
  };
}

const rows = pages.flatMap(({ rows }) => rows);
const seed = "teal-provider-tracklists-v1";
const seenReleaseGroups = new Set();
const conflicts = rows.filter((row) => differs(row, "release"));
const score = (row) => createHash("sha256").update(`${seed}\n${textIdentity(row)}`).digest("hex");
const cases = pages.flatMap(({ sample, rows }) => {
  const eligible = rows.filter(({ submitted, mapped, release }) =>
    release && !prior.has(release) && (has(submitted, "release") || has(mapped, "release")));
  const ranked = [...new Map(eligible.map((row) => [textIdentity(row), row])).values()]
    .map((row) => ({ row, hash: score(row) })).sort((left, right) => left.hash.localeCompare(right.hash));
  const selected = [];
  for (const { row, hash } of ranked) {
    const provenance = has(row.submitted, "release") ? "submitted" : "mapped";
    const { release_mbid: releaseId, release_group_mbid: groupId } = row[provenance];
    if (seenReleaseGroups.has(groupId ?? releaseId)) continue;
    seenReleaseGroups.add(groupId ?? releaseId);
    selected.push({ ...row, sample, hash, releaseId, provenance });
    if (selected.length === 2) break;
  }
  return selected;
});

if (process.argv.includes("--cases")) {
  console.log(JSON.stringify(cases, null, 2));
} else {
  console.table([...pages.map((page) => coverage(page.sample, page.rows)), coverage("total", rows)]);
  for (const pair of new Set(conflicts.map(({ submitted, mapped }) => `${submitted.release_mbid}/${mapped.release_mbid}`))) {
    const [source, mapped] = pair.split("/");
    const affected = conflicts.filter((row) => row.submitted.release_mbid === source && row.mapped.release_mbid === mapped);
    console.log(JSON.stringify({ source, mapped, rows: affected.length, uniqueInputs: new Set(affected.map(textIdentity)).size,
      sameRecording: affected.filter(({ submitted, mapped }) => submitted.recording_mbid === mapped.recording_mbid).length }));
  }
}
