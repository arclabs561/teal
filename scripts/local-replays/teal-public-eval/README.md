# Teal public search replay

Run `node replay.mjs --check` with Node 24 or later. The script uses matcher copies in the sibling `teal-eval` and `teal-pr-updates` directories. It needs no dependencies, credentials, network connection, or Last.fm cache.

MusicBrainz search responses were captured on November 22, 2026 with a limit of 25. The fixture keeps each result in its original order and projects to the fields used by the matchers. Source URLs and capture timestamps are in the fixture. Expected recording IDs come from separate release-tracklist lookups. Each case starts with an empty in-memory cache. The check fails if a matcher requests a missing response, if a known-good result slips from first place, or if a known-good lookup unexpectedly requires fallback.

The translated Ado title is a reporting-only case. All tested versions return the live recording on マーズ for “Fireworks” by Ado on 狂言. The studio recording on 狂言 has ISRC JPPO02105117. Treat that as a separate identifier-based lookup opportunity when the source supplies an ISRC. Title-only inputs need evidence that the recording is on the requested album.

The fixture contains four queries over three recordings. It establishes specific behavior without estimating real-world hit rates or latency. The stubbed fetch counts requests and sets request spacing to zero for the offline run.

## Public dataset for the larger evaluation

Start with a dated ListenBrainz incremental archive. The 2026-11-16 dump directory lists a 215 MB listens archive with checksums. The archive contains JSON lines in a .listens file. Stream that file and retain only track, artist, release, available media identifiers, the recording label, and label provenance. Keep usernames and timestamps out of the fixture.

Use validated client-provided IDs or matches corroborated by independent catalog identifiers for the primary score. Keep server-inferred labels as a separate comparison. Repeated variants of the same recording belong together when dividing tuning cases from holdout cases, and album edition matters for exact-recording scoring.

`listenbrainz-sample.json` is a bounded intake check over three public recent-listens responses. It contains 45 rows, 35 distinct title/artist/release inputs, 15 rows with both a client-provided ID and a server mapping, 22 with a mapping alone, and 8 with neither. One client-provided Röyksopp recording ID was verified through direct MusicBrainz lookup. Client IDs and server mappings agreeing is not independent validation.

Keep the small pinned fixture in PR CI. Refresh a larger sample on a separate schedule, record the dump URL and checksum, and save a versioned response bundle for replay. Keep the original edge cases in the PR fixture even as the larger sample rotates.
