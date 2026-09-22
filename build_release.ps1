param([string]$Version='1.0.0-rc1')
$ErrorActionPreference='Stop';$root=$PSScriptRoot;$dist=Join-Path $root 'dist';$stage=Join-Path $dist "youtube-voc-collector-$Version";$payload=Join-Path $stage 'youtube-voc-collector'
if(Test-Path $dist){Remove-Item -LiteralPath $dist -Recurse -Force};New-Item -ItemType Directory -Force $payload|Out-Null
Get-ChildItem $root -Recurse -Directory -Filter __pycache__|Where-Object{$_.FullName -notlike "$dist*"}|Remove-Item -Recurse -Force
Get-ChildItem $root -Recurse -File -Include *.pyc,*.pyo|Where-Object{$_.FullName -notlike "$dist*"}|Remove-Item -Force
foreach($name in @('agents','references','scripts','tests','.github')){if(Test-Path (Join-Path $root $name)){Copy-Item -LiteralPath (Join-Path $root $name) -Destination $payload -Recurse -Force}}
foreach($name in @('SKILL.md','VERSION')){Copy-Item -LiteralPath (Join-Path $root $name) -Destination $payload -Force}
foreach($name in @('install.ps1','install.cmd','doctor.ps1','uninstall.ps1','uninstall.cmd','README.md','LICENSE','CHANGELOG.md','SECURITY.md')){Copy-Item -LiteralPath (Join-Path $root $name) -Destination $stage -Force}
$bad=@(Get-ChildItem $stage -Recurse -File|Where-Object{$_.Extension -in '.pem','.key','.pfx','.pyc','.log' -or $_.FullName -match '\\outputs\\|__pycache__|browser-profile|youtube-voc-browser-profile|\\cookies?\\|\\tokens?\\'})
if($bad){throw "Unsafe release files: $($bad.FullName -join ', ')"}
$files=@(Get-ChildItem $stage -Recurse -File|ForEach-Object{$_.FullName.Substring($stage.Length+1).Replace('\','/')})
$manifest=[ordered]@{name='youtube-voc-collector';version=$Version;files=$files;built_at=(Get-Date).ToUniversalTime().ToString('o')}
$manifest|ConvertTo-Json -Depth 4|Set-Content (Join-Path $stage 'release-manifest.json') -Encoding utf8
$zip=Join-Path $dist "youtube-voc-collector-$Version.zip";Compress-Archive -Path "$stage\*" -DestinationPath $zip -CompressionLevel Optimal
$stream=[IO.File]::OpenRead($zip);try{$sha=[Security.Cryptography.SHA256]::Create();$hash=([BitConverter]::ToString($sha.ComputeHash($stream))).Replace('-','').ToLower()}finally{$stream.Dispose()};"$hash  $([IO.Path]::GetFileName($zip))"|Set-Content (Join-Path $dist 'SHA256SUMS.txt') -Encoding ascii
Copy-Item (Join-Path $stage 'release-manifest.json') (Join-Path $dist 'release-manifest.json') -Force
[ordered]@{status='built';zip=(Resolve-Path $zip).Path;sha256=$hash;files=$files.Count}|ConvertTo-Json
