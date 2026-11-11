// Real Edge test: generic Fairymouse Win32 messages mutate UI; CDP observes only.
import {spawn} from 'node:child_process';
import {checkpoint,traceRpc,finishTrace,startMonitor,reportPath} from './app_harness.mjs';
import {createInterface} from 'node:readline';
import {createServer} from 'node:http';
import {dirname,join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {existsSync,mkdirSync,readFileSync,writeFileSync} from 'node:fs';
const root=dirname(dirname(fileURLToPath(import.meta.url)));
const folder=join(root,'tests','.work','edge-native-'+Date.now());mkdirSync(folder,{recursive:true});
const profile=join(folder,'profile'),file=join(folder,'saved-page.html');
const executable=['C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe','C:/Program Files/Microsoft/Edge/Application/msedge.exe'].find(existsSync);
const report={app:'Microsoft Edge',status:'skipped',route:'hidden Win32 messages plus hidden UIA browser context menu and native Save As; CDP read-only geometry/state',validatedAt:new Date().toISOString()};
const pause=ms=>new Promise(r=>setTimeout(r,ms));
const marker='FAIRYMOUSE_NATIVE_SAVE_'+Date.now();
const page=`<!doctype html><meta charset="utf-8"><title>Fairymouse Native Save Test</title><style>body{font:24px sans-serif;padding:40px}input,button{font:24px sans-serif;display:block;margin:15px 0;padding:10px;width:500px}</style><h1>Fairymouse native Save As</h1><input id="qty"><button id="export">Apply marker</button><p id="result">Initial text</p><script>document.querySelector('#export').onclick=()=>{result.textContent=qty.value};</script>`;
const http=createServer((req,res)=>{res.setHeader('Content-Type','text/html; charset=utf-8');res.end(page)});
function flat(node){return node&&typeof node==='object'?[node,...(node.children??[]).flatMap(flat)]:[]}
function client(){const child=spawn(process.execPath,[join(root,'hidden','launch.mjs')],{windowsHide:true,stdio:['pipe','pipe','pipe']});let seq=0;const pending=new Map();createInterface({input:child.stdout}).on('line',l=>{const m=JSON.parse(l),p=pending.get(m.id);if(p){clearTimeout(p.timer);pending.delete(m.id);m.error?p.reject(new Error(JSON.stringify(m.error))):p.resolve(m.result)}});child.stderr.on('data',b=>process.stderr.write(b));child.on('exit',()=>{for(const p of pending.values()){clearTimeout(p.timer);p.reject(new Error('MCP exited'))}pending.clear()});const rpc=traceRpc((method,params={})=>new Promise((resolve,reject)=>{const id=++seq,timer=setTimeout(()=>{pending.delete(id);reject(new Error('MCP timeout'))},25000);pending.set(id,{resolve,reject,timer});child.stdin.write(JSON.stringify({jsonrpc:'2.0',id,method,params})+'\n')}));return{rpc,async call(name,args){const r=await rpc('tools/call',{name,arguments:args});if(r.isError)throw new Error(name+': '+JSON.stringify(r));return r.structuredContent?.result??r.structuredContent?.data??r.structuredContent},async init(){await rpc('initialize',{protocolVersion:'2025-11-25',capabilities:{},clientInfo:{name:'edge-regression',version:'1'}});child.stdin.write(JSON.stringify({jsonrpc:'2.0',method:'notifications/initialized'})+'\n')},close(){child.stdin.end()}}}
let browser,ws,monitor,launchPid,top,dialog,created=false;const name='FairyHidden-EdgeSave-'+process.pid;
function guard(){monitor?.guard()}
try{
 if(!process.argv.includes('--run')){report.reason='Run with --run for isolated Edge regression';}
 else if(!executable){report.reason='Microsoft Edge executable not found';}
 else{
  await new Promise(r=>http.listen(0,'127.0.0.1',r));const port=http.address().port;
  monitor=await startMonitor(folder);
  browser=client();await browser.init();await browser.call('hidden_create',{name});created=true;
  guard();const launched=await browser.call('hidden_launch',{name,executable,arguments:[`--user-data-dir=${profile}`,'--no-first-run','--no-default-browser-check','--disable-background-mode','--disable-sync','--disable-gpu','--force-device-scale-factor=1','--window-size=900,700','--remote-debugging-port=0',`--app=http://127.0.0.1:${port}`],wait_ms:5000});launchPid=launched.pid;
  for(let i=0;i<100&&!existsSync(join(profile,'DevToolsActivePort'));i++)await pause(100);
  if(!existsSync(join(profile,'DevToolsActivePort')))throw new Error('Dedicated Edge debugging endpoint unavailable');
  const debugPort=Number(readFileSync(join(profile,'DevToolsActivePort'),'utf8').split('\n')[0]);
  let target;for(let i=0;i<50&&!target;i++){target=(await (await fetch(`http://127.0.0.1:${debugPort}/json/list`)).json()).find(t=>t.type==='page'&&t.url===`http://127.0.0.1:${port}/`);if(!target)await pause(100)}
  if(!target)throw new Error('Local test page not found');
  ws=new WebSocket(target.webSocketDebuggerUrl);await new Promise((resolve,reject)=>{ws.onopen=resolve;ws.onerror=reject});let seq=0;const pending=new Map();ws.onmessage=e=>{const m=JSON.parse(e.data),p=pending.get(m.id);if(p){clearTimeout(p.timer);pending.delete(m.id);m.error?p.reject(new Error(JSON.stringify(m.error))):p.resolve(m.result)}};
  const observe=expression=>new Promise((resolve,reject)=>{const id=++seq,timer=setTimeout(()=>{pending.delete(id);reject(new Error('CDP observation timeout'))},5000);pending.set(id,{resolve:r=>resolve(r.result.value),reject,timer});ws.send(JSON.stringify({id,method:'Runtime.evaluate',params:{expression,returnByValue:true}}))});
  for(let i=0;i<50;i++){const windows=await browser.call('hidden_windows',{name});top=windows.find(w=>w.class==='Chrome_WidgetWin_1'&&(w.title||'').includes('Fairymouse'));if(top)break;await pause(100)}
  if(!top)throw new Error('No matching hidden Edge window');
  const children=await browser.call('hidden_controls',{name,hwnd:top.handle});
  const render=children.find(c=>c.class==='Chrome_RenderWidgetHostHWND');
  report.rendererClass=render?.class;report.topClass=top.class;
  if(!render)throw new Error('Edge renderer child HWND unavailable; no guessed shell offsets');
  report.browserVersion=(await (await fetch(`http://127.0.0.1:${debugPort}/json/version`)).json()).Browser;
  await checkpoint('edit');
  for(const [id,value] of [['qty',marker]]){
   guard();const point=await observe(`(()=>{const r=document.getElementById('${id}').getBoundingClientRect();return {x:Math.round(r.x+r.width/2),y:Math.round(r.y+r.height/2)}})()`);
   await browser.call('hidden_click',{name,hwnd:render.handle,...point});
   await browser.call('hidden_type_text',{name,hwnd:render.handle,text:value});
   await pause(100);const actual=await observe(`document.getElementById('${id}').value`);if(actual!==value)throw new Error('Win32 typed field mismatch: '+id+' observed '+actual);
  }
  guard();const point=await observe(`(()=>{const r=document.getElementById('export').getBoundingClientRect();return {x:Math.round(r.x+r.width/2),y:Math.round(r.y+r.height/2)}})()`);
  await browser.call('hidden_click',{name,hwnd:render.handle,...point});
  let applied=false;for(let i=0;i<30;i++){if(await observe(`document.getElementById('result').textContent`)===marker){applied=true;break}await pause(100)}
  if(!applied)throw new Error('Marker UI readback failed');
  await checkpoint('save');
  // Right-click blank content to open Chromium's real native context menu.
  guard();await browser.call('hidden_click',{name,hwnd:render.handle,x:700,y:500,button:'right'});
  const menu=await browser.call('hidden_semantic',{name,hwnd:top.handle,action:'snapshot'});
  writeFileSync(join(folder,'menu.json'),JSON.stringify(menu,null,2));
  const save=flat(menu.tree).find(n=>n.role==='menuitem'&&/^(另存为|Save as)(?:\([A-Za-z&]+\))?(?:\.\.\.|…)?(?:\s.*)?$/i.test(n.name||''));
  if(!save?.ref_id)throw new Error('Native Save As context menu item not observed');
  guard();await browser.call('hidden_semantic',{name,hwnd:top.handle,action:'click',ref:save.ref_id});

  for(let i=0;i<50&&!dialog;i++){dialog=(await browser.call('hidden_windows',{name})).find(w=>w.class==='#32770');if(!dialog)await pause(100)}
  if(!dialog)throw new Error('Native Save As dialog not observed');
  let form,filename;
  const formDeadline=Date.now()+10000;
  while(Date.now()<formDeadline){
   try{form=await browser.call('hidden_semantic',{name,hwnd:dialog.handle,action:'snapshot'})}
   catch(error){if(!error.message.includes('WINDOW_NOT_FOUND'))throw error;await pause(150);continue}
   filename=flat(form.tree).find(n=>n.role==='textfield'&&/^(文件名|File name)/i.test(n.name||''));
   if(filename?.ref_id)break;
   await pause(150);
  }
  if(!filename?.ref_id)throw new Error('Native filename edit not observed within bounded reads');
  guard();await browser.call('hidden_semantic',{name,hwnd:dialog.handle,action:'set_value',ref:filename.ref_id,value:file});
  const ready=await browser.call('hidden_semantic',{name,hwnd:dialog.handle,action:'snapshot'});
  const saveButton=flat(ready.tree).find(n=>n.role==='button'&&/^(保存|Save)(?:\([A-Za-z&]+\))?$/i.test(n.name||''));
  if(!saveButton?.ref_id)throw new Error('Native Save button not observed');
  guard();await browser.call('hidden_semantic',{name,hwnd:dialog.handle,action:'click',ref:saveButton.ref_id});
  for(let i=0;i<100&&!existsSync(file);i++)await pause(100);
  if(!existsSync(file))throw new Error('Native saved HTML file missing');
  const saved=readFileSync(file,'utf8');
  if(!saved.includes(marker))throw new Error('Native HTML did not contain applied marker');
  const dialogClosed=await browser.call('hidden_wait',{name,condition:'window_closed',hwnd:dialog.handle,timeout_ms:5000});
  if(!dialogClosed.verified)throw new Error('Native Save dialog still open after disk write');
  report.marker=marker;report.savedFileBytes=Buffer.byteLength(saved);report.nativeSaveDialogObserved=true;
  const shot=await browser.rpc('tools/call',{name:'hidden_screenshot',arguments:{name,hwnd:top.handle,max_size:900}});const image=shot.content?.find(c=>c.type==='image');if(!image)throw new Error('Edge screenshot unavailable');writeFileSync(join(folder,'edge.png'),Buffer.from(image.data,'base64'));
  report.status='passed';report.fileReadbackVerified=true;report.screenshotCaptured=true;report.physicalInputUsed=false;
 }
}catch(error){report.status='failed';report.reason=error.message;process.exitCode=1}
finally{
 ws?.close();
 if(created){try{
  const windows=await browser.call('hidden_windows',{name});
  for(const window of windows){
   if((window.process_id===launchPid&&window.class==='Chrome_WidgetWin_1')||window.handle===dialog?.handle)
    await browser.call('hidden_close_window',{name,hwnd:window.handle});
  }
  const exited=launchPid?await browser.call('hidden_wait',{name,condition:'process_exited',process_id:launchPid,timeout_ms:10000}):{verified:true};
  if(!exited.verified)throw new Error('Own browser did not exit after close');
  let remaining=[];
  for(let i=0;i<30;i++){remaining=await browser.call('hidden_windows',{name});if(!remaining.length)break;await pause(100)}
  if(remaining.length){report.cleanupRemainingWindows=remaining.map(w=>({class:w.class,process_id:w.process_id,handle:w.handle}));throw new Error('Hidden desktop retains helper windows after browser exit')}
  await browser.call('hidden_release',{name});report.cleanedUp=true;
 }catch(error){report.cleanedUp=false;report.cleanupError=error.message;report.status='failed';process.exitCode=1}}

 browser?.close();
 if(monitor){try{report.foreground=await monitor.stop()}catch(error){report.monitorError=error.message;report.status='failed';process.exitCode=1}}
 finishTrace(report.status);
 http.close();
 mkdirSync(join(root,'reports'),{recursive:true});writeFileSync(reportPath('edge-native-save.json'),JSON.stringify(report,null,2));console.log(JSON.stringify(report));
}
