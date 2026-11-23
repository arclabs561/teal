import assert from "node:assert/strict";
import { createEvaluationTransport, UnavailableSearch } from "./evaluation-transport.mjs";

const recordings = "https://musicbrainz.org/ws/2/recording?query=fixture";
const aliases = "https://musicbrainz.org/ws/2/artist?query=alias:久石譲";

for (const field of ["recordings", "artists"]) {
  const url = field === "recordings" ? recordings : aliases;
  const cache = new Map();
  let calls = 0;
  let available = false;
  const client = createEvaluationTransport({
    cache, intervalMs: 0, retryMs: 0,
    fetcher: async () => {
      calls++;
      if (!available) return new Response(null, { status: 503 });
      return Response.json({ [field]: [] });
    },
  });
  await assert.rejects(() => client.getList(url, field), (error) =>
    error instanceof UnavailableSearch && error.attempts === 3 && error.message === "HTTP 503");
  assert.equal(calls, 3);
  assert.equal(cache.size, 0);
  available = true;
  assert.deepEqual(await client.getList(url, field), []);
  assert.deepEqual(await client.getList(url, field), []);
  assert.equal(calls, 4);
}
console.log("503 exhaustion stays unavailable for recording and alias lookups. Successful empty responses cache.");

const badCache = new Map();
const malformed = createEvaluationTransport({
  cache: badCache, intervalMs: 0, retryMs: 0,
  fetcher: async () => Response.json({ error: "proxy returned a JSON error page" }),
});
await assert.rejects(() => malformed.getList(recordings, "recordings"), /Invalid recordings response/);
assert.equal(badCache.size, 0);
console.log("HTTP 200 with the wrong response shape stays unavailable.");

const keepAlive = setTimeout(() => {}, 1000);
try {
  const timeoutCache = new Map();
  const timeout = createEvaluationTransport({
    cache: timeoutCache, intervalMs: 0, retryMs: 0, timeoutMs: 8,
    fetcher: async (_url, { signal }) => new Promise((_, reject) => {
      signal.addEventListener("abort", () => reject(signal.reason), { once: true });
    }),
  });
  await assert.rejects(() => timeout.getList(recordings, "recordings"), (error) =>
    error instanceof UnavailableSearch && error.attempts === 3 && error.message === "TimeoutError");
  assert.equal(timeoutCache.size, 0);
} finally {
  clearTimeout(keepAlive);
}
console.log("A stalled fetch aborts after its timeout and never becomes a cached miss.");

let calls = 0;
const fetchStarts = [];
const paced = createEvaluationTransport({
  intervalMs: 20, retryMs: 0,
  fetcher: async (url) => {
    fetchStarts.push(performance.now());
    if (++calls === 1) return new Response(null, { status: 429, headers: { "Retry-After": "0" } });
    const field = url.includes("/artist?") ? "artists" : "recordings";
    return Response.json({ [field]: [] });
  },
});
await Promise.all([
  paced.getList(recordings, "recordings"),
  paced.getList(aliases, "artists"),
  paced.getList(recordings + "2", "recordings"),
]);
const gaps = paced.requestStarts.slice(1).map((ts, i) => ts - paced.requestStarts[i]);
assert.equal(calls, 4);
assert.ok(gaps.every((gap) => gap >= 19));
assert.ok(fetchStarts.slice(1).every((time, i) => time - fetchStarts[i] >= 18));
console.log("The simulated 429 retry and both endpoint types shared one 20 ms request schedule.");

const tooSlow = createEvaluationTransport({
  intervalMs: 0, retryMs: 0, maxRetryAfterMs: 100,
  fetcher: async () => new Response(null, { status: 429, headers: { "Retry-After": "120" } }),
});
await assert.rejects(() => tooSlow.getList(recordings, "recordings"), /wait budget/);
assert.equal(tooSlow.requestStarts.length, 1);
console.log("A server-directed wait outside the run budget defers the query without an early retry.");

const incompleteItem = createEvaluationTransport({
  intervalMs: 0, retryMs: 0,
  fetcher: async () => Response.json({ artists: [{ id: "alias-without-name" }] }),
});
await assert.rejects(() => incompleteItem.getList(aliases, "artists"), /Invalid artists response/);
