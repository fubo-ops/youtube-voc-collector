#!/usr/bin/env python3
"""Coerce lightly structured VOC rows into the canonical raw JSONL envelope."""

from __future__ import annotations

import argparse
import hashlib
import json
from datetime import datetime, timezone
from pathlib import Path
from typing import Any


def utc_now() -> str:
    return datetime.now(timezone.utc).replace(microsecond=0).isoformat().replace("+00:00", "Z")


def first_value(row: dict[str, Any], *keys: str) -> Any:
    for key in keys:
        value = row.get(key)
        if value not in (None, ""):
            return value
    return None


def stable_id(source: str, row: dict[str, Any]) -> str:
    explicit = first_value(row, "source_item_id", "id", "review_id", "comment_id", "post_id")
    if explicit:
        return str(explicit)
    material = json.dumps(row, sort_keys=True, ensure_ascii=False)
    digest = hashlib.sha256(f"{source}:{material}".encode("utf-8")).hexdigest()[:16]
    return f"derived-{digest}"


def normalize(row: dict[str, Any], source: str, query: str | None, collected_at: str) -> dict[str, Any]:
    text = first_value(row, "text", "body", "review_body", "comment_text", "content")
    title = first_value(row, "title", "review_title", "post_title", "video_title")
    url = first_value(row, "url", "permalink", "review_url", "comment_url")
    parent_id = first_value(row, "source_parent_id", "parent_id", "thread_id", "post_id", "video_id")
    metadata = row.get("metadata") if isinstance(row.get("metadata"), dict) else {}

    common_keys = {
        "schema_version", "source", "source_item_id", "source_parent_id", "collected_at",
        "observed_at", "query", "topic", "filters", "collector", "url", "permalink",
        "thread_url", "position", "capture_method", "access_notes", "title", "review_title",
        "post_title", "video_title", "text", "body", "review_body", "comment_text", "content",
        "language", "media_refs", "author", "handle", "profile_url", "is_verified", "score",
        "rating", "likes", "replies", "views", "metadata", "created_at", "published_at",
    }

    return {
        "schema_version": "voc_raw_v1",
        "source": source,
        "source_item_id": stable_id(source, row),
        "source_parent_id": parent_id,
        "collected_at": first_value(row, "collected_at") or collected_at,
        "observed_at": first_value(row, "observed_at", "created_at", "published_at"),
        "query_context": {
            "query": first_value(row, "query") or query,
            "topic": first_value(row, "topic"),
            "filters": row.get("filters") if isinstance(row.get("filters"), dict) else {},
            "collector": first_value(row, "collector") or "normalized-jsonl",
        },
        "provenance": {
            "url": url,
            "thread_url": first_value(row, "thread_url"),
            "position": first_value(row, "position"),
            "capture_method": first_value(row, "capture_method") or "input-jsonl",
            "access_notes": first_value(row, "access_notes"),
        },
        "content": {
            "title": title,
            "text": text,
            "language": first_value(row, "language"),
            "media_refs": row.get("media_refs") if isinstance(row.get("media_refs"), list) else [],
        },
        "author": {
            "handle": first_value(row, "author", "handle"),
            "profile_url": first_value(row, "profile_url"),
            "is_verified": first_value(row, "is_verified"),
        },
        "engagement": {
            "score": first_value(row, "score"),
            "rating": first_value(row, "rating"),
            "likes": first_value(row, "likes"),
            "replies": first_value(row, "replies"),
            "views": first_value(row, "views"),
        },
        "source_specific": {
            **metadata,
            **{key: value for key, value in row.items() if key not in common_keys},
        },
    }


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("input", type=Path)
    parser.add_argument("output", type=Path)
    parser.add_argument("--source", required=True)
    parser.add_argument("--query")
    args = parser.parse_args()

    collected_at = utc_now()
    count = 0
    with args.input.open("r", encoding="utf-8") as src, args.output.open("w", encoding="utf-8") as dst:
        for line_number, line in enumerate(src, start=1):
            if not line.strip():
                continue
            try:
                row = json.loads(line)
            except json.JSONDecodeError as exc:
                raise SystemExit(f"Invalid JSON on line {line_number}: {exc}") from exc
            if not isinstance(row, dict):
                raise SystemExit(f"Line {line_number} must be a JSON object")
            dst.write(json.dumps(normalize(row, args.source, args.query, collected_at), ensure_ascii=False) + "\n")
            count += 1

    print(f"Wrote {count} records to {args.output}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
