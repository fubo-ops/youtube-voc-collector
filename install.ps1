param([string]$SkillsRoot=(Join-Path $HOME '.codex\skills'))
$ErrorActionPreference='Stop'
$source=if(Test-Path (Join-Path $PSScriptRoot 'youtube-voc-collector\SKILL.md')){Join-Path $PSScriptRoot 'youtube-voc-collector'}else{$PSScriptRoot}
$target=Join-Path $SkillsRoot 'youtube-voc-collector'
New-Item -ItemType Directory -Force $SkillsRoot|Out-Null
if(Test-Path $target){Remove-Item -LiteralPath $target -Recurse -Force}
New-Item -ItemType Directory -Force $target|Out-Null
foreach($name in @('agents','references','scripts')){Copy-Item -LiteralPath (Join-Path $source $name) -Destination $target -Recurse -Force}
foreach($name in @('SKILL.md','VERSION')){Copy-Item -LiteralPath (Join-Path $source $name) -Destination $target -Force}
[ordered]@{status='installed';path=(Resolve-Path $target).Path;version=(Get-Content (Join-Path $target 'VERSION') -Raw).Trim()}|ConvertTo-Json
