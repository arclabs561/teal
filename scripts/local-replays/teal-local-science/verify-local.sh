#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "${BASH_SOURCE[0]}")"

node cache-outage.mjs
node cache-prototype.mjs
node test-transport.mjs
node test-sqlite-cache.mjs
node test-paired-replay.mjs
node run-public-pairs.mjs
node run-release-pairs.mjs
node run-release-credits.mjs
node check-credits.mjs
node label-coverage.mjs
node identifier-audit/audit-inputs.mjs --cases | cmp - identifier-audit/tracklist-manifest.json
node identifier-audit/audit-inputs.mjs
node identifier-audit/audit-editions.mjs
node identifier-audit/replay-search.mjs
