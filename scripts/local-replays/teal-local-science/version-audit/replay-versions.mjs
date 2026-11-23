import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { searchRecordings } from "../../teal-public-ci/apps/amethyst/lib/searchOrchestrator.ts";
import { buildQueryPart } from "../../teal-public-ci/apps/amethyst/lib/musicbrainzSearchUtils.ts";

const read = (file) => JSON.parse(readFileSync(new URL(file, import.meta.url), "utf8"));
const cases = read("plan.json");
const captures = read("responses.json");
const config = { enableCleaning: true, enableFuzzy: true, enableMultiStage: true };
const explicitVersion = (title) => title?.match(/\b(movie|english)\s+ver(?:sion)?\.?[)\]]?\s*$/i)?.[1].toLowerCase();

function promoteVersion(results, input) {
  const requested = explicitVersion(input.track);
  const first = results[0];
  const firstVersion = explicitVersion(first?.title);
  if (!requested || !firstVersion || firstVersion === requested) return results;

  const credited = (result) => result["artist-credit"]?.some(({ name }) => name.toLowerCase() === input.artist.toLowerCase());
  if (!credited(first)) return results;

  const releases = new Set(first.releases?.map(({ id }) => id));
  const matching = results.find((result) => explicitVersion(result.title) === requested && credited(result) &&
    result.releases?.some(({ id }) => releases.has(id)));
  return matching ? [matching, ...results.filter((result) => result.id !== matching.id)] : results;
}

const report = [];
for (const input of cases) {
  let requests = 0;
  const baseline = await searchRecordings(input, config, async (track, artist, release, strategy) => {
    requests++;
    assert.equal(strategy, "exact");
    const query = Object.entries({ title: track, artist, release }).filter(([, value]) => value)
      .map(([field, value]) => buildQueryPart(field, value, strategy)).join(" AND ");
    const capture = captures[query];
    assert.ok(capture && !capture.unavailable, `Missing captured response for ${query}`);
    assert.equal(new URL(capture.captureUrl).searchParams.get("limit"), "25");
    return capture.recordings;
  });
  assert.equal(requests, 2);
  const changed = promoteVersion(baseline, input);
  const rank = (results) => results.findIndex(({ id }) => id === input.recordingId) + 1;
  assert.equal(rank(changed) > 0, rank(baseline) > 0);
  assert.deepEqual(promoteVersion(baseline, { ...input, track: input.track.split(" - ")[0] }), baseline);
  const separated = baseline.map((result, index) => index === 0 ? result : { ...result, releases: [] });
  assert.deepEqual(promoteVersion(separated, input), separated);
  report.push({ track: input.track, before: rank(baseline) || "miss", after: rank(changed) || "miss", requests });
}

console.table(report);
const top1 = (arm) => report.filter((row) => row[arm] === 1).length;
assert.equal(top1("before"), 3);
assert.equal(top1("after"), 5);
console.log("Top one improved from 3/6 to 5/6 with zero added requests. All six labels come from one album.");

const spelling = read("spelling-probe.json");
const zen = cases.find(({ track }) => track === "Zenzenzense - movie ver.");
assert.equal(spelling["provider-spelling"].count, 0);
assert.equal(spelling["native-spelling"].recordings[0].id, zen.recordingId);
console.log("Zenzenzense exact provider spelling returned zero. The known Japanese title found the requested movie version first.");
