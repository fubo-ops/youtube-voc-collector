# Raw comment record schema

JSONL is UTF-8 with one public visible comment or reply per row. Standalone video records are invalid.

Required identity and lineage:

```json
{
  "schema_version": "voc_raw_v1",
  "source": "youtube",
  "record_type": "comment",
  "source_item_id": "comment:VIDEO_ID:COMMENT_ID",
  "source_parent_id": "video:VIDEO_ID",
  "comment_id": "COMMENT_ID",
  "parent_comment_id": null,
  "depth": 0,
  "video_id": "VIDEO_ID",
  "video_title": "Title",
  "video_url": "https://www.youtube.com/watch?v=VIDEO_ID",
  "channel_title": "Channel",
  "channel_url": "https://www.youtube.com/@channel",
  "amazon_asins": ["ASIN"],
  "matched_query": "product-driven query",
  "keyword_sources": ["amazon", "sellersprite", "product_context:use_case"],
  "author": {"handle": "Visible author"},
  "published_at": "2 weeks ago",
  "like_count": "2",
  "comment_text": "Visible comment text",
  "collected_at": "ISO-8601",
  "audit_status": "PASS",
  "source_specific": {"record_type": "comment"}
}
```

`relevance_tier`, `semantic_link`, `evidence_reason`, `confidence`, and `audit_status` are optional diagnostics and never delivery filters. Advertising, links, short text, generic wording, weak evidence, PASS, PARTIAL, and BLOCKED rows remain in raw output when successfully read.

Technical deduplication uses stable comment ID only. When an ID is absent, use the exact tuple `video_id + author + comment_text`; never fuzzy-match. Manifest counts must reconcile `raw_captured_count`, `technical_duplicate_count`, `final_collected_count`, `main_comment_count`, `reply_count`, `executed_query_count`, `deduplicated_video_count`, and `video_record_count=0`. Quality Gate checks required fields, URLs, parent lineage, duplicate IDs, record type, and JSONL/CSV/Excel count agreement.
