# Public replay and ListenBrainz intake

The public MusicBrainz regression test is from Teal #253. On that PR checkout with dependencies installed, run the Amethyst Jest test:

```sh
pnpm --filter @teal/amethyst test --runTestsByPath lib/__tests__/musicbrainzPublicReplay.test.ts
```

In this directory, `node --import ./loader.mjs run-jest-case.mjs` exercises the captured assertions with a small local harness. The PR’s Build Amethyst workflow runs the Jest suite.

The offline check uses captured recording searches and expected recording IDs read from the album tracklists. It asserts first place and one request for three public examples. Ado’s English-title search for an explicitly requested album still returns a live version, and is recorded as a TODO in Jest. The local comparison replay in the sibling `teal-public-eval` directory reports that miss across versions.

## Sample a ListenBrainz archive

Use the verified, dated ListenBrainz dump’s extracted `.listens` file:

```sh
python3 local/sample-listenbrainz.py --per-tier 250 --seed teal-listens-v1 < 0.listens > candidates.jsonl
```

For a single public recent-listens API response, add `--api`. The sampler selects a bounded number of unique candidates per label tier, strips user and timestamp fields, and gives the same sample regardless of input order. Results retain the original title, artist, release, client ID, server mapping, and any supplied ISRC or Spotify identifier. Validate recording IDs against pinned catalog evidence before scoring. Group all variants of a recording together when splitting tuning and holdout samples.

The local public seed uses the identifier fields from the earlier 45-row intake. The test input also includes a synthetic conflicting-ID case. API mode and streaming mode produced identical samples and reversing the input did not change the output. The larger dated archive has not been downloaded in this workspace.

## Run the checks together

Run `bash verify-cloud.sh` from this directory. It runs the public replay, the sampler’s deterministic intake checks, and mocked sign-in, image, picker, and evaluator regressions. It uses Node 24 and Python 3. The [top-level runner](../README.md) includes the optional Lua fixtures for portable listening records.

The local delete fixture simulates independent PDS and index writes. When the PDS delete succeeds and SQL fails, the index row remains and a user retry returns NotFound. Delivering the repository delete event through the real indexing handler removes that row in the fixture. Firehose delivery or replay after a real HappyView outage still needs an integration test.
