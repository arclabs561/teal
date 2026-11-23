import { buildQueryPart, escapeLucene } from "./matcher/musicbrainzSearchUtils.ts";
import { searchRecordings } from "./matcher/searchOrchestrator.ts";
import { UnavailableSearch } from "./evaluation-transport.mjs";

function searchURL(endpoint, query, limit) {
  return `https://musicbrainz.org/ws/2/${endpoint}?query=${encodeURIComponent(query)}&fmt=json&limit=${limit}`;
}

const fullSearch = { enableCleaning: true, enableFuzzy: true, enableMultiStage: true };

export function makeReplaySearch(client) {
  const baseline = ({ track, artist, release }) => {
    const query = Object.entries({ title: track, artist, release })
      .filter(([, value]) => value)
      .map(([field, value]) => `${field}:"${escapeLucene(value)}"`)
      .join(" AND ");
    return query ? client.getList(searchURL("recording", query, 25), "recordings") : [];
  };

  const recording = (track, artist, release, strategy) => {
    const query = Object.entries({ title: track, artist, release })
      .filter(([, value]) => value)
      .map(([field, value]) => buildQueryPart(field, value, strategy))
      .join(" AND ");
    return query ? client.getList(searchURL("recording", query, 25), "recordings") : [];
  };

  const resolveAlias = async (name) => {
    const query = `alias:"${name.replaceAll("\\", "\\\\").replaceAll('"', '\\"')}"`;
    const [artist] = await client.getList(searchURL("artist", query, 3), "artists");
    return artist?.name ?? null;
  };
  const candidate = (input) => searchRecordings(input, fullSearch, recording, { resolveAlias });
  return { baseline, candidate };
}

export async function scoreCase(input, expected, systems) {
  const outcome = async (search) => {
    try {
      const results = await search(input);
      const rank = results.findIndex((result) => result.id === expected) + 1;
      return { status: "scored", rank: rank || null };
    } catch (error) {
      if (!(error instanceof UnavailableSearch)) throw error;
      return { status: "unavailable", reason: error.message, url: error.url };
    }
  };
  const baseline = await outcome(systems.baseline);
  const candidate = await outcome(systems.candidate);
  return { baseline, candidate };
}

export function summarizePairs(rows) {
  let pairs = 0;
  let net = 0;
  let minimum = 0;
  let maximum = 0;
  let baselineUnavailable = 0;
  let candidateUnavailable = 0;
  for (const { baseline, candidate } of rows) {
    const before = baseline.status === "scored" ? Number(baseline.rank === 1) : null;
    const after = candidate.status === "scored" ? Number(candidate.rank === 1) : null;
    baselineUnavailable += Number(before === null);
    candidateUnavailable += Number(after === null);
    minimum += (after ?? 0) - (before ?? 1);
    maximum += (after ?? 1) - (before ?? 0);
    if (before !== null && after !== null) {
      pairs++;
      net += after - before;
    }
  }
  return {
    queries: rows.length,
    comparablePairs: pairs,
    baselineUnavailable,
    candidateUnavailable,
    top1DeltaPairedPp: pairs ? 100 * net / pairs : null,
    top1DeltaAllQueriesBoundsPp: rows.length
      ? [100 * minimum / rows.length, 100 * maximum / rows.length]
      : null,
  };
}
