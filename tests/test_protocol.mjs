import assert from 'node:assert/strict';
import {spawn,execFileSync} from 'node:child_process';
import {createInterface} from 'node:readline';
import {fileURLToPath} from 'node:url';
import {normalize,localResult,controlTool,observationIsFresh} from '../desktop/protocol.mjs';

const upstream={content:[{type:'text',text:JSON.stringify({ok:true,data:{name:'test'}})}]};
const read=normalize(upstream,'desktop_snapshot');
assert.equal(read.structuredContent.fairy.status,'observed');
assert.deepEqual(read.content,upstream.content);
assert.equal(normalize(upstream,'desktop_click').structuredContent.fairy.status,'completed_unverified');
const bad=normalize({content:[],structuredContent:{ok:false,error:{code:'STALE_REF',message:'observe'}}},'desktop_click');
assert.equal(bad.isError,true);assert.equal(bad.structuredContent.fairy.code,'STALE_REF');assert.equal(bad.structuredContent.ok,false);
assert.equal(normalize({content:[],structuredContent:{verified:true}},'desktop_click').structuredContent.fairy.verified,true);
assert.equal(localResult('error','PAUSED','paused').isError,true);
assert.deepEqual(controlTool.inputSchema.properties.action.enum,['status','pause','resume','recover']);

// A snapshot issued before pause/resume must never unlock mutations later.
assert.equal(observationIsFresh(0,2,false,false),false);
assert.equal(observationIsFresh(1,2,false,false),false);
assert.equal(observationIsFresh(2,2,true,false),false);
assert.equal(observationIsFresh(2,2,false,true),false);
assert.equal(observationIsFresh(2,2,false,false),true);
assert.deepEqual(normalize({content:[],structuredContent:[1,2]},'desktop_status').structuredContent.upstream,[1,2]);

const child=spawn(process.execPath,[fileURLToPath(new URL('../desktop/background-mcp.mjs',import.meta.url))],{windowsHide:true,stdio:['pipe','pipe','pipe']});
let sequence=0;const pending=new Map();
createInterface({input:child.stdout}).on('line',line=>{const m=JSON.parse(line),p=pending.get(m.id);if(p){pending.delete(m.id);clearTimeout(p.timer);m.error?p.reject(new Error(JSON.stringify(m.error))):p.resolve(m.result)}});
child.stderr.on('data',b=>process.stderr.write(b));
child.on('exit',()=>{for(const p of pending.values()){clearTimeout(p.timer);p.reject(new Error('Early exit'))}pending.clear()});
const rpc=(method,params={})=>new Promise((resolve,reject)=>{const id=++sequence;const timer=setTimeout(()=>{pending.delete(id);reject(new Error('RPC timeout'))},10000);pending.set(id,{resolve,reject,timer});child.stdin.write(JSON.stringify({jsonrpc:'2.0',id,method,params})+'\n')});
const call=(name,args={})=>rpc('tools/call',{name,arguments:args});
try{
 await rpc('initialize',{protocolVersion:'2025-11-25',capabilities:{},clientInfo:{name:'protocol-regression',version:'1'}});
 child.stdin.write(JSON.stringify({jsonrpc:'2.0',method:'notifications/initialized'})+'\n');
 const list=await rpc('tools/list');assert.equal(list.tools.length,26);
 const pausedState=await call('desktop_control',{action:'pause'});assert.equal(pausedState.structuredContent.fairy.paused,true);
 const generation=pausedState.structuredContent.fairy.observation_generation;
 const refused=await call('desktop_click',{});assert.equal(refused.structuredContent.fairy.code,'PAUSED');assert.equal(refused.isError,true);
 const status=await call('desktop_status');assert.equal(status.isError,false);assert.equal(status.structuredContent.fairy.status,'observed');
 const resumed=await call('desktop_control',{action:'resume'});assert.equal(resumed.structuredContent.fairy.paused,false);assert.ok(resumed.structuredContent.fairy.observation_generation>generation);
 assert.equal((await call('desktop_click',{})).structuredContent.fairy.code,'OBSERVATION_REQUIRED');
 assert.equal((await call('desktop_control',{action:'bogus'})).structuredContent.fairy.code,'INVALID_ARGUMENT');
 assert.equal((await call('desktop_control',{action:'recover'})).structuredContent.fairy.code,'RECOVERY_NOT_ALLOWED');
 const current=await call('desktop_control',{action:'status'});
 const pid=current.structuredContent.fairy.backend_pid;assert.ok(Number.isSafeInteger(pid)&&pid>0);
 execFileSync('powershell',['-NoProfile','-Command',`Stop-Process -Id ${pid} -Force`],{windowsHide:true});
 let health;for(let i=0;i<30;i++){health=await call('desktop_control',{action:'status'});if(!health.structuredContent.fairy.backend_available)break;await new Promise(r=>setTimeout(r,50))}
 assert.equal(health.structuredContent.fairy.backend_available,false);
 const recovered=await call('desktop_control',{action:'recover'});assert.equal(recovered.structuredContent.fairy.status,'recovered');assert.equal(recovered.structuredContent.fairy.paused,true);
 assert.equal((await call('desktop_status')).isError,false);
 await call('desktop_control',{action:'resume'});
 assert.equal((await call('desktop_click',{})).structuredContent.fairy.code,'OBSERVATION_REQUIRED');
 console.log('Desktop protocol and live pause/resume checks passed (no GUI actions sent).');
}finally{child.stdin.end()}
