import json
import sys
from collections import Counter
from pathlib import Path

ROOT = Path(__file__).resolve().parent
OUTPUT = Path(sys.argv[1]) if len(sys.argv) > 1 else ROOT
SCENARIOS = json.loads((ROOT / "cadet-legacy-matrix.json").read_text())
COLLECTIONS = {"alpha": "fm.teal.alpha.feed.play", "stable": "fm.teal.feed.play"}


def results(branch):
    rows = {}
    for line in (OUTPUT / f"cadet-matrix-{branch}.txt").read_text().splitlines():
        if line.startswith("MATRIX "):
            result = json.loads(line.removeprefix("MATRIX "))
            rows[(result["name"], result["reversed"])] = result["rows"]
    assert len(rows) == 2 * len(SCENARIOS), rows
    return rows


def by_record_key(plays):
    kept = {}
    for play in plays:
        if play["key"] not in kept or play["namespace"] == "stable":
            kept[play["key"]] = play
    return kept


def match(left, right, seconds, use_id, require_id=False):
    if seconds is None or abs(left["seconds"] - right["seconds"]) > seconds:
        return False
    a, b = left["recording"], right["recording"]
    if require_id:
        return a is not None and b is not None and a == b
    return not use_id or a is None or b is None or a == b


def cadet_policy(plays, seconds, use_id, require_id=False):
    kept = {}
    for play in plays:
        key = play["key"]
        old = kept.get(key)
        if play["namespace"] == "alpha":
            if old and old["namespace"] == "stable":
                continue
            if any(other["namespace"] == "stable" and match(play, other, seconds, use_id, require_id)
                   for other in kept.values()):
                kept.pop(key, None)
                continue
        else:
            superseded = [other_key for other_key, other in kept.items()
                          if other["namespace"] == "alpha" and other_key != key
                          and match(play, other, seconds, use_id, require_id)]
            for other_key in superseded:
                del kept[other_key]
        kept[key] = play
    return kept.values()


def pair_once(plays):
    records = list(by_record_key(plays).values())
    matches = sorted(
        (abs(a["seconds"] - b["seconds"]), a["key"], b["key"])
        for a in records if a["namespace"] == "alpha"
        for b in records if b["namespace"] == "stable" and match(a, b, 600, True)
    )
    paired_alpha, paired_stable = set(), set()
    for _, alpha, stable in matches:
        if alpha not in paired_alpha and stable not in paired_stable:
            paired_alpha.add(alpha)
            paired_stable.add(stable)
    return [record for record in records if record["key"] not in paired_alpha]


def row_id(play):
    return f"{COLLECTIONS[play['namespace']]}:{play['key']}"


def score(input_plays, retained):
    expected = {play["listen"] for play in input_plays}
    counts = Counter(play["listen"] for play in retained)
    lost = len(expected - counts.keys())
    duplicates = sum(count - 1 for count in counts.values())
    return lost, duplicates


draft = results("draft")
candidate = results("candidate")
policies = {
    "Unmodified draft, 600s": lambda plays: cadet_policy(plays, 600, False),
    "Local ID guard, 600s": lambda plays: cadet_policy(plays, 600, True),
    "Local ID guard, 60s": lambda plays: cadet_policy(plays, 60, True),
    "Local ID guard, 30s": lambda plays: cadet_policy(plays, 30, True),
    "Require equal known IDs, 600s": lambda plays: cadet_policy(plays, 600, True, True),
    "Pair each copy once, 600s (offline)": pair_once,
    "Shared record key only": lambda plays: by_record_key(plays).values(),
}
counts = {policy: [0, 0] for policy in policies}

for scenario in SCENARIOS:
    for reverse in (False, True):
        plays = scenario["plays"][::-1] if reverse else scenario["plays"]
        key = (scenario["name"], reverse)
        for policy, apply in policies.items():
            retained = list(apply(plays))
            keys = [row_id(play) for play in sorted(retained, key=lambda play: play["key"])]
            if policy == "Unmodified draft, 600s":
                assert keys == draft[key], (key, keys, draft[key])
            if policy == "Local ID guard, 600s":
                assert keys == candidate[key], (key, keys, candidate[key])
            lost, duplicates = score(plays, retained)
            counts[policy][0] += lost
            counts[policy][1] += duplicates

print(f"{len(SCENARIOS)} synthetic cases, two arrival orders each")
print(f"The draft and local-guard models matched all {len(draft) + len(candidate)} observed PostgreSQL results.")
for policy, (lost, duplicates) in counts.items():
    print(f"{policy:<39} {lost:>2} lost listens, {duplicates:>2} duplicate rows")
