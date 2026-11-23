#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "${BASH_SOURCE[0]}")"

if [[ ${1:-} == --with-lua ]]; then
    (
        cd teal-portability
        for fixture in tests/*.lua; do
            if command -v lua5.4 >/dev/null; then
                lua5.4 "$fixture"
            else
                python3 run-lua.py "$fixture"
            fi
        done
    )
elif [[ $# -ne 0 ]]; then
    echo "Usage: bash verify.sh [--with-lua]" >&2
    exit 2
fi

bash teal-public-ci/verify-cloud.sh
bash teal-local-science/verify-local.sh
node teal-public-eval/replay.mjs --check
node teal-eval/replay.mjs
node teal-local-science/version-audit/replay-versions.mjs
node teal-catalog-exploration/evaluate.mjs
node teal-catalog-exploration/compare-identifiers.mjs
node teal-catalog-exploration/audit-album.mjs
node teal-catalog-exploration/test-artist-credits.mjs
node piper/now-playing-model.mjs
python3 cadet/score-cadet-legacy-matrix.py
