#!/usr/bin/env python3
"""Extract a bounded, reproducible candidate set from public ListenBrainz data."""

import argparse
import hashlib
import heapq
import json
import sys
import uuid


def recording_id(value):
    if not isinstance(value, str):
        return None
    try:
        return str(uuid.UUID(value))
    except ValueError:
        return None


def project(listen):
    metadata = listen.get("track_metadata") or {}
    track = metadata.get("track_name")
    artist = metadata.get("artist_name")
    if not all(isinstance(value, str) and value.strip() for value in (track, artist)):
        return None

    additional = metadata.get("additional_info") or {}
    mapping = metadata.get("mbid_mapping") or {}
    client = recording_id(additional.get("recording_mbid"))
    mapped = recording_id(mapping.get("recording_mbid"))
    release = metadata.get("release_name") or None
    if client and mapped and client != mapped:
        tier = "conflicting_ids"
    elif client:
        tier = "client_id_needs_validation"
    elif mapped:
        tier = "server_mapping_only"
    else:
        tier = "unlabeled"

    return {
        "track": track,
        "artist": artist,
        "release": release,
        "client_recording_id": client,
        "mapped_recording_id": mapped,
        "label_tier": tier,
        "isrc": additional.get("isrc") or None,
        "spotify_id": additional.get("spotify_id") or None,
    }


def sample(listens, quota, seed):
    selected = {}
    buckets = {}
    for listen in listens:
        row = project(listen)
        if row is None:
            continue
        tier = row["label_tier"]
        keys = selected.setdefault(tier, set())
        heap = buckets.setdefault(tier, [])
        key = json.dumps(row, ensure_ascii=False, sort_keys=True)
        if key in keys:
            continue
        digest = hashlib.sha256(f"{seed}\n{key}".encode()).digest()
        entry = (-int.from_bytes(digest, "big"), key)
        if len(heap) == quota:
            if entry <= heap[0]:
                continue
            _, removed = heapq.heapreplace(heap, entry)
            keys.remove(removed)
        else:
            heapq.heappush(heap, entry)
        keys.add(key)

    for tier in sorted(buckets):
        for _, row in sorted(buckets[tier], reverse=True):
            yield row


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--per-tier", type=int, default=250)
    parser.add_argument("--seed", default="teal-listens-v1")
    parser.add_argument("--api", action="store_true", help="Read one ListenBrainz API page instead of .listens JSONL")
    args = parser.parse_args()
    if args.per_tier < 1:
        parser.error("--per-tier must be positive")

    if args.api:
        listens = json.load(sys.stdin)["payload"]["listens"]
    else:
        listens = (json.loads(line) for line in sys.stdin if line.strip())
    for row in sample(listens, args.per_tier, args.seed):
        print(row)


if __name__ == "__main__":
    main()
