#!/usr/bin/env bash
set -euo pipefail

root=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
cd "$root"

node --import ./loader.mjs run-jest-case.mjs
node --import ./loader.mjs scripts/eval/replay-public.ts --check
python3 local/sample-listenbrainz.py --api --per-tier 5 < local/intake-test-api.json |
  cmp - local/candidates.jsonl
python3 -c 'import sys; sys.stdout.writelines(reversed(sys.stdin.readlines()))' < local/intake-test.jsonl |
  python3 local/sample-listenbrainz.py --per-tier 5 |
  cmp - local/candidates.jsonl
echo "PASS ListenBrainz sampling across input orders and formats"

(
  cd ../teal-pr-updates
  MB_RATE_LIMIT_MS=0 node verification/verify.mjs
  node verification/picker-race.mjs
)
