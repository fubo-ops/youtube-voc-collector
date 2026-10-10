# Changelog

## 1.1.0 - 2026-10-10

- Replaced product-specific discovery rules with Amazon/SellerSprite-driven product context and generic query families.
- Added cross-category, species, human-use, and unrelated-ASMR video rejection.
- Resume now merges new expanded keywords, checkpoints the candidate pool, and never replays completed queries or videos.
- Added atomic raw-comment checkpoints, hard per-video comment/reply limits, candidate prioritization, profile locking, and accurate stop reasons.
- Quality Gate now covers structural integrity and JSONL/CSV/Excel count agreement only.
- Default output now uses `YouTube评论采集/<ASIN>`.

## 1.0.0-rc1 - 2026-09-16

- Initial standalone raw YouTube comment collector release.
