import assert from 'node:assert/strict';
import {assessCoexistence,startMonitor,pause} from './app_harness.mjs';
import {mkdirSync,writeFileSync} from 'node:fs';
import {dirname,join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {execFileSync} from 'node:child_process';
const clear={mode:'coexist',samples:30,registeredProcesses:1,invalidSamples:0,registrationFailures:0,ancestryErrors:0,targetForegroundSamples:0,targetFocusSamples:0,inputDesktopChanges:0,foregroundChanges:0,focusChanges:0,cursorChanges:0};
assert.equal(assessCoexistence(clear).status,'observed_clear');
const active={...clear,foregroundChanges:10,focusChanges:9,cursorChanges:29};
assert.equal(assessCoexistence(active).status,'observed_clear');
assert.equal(assessCoexistence(active).userActivityObserved,true);
for(const key of ['targetForegroundSamples','targetFocusSamples','inputDesktopChanges'])assert.equal(assessCoexistence({...active,[key]:1}).status,'failed',key);
for(const key of ['invalidSamples','registrationFailures','ancestryErrors'])assert.equal(assessCoexistence({...active,[key]:1}).status,'inconclusive',key);
assert.equal(assessCoexistence({...clear,registeredProcesses:0}).status,'inconclusive');
assert.equal(assessCoexistence({...clear,unresolvedLaunchProcesses:1}).status,'inconclusive');
// A documented activation transition still leaves an observation gap: reasons
// explain the failure and must never override the invalid-sample verdict.
assert.equal(assessCoexistence({...clear,invalidSamples:1,invalidReasonCounts:{FOREGROUND_NULL:1}}).status,'inconclusive');
assert.equal(assessCoexistence({...clear,invalidSamples:1,invalidReasonCounts:{FOREGROUND_CHANGED_DURING_SAMPLE:1},targetForegroundSamples:1}).status,'failed');
assert.equal(assessCoexistence({...clear,samples:0}).status,'inconclusive');
assert.equal(assessCoexistence({}).status,'inconclusive');
assert.equal(assessCoexistence({...clear,mode:'strict'}).status,'inconclusive');
await assert.rejects(startMonitor('unused',{mode:'invalid'}),/Unknown monitor mode/);
console.log('Coexistence assessment boundaries passed; no GUI actions performed.');
if(process.argv.includes('--live')){
 const folder=join(dirname(fileURLToPath(import.meta.url)),'.work','monitor-selftest-'+Date.now());mkdirSync(folder,{recursive:true});
 const reports=[];
 let monitor=await startMonitor(join(folder,'strict'),{mode:'strict'});
 await pause(80);reports.push(await monitor.stop());
 assert.ok(reports.at(-1).samples>0);
 assert.ok(Number.isInteger(reports.at(-1).invalidSamples));
 assert.ok(Number.isFinite(reports.at(-1).maximumSampleGapMs));
 monitor=await startMonitor(join(folder,'registered'),{mode:'coexist'});
 try{await monitor.registerProcess(process.pid);await pause(400);monitor.guard()}finally{reports.push(await monitor.stop())}
 assert.equal(reports.at(-1).assessment.status,'observed_clear');
 monitor=await startMonitor(join(folder,'unregistered'),{mode:'coexist'});await pause(60);reports.push(await monitor.stop());
 assert.equal(reports.at(-1).assessment.status,'inconclusive');
 monitor=await startMonitor(join(folder,'missing-process'),{mode:'coexist'});
 await assert.rejects(monitor.registerProcess(4294967294),/identity unavailable/);await pause(50);
 assert.throws(()=>monitor.guard(),/incomplete observation/);reports.push(await monitor.stop());
 assert.equal(reports.at(-1).assessment.status,'inconclusive');
 // Deliberately register the already-foreground process as a test target.
 // This reads IDs only and must detect the violation without activating anything.
 monitor=await startMonitor(join(folder,'foreground-target'),{mode:'coexist'});
 const python=join(dirname(fileURLToPath(import.meta.url)),'..','runtime','Scripts','python.exe');
 const code="import ctypes;from ctypes import wintypes as W;u=ctypes.WinDLL('user32');u.GetForegroundWindow.restype=W.HWND;u.GetWindowThreadProcessId.argtypes=[W.HWND,ctypes.POINTER(W.DWORD)];p=W.DWORD();u.GetWindowThreadProcessId(u.GetForegroundWindow(),ctypes.byref(p));print(p.value)";
 const foregroundPid=Number(execFileSync(python,['-B','-c',code],{windowsHide:true,encoding:'utf8'}).trim());
 await monitor.registerProcess(foregroundPid);await pause(80);
 assert.throws(()=>monitor.guard(),/interference/);reports.push(await monitor.stop());
 assert.equal(reports.at(-1).assessment.status,'failed');
 assert.ok(reports.at(-1).targetForegroundSamples>0);
 writeFileSync(join(folder,'results.json'),JSON.stringify(reports,null,2));
 console.log('Read-only live monitor checks passed: strict start/stop, registered, unregistered, unavailable identity, foreground target. '+folder);
}
