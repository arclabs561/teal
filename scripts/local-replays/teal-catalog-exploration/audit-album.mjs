import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const fixture = JSON.parse(await readFile(
  new URL("../teal-public-eval/musicbrainz-fixtures.json", import.meta.url),
));
const responses = new Map(fixture.responses.map((row) => [row.query, row]));
const normalize = (title) => title.normalize("NFC").trim().toLowerCase();
process.env.MB_RATE_LIMIT_MS = "0";
const { searchMusicbrainz } = await import(
  "../teal-pr-updates/verification/search/searchOrchestrator.ts"
);
const report = [];
for (const example of fixture.cases) {
  const requested = normalize(example.input.release);
  const missing = [];
  let requests = 0;
  globalThis.fetch = async (input) => {
    requests++;
    const query = new URL(input).searchParams.get("query");
    const response = responses.get(query);
    if (!response) {
      missing.push(query);
      return new Response(null, { status: 400 });
    }
    return Response.json({ recordings: response.recordings });
  };
  const results = await searchMusicbrainz(example.input);
  assert.deepEqual(missing, []);
  const [first] = results;
  const matchesAlbumTitle = (result) =>
    result.releases?.some((release) => normalize(release.title) === requested) ?? false;
  const onNamedAlbum = results.filter(matchesAlbumTitle);
  const right = first?.id === fixture.labels[example.label].recordingId;
  report.push({
    case: example.name,
    right,
    albumUnconfirmed: !first || !matchesAlbumTitle(first),
    candidatesOnSameTitle: onNamedAlbum.length,
    requests,
  });
}
assert.equal(report.filter((row) => row.albumUnconfirmed).length, 1);
assert.equal(report.find((row) => row.albumUnconfirmed)?.right, false);
assert.ok(report.some((row) => row.candidatesOnSameTitle > 1));
console.table(report);
