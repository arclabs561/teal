#!/usr/bin/env bash
set -euo pipefail

fixtures=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
repo=${1:?Pass a disposable Teal checkout at 96cc729}
: "${DATABASE_URL:?Set DATABASE_URL to a disposable migrated PostgreSQL database}"
if [[ -n ${2:-} ]]; then
    mkdir -p "$2"
    output=$(cd "$2" && pwd)
else
    output=$(mktemp -d)
fi
cd "$repo"

draft=96cc72927b178f40d5b71630f20852af17df6b81
if [[ $(git rev-parse HEAD) != "$draft" ]]; then
    echo "Use the pinned Cadet draft at $draft" >&2
    exit 1
fi
source=services/cadet/src/ingestors/teal/feed_play.rs
test_source=services/cadet/tests/cadet_legacy_matrix.rs
test_data=services/cadet/tests/cadet-legacy-matrix.json
if ! git diff --quiet HEAD -- "$source" || [[ -e $test_source || -e $test_data ]]; then
    echo "The source and fixture paths must be clean in the Cadet checkout" >&2
    exit 1
fi
git apply --check "$fixtures/recording-id-guard.patch"

backup=$(mktemp)
cp "$source" "$backup"
restore() {
    cp "$backup" "$source"
    rm -f "$backup" "$test_source" "$test_data"
}
trap restore EXIT

cp "$fixtures/cadet-legacy-matrix.rs" "$test_source"
cp "$fixtures/cadet-legacy-matrix.json" "$test_data"
for revision in draft candidate; do
    if [[ $revision == candidate ]]; then
        git apply "$fixtures/recording-id-guard.patch"
    fi
    SQLX_OFFLINE=true cargo test --locked -p cadet --test cadet_legacy_matrix \
        -- --ignored --nocapture | tee "$output/cadet-matrix-$revision.txt"
done
python3 "$fixtures/score-cadet-legacy-matrix.py" "$output"
echo "Replay output saved to $output"
