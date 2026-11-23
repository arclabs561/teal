# Local Teal and Piper replays

Run the offline suite from the repository root with Bash, Node 24, and Python 3. Add `--with-lua` for the portability checks if Lua 5.4 or its shared library is installed.

```sh
bash scripts/local-replays/verify.sh
bash scripts/local-replays/verify.sh --with-lua
```

The suite uses pinned source snapshots, public catalog responses, and synthetic cases. It needs no live service, account, or Last.fm history. The results describe the code revisions and examples captured here.

| Directory | What it covers |
| --- | --- |
| [teal-public-ci](teal-public-ci/) and [teal-public-eval](teal-public-eval/) | MusicBrainz ranking fixtures, request counts, and deterministic ListenBrainz sampling |
| [teal-local-science](teal-local-science/) and [teal-catalog-exploration](teal-catalog-exploration/) | Evaluator cache outages, paired comparisons, recording and edition IDs, and artist credits |
| [teal-pr-updates](teal-pr-updates/verification/) and [teal-portability](teal-portability/) | Mocked sign-in, onboarding, picker races, portable play records, and deletion retries |
| [piper](piper/) and [cadet](cadet/) | Listen identity, now-playing models, and replay across alpha and stable collections |

## Sample more public data

Use a dated ListenBrainz archive. Record its date and checksum so another contributor can reproduce the sample. The sampler drops listener and playback timestamp fields. It also accepts a saved public API response with `--api`.

```sh
python3 scripts/local-replays/teal-public-ci/local/sample-listenbrainz.py \
  --per-tier 250 --seed teal-listens-v1 < 0.listens > candidates.jsonl
```

Validate client and server recording IDs against independent evidence such as MusicBrainz release tracklists. Keep versions of the same recording and release group together when splitting cases for tuning and holdout. For CI, use small pinned cases and response fixtures so the same checks can run without making live catalog requests. The included bounded samples and synthetic cases are regression checks. Estimating how often a failure occurs requires a larger, representative sample. [ListenBrainz downloads](https://listenbrainz.org/data/) · [MusicBrainz data license](https://musicbrainz.org/doc/MusicBrainz_Database/License)

## Run the service integrations

**Piper** uses Go at the version in the pinned checkout, its race-detector build dependencies, Python 3, and `patch`. Fetch PR #107 into a separate Piper checkout and check out `112d76f82f788a820d7e4ace9fddbb58be53cb11`. The runner uses Go overlays for five legacy-key cases and runs the candidate ListenBrainz suite with the race detector. The overlay leaves the Piper checkout intact. [Piper PR #107](https://github.com/teal-fm/piper/pull/107)

```sh
bash scripts/local-replays/piper/run-legacy-keys.sh /path/to/piper
```

**Cadet** uses the Rust toolchain and a disposable PostgreSQL database with the rewrite draft's migrations. Fetch PR #113 into a separate Teal checkout at `96cc72927b178f40d5b71630f20852af17df6b81`. Initialize the `vendor/atproto` submodule, build the lexicon CLI, and generate Rust types with `node tools/lexicon-cli/dist/index.js gen --rust-only`. With `DATABASE_URL` pointed at the disposable database, run the draft's migrations with `sqlx migrate run` from its checkout root. The runner temporarily installs the Rust fixture and applies the bundled candidate patch before the second run. It restores the checkout's source and prints the output directory. The offline suite compares the scoring model against the included PostgreSQL observations. [Teal draft #113](https://github.com/teal-fm/teal/pull/113)

```sh
bash scripts/local-replays/cadet/run-cadet-legacy-matrix.sh /path/to/teal-draft
```
