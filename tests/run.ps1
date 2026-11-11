$ErrorActionPreference='Stop'
$root=Split-Path $PSScriptRoot -Parent
$scratch=Join-Path $PSScriptRoot '.work'
New-Item -ItemType Directory -Path $scratch -Force | Out-Null
$fixture=Join-Path $scratch 'DesktopTrial.exe'
& "$env:WINDIR\Microsoft.NET\Framework64\v4.0.30319\csc.exe" /nologo /target:winexe /reference:System.Windows.Forms.dll /reference:System.Drawing.dll ("/out:"+$fixture) (Join-Path $PSScriptRoot 'DesktopTrial.cs')
if($LASTEXITCODE -ne 0){throw 'Fixture build failed'}
Add-Type -Path (Join-Path $PSScriptRoot 'TrialNative.cs')
$before=[TrialNative]::Read()
& 'D:\nodejs\node.exe' (Join-Path $PSScriptRoot 'smoke.mjs') $before.foreground.ToString()
if($LASTEXITCODE -ne 0){throw 'MCP smoke test failed'}
$after=[TrialNative]::Read()
@{before=$before;after=$after;foregroundUnchanged=($before.foreground -eq $after.foreground)} | ConvertTo-Json -Depth 4 | Set-Content -LiteralPath (Join-Path $root 'reports\foreground.json') -Encoding utf8
if($before.foreground -ne $after.foreground){Write-Warning 'Foreground changed during the test; user activity may be responsible. Inspect before making a no-interference claim.'}
'MCP and hidden desktop tests passed.'
