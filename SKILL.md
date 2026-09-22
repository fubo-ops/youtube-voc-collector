---
name: youtube-voc-collector
description: Collect and preserve raw public YouTube comments and visible replies for one Amazon US ASIN, an ASIN group, or an ASIN file, with checkpoint resume and JSONL/CSV/Excel exports; use when downstream cleaning or VOC analysis must start from a complete source-preserving layer.
---

# YouTube VOC Collector

Turn Amazon ASIN product semantics into focused YouTube discovery. This skill is the raw acquisition layer: preserve every successfully read public comment and visible reply after technical deduplication only. Videos are traceability context, never standalone records.

## Run modes

1. Run `preflight` first when access readiness is unknown. It checks Amazon, SellerSprite, YouTube search, one public video, and comment visibility without collecting formal comments.
2. Collect with `--asin`, `--asins`, or `--asin-file`; `--target-comments` counts technically unique captured comments and replies.
3. Resume with `--resume CHECKPOINT`; add `--retry-partial` or `--force-reaudit-partial` when incomplete videos should be revisited.

```powershell
node scripts/youtube_playwright_collector.cjs preflight --asin B003ULL1NQ --headless 0 --profile-dir .youtube-voc-browser-profile
node scripts/youtube_playwright_collector.cjs --asin B003ULL1NQ --target-comments 100 --target-videos 100 --max-comments-per-video 20 --detail-concurrency 1 --headless 0
```

Read [references/collection-guide.md](references/collection-guide.md) for flags, stopping rules, and outputs. Read [references/raw-record-schema.md](references/raw-record-schema.md) when consuming records.

## Required behavior

- Extract public Amazon product context and visible SellerSprite terms. If SellerSprite is unavailable, retain an explicit degraded reason and continue from Amazon/manual evidence without inventing SellerSprite data.
- Keep search queries anchored to dog joints, canine arthritis, chondroitin, glucosamine, MSM, Cosequin, Dasuquin, and related usage questions. Video audit and semantic fields may be retained as metadata but never control comment delivery.
- Do not remove advertising, promotions, affiliate links, short comments, generic expressions, low-relevance text, or weak evidence. Cleaning, semantic filtering, VOC classification, and trust ratings belong downstream.
- Deduplicate only by stable comment ID. If absent, use exact `video_id + author + comment_text`; never use fuzzy or similarity deduplication.
- Save checkpoint state after each query, video, and reply action. Preserve visible parent/reply lineage and merge only the query/ASIN lineage of confirmed technical duplicates.

## Output contract

Default output is `outputs/youtube` under the caller's working directory. Generate raw comment JSONL/CSV, ASIN keywords, conversation map, query plan, channel map, manifest, checkpoint, per-video evidence, and a five-sheet workbook: `Raw_Comments`, `Query_Plan`, `Video_Audit`, `Run_Summary`, `Quality_Gate`.

Every row has `source_specific.record_type: "comment"`, `source_parent_id: "video:<video_id>"`, comment and direct-parent IDs, parent/depth lineage, video/channel traceability, matched ASINs/keywords, author, time, likes, text, and collection time. Never emit a standalone video row. Manifest counts `raw_captured_count`, `technical_duplicate_count`, and `final_collected_count`; the quality gate checks structural integrity rather than Trusted volume.

## Access boundary

Read only publicly visible page content. Use only the dedicated profile passed by the user. Do not read/export credentials, cookies, tokens, or profile files; do not automate login/CAPTCHA; do not bypass age, region, membership, private-video, or access restrictions. Stop the batch and persist its checkpoint on explicit restriction.
