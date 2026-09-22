# Comment record schema

JSONL is UTF-8 with one public visible comment or reply per row. No video records are valid.

Required lineage fields (relevance/audit fields are optional diagnostics and never delivery filters):

```json
{
  "schema_version": "voc_raw_v1",
  "platform": "youtube",
  "source_item_id": "comment:VIDEO_ID:COMMENT_ID",
  "source_parent_id": "video:VIDEO_ID",
  "asin": "ASIN",
  "matched_asins": ["ASIN"],
  "query": "observed or seed query",
  "matched_keywords": ["query"],
  "discovery_round": 1,
  "relevance_tier": "direct_product",
  "semantic_link": "explicit product or brand mention",
  "evidence_reason": "matched: product name",
  "confidence": 0.91,
  "video_id": "VIDEO_ID",
  "video_title": "Title",
  "video_url": "https://www.youtube.com/watch?v=VIDEO_ID",
  "channel_id": null,
  "channel_title": "Channel",
  "channel_url": "https://www.youtube.com/@channel",
  "comment_id": "COMMENT_ID",
  "parent_comment_id": null,
  "depth": 0,
  "author": {"handle": "Visible author"},
  "author_channel_url": "https://www.youtube.com/@author",
  "body": "Visible comment text",
  "like_count": "2",
  "is_pinned": false,
  "is_creator_hearted": false,
  "created_at_or_visible_time": "2 weeks ago",
  "comment_url": "https://www.youtube.com/watch?v=VIDEO_ID&lc=COMMENT_ID",
  "collected_at": "2026-09-16T00:00:00Z",
  "audit_status": "PASS",
  "source_specific": {"record_type": "comment"}
}
```

Every captured row enters raw delivery regardless of relevance tier, audit status, advertising, links, length, or evidence strength. Global technical deduplication uses stable comment ID only; if missing, it uses the exact tuple `video_id + author + comment_text`. It merges lineage for confirmed duplicates and performs no fuzzy deduplication.
