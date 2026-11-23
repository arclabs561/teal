import { setTimeout as sleep } from "node:timers/promises";

export class UnavailableSearch extends Error {
  constructor(reason, url, attempts) {
    super(reason);
    this.url = url;
    this.attempts = attempts;
  }
}

export function createEvaluationTransport({
  fetcher = globalThis.fetch,
  intervalMs = 1100,
  retryMs = 1000,
  timeoutMs = 15000,
  maxRetryAfterMs = 10000,
  cache = new Map(),
} = {}) {
  let lastStart = -Infinity;
  let queue = Promise.resolve();
  const requestStarts = [];

  function reserve() {
    const slot = queue.then(async () => {
      const wait = lastStart + intervalMs - performance.now();
      if (wait > 0) await sleep(Math.ceil(wait));
      lastStart = performance.now();
      requestStarts.push(lastStart);
    });
    queue = slot;
    return slot;
  }

  async function getList(url, field) {
    const key = JSON.stringify([String(url), field]);
    const cached = cache.get(key);
    if (cached !== undefined) return cached;

    for (let attempt = 1; attempt <= 3; attempt++) {
      await reserve();
      let items;
      try {
        const response = await fetcher(url, {
          headers: { "User-Agent": "teal-eval (https://github.com/teal-fm/teal)" },
          signal: AbortSignal.timeout(timeoutMs),
        });
        if (!response.ok) {
          const temporary = response.status === 429 || response.status === 503;
          if (!temporary || attempt === 3) {
            throw new UnavailableSearch(`HTTP ${response.status}`, String(url), attempt);
          }
          const rawDelay = response.headers.get("Retry-After");
          const seconds = rawDelay === null ? NaN : Number(rawDelay);
          const serverDelay = Number.isFinite(seconds)
            ? Math.max(0, seconds * 1000)
            : rawDelay !== null
              ? Math.max(0, Date.parse(rawDelay) - Date.now()) || 0
              : 0;
          if (serverDelay > maxRetryAfterMs) {
            throw new UnavailableSearch("Retry-After exceeds this run's wait budget", String(url), attempt);
          }
          await sleep(Math.max(retryMs * 2 ** (attempt - 1), serverDelay));
          continue;
        }

        const payload = await response.json();
        items = payload?.[field];
        const name = field === "artists" ? "name" : "title";
        if (!Array.isArray(items) || items.some((item) =>
          typeof item?.id !== "string" || !item.id || typeof item[name] !== "string" || !item[name])) {
          throw new UnavailableSearch(`Invalid ${field} response`, String(url), attempt);
        }
      } catch (error) {
        if (error instanceof UnavailableSearch) throw error;
        if (attempt === 3) {
          throw new UnavailableSearch(error?.name ?? "Request failed", String(url), attempt);
        }
        await sleep(retryMs * 2 ** (attempt - 1));
        continue;
      }
      cache.set(key, items);
      return items;
    }
  }

  return { getList, requestStarts };
}
