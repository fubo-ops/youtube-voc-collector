---
name: youtube-voc-collector
description: Collect and preserve raw public YouTube comments and visible replies for any Amazon US product ASIN, ASIN group, or ASIN file; use when Amazon and SellerSprite product semantics should drive YouTube discovery and source-preserving JSONL, CSV, checkpoint, evidence, manifest, and Excel delivery.
---

# YouTube VOC Collector

Build a product context from the current Amazon title, bullet points, and visible SellerSprite terms, then discover product-relevant YouTube videos. This is a raw acquisition layer: preserve every successfully read public comment and visible reply after technical deduplication only. Videos are traceability context, never standalone records.

## Run

1. Run `preflight` when access readiness is unknown.
2. Collect with `--asin`, `--asins`, or `--asin-file`; `--target-comments` counts technically unique comments and replies.
3. Resume with `--resume CHECKPOINT`; new `--expanded-keywords` are merged without replaying completed queries or videos.

```powershell
node scripts/youtube_playwright_collector.cjs preflight --asin B0HMGGX71C --headless 0 --profile-dir .youtube-voc-browser-profile
node scripts/youtube_playwright_collector.cjs --asin B0HMGGX71C --target-comments 800 --videos-per-query 15 --max-comments-per-video 50 --detail-concurrency 3 --headless 0
```

Read [references/collection-guide.md](references/collection-guide.md) for flags and stopping rules. Read [references/raw-record-schema.md](references/raw-record-schema.md) when consuming records.

## Product semantics

- Derive product name, category, attributes, use cases, user problems, effects, materials or ingredients, purchase intent, alternatives, species, and source keywords from the current product context.
- Generate query families from those fields rather than fixed product vocabulary.
- Product semantics may widen discovery while rejecting cross-category results, wrong species, human-use drift, and unrelated ASMR.
- Relevance and PASS/PARTIAL/BLOCKED are diagnostic fields only; they never remove a successfully read raw comment.

## Raw output contract

Default output is `./YouTube评论采集/<ASIN>` under the caller's working directory. Generate JSONL, CSV, ASIN keywords, conversation map, query plan, channel map, manifest, atomic checkpoint, per-video evidence, and a five-sheet workbook: `Raw_Comments`, `Query_Plan`, `Video_Audit`, `Run_Summary`, `Quality_Gate`.

Every row is `record_type: "comment"` with `source_parent_id: "video:<video_id>"`. Preserve main comments and visible replies, including direct-parent ID and depth. Deduplicate only by stable comment ID; when absent, use exact `video_id + author + comment_text`. Never emit a standalone video row.

## Completion and access

Continue product-related discovery until the comment target, configured resource limit, access restriction, or consecutive product-query rounds with no additions. Save query candidates, video state, comments, and reply actions atomically so resume prefers new work. `max-reply-actions` and `max-comments-per-video` are hard per-video bounds; unfinished videos are PARTIAL and their captured comments remain deliverable.

Read only publicly visible content. Use only the dedicated profile supplied by the user. Do not read or export credentials, cookies, tokens, or profile files; do not automate login or CAPTCHA; do not bypass age, region, membership, private-video, or access restrictions.
