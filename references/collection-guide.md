# Collection guide

## Inputs and limits

Combine `--asin`, `--asins`, and `--asin-file`; values merge and deduplicate. `--target-comments` counts technically unique comments and visible replies. `--target-videos` and `--max-discovery-rounds` are resource limits. Each query scans `--videos-per-query` results before global video-ID deduplication.

Defaults: `target-comments=100`, `target-videos=100`, `videos-per-query=15`, `max-comments-per-video=20`, `max-reply-actions=40`, `detail-concurrency=1`, `max-discovery-rounds=3`. Detail concurrency is limited to 1–6 pages. A collector lock prevents two processes from using the same profile directory.

## Product context and discovery

Amazon title and bullets plus visible SellerSprite terms populate product name, category, attributes, use cases, problems, effects, materials/ingredients, purchase intent, alternatives, and species. Query families stay anchored to the current product. Video audit rejects cross-category, wrong-species, human-use, and unrelated-ASMR drift.

When the target is incomplete, later rounds use product context and supported YouTube wording. One empty round does not end collection. Stop reasons are `target_comments_reached`, `max_videos_reached`, `max_discovery_rounds`, `access_*`, `product_query_exhausted`, or `user_stopped`.

## Raw delivery and resume

PASS, PARTIAL, BLOCKED, short, generic, promotional, linked, and weak-evidence comments remain in raw delivery after technical deduplication. Top-level comments use `parent_comment_id=null`, `depth=0`; replies keep the direct parent. All rows keep `source_parent_id=video:<video_id>`.

Checkpoint writes are atomic after every query, completed video, and reply action. The candidate pool is checkpointed. Resume merges new `--expanded-keywords`, skips executed queries, and skips PASS/BLOCKED videos unless an explicit supported retry mode applies. Per-video comment and reply limits are hard bounds; remaining reply controls yield PARTIAL rather than lost data.

## Commands

```powershell
node scripts/youtube_playwright_collector.cjs --help
node scripts/youtube_playwright_collector.cjs preflight --asin ASIN --headless 0 --profile-dir .youtube-voc-browser-profile
node scripts/youtube_playwright_collector.cjs --asin ASIN --target-comments 800 --videos-per-query 15 --max-comments-per-video 50 --max-reply-actions 15 --detail-concurrency 3 --headless 0 --profile-dir .youtube-voc-browser-profile
node scripts/youtube_playwright_collector.cjs --asin ASIN --resume "YouTube评论采集/ASIN/RUN_checkpoint.json" --expanded-keywords "PRODUCT QUERY,USE CASE QUERY"
```

Default files are written under `./YouTube评论采集/<ASIN>`: raw JSONL/CSV, keyword and conversation maps, query plan, channel map, manifest, checkpoint, evidence, and XLSX. Use `build_youtube_excel.mjs` to rebuild a workbook and `rebuild_raw_collection.cjs` to recover rows from evidence.
