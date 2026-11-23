import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import type { MusicBrainzRecording, SearchParams } from "../../apps/amethyst/lib/oldStamp";

interface Fixture {
  searchLimit: number;
  cases: Array<{
    name: string;
    input: SearchParams;
    label: number;
    knownMiss?: boolean;
  }>;
  labels: Array<{ recordingId: string }>;
  responses: Array<{ query: string; recordings: MusicBrainzRecording[] }>;
}

async function main() {
  const check = process.argv.includes("--check");
  const fixture = JSON.parse(readFileSync(
    resolve("scripts/eval/fixtures/musicbrainz-public.json"), "utf8",
  )) as Fixture;
  const responses = new Map(fixture.responses.map((response) => [
    response.query, response.recordings,
  ]));
  assert.equal(responses.size, fixture.responses.length, "Duplicate fixture query");

  // Fetch is stubbed throughout. Skip the network rate-limit delay for replay.
  process.env.MB_RATE_LIMIT_MS = "0";
  const { searchMusicbrainz } = await import("../../apps/amethyst/lib/searchOrchestrator");
  const originalFetch = globalThis.fetch;
  const results = [];

  try {
    for (const example of fixture.cases) {
      let requests = 0;
      const missing: string[] = [];
      globalThis.fetch = async (input) => {
        requests++;
        const url = new URL(String(input));
        const query = url.searchParams.get("query");
        const recordings = query === null ? undefined : responses.get(query);
        if (
          url.origin !== "https://musicbrainz.org" ||
          url.pathname !== "/ws/2/recording" ||
          url.searchParams.get("limit") !== String(fixture.searchLimit) ||
          recordings === undefined
        ) {
          missing.push(url.href);
          return new Response(null, { status: 400 });
        }
        return Response.json({ recordings });
      };

      const recordings = await searchMusicbrainz(example.input);
      assert.deepEqual(missing, [], `Missing replay response for ${example.name}`);
      const expected = fixture.labels[example.label].recordingId;
      const rank = recordings.findIndex((recording) => recording.id === expected) + 1;
      if (check && !example.knownMiss) {
        assert.equal(rank, 1, `Wrong first result for ${example.name}`);
        assert.equal(requests, 1, `Unexpected fallback for ${example.name}`);
      }
      results.push({
        case: example.name,
        rank: rank || "not found",
        requests,
        expectedRecording: expected,
        firstResult: recordings[0]?.id ?? "",
        coverage: example.knownMiss ? "exploratory" : "regression",
      });
    }
  } finally {
    globalThis.fetch = originalFetch;
  }

  console.table(results);
}

main().catch((error: unknown) => {
  console.error(error);
  process.exitCode = 1;
});
