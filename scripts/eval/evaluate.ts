#!/usr/bin/env node
/**
 * Evaluate MusicBrainz matching using Last.fm scrobbles
 * 
 * PURPOSE:
 * - Measure if improved matching (cleaning + multi-stage) finds correct MBIDs better than baseline
 * - Addresses original problem: "funny search string" and "song disambiguation is the hardest part"
 * - Tests real-world scenarios: featuring artists, remixes, live versions, typos
 * 
 * METRICS (aligned with use case):
 * 
 * PRIMARY METRICS (user effort & findability):
 * - Precision@1: Is correct track first? (CRITICAL - users can select immediately, no scrolling)
 * - Precision@5: Is correct track in top 5? (Important - visible without much scrolling)
 * - Precision@10: Is correct track in top 10? (Important - covers first screen of results)
 * - Precision@25: Is correct track in top 25? (Findability - can user find it at all?)
 * - Recall/Findability: Can the track be found anywhere in results? (Addresses "song disambiguation")
 * 
 * SECONDARY METRICS (ranking quality):
 * - Mean Reciprocal Rank (MRR): Average of 1/position when found (measures ranking quality)
 * - Position distribution: Where do correct tracks appear? (1st, 2-5, 6-10, 11-25, not found)
 * 
 * ANALYSIS METRICS (understanding failures):
 * - Failure mode analysis: Which types of tracks are hardest? (featuring, remix, live, etc.)
 * - Name length analysis: Do short/long names affect matching?
 * 
 * USE CASE CONTEXT:
 * - Users manually type track/artist names
 * - Results displayed in scrollable FlatList (up to 25 results)
 * - Users scroll and tap to select one track
 * - Challenge: "song disambiguation" - finding the right version when multiple exist
 * - Goal: Minimize user effort (scrolling) while maximizing findability
 * 
 * Usage:
 *   pnpm tsx scripts/eval/evaluate.ts [--limit N] [--all] [--username USER] [--auth-only]
 * 
 * Examples:
 *   # Default: Baseline vs improved comparison
 *   pnpm tsx scripts/eval/evaluate.ts --limit 1000
 * 
 *   # Full history (best effort; will take time on first run)
 *   pnpm tsx scripts/eval/evaluate.ts --all
 * 
 * Options:
 *   --limit N              Number of scrobbles to evaluate (default: 1000)
 *   --all                  Evaluate using all cached scrobbles for the user (full history, best effort)
 *   --username USER        Use public API for username (skips OAuth; may be limited)
 *   --auth-only            Perform OAuth and cache the session key, then exit
 *   --no-cleaning          Disable name cleaning
 *   --no-fuzzy             Disable fuzzy matching
 *   --no-multistage        Disable multi-stage search
 *   --no-parallel          Disable parallel evaluation (parallel enabled by default)
 *   --concurrency N        Parallel concurrency (default: 5)
 *   --refresh-scrobbles    Force refresh cache (re-fetch scrobbles; still accumulates)
 *   --use-additional-apis  Allow extra API calls during evaluation to backfill missing MBIDs (slower)
 * 
 * Caching:
 *   SQLite cache at ~/.teal_eval_cache/lastfm_eval.db accumulates over time
 *   - Scrobbles: Never cleared, accumulates with each run
 *   - MBIDs: Cached per track+artist to avoid re-fetching
 *   - MusicBrainz searches: Cached to speed up evaluation
 *   - Idempotent: Running multiple times just adds more data
 *   - Use --refresh-scrobbles to force re-fetch (but still accumulates)
 * 
 * Notes:
 * - OAuth is the default (no --username): it’s the only way to fetch full history from Last.fm reliably.
 * - Evaluation artifacts (JSON/CSV) are written under scripts/eval/results/archive and ignored by git.
 */

import { readFileSync, writeFileSync, existsSync, mkdirSync } from "fs";
import { join } from "path";
import { homedir } from "os";
import { config } from "dotenv";
import {
  cleanArtistName,
  cleanTrackName,
  cleanReleaseName,
  normalizeForComparison,
} from "../../apps/amethyst/lib/musicbrainzCleaner";
import {
  escapeLucene,
  buildQueryPart,
  searchStage,
  type SearchStrategy,
} from "../../apps/amethyst/lib/musicbrainzSearchUtils";
import {
  rankMultiStageResults,
  type RankingQuery,
} from "../../apps/amethyst/lib/musicbrainzRanking";
import { LastFMCache } from "./evaluate-lastfm-cache";

// Load .env file explicitly
const envResult = config();
if (envResult.error) {
  console.warn(`Warning: Could not load .env file: ${envResult.error.message}`);
}

const LASTFM_API_KEY = process.env.LASTFM_API_KEY;
const LASTFM_API_SECRET = process.env.LASTFM_API_SECRET;

if (!LASTFM_API_KEY) {
  console.error("Error: LASTFM_API_KEY not found in environment");
  console.error("Make sure .env file exists and contains LASTFM_API_KEY");
  process.exit(1);
}

if (!LASTFM_API_SECRET) {
  console.error("Error: LASTFM_API_SECRET not found in environment");
  console.error("Make sure .env file exists and contains LASTFM_API_SECRET");
  process.exit(1);
}
const MUSICBRAINZ_BASE_URL = "https://musicbrainz.org/ws/2";
const SESSION_KEY_FILE = join(homedir(), ".lastfm_session_key");
const RATE_LIMIT_DELAY = 1000; // 1 second

// Cache structure for scrobbles
interface CachedScrobble {
  track: string;
  artist: string;
  album?: string;
  mbid: string | null;
  timestamp: string; // ISO timestamp from Last.fm
}

interface ScrobbleCache {
  timestamp: string; // When cache was created/updated
  username: string; // Which user's scrobbles
  scrobbles: CachedScrobble[];
}

interface LastFMTrack {
  name: string;
  artist: { "#text": string; mbid?: string };
  album?: { "#text": string };
  mbid?: string;
  "@attr"?: { nowplaying?: string };
  date?: { "#text": string; uts: string };
}

interface LastFMResponse {
  recenttracks: {
    track: LastFMTrack | LastFMTrack[];
    "@attr": { total: string; page: string; perPage: string; totalPages: string };
  };
}

interface SearchResult {
  id: string;
  title: string;
  "artist-credit"?: Array<{
    artist: { id: string; name: string };
  }>;
}

/**
 * Get Last.fm session key via OAuth
 */
async function getLastFMSession(): Promise<string> {
  if (!LASTFM_API_KEY || !LASTFM_API_SECRET) {
    throw new Error("LASTFM_API_KEY and LASTFM_API_SECRET must be set in .env");
  }

  // Try to load existing session key
  if (existsSync(SESSION_KEY_FILE)) {
    const sessionKey = readFileSync(SESSION_KEY_FILE, "utf-8").trim();
    if (sessionKey) {
      // Verify it's still valid by making a test call to user.getInfo
      try {
        const testParams: Record<string, string> = {
          method: "user.getInfo",
          api_key: LASTFM_API_KEY!,
          sk: sessionKey,
          format: "json",
        };
        const testSig = await generateSignature(testParams);
        testParams.api_sig = testSig;
        const testUrl = `https://ws.audioscrobbler.com/2.0/?${new URLSearchParams(testParams).toString()}`;
        const testRes = await fetch(testUrl);
        if (testRes.ok) {
          const data = await testRes.json();
          if (data.user && !data.error) {
            console.log(`Using existing session key (authenticated as: ${data.user.name})`);
            console.log(`(To force re-authentication, delete ${SESSION_KEY_FILE})\n`);
            return sessionKey;
          }
        }
      } catch (e: any) {
        console.log(`Existing session key invalid: ${e.message}`);
        console.log("Starting new OAuth flow...\n");
        // Session invalid, continue to OAuth
      }
    }
  }

  // OAuth flow
  console.log("\n=== Last.fm OAuth Authentication ===");
  console.log("Step 1: Getting authentication token...");

  // Step 1: Get token (no signature needed for getToken)
  const tokenUrl = `https://ws.audioscrobbler.com/2.0/?method=auth.getToken&api_key=${LASTFM_API_KEY}&format=json`;
  console.log(`  Fetching token from Last.fm API...`);
  console.log(`  API Key: ${LASTFM_API_KEY?.substring(0, 8)}...`);
  
  const tokenRes = await fetch(tokenUrl);
  if (!tokenRes.ok) {
    const errorText = await tokenRes.text();
    console.error(`  ✗ API Error: ${tokenRes.status} ${tokenRes.statusText}`);
    console.error(`  ✗ Response: ${errorText}`);
    throw new Error(`Failed to get token: ${tokenRes.statusText} - ${errorText}`);
  }
  
  const tokenData = await tokenRes.json();
  if (tokenData.error) {
    console.error(`  ✗ Last.fm API Error: ${tokenData.error} - ${tokenData.message || ''}`);
    throw new Error(`Last.fm API error: ${tokenData.error} - ${tokenData.message || 'Invalid API key or credentials'}`);
  }
  
  const token = tokenData.token;
  if (!token) {
    throw new Error(`No token received from Last.fm API. Response: ${JSON.stringify(tokenData)}`);
  }
  
  console.log(`  ✓ Got token: ${token.substring(0, 10)}...`);

  // Step 2: User authorizes
  const authUrl = `https://www.last.fm/api/auth?api_key=${LASTFM_API_KEY}&token=${token}`;
  console.log(`\nStep 2: Opening browser for authorization...`);
  console.log(`  URL: ${authUrl}`);
  console.log(`\n  Instructions:`);
  console.log(`  1. A browser window should open automatically`);
  console.log(`  2. Log in to Last.fm if needed`);
  console.log(`  3. Click "Allow access" to authorize this application`);
  console.log(`  4. The script will automatically detect when you've authorized\n`);
  
  // Try to open browser immediately - use spawn instead of exec for better control
  const { spawn } = await import("child_process");
  const platform = process.platform;
  
  let browserOpened = false;
  
  try {
    if (platform === "darwin") {
      const proc = spawn("open", [authUrl], { 
        detached: true,
        stdio: "ignore"
      });
      proc.unref();
      browserOpened = true;
    } else if (platform === "linux") {
      const proc = spawn("xdg-open", [authUrl], {
        detached: true,
        stdio: "ignore"
      });
      proc.unref();
      browserOpened = true;
    } else if (platform === "win32") {
      const proc = spawn("cmd", ["/c", "start", authUrl], {
        detached: true,
        stdio: "ignore"
      });
      proc.unref();
      browserOpened = true;
    } else {
      console.log(`  ⚠ Platform ${platform} not supported for auto-opening browser.`);
      console.log(`  Please manually visit: ${authUrl}\n`);
    }
    
    if (browserOpened) {
      console.log(`  ✓ Browser opened successfully\n`);
    }
  } catch (e: any) {
    console.error(`  ✗ Error opening browser: ${e.message}`);
    console.error(`  Please manually visit: ${authUrl}\n`);
  }
  
  // Give it a moment to open
  if (browserOpened) {
    await new Promise((resolve) => setTimeout(resolve, 1000));
  }
  
  console.log("Step 3: Waiting for authorization...");
  console.log("  (Polling Last.fm API every 2 seconds)");
  console.log("  (You can close this terminal after authorization completes)\n");

  // Step 3: Poll for session
  const maxWait = 300000; // 5 minutes
  const startTime = Date.now();
  const pollInterval = 2000; // 2 seconds
  let pollCount = 0;

  while (Date.now() - startTime < maxWait) {
    pollCount++;
    await new Promise((resolve) => setTimeout(resolve, pollInterval));

    // Get session
    const sig = await generateSignature({
      method: "auth.getSession",
      token,
      api_key: LASTFM_API_KEY,
    });
    const sessionUrl = `https://ws.audioscrobbler.com/2.0/?method=auth.getSession&api_key=${LASTFM_API_KEY}&token=${token}&api_sig=${sig}&format=json`;
    
    if (pollCount % 5 === 0) {
      console.log(`  Poll #${pollCount}: Checking for authorization...`);
    }
    
    try {
      const sessionRes = await fetch(sessionUrl);
      if (sessionRes.ok) {
        const sessionData = await sessionRes.json();
        if (sessionData.session?.key) {
          const sessionKey = sessionData.session.key;
          writeFileSync(SESSION_KEY_FILE, sessionKey);
          console.log(`  ✓ Authorization received! (after ${pollCount} polls)`);
          console.log(`  ✓ Session key saved to ${SESSION_KEY_FILE}\n`);
          return sessionKey;
        } else if (sessionData.error) {
          // Expected error until user authorizes
          if (pollCount === 1) {
            console.log(`  (Waiting for user to authorize in browser...)`);
          }
        }
      } else {
        if (pollCount === 1) {
          console.log(`  API returned ${sessionRes.status}, waiting for authorization...`);
        }
      }
    } catch (e: any) {
      if (pollCount === 1) {
        console.log(`  Error on first poll (expected): ${e.message}`);
      }
    }

    const elapsed = Math.floor((Date.now() - startTime) / 1000);
    if (elapsed > 0 && elapsed % 10 === 0) {
      console.log(`  Still waiting... (${elapsed}s elapsed, ${pollCount} polls)`);
    }
  }

  throw new Error(`OAuth timeout: No authorization received after ${Math.floor(maxWait / 1000)} seconds`);
}

/**
 * Generate Last.fm API signature
 * Signature is MD5 of: sorted parameter keys + values + API secret
 * Note: api_sig should NOT be included in signature calculation
 */
async function generateSignature(params: Record<string, string>): Promise<string> {
  const crypto = await import("crypto");
  // Exclude api_sig and format from signature calculation (per Last.fm API docs)
  const paramsForSig: Record<string, string> = {};
  for (const [key, value] of Object.entries(params)) {
    if (key !== "api_sig" && key !== "format") {
      paramsForSig[key] = value;
    }
  }
  
  const sortedKeys = Object.keys(paramsForSig).sort();
  const sigString = sortedKeys
    .map((key) => `${key}${paramsForSig[key]}`)
    .join("") + LASTFM_API_SECRET!;
  
  return crypto.createHash("md5").update(sigString).digest("hex");
}

/**
 * Get user's recent tracks from Last.fm
 */
async function getRecentTracks(
  username: string,
  limit: number,
  sessionKey?: string,
  page: number = 1
): Promise<LastFMTrack[]> {
  const params: Record<string, string> = {
    method: "user.getRecentTracks",
    api_key: LASTFM_API_KEY!,
    limit: Math.min(limit, 200).toString(), // Last.fm API max is 200 per page
    page: page.toString(),
    format: "json",
  };

  // Add user parameter (required for public API, optional for authenticated)
  if (username) {
    params.user = username;
  }

  // For authenticated calls, add session key and sign
  if (sessionKey) {
    params.sk = sessionKey;
    // Generate signature BEFORE adding api_sig
    const sig = await generateSignature(params);
    params.api_sig = sig;
  }

  const queryString = new URLSearchParams(params).toString();
  const url = `https://ws.audioscrobbler.com/2.0/?${queryString}`;

  // Retry logic for transient errors
  let retries = 3;
  let delay = 1000;
  while (retries > 0) {
    try {
      const res = await fetch(url);
      if (res.ok) {
        const data: LastFMResponse = await res.json();
        if (data.recenttracks?.track) {
          const tracks = data.recenttracks.track;
          return Array.isArray(tracks) ? tracks : [tracks];
        }
        return [];
      }
      
      // Retry on 5xx errors
      if (res.status >= 500 && retries > 1) {
        retries--;
        await new Promise((resolve) => setTimeout(resolve, delay));
        delay *= 2;
        continue;
      }
      
      const errorText = await res.text();
      throw new Error(`Last.fm API error: ${res.statusText} - ${errorText}`);
    } catch (error: any) {
      if (retries > 1 && (error.message?.includes("500") || error.message?.includes("503") || error.message?.includes("Internal Server Error"))) {
        retries--;
        await new Promise((resolve) => setTimeout(resolve, delay));
        delay *= 2;
        continue;
      }
      throw error;
    }
  }
  
  return [];
}

/**
 * Get track MBID via comprehensive MusicBrainz search
 * Since evaluation has no time constraints, we can try multiple search strategies:
 * 1. Exact match with cleaned names (most likely to succeed)
 * 2. Exact match with original names (fallback if cleaning removed important info)
 * 3. Fuzzy match with proximity (for typos/variations)
 * 4. Partial match (word-by-word, less strict)
 * 5. Artist-only search (when track name is too specific or incorrect)
 * Returns the best match found across all strategies
 */
async function getMBIDViaISRC(
  track: string,
  artist: string,
  cache?: LastFMCache
): Promise<string | null> {
  // Clean names for better matching
  const cleanedTrack = cleanTrackName(track);
  const cleanedArtist = cleanArtistName(artist);
  
  // Strategy 1: Exact match with cleaned names (most likely to succeed)
  if (cleanedTrack && cleanedArtist) {
    const exactCleanedQuery = `recording:"${escapeLucene(cleanedTrack)}" AND artist:"${escapeLucene(cleanedArtist)}"`;
    let mbid = await tryMusicBrainzSearch(exactCleanedQuery, cleanedTrack, cleanedArtist);
    if (mbid) return mbid;
  }
  
  // Strategy 2: Exact match with original names (fallback if cleaning removed important info)
  const exactOriginalQuery = `recording:"${escapeLucene(track)}" AND artist:"${escapeLucene(artist)}"`;
  let mbid = await tryMusicBrainzSearch(exactOriginalQuery, track, artist);
  if (mbid) return mbid;
  
  // Strategy 3: Fuzzy match (proximity search for multi-word, fuzzy for single word)
  const trackWords = (cleanedTrack || track).split(" ");
  const artistWords = (cleanedArtist || artist).split(" ");
  const searchTrack = cleanedTrack || track;
  const searchArtist = cleanedArtist || artist;
  
  if (trackWords.length > 1) {
    const fuzzyTrackQuery = `recording:"${escapeLucene(searchTrack)}"~3`;
    const fuzzyArtistQuery = artistWords.length > 1 ? `artist:"${escapeLucene(searchArtist)}"~3` : `artist:${escapeLucene(searchArtist)}~`;
    const fuzzyQuery = `${fuzzyTrackQuery} AND ${fuzzyArtistQuery}`;
    mbid = await tryMusicBrainzSearch(fuzzyQuery, searchTrack, searchArtist);
    if (mbid) return mbid;
  } else {
    const fuzzyQuery = `recording:${escapeLucene(searchTrack)}~ AND artist:${escapeLucene(searchArtist)}~`;
    mbid = await tryMusicBrainzSearch(fuzzyQuery, searchTrack, searchArtist);
    if (mbid) return mbid;
  }
  
  // Strategy 4: Partial match (word-by-word, less strict)
  const partialQuery = `recording:${escapeLucene(searchTrack)} AND artist:${escapeLucene(searchArtist)}`;
  mbid = await tryMusicBrainzSearch(partialQuery, searchTrack, searchArtist);
  if (mbid) return mbid;
  
  // Strategy 5: Try with artist only (sometimes track name is too specific or incorrect)
  const artistOnlyQuery = `artist:"${escapeLucene(searchArtist)}"`;
  mbid = await tryMusicBrainzSearch(artistOnlyQuery, searchTrack, searchArtist, true);
  if (mbid) return mbid;
  
  return null;
}

/**
 * Helper: Try a MusicBrainz search query and return MBID if a good match is found
 * If checkISRC is true, also checks if the recording has ISRCs (higher confidence)
 */
async function tryMusicBrainzSearch(
  query: string,
  originalTrack: string,
  originalArtist: string,
  checkISRC: boolean = false
): Promise<string | null> {
  try {
    await new Promise((resolve) => setTimeout(resolve, RATE_LIMIT_DELAY));
    const searchUrl = `${MUSICBRAINZ_BASE_URL}/recording?query=${encodeURIComponent(query)}&limit=10&fmt=json`;
    
    const res = await fetch(searchUrl, {
      headers: { "User-Agent": "tealtracker/0.0.1 (https://github.com/teal-fm/teal)" },
    });
    
    if (res.ok) {
      const data = await res.json();
      if (data.recordings && data.recordings.length > 0) {
        // Check all results, prefer ones with ISRCs if checkISRC is true
        for (const recording of data.recordings) {
          if (checkISRC) {
            // Get full recording details with ISRCs
            const recordingUrl = `${MUSICBRAINZ_BASE_URL}/recording/${recording.id}?inc=isrcs&fmt=json`;
            await new Promise((resolve) => setTimeout(resolve, RATE_LIMIT_DELAY));
            const recordingRes = await fetch(recordingUrl, {
              headers: { "User-Agent": "tealtracker/0.0.1 (https://github.com/teal-fm/teal)" },
            });
            if (recordingRes.ok) {
              const recordingData = await recordingRes.json();
              if (recordingData.isrcs && recordingData.isrcs.length > 0) {
                return recording.id; // Prefer recordings with ISRCs
              }
            }
          }
          // If no ISRC check needed, or no ISRCs found, return first result
          if (!checkISRC) {
            return recording.id;
          }
        }
        // If checkISRC was true but no ISRCs found, return first result anyway
        return data.recordings[0].id;
      }
    }
  } catch (e) {
    // Ignore errors, try next strategy
  }
  return null;
}


/**
 * Get track correction from Last.fm (canonical name)
 * Returns corrected track and artist names if available
 */
async function getTrackCorrection(
  track: string,
  artist: string,
  sessionKey: string,
  cache?: LastFMCache,
  apiMetrics?: APIMetrics
): Promise<{ track: string; artist: string } | null> {
  // Check cache first (we cache corrections separately)
  if (cache) {
    const cached = cache.getTrackCorrection(track, artist);
    if (cached !== undefined) {
      return cached ? { track: cached.correctedTrack, artist: cached.correctedArtist } : null;
    }
  }

  // Rate limit: Last.fm allows 5 req/sec, but we're conservative
  await new Promise((resolve) => setTimeout(resolve, 200)); // 200ms = 5 req/sec max

  const params: Record<string, string> = {
    method: "track.getCorrection",
    track,
    artist,
    api_key: LASTFM_API_KEY!,
    sk: sessionKey,
    format: "json",
  };

  const sig = await generateSignature(params);
  params.api_sig = sig;

  const queryString = new URLSearchParams(params).toString();
  const url = `https://ws.audioscrobbler.com/2.0/?${queryString}`;

  // Retry logic for transient errors (similar to getRecentTracks)
  let retries = 3;
  let delay = 200;
  while (retries > 0) {
    try {
      const res = await fetch(url);
      if (res.ok) {
        const data = await res.json();
        if (data.corrections?.correction?.track) {
          const corrected = data.corrections.correction.track;
          const correctedTrack = corrected.name || track;
          const correctedArtist = corrected.artist?.name || artist;
          
          // Cache the correction
          if (cache) {
            cache.setTrackCorrection(track, artist, correctedTrack, correctedArtist);
          }
          
          return { track: correctedTrack, artist: correctedArtist };
        }
        // No correction available, break and cache null
        break;
      }
      
      // Retry on 5xx errors
      if (res.status >= 500 && retries > 1) {
        if (apiMetrics) apiMetrics.lastfmErrors++;
        retries--;
        await new Promise((resolve) => setTimeout(resolve, delay));
        delay *= 2;
        continue;
      }
      
      // Non-retryable error, break
      if (apiMetrics && res.status >= 400) {
        apiMetrics.lastfmErrors++;
      }
      break;
    } catch (e) {
      if (apiMetrics) apiMetrics.lastfmErrors++;
      retries--;
      if (retries > 0) {
        await new Promise((resolve) => setTimeout(resolve, delay));
        delay *= 2;
        continue;
      }
      // Last retry failed, break
      break;
    }
  }

  // Cache null correction (no correction available)
  if (cache) {
    cache.setTrackCorrection(track, artist, null, null);
  }
  return null;
}

/**
 * Search for tracks on Last.fm
 * Returns array of matching tracks with MBIDs
 */
async function searchTracksOnLastFM(
  track: string,
  artist: string,
  sessionKey: string,
  limit: number = 10,
  cache?: LastFMCache,
  apiMetrics?: APIMetrics
): Promise<Array<{ track: string; artist: string; mbid: string | null }>> {
  // Check cache for search results (we could cache these too, but track.search is fast)
  // For now, we'll just rate limit and make the call
  
  // Rate limit: Last.fm allows 5 req/sec, but we're conservative
  await new Promise((resolve) => setTimeout(resolve, 200)); // 200ms = 5 req/sec max

  const params: Record<string, string> = {
    method: "track.search",
    track: `${track} ${artist}`, // Combine for better search
    api_key: LASTFM_API_KEY!,
    limit: limit.toString(),
    format: "json",
  };

  // track.search doesn't require authentication, but we can add session key for rate limits
  if (sessionKey) {
    params.sk = sessionKey;
    const sig = await generateSignature(params);
    params.api_sig = sig;
  }

  const queryString = new URLSearchParams(params).toString();
  const url = `https://ws.audioscrobbler.com/2.0/?${queryString}`;

  // Retry logic for transient errors
  let retries = 3;
  let delay = 200;
  while (retries > 0) {
    try {
      const res = await fetch(url);
      if (res.ok) {
        const data = await res.json();
        if (data.results?.trackmatches?.track) {
          const tracks = Array.isArray(data.results.trackmatches.track)
            ? data.results.trackmatches.track
            : [data.results.trackmatches.track];
          
          return tracks.map((t: any) => ({
            track: t.name,
            artist: t.artist,
            mbid: t.mbid || null,
          }));
        }
        // No results, return empty
        return [];
      }
      
      // Retry on 5xx errors
      if (res.status >= 500 && retries > 1) {
        if (apiMetrics) apiMetrics.lastfmErrors++;
        retries--;
        await new Promise((resolve) => setTimeout(resolve, delay));
        delay *= 2;
        continue;
      }
      
      // Non-retryable error, return empty
      if (apiMetrics && res.status >= 400) {
        apiMetrics.lastfmErrors++;
      }
      return [];
    } catch (e) {
      if (apiMetrics) apiMetrics.lastfmErrors++;
      retries--;
      if (retries > 0) {
        await new Promise((resolve) => setTimeout(resolve, delay));
        delay *= 2;
        continue;
      }
      // Last retry failed, return empty
      return [];
    }
  }
  
  return [];
}

/**
 * Get artist info from Last.fm (including MBID and aliases)
 */
async function getArtistInfo(
  artist: string,
  sessionKey: string,
  cache?: LastFMCache,
  apiMetrics?: APIMetrics
): Promise<{ mbid: string | null; aliases: string[] } | null> {
  // Check cache first
  if (cache) {
    const cached = cache.getArtistInfo(artist);
    if (cached !== undefined) {
      return cached;
    }
  }

  // Rate limit: Last.fm allows 5 req/sec, but we're conservative
  await new Promise((resolve) => setTimeout(resolve, 200)); // 200ms = 5 req/sec max

  const params: Record<string, string> = {
    method: "artist.getInfo",
    artist,
    api_key: LASTFM_API_KEY!,
    sk: sessionKey,
    format: "json",
  };

  const sig = await generateSignature(params);
  params.api_sig = sig;

  const queryString = new URLSearchParams(params).toString();
  const url = `https://ws.audioscrobbler.com/2.0/?${queryString}`;

  // Retry logic for transient errors
  let retries = 3;
  let delay = 200;
  while (retries > 0) {
    try {
      const res = await fetch(url);
      if (res.ok) {
        const data = await res.json();
        if (data.artist) {
          const mbid = data.artist.mbid || null;
          const aliases = data.artist.alias
            ? (Array.isArray(data.artist.alias) ? data.artist.alias : [data.artist.alias])
                .map((a: any) => typeof a === 'string' ? a : a['#text'] || a)
            : [];
          
          const result = { mbid, aliases };
          
          // Cache the result
          if (cache) {
            cache.setArtistInfo(artist, result);
          }
          
          return result;
        }
        // No artist data, break and cache null
        break;
      }
      
      // Retry on 5xx errors
      if (res.status >= 500 && retries > 1) {
        if (apiMetrics) apiMetrics.lastfmErrors++;
        retries--;
        await new Promise((resolve) => setTimeout(resolve, delay));
        delay *= 2;
        continue;
      }
      
      // Non-retryable error, break
      if (apiMetrics && res.status >= 400) {
        apiMetrics.lastfmErrors++;
      }
      break;
    } catch (e) {
      if (apiMetrics) apiMetrics.lastfmErrors++;
      retries--;
      if (retries > 0) {
        await new Promise((resolve) => setTimeout(resolve, delay));
        delay *= 2;
        continue;
      }
      // Last retry failed, break
      break;
    }
  }

  // Cache null result
  if (cache) {
    cache.setArtistInfo(artist, null);
  }
  return null;
}

/**
 * Get album info from Last.fm (including MBID)
 */
async function getAlbumInfo(
  artist: string,
  album: string,
  sessionKey: string,
  cache?: LastFMCache,
  apiMetrics?: APIMetrics
): Promise<{ mbid: string | null } | null> {
  // Check cache first
  if (cache) {
    const cached = cache.getAlbumInfo(artist, album);
    if (cached !== undefined) {
      return cached;
    }
  }

  // Rate limit: Last.fm allows 5 req/sec, but we're conservative
  await new Promise((resolve) => setTimeout(resolve, 200)); // 200ms = 5 req/sec max

  const params: Record<string, string> = {
    method: "album.getInfo",
    artist,
    album,
    api_key: LASTFM_API_KEY!,
    sk: sessionKey,
    format: "json",
  };

  const sig = await generateSignature(params);
  params.api_sig = sig;

  const queryString = new URLSearchParams(params).toString();
  const url = `https://ws.audioscrobbler.com/2.0/?${queryString}`;

  // Retry logic for transient errors
  let retries = 3;
  let delay = 200;
  while (retries > 0) {
    try {
      const res = await fetch(url);
      if (res.ok) {
        const data = await res.json();
        if (data.album) {
          const mbid = data.album.mbid || null;
          const result = { mbid };
          
          // Cache the result
          if (cache) {
            cache.setAlbumInfo(artist, album, result);
          }
          
          return result;
        }
        // No album data, break and cache null
        break;
      }
      
      // Retry on 5xx errors
      if (res.status >= 500 && retries > 1) {
        if (apiMetrics) apiMetrics.lastfmErrors++;
        retries--;
        await new Promise((resolve) => setTimeout(resolve, delay));
        delay *= 2;
        continue;
      }
      
      // Non-retryable error, break
      if (apiMetrics && res.status >= 400) {
        apiMetrics.lastfmErrors++;
      }
      break;
    } catch (e) {
      if (apiMetrics) apiMetrics.lastfmErrors++;
      retries--;
      if (retries > 0) {
        await new Promise((resolve) => setTimeout(resolve, delay));
        delay *= 2;
        continue;
      }
      // Last retry failed, break
      break;
    }
  }

  // Cache null result
  if (cache) {
    cache.setAlbumInfo(artist, album, null);
  }
  return null;
}

/**
 * Get track MBID from Last.fm (requires authenticated session)
 * Tries multiple methods in order:
 * 0. track.getCorrection (get canonical name first) - NEW
 * 1. Direct from track.getInfo API
 * 2. track.search (fallback when track.getInfo fails) - NEW
 * 3. artist.getInfo + track search (try artist MBID approach) - NEW
 * 4. album.getInfo + track search (try album MBID approach) - NEW
 * 5. Via MusicBrainz ISRC lookup (if Last.fm fails)
 * Uses cache to avoid repeated API calls
 */
async function getTrackMBID(
  track: string,
  artist: string,
  sessionKey: string,
  cache?: LastFMCache,
  useAdditionalAPIs: boolean = false,
  apiMetrics?: APIMetrics
): Promise<string | null> {
  // Check cache first
  if (cache) {
    const cached = cache.getMBID(track, artist);
    if (cached !== undefined) {
      return cached;
    }
  }
  
  // Method 0: Try track.getCorrection first (get canonical name)
  const correction = await getTrackCorrection(track, artist, sessionKey, cache, apiMetrics);
  let searchTrack = track;
  let searchArtist = artist;
  if (correction) {
    searchTrack = correction.track;
    searchArtist = correction.artist;
    if (apiMetrics) {
      apiMetrics.lastfmCalls++;
    }
  }
  
  // Method 1: Try track.getInfo (Last.fm authenticated) with corrected name
  // Note: track.getCorrection already incremented lastfmCalls if it was called
  // We increment here for track.getInfo call
  if (apiMetrics) {
    apiMetrics.lastfmCalls++;
  }
  const params: Record<string, string> = {
    method: "track.getInfo",
    track: searchTrack, // Use corrected name if available
    artist: searchArtist, // Use corrected artist if available
    api_key: LASTFM_API_KEY!,
    sk: sessionKey,
    format: "json",
  };

  const sig = await generateSignature(params);
  params.api_sig = sig;

  const queryString = new URLSearchParams(params).toString();
  const url = `https://ws.audioscrobbler.com/2.0/?${queryString}`;

  try {
    const res = await fetch(url);
    if (res.ok) {
      const data = await res.json();
      if (data.track?.mbid) {
        const mbid = data.track.mbid;
        // Validate MBID exists in MusicBrainz (since evaluation has no time constraints)
        // This ensures ground truth quality
        if (useAdditionalAPIs) {
          const isValid = await validateMBID(mbid, cache, apiMetrics);
          if (!isValid) {
            // Invalid MBID from Last.fm, fall through to next method
            // Don't cache invalid MBIDs
          } else {
            // Cache the result (both original and corrected queries)
            if (cache) {
              cache.setMBID(track, artist, mbid);
              if (correction) {
                cache.setMBID(searchTrack, searchArtist, mbid);
              }
            }
            return mbid;
          }
        } else {
          // Cache the result (no validation when additional APIs disabled)
          if (cache) {
            cache.setMBID(track, artist, mbid);
            if (correction) {
              cache.setMBID(searchTrack, searchArtist, mbid);
            }
          }
          return mbid;
        }
      }
      // Also check for corrected track name in response (additional correction)
      if (data.track?.name && data.track.name !== searchTrack) {
        // Try with corrected name from response
        const correctedParams: Record<string, string> = {
          method: "track.getInfo",
          track: data.track.name,
          artist: data.track.artist?.name || searchArtist,
          api_key: LASTFM_API_KEY!,
          sk: sessionKey,
          format: "json",
        };
        const correctedSig = await generateSignature(correctedParams);
        correctedParams.api_sig = correctedSig;
        const correctedUrl = `https://ws.audioscrobbler.com/2.0/?${new URLSearchParams(correctedParams).toString()}`;
        const correctedRes = await fetch(correctedUrl);
        if (correctedRes.ok) {
          const correctedData = await correctedRes.json();
          if (correctedData.track?.mbid) {
            const mbid = correctedData.track.mbid;
            // Validate MBID exists in MusicBrainz (since evaluation has no time constraints)
            if (useAdditionalAPIs) {
              const isValid = await validateMBID(mbid, cache, apiMetrics);
              if (!isValid) {
                // Invalid MBID from Last.fm, fall through to next method
                // Don't cache invalid MBIDs
              } else {
                // Cache all variations (original, correction API, response correction)
                if (cache) {
                  cache.setMBID(track, artist, mbid);
                  if (correction) {
                    cache.setMBID(searchTrack, searchArtist, mbid);
                  }
                  cache.setMBID(data.track.name, data.track.artist?.name || searchArtist, mbid);
                }
                return mbid;
              }
            } else {
              // Cache all variations (no validation)
              if (cache) {
                cache.setMBID(track, artist, mbid);
                if (correction) {
                  cache.setMBID(searchTrack, searchArtist, mbid);
                }
                cache.setMBID(data.track.name, data.track.artist?.name || searchArtist, mbid);
              }
              return mbid;
            }
          }
        }
      }
    }
  } catch (e) {
    // Ignore errors
  }

  // Method 2: Try track.search (fallback when track.getInfo fails)
  if (apiMetrics) {
    apiMetrics.lastfmCalls++;
  }
  const searchResults = await searchTracksOnLastFM(searchTrack, searchArtist, sessionKey, 10, cache, apiMetrics);
  for (const result of searchResults) {
    // Try to find exact or close match
    const trackMatch = result.track.toLowerCase() === searchTrack.toLowerCase() ||
                       result.track.toLowerCase().includes(searchTrack.toLowerCase()) ||
                       searchTrack.toLowerCase().includes(result.track.toLowerCase());
    const artistMatch = result.artist.toLowerCase() === searchArtist.toLowerCase() ||
                        result.artist.toLowerCase().includes(searchArtist.toLowerCase()) ||
                        searchArtist.toLowerCase().includes(result.artist.toLowerCase());
    
    if (trackMatch && artistMatch && result.mbid) {
      // Validate MBID if enabled
      if (useAdditionalAPIs && apiMetrics) {
        const isValid = await validateMBID(result.mbid, cache, apiMetrics);
        if (isValid) {
          if (cache) {
            cache.setMBID(track, artist, result.mbid);
            if (correction) {
              cache.setMBID(searchTrack, searchArtist, result.mbid);
            }
          }
          return result.mbid;
        }
      } else {
        // Cache and return without validation
        if (cache) {
          cache.setMBID(track, artist, result.mbid);
          if (correction) {
            cache.setMBID(searchTrack, searchArtist, result.mbid);
          }
        }
        return result.mbid;
      }
    }
  }

  // Method 3: Try artist.getInfo (could help with artist name variations)
  // Note: This is a fallback - if artist has MBID, we could potentially use it
  // but Last.fm doesn't directly support artist MBID + track name lookup
  // So we skip this for now (would need MusicBrainz API integration)
  // If we wanted to use this, we'd call:
  // const artistInfo = await getArtistInfo(searchArtist, sessionKey, cache, apiMetrics);
  // Then potentially use artist MBID for MusicBrainz search

  // Method 4: Try album.getInfo if we have album name (requires album parameter)
  // This would need to be called from the caller with album info
  // Skipping here since we don't have album in this function signature

  // Method 5: Try comprehensive MusicBrainz search (if enabled and Last.fm failed)
  // Since evaluation has no time constraints, we can be very thorough here
  if (useAdditionalAPIs) {
    const mbidViaMB = await getMBIDViaISRC(track, artist, cache);
    if (mbidViaMB) {
      // Validate MBID exists in MusicBrainz (since we have time)
      const isValid = await validateMBID(mbidViaMB, cache, apiMetrics);
      if (isValid) {
        if (cache) {
          cache.setMBID(track, artist, mbidViaMB);
        }
        return mbidViaMB;
      }
      // If invalid, continue to next method
    }
  }

  // Cache null result to avoid re-fetching
  if (cache) {
    cache.setMBID(track, artist, null);
  }
  return null;
}

/**
 * Validate that an MBID actually exists in MusicBrainz
 * Since evaluation has no time constraints, we can verify ground truth quality
 * Results are cached to avoid repeated API calls
 */
async function validateMBID(mbid: string, cache?: LastFMCache, apiMetrics?: APIMetrics): Promise<boolean> {
  // Check cache first (all slow operations should be cached)
  if (cache) {
    const cached = cache.getMBIDValidation(mbid);
    if (cached !== undefined) {
      return cached; // Return cached result
    }
  }

  try {
    await new Promise((resolve) => setTimeout(resolve, RATE_LIMIT_DELAY));
    const lookupUrl = `${MUSICBRAINZ_BASE_URL}/recording/${mbid}?fmt=json`;
    const apiCallStart = Date.now();
    const res = await fetch(lookupUrl, {
      headers: { "User-Agent": "tealtracker/0.0.1 (https://github.com/teal-fm/teal)" },
    });
    const apiCallTime = Date.now() - apiCallStart;
    
    if (apiMetrics) {
      apiMetrics.musicbrainzCalls++;
      apiMetrics.totalAPICallTime += apiCallTime;
    }
    
    let isValid: boolean;
    let errorMessage: string | undefined;
    
    // Only 404 means invalid MBID; rate limits (503) and other errors are transient
    if (res.status === 404) {
      isValid = false; // MBID doesn't exist
      errorMessage = "404 Not Found";
    } else if (res.status === 503) {
      // Rate limited - assume valid (we'll retry later if needed)
      // This prevents false negatives from rate limiting
      if (apiMetrics) apiMetrics.musicbrainzRateLimits++;
      isValid = true;
      errorMessage = "503 Rate Limited (assumed valid)";
    } else if (res.ok) {
      isValid = true; // 200 = valid
    } else {
      // Other errors - assume valid to avoid false negatives
      if (apiMetrics) apiMetrics.musicbrainzErrors++;
      isValid = true;
      errorMessage = `HTTP ${res.status} (assumed valid)`;
    }
    
    // Cache the result (accumulates over time, never cleared)
    if (cache) {
      cache.setMBIDValidation(mbid, isValid, res.status, errorMessage);
    }
    
    return isValid;
  } catch (e) {
    // Network errors - assume valid to avoid false negatives
    // Better to include potentially invalid MBIDs than exclude valid ones
    if (apiMetrics) apiMetrics.musicbrainzErrors++;
    const errorMsg = e instanceof Error ? e.message : String(e);
    if (cache) {
      cache.setMBIDValidation(mbid, true, undefined, `Network error: ${errorMsg} (assumed valid)`);
    }
    return true;
  }
}

/**
 * Bootstrap confidence intervals
 */
function bootstrapCI(
  values: boolean[],
  metric: (vals: boolean[]) => number,
  iterations: number = 10000,
  confidence: number = 0.95,
): [number, number, number] {
  const n = values.length;
  
  if (n < 30) {
    const point = metric(values);
    const successes = values.filter((v) => v).length;
    const p = successes / n;
    const se = Math.sqrt((p * (1 - p)) / n);
    const tCrit = 2.045;
    const margin = tCrit * se;
    return [point, Math.max(0, point - margin), Math.min(100, point + margin)];
  }
  
  const allSame = values.every((v) => v === values[0]);
  if (allSame) {
    const point = metric(values);
    return [point, point, point];
  }

  const samples: number[] = [];
  for (let i = 0; i < iterations; i++) {
    const resample: boolean[] = [];
    for (let j = 0; j < n; j++) {
      resample.push(values[Math.floor(Math.random() * n)]);
    }
    samples.push(metric(resample));
  }

  samples.sort((a, b) => a - b);
  const alpha = 1 - confidence;
  const lowerIdx = Math.floor(iterations * (alpha / 2));
  const upperIdx = Math.floor(iterations * (1 - alpha / 2));
  const point = metric(values);
  const lower = samples[lowerIdx];
  const upper = samples[upperIdx];

  return [point, lower, upper];
}

/**
 * McNemar's test for paired binary classification
 */
function mcnemarTest(
  baselineCorrect: boolean[],
  improvedCorrect: boolean[],
): { statistic: number; pValue: number; significant: boolean } {
  if (baselineCorrect.length !== improvedCorrect.length) {
    throw new Error("McNemar test requires arrays of equal length");
  }

  let b01 = 0; // Baseline wrong, improved correct
  let b10 = 0; // Baseline correct, improved wrong

  for (let i = 0; i < baselineCorrect.length; i++) {
    const b = baselineCorrect[i];
    const i_ = improvedCorrect[i];
    if (!b && i_) b01++;
    else if (b && !i_) b10++;
  }

  const discordant = b01 + b10;
  
  if (discordant === 0) {
    return { statistic: 0, pValue: 1.0, significant: false };
  }

  if (discordant < 25) {
    const n = discordant;
    const k = Math.max(b01, b10);
    let pValue = 0;
    
    for (let x = k; x <= n; x++) {
      let logCoeff = 0;
      for (let i = 0; i < x; i++) {
        logCoeff += Math.log(n - i) - Math.log(i + 1);
      }
      pValue += Math.exp(logCoeff - n * Math.log(2));
    }
    pValue = Math.min(1.0, pValue * 2);
    
    return {
      statistic: 0,
      pValue,
      significant: pValue < 0.05,
    };
  }

  const chi2 = Math.pow(Math.abs(b01 - b10) - 1, 2) / discordant;
  
  let pValue: number;
  if (chi2 > 6.63) {
    pValue = 0.01;
  } else if (chi2 > 3.84) {
    pValue = 0.05;
  } else if (chi2 > 2.71) {
    pValue = 0.10;
  } else {
    pValue = 1 - Math.exp(-chi2 / 2);
  }

  return {
    statistic: chi2,
    pValue,
    significant: pValue < 0.05,
  };
}

/**
 * Cohen's h for effect size (proportions)
 */
function cohensH(p1: number, p2: number): number {
  const h1 = 2 * Math.asin(Math.sqrt(p1 / 100));
  const h2 = 2 * Math.asin(Math.sqrt(p2 / 100));
  return h1 - h2;
}

/**
 * Calculate Discounted Cumulative Gain (DCG) at position p
 * DCG_p = sum(rel_i / log2(i + 1)) for i from 1 to p
 */
function dcg(relevance: number[], p: number = Infinity): number {
  const limit = Math.min(p, relevance.length);
  return relevance
    .slice(0, limit)
    .reduce((sum, rel, i) => sum + rel / Math.log2(i + 2), 0);
}

/**
 * Calculate Normalized Discounted Cumulative Gain (NDCG) at position p
 * NDCG_p = DCG_p / IDCG_p
 * For binary relevance (0/1), IDCG is just the DCG of sorted relevance scores
 */
function ndcg(actualRelevance: number[], p: number = Infinity): number {
  if (actualRelevance.length === 0) return 0;
  
  const idealRelevance = [...actualRelevance].sort((a, b) => b - a);
  const dcgActual = dcg(actualRelevance, p);
  const idcg = dcg(idealRelevance, p);
  
  // Avoid division by zero
  if (idcg === 0) return 0;
  
  return dcgActual / idcg;
}


/**
 * Baseline search (original "funny search string")
 * 
 * CRITICAL: Original implementation did NOT escape Lucene special characters.
 * However, we use escapeLucene() here for safety (prevents query injection).
 * This makes baseline slightly BETTER than original, but is necessary for correctness.
 * 
 * Original was: title:"${track}" AND artist:"${artist}"
 * This version: title:"${escapeLucene(track)}" AND artist:"${escapeLucene(artist)}"
 * 
 * Impact: Baseline may perform slightly better than true original due to escaping,
 * but this is acceptable as escaping is a correctness fix, not a matching improvement.
 */
async function baselineSearch(
  track: string,
  artist: string,
  release: string | undefined,
  cache?: LastFMCache,
  apiMetrics?: APIMetrics
): Promise<SearchResult[]> {
  // Check cache first - if cached, return immediately (no delay)
  // Baseline search always uses: no cleaning, no fuzzy, no multistage
  if (cache) {
    const cached = cache.getSearchResults(track, artist, release, false, false, false);
    if (cached !== null) {
      return cached;
    }
  }

  const queryParts: string[] = [];
  // NOTE: Original didn't escape, but we do for safety (prevents Lucene injection)
  // This makes baseline slightly better than original, but is a correctness fix
  if (track) queryParts.push(`title:"${escapeLucene(track)}"`);
  if (artist) queryParts.push(`artist:"${escapeLucene(artist)}"`);
  if (release) queryParts.push(`release:"${escapeLucene(release)}"`);

  if (queryParts.length === 0) return [];

  const query = queryParts.join(" AND ");
  const url = `${MUSICBRAINZ_BASE_URL}/recording?query=${encodeURIComponent(query)}&fmt=json&limit=25`;

  // Only delay for actual API calls, not cached results
  await new Promise((resolve) => setTimeout(resolve, RATE_LIMIT_DELAY));

  // Retry logic with exponential backoff for rate limiting
  let retries = 3;
  let delay = 1000;
  
  while (retries > 0) {
    try {
      const apiCallStart = Date.now();
      const res = await fetch(url, {
        headers: { "User-Agent": "tealtracker/0.0.1 (https://github.com/teal-fm/teal)" },
      });
      const apiCallTime = Date.now() - apiCallStart;
      
      if (apiMetrics) {
        apiMetrics.musicbrainzCalls++;
        apiMetrics.totalAPICallTime += apiCallTime;
      }

      if (res.status === 503) {
        // Rate limited, wait and retry
        if (apiMetrics) apiMetrics.musicbrainzRateLimits++;
        retries--;
        if (retries > 0) {
          await new Promise((resolve) => setTimeout(resolve, delay));
          delay *= 2;
          continue;
        }
        // Last retry failed, return empty
        const results: SearchResult[] = [];
        if (cache) cache.setSearchResults(track, artist, release, results, false, false, false);
        return results;
      }

      if (!res.ok) {
        if (apiMetrics) apiMetrics.musicbrainzErrors++;
        const results: SearchResult[] = [];
        if (cache) cache.setSearchResults(track, artist, release, results, false, false, false);
        return results;
      }
      
      const data = await res.json();
      const rawResults = data.recordings || [];
      const results = rawResults.filter((r: SearchResult): r is SearchResult & { id: string } => !!r.id);
      if (cache) cache.setSearchResults(track, artist, release, results, false, false, false);
      return results;
    } catch (error) {
      if (apiMetrics) apiMetrics.musicbrainzErrors++;
      retries--;
      if (retries > 0) {
        await new Promise((resolve) => setTimeout(resolve, delay));
        delay *= 2;
        continue;
      }
      // Last retry failed, return empty
      const results: SearchResult[] = [];
      if (cache) cache.setSearchResults(track, artist, release, results, false, false, false);
      return results;
    }
  }
  
  // Should never reach here, but TypeScript needs it
  const results: SearchResult[] = [];
  if (cache) cache.setSearchResults(track, artist, release, results, false, false, false);
  return results;
}

/**
 * Search configuration for A/B testing different feature combinations
 */
interface SearchConfig {
  enableCleaning: boolean;
  enableFuzzy: boolean;
  enableMultiStage: boolean;
}

/**
 * Improved search with configurable features for variation testing
 * Note: We use searchStage from musicbrainzSearchUtils directly for consistency with frontend
 */
async function improvedSearchWithConfig(
  track: string,
  artist: string,
  release: string | undefined,
  config: SearchConfig,
  cache?: LastFMCache,
  apiMetrics?: APIMetrics
): Promise<SearchResult[]> {
  // Stage 1: Cleaning (if enabled)
  // CRITICAL: Match production behavior exactly:
  // - Production: cleanTrackName(track) || undefined (converts empty string to undefined)
  // - This ensures empty cleaned names don't fall back to original values
  let cleanedTrack: string | undefined;
  let cleanedArtist: string | undefined;
  let cleanedRelease: string | undefined;
  
  if (config.enableCleaning) {
    cleanedTrack = track ? (cleanTrackName(track) || undefined) : undefined;
    cleanedArtist = artist ? (cleanArtistName(artist) || undefined) : undefined;
    cleanedRelease = release ? (cleanReleaseName(release) || undefined) : undefined;
  } else {
    // If cleaning disabled, use original values (but still allow undefined)
    cleanedTrack = track || undefined;
    cleanedArtist = artist || undefined;
    cleanedRelease = release || undefined;
  }

  // Stage 1: Exact match with cleaned names
  // Check cache first for exact match
  let exactResults: SearchResult[] = [];
  if (cache) {
    const cached = cache.getSearchResults(
      cleanedTrack ?? track,
      cleanedArtist ?? artist,
      cleanedRelease ?? release,
      config.enableCleaning,
      false, // exact = no fuzzy
      false  // exact = no multistage
    );
    if (cached !== null && cached.length > 0) {
      exactResults = cached;
    }
  }
  
  // If not cached, use searchStage for exact match to match frontend behavior (consistent escaping)
  // CRITICAL: Pass cleaned names directly (not || original) to match production behavior
  // Production passes cleanedTrack (which may be undefined if cleaning resulted in empty string)
  if (exactResults.length === 0) {
    const stageStart = Date.now();
    const rawResults = await searchStage(
      cleanedTrack,
      cleanedArtist,
      cleanedRelease,
      "exact"
    ) as SearchResult[];
    // Only count API call if at least one query parameter exists
    // searchStage returns immediately (no API call) if all parameters are undefined
    if (apiMetrics && (cleanedTrack || cleanedArtist || cleanedRelease)) {
      apiMetrics.musicbrainzCalls++;
      apiMetrics.totalAPICallTime += Date.now() - stageStart;
    }
    
    exactResults = rawResults.filter((r): r is SearchResult & { id: string } => !!r.id);
    
    // Cache exact results
      // Use cleaned names for cache key (or original if cleaning disabled)
    if (cache && exactResults.length > 0) {
      cache.setSearchResults(
          cleanedTrack ?? track,
          cleanedArtist ?? artist,
          cleanedRelease ?? release,
        exactResults,
        config.enableCleaning,
        false, // exact = no fuzzy
        false  // exact = no multistage
      );
    }
  } else {
    exactResults = exactResults.filter((r): r is SearchResult & { id: string } => !!r.id);
  }

  // Stage 2 & 3: Fuzzy and partial matching (if enabled and multi-stage enabled)
  // CRITICAL: Must match production logic exactly:
  // - Production: Skip multi-stage if exact search already returns good results (prevents regressions)
  // - Production: fuzzy if exactResults.length < FUZZY_THRESHOLD (3) AND shouldUseMultiStage
  // - Production: partial if totalSoFar < PARTIAL_THRESHOLD (5), where totalSoFar = exact + fuzzy
  // This ensures evaluation matches what users actually see
  // CRITICAL FIX: Match production's conditional multi-stage logic exactly
  // Production: Be extremely conservative - only use multi-stage if exact search truly failed
  // For track+artist: skip multi-stage if we have ANY exact results (exact match is very reliable)
  // For track-only: skip multi-stage if we have >= 2 exact results OR if first result matches very well
  const hasGoodExactResult = exactResults.length > 0 && (
    // If we have track+artist, any exact match is very reliable (skip multi-stage)
    (cleanedArtist && exactResults.length >= 1) ||
    // For track-only, need >= 2 results OR first result must match track name very well
    // Use stricter matching: result title should start with or equal cleaned track (not just contain)
    (!cleanedArtist && (
      exactResults.length >= 2 ||
      (exactResults.length >= 1 && exactResults[0]?.title && cleanedTrack && (
        normalizeForComparison(exactResults[0].title) === normalizeForComparison(cleanedTrack) ||
        normalizeForComparison(exactResults[0].title).startsWith(normalizeForComparison(cleanedTrack) + " ")
      ))
    ))
  );
  // CRITICAL FIX: Only use multi-stage if exact search truly failed (0 results)
  // This is extremely conservative to prevent regressions in easy cases
  // Exception: For track-only with 1 result that doesn't match well, we still try multi-stage
  const shouldUseMultiStage = exactResults.length === 0 || 
    (!cleanedArtist && exactResults.length === 1 && !hasGoodExactResult);
  const needsMoreResults = config.enableMultiStage && (cleanedTrack || cleanedArtist) && shouldUseMultiStage;
  const needsFuzzy = needsMoreResults && config.enableFuzzy && exactResults.length < 3; // FUZZY_THRESHOLD = 3
  // Note: needsPartial depends on totalSoFar (exact + fuzzy), not just exactResults.length
  // We'll calculate this after fuzzy stage completes
  
  let fuzzyResults: SearchResult[] = [];
  let partialResults: SearchResult[] = [];
  
  if (needsFuzzy) {
    const promises: Promise<{ type: "fuzzy"; results: SearchResult[] }>[] = [];
    
    // Stage 2: Fuzzy matching
    {
      promises.push(
        (async () => {
          // Check cache first for fuzzy stage
          if (cache) {
            const cached = cache.getSearchResults(
              cleanedTrack ?? track,
              cleanedArtist ?? artist,
              cleanedRelease ?? release,
              config.enableCleaning,
              true,  // fuzzy = true
              false  // not multistage yet (single stage)
            );
            if (cached !== null && cached.length > 0) {
              return { type: "fuzzy" as const, results: cached };
            }
          }
          
          // Not cached, make API call
          // CRITICAL: Pass cleaned names directly (not || original) to match production
          const stageStart = Date.now();
          const results = await searchStage(
            cleanedTrack,
            cleanedArtist,
            cleanedRelease,
            "fuzzy"
          ) as SearchResult[];
          // Only count API call if at least one query parameter exists
          // searchStage returns immediately (no API call) if all parameters are undefined
          if (apiMetrics && (cleanedTrack || cleanedArtist || cleanedRelease)) {
            apiMetrics.musicbrainzCalls++;
            apiMetrics.totalAPICallTime += Date.now() - stageStart;
          }
          
          // Cache fuzzy results
          if (cache && results.length > 0) {
            cache.setSearchResults(
              cleanedTrack ?? track,
              cleanedArtist ?? artist,
              cleanedRelease ?? release,
              results,
              config.enableCleaning,
              true,  // fuzzy = true
              false  // not multistage yet (single stage)
            );
          }
          
          return { type: "fuzzy" as const, results };
        })()
      );
    }

    // Execute fuzzy stage first (if needed), then check for partial
    // This matches production logic: partial depends on totalSoFar (exact + fuzzy)
    // CRITICAL: Do NOT check needsPartial here - it depends on totalSoFar which we calculate after fuzzy
    const stageResults = await Promise.all(promises);
    for (const stageResult of stageResults) {
      const validResults = stageResult.results.filter((r): r is SearchResult & { id: string } => !!r.id);
      fuzzyResults = validResults;
    }
  }
  
  // Now check if partial is needed (matches production: totalSoFar < PARTIAL_THRESHOLD)
  // CRITICAL: Production checks totalSoFar (exact + fuzzy), not just exactResults.length
  // This check must be OUTSIDE the if (needsFuzzy) block because partial can run even if fuzzy didn't
  const totalSoFar = exactResults.length + fuzzyResults.length;
  const needsPartial = needsMoreResults && totalSoFar < 5; // PARTIAL_THRESHOLD = 5
  
    if (needsPartial) {
          // Check cache first for partial stage
          if (cache) {
            const cached = cache.getSearchResults(
          cleanedTrack ?? track,
          cleanedArtist ?? artist,
          cleanedRelease ?? release,
              config.enableCleaning,
              false, // partial = no fuzzy
              false  // not multistage yet (single stage)
            );
            if (cached !== null && cached.length > 0) {
              const validCached = cached.filter((r): r is SearchResult & { id: string } => !!r.id);
          partialResults = validCached;
            }
          }
          
      // If not cached, make API call
      // CRITICAL: Pass cleaned names directly (not || original) to match production
      if (partialResults.length === 0) {
          const stageStart = Date.now();
          const rawResults = await searchStage(
          cleanedTrack,
          cleanedArtist,
          cleanedRelease,
            "partial"
          ) as SearchResult[];
        // Only count API call if at least one query parameter exists
        // searchStage returns immediately (no API call) if all parameters are undefined
        if (apiMetrics && (cleanedTrack || cleanedArtist || cleanedRelease)) {
            apiMetrics.musicbrainzCalls++;
            apiMetrics.totalAPICallTime += Date.now() - stageStart;
          }
          
          const results = rawResults.filter((r): r is SearchResult & { id: string } => !!r.id);
          
          // Cache partial results
          if (cache && results.length > 0) {
            cache.setSearchResults(
            cleanedTrack ?? track,
            cleanedArtist ?? artist,
            cleanedRelease ?? release,
              results,
              config.enableCleaning,
              false, // partial = no fuzzy
              false  // not multistage yet (single stage)
            );
          }
          
        partialResults = results;
      }
  }

  // IMPROVEMENT: If cleaned names failed, try multiple fallback strategies (matches production)
  // This helps with cases where cleaning removed important information or exact match is too strict
  // CRITICAL FIX: Only run fallback strategies if we're using multi-stage (prevents regressions)
  let fallbackResults: SearchResult[] = [];
  const totalSoFarAfterPartial = exactResults.length + fuzzyResults.length + partialResults.length;
  // CRITICAL FIX: Only run fallback strategies if we're using multi-stage
  // This prevents adding noise when exact search already found good results
  if (shouldUseMultiStage && totalSoFarAfterPartial < 5) { // PARTIAL_THRESHOLD = 5
    // Strategy 1: Try original (uncleaned) names if we cleaned something
    const hasCleaned = (cleanedTrack !== track && track) ||
                      (cleanedArtist !== artist && artist);
    
    if (hasCleaned && (track || artist)) {
      // Try exact search with original (uncleaned) names
      const originalExact = await searchStage(
        track,
        artist,
        release,
        "exact"
      ) as SearchResult[];
      const validOriginalExact = originalExact.filter((r): r is SearchResult & { id: string } => !!r.id);
      fallbackResults.push(...validOriginalExact);
      
      // Only count API call if at least one query parameter exists
      if (apiMetrics && (track || artist || release)) {
        apiMetrics.musicbrainzCalls++;
      }
    }
    
    // Strategy 2: Try fuzzy search with original names (helps with special chars, Unicode)
    // Only if we haven't found enough results yet
    if (fallbackResults.length < 5 && (track || artist)) {
      const originalFuzzy = await searchStage(
        track,
        artist,
        release,
        "fuzzy"
      ) as SearchResult[];
      const validOriginalFuzzy = originalFuzzy.filter((r): r is SearchResult & { id: string } => !!r.id);
      fallbackResults.push(...validOriginalFuzzy);
      
      // Only count API call if at least one query parameter exists
      if (apiMetrics && (track || artist || release)) {
        apiMetrics.musicbrainzCalls++;
      }
    }
    
    // Strategy 3: Try track-only search if both track and artist were provided
    // Sometimes MusicBrainz has better matches when searching fewer fields
    if (fallbackResults.length < 5 && track && artist) {
      const trackOnly = await searchStage(
        track,
        undefined,
        release,
        "exact"
      ) as SearchResult[];
      const validTrackOnly = trackOnly.filter((r): r is SearchResult & { id: string } => !!r.id);
      fallbackResults.push(...validTrackOnly);
      
      // Only count API call if at least one query parameter exists
      if (apiMetrics && (track || release)) {
        apiMetrics.musicbrainzCalls++;
      }
    }

    // Strategy 4: Try artist-only search if both track and artist were provided
    if (fallbackResults.length < 5 && track && artist) {
      const artistOnly = await searchStage(
        undefined, // No track
        artist,
        release,
        "exact",
      ) as SearchResult[];
      const validArtistOnly = artistOnly.filter((r): r is SearchResult & { id: string } => !!r.id);
      fallbackResults.push(...validArtistOnly);

      if (apiMetrics && (artist || release)) {
        apiMetrics.musicbrainzCalls++;
      }
    }
    
    // Strategy 5: Try explicit "live" variations if query contains "live" indicator
    // This helps find live versions that might not match with cleaned names
    const hasLiveIndicator = (track || "").toLowerCase().includes("live") ||
                            (track || "").toLowerCase().includes("(live)") ||
                            (track || "").toLowerCase().includes("[live]");
    
    if (fallbackResults.length < 5 && hasLiveIndicator && track) {
      // Try variations: "track (live)", "track live", "track - live"
      const liveVariations = [
        track.replace(/\s*\(live\)\s*/i, " (live)"), // Ensure "(live)" format
        track.replace(/\s*\(live\)\s*/i, " live"), // Try "live" without parentheses
        track.replace(/\s*\(live\)\s*/i, " - live"), // Try " - live" format
      ];
      
      // Try each variation (deduplicate later)
      for (const liveTrack of liveVariations) {
        if (fallbackResults.length >= 5) break;
        const liveResults = await searchStage(
          liveTrack,
          artist,
          release,
          "exact",
        ) as SearchResult[];
        const validLiveResults = liveResults.filter((r): r is SearchResult & { id: string } => !!r.id);
        fallbackResults.push(...validLiveResults);
        
        if (apiMetrics && (liveTrack || artist || release)) {
          apiMetrics.musicbrainzCalls++;
        }
      }
    }
  }

  // Re-rank all results using rankMultiStageResults (matches frontend behavior)
  // This ensures evaluation matches what users actually see
  const stageResultsForRanking = [
    { results: exactResults, strategy: "exact" as const },
    ...(fuzzyResults.length > 0 ? [{ results: fuzzyResults, strategy: "fuzzy" as const }] : []),
    ...(partialResults.length > 0 ? [{ results: partialResults, strategy: "partial" as const }] : []),
    ...(fallbackResults.length > 0 ? [{ results: fallbackResults, strategy: "exact" as const }] : []), // Fallback uses exact strategy
  ].filter((stage) => stage.results.length > 0);

  // Re-rank all results together (matches frontend behavior)
  let finalResults: SearchResult[];
  if (stageResultsForRanking.length > 0) {
    const rankingQuery: RankingQuery = {
      track,
      artist,
      release,
      cleanedTrack: config.enableCleaning ? cleanedTrack : undefined,
      cleanedArtist: config.enableCleaning ? cleanedArtist : undefined,
      cleanedRelease: config.enableCleaning ? cleanedRelease : undefined,
    };
    finalResults = rankMultiStageResults(stageResultsForRanking, rankingQuery);
  } else {
    finalResults = [];
  }

  finalResults = finalResults.slice(0, 25);
  
  // Cache full result at function level (for top-level cache check in evaluateCase)
  // Use cleaned names for cache key (or original if cleaning disabled) to match the top-level cache check
  // This allows the top-level cache check to work correctly
  if (cache) {
    cache.setSearchResults(
      cleanedTrack ?? track,
      cleanedArtist ?? artist,
      cleanedRelease ?? release,
      finalResults,
      config.enableCleaning,
      config.enableFuzzy,
      config.enableMultiStage
    );
  }
  
  return finalResults;
}

async function main() {
  const startTime = Date.now();
  
  const args = process.argv.slice(2);

  const limitArg = args.findIndex((a) => a === "--limit");
  const limit = limitArg >= 0 ? parseInt(args[limitArg + 1]) || 1000 : 1000;
  const useAll = args.includes("--all");
  const authOnly = args.includes("--auth-only");
  
  // (Loved tracks expansion removed to keep the eval runner minimal and reproducible.)
  
  // Initialize SQLite cache
  const cache = new LastFMCache();
  
  // Note: ultra-aggressive evaluation-time search was removed (archived previously).
  const usernameArg = args.findIndex((a) => a === "--username");
  const username = usernameArg >= 0 ? args[usernameArg + 1] : undefined;
  
  // Initialize API metrics early (used in validation)
  interface APIMetrics {
    musicbrainzCalls: number;
    musicbrainzRateLimits: number;
    musicbrainzErrors: number;
    lastfmCalls: number;
    lastfmErrors: number;
    totalAPICallTime: number;
  }
  
  const apiMetrics: APIMetrics = {
    musicbrainzCalls: 0,
    musicbrainzRateLimits: 0,
    musicbrainzErrors: 0,
    lastfmCalls: 0,
    lastfmErrors: 0,
    totalAPICallTime: 0,
  };
  
  // Helper to format elapsed time
  const formatTime = (ms: number): string => {
    if (ms < 1000) {
      return `${Math.round(ms)}ms`;
    }
    const seconds = Math.floor(ms / 1000);
    const minutes = Math.floor(seconds / 60);
    const hours = Math.floor(minutes / 60);
    if (hours > 0) {
      return `${hours}h ${minutes % 60}m ${seconds % 60}s`;
    } else if (minutes > 0) {
      return `${minutes}m ${seconds % 60}s`;
    } else {
      return `${seconds}s`;
    }
  };
  
  // Helper to calculate ETA
  const calculateETA = (elapsed: number, completed: number, total: number): string => {
    if (completed === 0 || completed >= total) return "0s";
    const avgTimePerItem = elapsed / completed;
    const remaining = total - completed;
    const etaMs = avgTimePerItem * remaining;
    return formatTime(etaMs);
  };
  
  // Feature flags for variation testing
  const noCleaning = args.includes("--no-cleaning");
  const noFuzzy = args.includes("--no-fuzzy");
  const noMultiStage = args.includes("--no-multistage");
  // Enable parallel by default for speed (can disable with --no-parallel)
  const parallel = !args.includes("--no-parallel");
  const concurrency = parallel ? (args.findIndex((a) => a === "--concurrency") >= 0 
    ? parseInt(args[args.findIndex((a) => a === "--concurrency") + 1]) || 5 
    : 5) : 1;
  const useAdditionalAPIs = args.includes("--use-additional-apis");
  
  const searchConfig: SearchConfig = {
    enableCleaning: !noCleaning,
    enableFuzzy: !noFuzzy,
    enableMultiStage: !noMultiStage,
  };

  console.log("=".repeat(60));
  console.log("MusicBrainz Matching Evaluation");
  console.log("=".repeat(60));
  console.log();
  
  // Show configuration
  if (noCleaning || noFuzzy || noMultiStage || parallel || useAdditionalAPIs || useAll) {
    console.log("CONFIGURATION:");
    console.log(`  Cleaning: ${searchConfig.enableCleaning ? "enabled" : "disabled"}`);
    console.log(`  Fuzzy matching: ${searchConfig.enableFuzzy ? "enabled" : "disabled"}`);
    console.log(`  Multi-stage: ${searchConfig.enableMultiStage ? "enabled" : "disabled"}`);
    if (parallel) {
      console.log(`  Parallel: enabled (concurrency: ${concurrency})`);
    } else {
      console.log(`  Parallel: disabled (use --parallel to enable)`);
    }
    if (useAdditionalAPIs) {
      console.log(`  Additional APIs: enabled (MusicBrainz ISRC lookup for MBID resolution)`);
    }
    if (useAll) {
      console.log(`  Dataset: all cached scrobbles`);
    }
    console.log();
  }

  // Initialize scrobbles array
  let scrobbles: Array<{
    track: string;
    artist: string;
    album?: string;
    mbid: string | null;
  }> = [];
  
  // Initialize validScrobbles (filled from Last.fm scrobbles)
  let validScrobbles: Array<{
    track: string;
    artist: string;
    album?: string;
    mbid: string | null;
  }> = [];
  
  // Use Last.fm API (OAuth default).
  if (!LASTFM_API_KEY || !LASTFM_API_SECRET) {
    console.error("Error: LASTFM_API_KEY and LASTFM_API_SECRET must be set in .env");
    process.exit(1);
  }

  // Get session key (OAuth if needed)
  let sessionKey: string | undefined;
  if (!username) {
    console.log("No username provided - using OAuth authentication\n");
    try {
      sessionKey = await getLastFMSession();
    } catch (error: any) {
      console.error(`\n✗ OAuth Error: ${error.message}`);
      console.log("\nTo use public API instead, set LASTFM_USERNAME in .env or use --username USER");
      process.exit(1);
    }
  } else {
    console.log(`Using public API for username: ${username}\n`);
  }

  if (authOnly) {
    console.log("\nAuthenticated. Session key is cached locally.");
    cache.close();
    return;
  }

  // Get recent tracks
  // For authenticated users, we can get tracks directly without username
  // Last.fm API will return tracks for the authenticated user when session key is provided
  let targetUsername = username;
  if (sessionKey && !targetUsername) {
    console.log("Using authenticated session (no username lookup needed)...");
    targetUsername = ""; // Empty username means use authenticated user
  }
  
  if (!targetUsername && !sessionKey) {
    throw new Error("No username available. Provide --username or authenticate via OAuth.");
  }
  
  const cacheUsername = targetUsername || (sessionKey ? "authenticated" : "");
  
  // Show cache stats
  const stats = cache.getStats(cacheUsername);
  console.log("CACHE STATS (All accumulate over time, never cleared):");
  console.log(`  Total scrobbles: ${stats.totalScrobbles}`);
  console.log(`  With MBIDs: ${stats.scrobblesWithMBID}`);
  console.log(`  Cached MBID lookups: ${stats.cachedMBIDs}`);
  console.log(`  Cached MusicBrainz searches: ${stats.cachedSearches}`);
  console.log(`  Cached MBID validations: ${stats.cachedValidations}\n`);
  
  const desiredLimit = useAll ? stats.totalScrobbles : limit;

  // Get scrobbles from cache
  const cachedScrobbles = cache.getScrobbles(cacheUsername, desiredLimit);
  const refresh = args.includes("--refresh-scrobbles");
  
  let fromCache = 0;
  let fetched = 0;
  let added = 0;
  
  // If we have enough cached, use them
  if (!refresh && cachedScrobbles.length >= desiredLimit) {
    scrobbles = cachedScrobbles.slice(0, desiredLimit).map((s) => ({
      track: s.track,
      artist: s.artist,
      album: s.album,
      mbid: s.mbid,
    }));
    fromCache = scrobbles.length;
    console.log(`Using ${fromCache} scrobbles from cache (${stats.totalScrobbles} total available)\n`);
  } else {
    // Need to fetch more - calculate how many
    const needCount = useAll
      ? Number.MAX_SAFE_INTEGER
      : (refresh ? desiredLimit : Math.max(0, desiredLimit - cachedScrobbles.length));
    
    if (needCount > 0) {
      if (refresh) {
        console.log(`Fetching ${needCount} fresh scrobbles (--refresh flag)...\n`);
      } else {
        console.log(`Fetching ${needCount} additional scrobbles (${cachedScrobbles.length} already cached)...\n`);
      }
      
      // Fetch in pages (Last.fm max 200 per page)
      const pagesNeeded = useAll ? Number.MAX_SAFE_INTEGER : Math.ceil(needCount / 200);
      const allTracks: LastFMTrack[] = [];
      
      const fetchStartTime = Date.now();
      for (let page = 1; page <= pagesNeeded && allTracks.length < needCount; page++) {
        const pageLimit = Math.min(200, needCount - allTracks.length);
        const pageStartTime = Date.now();
        const pageTracks = await getRecentTracks(targetUsername || "", pageLimit, sessionKey, page);
        if (useAll && pageTracks.length === 0) {
          break;
        }
        allTracks.push(...pageTracks);
        fetched += pageTracks.length;
        
        const pageElapsed = Date.now() - pageStartTime;
        const totalElapsed = Date.now() - fetchStartTime;
        const avgTimePerPage = totalElapsed / page;
        const remainingPages = useAll ? 0 : (pagesNeeded - page);
        const etaMs = avgTimePerPage * remainingPages;
        
        if (!useAll) {
          console.log(`  Page ${page}/${pagesNeeded}: ${fetched}/${needCount} scrobbles (${formatTime(pageElapsed)}, ETA: ${formatTime(etaMs)})`);
        } else if (page % 25 === 0) {
          console.log(`  Page ${page}: fetched=${fetched} (${formatTime(pageElapsed)})`);
        }
        
        if (page < pagesNeeded) {
          await new Promise((resolve) => setTimeout(resolve, 500)); // Rate limit between pages
        }
      }
      
      const fetchElapsed = Date.now() - fetchStartTime;
      console.log(`Downloaded ${fetched} scrobbles in ${formatTime(fetchElapsed)}\n`);
      
      // Get MBIDs for new scrobbles (if authenticated) - use cache and parallelize
      if (sessionKey) {
        console.log("Resolving MBIDs (using cache + parallel fetching)...");
        
        const scrobblesToAdd: Array<{
          track: string;
          artist: string;
          album?: string;
          mbid: string | null;
          timestamp: string;
        }> = [];
        
        // First pass: check cache and extract from track data
        const tracksNeedingMBID: Array<{ track: LastFMTrack; mbid: string | null }> = [];
        let cacheHits = 0;
        for (const track of allTracks) {
          // Check cache first
          let mbid = cache.getMBID(track.name, track.artist["#text"]);
          
          // If not in cache, check track data
          if (mbid === undefined) {
            mbid = track.mbid || track.artist?.mbid || null;
            // Always cache MBIDs from track data (even if null) to avoid re-checking
            cache.setMBID(track.name, track.artist["#text"], mbid);
          } else {
            cacheHits++;
          }
          
          tracksNeedingMBID.push({ track, mbid: mbid || null });
        }
        
        if (cacheHits > 0) {
          console.log(`  ${cacheHits}/${allTracks.length} MBIDs found in cache`);
        }
        
        const alreadyHaveMBID = tracksNeedingMBID.filter((t) => t.mbid).length;
        const needMBID = tracksNeedingMBID.filter((t) => !t.mbid);
        
        console.log(`  ${alreadyHaveMBID}/${allTracks.length} have MBIDs (from cache or track data)`);
        
        if (needMBID.length > 0) {
          // Check if we should use additional APIs for MBID resolution
          // useAdditionalAPIs is already declared at the top of main()
          
          console.log(`  Fetching MBIDs for ${needMBID.length} tracks in parallel (concurrency: ${concurrency})...`);
          if (useAdditionalAPIs) {
            console.log(`  Additional APIs enabled: MusicBrainz ISRC lookup (fallback if Last.fm fails)`);
          }
          
          // Fetch MBIDs in parallel batches
          const mbidChunks: Array<typeof needMBID> = [];
          for (let i = 0; i < needMBID.length; i += concurrency) {
            mbidChunks.push(needMBID.slice(i, i + concurrency));
          }
          
          const mbidFetchStartTime = Date.now();
          for (let chunkIdx = 0; chunkIdx < mbidChunks.length; chunkIdx++) {
            const chunk = mbidChunks[chunkIdx];
            const chunkStartTime = Date.now();
            const mbidPromises = chunk.map(async (item) => {
              const mbid = await getTrackMBID(
                item.track.name, 
                item.track.artist["#text"], 
                sessionKey, 
                cache,
                useAdditionalAPIs,
                apiMetrics
              );
              return { ...item, mbid };
            });
            
            const results = await Promise.all(mbidPromises);
            for (const result of results) {
              const idx = tracksNeedingMBID.findIndex((t) => t.track === result.track);
              if (idx >= 0) {
                tracksNeedingMBID[idx].mbid = result.mbid;
              }
            }
            
            const chunkElapsed = Date.now() - chunkStartTime;
            const totalElapsed = Date.now() - mbidFetchStartTime;
            const fetched = tracksNeedingMBID.filter((t) => t.mbid).length;
            const remaining = allTracks.length - fetched;
            
            if (chunkIdx % 5 === 0 || chunkIdx === mbidChunks.length - 1) {
              const avgTimePerChunk = totalElapsed / (chunkIdx + 1);
              const remainingChunks = mbidChunks.length - (chunkIdx + 1);
              const etaMs = avgTimePerChunk * remainingChunks;
              const progress = ((fetched / allTracks.length) * 100).toFixed(1);
              console.log(`  Batch ${chunkIdx + 1}/${mbidChunks.length}: ${fetched}/${allTracks.length} MBIDs (${progress}%, ${formatTime(chunkElapsed)}, ETA: ${formatTime(etaMs)})`);
            }
            
            if (chunkIdx < mbidChunks.length - 1) {
              await new Promise((resolve) => setTimeout(resolve, 100));
            }
          }
          
          const mbidFetchElapsed = Date.now() - mbidFetchStartTime;
          const finalFetched = tracksNeedingMBID.filter((t) => t.mbid).length;
          console.log(`  MBID resolution complete: ${finalFetched}/${allTracks.length} in ${formatTime(mbidFetchElapsed)}`);
        }
        
        // Convert to scrobbles format and add to cache
        for (const item of tracksNeedingMBID) {
          const timestamp = item.track.date?.["#text"] || new Date().toISOString();
          scrobblesToAdd.push({
            track: item.track.name,
            artist: item.track.artist["#text"],
            album: item.track.album?.["#text"],
            mbid: item.mbid || null,
            timestamp,
          });
        }
        
        // Add to cache (idempotent - ignores duplicates)
        added = cache.addScrobbles(cacheUsername, scrobblesToAdd);
        console.log(`  Added ${added} new scrobbles to cache (${scrobblesToAdd.length - added} were duplicates)\n`);
        
        const mbidCount = tracksNeedingMBID.filter((t) => t.mbid).length;
        console.log(`  ${mbidCount}/${allTracks.length} scrobbles have MBIDs (${(mbidCount / allTracks.length * 100).toFixed(1)}%)\n`);
      } else {
        // Public API - no MBIDs, just add to cache
        const scrobblesToAdd = allTracks.map((track) => ({
          track: track.name,
          artist: track.artist["#text"],
          album: track.album?.["#text"],
          mbid: track.mbid || track.artist.mbid || null,
          timestamp: track.date?.["#text"] || new Date().toISOString(),
        }));
        added = cache.addScrobbles(cacheUsername, scrobblesToAdd);
        console.log(`  Added ${added} new scrobbles to cache\n`);
      }
    }
    
    // Get final scrobbles from cache (now includes newly added)
    const finalScrobbles = cache.getScrobbles(cacheUsername, desiredLimit);
    scrobbles = finalScrobbles.map((s) => ({
      track: s.track,
      artist: s.artist,
      album: s.album,
      mbid: s.mbid,
    }));
    fromCache = finalScrobbles.length;
    
    if (added > 0) {
      console.log(`Cache updated: ${added} new scrobbles added, ${fromCache} total available\n`);
    }
  }

  // Evaluate
  console.log("Evaluating matching performance...\n");

  // Validate MBIDs exist in MusicBrainz (since evaluation has no time constraints).
  // This ensures ground truth quality: we only evaluate with MBIDs that actually exist.
  // validScrobbles was already initialized above, but for Last.fm path we filter here
  if (validScrobbles.length === 0) {
    validScrobbles = scrobbles.filter((s) => s.mbid);
  }
  
  if (validScrobbles.length === 0) {
    console.error("Error: No scrobbles with MBIDs found for evaluation");
    console.error("  For Last.fm: Ensure you're authenticated (OAuth) to get MBIDs");
    process.exit(1);
  }
  
  if (useAdditionalAPIs && validScrobbles.length > 0) {
    console.log(`Validating ${validScrobbles.length} MBIDs against MusicBrainz (ensuring ground truth quality)...`);
    const validationStartTime = Date.now();
    let validatedCount = 0;
    let invalidCount = 0;
    
    // Validate in parallel batches (but respect rate limits)
    const validationChunks: Array<typeof validScrobbles> = [];
    const validationConcurrency = 3; // Lower than evaluation to respect rate limits
    for (let i = 0; i < validScrobbles.length; i += validationConcurrency) {
      validationChunks.push(validScrobbles.slice(i, i + validationConcurrency));
    }
    
    const validScrobblesSet = new Set<typeof validScrobbles[0]>();
    
    for (let chunkIdx = 0; chunkIdx < validationChunks.length; chunkIdx++) {
      const chunk = validationChunks[chunkIdx];
      const validationPromises = chunk.map(async (s) => {
        const isValid = await validateMBID(s.mbid!, cache, apiMetrics);
        return { scrobble: s, isValid };
      });
      
      const results = await Promise.all(validationPromises);
      for (const result of results) {
        if (result.isValid) {
          validatedCount++;
          validScrobblesSet.add(result.scrobble);
        } else {
          invalidCount++;
        }
      }
      
      if (chunkIdx % 50 === 0 || chunkIdx === validationChunks.length - 1) {
        const progress = ((chunkIdx + 1) / validationChunks.length * 100).toFixed(1);
        console.log(`  Validated ${chunkIdx + 1}/${validationChunks.length} chunks (${progress}%): ${validatedCount} valid, ${invalidCount} invalid`);
      }
    }
    
    // Replace validScrobbles with only validated ones
    validScrobbles = Array.from(validScrobblesSet);
    
    const validationElapsed = Date.now() - validationStartTime;
    console.log(`MBID validation complete: ${validatedCount} valid, ${invalidCount} invalid (removed from evaluation) in ${formatTime(validationElapsed)}`);
    if (invalidCount > 0) {
      console.log(`  (Removed ${invalidCount} invalid MBIDs to ensure ground truth quality)\n`);
    } else {
      console.log();
    }
  }
  
  // Ensure validScrobbles is initialized (should be set in both paths above)
  if (validScrobbles.length === 0 && scrobbles.length > 0) {
    validScrobbles = scrobbles.filter((s) => s.mbid);
  }
  
  // Pre-validate all MBIDs before evaluation (eliminates bottleneck during evaluation)
  // This ensures all MBIDs are validated and cached before we start evaluating
  if (validScrobbles.length > 0) {
    console.log("Pre-validating MBIDs (ensures ground truth quality)...");
    const preValidationStartTime = Date.now();
    
    // Check which MBIDs need validation (not in cache)
    const mbidsToValidate = new Set<string>();
    const mbidsAlreadyValidated = new Set<string>();
    
    for (const s of validScrobbles) {
      if (s.mbid) {
        const cached = cache.getMBIDValidation(s.mbid);
        if (cached === undefined) {
          mbidsToValidate.add(s.mbid);
        } else if (cached === true) {
          mbidsAlreadyValidated.add(s.mbid);
        }
      }
    }
    
    const uniqueMBIDsToValidate = Array.from(mbidsToValidate);
    const alreadyValidatedCount = mbidsAlreadyValidated.size;
    
    console.log(`  ${alreadyValidatedCount}/${validScrobbles.length} MBIDs already validated (cached)`);
    
    if (uniqueMBIDsToValidate.length > 0) {
      console.log(`  Validating ${uniqueMBIDsToValidate.length} unique MBIDs in parallel (concurrency: ${concurrency})...`);
      
      // Validate in parallel batches
      const validationChunks: string[][] = [];
      for (let i = 0; i < uniqueMBIDsToValidate.length; i += concurrency) {
        validationChunks.push(uniqueMBIDsToValidate.slice(i, i + concurrency));
      }
      
      let validatedCount = 0;
      let invalidCount = 0;
      
      for (let chunkIdx = 0; chunkIdx < validationChunks.length; chunkIdx++) {
        const chunk = validationChunks[chunkIdx];
        const validationPromises = chunk.map(async (mbid) => {
          const isValid = await validateMBID(mbid, cache, apiMetrics);
          return { mbid, isValid };
        });
        
        const results = await Promise.all(validationPromises);
        for (const { mbid, isValid } of results) {
          if (isValid) {
            validatedCount++;
          } else {
            invalidCount++;
          }
        }
        
        // Progress log every 50 chunks or on last chunk
        if (chunkIdx % 50 === 0 || chunkIdx === validationChunks.length - 1) {
          const progress = ((chunkIdx + 1) / validationChunks.length * 100).toFixed(1);
          console.log(`  Validated ${chunkIdx + 1}/${validationChunks.length} chunks (${progress}%): ${validatedCount} valid, ${invalidCount} invalid so far`);
        }
      }
      
      // Filter out invalid MBIDs
      const validMBIDSet = new Set<string>();
      for (const s of validScrobbles) {
        if (s.mbid) {
          const isValid = cache.getMBIDValidation(s.mbid);
          if (isValid === true || isValid === undefined) {
            // Include if valid or not yet validated (assume valid to avoid false negatives)
            validMBIDSet.add(s.mbid);
          }
        }
      }
      
      validScrobbles = validScrobbles.filter((s) => s.mbid && validMBIDSet.has(s.mbid));
      
      const preValidationElapsed = Date.now() - preValidationStartTime;
      console.log(`Pre-validation complete: ${validatedCount} valid, ${invalidCount} invalid in ${formatTime(preValidationElapsed)}`);
      console.log(`  Filtered to ${validScrobbles.length} scrobbles with valid MBIDs\n`);
    } else {
      console.log(`  All MBIDs already validated (cached)\n`);
    }
  }
  
  if (validScrobbles.length === 0) {
    console.log("No scrobbles with MBIDs found. Evaluating without ground truth...\n");
    console.log("(This mode compares result counts, not accuracy)\n");
    
    let baselineCount = 0;
    let improvedCount = 0;
    let baselineTotalResults = 0;
    let improvedTotalResults = 0;

    for (let i = 0; i < scrobbles.length; i++) {
      const s = scrobbles[i];
      if (i % 10 === 0 || i === scrobbles.length - 1) {
        console.log(`  Evaluating ${i + 1}/${scrobbles.length}: "${s.track}" by ${s.artist}...`);
      }

      const baselineRes = await baselineSearch(s.track, s.artist, s.album, cache, apiMetrics);
      const improvedRes = await improvedSearchWithConfig(s.track, s.artist, s.album, searchConfig, cache, apiMetrics);

      if (baselineRes.length > 0) baselineCount++;
      if (improvedRes.length > 0) improvedCount++;
      baselineTotalResults += baselineRes.length;
      improvedTotalResults += improvedRes.length;
    }

    console.log("\nBASELINE (Simple Query):");
    console.log(`  Found results: ${baselineCount}/${scrobbles.length} (${(baselineCount / scrobbles.length * 100).toFixed(1)}%)`);
    console.log(`  Avg results per query: ${(baselineTotalResults / scrobbles.length).toFixed(1)}`);
    console.log("\nIMPROVED (Cleaning + Multi-Stage):");
    console.log(`  Found results: ${improvedCount}/${scrobbles.length} (${(improvedCount / scrobbles.length * 100).toFixed(1)}%)`);
    console.log(`  Avg results per query: ${(improvedTotalResults / scrobbles.length).toFixed(1)}`);
    console.log(`\nIMPROVEMENT: +${improvedCount - baselineCount} scrobbles (${((improvedCount - baselineCount) / scrobbles.length * 100).toFixed(1)}%)`);
    console.log(`  Result count change: ${improvedTotalResults - baselineTotalResults > 0 ? "+" : ""}${improvedTotalResults - baselineTotalResults}`);
    return;
  }

  // Baseline vs improved (default / only mode)
  // Evaluate with ground truth
  // Track metrics for different failure modes
  interface EvaluationCase {
    track: string;
    artist: string;
    album?: string;
    mbid: string;
    baselinePos: number; // -1 if not found
    improvedPos: number; // -1 if not found
    baselineFound: boolean;
    improvedFound: boolean;
    baselineNDCG: number; // NDCG@25 for baseline search
    improvedNDCG: number; // NDCG@25 for improved search
    failureMode?: string; // "featuring", "remix", "live", "typo", "none"
    duplicateCount?: number; // How many times this track+artist+mbid appears
    fieldCombination?: string; // "track+artist", "track_only", "track+album"
  }

  // Deduplicate scrobbles by (track, artist, mbid) to avoid overweighting
  // This aligns with IR evaluation best practices: measure unique query performance
  const deduplicationKey = (s: typeof validScrobbles[0]) => 
    `${s.track.toLowerCase().trim()}::${s.artist.toLowerCase().trim()}::${s.mbid}`;
  
  const seen = new Map<string, typeof validScrobbles[0] & { count: number }>();
  for (const s of validScrobbles) {
    const key = deduplicationKey(s);
    if (seen.has(key)) {
      seen.get(key)!.count++;
    } else {
      seen.set(key, { ...s, count: 1 });
    }
  }
  
  const uniqueScrobbles = Array.from(seen.values());
  const duplicateStats = {
    total: validScrobbles.length,
    unique: uniqueScrobbles.length,
    duplicates: validScrobbles.length - uniqueScrobbles.length,
    maxDuplicates: Math.max(...uniqueScrobbles.map(s => s.count)),
  };
  
  console.log(`\nDEDUPLICATION:`);
  console.log(`  Total scrobbles: ${duplicateStats.total}`);
  console.log(`  Unique (track+artist+mbid): ${duplicateStats.unique}`);
  console.log(`  Duplicates removed: ${duplicateStats.duplicates} (${(duplicateStats.duplicates / duplicateStats.total * 100).toFixed(1)}%)`);
  console.log(`  Max duplicates per track: ${duplicateStats.maxDuplicates}`);
  console.log(`  Evaluation will use ${uniqueScrobbles.length} unique cases`);
  console.log(`  (Deduplication prevents popular tracks from overweighting the evaluation)`);
  console.log(`  (This aligns with IR evaluation best practices: measure unique query performance)\n`);

  // Expand evaluation cases to include single-field searches (track only)
  // This tests real user behavior: users might search with track only (no artist)
  const expandedCases: Array<typeof uniqueScrobbles[0] & { fieldCombination: string }> = [];
  
  for (const scrobble of uniqueScrobbles) {
    // Original case: track + artist (current behavior)
    expandedCases.push({ ...scrobble, fieldCombination: "track+artist" });
    
    // Single-field case: track only (no artist) - tests real user behavior
    // Only add if track name is meaningful (not empty, not too short)
    if (scrobble.track && scrobble.track.trim().length >= 3) {
      expandedCases.push({ 
        ...scrobble, 
        artist: "", // Empty artist for track-only search
        fieldCombination: "track_only" 
      });
    }
  }
  
  console.log(`INPUT SPACE EXPANSION:`);
  console.log(`  Original cases: ${uniqueScrobbles.length} (track+artist)`);
  console.log(`  Expanded cases: ${expandedCases.length} (includes track-only searches)`);
  console.log(`  Track-only cases: ${expandedCases.filter(c => c.fieldCombination === "track_only").length}`);
  console.log(`  (Tests real user behavior: users might search with track only)\n`);

  const cases: EvaluationCase[] = [];
  let baselineP1 = 0;
  let baselineP5 = 0;
  let baselineP10 = 0;
  let baselineP25 = 0;
  let baselineFound = 0; // Recall/Findability - found anywhere in results
  let improvedP1 = 0;
  let improvedP5 = 0;
  let improvedP10 = 0;
  let improvedP25 = 0;
  let improvedFound = 0; // Recall/Findability - found anywhere in results
  let baselineBetter = 0;
  let improvedBetter = 0;
  let bothSame = 0;
  let baselineMRR = 0; // Mean Reciprocal Rank
  let improvedMRR = 0;

  // Categorize failure modes - helps understand what makes matching hard
  function categorizeFailureMode(track: string, artist: string): string {
    const trackLower = track.toLowerCase();
    const artistLower = artist.toLowerCase();
    
    // Check for featuring patterns (most common issue)
    if (/\bfeat\.?\b|\bft\.?\b|\bfeaturing\b/i.test(track) || 
        /\bfeat\.?\b|\bft\.?\b|\bfeaturing\b/i.test(artist) ||
        /\(feat\.|\(ft\.|\(featuring/i.test(track)) {
      return "featuring";
    }
    
    // Check for remix patterns
    if (/\bremix\b|\brmx\b|\bre-?mix/i.test(track) ||
        /\(remix\)|\[remix\]/i.test(track)) {
      return "remix";
    }
    
    // Check for live versions
    if (/\blive\b/i.test(track) ||
        /\(live\)|\[live\]/i.test(track)) {
      return "live";
    }
    
    // Check for other parenthetical content (years, versions, etc.)
    if (/\([^)]+\)|\[[^\]]+\]/.test(track)) {
      return "parenthetical";
    }
    
    // Check for special characters or unusual formatting
    if (/[^\w\s\-'&]/.test(track) || /[^\w\s\-'&]/.test(artist)) {
      return "special_chars";
    }
    
    // Check for very short names (might be harder to match)
    if (track.length < 5 || artist.length < 5) {
      return "short_name";
    }
    
    return "standard";
  }

  // Classify query hardness based on baseline performance and query characteristics
  // Hardness levels: "easy", "medium", "hard"
  // Based on IR evaluation best practices: hardness is defined by baseline effectiveness
  // and query characteristics (ambiguity, specificity, context)
  function classifyHardness(
    track: string,
    artist: string,
    failureMode: string,
    baselinePos: number,
    baselineFound: boolean
  ): "easy" | "medium" | "hard" {
    const trackLower = track.toLowerCase().trim();
    const artistLower = artist.toLowerCase().trim();
    
    // Primary hardness signal: Baseline performance
    // IR best practice: Use baseline effectiveness (AP/NDCG/position) as primary hardness indicator
    // Easy: Baseline finds it at P1-P5 (good baseline performance)
    // Medium: Baseline finds it at P6-P25 or not found but query has sufficient context
    // Hard: Baseline doesn't find it AND query is ambiguous/underspecified
    
    // Easy: Baseline already performs well (found in top 5)
    if (baselineFound && baselinePos >= 0 && baselinePos < 5) {
      return "easy";
    }
    
    // Medium: Baseline found it but lower in results (P6-P25)
    // These are queries where improved search can help with ranking
    if (baselineFound && baselinePos >= 5 && baselinePos < 25) {
      return "medium";
    }
    
    // For not-found cases, check query characteristics to determine hardness
    if (!baselineFound) {
      // Query characteristics that indicate hardness (ambiguity, underspecification)
      const ambiguousWords = new Set([
        "air", "one", "two", "three", "four", "five", "six", "seven", "eight", "nine", "ten",
        "song", "track", "music", "beat", "sound", "tune", "piece", "high", "low", "new", "old",
        "love", "time", "life", "day", "night", "sun", "moon", "star", "sky", "sea", "water",
        "fire", "wind", "earth", "light", "dark", "red", "blue", "green", "black", "white",
        "big", "small", "good", "bad", "yes", "no", "ok", "okay", "hi", "hey", "hello", "bye",
        "go", "come", "get", "take", "give", "make", "do", "be", "see", "know", "think", "say",
        "want", "need", "like", "can", "will", "may", "must", "should", "could", "would",
      ]);
      
      const trackWords = trackLower.split(/\s+/).filter(w => w.length > 0);
      
      // Hard indicators (check these first - most restrictive):
      // 1. Potential typos (very short names <3 chars) - data quality issue (most severe, check first)
      if (artist.length < 3 || track.length < 3) {
        return "hard";
      }
      
      // 2. Very short track name (<4 chars) - inherently ambiguous
      if (track.length < 4) {
        return "hard";
      }
      
      // 3. Numeric-only track names - ambiguous without context
      if (/^\d+$/.test(track.trim())) {
        return "hard";
      }
      
      // 4. Single-word common word (ambiguous)
      if (trackWords.length === 1 && ambiguousWords.has(trackWords[0])) {
        return "hard";
      }
      
      // Medium: Not found by baseline but query has sufficient context (not ambiguous)
      // These are cases where improved search should be able to help
      // Check this BEFORE defaulting to hard - if query has good context, it's medium
      // This applies to both track+artist AND track-only searches with specific names
      
      // For track+artist searches: check if both have sufficient context
      if (artist && artist.length >= 3 && track.length >= 4) {
        // Multi-word track name (more specific, less ambiguous)
        if (trackWords.length > 1) {
          return "medium";
        }
        // Single word that's NOT in ambiguous set (specific enough)
        if (trackWords.length === 1 && !ambiguousWords.has(trackWords[0])) {
          return "medium";
        }
      }
      
      // For track-only searches: check if track name is specific enough
      if (!artist || artist.trim().length === 0) {
        // Track-only with very short name or common word is hard
        if (track.length < 6 || (trackWords.length === 1 && ambiguousWords.has(trackWords[0]))) {
          return "hard";
        }
        // Track-only with multi-word name (more specific) can be medium
        if (trackWords.length > 1 && track.length >= 6) {
          return "medium";
        }
        // Track-only with single word that's NOT ambiguous can be medium
        if (trackWords.length === 1 && !ambiguousWords.has(trackWords[0]) && track.length >= 6) {
          return "medium";
        }
        // Otherwise, track-only is hard (ambiguous or too short)
        return "hard";
      }
      
      // Default not-found cases to hard (conservative - if we can't classify as medium, assume hard)
      return "hard";
    }
    
    // Default to medium for edge cases (shouldn't reach here, but safety fallback)
    return "medium";
  }

  // Track cache hit rates for evaluation (thread-safe using return values)
  interface EvaluationCaseWithCacheStats extends EvaluationCase {
    baselineCacheHit: boolean;
    improvedCacheHit: boolean;
  }
  
  // Track API call metrics (for performance analysis)
  interface APIMetrics {
    musicbrainzCalls: number;
    musicbrainzRateLimits: number;
    musicbrainzErrors: number;
    lastfmCalls: number;
    lastfmErrors: number;
    totalAPICallTime: number; // milliseconds
  }
  
  // apiMetrics already initialized earlier (before validation)

  // Parallel evaluation for speed
  const evaluationStartTime = Date.now();
  let lastLogTime = evaluationStartTime;
  
  async function evaluateCase(
    s: typeof expandedCases[0], 
    index: number, 
    total: number
  ): Promise<EvaluationCaseWithCacheStats> {
    const caseStartTime = Date.now();
    const logInterval = total > 200 ? 50 : total > 50 ? 25 : 10;
    
    // Check if entire evaluation result is cached (instant re-runs)
    // Include fieldCombination in cache key to distinguish track-only vs track+artist
    const fieldCombo = s.fieldCombination || (s.artist ? "track+artist" : "track_only");
    const cachedResult = cache.getEvaluationResult(
      s.track,
      s.artist || "", // Normalize empty artist to empty string for cache key
      s.album,
      s.mbid!,
      searchConfig,
      fieldCombo
    );
    
    if (cachedResult) {
      // Return cached result instantly - no processing needed
      const caseElapsed = Date.now() - caseStartTime;
      
      // Log progress (only periodically to avoid spam)
      const now = Date.now();
      const shouldLog = index % logInterval === 0 || index === total - 1 || (now - lastLogTime) > 2000;
      
      if (shouldLog) {
        const progress = ((index + 1) / total * 100).toFixed(1);
        const elapsed = now - evaluationStartTime;
        const avgTimePerCase = elapsed / (index + 1);
        const remaining = total - (index + 1);
        const etaMs = avgTimePerCase * remaining;
        
        const dupInfo = s.count > 1 ? ` (${s.count}x)` : "";
        const timingInfo = ` [${formatTime(caseElapsed)}/case, ETA: ${calculateETA(elapsed, index + 1, total)}]`;
        
        console.log(`  ${index + 1}/${total} (${progress}%): "${s.track}" by ${s.artist}${dupInfo} [evaluation cached]${timingInfo}`);
        lastLogTime = now;
      }
      
      // Recalculate hardness (not cached, calculated dynamically using baseline performance)
      const hardness = classifyHardness(
        s.track,
        s.artist || "",
        cachedResult.failureMode || "standard",
        cachedResult.baselinePos,
        cachedResult.baselineFound
      );
      return {
        track: s.track,
        artist: s.artist,
        album: s.album,
        mbid: s.mbid!,
        baselinePos: cachedResult.baselinePos,
        improvedPos: cachedResult.improvedPos,
        baselineFound: cachedResult.baselineFound,
        improvedFound: cachedResult.improvedFound,
        baselineNDCG: cachedResult.baselineNDCG,
        improvedNDCG: cachedResult.improvedNDCG,
        failureMode: cachedResult.failureMode,
        hardness,
        duplicateCount: cachedResult.duplicateCount,
        baselineCacheHit: true, // Evaluation result cached means search was cached too
        improvedCacheHit: true,
      };
    }
    
    // Not cached - need to evaluate
    // Check cache before searching (for reporting - search functions handle caching internally)
    // Baseline always uses: no cleaning, no fuzzy, no multistage
    // Handle single-field searches: if artist is empty, search with track only
    const baselineCached = cache.getSearchResults(s.track, s.artist || undefined, s.album, false, false, false) !== null;
    const baselineRes = await baselineSearch(s.track, s.artist || "", s.album, cache, apiMetrics);
    
    // For improved search, check cache for cleaned version with actual config
    // Handle single-field searches: if artist is empty, search with track only
    const cleanedTrack = searchConfig.enableCleaning ? cleanTrackName(s.track) : s.track;
    const cleanedArtist = s.artist ? (searchConfig.enableCleaning ? cleanArtistName(s.artist) : s.artist) : undefined;
    const improvedCached = cache.getSearchResults(
      cleanedTrack || s.track, 
      cleanedArtist || s.artist || undefined, 
      s.album,
      searchConfig.enableCleaning,
      searchConfig.enableFuzzy,
      searchConfig.enableMultiStage
    ) !== null;
    const improvedRes = await improvedSearchWithConfig(s.track, s.artist || "", s.album, searchConfig, cache, apiMetrics);
    
    const caseElapsed = Date.now() - caseStartTime;
    
    // Log progress with timing and ETA (only log periodically to avoid spam)
    const now = Date.now();
    const shouldLog = index % logInterval === 0 || index === total - 1 || (now - lastLogTime) > 2000;
    
    if (shouldLog) {
      const progress = ((index + 1) / total * 100).toFixed(1);
      const elapsed = now - evaluationStartTime;
      const avgTimePerCase = elapsed / (index + 1);
      const remaining = total - (index + 1);
      const etaMs = avgTimePerCase * remaining;
      
      const dupInfo = s.count > 1 ? ` (${s.count}x)` : "";
      const cacheInfo = baselineCached && improvedCached ? " [cached]" : baselineCached || improvedCached ? " [partial]" : "";
      const timingInfo = ` [${formatTime(caseElapsed)}/case, ETA: ${calculateETA(elapsed, index + 1, total)}]`;
      
      console.log(`  ${index + 1}/${total} (${progress}%): "${s.track}" by ${s.artist}${dupInfo}${cacheInfo}${timingInfo}`);
      lastLogTime = now;
    }

    const baselineIds = baselineRes
      .slice(0, 25)
      .map((r) => r.id)
      .filter((id): id is string => !!id);
    const improvedIds = improvedRes
      .slice(0, 25)
      .map((r) => r.id)
      .filter((id): id is string => !!id);

    // Calculate position (0-indexed) if found, -1 if not found
    // Use indexOf once (more efficient than includes + indexOf)
    const baselinePos = baselineIds.indexOf(s.mbid!);
    const improvedPos = improvedIds.indexOf(s.mbid!);
    
    // Check if MBID is found anywhere (for findability metric)
    const baselineFoundAnywhere = baselinePos >= 0;
    const improvedFoundAnywhere = improvedPos >= 0;

    // Calculate NDCG@25 for both searches
    // Build relevance arrays: 1 if result matches expected MBID, 0 otherwise
    const baselineRelevance = baselineIds.map(id => id === s.mbid! ? 1 : 0);
    const improvedRelevance = improvedIds.map(id => id === s.mbid! ? 1 : 0);
    
    const baselineNDCG = ndcg(baselineRelevance, 25);
    const improvedNDCG = ndcg(improvedRelevance, 25);

    const failureMode = s.artist ? categorizeFailureMode(s.track, s.artist) : "track_only";
    // Hardness is calculated after baseline search to use baseline performance as signal
    const hardness = classifyHardness(s.track, s.artist || "", failureMode, baselinePos, baselineFoundAnywhere);
    
    const result = {
      track: s.track,
      artist: s.artist || "",
      album: s.album,
      mbid: s.mbid!,
      baselinePos,
      improvedPos,
      baselineFound: baselineFoundAnywhere,
      improvedFound: improvedFoundAnywhere,
      baselineNDCG,
      improvedNDCG,
      failureMode,
      hardness,
      duplicateCount: s.count,
      fieldCombination: s.fieldCombination || (s.artist ? "track+artist" : "track_only"),
      baselineCacheHit: baselineCached,
      improvedCacheHit: improvedCached,
    };
    
    // Cache the evaluation result for instant re-runs
    cache.setEvaluationResult(
      s.track,
      s.artist,
      s.album,
      s.mbid!,
      searchConfig,
      {
        baselinePos,
        improvedPos,
        baselineFound: baselineFoundAnywhere,
        improvedFound: improvedFoundAnywhere,
        baselineNDCG,
        improvedNDCG,
        failureMode,
        duplicateCount: s.count,
      },
      s.fieldCombination || (s.artist ? "track+artist" : "track_only")
    );
    
    return result;
  }

  // Evaluate cases (parallel or sequential) - use expanded set (includes single-field searches)
  let baselineCacheHits = 0;
  let improvedCacheHits = 0;
  let evaluationResultCacheHits = 0;
  let totalSearches = 0;
  
  if (parallel && concurrency > 1) {
    console.log(`  Using parallel evaluation (concurrency: ${concurrency})...\n`);
    const chunks: Array<typeof expandedCases[0]>[] = [];
    for (let i = 0; i < expandedCases.length; i += concurrency) {
      chunks.push(expandedCases.slice(i, i + concurrency));
    }
    
    for (let chunkIdx = 0; chunkIdx < chunks.length; chunkIdx++) {
      const chunk = chunks[chunkIdx];
      const chunkStartTime = Date.now();
      const chunkCases = await Promise.all(
        chunk.map((s, idx) => evaluateCase(s, chunkIdx * concurrency + idx, expandedCases.length))
      );
      
      const chunkElapsed = Date.now() - chunkStartTime;
      const totalElapsed = Date.now() - evaluationStartTime;
      const completed = (chunkIdx + 1) * concurrency;
      const remaining = expandedCases.length - completed;
      const avgTimePerChunk = totalElapsed / (chunkIdx + 1);
      const etaMs = avgTimePerChunk * (chunks.length - chunkIdx - 1);
      
      // Log chunk progress with detailed metrics
      const shouldLogChunk = chunkIdx % 10 === 0 || chunkIdx === chunks.length - 1;
      if (shouldLogChunk) {
        const progress = ((completed / expandedCases.length) * 100).toFixed(1);
        const cacheHitRate = totalSearches > 0 
          ? (((baselineCacheHits + improvedCacheHits) / totalSearches) * 100).toFixed(1)
          : "0.0";
        const evalCacheHitRate = evaluationResultCacheHits > 0 && completed > 0
          ? ((evaluationResultCacheHits / completed) * 100).toFixed(1)
          : "0.0";
        console.log(`  Chunk ${chunkIdx + 1}/${chunks.length}: ${Math.min(completed, expandedCases.length)}/${expandedCases.length} cases (${progress}%, ${formatTime(chunkElapsed)}, ETA: ${formatTime(etaMs)}, cache: ${cacheHitRate}%, eval cache: ${evalCacheHitRate}%)`);
      }
      
      // Aggregate cache stats (thread-safe - each case returns its own stats)
      for (const caseResult of chunkCases) {
        if (caseResult.baselineCacheHit) baselineCacheHits++;
        if (caseResult.improvedCacheHit) improvedCacheHits++;
        // Check if this was a fully cached evaluation result (instant return)
        if (caseResult.baselineCacheHit && caseResult.improvedCacheHit && caseResult.baselinePos !== undefined) {
          evaluationResultCacheHits++;
        }
        totalSearches += 2; // baseline + improved
        
        // Convert to EvaluationCase (drop cache stats)
      // Recalculate hardness (not cached, calculated dynamically using baseline performance)
      const hardness = classifyHardness(
        caseResult.track,
        caseResult.artist,
        caseResult.failureMode || "standard",
        caseResult.baselinePos,
        caseResult.baselineFound
      );
        cases.push({
          track: caseResult.track,
          artist: caseResult.artist,
          album: caseResult.album,
          mbid: caseResult.mbid,
          baselinePos: caseResult.baselinePos,
          improvedPos: caseResult.improvedPos,
          baselineFound: caseResult.baselineFound,
          improvedFound: caseResult.improvedFound,
          baselineNDCG: caseResult.baselineNDCG,
          improvedNDCG: caseResult.improvedNDCG,
          failureMode: caseResult.failureMode,
        hardness,
          duplicateCount: caseResult.duplicateCount,
          fieldCombination: caseResult.fieldCombination,
        });
      }
    }
  } else {
    for (let i = 0; i < expandedCases.length; i++) {
      const caseResult = await evaluateCase(expandedCases[i], i, expandedCases.length);
      if (caseResult.baselineCacheHit) baselineCacheHits++;
      if (caseResult.improvedCacheHit) improvedCacheHits++;
      // Check if this was a fully cached evaluation result (instant return)
      if (caseResult.baselineCacheHit && caseResult.improvedCacheHit && caseResult.baselinePos !== undefined) {
        evaluationResultCacheHits++;
      }
      totalSearches += 2; // baseline + improved
      
      // Convert to EvaluationCase (drop cache stats)
      // Recalculate hardness (not cached, calculated dynamically using baseline performance)
      const hardness = classifyHardness(
        caseResult.track,
        caseResult.artist,
        caseResult.failureMode || "standard",
        caseResult.baselinePos,
        caseResult.baselineFound
      );
      cases.push({
        track: caseResult.track,
        artist: caseResult.artist,
        album: caseResult.album,
        mbid: caseResult.mbid,
        baselinePos: caseResult.baselinePos,
        improvedPos: caseResult.improvedPos,
        baselineFound: caseResult.baselineFound,
        improvedFound: caseResult.improvedFound,
        baselineNDCG: caseResult.baselineNDCG,
        improvedNDCG: caseResult.improvedNDCG,
        failureMode: caseResult.failureMode,
        hardness,
        duplicateCount: caseResult.duplicateCount,
        fieldCombination: caseResult.fieldCombination,
      });
    }
  }
  
  const evaluationElapsed = Date.now() - evaluationStartTime;
  const avgTimePerCase = cases.length > 0 ? evaluationElapsed / cases.length : 0;
  console.log(`\nEvaluation complete: ${cases.length} cases in ${formatTime(evaluationElapsed)} (avg: ${formatTime(avgTimePerCase)}/case)\n`);

  // Calculate metrics from cases
  // Position distribution tracking
  const baselinePositions: number[] = []; // -1 for not found, 0-4 for positions
  const improvedPositions: number[] = [];
  const trackLengths: number[] = [];
  const artistLengths: number[] = [];
  let baselineNDCGSum = 0;
  let improvedNDCGSum = 0;
  
  // Track position distribution by field combination
  const positionByFieldCombo: Record<string, {
    baseline: number[];
    improved: number[];
  }> = {};
  
  for (const c of cases) {
    // Track position distribution by field combination
    const combo = c.fieldCombination || "track+artist";
    if (!positionByFieldCombo[combo]) {
      positionByFieldCombo[combo] = { baseline: [], improved: [] };
    }
    positionByFieldCombo[combo].baseline.push(c.baselinePos);
    positionByFieldCombo[combo].improved.push(c.improvedPos);
    // Precision@K metrics (user effort - how many results to scroll through)
    if (c.baselinePos === 0) baselineP1++;
    if (c.baselinePos >= 0 && c.baselinePos < 5) baselineP5++;
    if (c.baselinePos >= 0 && c.baselinePos < 10) baselineP10++;
    if (c.baselinePos >= 0 && c.baselinePos < 25) baselineP25++;
    if (c.baselineFound) baselineFound++; // Recall/Findability
    
    if (c.improvedPos === 0) improvedP1++;
    if (c.improvedPos >= 0 && c.improvedPos < 5) improvedP5++;
    if (c.improvedPos >= 0 && c.improvedPos < 10) improvedP10++;
    if (c.improvedPos >= 0 && c.improvedPos < 25) improvedP25++;
    if (c.improvedFound) improvedFound++; // Recall/Findability

    // Mean Reciprocal Rank (MRR): 1/position if found, 0 if not
    baselineMRR += c.baselineFound ? 1 / (c.baselinePos + 1) : 0;
    improvedMRR += c.improvedFound ? 1 / (c.improvedPos + 1) : 0;
    
    // NDCG@25 (already calculated per case)
    baselineNDCGSum += c.baselineNDCG;
    improvedNDCGSum += c.improvedNDCG;
    
    // Track position distributions
    baselinePositions.push(c.baselineFound ? c.baselinePos : -1);
    improvedPositions.push(c.improvedFound ? c.improvedPos : -1);
    
    // Track name lengths for analysis
    trackLengths.push(c.track.length);
    artistLengths.push(c.artist.length);

    // Track which method performed better
    if (c.baselineFound && !c.improvedFound) {
      baselineBetter++;
    } else if (c.improvedFound && !c.baselineFound) {
      improvedBetter++;
    } else if (c.baselineFound && c.improvedFound) {
      // Both found - check position
      if (c.baselinePos < c.improvedPos) {
        baselineBetter++;
      } else if (c.improvedPos < c.baselinePos) {
        improvedBetter++;
      } else {
        bothSame++;
      }
    } else {
      bothSame++; // Neither found
    }
  }

  baselineMRR /= cases.length;
  improvedMRR /= cases.length;
  const baselineNDCG = baselineNDCGSum / cases.length;
  const improvedNDCG = improvedNDCGSum / cases.length;

  // Prepare boolean arrays for statistical tests
  const baselineP1Array = cases.map(c => c.baselinePos === 0);
  const baselineP5Array = cases.map(c => c.baselinePos >= 0 && c.baselinePos < 5);
  const baselineP10Array = cases.map(c => c.baselinePos >= 0 && c.baselinePos < 10);
  const baselineP25Array = cases.map(c => c.baselinePos >= 0 && c.baselinePos < 25);
  const baselineFoundArray = cases.map(c => c.baselineFound); // Recall/Findability
  
  const improvedP1Array = cases.map(c => c.improvedPos === 0);
  const improvedP5Array = cases.map(c => c.improvedPos >= 0 && c.improvedPos < 5);
  const improvedP10Array = cases.map(c => c.improvedPos >= 0 && c.improvedPos < 10);
  const improvedP25Array = cases.map(c => c.improvedPos >= 0 && c.improvedPos < 25);
  const improvedFoundArray = cases.map(c => c.improvedFound); // Recall/Findability

  // Calculate bootstrap confidence intervals for all metrics
  const [baselineP1Point, baselineP1Lower, baselineP1Upper] = bootstrapCI(
    baselineP1Array,
    (vals) => (vals.filter((v) => v).length / vals.length) * 100
  );
  const [baselineP5Point, baselineP5Lower, baselineP5Upper] = bootstrapCI(
    baselineP5Array,
    (vals) => (vals.filter((v) => v).length / vals.length) * 100
  );
  const [baselineP10Point, baselineP10Lower, baselineP10Upper] = bootstrapCI(
    baselineP10Array,
    (vals) => (vals.filter((v) => v).length / vals.length) * 100
  );
  const [baselineP25Point, baselineP25Lower, baselineP25Upper] = bootstrapCI(
    baselineP25Array,
    (vals) => (vals.filter((v) => v).length / vals.length) * 100
  );
  const [baselineFoundPoint, baselineFoundLower, baselineFoundUpper] = bootstrapCI(
    baselineFoundArray,
    (vals) => (vals.filter((v) => v).length / vals.length) * 100
  );
  
  const [improvedP1Point, improvedP1Lower, improvedP1Upper] = bootstrapCI(
    improvedP1Array,
    (vals) => (vals.filter((v) => v).length / vals.length) * 100
  );
  const [improvedP5Point, improvedP5Lower, improvedP5Upper] = bootstrapCI(
    improvedP5Array,
    (vals) => (vals.filter((v) => v).length / vals.length) * 100
  );
  const [improvedP10Point, improvedP10Lower, improvedP10Upper] = bootstrapCI(
    improvedP10Array,
    (vals) => (vals.filter((v) => v).length / vals.length) * 100
  );
  const [improvedP25Point, improvedP25Lower, improvedP25Upper] = bootstrapCI(
    improvedP25Array,
    (vals) => (vals.filter((v) => v).length / vals.length) * 100
  );
  const [improvedFoundPoint, improvedFoundLower, improvedFoundUpper] = bootstrapCI(
    improvedFoundArray,
    (vals) => (vals.filter((v) => v).length / vals.length) * 100
  );

  // McNemar's test for statistical significance (primary metrics)
  const mcnemarP1 = mcnemarTest(baselineP1Array, improvedP1Array);
  const mcnemarP5 = mcnemarTest(baselineP5Array, improvedP5Array);
  const mcnemarFound = mcnemarTest(baselineFoundArray, improvedFoundArray);

  // Effect size (Cohen's h)
  const effectSizeP1 = cohensH(baselineP1Point, improvedP1Point);
  const effectSizeP5 = cohensH(baselineP5Point, improvedP5Point);
  const effectSizeFound = cohensH(baselineFoundPoint, improvedFoundPoint);

  // Confidence interval for difference
  const diffP1Array = improvedP1Array.map((imp, i) => imp && !baselineP1Array[i]);
  const diffP5Array = improvedP5Array.map((imp, i) => imp && !baselineP5Array[i]);
  const diffFoundArray = improvedFoundArray.map((imp, i) => imp && !baselineFoundArray[i]);
  const [diffP1Point, diffP1Lower, diffP1Upper] = bootstrapCI(
    diffP1Array,
    (vals) => (vals.filter((v) => v).length / vals.length) * 100
  );
  const [diffP5Point, diffP5Lower, diffP5Upper] = bootstrapCI(
    diffP5Array,
    (vals) => (vals.filter((v) => v).length / vals.length) * 100
  );
  const [diffFoundPoint, diffFoundLower, diffFoundUpper] = bootstrapCI(
    diffFoundArray,
    (vals) => (vals.filter((v) => v).length / vals.length) * 100
  );

  const totalElapsed = Date.now() - startTime;
  
  // API call metrics (if any API calls were made)
  if (apiMetrics.musicbrainzCalls > 0 || apiMetrics.lastfmCalls > 0) {
    console.log("\nAPI CALL METRICS:");
    console.log(`  MusicBrainz: ${apiMetrics.musicbrainzCalls} calls`);
    if (apiMetrics.musicbrainzRateLimits > 0) {
      console.log(`    Rate limits: ${apiMetrics.musicbrainzRateLimits} (${((apiMetrics.musicbrainzRateLimits / apiMetrics.musicbrainzCalls) * 100).toFixed(1)}%)`);
    }
    if (apiMetrics.musicbrainzErrors > 0) {
      console.log(`    Errors: ${apiMetrics.musicbrainzErrors} (${((apiMetrics.musicbrainzErrors / apiMetrics.musicbrainzCalls) * 100).toFixed(1)}%)`);
    }
    if (apiMetrics.lastfmCalls > 0) {
      console.log(`  Last.fm: ${apiMetrics.lastfmCalls} calls`);
      if (apiMetrics.lastfmErrors > 0) {
        console.log(`    Errors: ${apiMetrics.lastfmErrors} (${((apiMetrics.lastfmErrors / apiMetrics.lastfmCalls) * 100).toFixed(1)}%)`);
      }
    }
    if (apiMetrics.totalAPICallTime > 0) {
      const avgAPITime = apiMetrics.totalAPICallTime / (apiMetrics.musicbrainzCalls + apiMetrics.lastfmCalls);
      console.log(`  Total API time: ${formatTime(apiMetrics.totalAPICallTime)} (avg: ${formatTime(avgAPITime)}/call)`);
    }
    console.log();
  }
  
  console.log("\n" + "=".repeat(60));
  console.log("EVALUATION RESULTS (DEDUPLICATED)");
  console.log("=".repeat(60));
  console.log(`\nTest set: ${cases.length} unique scrobbles (from ${validScrobbles.length} total with MBIDs)`);
  console.log(`Total scrobbles: ${scrobbles.length}`);
  console.log(`Deduplication: ${duplicateStats.duplicates} duplicates removed (${(duplicateStats.duplicates / duplicateStats.total * 100).toFixed(1)}%)`);
  if (totalSearches > 0) {
    const baselineHitRate = ((baselineCacheHits / cases.length) * 100).toFixed(1);
    const improvedHitRate = ((improvedCacheHits / cases.length) * 100).toFixed(1);
    const overallHitRate = (((baselineCacheHits + improvedCacheHits) / totalSearches) * 100).toFixed(1);
    console.log(`Cache performance: Baseline ${baselineHitRate}% hits, Improved ${improvedHitRate}% hits, Overall ${overallHitRate}%`);
    if (evaluationResultCacheHits > 0) {
      const evalCacheHitRate = ((evaluationResultCacheHits / cases.length) * 100).toFixed(1);
      console.log(`  Evaluation results: ${evaluationResultCacheHits}/${cases.length} (${evalCacheHitRate}% fully cached - instant re-runs!)`);
    }
    console.log(`  (Cache avoids ${totalSearches - baselineCacheHits - improvedCacheHits} redundant API calls)`);
  }
  console.log(`Total time: ${formatTime(totalElapsed)}`);
  
  // Performance metrics
  if (cases.length > 0) {
    const avgTimePerCase = totalElapsed / cases.length;
    const casesPerSecond = cases.length / (totalElapsed / 1000);
    console.log(`Performance: ${formatTime(avgTimePerCase)}/case, ${casesPerSecond.toFixed(2)} cases/sec`);
    
    // Breakdown by cache status
    const cachedCases = cases.filter(c => c.baselineCacheHit && c.improvedCacheHit).length;
    const uncachedCases = cases.length - cachedCases;
    if (cachedCases > 0 && uncachedCases > 0) {
      const cachedTime = totalElapsed * (cachedCases / cases.length); // Estimate
      const uncachedTime = totalElapsed * (uncachedCases / cases.length); // Estimate
      console.log(`  Cached: ${cachedCases} cases (~${formatTime(cachedTime / cachedCases)}/case)`);
      console.log(`  Uncached: ${uncachedCases} cases (~${formatTime(uncachedTime / uncachedCases)}/case)`);
    }
    console.log();
  }
  
  console.log();

  console.log("BASELINE (Simple Query):");
  console.log(`  Precision@1: ${baselineP1Point.toFixed(1)}% [${baselineP1Lower.toFixed(1)}%, ${baselineP1Upper.toFixed(1)}%] (${baselineP1}/${cases.length}) - First result`);
  console.log(`  Precision@5: ${baselineP5Point.toFixed(1)}% [${baselineP5Lower.toFixed(1)}%, ${baselineP5Upper.toFixed(1)}%] (${baselineP5}/${cases.length}) - Top 5 (minimal scrolling)`);
  console.log(`  Precision@10: ${baselineP10Point.toFixed(1)}% [${baselineP10Lower.toFixed(1)}%, ${baselineP10Upper.toFixed(1)}%] (${baselineP10}/${cases.length}) - Top 10 (first screen)`);
  console.log(`  Precision@25: ${baselineP25Point.toFixed(1)}% [${baselineP25Lower.toFixed(1)}%, ${baselineP25Upper.toFixed(1)}%] (${baselineP25}/${cases.length}) - Top 25 (all results)`);
  console.log(`  Findability: ${baselineFoundPoint.toFixed(1)}% [${baselineFoundLower.toFixed(1)}%, ${baselineFoundUpper.toFixed(1)}%] (${baselineFound}/${cases.length}) - Found anywhere`);
  console.log(`  Mean Reciprocal Rank: ${baselineMRR.toFixed(3)} - Average rank quality`);
  console.log(`  NDCG@25: ${baselineNDCG.toFixed(3)} - Ranking quality (graded relevance)\n`);

  const configDesc = [
    searchConfig.enableCleaning ? "cleaning" : "no-cleaning",
    searchConfig.enableFuzzy ? "fuzzy" : "no-fuzzy",
    searchConfig.enableMultiStage ? "multistage" : "no-multistage",
  ].join(" + ");
  
  console.log(`IMPROVED (${configDesc}):`);
  console.log(`  Precision@1: ${improvedP1Point.toFixed(1)}% [${improvedP1Lower.toFixed(1)}%, ${improvedP1Upper.toFixed(1)}%] (${improvedP1}/${cases.length}) - First result`);
  console.log(`  Precision@5: ${improvedP5Point.toFixed(1)}% [${improvedP5Lower.toFixed(1)}%, ${improvedP5Upper.toFixed(1)}%] (${improvedP5}/${cases.length}) - Top 5 (minimal scrolling)`);
  console.log(`  Precision@10: ${improvedP10Point.toFixed(1)}% [${improvedP10Lower.toFixed(1)}%, ${improvedP10Upper.toFixed(1)}%] (${improvedP10}/${cases.length}) - Top 10 (first screen)`);
  console.log(`  Precision@25: ${improvedP25Point.toFixed(1)}% [${improvedP25Lower.toFixed(1)}%, ${improvedP25Upper.toFixed(1)}%] (${improvedP25}/${cases.length}) - Top 25 (all results)`);
  console.log(`  Findability: ${improvedFoundPoint.toFixed(1)}% [${improvedFoundLower.toFixed(1)}%, ${improvedFoundUpper.toFixed(1)}%] (${improvedFound}/${cases.length}) - Found anywhere`);
  console.log(`  Mean Reciprocal Rank: ${improvedMRR.toFixed(3)} - Average rank quality`);
  console.log(`  NDCG@25: ${improvedNDCG.toFixed(3)} - Ranking quality (graded relevance)\n`);

  const p1Improvement = improvedP1Point - baselineP1Point;
  const p5Improvement = improvedP5Point - baselineP5Point;
  const p10Improvement = improvedP10Point - baselineP10Point;
  const p25Improvement = improvedP25Point - baselineP25Point;
  const foundImprovement = improvedFoundPoint - baselineFoundPoint;
  const mrrImprovement = improvedMRR - baselineMRR;
  const ndcgImprovement = improvedNDCG - baselineNDCG;
  
  console.log("IMPROVEMENT (Primary Metrics):");
  console.log(`  Precision@1: ${p1Improvement > 0 ? "+" : ""}${p1Improvement.toFixed(1)}% [${diffP1Lower.toFixed(1)}%, ${diffP1Upper.toFixed(1)}%] - First result (no scrolling)`);
  console.log(`  Precision@5: ${p5Improvement > 0 ? "+" : ""}${p5Improvement.toFixed(1)}% [${diffP5Lower.toFixed(1)}%, ${diffP5Upper.toFixed(1)}%] - Top 5 (minimal scrolling)`);
  console.log(`  Precision@10: ${p10Improvement > 0 ? "+" : ""}${p10Improvement.toFixed(1)}% - Top 10 (first screen)`);
  console.log(`  Precision@25: ${p25Improvement > 0 ? "+" : ""}${p25Improvement.toFixed(1)}% - Top 25 (all results)`);
  console.log(`  Findability: ${foundImprovement > 0 ? "+" : ""}${foundImprovement.toFixed(1)}% [${diffFoundLower.toFixed(1)}%, ${diffFoundUpper.toFixed(1)}%] - Found anywhere (addresses disambiguation)`);
  console.log(`  Mean Reciprocal Rank: ${mrrImprovement > 0 ? "+" : ""}${mrrImprovement.toFixed(3)} - Ranking quality`);
  console.log(`  NDCG@25: ${ndcgImprovement > 0 ? "+" : ""}${ndcgImprovement.toFixed(3)} - Ranking quality (graded relevance, ideal for disambiguation)`);
  
  // Statistical significance
  console.log("\nSTATISTICAL SIGNIFICANCE (Primary Metrics):");
  console.log(`  Precision@1: ${mcnemarP1.significant ? "SIGNIFICANT" : "not significant"} (p=${mcnemarP1.pValue.toFixed(4)}, χ²=${mcnemarP1.statistic.toFixed(2)})`);
  console.log(`  Precision@5: ${mcnemarP5.significant ? "SIGNIFICANT" : "not significant"} (p=${mcnemarP5.pValue.toFixed(4)}, χ²=${mcnemarP5.statistic.toFixed(2)})`);
  console.log(`  Findability: ${mcnemarFound.significant ? "SIGNIFICANT" : "not significant"} (p=${mcnemarFound.pValue.toFixed(4)}, χ²=${mcnemarFound.statistic.toFixed(2)})`);
  console.log(`  Effect size (Cohen's h): P@1=${effectSizeP1.toFixed(3)}, P@5=${effectSizeP5.toFixed(3)}, Findability=${effectSizeFound.toFixed(3)}`);
  console.log(`  (|h| < 0.2: negligible, 0.2-0.5: small, 0.5-0.8: medium, >0.8: large)\n`);

  console.log("COMPARATIVE PERFORMANCE:");
  console.log(`  Baseline better: ${baselineBetter} scrobbles`);
  console.log(`  Improved better: ${improvedBetter} scrobbles`);
  console.log(`  Same result: ${bothSame} scrobbles`);
  
  if (cases.length > 0) {
    const improvedWinRate = (improvedBetter / cases.length) * 100;
    const baselineWinRate = (baselineBetter / cases.length) * 100;
    console.log(`  Improved win rate: ${improvedWinRate.toFixed(1)}%`);
    console.log(`  Baseline win rate: ${baselineWinRate.toFixed(1)}%\n`);
  }
  
  // Position distribution analysis (user effort - how many results to scroll through)
  const baselinePosDist = {
    notFound: baselinePositions.filter(p => p === -1).length,
    pos1: baselinePositions.filter(p => p === 0).length,
    pos2to5: baselinePositions.filter(p => p >= 1 && p < 5).length,
    pos6to10: baselinePositions.filter(p => p >= 5 && p < 10).length,
    pos11to25: baselinePositions.filter(p => p >= 10 && p < 25).length,
  };
  const improvedPosDist = {
    notFound: improvedPositions.filter(p => p === -1).length,
    pos1: improvedPositions.filter(p => p === 0).length,
    pos2to5: improvedPositions.filter(p => p >= 1 && p < 5).length,
    pos6to10: improvedPositions.filter(p => p >= 5 && p < 10).length,
    pos11to25: improvedPositions.filter(p => p >= 10 && p < 25).length,
  };
  
  console.log("POSITION DISTRIBUTION (User Effort - Scrolling Required):");
  console.log("  Baseline:");
  console.log(`    Not found: ${baselinePosDist.notFound} (${(baselinePosDist.notFound / cases.length * 100).toFixed(1)}%) - User cannot find track`);
  console.log(`    Position 1: ${baselinePosDist.pos1} (${(baselinePosDist.pos1 / cases.length * 100).toFixed(1)}%) - No scrolling (immediate selection)`);
  console.log(`    Position 2-5: ${baselinePosDist.pos2to5} (${(baselinePosDist.pos2to5 / cases.length * 100).toFixed(1)}%) - Minimal scrolling`);
  console.log(`    Position 6-10: ${baselinePosDist.pos6to10} (${(baselinePosDist.pos6to10 / cases.length * 100).toFixed(1)}%) - First screen scrolling`);
  console.log(`    Position 11-25: ${baselinePosDist.pos11to25} (${(baselinePosDist.pos11to25 / cases.length * 100).toFixed(1)}%) - Significant scrolling`);
  console.log("  Improved:");
  console.log(`    Not found: ${improvedPosDist.notFound} (${(improvedPosDist.notFound / cases.length * 100).toFixed(1)}%) - User cannot find track`);
  console.log(`    Position 1: ${improvedPosDist.pos1} (${(improvedPosDist.pos1 / cases.length * 100).toFixed(1)}%) - No scrolling (immediate selection)`);
  console.log(`    Position 2-5: ${improvedPosDist.pos2to5} (${(improvedPosDist.pos2to5 / cases.length * 100).toFixed(1)}%) - Minimal scrolling`);
  console.log(`    Position 6-10: ${improvedPosDist.pos6to10} (${(improvedPosDist.pos6to10 / cases.length * 100).toFixed(1)}%) - First screen scrolling`);
  console.log(`    Position 11-25: ${improvedPosDist.pos11to25} (${(improvedPosDist.pos11to25 / cases.length * 100).toFixed(1)}%) - Significant scrolling\n`);
  
  // Position distribution by field combination
  if (Object.keys(positionByFieldCombo).length > 1) {
    console.log("POSITION DISTRIBUTION BY FIELD COMBINATION:");
    for (const [combo, positions] of Object.entries(positionByFieldCombo)) {
      const comboCases = cases.filter(c => (c.fieldCombination || "track+artist") === combo);
      if (comboCases.length === 0) continue;
      
      const comboLabel = combo === "track+artist" ? "Track + Artist" : 
                        combo === "track_only" ? "Track Only" : 
                        "Track + Album";
      
      const baselineComboPos1 = positions.baseline.filter(p => p === 0).length;
      const improvedComboPos1 = positions.improved.filter(p => p === 0).length;
      const baselineComboFound = positions.baseline.filter(p => p >= 0).length;
      const improvedComboFound = positions.improved.filter(p => p >= 0).length;
      
      console.log(`  ${comboLabel} (${comboCases.length} cases):`);
      console.log(`    Baseline: P@1=${(baselineComboPos1 / comboCases.length * 100).toFixed(1)}%, Found=${(baselineComboFound / comboCases.length * 100).toFixed(1)}%`);
      console.log(`    Improved: P@1=${(improvedComboPos1 / comboCases.length * 100).toFixed(1)}%, Found=${(improvedComboFound / comboCases.length * 100).toFixed(1)}%`);
    }
    console.log();
  }
  
  // Name length analysis
  const avgTrackLength = trackLengths.reduce((a, b) => a + b, 0) / trackLengths.length;
  const avgArtistLength = artistLengths.reduce((a, b) => a + b, 0) / artistLengths.length;
  
  // Analyze by track/artist length quartiles
  const sortedByTrackLength = [...cases].sort((a, b) => a.track.length - b.track.length);
  const sortedByArtistLength = [...cases].sort((a, b) => a.artist.length - b.artist.length);
  const q1Track = sortedByTrackLength[Math.floor(sortedByTrackLength.length * 0.25)];
  const q3Track = sortedByTrackLength[Math.floor(sortedByTrackLength.length * 0.75)];
  const q1Artist = sortedByArtistLength[Math.floor(sortedByArtistLength.length * 0.25)];
  const q3Artist = sortedByArtistLength[Math.floor(sortedByArtistLength.length * 0.75)];
  
  const shortTracks = cases.filter(c => c.track.length <= (q1Track?.track.length || 10));
  const longTracks = cases.filter(c => c.track.length >= (q3Track?.track.length || 30));
  const shortArtists = cases.filter(c => c.artist.length <= (q1Artist?.artist.length || 8));
  const longArtists = cases.filter(c => c.artist.length >= (q3Artist?.artist.length || 20));
  
  if (shortTracks.length > 0 && longTracks.length > 0) {
    const shortTrackP1 = (shortTracks.filter(c => c.improvedPos === 0).length / shortTracks.length * 100);
    const longTrackP1 = (longTracks.filter(c => c.improvedPos === 0).length / longTracks.length * 100);
    const shortArtistP1 = (shortArtists.filter(c => c.improvedPos === 0).length / shortArtists.length * 100);
    const longArtistP1 = (longArtists.filter(c => c.improvedPos === 0).length / longArtists.length * 100);
    
    console.log("NAME LENGTH ANALYSIS:");
    console.log(`  Average track length: ${avgTrackLength.toFixed(1)} chars`);
    console.log(`  Average artist length: ${avgArtistLength.toFixed(1)} chars`);
    console.log(`  Short tracks (≤${q1Track?.track.length || 10} chars, n=${shortTracks.length}): P@1=${shortTrackP1.toFixed(1)}%`);
    console.log(`  Long tracks (≥${q3Track?.track.length || 30} chars, n=${longTracks.length}): P@1=${longTrackP1.toFixed(1)}%`);
    console.log(`  Short artists (≤${q1Artist?.artist.length || 8} chars, n=${shortArtists.length}): P@1=${shortArtistP1.toFixed(1)}%`);
    console.log(`  Long artists (≥${q3Artist?.artist.length || 20} chars, n=${longArtists.length}): P@1=${longArtistP1.toFixed(1)}%\n`);
  }

  // Failure mode analysis - shows which types of tracks benefit most
  // Enhanced: Now includes all Precision@K metrics (P@1, P@5, P@10, P@25) per mode
  const failureModes = ["featuring", "remix", "live", "parenthetical", "special_chars", "short_name", "standard"];
  const modeStats: Record<string, {
    count: number;
    baselineP1: number; improvedP1: number;
    baselineP5: number; improvedP5: number;
    baselineP10: number; improvedP10: number;
    baselineP25: number; improvedP25: number;
    baselineFound: number; improvedFound: number;
  }> = {};
  
  for (const mode of failureModes) {
    const modeCases = cases.filter((c) => c.failureMode === mode);
    if (modeCases.length === 0) continue;

    const baselineModeP1 = modeCases.filter((c) => c.baselinePos === 0).length;
    const improvedModeP1 = modeCases.filter((c) => c.improvedPos === 0).length;
    const baselineModeP5 = modeCases.filter((c) => c.baselinePos >= 0 && c.baselinePos < 5).length;
    const improvedModeP5 = modeCases.filter((c) => c.improvedPos >= 0 && c.improvedPos < 5).length;
    const baselineModeP10 = modeCases.filter((c) => c.baselinePos >= 0 && c.baselinePos < 10).length;
    const improvedModeP10 = modeCases.filter((c) => c.improvedPos >= 0 && c.improvedPos < 10).length;
    const baselineModeP25 = modeCases.filter((c) => c.baselinePos >= 0 && c.baselinePos < 25).length;
    const improvedModeP25 = modeCases.filter((c) => c.improvedPos >= 0 && c.improvedPos < 25).length;
    const baselineModeFound = modeCases.filter((c) => c.baselineFound).length;
    const improvedModeFound = modeCases.filter((c) => c.improvedFound).length;

    modeStats[mode] = {
      count: modeCases.length,
      baselineP1: (baselineModeP1 / modeCases.length) * 100,
      improvedP1: (improvedModeP1 / modeCases.length) * 100,
      baselineP5: (baselineModeP5 / modeCases.length) * 100,
      improvedP5: (improvedModeP5 / modeCases.length) * 100,
      baselineP10: (baselineModeP10 / modeCases.length) * 100,
      improvedP10: (improvedModeP10 / modeCases.length) * 100,
      baselineP25: (baselineModeP25 / modeCases.length) * 100,
      improvedP25: (improvedModeP25 / modeCases.length) * 100,
      baselineFound: (baselineModeFound / modeCases.length) * 100,
      improvedFound: (improvedModeFound / modeCases.length) * 100,
    };
  }

  // Calculate hardness-stratified metrics (IR best practice: stratified evaluation by query difficulty)
  const easyCases = cases.filter(c => c.hardness === "easy");
  const mediumCases = cases.filter(c => c.hardness === "medium");
  const hardCases = cases.filter(c => c.hardness === "hard");
  
  // Calculate metrics per hardness level
  const hardnessStats: Record<"easy" | "medium" | "hard", {
    count: number;
    baselineP1: number; improvedP1: number;
    baselineP5: number; improvedP5: number;
    baselineFound: number; improvedFound: number;
  }> = {
    easy: { count: 0, baselineP1: 0, improvedP1: 0, baselineP5: 0, improvedP5: 0, baselineFound: 0, improvedFound: 0 },
    medium: { count: 0, baselineP1: 0, improvedP1: 0, baselineP5: 0, improvedP5: 0, baselineFound: 0, improvedFound: 0 },
    hard: { count: 0, baselineP1: 0, improvedP1: 0, baselineP5: 0, improvedP5: 0, baselineFound: 0, improvedFound: 0 },
  };
  
  for (const c of cases) {
    const hardness = c.hardness || "medium"; // Default to medium if not set
    const stats = hardnessStats[hardness];
    stats.count++;
    if (c.baselinePos === 0) stats.baselineP1++;
    if (c.improvedPos === 0) stats.improvedP1++;
    if (c.baselinePos >= 0 && c.baselinePos < 5) stats.baselineP5++;
    if (c.improvedPos >= 0 && c.improvedPos < 5) stats.improvedP5++;
    if (c.baselineFound) stats.baselineFound++;
    if (c.improvedFound) stats.improvedFound++;
  }
  
  console.log("\nQUERY HARDNESS-STRATIFIED METRICS:");
  console.log("(IR best practice: Stratified evaluation by query difficulty based on baseline performance)");
  console.log("(Hardness = baseline effectiveness + query characteristics: ambiguity, specificity, context)\n");
  
  for (const [level, stats] of Object.entries(hardnessStats) as Array<["easy" | "medium" | "hard", typeof hardnessStats.easy]>) {
    if (stats.count === 0) continue;
    
    const baselineP1Percent = (stats.baselineP1 / stats.count) * 100;
    const improvedP1Percent = (stats.improvedP1 / stats.count) * 100;
    const baselineP5Percent = (stats.baselineP5 / stats.count) * 100;
    const improvedP5Percent = (stats.improvedP5 / stats.count) * 100;
    const baselineFoundPercent = (stats.baselineFound / stats.count) * 100;
    const improvedFoundPercent = (stats.improvedFound / stats.count) * 100;
    
    const p1Gain = improvedP1Percent - baselineP1Percent;
    const p5Gain = improvedP5Percent - baselineP5Percent;
    const foundGain = improvedFoundPercent - baselineFoundPercent;
    
    console.log(`  ${level.toUpperCase()} (${stats.count} cases, ${(stats.count / cases.length * 100).toFixed(1)}%):`);
    console.log(`    Baseline: P@1=${baselineP1Percent.toFixed(1)}%, P@5=${baselineP5Percent.toFixed(1)}%, Found=${baselineFoundPercent.toFixed(1)}%`);
    console.log(`    Improved: P@1=${improvedP1Percent.toFixed(1)}%, P@5=${improvedP5Percent.toFixed(1)}%, Found=${improvedFoundPercent.toFixed(1)}%`);
    if (p1Gain !== 0 || p5Gain !== 0 || foundGain !== 0) {
      console.log(`    Gain: P@1=${p1Gain > 0 ? "+" : ""}${p1Gain.toFixed(1)}%, P@5=${p5Gain > 0 ? "+" : ""}${p5Gain.toFixed(1)}%, Found=${foundGain > 0 ? "+" : ""}${foundGain.toFixed(1)}%`);
    }
    console.log("");
  }

  if (Object.keys(modeStats).length > 0) {
    console.log("\nSTRATIFIED FAILURE MODE ANALYSIS:");
    console.log("(Shows which types of tracks benefit most from improved matching)");
    console.log("(All Precision@K metrics reported per failure mode)\n");
    for (const [mode, stats] of Object.entries(modeStats)) {
      const p1Gain = stats.improvedP1 - stats.baselineP1;
      const p5Gain = stats.improvedP5 - stats.baselineP5;
      const p10Gain = stats.improvedP10 - stats.baselineP10;
      const p25Gain = stats.improvedP25 - stats.baselineP25;
      const foundGain = stats.improvedFound - stats.baselineFound;
      
      console.log(`  ${mode.toUpperCase().replace(/_/g, " ")} (${stats.count} cases):`);
      console.log(`    Baseline: P@1=${stats.baselineP1.toFixed(1)}%, P@5=${stats.baselineP5.toFixed(1)}%, P@10=${stats.baselineP10.toFixed(1)}%, P@25=${stats.baselineP25.toFixed(1)}%, Found=${stats.baselineFound.toFixed(1)}%`);
      console.log(`    Improved: P@1=${stats.improvedP1.toFixed(1)}%, P@5=${stats.improvedP5.toFixed(1)}%, P@10=${stats.improvedP10.toFixed(1)}%, P@25=${stats.improvedP25.toFixed(1)}%, Found=${stats.improvedFound.toFixed(1)}%`);
      if (p1Gain !== 0 || p5Gain !== 0 || p10Gain !== 0 || p25Gain !== 0 || foundGain !== 0) {
        console.log(`    Gain: P@1=${p1Gain > 0 ? "+" : ""}${p1Gain.toFixed(1)}%, P@5=${p5Gain > 0 ? "+" : ""}${p5Gain.toFixed(1)}%, P@10=${p10Gain > 0 ? "+" : ""}${p10Gain.toFixed(1)}%, P@25=${p25Gain > 0 ? "+" : ""}${p25Gain.toFixed(1)}%, Found=${foundGain > 0 ? "+" : ""}${foundGain.toFixed(1)}%`);
      }
      console.log();
    }
  }

  // Field combination analysis - shows performance by input type (track+artist vs track_only)
  const fieldCombinations = ["track+artist", "track_only", "track+album"];
  const fieldStats: Record<string, {
    count: number;
    baselineP1: number; improvedP1: number;
    baselineP5: number; improvedP5: number;
    baselineFound: number; improvedFound: number;
  }> = {};
  
  for (const combo of fieldCombinations) {
    const comboCases = cases.filter((c) => c.fieldCombination === combo);
    if (comboCases.length === 0) continue;
    
    const baselineComboP1 = comboCases.filter((c) => c.baselinePos === 0).length;
    const improvedComboP1 = comboCases.filter((c) => c.improvedPos === 0).length;
    const baselineComboP5 = comboCases.filter((c) => c.baselinePos >= 0 && c.baselinePos < 5).length;
    const improvedComboP5 = comboCases.filter((c) => c.improvedPos >= 0 && c.improvedPos < 5).length;
    const baselineComboFound = comboCases.filter((c) => c.baselineFound).length;
    const improvedComboFound = comboCases.filter((c) => c.improvedFound).length;
    
    fieldStats[combo] = {
      count: comboCases.length,
      baselineP1: (baselineComboP1 / comboCases.length) * 100,
      improvedP1: (improvedComboP1 / comboCases.length) * 100,
      baselineP5: (baselineComboP5 / comboCases.length) * 100,
      improvedP5: (improvedComboP5 / comboCases.length) * 100,
      baselineFound: (baselineComboFound / comboCases.length) * 100,
      improvedFound: (improvedComboFound / comboCases.length) * 100,
    };
  }
  
  if (Object.keys(fieldStats).length > 0) {
    console.log("\nFIELD COMBINATION ANALYSIS:");
    console.log("(Shows performance by input type - matches real user behavior)\n");
    for (const [combo, stats] of Object.entries(fieldStats)) {
      const p1Gain = stats.improvedP1 - stats.baselineP1;
      const p5Gain = stats.improvedP5 - stats.baselineP5;
      const foundGain = stats.improvedFound - stats.baselineFound;
      
      const comboLabel = combo === "track+artist" ? "Track + Artist" : 
                        combo === "track_only" ? "Track Only" : 
                        "Track + Album";
      
      console.log(`  ${comboLabel} (${stats.count} cases):`);
      console.log(`    Baseline: P@1=${stats.baselineP1.toFixed(1)}%, P@5=${stats.baselineP5.toFixed(1)}%, Found=${stats.baselineFound.toFixed(1)}%`);
      console.log(`    Improved: P@1=${stats.improvedP1.toFixed(1)}%, P@5=${stats.improvedP5.toFixed(1)}%, Found=${stats.improvedFound.toFixed(1)}%`);
      if (p1Gain !== 0 || p5Gain !== 0 || foundGain !== 0) {
        console.log(`    Gain: P@1=${p1Gain > 0 ? "+" : ""}${p1Gain.toFixed(1)}%, P@5=${p5Gain > 0 ? "+" : ""}${p5Gain.toFixed(1)}%, Found=${foundGain > 0 ? "+" : ""}${foundGain.toFixed(1)}%`);
      }
      console.log();
    }
  }

  // Show specific improvement examples
  const improvements = cases.filter(
    (c) => !c.baselineFound && c.improvedFound || (c.baselineFound && c.improvedFound && c.improvedPos < c.baselinePos)
  );
  if (improvements.length > 0) {
    console.log(`\nIMPROVEMENT EXAMPLES (${Math.min(5, improvements.length)} of ${improvements.length}):`);
    for (let i = 0; i < Math.min(5, improvements.length); i++) {
      const ex = improvements[i];
      const dupInfo = ex.duplicateCount && ex.duplicateCount > 1 ? ` (appeared ${ex.duplicateCount}x in dataset)` : "";
      const fieldInfo = ex.fieldCombination === "track_only" ? " [track only]" : "";
      console.log(`  "${ex.track}" by ${ex.artist || "[no artist]"}${dupInfo}${fieldInfo}`);
      console.log(`    Baseline: ${ex.baselineFound ? `position ${ex.baselinePos + 1}` : "not found"}`);
      console.log(`    Improved: ${ex.improvedFound ? `position ${ex.improvedPos + 1}` : "not found"}`);
    }
  }
  
  // Show duplicate distribution analysis
  const duplicateDistribution: Record<number, number> = {};
  for (const c of cases) {
    const count = c.duplicateCount || 1;
    duplicateDistribution[count] = (duplicateDistribution[count] || 0) + 1;
  }
  
  if (Object.keys(duplicateDistribution).length > 1) {
    console.log(`\nDUPLICATE DISTRIBUTION:`);
    console.log(`  (How many times each unique track appeared in the dataset)`);
    const sortedCounts = Object.keys(duplicateDistribution).map(Number).sort((a, b) => a - b);
    for (const count of sortedCounts.slice(0, 5)) {
      const tracks = duplicateDistribution[count];
      console.log(`  ${count}x: ${tracks} unique tracks`);
    }
    if (sortedCounts.length > 5) {
      const remaining = sortedCounts.slice(5).reduce((sum, c) => sum + duplicateDistribution[c], 0);
      console.log(`  ... and ${remaining} more`);
    }
  }

  // Show specific regression examples
  const regressions = cases.filter(
    (c) => c.baselineFound && !c.improvedFound || (c.baselineFound && c.improvedFound && c.baselinePos < c.improvedPos)
  );
  if (regressions.length > 0) {
    console.log(`\nREGRESSION EXAMPLES (${Math.min(3, regressions.length)} of ${regressions.length}):`);
    for (let i = 0; i < Math.min(3, regressions.length); i++) {
      const ex = regressions[i];
      console.log(`  "${ex.track}" by ${ex.artist}`);
      console.log(`    Baseline: ${ex.baselineFound ? `position ${ex.baselinePos + 1}` : "not found"}`);
      console.log(`    Improved: ${ex.improvedFound ? `position ${ex.improvedPos + 1}` : "not found"}`);
    }
  }

  // Save results
  const archiveDir = join(process.cwd(), "scripts", "eval", "results", "archive", new Date().toISOString().split("T")[0]);
  mkdirSync(archiveDir, { recursive: true });
  const resultsFile = join(archiveDir, "lastfm-evaluation-results.json");
  writeFileSync(
    resultsFile,
    JSON.stringify(
      {
        timestamp: new Date().toISOString(),
        scrobbles_total: scrobbles.length,
        scrobbles_with_mbid: validScrobbles.length,
        deduplication: {
          ...duplicateStats,
          distribution: duplicateDistribution,
        },
        evaluation_approach: {
          deduplicated: true,
          rationale: "Deduplication by (track, artist, mbid) prevents popular tracks from overweighting the evaluation. This aligns with IR evaluation best practices where unique queries are preferred to measure system performance across diverse cases rather than frequency-weighted metrics.",
        },
        metrics: {
          // Primary metrics (user effort & findability)
          baseline_p1: baselineP1Point,
          baseline_p5: baselineP5Point,
          baseline_p10: baselineP10Point,
          baseline_p25: baselineP25Point,
          baseline_findability: baselineFoundPoint,
          improved_p1: improvedP1Point,
          improved_p5: improvedP5Point,
          improved_p10: improvedP10Point,
          improved_p25: improvedP25Point,
          improved_findability: improvedFoundPoint,
          p1_improvement: p1Improvement,
          p5_improvement: p5Improvement,
          p10_improvement: p10Improvement,
          p25_improvement: p25Improvement,
          findability_improvement: foundImprovement,
          // Secondary metrics (ranking quality)
          baseline_mrr: baselineMRR,
          improved_mrr: improvedMRR,
          mrr_improvement: mrrImprovement,
          baseline_ndcg: baselineNDCG,
          improved_ndcg: improvedNDCG,
          ndcg_improvement: ndcgImprovement,
          // Comparative performance
          baseline_better: baselineBetter,
          improved_better: improvedBetter,
          same_result: bothSame,
        },
        field_combination_analysis: fieldStats,
        failure_mode_analysis: modeStats,
        cache_performance: {
          baseline_cache_hits: baselineCacheHits,
          improved_cache_hits: improvedCacheHits,
          evaluation_result_cache_hits: evaluationResultCacheHits,
          total_searches: totalSearches,
          baseline_hit_rate: totalSearches > 0 ? ((baselineCacheHits / cases.length) * 100) : 0,
          improved_hit_rate: totalSearches > 0 ? ((improvedCacheHits / cases.length) * 100) : 0,
          overall_hit_rate: totalSearches > 0 ? (((baselineCacheHits + improvedCacheHits) / totalSearches) * 100) : 0,
          evaluation_result_hit_rate: cases.length > 0 ? ((evaluationResultCacheHits / cases.length) * 100) : 0,
        },
        api_metrics: {
          musicbrainz_calls: apiMetrics.musicbrainzCalls,
          musicbrainz_rate_limits: apiMetrics.musicbrainzRateLimits,
          musicbrainz_errors: apiMetrics.musicbrainzErrors,
          lastfm_calls: apiMetrics.lastfmCalls,
          lastfm_errors: apiMetrics.lastfmErrors,
          total_api_call_time_ms: apiMetrics.totalAPICallTime,
          avg_api_call_time_ms: (apiMetrics.musicbrainzCalls + apiMetrics.lastfmCalls) > 0 
            ? apiMetrics.totalAPICallTime / (apiMetrics.musicbrainzCalls + apiMetrics.lastfmCalls)
            : 0,
        },
        performance: {
          total_time_ms: totalElapsed,
          avg_time_per_case_ms: cases.length > 0 ? totalElapsed / cases.length : 0,
          cases_per_second: cases.length > 0 ? cases.length / (totalElapsed / 1000) : 0,
          cached_cases: cases.filter(c => c.baselineCacheHit && c.improvedCacheHit).length,
          uncached_cases: cases.length - cases.filter(c => c.baselineCacheHit && c.improvedCacheHit).length,
        },
        hardness_stratified_metrics: {
          easy: {
            count: hardnessStats.easy.count,
            baseline_p1: hardnessStats.easy.count > 0 ? (hardnessStats.easy.baselineP1 / hardnessStats.easy.count) * 100 : 0,
            improved_p1: hardnessStats.easy.count > 0 ? (hardnessStats.easy.improvedP1 / hardnessStats.easy.count) * 100 : 0,
            baseline_p5: hardnessStats.easy.count > 0 ? (hardnessStats.easy.baselineP5 / hardnessStats.easy.count) * 100 : 0,
            improved_p5: hardnessStats.easy.count > 0 ? (hardnessStats.easy.improvedP5 / hardnessStats.easy.count) * 100 : 0,
            baseline_found: hardnessStats.easy.count > 0 ? (hardnessStats.easy.baselineFound / hardnessStats.easy.count) * 100 : 0,
            improved_found: hardnessStats.easy.count > 0 ? (hardnessStats.easy.improvedFound / hardnessStats.easy.count) * 100 : 0,
          },
          medium: {
            count: hardnessStats.medium.count,
            baseline_p1: hardnessStats.medium.count > 0 ? (hardnessStats.medium.baselineP1 / hardnessStats.medium.count) * 100 : 0,
            improved_p1: hardnessStats.medium.count > 0 ? (hardnessStats.medium.improvedP1 / hardnessStats.medium.count) * 100 : 0,
            baseline_p5: hardnessStats.medium.count > 0 ? (hardnessStats.medium.baselineP5 / hardnessStats.medium.count) * 100 : 0,
            improved_p5: hardnessStats.medium.count > 0 ? (hardnessStats.medium.improvedP5 / hardnessStats.medium.count) * 100 : 0,
            baseline_found: hardnessStats.medium.count > 0 ? (hardnessStats.medium.baselineFound / hardnessStats.medium.count) * 100 : 0,
            improved_found: hardnessStats.medium.count > 0 ? (hardnessStats.medium.improvedFound / hardnessStats.medium.count) * 100 : 0,
          },
          hard: {
            count: hardnessStats.hard.count,
            baseline_p1: hardnessStats.hard.count > 0 ? (hardnessStats.hard.baselineP1 / hardnessStats.hard.count) * 100 : 0,
            improved_p1: hardnessStats.hard.count > 0 ? (hardnessStats.hard.improvedP1 / hardnessStats.hard.count) * 100 : 0,
            baseline_p5: hardnessStats.hard.count > 0 ? (hardnessStats.hard.baselineP5 / hardnessStats.hard.count) * 100 : 0,
            improved_p5: hardnessStats.hard.count > 0 ? (hardnessStats.hard.improvedP5 / hardnessStats.hard.count) * 100 : 0,
            baseline_found: hardnessStats.hard.count > 0 ? (hardnessStats.hard.baselineFound / hardnessStats.hard.count) * 100 : 0,
            improved_found: hardnessStats.hard.count > 0 ? (hardnessStats.hard.improvedFound / hardnessStats.hard.count) * 100 : 0,
          },
        },
        cases: cases.map((c) => ({
          track: c.track,
          artist: c.artist,
          album: c.album,
          mbid: c.mbid,
          baseline_pos: c.baselinePos >= 0 ? c.baselinePos + 1 : null,
          improved_pos: c.improvedPos >= 0 ? c.improvedPos + 1 : null,
          baseline_found: c.baselineFound,
          improved_found: c.improvedFound,
          baseline_ndcg: c.baselineNDCG,
          improved_ndcg: c.improvedNDCG,
          failure_mode: c.failureMode,
          hardness: c.hardness,
          field_combination: c.fieldCombination,
          duplicate_count: c.duplicateCount,
        })),
      },
      null,
      2
    )
  );
  console.log(`\nResults saved to: ${resultsFile}`);
  
  // Show final cache stats
  const finalStats = cache.getStats(cacheUsername);
  console.log("\nFINAL CACHE STATS (All accumulate over time, never cleared):");
  console.log(`  Total scrobbles: ${finalStats.totalScrobbles}`);
  console.log(`  With MBIDs: ${finalStats.scrobblesWithMBID}`);
  console.log(`  Cached MBID lookups: ${finalStats.cachedMBIDs}`);
  console.log(`  Cached MusicBrainz searches: ${finalStats.cachedSearches}`);
  console.log(`  Cached MBID validations: ${finalStats.cachedValidations}`);
  console.log(`  Cached evaluation results: ${finalStats.cachedEvaluationResults} (enables instant re-runs)`);
  
  const totalElapsedFinal = Date.now() - startTime;
  console.log(`\nTotal execution time: ${formatTime(totalElapsedFinal)}`);
  console.log(`  Average: ${formatTime(totalElapsedFinal / cases.length)} per evaluation case`);
  
  cache.close();
}

main().catch(console.error);