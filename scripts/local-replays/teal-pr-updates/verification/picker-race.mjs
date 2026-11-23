import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const route = readFileSync("253/apps/amethyst/app/(tabs)/(stamp)/stamp/index.tsx", "utf8");
const clear = route.match(/  const clearSearchResults = \(\) => \{[\s\S]*?\n  \};/)[0];
const search = route.match(/  const handleSearch = async \(\): Promise<void> => \{[\s\S]*?\n  \};/)[0];
const update = route.match(/  const updateSearchField = \(field: keyof SearchParams, text: string\) => \{[\s\S]*?\n  \};/)[0];
const build = Function("searchMusicbrainz", `
  let searchFields = {track: "old"};
  let phase, results, selected, releases, searched;
  const activeSearch = {current: null};
  const setSearchPhase = (v) => phase = v;
  const setSearchResults = (v) => results = v;
  const setSelectedTrack = (v) => selected = v;
  const setReleaseSelections = (v) => releases = v;
  const setHasSearched = (v) => searched = v;
  const setSearchFields = (cb) => searchFields = cb(searchFields);
  ${clear}
  ${search.replace(": Promise<void>", "")}
  ${update.replace("field: keyof SearchParams, text: string", "field, text")}
  return {handleSearch, clearSearchResults, updateSearchField,
    state: () => ({phase, results, selected, releases, searched})};
`);
const pending = [];
const feature = build((fields, progress) => new Promise((resolve) => pending.push({fields, progress, resolve})));
const old = feature.handleSearch();
await feature.handleSearch();
assert.equal(pending.length, 1);
pending[0].progress.onFallback();
assert.equal(feature.state().phase, "fallback");
feature.updateSearchField("track", "new");
assert.equal(pending[0].progress.signal.aborted, true);
assert.deepEqual(feature.state(), {phase: "idle", results: [], selected: null, releases: {}, searched: false});
const newer = feature.handleSearch();
assert.equal(pending[1].fields.track, "new");
pending[1].resolve(["new hit"]);
await newer;
pending[0].resolve(["stale hit"]);
await old;
assert.deepEqual(feature.state().results, ["new hit"]);
feature.clearSearchResults();
assert.equal(feature.state().searched, false);
console.log("Manual picker suppresses duplicates and preserves new results after stale searches finish.");
