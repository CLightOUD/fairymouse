[CmdletBinding()]
param([switch]$Run)
$ErrorActionPreference = 'Stop'
if(-not $Run){throw 'Use -Run to download a fresh local Python and locked dependencies into tests/.work.'}
$root = Split-Path $PSScriptRoot -Parent
$node = (Get-Command node -ErrorAction Stop).Source
$null = Get-Command uv -ErrorAction Stop
$folder = Join-Path $PSScriptRoot ('.work\clean-install-' + [DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds())
New-Item -ItemType Directory -Path $folder -Force | Out-Null
$archive = Join-Path $folder 'source.zip'
& git -C $root archive HEAD --format=zip --output=$archive
if($LASTEXITCODE -ne 0){throw 'Source export failed'}
# Build a Unicode path without relying on the host PowerShell source encoding.
$label = [string][char]0x4e2d + [char]0x6587 + ' space'
$checkout = Join-Path $folder $label
Expand-Archive -LiteralPath $archive -DestinationPath $checkout
# Exercise the candidate installer without requiring a commit or exporting personal data.
foreach($file in @('install.ps1','doctor.mjs','configure.mjs')){
    Copy-Item -LiteralPath (Join-Path $root "scripts\$file") -Destination (Join-Path $checkout "scripts\$file")
}
$runner = Join-Path $folder 'acceptance.mjs'
$source = @'
import assert from 'node:assert/strict';
import {spawn,spawnSync,execFileSync} from 'node:child_process';
import {createInterface} from 'node:readline';
import {existsSync,readFileSync,writeFileSync} from 'node:fs';
import {createHash} from 'node:crypto';
import {join,dirname,resolve} from 'node:path';
const [root,checkout,folder]=process.argv.slice(2);
const powershell=join(process.env.SystemRoot,'System32','WindowsPowerShell','v1.0','powershell.exe');
const installer=join(checkout,'scripts','install.ps1');
const report={status:'failed',validatedAt:new Date().toISOString(),scope:'Same-machine fresh source export, Unicode/space path, empty dedicated uv cache and Python directory; not a second clean Windows machine.',checks:{},failures:[]};
const env={...process.env,UV_CACHE_DIR:join(folder,'uv-cache'),UV_PYTHON_INSTALL_DIR:join(folder,'sentinel-python'),UV_PYTHON_BIN_DIR:join(folder,'sentinel-bin'),PYTHONUTF8:'1'};
delete env.VIRTUAL_ENV;
delete env.UV_PYTHON;
delete env.UV_NO_MANAGED_PYTHON;
delete env.UV_MANAGED_PYTHON;
const psargs=['-NoProfile','-NonInteractive','-ExecutionPolicy','Bypass','-File',installer];
function run(command,args,label,extraEnv=env){
 const start=Date.now();
 const result=spawnSync(command,args,{cwd:folder,env:extraEnv,encoding:'utf8',windowsHide:true,timeout:300000,maxBuffer:8*1024*1024});
 writeFileSync(join(folder,label+'.stdout.log'),result.stdout??'');
 writeFileSync(join(folder,label+'.stderr.log'),result.stderr??'');
 return {...result,elapsedMs:Date.now()-start};
}
function passed(result,label){assert.equal(result.status,0,label+': '+(result.error?.message??result.stderr??''))}
async function mcp(entry,statusTool){
 const child=spawn(process.execPath,[join(checkout,entry)],{cwd:folder,env,windowsHide:true,stdio:['pipe','pipe','pipe']});
 let sequence=0,stderr='';const pending=new Map();
 child.stderr.on('data',b=>stderr+=b);
 child.on('error',error=>{for(const p of pending.values()){clearTimeout(p.timer);p.reject(error)}pending.clear()});
 createInterface({input:child.stdout}).on('line',line=>{
  let message;try{message=JSON.parse(line)}catch(error){for(const p of pending.values()){clearTimeout(p.timer);p.reject(error)}pending.clear();return}
  const p=pending.get(message.id);if(p){clearTimeout(p.timer);pending.delete(message.id);message.error?p.reject(new Error(JSON.stringify(message.error))):p.resolve(message.result)}
 });
 child.on('exit',()=>{for(const p of pending.values()){clearTimeout(p.timer);p.reject(new Error('MCP exited: '+stderr))}pending.clear()});
 const rpc=(method,params={})=>new Promise((resolve,reject)=>{
  const id=++sequence,timer=setTimeout(()=>{pending.delete(id);reject(new Error('MCP timeout: '+method))},20000);
  pending.set(id,{resolve,reject,timer});child.stdin.write(JSON.stringify({jsonrpc:'2.0',id,method,params})+'\n');
 });
 try{
  const initialized=await rpc('initialize',{protocolVersion:'2025-11-25',capabilities:{},clientInfo:{name:'clean-install-acceptance',version:'1'}});
  assert.ok(initialized.serverInfo);
  child.stdin.write(JSON.stringify({jsonrpc:'2.0',method:'notifications/initialized'})+'\n');
  const list=await rpc('tools/list');assert.ok(list.tools.some(tool=>tool.name===statusTool));
  const status=await rpc('tools/call',{name:statusTool,arguments:{}});assert.ok(!status.isError,JSON.stringify(status));
  return {tools:list.tools.length,statusPassed:true};
 }finally{
  child.stdin.end();
  const code=await new Promise(resolve=>{if(child.exitCode!==null)return resolve(child.exitCode);const timer=setTimeout(()=>{child.kill();resolve(null)},5000);child.once('exit',code=>{clearTimeout(timer);resolve(code)})});
  writeFileSync(join(folder,statusTool+'.stderr.log'),stderr);
  assert.equal(code,0,'MCP did not close cleanly');
 }
}
try{
 report.sourceCommit=execFileSync('git',['-C',root,'rev-parse','HEAD'],{encoding:'utf8',windowsHide:true}).trim();
 report.installerSha256=createHash('sha256').update(readFileSync(installer)).digest('hex');
 report.node=process.version;
 report.uv=execFileSync('uv',['--version'],{encoding:'utf8',windowsHide:true}).trim();
 assert.ok(!existsSync(join(checkout,'runtime'))&&!existsSync(join(checkout,'python'))&&!existsSync(join(checkout,'python-managed'))&&!existsSync(env.UV_CACHE_DIR));
 report.checks.freshRuntimeAndCache=true;
 assert.ok(/[^\x00-\x7f]/.test(checkout)&&checkout.includes(' '));report.checks.unicodeAndSpacePath=true;
 const systemPath=[join(process.env.SystemRoot,'System32'),process.env.SystemRoot].join(';');
 const noNode=run(powershell,psargs,'missing-node',{...env,PATH:systemPath});
 assert.notEqual(noNode.status,0);assert.match(noNode.stderr,/Node\.js is required/);report.checks.missingNodeDiagnosed=true;
 const noUv=run(powershell,psargs,'missing-uv',{...env,PATH:dirname(process.execPath)+';'+systemPath});
 assert.notEqual(noUv.status,0);assert.match(noUv.stderr,/uv must already be installed/);report.checks.missingUvDiagnosed=true;
 assert.ok(!existsSync(join(checkout,'runtime')));report.checks.missingPrerequisitesDoNotCreateRuntime=true;
 const dry=run(powershell,[...psargs,'-DryRun'],'dry-run');passed(dry,'Dry-run');assert.equal(JSON.parse(dry.stdout).runtimeExists,false);
 const first=run(powershell,psargs,'first-install');passed(first,'Fresh installation');report.firstInstallMs=first.elapsedMs;report.checks.freshDownloadAndInstall=true;
 const interpreter=join(checkout,'runtime','Scripts','python.exe');
 const details=JSON.parse(execFileSync(interpreter,['-B','-c',"import json,sys;print(json.dumps({'base':sys.base_prefix,'prefix':sys.prefix,'version':sys.version.split()[0]}))"],{encoding:'utf8',windowsHide:true,env}));
 assert.equal(details.version,'3.12.13');assert.ok(resolve(details.base).toLowerCase().startsWith(resolve(join(checkout,'python-managed')).toLowerCase()+'\\'));
 report.checks.projectManagedInterpreter=true;
 assert.ok(!existsSync(env.UV_PYTHON_BIN_DIR)&&!existsSync(env.UV_PYTHON_INSTALL_DIR));report.checks.externalPythonDirectoriesUntouched=true;
 const before=readFileSync(join(checkout,'runtime','pyvenv.cfg'),'utf8');
 const repeat=run(powershell,psargs,'repeat-install');passed(repeat,'Repeat installation');report.repeatInstallMs=repeat.elapsedMs;
 assert.equal(readFileSync(join(checkout,'runtime','pyvenv.cfg'),'utf8'),before);report.checks.repeatInstallPreservesVenv=true;
 const check=run(powershell,[...psargs,'-Check'],'check');passed(check,'Installation diagnostic');assert.equal(JSON.parse(check.stdout).ok,true);report.checks.diagnosticsPassed=true;
 const config=JSON.parse(execFileSync(process.execPath,[join(checkout,'scripts','configure.mjs'),'--agents','writer,reviewer'],{cwd:folder,encoding:'utf8',windowsHide:true}));
 assert.equal(Object.keys(config.mcpServers).length,3);for(const server of Object.values(config.mcpServers)){assert.ok(server.args[0].startsWith(checkout));assert.ok(existsSync(server.args[0]))}report.checks.generatedConfigurationPortable=true;
 report.mcp={desktop:await mcp('desktop/background-mcp.mjs','desktop_status'),hidden:await mcp('hidden/launch.mjs','hidden_status')};
 report.status='passed';
}catch(error){report.failures.push(error.message);process.exitCode=1}
finally{writeFileSync(join(root,'reports','clean-install.json'),JSON.stringify(report,null,2)+'\n');console.log(JSON.stringify(report,null,2))}
'@
[System.IO.File]::WriteAllText($runner,$source,[System.Text.UTF8Encoding]::new($false))
& $node $runner $root $checkout $folder
if($LASTEXITCODE -ne 0){throw "Clean installation acceptance failed; inspect reports/clean-install.json and $folder"}
