param([string]$SkillsRoot=(Join-Path $HOME '.codex\skills'))
$ErrorActionPreference='Stop';$skill=Join-Path $SkillsRoot 'youtube-voc-collector'
$required=@('SKILL.md','VERSION','agents\openai.yaml','scripts\youtube_playwright_collector.cjs','scripts\youtube_voc_core.cjs','scripts\normalize_raw_jsonl.py','scripts\build_youtube_excel.mjs')
$missing=@($required|Where-Object{-not(Test-Path (Join-Path $skill $_))});if($missing){throw "Missing: $($missing -join ', ')"}
& node --check (Join-Path $skill 'scripts\youtube_playwright_collector.cjs');if($LASTEXITCODE){throw 'collector syntax failed'}
$help=(& node (Join-Path $skill 'scripts\youtube_playwright_collector.cjs') --help 2>&1|Out-String);if($LASTEXITCODE -or $help -notmatch 'target-comments'){throw 'collector help failed'}
[ordered]@{status='ready';path=(Resolve-Path $skill).Path;version=(Get-Content (Join-Path $skill 'VERSION') -Raw).Trim()}|ConvertTo-Json
