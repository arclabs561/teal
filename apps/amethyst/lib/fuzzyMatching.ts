/**
 * Enhanced fuzzy matching utilities for MusicBrainz search
 * 
 * Improves on basic Lucene fuzzy search with:
 * - Edit distance (Levenshtein) calculation for typos
 * - Common typo patterns (e.g., "Beatles" vs "Beetles")
 * - Better handling of abbreviations and variations
 */

import { normalizeForComparison } from "./musicbrainzCleaner";

/**
 * Calculate Levenshtein edit distance between two strings
 * Returns the minimum number of single-character edits needed
 */
export function levenshteinDistance(str1: string, str2: string): number {
  const s1 = str1.toLowerCase();
  const s2 = str2.toLowerCase();
  
  const len1 = s1.length;
  const len2 = s2.length;
  
  // Create matrix
  const matrix: number[][] = Array(len1 + 1)
    .fill(null)
    .map(() => Array(len2 + 1).fill(0));
  
  // Initialize first row and column
  for (let i = 0; i <= len1; i++) matrix[i][0] = i;
  for (let j = 0; j <= len2; j++) matrix[0][j] = j;
  
  // Fill matrix
  for (let i = 1; i <= len1; i++) {
    for (let j = 1; j <= len2; j++) {
      const cost = s1[i - 1] === s2[j - 1] ? 0 : 1;
      matrix[i][j] = Math.min(
        matrix[i - 1][j] + 1,      // deletion
        matrix[i][j - 1] + 1,      // insertion
        matrix[i - 1][j - 1] + cost // substitution
      );
    }
  }
  
  return matrix[len1][len2];
}

/**
 * Calculate similarity ratio (0-1) based on edit distance
 * 1.0 = identical, 0.0 = completely different
 */
export function similarityRatio(str1: string, str2: string): number {
  const maxLen = Math.max(str1.length, str2.length);
  if (maxLen === 0) return 1.0;
  
  const distance = levenshteinDistance(str1, str2);
  return 1 - distance / maxLen;
}

/**
 * Common typo patterns for music names
 * Maps common misspellings to correct forms
 * 
 * NOTE: Keep this minimal - only include unambiguous typos
 * where the typo is clearly wrong (not context-dependent)
 */
const COMMON_TYPOS: Record<string, string> = {
  "beetles": "beatles",
  "beetle": "beatle",
  "acdc": "ac/dc",
  "ac dc": "ac/dc",
};

/**
 * Normalize common typos before comparison
 * Note: normalizeForComparison already lowercases, so we use it directly
 */
export function normalizeTypos(text: string): string {
  const normalized = normalizeForComparison(text);
  
  // Check for common typos
  for (const [typo, correct] of Object.entries(COMMON_TYPOS)) {
    if (normalized.includes(typo) && !normalized.includes(correct)) {
      // Replace typo with correct form
      return normalized.replace(new RegExp(typo, "g"), correct);
    }
  }
  
  return normalized;
}

/**
 * Enhanced fuzzy match check with typo normalization
 */
export function fuzzyMatch(
  query: string,
  candidate: string,
  threshold: number = 0.75
): boolean {
  // First try normalized comparison
  const queryNorm = normalizeForComparison(query);
  const candidateNorm = normalizeForComparison(candidate);
  
  if (queryNorm === candidateNorm) return true;
  
  // Try with typo normalization
  const queryTypoNorm = normalizeTypos(query);
  const candidateTypoNorm = normalizeTypos(candidate);
  
  if (queryTypoNorm === candidateTypoNorm) return true;
  
  // Check similarity ratio
  const ratio = similarityRatio(queryNorm, candidateNorm);
  if (ratio >= threshold) return true;
  
  // Check with typo normalization
  const typoRatio = similarityRatio(queryTypoNorm, candidateTypoNorm);
  return typoRatio >= threshold;
}

/**
 * Score a candidate match based on fuzzy similarity
 * Returns score 0-1, where 1.0 is perfect match
 */
export function fuzzyScore(query: string, candidate: string): number {
  const queryNorm = normalizeForComparison(query);
  const candidateNorm = normalizeForComparison(candidate);
  
  // Exact match
  if (queryNorm === candidateNorm) return 1.0;
  
  // Starts with query
  if (candidateNorm.startsWith(queryNorm)) {
    return 0.9;
  }
  
  // Contains query
  if (candidateNorm.includes(queryNorm)) {
    return 0.8;
  }
  
  // Similarity ratio
  const ratio = similarityRatio(queryNorm, candidateNorm);
  
  // Boost if typo-normalized versions match
  const queryTypoNorm = normalizeTypos(query);
  const candidateTypoNorm = normalizeTypos(candidate);
  if (queryTypoNorm === candidateTypoNorm) {
    return Math.max(ratio, 0.85);
  }
  
  return ratio;
}

