# Collection guide

## Inputs and completion

Use exactly one or combine any of `--asin ASIN`, `--asins "ASIN1,ASIN2"`, and `--asin-file FILE`; values merge and deduplicate. `--target-comments` counts technically unique captured comments and visible replies. `--target-videos` is the maximum inspected-video budget.

Defaults: `target-comments=100`, `target-videos=100`, `videos-per-query=15`, `max-comments-per-video=20`, `detail-concurrency=1`, `max-discovery-rounds=3`. Search is serial; detail pages use a bounded 1–6 page pool. Raise concurrency only after a successful smoke run.

## Discovery and audit

Round 1 uses Amazon, visible SellerSprite, and `--expanded-keywords`. Search remains product/problem anchored. PASS/PARTIAL/BLOCKED and relevance fields are diagnostic metadata only and never remove a captured comment from raw delivery.

Top-level comments use `parent_comment_id=null`, `depth=0`; replies point to the direct parent. All levels keep `source_parent_id=video:<video_id>`. Only empty/tombstone placeholders and confirmed technical duplicates are omitted. Advertising, bot text, links, short comments, low relevance, and all sentiments are retained.

## Commands

```powershell
node scripts/youtube_playwright_collector.cjs --help
node scripts/youtube_playwright_collector.cjs preflight --asin B003ULL1NQ --headless 0 --profile-dir .youtube-voc-browser-profile
node scripts/youtube_playwright_collector.cjs --asins "B003ULL1NQ,B000000000" --target-comments 100 --target-videos 100 --videos-per-query 15 --max-comments-per-video 20 --max-reply-actions 40 --detail-concurrency 1 --max-discovery-rounds 3 --headless 0 --out-dir outputs/youtube --profile-dir .youtube-voc-browser-profile
node scripts/youtube_playwright_collector.cjs --asin-file asins.txt --resume outputs/youtube/RUN_checkpoint.json --retry-partial
```

## Files

- `*_raw_comments.jsonl`, `*_comments_raw.csv`
- `*_asin_keywords.json`, `*_conversation_map.json`, `*_query_plan.json`, `*_community_or_channel_map.json`
- `*_manifest.json`, `*_checkpoint.json`, timestamped `.xlsx`
- `evidence/VIDEO_ID/{audit,comment_tree,frontier,action_ledger}.json`

Run `build_youtube_excel.mjs` to rebuild a workbook without collection. Run `rebuild_raw_collection.cjs` to recover raw rows from saved evidence and legacy JSONL. Preflight supports `--fixture FILE` and never calls formal comment collection.
