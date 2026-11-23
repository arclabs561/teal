# Local search and benchmark experiments

Run these with Node 24 from this directory. The cache scripts use copies of the #253 evaluator and search functions with mocked fetch and an in-memory implementation of the evaluator's SQLite cache interface. The local prototype uses the draft's recording transport, which throws a typed error for unavailable responses.

- `node cache-outage.mjs` demonstrates that both evaluator paths currently store HTTP 502 responses as no-match entries. A healthy rerun using that cache makes no request. An empty cache lets the healthy response rank first.
- `node cache-prototype.mjs` makes those failures visible and leaves the cache empty, so the healthy retry can succeed. Successful HTTP 200 responses with no hits remain cacheable. This first prototype tests recording lookup against the same cache interface as the original evaluator.
- `node check-credits.mjs` checks captured MusicBrainz responses and the presence of structured names in public ListenBrainz inputs. Three diagnosed collaborative tracks have separate artist names available. The observed Piper mapping path already uses the server-resolved credit names when they are present. The public sample is bounded recent listens and should not be interpreted as overall metadata coverage.
- `node label-coverage.mjs` separates exact tracklist verification from corroboration by recording lookup, mapping-only data, and missing labels. This uses the earlier workspace sample from the sibling catalog-exploration directory.

## Refined replay

Run `bash verify-local.sh` for the full search and evaluator suite.

The replay transport serves recording and artist lookup. The tests cover exhausted 503 retries, 429 retry scheduling, timeout, malformed HTTP 200 responses, and a Retry-After value beyond the configured wait budget. Only successful responses with a valid result list are cached. No live completion-rate or latency measurements were taken.

An alias transport failure makes that arm of a comparison unavailable. In the local recovery case, the next alias lookup found the desired recording and reused a genuine exact-query miss. A response missing from the fixture also stays unavailable.

The report shows the paired top-1 change for queries that completed on both sides and the possible range across all attempted queries when some outcomes are missing. In a synthetic five-query example, comparable pairs improved by 33.3 pp, while the missing-outcome bounds across all five were −20 to +40 pp. Those bounds describe missing outcomes, not sampling uncertainty. Use the recording-clustered confidence intervals separately.

The four public cases complete under the new replay. The ranker moves the verified studio “Bachelorette” from raw MusicBrainz rank four to rank one. “Fireworks” remains a miss under both policies. These four fixtures are regression checks over three recordings.

## Persistent evaluator cache

`node test-sqlite-cache.mjs` opens the same temporary database in three consecutive Node processes. The outage process sees an exhausted recording 503 and an artist 502, alongside a real 200 response with zero recordings. Recovery reuses the real empty result, fetches both failed inputs and checks that a different result limit has its own key. The offline restart serves all four healthy entries with zero fetches. A synthetic legacy empty entry stays isolated by namespace. The adapter uses Node 24’s SQLite. The integration with Teal’s existing evaluator and SQLite driver remains to be tested.

## Release title versus release ID

Run `node run-release-pairs.mjs` and `node run-release-credits.mjs`. The fixture directory contains five public MusicBrainz release tracklists and 31 recording response snapshots. `release-pair-cases.mjs` picks two distinct recording IDs from each tracklist by SHA-256 with seed `teal-release-pairs-v1`, excluding four titles tested earlier. The five releases came from prior casework. The ten query inputs and labels were written to `release-pair-manifest.json` before capturing the search responses.

The primary comparison uses one request per arm, with the same track title, display artist credit and five-result limit. It compares `release:"…"` with `reid:<uuid>` in MusicBrainz’s raw result order. Six initial captures were unavailable through the fetch connector, including one truncated payload. Retries of the same query with reordered URL parameters recovered all six. The fixture retains the failed captures and MusicBrainz’s response timestamps. Offline replay makes no requests.

| Metric | Release title | Known release ID |
| --- | --- | --- |
| Tracklist recording at rank 1 | 6/10 | 9/10 |
| Tracklist recording in the first five | 8/10 | 9/10 |

“Hello Again” moved from outside the first five to first place. “I Refuse” moved from fifth to first, though its release ID search also returned “Magic” at rank two. Ado’s “会いたくて” moved from second to first. The top-1 difference ranged from 12.5 to 37.5 percentage points when leaving out each release in turn. This is a sensitivity check over the five selected releases. These figures describe search ranking with a known catalog release ID and aligned catalog text. They do not estimate app-wide ranking, identifier availability or latency.

The duplicate-title control uses a different edition of Ado’s 狂言. Its tracklist gives two different recording IDs to “会いたくて”, one on CD and one on DVD. A search constrained to that release ID returns both at score 100. The release identifier narrows the set of editions. The medium or another distinguishing field is still needed for this edition. [MusicBrainz release tracklist](https://musicbrainz.org/release/f55654fa-fa15-4eb5-8709-56b5047b3629)

The artist-credit follow-up isolates the miss on Röyksopp’s “Sorry”. The copied #253 orchestrator trims `feat.` and finds the track at rank one after one exact release-title request. Two separate, catalog-backed artist clauses also return the expected recording. Replacing the guest with the other track’s guest produces a real empty response for both controls. “Let’s Get It Right” succeeds on all the correctly credited variants. These cases support retaining the existing cleanup and testing structured credits on examples where the lead artist alone is actually ambiguous. [MusicBrainz label source](https://musicbrainz.org/release/e96c2e7b-94fd-4fbe-9c44-1a27d8664825)

## What these checks change

The success-only cache and offline replay are ready to trial in the evaluator. The regression checks cover an outage cached as a miss, retries, a restart, alias recovery and missing responses. Use pinned fixtures for a small CI check and keep live capture optional. A distinct cache namespace makes the healthy results reusable without trusting unverified legacy entries.

Keep the extra artist constraints as an experiment for paths that already have known separate artists. Two intact artist names returned different first candidates after comma splitting. The captured responses do not establish that the first candidate was a better or worse edition. Preserve the existing query for ordinary display strings.

Use the release-ID cases as regression checks for callers that already have a trustworthy release MBID. The captured queries each cost one request. The test does not justify an additional interactive lookup to discover a release ID. For a broader evaluation, start with more release groups and verify labels independently from candidate search, then report how often the real input carries a usable ID alongside top-1, top-5 and request counts.

The [provider identifier audit](identifier-audit/README.md) follows up with public ListenBrainz inputs. It measures client-supplied and inferred identifiers separately, checks conflicting editions against their tracklists, and replays the current #253 code on a provider-version mismatch.
