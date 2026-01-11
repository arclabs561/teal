# MusicBrainz Matching Evaluation

Evaluation framework for testing MusicBrainz matching improvements.

## Files

- `evaluate.ts`: main runner (baseline vs improved)
- `evaluate-lastfm-cache.ts`: SQLite cache used by the runner
- Evidence for why this exists (what was run, with what data, and what changed) is recorded in the `chore(eval)` commit message for this branch.

## Quick Start

```bash
# 1) Configure Last.fm API credentials (either env vars or a repo-root .env)
# LASTFM_API_KEY=...
# LASTFM_API_SECRET=...

# 2) OAuth once (stores session key locally at ~/.lastfm_session_key)
pnpm eval:auth

# 3) Run evaluation (sample)
pnpm eval:run --limit 1000

# 4) Run evaluation on full cached history (best effort; can take a while on first run)
pnpm eval:run --all
```

## Main Script

- `evaluate.ts` is the entry point.

## Notes

- The SQLite cache lives at `~/.teal_eval_cache/lastfm_eval.db` and accumulates over time.
- Result JSON files under `scripts/eval/results/archive/` are treated as artifacts (not code). Do not commit them.

