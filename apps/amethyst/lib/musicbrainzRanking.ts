/**
 * Client-side result ranking for MusicBrainz search results
 * 
 * Based on research findings:
 * - MusicBrainz uses Lucene scoring but doesn't expose tunable relevance
 * - Client-side rescoring is recommended practice
 * - Exact matches should be prioritized over fuzzy matches
 * - Position and coverage bonuses improve relevance
 * 
 * This file contains an evidence-tuned scorer/ranker.
 * The provenance (what was run and what changed) lives in the eval commit message for this branch.
 */

import type { MusicBrainzRecording } from "./oldStamp";
import { normalizeForComparison } from "./musicbrainzCleaner";
import { fuzzyScore } from "./fuzzyMatching";
import type { SearchStrategy } from "./musicbrainzSearchUtils";

// =============================================================================
// SCORING CONSTANTS
// =============================================================================
// These values were tuned via evaluation; see the eval commit message for provenance.
// Changes should be validated with: pnpm tsx scripts/eval/evaluate.ts --limit 10000

/** Strategy base scores - exact matches get highest priority */
const SCORE_EXACT = 3.0;
const SCORE_FUZZY = 0.8;
const SCORE_PARTIAL = 0.5;

/** Track exact match boost - higher for track-only searches */
const TRACK_EXACT_BOOST_TRACK_ONLY = 2.8;
const TRACK_EXACT_BOOST_WITH_ARTIST = 2.2;

/** Track partial match boosts */
const TRACK_STARTS_WITH_CLEANED = 1.6;
const TRACK_CONTAINS_CLEANED = 1.3;
const TRACK_EXACT_ORIGINAL_FACTOR = 0.8;
const TRACK_STARTS_WITH_ORIGINAL = 1.4;
const TRACK_CONTAINS_ORIGINAL = 1.2;

/** Artist match boosts */
const ARTIST_EXACT = 1.8;
const ARTIST_STARTS_WITH = 1.4;
const ARTIST_CONTAINS = 1.2;
const ARTIST_AND_TRACK_BOTH_MATCH = 1.5;

/** Release match boosts */
const RELEASE_EXACT = 1.5;
const RELEASE_TRACK_ONLY = 1.8; // Higher when no artist for disambiguation
const RELEASE_CONTAINS = 1.2;

/** Disambiguation boosts (parenthetical info matching) */
const DISAMBIGUATION_EXACT = 1.4;
const DISAMBIGUATION_CONTAINS = 1.2;

/** Special case boosts */
const FEATURING_ARTIST_MATCH = 1.4;
const LIVE_VERSION_MATCH = 1.3;

export interface RankingQuery {
  track?: string;
  artist?: string;
  release?: string;
  cleanedTrack?: string;
  cleanedArtist?: string;
  cleanedRelease?: string;
}

// Re-export SearchStrategy from searchUtils to avoid duplication
export type { SearchStrategy } from "./musicbrainzSearchUtils";

interface RankedResult {
  result: MusicBrainzRecording;
  score: number;
}

/**
 * Score a single search result based on query and search strategy
 * 
 * Scoring factors (tuned via evaluation):
 * 1. Strategy base score: exact (3.0x), fuzzy (0.8x), partial (0.5x)
 * 2. Track match bonuses: exact (2.2-2.8x), starts-with (1.4-1.6x), contains (1.2-1.3x)
 * 3. Artist match bonuses: exact (1.8x), starts-with (1.4x), contains (1.2x)
 * 4. Coverage bonus: both track+artist match (1.5x)
 * 5. Special bonuses: featuring artist (1.4x), live version (1.3x)
 */
export function scoreResult(
  result: MusicBrainzRecording,
  query: RankingQuery,
  searchStrategy: SearchStrategy
): number {
  let score = 1.0;

  // Extract result fields first (needed for fuzzy matching below)
  const resultTitle = result.title || "";
  const resultArtist = result["artist-credit"]?.[0]?.name || "";
  const resultRelease = result.releases?.[0]?.title || "";

  // Strategy-based base score
  // Larger gap between exact and fuzzy/partial prevents noise from pushing exact results down
  if (searchStrategy === "exact") {
    score *= SCORE_EXACT;
  } else if (searchStrategy === "fuzzy") {
    score *= SCORE_FUZZY;
    // Apply fuzzy matching boost for fuzzy strategy
    if (query.track || query.cleanedTrack) {
      const trackQuery = query.cleanedTrack || query.track!;
      const fuzzyTrackScore = fuzzyScore(trackQuery, resultTitle);
      score *= (0.5 + fuzzyTrackScore * 0.5); // Blend base score with fuzzy score
    }
    if (query.artist || query.cleanedArtist) {
      const artistQuery = query.cleanedArtist || query.artist!;
      const fuzzyArtistScore = fuzzyScore(artistQuery, resultArtist);
      score *= (0.5 + fuzzyArtistScore * 0.5); // Blend base score with fuzzy score
    }
  } else {
    score *= SCORE_PARTIAL;
  }

  // Normalize for accent-insensitive comparison
  const resultTitleNorm = normalizeForComparison(resultTitle);
  const resultArtistNorm = normalizeForComparison(resultArtist);
  const resultReleaseNorm = normalizeForComparison(resultRelease);

  // Track name matching (accent-insensitive)
  // Higher boost for track-only searches since we have less context for disambiguation
  const isTrackOnly = !query.artist && !query.cleanedArtist;
  const trackExactBoost = isTrackOnly ? TRACK_EXACT_BOOST_TRACK_ONLY : TRACK_EXACT_BOOST_WITH_ARTIST;
  
  if (query.cleanedTrack) {
    const cleanedTrackNorm = normalizeForComparison(query.cleanedTrack);
    if (resultTitleNorm === cleanedTrackNorm) {
      score *= trackExactBoost;
    } else if (resultTitleNorm.startsWith(cleanedTrackNorm)) {
      score *= TRACK_STARTS_WITH_CLEANED;
    } else if (resultTitleNorm.includes(cleanedTrackNorm)) {
      score *= TRACK_CONTAINS_CLEANED;
    }
  } else if (query.track) {
    const trackNorm = normalizeForComparison(query.track);
    if (resultTitleNorm === trackNorm) {
      score *= (trackExactBoost * TRACK_EXACT_ORIGINAL_FACTOR);
    } else if (resultTitleNorm.startsWith(trackNorm)) {
      score *= TRACK_STARTS_WITH_ORIGINAL;
    } else if (resultTitleNorm.includes(trackNorm)) {
      score *= TRACK_CONTAINS_ORIGINAL;
    }
  }

  // Artist name matching (accent-insensitive)
  if (query.cleanedArtist) {
    const cleanedArtistNorm = normalizeForComparison(query.cleanedArtist);
    if (resultArtistNorm === cleanedArtistNorm) {
      score *= ARTIST_EXACT;
    } else if (resultArtistNorm.startsWith(cleanedArtistNorm)) {
      score *= ARTIST_STARTS_WITH;
    } else if (resultArtistNorm.includes(cleanedArtistNorm)) {
      score *= ARTIST_CONTAINS;
    }
  } else if (query.artist) {
    const artistNorm = normalizeForComparison(query.artist);
    if (resultArtistNorm === artistNorm) {
      score *= ARTIST_CONTAINS; // Original artist - lower boost
    } else if (resultArtistNorm.startsWith(artistNorm)) {
      score *= TRACK_CONTAINS_ORIGINAL;
    } else if (resultArtistNorm.includes(artistNorm)) {
      score *= 1.1;
    }
  }

  // Release name matching (bonus, not critical) - accent-insensitive
  // Higher boost for track-only searches where release helps disambiguation
  const releaseBoost = isTrackOnly ? RELEASE_TRACK_ONLY : RELEASE_CONTAINS;
  
  if (query.cleanedRelease && resultRelease) {
    const cleanedReleaseNorm = normalizeForComparison(query.cleanedRelease);
    const resultReleaseNorm = normalizeForComparison(resultRelease);
    if (resultReleaseNorm === cleanedReleaseNorm) {
      score *= releaseBoost;
    } else if (resultReleaseNorm.includes(cleanedReleaseNorm)) {
      score *= (releaseBoost * 0.9);
    }
  } else if (query.release && resultRelease) {
    const releaseNorm = normalizeForComparison(query.release);
    const resultReleaseNorm = normalizeForComparison(resultRelease);
    if (resultReleaseNorm === releaseNorm) {
      score *= (releaseBoost * 0.9);
    } else if (resultReleaseNorm.includes(releaseNorm)) {
      score *= (releaseBoost * 0.8);
    }
  }

  // Coverage bonus: all query terms match (accent-insensitive)
  let matchedFields = 0;
  let totalFields = 0;
  let trackMatched = false;
  let artistMatched = false;
  
  if (query.track || query.cleanedTrack) {
    totalFields++;
    if (resultTitle && (query.cleanedTrack || query.track)) {
      const searchTerm = normalizeForComparison(query.cleanedTrack || query.track!);
      if (resultTitleNorm.includes(searchTerm)) {
        matchedFields++;
        trackMatched = true;
      }
    }
  }
  
  if (query.artist || query.cleanedArtist) {
    totalFields++;
    if (resultArtist && (query.cleanedArtist || query.artist)) {
      const searchTerm = normalizeForComparison(query.cleanedArtist || query.artist!);
      if (resultArtistNorm.includes(searchTerm)) {
        matchedFields++;
        artistMatched = true;
      }
    }
  }
  
  // Strong bonus when both track AND artist match (most important fields)
  if (trackMatched && artistMatched && totalFields >= 2) {
    score *= ARTIST_AND_TRACK_BOTH_MATCH;
  } else if (totalFields > 0 && matchedFields === totalFields) {
    score *= TRACK_CONTAINS_CLEANED; // All fields match
  }

  // Featuring artist bonus (Priority 5 improvement)
  // Boost results where track title contains featuring artist information that matches the query
  // This helps rank "Song feat. Artist" above "Song" when user searches for "Song feat. Artist"
  // IMPROVEMENT: Check original track first (cleaning might have removed featuring info)
  // If original has featuring, use it; otherwise fall back to cleaned
  const originalTrack = query.track || "";
  const cleanedTrack = query.cleanedTrack || "";
  const queryTrackForFeat = originalTrack || cleanedTrack;
  const queryTrackLower = queryTrackForFeat.toLowerCase();
  const resultTitleLower = resultTitle.toLowerCase();
  
  // Extract featuring artist from query track if present
  // IMPROVEMENT: Also check parentheses for featuring info (e.g., "Song (feat. Artist)")
  const featPatterns = [/\s+feat\.?\s+/i, /\s+ft\.\s+/i, /\s+featuring\s+/i];
  let queryFeatArtist: string | null = null;
  
  // First, try extracting from parentheses (common format: "Song (feat. Artist)")
  if (queryTrackForFeat.includes("(") && queryTrackForFeat.includes(")")) {
    const parenMatch = queryTrackForFeat.match(/\(([^)]+)\)/);
    if (parenMatch && parenMatch[1]) {
      const parenContent = parenMatch[1].toLowerCase();
      // Check if parenthetical contains featuring info
      for (const pattern of featPatterns) {
        const match = parenContent.match(pattern);
        if (match && match.index !== undefined) {
          const featContent = parenContent.substring(match.index + match[0].length).trim();
          const featWords = featContent.split(/\s+/).filter(w => w.length > 2);
          if (featWords.length > 0) {
            queryFeatArtist = featWords.slice(0, Math.min(3, featWords.length)).join(" ").toLowerCase();
            break;
          }
        }
      }
    }
  }
  
  // Also check brackets (common format: "Song [feat. Artist]")
  if (!queryFeatArtist && queryTrackForFeat.includes("[") && queryTrackForFeat.includes("]")) {
    const bracketMatch = queryTrackForFeat.match(/\[([^\]]+)\]/);
    if (bracketMatch && bracketMatch[1]) {
      const bracketContent = bracketMatch[1].toLowerCase();
      // Check if bracket content contains featuring info
      for (const pattern of featPatterns) {
        const match = bracketContent.match(pattern);
        if (match && match.index !== undefined) {
          const featContent = bracketContent.substring(match.index + match[0].length).trim();
          const featWords = featContent.split(/\s+/).filter(w => w.length > 2);
          if (featWords.length > 0) {
            queryFeatArtist = featWords.slice(0, Math.min(3, featWords.length)).join(" ").toLowerCase();
            break;
          }
        }
      }
    }
  }
  
  // If not found in parentheses, try regular patterns (e.g., "Song feat. Artist")
  if (!queryFeatArtist) {
    for (const pattern of featPatterns) {
      const match = queryTrackLower.match(pattern);
      if (match && match.index !== undefined) {
        const featContent = queryTrackLower.substring(match.index + match[0].length).trim();
        // Extract first meaningful word/phrase (artist name)
        const featWords = featContent.split(/\s+/).filter(w => w.length > 2);
        if (featWords.length > 0) {
          // Take first 1-3 words as artist name (handles "feat. Artist Name" or "feat. Artist")
          queryFeatArtist = featWords.slice(0, Math.min(3, featWords.length)).join(" ").toLowerCase();
          break;
        }
      }
    }
  }
  
  // Check if result title also contains featuring artist
  if (queryFeatArtist) {
    // Normalize for accent-insensitive matching (handles "Beyoncé" vs "Beyonce")
    const queryFeatArtistNorm = normalizeForComparison(queryFeatArtist);
    
    // Check if result title contains the same featuring artist
    // IMPROVEMENT: Also check parentheses for featuring info in result title
    let resultFeatArtist: string | null = null;
    
    // First, try extracting from parentheses (common format: "Song (feat. Artist)")
    if (resultTitle.includes("(") && resultTitle.includes(")")) {
      const parenMatch = resultTitle.match(/\(([^)]+)\)/);
      if (parenMatch && parenMatch[1]) {
        const parenContent = parenMatch[1].toLowerCase();
        const resultFeatPatterns = [/\s+feat\.?\s+/i, /\s+ft\.\s+/i, /\s+featuring\s+/i];
        for (const pattern of resultFeatPatterns) {
          const match = parenContent.match(pattern);
          if (match && match.index !== undefined) {
            const featContent = parenContent.substring(match.index + match[0].length).trim();
            const featWords = featContent.split(/\s+/).filter(w => w.length > 2);
            if (featWords.length > 0) {
              resultFeatArtist = featWords.slice(0, Math.min(3, featWords.length)).join(" ").toLowerCase();
              break;
            }
          }
        }
      }
    }
    
    // Also check brackets (common format: "Song [feat. Artist]")
    if (!resultFeatArtist && resultTitle.includes("[") && resultTitle.includes("]")) {
      const bracketMatch = resultTitle.match(/\[([^\]]+)\]/);
      if (bracketMatch && bracketMatch[1]) {
        const bracketContent = bracketMatch[1].toLowerCase();
        const resultFeatPatterns = [/\s+feat\.?\s+/i, /\s+ft\.\s+/i, /\s+featuring\s+/i];
        for (const pattern of resultFeatPatterns) {
          const match = bracketContent.match(pattern);
          if (match && match.index !== undefined) {
            const featContent = bracketContent.substring(match.index + match[0].length).trim();
            const featWords = featContent.split(/\s+/).filter(w => w.length > 2);
            if (featWords.length > 0) {
              resultFeatArtist = featWords.slice(0, Math.min(3, featWords.length)).join(" ").toLowerCase();
              break;
            }
          }
        }
      }
    }
    
    // If not found in parentheses, try regular patterns (e.g., "Song feat. Artist")
    if (!resultFeatArtist) {
      const resultFeatPatterns = [/\s+feat\.?\s+/i, /\s+ft\.\s+/i, /\s+featuring\s+/i];
      for (const pattern of resultFeatPatterns) {
        const resultMatch = resultTitleLower.match(pattern);
        if (resultMatch && resultMatch.index !== undefined) {
          const resultFeatContent = resultTitleLower.substring(resultMatch.index + resultMatch[0].length).trim();
          const resultFeatWords = resultFeatContent.split(/\s+/).filter(w => w.length > 2);
          if (resultFeatWords.length > 0) {
            resultFeatArtist = resultFeatWords.slice(0, Math.min(3, resultFeatWords.length)).join(" ").toLowerCase();
            break;
          }
        }
      }
    }
    
    // Check if featuring artists match (accent-insensitive, fuzzy: contains or is contained)
    if (resultFeatArtist) {
      const resultFeatArtistNorm = normalizeForComparison(resultFeatArtist);
      if (resultFeatArtistNorm.includes(queryFeatArtistNorm) || queryFeatArtistNorm.includes(resultFeatArtistNorm)) {
        score *= FEATURING_ARTIST_MATCH;
      }
    }
  }
  
  // Live/variant version bonus
  // Boost results where track title contains variant keyword when query does too
  const queryTrackForVariants = (query.track || query.cleanedTrack || "").toLowerCase();
  const variantKeywords = ["live", "acoustic", "remix", "remaster"];
  for (const keyword of variantKeywords) {
    if (queryTrackForVariants.includes(keyword) && resultTitleLower.includes(keyword)) {
      score *= LIVE_VERSION_MATCH;
      break;
    }
  }

  // Disambiguation comment bonus (Priority 3 improvement)
  // MusicBrainz disambiguation comments help distinguish identically named entities
  // Boost results where disambiguation matches query keywords (e.g., "Song (Live)" query + "live version" disambiguation)
  // Note: Disambiguation may not be available in basic search results (requires detailed includes)
  // This is fine - the code handles it gracefully when not present
  if (result.disambiguation && typeof result.disambiguation === "string" && result.disambiguation.trim().length > 0) {
    const disambiguationLower = result.disambiguation.toLowerCase();
    const queryLower = ((query.track || "") + " " + (query.artist || "") + " " + (query.release || "")).toLowerCase();
    
    // Check if query contains variant keywords that match disambiguation
    const variantKeywords = ["live", "acoustic", "remix", "remaster", "version", "edit", "extended", "demo", "dub"];
    let matchedKeyword: string | null = null;
    
    for (const keyword of variantKeywords) {
      if (queryLower.includes(keyword) && disambiguationLower.includes(keyword)) {
        matchedKeyword = keyword;
        break;
      }
    }
    
    if (matchedKeyword) {
      // Strong boost when query and disambiguation both contain the same variant keyword
      score *= RELEASE_EXACT; // Reuse release exact boost for variant match
    } else if (disambiguationLower.includes("live") || 
               disambiguationLower.includes("acoustic") ||
               disambiguationLower.includes("remix") ||
               disambiguationLower.includes("remaster")) {
      // Slight boost for having disambiguation with variant indicators
      score *= 1.05;
    }
  }

  return score;
}

/**
 * Rank and sort search results by relevance
 * 
 * @param results - Search results from MusicBrainz API
 * @param query - Original query with cleaned names
 * @param searchStrategy - Strategy used to find these results
 * @returns Sorted results (highest score first)
 */
export function rankResults(
  results: MusicBrainzRecording[],
  query: RankingQuery,
  searchStrategy: SearchStrategy
): MusicBrainzRecording[] {
  // Score all results
  const ranked: RankedResult[] = results.map((result) => ({
    result,
    score: scoreResult(result, query, searchStrategy),
  }));

  // Sort by score (descending), then by original order for tie-breaking
  ranked.sort((a, b) => {
    if (Math.abs(a.score - b.score) > 0.01) {
      return b.score - a.score; // Higher score first
    }
    // Tie-breaking: maintain original order (stable sort)
    return 0;
  });

  return ranked.map((r) => r.result);
}

/**
 * Rank results from multiple search stages
 * 
 * When results come from multiple stages (exact + fuzzy + partial),
 * we need to rank them together while preserving stage information.
 * 
 * @param stageResults - Results grouped by stage
 * @param query - Original query with cleaned names
 * @returns Combined and ranked results
 */
export function rankMultiStageResults(
  stageResults: Array<{
    results: MusicBrainzRecording[];
    strategy: SearchStrategy;
  }>,
  query: RankingQuery
): MusicBrainzRecording[] {
  // Score all results with their respective strategies
  const allRanked: RankedResult[] = [];
  const seenIds = new Set<string>();

  for (const { results, strategy } of stageResults) {
    for (const result of results) {
      // Filter out results with undefined/null IDs (defensive - should not happen)
      if (result.id && !seenIds.has(result.id)) {
        seenIds.add(result.id);
        allRanked.push({
          result,
          score: scoreResult(result, query, strategy),
        });
      }
    }
  }

  // Sort by score (descending)
  allRanked.sort((a, b) => b.score - a.score);

  return allRanked.map((r) => r.result);
}

