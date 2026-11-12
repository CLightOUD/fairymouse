import assert from 'node:assert/strict';
import {execFileSync,spawnSync} from 'node:child_process';
import {dirname,join,isAbsolute} from 'node:path';
import {fileURLToPath} from 'node:url';
const root=dirname(dirname(fileURLToPath(import.meta.url)));
const configure=join(root,'scripts','configure.mjs');
const config=JSON.parse(execFileSync(process.execPath,[configure,'--agents','writer,reviewer'],{cwd:process.env.TEMP,encoding:'utf8',windowsHide:true}));
assert.equal(Object.keys(config.mcpServers).length,3);
for(const value of Object.values(config.mcpServers)){assert.ok(isAbsolute(value.command));assert.ok(isAbsolute(value.args[0]));}
assert.notEqual(spawnSync(process.execPath,[configure,'--agents','same,same'],{windowsHide:true}).status,0);
assert.notEqual(spawnSync(process.execPath,[configure,'--agents','../bad'],{windowsHide:true}).status,0);
const plan=JSON.parse(execFileSync('powershell',['-NoProfile','-ExecutionPolicy','Bypass','-File',join(root,'scripts','install.ps1'),'-DryRun'],{encoding:'utf8',windowsHide:true}));
assert.equal(plan.pythonVersion,'3.12.13');assert.ok(plan.lockExists);assert.ok(plan.clientConfiguration.startsWith('Not modified'));
const powershell=join(process.env.SystemRoot,'System32','WindowsPowerShell','v1.0','powershell.exe');
const systemPath=[join(process.env.SystemRoot,'System32'),process.env.SystemRoot].join(';');
for(const [path,message] of [[systemPath,/Node\.js is required/],[dirname(process.execPath)+';'+systemPath,/uv must already be installed/]]){
 const missing=spawnSync(powershell,['-NoProfile','-NonInteractive','-ExecutionPolicy','Bypass','-File',join(root,'scripts','install.ps1')],
  {encoding:'utf8',windowsHide:true,env:{...process.env,PATH:path}});
 assert.notEqual(missing.status,0);assert.match(missing.stderr,message);
}
console.log('Configuration generation, installer dry-run and missing-prerequisite checks passed.');
