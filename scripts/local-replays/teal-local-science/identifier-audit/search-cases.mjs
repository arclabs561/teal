import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { buildQueryPart } from "../../teal-public-ci/apps/amethyst/lib/musicbrainzSearchUtils.ts";
import { cleanArtistName, cleanReleaseName, cleanTrackName } from "../../teal-public-ci/apps/amethyst/lib/musicbrainzCleaner.ts";

export const readFixture = (name) => JSON.parse(readFileSync(new URL(name, import.meta.url), "utf8"));
export const tracklist = (releaseId) => readFixture(`tracklists/${releaseId}.json`);
const selections = readFixture("tracklist-manifest.json");

// Positions refer to the independent release lookup. A missing position marks
// a provider variant that the inspected tracklist did not substantiate.
const positions = [
  [1, "12", "Submitted recording and track title corroborated"],
  [1, "33", "Submitted recording and track title corroborated"],
  [null, null, "Slowed version absent from the compilation tracklist"],
  [2, "3", "Movie-version title, track number and duration agree"],
  [1, "7", "Track title, number and duration agree"],
  [null, null, "A 1987 CD does not establish the reported 2014 remaster edition"],
  [1, "2", "Case-normalized title and duration agree"],
  [1, "4", "Hyphen-normalized title and duration agree"],
];

function url(query) {
  return `https://musicbrainz.org/ws/2/recording?query=${encodeURIComponent(query.join(" AND "))}&fmt=json&limit=5`;
}

assert.equal(selections.length, positions.length);
export const searchCases = selections.map((input, index) => {
  const [medium, number, evidence] = positions[index];
  const list = tracklist(input.releaseId);
  const track = list.media.find((entry) => entry.position === medium)?.tracks.find((entry) => entry.number === number);
  if (medium) assert.ok(track, `Missing track at ${medium}/${number} for ${input.track}`);
  const cleaned = { title: cleanTrackName(input.track), artist: cleanArtistName(input.artist), release: cleanReleaseName(input.release) };
  const base = Object.entries({ title: cleaned.title, artist: cleaned.artist })
    .map(([field, value]) => buildQueryPart(field, value, "exact"));
  return {
    input,
    cleaned,
    evidence,
    position: medium ? { medium, number } : null,
    label: track?.recording ?? null,
    catalogTrack: track?.title ?? null,
    urls: {
      name: url([...base, buildQueryPart("release", cleaned.release, "exact")]),
      id: url([...base, `reid:${list.id}`]),
    },
  };
});
