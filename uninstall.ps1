param([string]$SkillsRoot=(Join-Path $HOME '.codex\skills'))
$ErrorActionPreference='Stop';$target=Join-Path $SkillsRoot 'youtube-voc-collector'
if(Test-Path $target){Remove-Item -LiteralPath $target -Recurse -Force}
[ordered]@{status='uninstalled';path=$target}|ConvertTo-Json
