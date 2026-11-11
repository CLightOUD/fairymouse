// Read-only compatibility gate. Never activate UWP Calculator on the main desktop.
import {execFileSync} from 'node:child_process';
import {dirname,join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {mkdirSync,writeFileSync} from 'node:fs';
import {finishTrace,reportPath} from './app_harness.mjs';
const root=dirname(dirname(fileURLToPath(import.meta.url)));
const report={app:'Windows Calculator',status:'skipped',validatedAt:new Date().toISOString(),physicalInputUsed:false,launched:false};
const code=`$ErrorActionPreference='Stop'
$processes=@(Get-Process -Name CalculatorApp,Calculator,calc -ErrorAction SilentlyContinue | Select-Object -ExpandProperty Id)
$package=Get-AppxPackage Microsoft.WindowsCalculator
$entry='';$executable=''
if($package){
 [xml]$manifest=Get-Content -LiteralPath (Join-Path $package.InstallLocation 'AppxManifest.xml')
 $application=$manifest.Package.Applications.Application | Select-Object -First 1
 $entry=[string]$application.EntryPoint
 $executable=[string]$application.Executable
}
@{processCount=$processes.Count;version=([string]$package.Version);entryPoint=$entry;executable=$executable}|ConvertTo-Json -Compress`;
try{
 const preflight=JSON.parse(execFileSync('powershell',['-NoProfile','-Command',code],{windowsHide:true,encoding:'utf8',timeout:15000}).trim());
 Object.assign(report,preflight);
 if(preflight.processCount)report.reason='Existing Calculator process detected; no launch or interaction attempted';
 else if(!preflight.version)report.reason='Calculator package metadata unavailable; no launch attempted';
 else if(preflight.entryPoint!=='Windows.FullTrustApplication'){
  report.status='unsupported';
  report.reason='Installed Calculator declares a UWP entry point. Shell/AppActivation cannot guarantee the requested hidden desktop, so no launch, calculation, screenshot, or foreground fallback was attempted';
 }else report.reason='Full-trust Calculator detected but this build lacks a verified isolated launch contract; no launch attempted';
}catch(error){report.status='failed';report.reason=error.message;process.exitCode=1}
const output=reportPath('calculator-apps.json');mkdirSync(dirname(output),{recursive:true});
writeFileSync(output,JSON.stringify(report,null,2));
finishTrace(report.status);console.log(JSON.stringify(report));
