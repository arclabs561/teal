/**
 * Tests for fuzzy matching utilities
 * 
 * These tests validate the edit distance and similarity scoring
 * used to improve MusicBrainz search matching for typos and variations.
 */

import {
  levenshteinDistance,
  similarityRatio,
  normalizeTypos,
  fuzzyMatch,
  fuzzyScore,
} from "../fuzzyMatching";

describe("levenshteinDistance", () => {
  describe("exact matches", () => {
    it("should return 0 for identical strings", () => {
      expect(levenshteinDistance("hello", "hello")).toBe(0);
      expect(levenshteinDistance("Beatles", "Beatles")).toBe(0);
    });

    it("should return 0 for case-insensitive matches", () => {
      expect(levenshteinDistance("HELLO", "hello")).toBe(0);
      expect(levenshteinDistance("Beatles", "BEATLES")).toBe(0);
    });

    it("should return 0 for empty strings", () => {
      expect(levenshteinDistance("", "")).toBe(0);
    });
  });

  describe("single edits", () => {
    it("should return 1 for single character insertion", () => {
      expect(levenshteinDistance("hello", "helloo")).toBe(1);
    });

    it("should return 1 for single character deletion", () => {
      expect(levenshteinDistance("hello", "helo")).toBe(1);
    });

    it("should return 1 for single character substitution", () => {
      expect(levenshteinDistance("hello", "hallo")).toBe(1);
    });
  });

  describe("multiple edits", () => {
    it("should return correct distance for multiple edits", () => {
      expect(levenshteinDistance("kitten", "sitting")).toBe(3);
    });

    it("should return string length when comparing to empty", () => {
      expect(levenshteinDistance("hello", "")).toBe(5);
      expect(levenshteinDistance("", "world")).toBe(5);
    });
  });

  describe("music-specific cases", () => {
    it("should correctly measure Beatles/Beetles typo", () => {
      // beatles vs beetles: "a" -> "e" (1 edit)
      expect(levenshteinDistance("beatles", "beetles")).toBe(1);
    });

    it("should handle AC/DC variations", () => {
      // "acdc" vs "ac/dc": insert "/" (1 edit)
      expect(levenshteinDistance("acdc", "ac/dc")).toBe(1);
    });
  });
});

describe("similarityRatio", () => {
  it("should return 1.0 for identical strings", () => {
    expect(similarityRatio("hello", "hello")).toBe(1.0);
  });

  it("should return 1.0 for empty strings", () => {
    expect(similarityRatio("", "")).toBe(1.0);
  });

  it("should return 0.0 for completely different strings", () => {
    expect(similarityRatio("abc", "xyz")).toBe(0);
  });

  it("should return value between 0 and 1 for partial matches", () => {
    const ratio = similarityRatio("hello", "hallo");
    expect(ratio).toBeGreaterThan(0);
    expect(ratio).toBeLessThan(1);
  });

  it("should return higher ratio for more similar strings", () => {
    const closeRatio = similarityRatio("hello", "hallo"); // 1 edit
    const farRatio = similarityRatio("hello", "world"); // 4 edits
    expect(closeRatio).toBeGreaterThan(farRatio);
  });
});

describe("normalizeTypos", () => {
  it("should correct Beatles typo", () => {
    expect(normalizeTypos("The Beetles")).toBe("the beatles");
  });

  it("should correct AC/DC variations", () => {
    expect(normalizeTypos("ACDC")).toBe("ac/dc");
    expect(normalizeTypos("AC DC")).toBe("ac/dc");
  });

  it("should not change correct spellings", () => {
    expect(normalizeTypos("The Beatles")).toBe("the beatles");
  });

  it("should handle mixed case", () => {
    expect(normalizeTypos("BEETLES")).toBe("beatles");
  });
});

describe("fuzzyMatch", () => {
  describe("exact matches", () => {
    it("should match identical strings", () => {
      expect(fuzzyMatch("Hello World", "Hello World")).toBe(true);
    });

    it("should match case-insensitively", () => {
      expect(fuzzyMatch("HELLO", "hello")).toBe(true);
    });

    it("should match with accent differences", () => {
      expect(fuzzyMatch("Beyoncé", "Beyonce")).toBe(true);
    });
  });

  describe("typo correction", () => {
    it("should match Beatles/Beetles", () => {
      expect(fuzzyMatch("The Beetles", "The Beatles")).toBe(true);
    });

    it("should match AC/DC variations", () => {
      expect(fuzzyMatch("ACDC", "AC/DC")).toBe(true);
    });
  });

  describe("similarity threshold", () => {
    it("should match similar strings above threshold", () => {
      expect(fuzzyMatch("hello", "hallo", 0.7)).toBe(true);
    });

    it("should not match dissimilar strings", () => {
      expect(fuzzyMatch("hello", "world", 0.7)).toBe(false);
    });

    it("should respect custom threshold", () => {
      // "hello" vs "hallo" has ratio 0.8
      expect(fuzzyMatch("hello", "hallo", 0.9)).toBe(false);
      expect(fuzzyMatch("hello", "hallo", 0.7)).toBe(true);
    });
  });
});

describe("fuzzyScore", () => {
  it("should return 1.0 for exact matches", () => {
    expect(fuzzyScore("Hello World", "Hello World")).toBe(1.0);
  });

  it("should return 0.9 for 'starts with' matches", () => {
    expect(fuzzyScore("Hello", "Hello World")).toBe(0.9);
  });

  it("should return 0.8 for 'contains' matches", () => {
    expect(fuzzyScore("World", "Hello World")).toBe(0.8);
  });

  it("should return similarity ratio for partial matches", () => {
    // "hello" vs "hallo": 1 edit out of 5 chars = 0.8 similarity
    const score = fuzzyScore("hello", "hallo");
    expect(score).toBeGreaterThan(0);
    expect(score).toBeLessThanOrEqual(0.8);
  });

  it("should boost score for typo-corrected matches", () => {
    // "Beetles" matches "Beatles" after typo correction
    const score = fuzzyScore("Beetles", "Beatles");
    expect(score).toBeGreaterThanOrEqual(0.85);
  });
});

describe("edge cases", () => {
  it("should handle empty strings", () => {
    expect(fuzzyMatch("", "")).toBe(true);
    expect(fuzzyScore("", "")).toBe(1.0);
  });

  it("should handle very long strings", () => {
    const long1 = "a".repeat(100);
    const long2 = "a".repeat(99) + "b";
    expect(fuzzyMatch(long1, long2, 0.9)).toBe(true);
  });

  it("should handle special characters", () => {
    expect(fuzzyMatch("Rock & Roll", "Rock and Roll")).toBe(false); // Different after normalization
    expect(fuzzyMatch("AC/DC", "ACDC")).toBe(true); // Typo correction
  });
});
