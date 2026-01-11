/**
 * Shared utilities for MusicBrainz search
 * Used by both frontend (oldStamp.tsx) and evaluation scripts
 */

export type SearchStrategy = "exact" | "fuzzy" | "partial";

/**
 * Search strategy thresholds
 * 
 * RATIONALE:
 * - FUZZY_THRESHOLD = 3: If exact search returns <3 results, it's likely a failure or near-failure.
 *   Fuzzy search helps find matches with typos or variations. 3 is chosen as a balance:
 *   - Too low (2): Would trigger too often when exact search returns 2 valid results
 *   - Too high (4-5): Would miss opportunities when exact search returns 3 results but none are correct
 *   - 3 is a reasonable threshold: if exact returns 0-2 results, fuzzy is likely to help
 * 
 * - PARTIAL_THRESHOLD = 5: If (exact + fuzzy) returns <5 results, it's likely insufficient.
 *   Partial search helps find matches with partial name matches. 5 is chosen to match typical UI display
 *   (top 5 results visible without scrolling). This threshold ensures we have enough results for users
 *   to choose from, while avoiding unnecessary API calls when we already have sufficient results.
 * 
 * These values can be overridden via environment variables:
 * - FUZZY_THRESHOLD: Default 3, can be set via process.env.FUZZY_THRESHOLD
 * - PARTIAL_THRESHOLD: Default 5, can be set via process.env.PARTIAL_THRESHOLD
 * 
 * Future work: Evaluate different threshold values (2, 3, 4, 5 for fuzzy; 3, 4, 5, 6, 10 for partial)
 * to find optimal values based on evaluation data.
 */
export const FUZZY_THRESHOLD = typeof process !== "undefined" && process.env?.FUZZY_THRESHOLD
  ? parseInt(process.env.FUZZY_THRESHOLD, 10)
  : 3; // Try fuzzy if results < 3

export const PARTIAL_THRESHOLD = typeof process !== "undefined" && process.env?.PARTIAL_THRESHOLD
  ? parseInt(process.env.PARTIAL_THRESHOLD, 10)
  : 5; // Try partial if results < 5

export const PROXIMITY_DISTANCE = 3; // Words within 3 positions for proximity search
export const MAX_RETRIES = 3; // Maximum retry attempts for rate limiting
export const INITIAL_RETRY_DELAY = 1000; // Initial delay in milliseconds

/**
 * Escape Lucene special characters in search terms
 * Special chars: + - && || ! ( ) { } [ ] ^ " ~ * ? : \
 * 
 * IMPROVEMENT: Don't escape apostrophes (') and dashes (-) when inside quoted phrases
 * MusicBrainz often stores names with apostrophes/dashes (e.g., "Dancin' Music", "V-Rally"),
 * and escaping them prevents matches. Inside quoted phrases, these are safe.
 * 
 * However, we still escape them for safety in unquoted contexts (partial search).
 */
export function escapeLucene(text: string): string {
  // Escape backslash first (must be first)
  let escaped = text.replace(/\\/g, "\\\\");
  
  // Escape Lucene operators (these are always problematic)
  escaped = escaped
    .replace(/\+/g, "\\+")
    .replace(/&&/g, "\\&&")
    .replace(/\|\|/g, "\\||")
    .replace(/!/g, "\\!")
    .replace(/\(/g, "\\(")
    .replace(/\)/g, "\\)")
    .replace(/{/g, "\\{")
    .replace(/}/g, "\\}")
    .replace(/\[/g, "\\[")
    .replace(/\]/g, "\\]")
    .replace(/\^/g, "\\^")
    .replace(/"/g, '\\"')
    .replace(/~/g, "\\~")
    .replace(/\*/g, "\\*")
    .replace(/\?/g, "\\?")
    .replace(/:/g, "\\:");
  
  // NOTE: We intentionally DON'T escape dashes (-) and apostrophes (')
  // when used in quoted phrases, as MusicBrainz often stores names with these characters.
  // For example: "Dancin' Music", "V-Rally", "Howl's Moving Castle"
  // Inside quoted phrases, these are safe and needed for matching.
  // 
  // If we need to escape them for unquoted contexts (partial search), we can add
  // a parameter to this function to control escaping behavior.
  
  return escaped;
}

/**
 * Build a single query part for a field (title, artist, release)
 * 
 * Strategies:
 * - exact: Quoted phrase (handles spaces, special chars)
 * - fuzzy: Proximity for multi-word, fuzzy operator for single word
 * - partial: Unquoted (allows substring matching, escapes operators)
 */
export function buildQueryPart(
  field: "title" | "artist" | "release",
  value: string,
  strategy: SearchStrategy,
): string {
  if (strategy === "exact") {
    // For exact match in quoted phrases, we can be less aggressive with escaping
    // Only escape truly problematic characters (quotes, backslashes)
    // Apostrophes and dashes are safe inside quotes
    let escaped = value
      .replace(/\\/g, "\\\\")
      .replace(/"/g, '\\"');
    return `${field}:"${escaped}"`;
  } else if (strategy === "fuzzy") {
    // For fuzzy, escape more aggressively but still preserve apostrophes/dashes in quotes
    const escaped = escapeLucene(value);
    // For multi-word, use proximity; for single word, use fuzzy
    const words = value.split(/\s+/);
    if (words.length > 1) {
      return `${field}:"${escaped}"~${PROXIMITY_DISTANCE}`;
    } else {
      return `${field}:${escaped}~`;
    }
  } else {
    // Partial: no quotes, so we need to escape dashes and other operators
    const escaped = escapeLucene(value);
    return `${field}:${escaped}`;
  }
}

/**
 * Single search stage with specified matching strategy
 * Performs a MusicBrainz API search with exponential backoff retry logic
 */
export async function searchStage(
  track: string | undefined,
  artist: string | undefined,
  release: string | undefined,
  strategy: SearchStrategy,
  options?: {
    limit?: number;
    userAgent?: string;
    baseUrl?: string;
  },
): Promise<any[]> {
  const limit = options?.limit ?? 25;
  const userAgent = options?.userAgent ?? "tealtracker/0.0.1 (https://github.com/teal-fm/teal)";
  const baseUrl = options?.baseUrl ?? "https://musicbrainz.org/ws/2";

  const queryParts: string[] = [];

  if (track) {
    queryParts.push(buildQueryPart("title", track, strategy));
  }

  if (artist) {
    queryParts.push(buildQueryPart("artist", artist, strategy));
  }

  if (release) {
    queryParts.push(buildQueryPart("release", release, strategy));
  }

  if (queryParts.length === 0) {
    return [];
  }

  const query = queryParts.join(" AND ");

  // Retry with exponential backoff for rate limiting
  let retries = MAX_RETRIES;
  let delay = INITIAL_RETRY_DELAY;

  while (retries > 0) {
    try {
      const res = await fetch(
        `${baseUrl}/recording?query=${encodeURIComponent(query)}&fmt=json&limit=${limit}`,
        {
          headers: {
            "User-Agent": userAgent,
          },
        },
      );

      // Handle rate limiting (503)
      if (res.status === 503) {
        retries--;
        if (retries > 0) {
          await new Promise((resolve) => setTimeout(resolve, delay));
          delay *= 2; // Exponential backoff
          continue;
        }
        return [];
      }

      if (!res.ok) {
        return [];
      }

      const data = await res.json();
      return data.recordings || [];
    } catch (error) {
      retries--;
      if (retries > 0) {
        await new Promise((resolve) => setTimeout(resolve, delay));
        delay *= 2;
      } else {
        if (error instanceof Error) {
          console.error(`Search stage ${strategy} failed:`, error.message);
        }
        return [];
      }
    }
  }

  return [];
}

