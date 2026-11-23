# Catalog experiments

Use Node 24 to run:

- `node compare-identifiers.mjs` compares provider duration, release identity, and documented catalog aliases using captured responses.
- `node test-artist-credits.mjs` reruns the #253 search code on captured first-stage responses. Two inputs use the separately captured response for their known multi-artist credits. Some legacy fallback stages were unavailable to the capture, so these are first-stage comparisons.
- `node evaluate.mjs` verifies the earlier seed labels against release tracklists and prints ISRC outcomes.
- `node audit-album.mjs` audits album evidence in the earlier replay without changing the ranking.

The expanded ListenBrainz sample contains 108 public listens from six bounded recent-listens pages. Listener identifiers and listening timestamps were dropped. The sampler found 15 client IDs, 79 server mappings without client IDs, and 14 unlabeled inputs. The label audit establishes that all 15 submitted IDs resolve. Ten recording lookups returned the exact supplied release title. A missing name in a recording's response is insufficient to disprove a label. For “Drive,” direct tracklists for two selected `Heartbeat City` releases returned the same recording and disagreed with the submitted ID. Keep that item out of the exact-edition gold set unless source evidence resolves it.

Example verified results:

- “Golden Brown” had multiple records under one ISRC. The observed source duration was 206,760 ms. A candidate 51 ms from that value was absent from the verified 1981 `La Folie` tracklist. The actual album recording was 1,133 ms away.
- Four MusicBrainz candidates in the “Bachelorette” search included a release named `Homogenic`. The requested track title on the verified release ID identified one recording.
- The catalog alias `Hanabi` for Ado’s `花火` found the studio track with the album. The problematic supplied title `Fireworks` was absent from the captured recording aliases.
- Separate artist clauses found each of two collaborative recordings in one lookup with release context. Four single-credit controls still matched in one request. Use actual structured credits from the source when they exist. A comma in a display name is not evidence that it contains multiple artists.

When promoting any case to regression CI, preserve the labels, evidence URLs, and captured requests in an offline fixture. Use larger stratified samples for ranking changes and leave examples with uncertain labels in a separate report.
