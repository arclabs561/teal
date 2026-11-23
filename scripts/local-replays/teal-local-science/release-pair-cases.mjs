import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { buildQueryPart } from "./matcher/musicbrainzSearchUtils.ts";

const releaseFiles = JSON.parse(readFileSync(new URL("release-tracklists.json", import.meta.url), "utf8"));
const sampleSeed = "teal-release-pairs-v1";
const knownTitles = new Set(["Drive", "Golden Brown", "花火", "Bachelorette"]);

function recordingUrl(query) {
  return `https://musicbrainz.org/ws/2/recording?query=${encodeURIComponent(query)}&fmt=json&limit=5`;
}

export const cases = releaseFiles.flatMap((release) => {
  const scores = new Map(release.tracks.map((track) => [track.recording, createHash("sha256")
    .update(`${sampleSeed}:${release.id}:${track.recording}`).digest("hex")]));
  const candidates = release.tracks.filter((track) => !knownTitles.has(track.title));
  const distinct = [...new Map(candidates.map((track) => [track.recording, track])).values()];
  return distinct.sort((left, right) => scores.get(left.recording).localeCompare(scores.get(right.recording)))
    .slice(0, 2).map((track) => {
      const text = [buildQueryPart("title", track.title, "exact"), buildQueryPart("artist", track.artist, "exact")];
      return {
        ...track,
        release: release.title,
        releaseId: release.id,
        tracklistUrl: release.url,
        urls: {
          name: recordingUrl([...text, buildQueryPart("release", release.title, "exact")].join(" AND ")),
          id: recordingUrl([...text, `reid:${release.id}`].join(" AND ")),
        },
      };
    });
});
