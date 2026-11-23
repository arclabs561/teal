# Evaluating recording identity in Teal

Teal’s listen records can carry a MusicBrainz recording, release, and track ID. A recording identifies the audio performance. A release identifies an edition of an album or single. A track identifies a recording’s position on one release. A bad recording ID can affect Teal profiles, stats, and other apps that use the same public listen. A user who specifies an album is also giving us evidence about which version they intend.

## Matching surfaces

- Amethyst’s manual picker uses the search orchestrator for exact, fuzzy, and title-only lookup. Strong exact matches should keep their fast path. Weak candidates can justify more lookups, with the picker showing progress and discarding stale results. On the app rewrite branch the orchestrator lives in `packages/client`.
- The public site editor has its own MusicBrainz client in `apps/site/src/lib/musicbrainz.ts`. It can suggest a recording from a saved ISRC or let the user look up a recording directly. Its release picker can use the chosen recording’s releases.
- The evaluation uses the matcher that the target client actually calls. Evaluate the public editor separately when it uses a different backend or lookup path.

An ISRC is a useful candidate filter. It may resolve to zero, one, or several recordings in MusicBrainz. A matching album title is corroborating evidence and may still refer to several editions. When supplied information disagrees with the candidates, keep that uncertainty visible and let the listener choose. More text-search requests may still leave the intended recording outside the candidate set.

## What to run on a PR

Use a small offline fixture with captured MusicBrainz responses and labels from independent release tracklists or separately verified identifiers. Keep response order, backend, query, limit, and capture date. A missing fixture or failed request should stay distinct from a successful search with no results.

Gate individual behaviors the project already intends to support. Verify that a known recording is first, an explicit edition beats the wrong one, and a strong exact match stays at one request. Keep current misses visible as exploratory cases until the behavior is fixed. Run the test in Amethyst’s existing library suite. Keep the same fixtures when moving the matcher into the shared client package.

## What to measure before changing ranking defaults

Build a versioned sample from a dated ListenBrainz dump. Retain input text, useful catalog identifiers, and label provenance. Drop listener names and listening timestamps. Validate submitted recording IDs against catalog evidence before scoring. Keep ListenBrainz-inferred mappings and conflicts in separate tiers. Keep variants of one recording together, and cap the influence of any one album or artist when sampling.

Compare current and candidate matchers on the same backend responses. Report expected recording rank, wrong-version top results, request counts, and latency when measured against a live or local search backend. Include denominators, label tiers, and paired uncertainty grouped by recording. Fixture request counts do not measure live latency.

Keep the small regression fixture in PR CI. Generate the larger sample and response bundle separately, with source versions and checksums. A maintainer should be able to rerun the comparison from a checkout without a personal Last.fm account. Promote a local comparison to a tracked eval once the labels, responses, and failure handling are reproducible outside its original workspace.

## Evidence behind the initial cases

- The English title “Fireworks” by Ado returned a score-100 live recording outside the requested album 狂言. The original-script query found the studio track on the requested release. The studio ISRC also resolved to that recording in the catalog snapshot.
- “Golden Brown” returned three recordings for one ISRC. “Bachelorette” surfaced several recording candidates attached to releases titled Homogenic. Identifier and album collisions belong in the evaluation.
- Twelve submitted IDs could be confirmed from two release tracklists, with ten from one Röyksopp album. That establishes label provenance for those examples. It also shows why recent listens from a few contributors give poor coverage on their own.

[Public replay PR](https://github.com/teal-fm/teal/pull/253) · [Paired reporting PR](https://github.com/teal-fm/teal/pull/255) · [ListenBrainz label fields](https://listenbrainz.readthedocs.io/en/latest/users/json.html)
