param([switch]$RealApps, [switch]$ParallelApps, [switch]$Headless)
$ErrorActionPreference='Stop'
if($Headless -and ($RealApps -or $ParallelApps)){throw 'Headless cannot be combined with real GUI application tests'}
$root=Split-Path $PSScriptRoot -Parent
& (Join-Path $root 'runtime\Scripts\python.exe') -B (Join-Path $PSScriptRoot 'test_reliability.py')
if($LASTEXITCODE -ne 0){throw 'Reliability regression tests failed'}
& (Join-Path $root 'runtime\Scripts\python.exe') -B (Join-Path $PSScriptRoot 'test_observations.py')
if($LASTEXITCODE -ne 0){throw 'Observation and lease tests failed'}
& (Join-Path $root 'runtime\Scripts\python.exe') -B (Join-Path $PSScriptRoot 'test_controls.py')
if($LASTEXITCODE -ne 0){throw 'Control tests failed'}
& (Join-Path $root 'runtime\Scripts\python.exe') -B (Join-Path $PSScriptRoot 'test_semantic.py')
if($LASTEXITCODE -ne 0){throw 'Hidden semantic bridge tests failed'}
& (Join-Path $root 'runtime\Scripts\python.exe') -B (Join-Path $PSScriptRoot 'test_recovery.py')
if($LASTEXITCODE -ne 0){throw 'Worker recovery tests failed'}
& (Join-Path $root 'runtime\Scripts\python.exe') -B (Join-Path $PSScriptRoot 'test_foreground_probe.py')
if($LASTEXITCODE -ne 0){throw 'Foreground sampling diagnostic tests failed'}
& (Join-Path $root 'runtime\Scripts\python.exe') -B (Join-Path $PSScriptRoot 'test_resource_usage.py')
if($LASTEXITCODE -ne 0){throw 'Resource measurement tests failed'}
$scratch=Join-Path $PSScriptRoot '.work'
New-Item -ItemType Directory -Path $scratch -Force | Out-Null
$node=(Get-Command node -ErrorAction Stop).Source
& $node (Join-Path $PSScriptRoot 'test_protocol.mjs')
if($LASTEXITCODE -ne 0){throw 'Desktop protocol tests failed'}
& $node (Join-Path $PSScriptRoot 'test_install.mjs')
if($LASTEXITCODE -ne 0){throw 'Installation tests failed'}
& $node (Join-Path $PSScriptRoot 'test_app_harness.mjs')
if($LASTEXITCODE -ne 0){throw 'Application monitor contract tests failed'}
& $node (Join-Path $PSScriptRoot 'test_mcp_headless.mjs')
if($LASTEXITCODE -ne 0){throw 'Headless MCP transport tests failed'}
if($Headless){
    'Headless contracts passed. Real GUI, foreground interference and screenshots are not covered.'
    return
}
$fixture=Join-Path $scratch 'DesktopTrial.exe'
& "$env:WINDIR\Microsoft.NET\Framework64\v4.0.30319\csc.exe" /nologo /target:winexe /reference:System.Windows.Forms.dll /reference:System.Drawing.dll ("/out:"+$fixture) (Join-Path $PSScriptRoot 'DesktopTrial.cs')
if($LASTEXITCODE -ne 0){throw 'Fixture build failed'}
Add-Type -Path (Join-Path $PSScriptRoot 'TrialNative.cs')
$before=[TrialNative]::Read()
& $node (Join-Path $PSScriptRoot 'smoke.mjs') $before.foreground.ToString()
if($LASTEXITCODE -ne 0){throw 'MCP smoke test failed'}
& (Join-Path $root 'runtime\Scripts\python.exe') -B -c "from PIL import Image; im=Image.open(r'$root\reports\hidden-test.png'); im.load(); assert max(im.size)<=320; assert any(lo!=hi for lo,hi in im.convert('RGB').getextrema()), 'Blank fixture screenshot'"
if($LASTEXITCODE -ne 0){throw 'Screenshot pixel validation failed'}
$after=[TrialNative]::Read()
@{before=$before;after=$after;foregroundUnchanged=($before.foreground -eq $after.foreground)} | ConvertTo-Json -Depth 4 | Set-Content -LiteralPath (Join-Path $root 'reports\foreground.json') -Encoding utf8
if($before.foreground -ne $after.foreground){Write-Warning 'Foreground changed during the test; user activity may be responsible. Inspect before making a no-interference claim.'}
'MCP and hidden desktop tests passed.'
if($RealApps){
    & $node (Join-Path $PSScriptRoot 'real_apps.mjs') --run
    if($LASTEXITCODE -ne 0){throw 'Real application regression failed; inspect reports/real-apps.json'}
    & $node (Join-Path $PSScriptRoot 'edge_apps.mjs') --run
    if($LASTEXITCODE -ne 0){throw 'Edge regression failed; inspect reports/edge-apps.json'}
    & $node (Join-Path $PSScriptRoot 'wps_apps.mjs') --run
    if($LASTEXITCODE -ne 0){throw 'WPS regression failed; inspect reports/wps-apps.json'}
    & $node (Join-Path $PSScriptRoot 'wps_formats.mjs') --run --format both
    if($LASTEXITCODE -ne 0){throw 'WPS DOCX/XLSX regression failed; inspect reports/wps-formats.json'}
    & $node (Join-Path $PSScriptRoot 'edge_native_save.mjs') --run
    if($LASTEXITCODE -ne 0){throw 'Edge native save regression failed; inspect reports/edge-native-save.json'}
    & $node (Join-Path $PSScriptRoot 'paint_apps.mjs') --run
    if($LASTEXITCODE -ne 0){throw 'Paint regression failed; inspect reports/paint-apps.json'}
    'Real application compatibility result recorded in reports/real-apps.json (unsupported is not a save-success claim).'
}
if($ParallelApps){
    & $node (Join-Path $PSScriptRoot 'parallel_apps.mjs') --run --paint
    if($LASTEXITCODE -ne 0){throw 'Parallel real application regression failed; inspect reports/parallel-apps.json'}
}
