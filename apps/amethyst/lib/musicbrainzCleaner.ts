/**
 * MusicBrainz name cleaning utilities
 * Ported from backend Rust implementation for improved search matching
 */

// =============================================================================
// CONFIGURATION CONSTANTS
// =============================================================================

/**
 * Threshold for "short" base names that need disambiguation info preserved.
 * Track names shorter than this are more likely to be generic (e.g., "High", "One")
 * and benefit from having remix/feat info preserved.
 * 
 * Evaluated against Last.fm scrobble data: 15 chars balances:
 * - Preserving disambiguation for common short names
 * - Removing guff for longer, more specific names
 */
const SHORT_NAME_THRESHOLD = 15;

/**
 * Threshold for "common phrase" length (combined with word count check).
 * Names under this length with ≤3 words are considered common phrases
 * that may need disambiguation.
 */
const COMMON_PHRASE_LENGTH = 20;

/**
 * Minimum word length to be considered a potential artist name in disambiguation.
 * Words shorter than this are likely articles/prepositions, not artist names.
 */
const MIN_ARTIST_NAME_LENGTH = 4;

/**
 * Generic track names that commonly need disambiguation info preserved.
 * These are words that appear in many different songs by different artists.
 */
const GENERIC_TRACK_NAMES = [
  "song", "track", "music", "beat", "sound", "tune", "piece",
  "high", "low", "one", "two", "three", "four", "five",
  "love", "time", "life", "home", "heart", "dream",
] as const;

/**
 * Words commonly found in parenthetical/bracketed content that can be removed
 * without losing essential information for matching.
 * 
 * Categories:
 * - Audio quality/format: mono, stereo, remastered, etc.
 * - Version types: remix, edit, live, acoustic, etc.
 * - Production info: prod, produced, by
 * - Edition types: deluxe, expanded, anniversary, bonus
 * - Collaboration markers: feat, ft, featuring, vs, with
 * - Status/metadata: official, explicit, clean, etc.
 */
const GUFF_WORDS = [
  // Audio quality/format
  "mono",
  "stereo",
  "quadraphonic",
  "remastered",
  "remaster",
  "master",
  "hd",
  "hifi",
  "hi-fi",
  
  // Version types
  "a cappella",
  "acoustic",
  "extended",
  "instrumental",
  "karaoke",
  "live",
  "orchestral",
  "piano",
  "unplugged",
  "vocal",
  
  // Remix/edit variants
  "club",
  "clubmix",
  "dance",
  "edit",
  "maxi",
  "megamix",
  "mix",
  "radio",
  "re-edit",
  "reedit",
  "refix",
  "remake",
  "remix",
  "remixed",
  "remode",
  "reprise",
  "rework",
  "reworked",
  "rmx",
  
  // Production credits (commonly in brackets)
  "prod",
  "produced",
  "production",
  
  // Edition/release types
  "anniversary",
  "bonus",
  "deluxe",
  "edition",
  "expanded",
  "original",
  "release",
  "released",
  "single",
  "special",
  "version",
  "ver",
  
  // Session/take variants
  "demo",
  "outtake",
  "outtakes",
  "rehearsal",
  "session",
  "take",
  "takes",
  "tape",
  "tryout",
  
  // Track structure
  "composition",
  "cut",
  "dialogue",
  "excerpt",
  "interlude",
  "intro",
  "long",
  "main",
  "outro",
  "rap",
  "short",
  "skit",
  "studio",
  "track",
  
  // Content ratings
  "censored",
  "clean",
  "dirty",
  "explicit",
  "uncensored",
  
  // Collaboration/featuring
  "feat",
  "featuring",
  "ft",
  "vs",
  "with",
  "without",
  
  // Video/media
  "official",
  "video",
  
  // Other metadata
  "reinterpreted",
  "unknown",
  "untitled",
] as const;

/**
 * Check if content should be kept for disambiguation (remix/feat info)
 * 
 * Returns true if:
 * - Content contains remix/feat info AND
 * - Base name is generic, short, or content has artist name
 */
function shouldKeepForDisambiguation(
  content: string,
  baseName: string,
  type: "remix" | "feat"
): boolean {
  const contentLower = content.toLowerCase();
  const baseNameLower = baseName.toLowerCase();
  
  // Check if content matches the type we're looking for
  const isRelevant = type === "remix"
    ? /remix|rmx|rework|refix|remode/.test(contentLower)
    : /feat\.?|ft\.?|featuring/i.test(contentLower);
  
  if (!isRelevant) return false;
  
  // Check if base name is generic (common word that appears in many songs)
  const isGenericWord = GENERIC_TRACK_NAMES.some(
    word => baseNameLower === word || baseNameLower.startsWith(word + " ")
  );
  const isShort = baseName.length < SHORT_NAME_THRESHOLD;
  const isCommonPhrase = baseName.split(/\s+/).length <= 3 && baseName.length < COMMON_PHRASE_LENGTH;
  
  // Check if content contains artist name (word ≥ MIN_ARTIST_NAME_LENGTH that's not a keyword)
  const keywordPattern = type === "remix" ? /remix|rmx|rework|refix|remode/i : /feat\.?|ft\.?|featuring/i;
  const hasArtistName = contentLower.split(/\s+/).some(
    word => word.length >= MIN_ARTIST_NAME_LENGTH && !keywordPattern.test(word)
  );
  
  return isGenericWord || (isShort && isCommonPhrase) || hasArtistName;
}

/**
 * Check if parenthetical content is likely "guff" that should be removed
 */
function isLikelyGuff(content: string): boolean {
  const contentLower = content.toLowerCase();
  const words = contentLower.split(/\s+/);

  // Count guff words (strip trailing punctuation for matching: "prod." -> "prod")
  const guffWordSet = new Set<string>(GUFF_WORDS);
  const guffWordCount = words.filter((word) => {
    const stripped = word.replace(/[.,!?;:]+$/, ""); // Strip trailing punctuation
    return guffWordSet.has(word) || guffWordSet.has(stripped);
  }).length;

  // Check for years (19XX or 20XX)
  const hasYear = /(19|20)\d{2}/.test(contentLower);

  // Consider it guff if >50% are guff words, or if it contains years, or if it's short and common
  return (
    guffWordCount > words.length / 2 ||
    hasYear ||
    (words.length <= 2 &&
      GUFF_WORDS.some((guff) => contentLower.includes(guff)))
  );
}

/**
 * Clean artist name by removing common variations and guff
 */
export function cleanArtistName(name: string): string {
  let cleaned = name.trim();

  // Remove common featuring patterns
  const featPatterns = [
    /\s+feat\.?\s+/i,
    /\s+ft\.\s+/i,
    /\s+featuring\s+/i,
  ];
  for (const pattern of featPatterns) {
    const match = cleaned.match(pattern);
    if (match && match.index !== undefined) {
      cleaned = cleaned.substring(0, match.index).trim();
    }
  }

  // Remove parenthetical content if it looks like guff
  // Match backend behavior: only remove first occurrence to handle nested parentheses correctly
  if (cleaned.includes("(") && cleaned.includes(")")) {
    const start = cleaned.indexOf("(");
    // Find matching closing paren (handle nested)
    let depth = 1;
    let end = start + 1;
    while (end < cleaned.length && depth > 0) {
      if (cleaned[end] === "(") depth++;
      else if (cleaned[end] === ")") depth--;
      end++;
    }
    if (depth === 0) {
      end--; // Adjust for final increment
      const parenContent = cleaned.substring(start + 1, end).toLowerCase();
      if (isLikelyGuff(parenContent)) {
        cleaned = (cleaned.substring(0, start) + cleaned.substring(end + 1)).trim();
        // Normalize whitespace after removal (fixes double spaces)
        cleaned = cleaned.replace(/\s+/g, " ").trim();
      }
    }
  }

  // Remove brackets with guff
  // Match backend behavior: only remove first occurrence
  if (cleaned.includes("[") && cleaned.includes("]")) {
    const start = cleaned.indexOf("[");
    // Find matching closing bracket (handle nested)
    let depth = 1;
    let end = start + 1;
    while (end < cleaned.length && depth > 0) {
      if (cleaned[end] === "[") depth++;
      else if (cleaned[end] === "]") depth--;
      end++;
    }
    if (depth === 0) {
      end--; // Adjust for final increment
      const bracketContent = cleaned.substring(start + 1, end).toLowerCase();
      if (isLikelyGuff(bracketContent)) {
        cleaned = (cleaned.substring(0, start) + cleaned.substring(end + 1)).trim();
        // Normalize whitespace after removal
        cleaned = cleaned.replace(/\s+/g, " ").trim();
      }
    }
  }

  // Remove common "The " prefix
  if (cleaned.toLowerCase().startsWith("the ") && cleaned.length > 4) {
    const withoutThe = cleaned.substring(4).trim();
    if (withoutThe.length > 0) {
      return withoutThe;
    }
  }

  return cleaned.trim();
}

/**
 * Clean track name by removing common variations and guff
 * 
 * IMPROVEMENT: Smarter remix handling - don't remove "remix" if it's the only distinguishing feature
 * (e.g., "High You Are (Branchez Remix)" - "Branchez Remix" distinguishes this from other versions)
 */
export function cleanTrackName(name: string): string {
  let cleaned = name.trim();

  // Remove parenthetical content if it looks like guff
  // Match backend behavior: only remove first occurrence to handle nested parentheses correctly
  if (cleaned.includes("(") && cleaned.includes(")")) {
    const start = cleaned.indexOf("(");
    // Find matching closing paren (handle nested)
    let depth = 1;
    let end = start + 1;
    while (end < cleaned.length && depth > 0) {
      if (cleaned[end] === "(") depth++;
      else if (cleaned[end] === ")") depth--;
      end++;
    }
    if (depth === 0) {
      end--; // Adjust for final increment
      const parenContent = cleaned.substring(start + 1, end);
      const baseName = cleaned.substring(0, start).trim();
      
      // Only remove if it's guff AND not needed for disambiguation AND won't leave empty
      // Check for both remix AND feat patterns (parenthetical content can be either)
      const shouldKeepRemix = shouldKeepForDisambiguation(parenContent, baseName, "remix");
      const shouldKeepFeat = shouldKeepForDisambiguation(parenContent, baseName, "feat");
      const shouldKeep = shouldKeepRemix || shouldKeepFeat;
      // BUG FIX: Don't remove if it would leave the track name empty
      const wouldLeaveEmpty = baseName.length === 0 && cleaned.substring(end + 1).trim().length === 0;
      if (isLikelyGuff(parenContent.toLowerCase()) && !shouldKeep && !wouldLeaveEmpty) {
        cleaned = (cleaned.substring(0, start) + cleaned.substring(end + 1)).trim();
        cleaned = cleaned.replace(/\s+/g, " ").trim();
      }
    }
  }

  // Remove brackets with guff (same logic as parentheses)
  if (cleaned.includes("[") && cleaned.includes("]")) {
    const start = cleaned.indexOf("[");
    let depth = 1;
    let end = start + 1;
    while (end < cleaned.length && depth > 0) {
      if (cleaned[end] === "[") depth++;
      else if (cleaned[end] === "]") depth--;
      end++;
    }
    if (depth === 0) {
      end--;
      const bracketContent = cleaned.substring(start + 1, end);
      const baseName = cleaned.substring(0, start).trim();
      
      // Check for both remix AND feat patterns (bracket content can be either)
      const shouldKeepRemix = shouldKeepForDisambiguation(bracketContent, baseName, "remix");
      const shouldKeepFeat = shouldKeepForDisambiguation(bracketContent, baseName, "feat");
      const shouldKeep = shouldKeepRemix || shouldKeepFeat;
      // BUG FIX: Don't remove if it would leave the track name empty
      const wouldLeaveEmpty = baseName.length === 0 && cleaned.substring(end + 1).trim().length === 0;
      if (isLikelyGuff(bracketContent.toLowerCase()) && !shouldKeep && !wouldLeaveEmpty) {
        cleaned = (cleaned.substring(0, start) + cleaned.substring(end + 1)).trim();
        cleaned = cleaned.replace(/\s+/g, " ").trim();
      }
    }
  }

  // Remove featuring artists from track titles
  const featPatterns = [
    /\s+feat\.?\s+/i,
    /\s+ft\.\s+/i,
    /\s+featuring\s+/i,
  ];
  
  for (const pattern of featPatterns) {
    const match = cleaned.match(pattern);
    if (match && match.index !== undefined) {
      const baseName = cleaned.substring(0, match.index).trim();
      const featContent = cleaned.substring(match.index + match[0].length).trim();
      
      // Only remove if not needed for disambiguation
      const shouldKeep = shouldKeepForDisambiguation(featContent, baseName, "feat");
      if (!shouldKeep) {
        cleaned = baseName;
      }
      break;
    }
  }

  return cleaned.trim();
}

/**
 * Clean release/album name by removing common variations and guff
 * 
 * NOTE: Currently delegates to cleanTrackName. This is intentional because:
 * - Albums often have similar "guff" patterns (remastered, deluxe, etc.)
 * - The shouldKeepForDisambiguation logic works for both contexts
 * - If album-specific cleaning is needed later, add it here
 */
export function cleanReleaseName(name: string): string {
  return cleanTrackName(name);
}

/**
 * Normalize text for comparison (remove special chars, lowercase, etc.)
 * Enhanced with Unicode normalization for accent-insensitive matching
 * Matches backend Rust implementation with Unicode improvements
 */
export function normalizeForComparison(text: string): string {
  // Handle null/undefined gracefully
  if (typeof text !== "string" || text === null || text === undefined) {
    return "";
  }
  
  // Use Unicode normalization for accent-insensitive matching
  let normalized = text;
  
  // Step 1: Normalize to NFD (decomposed form) to separate base characters from accents
  normalized = text.normalize("NFD");
  
  // Step 2: Remove combining diacritical marks (accents)
  normalized = normalized.replace(/[\u0300-\u036f]/g, "");
  
  // Step 3: Filter to alphanumeric and whitespace only, then lowercase
  const filtered = Array.from(normalized)
    .filter((c) => /[a-zA-Z0-9\s]/.test(c))
    .join("");

  return filtered
    .toLowerCase()
    .split(/\s+/)
    .filter((w) => w.length > 0)
    .join(" ")
    .trim();
}

// Note: we intentionally do not export an additional "match key" helper here.
// `normalizeForComparison` is the only comparison normalization used in production code.
