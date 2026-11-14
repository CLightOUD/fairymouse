[CmdletBinding()]
param([switch]$FreshInstall)
$ErrorActionPreference='Stop'
$node=(Get-Command node -ErrorAction Stop).Source
# Preserve the invoking PowerShell version in child test runs (5.1 or 7).
$shellPath=(Get-Process -Id $PID).Path
$arguments=@((Join-Path $PSScriptRoot 'ci.mjs'),'--shell',$shellPath)
if($FreshInstall){$arguments+='--fresh-install'}
& $node @arguments
if($LASTEXITCODE -ne 0){throw 'Windows checks failed; inspect tests/.work/ci/summary.json'}
