import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { fileURLToPath } from "node:url";
import { createEvaluationTransport, UnavailableSearch } from "./evaluation-transport.mjs";
import { openResponseCache } from "./sqlite-response-cache.mjs";

const base = "https://musicbrainz.org/ws/2";
const recording = `${base}/recording?query=recording&limit=5`;
const moreRecordings = `${base}/recording?query=recording&limit=10`;
const empty = `${base}/recording?query=empty&limit=5`;
const artist = `${base}/artist?query=alias`;
const recordingResults = [{ id: "healthy-recording", title: "Recording" }];
const artistResults = [{ id: "healthy-artist", name: "Artist" }];

async function runPhase(phase, path) {
  const cache = openResponseCache(path);
  const calls = [];
  const client = createEvaluationTransport({
    cache, intervalMs: 0, retryMs: 0,
    fetcher: async (url) => {
      calls.push(url);
      if (phase === "offline") throw new Error("Network disabled for the replay");
      if (url === empty) return Response.json({ recordings: [] });
      if (phase === "outage") return new Response(null, { status: url === artist ? 502 : 503 });
      if (url === artist) return Response.json({ artists: artistResults });
      return Response.json({ recordings: recordingResults });
    },
  });
  try {
    if (phase === "outage") {
      const database = new DatabaseSync(path);
      try {
        database.prepare("INSERT INTO evaluation_responses VALUES (?, ?, ?)")
          .run("legacy-v1", JSON.stringify([recording, "recordings"]), "[]");
      } finally {
        database.close();
      }
      assert.deepEqual(await client.getList(empty, "recordings"), []);
      await assert.rejects(() => client.getList(recording, "recordings"), (error) =>
        error instanceof UnavailableSearch && error.attempts === 3 && error.message === "HTTP 503");
      await assert.rejects(() => client.getList(artist, "artists"), /HTTP 502/);
      assert.deepEqual(calls, [empty, recording, recording, recording, artist]);
    } else {
      assert.deepEqual(await client.getList(empty, "recordings"), []);
      assert.deepEqual(await client.getList(recording, "recordings"), recordingResults);
      assert.deepEqual(await client.getList(artist, "artists"), artistResults);
      assert.deepEqual(await client.getList(moreRecordings, "recordings"), recordingResults);
      assert.deepEqual(calls, phase === "offline" ? [] : [recording, artist, moreRecordings]);
    }
  } finally {
    cache.close();
  }
  console.log(`${phase} process made ${calls.length} fetches`);
}

const [phase, path] = process.argv.slice(2);
if (phase) {
  await runPhase(phase, path);
} else {
  const directory = mkdtempSync(join(tmpdir(), "teal-eval-cache-"));
  try {
    const path = join(directory, "responses.sqlite");
    for (const phase of ["outage", "recover", "offline"]) {
      const child = spawn(process.execPath, [fileURLToPath(import.meta.url), phase, path], { stdio: "inherit" });
      const [status] = await once(child, "close");
      assert.equal(status, 0, `${phase} process failed`);
    }
    const database = new DatabaseSync(path, { readOnly: true });
    try {
      const rows = database.prepare("SELECT namespace, COUNT(*) AS count FROM evaluation_responses GROUP BY namespace ORDER BY namespace").all();
      assert.deepEqual(rows.map(({ namespace, count }) => [namespace, count]), [
        ["legacy-v1", 1], ["musicbrainz-success-v2", 4],
      ]);
      const legacy = database.prepare("SELECT results FROM evaluation_responses WHERE namespace = 'legacy-v1'").get();
      assert.equal(legacy.results, "[]");
    } finally {
      database.close();
    }
    console.log("A legacy empty entry stayed isolated. A genuine empty result survived all three processes.");
  } finally {
    rmSync(directory, { recursive: true });
  }
}
