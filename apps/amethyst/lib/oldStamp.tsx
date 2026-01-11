import { Record as PlayRecord } from "@teal/lexicons/src/types/fm/teal/alpha/feed/play";
import {
  cleanArtistName,
  cleanTrackName,
  cleanReleaseName,
  normalizeForComparison,
} from "./musicbrainzCleaner";
import {
  searchStage,
  PARTIAL_THRESHOLD,
} from "./musicbrainzSearchUtils";
import {
  rankMultiStageResults,
  type RankingQuery,
} from "./musicbrainzRanking";

// MusicBrainz API Types
export interface MusicBrainzArtistCredit {
  artist: {
    id: string;
    name: string;
    "sort-name"?: string;
  };
  joinphrase?: string;
  name: string;
}

export interface MusicBrainzRelease {
  id: string;
  title: string;
  status?: string;
  date?: string;
  country?: string;
  disambiguation?: string;
  "track-count"?: number;
}

export interface MusicBrainzRecording {
  id: string;
  title: string;
  length?: number;
  isrcs?: string[];
  disambiguation?: string; // Disambiguation comment (e.g., "Live at Wembley", "US pop singer, 1958-2009")
  "artist-credit"?: MusicBrainzArtistCredit[];
  releases?: MusicBrainzRelease[];
  selectedRelease?: MusicBrainzRelease; // Added for UI state
}

export interface SearchParams {
  track?: string;
  artist?: string;
  release?: string;
}

export interface SearchResultProps {
  result: MusicBrainzRecording;
  onSelectTrack: (track: MusicBrainzRecording | null) => void;
  isSelected: boolean;
  selectedRelease: MusicBrainzRelease | null;
  onReleaseSelect: (trackId: string, release: MusicBrainzRelease) => void;
}

export interface ReleaseSelections {
  [key: string]: MusicBrainzRelease;
}

export interface PlaySubmittedData {
  playRecord: PlayRecord | null;
  playAtUrl: string | null;
  blueskyPostUrl: string | null;
}

/**
 * Check if exact search results are "good enough" to skip multi-stage search
 * 
 * Rationale (based on evaluation; see the eval commit message for provenance):
 * - For track+artist queries: any exact result is reliable (artist provides context)
 * - For track-only queries: need >= 2 results OR first result must match well
 *   (single results could be false positives without artist context)
 * 
 * This conservative approach prevents regressions in "easy" cases where
 * exact search already finds the right result.
 */
function checkIfExactResultsAreSufficient(
  exactResults: MusicBrainzRecording[],
  cleanedTrack: string | undefined,
  cleanedArtist: string | undefined
): boolean {
  if (exactResults.length === 0) return false;
  
  // Track+Artist: any exact match is reliable
  if (cleanedArtist && exactResults.length >= 1) {
    return true;
  }
  
  // Track-only: need >= 2 results OR first result must match track name very well
  if (!cleanedArtist) {
    if (exactResults.length >= 2) return true;
    
    // Check if first result matches track name well
    const firstResult = exactResults[0];
    if (firstResult?.title && cleanedTrack) {
      const resultTitle = normalizeForComparison(firstResult.title);
      const trackNorm = normalizeForComparison(cleanedTrack);
      // Exact match or starts with the track name
      return resultTitle === trackNorm || resultTitle.startsWith(trackNorm + " ");
    }
  }
  
  return false;
}

/** Fallback strategy configuration */
interface FallbackStrategy {
  name: string;
  track: string | undefined;
  artist: string | undefined;
  release: string | undefined;
  strategy: "exact" | "fuzzy";
  condition?: () => boolean;
}

/**
 * Run fallback strategies when primary search stages fail
 * Strategies are tried in order until PARTIAL_THRESHOLD results are found
 */
async function runFallbackStrategies(
  searchParams: SearchParams,
  cleanedTrack: string | undefined,
  cleanedArtist: string | undefined
): Promise<MusicBrainzRecording[]> {
  const results: MusicBrainzRecording[] = [];
  
  const hasCleaned = Boolean(
    (cleanedTrack !== searchParams.track && searchParams.track) ||
    (cleanedArtist !== searchParams.artist && searchParams.artist)
  );
  const hasLiveIndicator = (searchParams.track || "").toLowerCase().includes("live");
  
  // Define strategies in priority order
  const strategies: FallbackStrategy[] = [
    // 1. Original (uncleaned) exact - if cleaning changed something
    {
      name: "original-exact",
      track: searchParams.track,
      artist: searchParams.artist,
      release: searchParams.release,
      strategy: "exact",
      condition: () => hasCleaned,
    },
    // 2. Original fuzzy - helps with special chars, Unicode
    {
      name: "original-fuzzy",
      track: searchParams.track,
      artist: searchParams.artist,
      release: searchParams.release,
      strategy: "fuzzy",
    },
    // 3. Track-only - when artist name doesn't match
    {
      name: "track-only",
      track: searchParams.track,
      artist: undefined,
      release: searchParams.release,
      strategy: "exact",
      condition: () => !!(searchParams.track && searchParams.artist),
    },
    // 4. Artist-only - find artist's catalog
    {
      name: "artist-only",
      track: undefined,
      artist: searchParams.artist,
      release: searchParams.release,
      strategy: "exact",
      condition: () => !!(searchParams.track && searchParams.artist),
    },
  ];
  
  // Add live variations if query contains "live"
  if (hasLiveIndicator && searchParams.track) {
    const liveVariations = [
      searchParams.track.replace(/\s*\(live\)\s*/i, " (live)"),
      searchParams.track.replace(/\s*\(live\)\s*/i, " live"),
      searchParams.track.replace(/\s*\(live\)\s*/i, " - live"),
    ];
    for (const liveTrack of liveVariations) {
      strategies.push({
        name: "live-variation",
        track: liveTrack,
        artist: searchParams.artist,
        release: searchParams.release,
        strategy: "exact",
      });
    }
  }
  
  // Execute strategies until we have enough results
  for (const strat of strategies) {
    if (results.length >= PARTIAL_THRESHOLD) break;
    if (strat.condition && !strat.condition()) continue;
    if (!strat.track && !strat.artist) continue;
    
    const stratResults = await searchStage(
      strat.track,
      strat.artist,
      strat.release,
      strat.strategy,
    ) as MusicBrainzRecording[];
    results.push(...stratResults);
  }
  
  return results;
}

/**
 * Multi-stage MusicBrainz search with improved matching
 * Stage 1: Exact match with cleaned names
 * Stage 2: Fuzzy match (if Stage 1 fails or returns few results)
 * Stage 3: Partial match (if Stage 2 fails)
 */
export async function searchMusicbrainz(
  searchParams: SearchParams,
): Promise<MusicBrainzRecording[]> {
  try {
    // Clean input names using backend logic
    const cleanedTrack = searchParams.track
      ? (cleanTrackName(searchParams.track) || undefined)
      : undefined;
    const cleanedArtist = searchParams.artist
      ? (cleanArtistName(searchParams.artist) || undefined)
      : undefined;
    const cleanedRelease = searchParams.release
      ? (cleanReleaseName(searchParams.release) || undefined)
      : undefined;

    // Stage 1: Exact match with cleaned names
    const exactResults = await searchStage(
      cleanedTrack,
      cleanedArtist,
      cleanedRelease,
      "exact",
    ) as MusicBrainzRecording[];

    // Determine if exact search returned "good enough" results
    // This is critical for preventing regressions in easy cases
    const hasGoodExactResult = checkIfExactResultsAreSufficient(
      exactResults, 
      cleanedTrack, 
      cleanedArtist
    );
    
    // Only use multi-stage if exact search truly failed
    // Conservative approach: prevents noise from degrading already-good results
    const shouldUseMultiStage = exactResults.length === 0 || 
      (!cleanedArtist && exactResults.length === 1 && !hasGoodExactResult);

    // Stage 2: If Stage 1 returns few results, try fuzzy match
    let fuzzyResults: MusicBrainzRecording[] = [];
    if (shouldUseMultiStage && (cleanedTrack || cleanedArtist)) {
      fuzzyResults = await searchStage(
        cleanedTrack,
        cleanedArtist,
        cleanedRelease,
        "fuzzy",
      ) as MusicBrainzRecording[];
    }

    // Stage 3: If still few results, try partial match
    let partialResults: MusicBrainzRecording[] = [];
    const totalSoFar = exactResults.length + fuzzyResults.length;
    if (shouldUseMultiStage && totalSoFar < PARTIAL_THRESHOLD && (cleanedTrack || cleanedArtist)) {
      partialResults = await searchStage(
        cleanedTrack,
        cleanedArtist,
        cleanedRelease,
        "partial",
      ) as MusicBrainzRecording[];
    }

    // IMPROVEMENT: If cleaned names failed, try multiple fallback strategies
    // This helps with cases where cleaning removed important information or exact match is too strict
    // Fallback strategies - only run if multi-stage is enabled and we need more results
    let fallbackResults: MusicBrainzRecording[] = [];
    const totalSoFarAfterPartial = exactResults.length + fuzzyResults.length + partialResults.length;
    
    if (shouldUseMultiStage && totalSoFarAfterPartial < PARTIAL_THRESHOLD) {
      fallbackResults = await runFallbackStrategies(searchParams, cleanedTrack, cleanedArtist);
    }

    // Rank and combine results from all stages (including fallback)
    const stageResults = [
      { results: exactResults, strategy: "exact" as const },
      { results: fuzzyResults, strategy: "fuzzy" as const },
      { results: partialResults, strategy: "partial" as const },
      { results: fallbackResults, strategy: "exact" as const }, // Fallback uses exact strategy
    ].filter((stage) => stage.results.length > 0);

    const rankingQuery: RankingQuery = {
      track: searchParams.track,
      artist: searchParams.artist,
      release: searchParams.release,
      cleanedTrack,
      cleanedArtist,
      cleanedRelease,
    };

    const rankedResults = rankMultiStageResults(stageResults, rankingQuery);

    return rankedResults.slice(0, 25); // Limit to 25 results
  } catch (error) {
    if (error instanceof Error) {
      console.error("Failed to fetch MusicBrainz data:", error.message);
    } else {
      console.error("Failed to fetch MusicBrainz data:", error);
    }
    return [];
  }
}

