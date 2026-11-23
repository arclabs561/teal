#!/usr/bin/env bash
set -euo pipefail

fixtures=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
cd "${1:?Pass a checkout of Piper PR 107 at 112d76f}"
repo=$(pwd -P)
pinned=112d76f82f788a820d7e4ace9fddbb58be53cb11
if [[ $(git rev-parse HEAD) != "$pinned" ]] || [[ -n $(git status --porcelain) ]]; then
    echo "Use a clean Piper checkout of $pinned" >&2
    exit 1
fi
scratch=$(mktemp -d)
trap 'rm -rf "$scratch"' EXIT

python3 - "$repo" "$fixtures" "$scratch" <<'PY'
import json
import sys
from pathlib import Path

repo, fixtures, scratch = map(Path, sys.argv[1:])
package = repo / "service/listenbrainz"
fixture = {str(package / "legacy_keys_replay_test.go"): str(fixtures / "piper-empty-legacy-keys.go")}
candidate = {**fixture, str(package / "listenbrainz.go"): str(scratch / "listenbrainz.go")}
for name, replacements in (("original", fixture), ("candidate", candidate)):
    (scratch / f"{name}.json").write_text(json.dumps({"Replace": replacements}))
PY

PIPER_REPLAY_CANDIDATE=0 go test -count=1 -overlay "$scratch/original.json" \
    -v -run '^TestAuditEmptyLegacyListenBrainzKeys$' ./service/listenbrainz

cp service/listenbrainz/listenbrainz.go "$scratch/listenbrainz.go"
patch "$scratch/listenbrainz.go" "$fixtures/legacy-key-candidate.patch"
PIPER_REPLAY_CANDIDATE=1 go test -race -count=1 -overlay "$scratch/candidate.json" \
    ./service/listenbrainz
