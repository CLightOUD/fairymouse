// Actual stdio transport + routing checks; no GUI app, focus or physical input.
import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {createInterface} from 'node:readline';
import {fileURLToPath} from 'node:url';

async function verify(entry,route,count){
 const child=spawn(process.execPath,[fileURLToPath(new URL(entry,import.meta.url))],{windowsHide:true,stdio:['pipe','pipe','pipe']});
 let id=0,stderr='';const pending=new Map();
 const fail=error=>{for(const p of pending.values()){clearTimeout(p.timer);p.reject(error)}pending.clear()};
 child.stderr.on('data',b=>stderr=(stderr+b).slice(-8000));
 child.on('error',fail);child.on('exit',()=>fail(new Error('MCP exited before reply: '+stderr)));
 const exited=new Promise(resolve=>child.once('exit',(code,signal)=>resolve({code,signal})));
 createInterface({input:child.stdout}).on('line',line=>{
  let response;try{response=JSON.parse(line)}catch(error){fail(error);return}
  const p=pending.get(response.id);if(!p)return;
  clearTimeout(p.timer);pending.delete(response.id);
  response.error?p.reject(new Error(JSON.stringify(response.error))):p.resolve(response.result);
 });
 const rpc=(method,params={})=>new Promise((resolve,reject)=>{
  const key=++id,timer=setTimeout(()=>{pending.delete(key);reject(new Error('MCP deadline: '+method))},15000);
  pending.set(key,{resolve,reject,timer});child.stdin.write(JSON.stringify({jsonrpc:'2.0',id:key,method,params})+'\n');
 });
 const call=(name,args={})=>rpc('tools/call',{name,arguments:args});
 try{
  assert.ok((await rpc('initialize',{protocolVersion:'2025-11-25',capabilities:{},clientInfo:{name:'headless-contract',version:'1'}})).serverInfo);
  child.stdin.write(JSON.stringify({jsonrpc:'2.0',method:'notifications/initialized'})+'\n');
  const list=await rpc('tools/list');assert.equal(list.tools.length,count);
  const status=await call(route+'_status');assert.equal(status.isError,false,JSON.stringify(status));
  if(route==='hidden'){
   const rejected=await call('hidden_create',{name:'Default'});assert.equal(rejected.isError,true);
   assert.equal(rejected.structuredContent.fairy.status,'error');
   await call('hidden_control',{action:'pause'});
   assert.equal((await call('hidden_create',{name:'FairyHidden-headless-'+process.pid})).structuredContent.code,'PAUSED');
   assert.equal((await call('hidden_status')).isError,false);
   await call('hidden_control',{action:'resume'});
  }else{
   for(const forbidden of ['desktop_press','desktop_focus_window','desktop_mouse_click','desktop_restore'])assert.ok(!list.tools.some(t=>t.name===forbidden));
   assert.equal((await call('desktop_press',{key:'a'})).isError,true);
  }
 }finally{
  child.stdin.end();
  let timer;const result=await Promise.race([exited,new Promise(resolve=>{timer=setTimeout(()=>resolve(null),5000)})]);clearTimeout(timer);
  if(!result){child.kill();await exited;throw new Error('MCP failed to exit on stdin EOF: '+route)}
  assert.equal(result.code,0,stderr);
 }
}
await verify('../desktop/background-mcp.mjs','desktop',26);
await verify('../hidden/launch.mjs','hidden',17);
console.log('Headless MCP handshake, allowlist, pause and clean EOF exit passed.');
