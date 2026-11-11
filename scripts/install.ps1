[CmdletBinding()]
param([switch]$Check, [switch]$DryRun)
$ErrorActionPreference = 'Stop'
$root = Split-Path $PSScriptRoot -Parent
$node = Get-Command node -ErrorAction SilentlyContinue
$uv = Get-Command uv -ErrorAction SilentlyContinue
$python = Join-Path $root 'runtime\Scripts\python.exe'
$lock = Join-Path $root 'requirements.lock'
$plan = [ordered]@{
    root=$root; pythonVersion='3.12.13'; nodeAvailable=([bool]$node); uvAvailable=([bool]$uv)
    runtimeExists=(Test-Path -LiteralPath $python); lockExists=(Test-Path -LiteralPath $lock)
    changes=@('Create the local runtime venv if missing', 'Sync dependencies from requirements.lock', 'Run read-only diagnostics')
    clientConfiguration='Not modified; node scripts/configure.mjs prints configuration'
}
if($DryRun){$plan | ConvertTo-Json -Depth 4; exit 0}
if(-not $node){throw 'Node.js is required on PATH; this script does not install system software.'}
if($Check){& $node.Source (Join-Path $PSScriptRoot 'doctor.mjs'); exit $LASTEXITCODE}
if(-not $uv){throw 'uv must already be installed on PATH. No third-party installer is downloaded or executed.'}
if(-not (Test-Path -LiteralPath $lock)){throw 'requirements.lock is missing'}
if(Test-Path -LiteralPath $python){
    $actual = & $python -B -c 'import platform;print(platform.python_version())'
    if($LASTEXITCODE -ne 0 -or $actual -ne '3.12.13'){throw 'Existing runtime is not Python 3.12.13; preserve it and prepare the required version manually.'}
}else{
    $bundled = Join-Path $root 'python\python.exe'
    if(Test-Path -LiteralPath $bundled){
        $actual = & $bundled -B -c 'import platform;print(platform.python_version())'
        if($LASTEXITCODE -ne 0 -or $actual -ne '3.12.13'){throw 'Bundled Python is not the pinned version'}
        & $uv.Source venv --python $bundled (Join-Path $root 'runtime')
    }else{
        $previous = $env:UV_PYTHON_INSTALL_DIR
        try{
            $env:UV_PYTHON_INSTALL_DIR = Join-Path $root 'python-managed'
            & $uv.Source python install 3.12.13
            if($LASTEXITCODE -ne 0){throw 'Pinned Python download/install failed'}
            & $uv.Source venv --python 3.12.13 (Join-Path $root 'runtime')
        }finally{$env:UV_PYTHON_INSTALL_DIR=$previous}
    }
    if($LASTEXITCODE -ne 0){throw 'Virtual environment creation failed'}
}
& $uv.Source pip sync --python $python $lock
if($LASTEXITCODE -ne 0){throw 'Locked dependency installation failed'}
& $node.Source (Join-Path $PSScriptRoot 'doctor.mjs')
if($LASTEXITCODE -ne 0){throw 'Installation diagnostics failed'}
