// Real Edge test: generic Fairymouse Win32 messages mutate UI; CDP observes only.
import {spawn} from 'node:child_process';
import {createInterface} from 'node:readline';
import {createServer} from 'node:http';
import {dirname,join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {existsSync,mkdirSync,readFileSync,writeFileSync} from 'node:fs';
const root=dirname(dirname(fileURLToPath(import.meta.url)));
const folder=join(root,'tests','.work','edge-'+Date.now());mkdirSync(folder,{recursive:true});
const profile=join(folder,'profile'),file=join(folder,'budget.json');
const executable=['C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe','C:/Program Files/Microsoft/Edge/Application/msedge.exe'].find(existsSync);
const report={app:'Microsoft Edge',status:'skipped',route:'hidden Win32 click/WM_CHAR; CDP read-only DOM geometry/state; localhost form POST exports JSON',validatedAt:new Date().toISOString()};
const pause=ms=>new Promise(r=>setTimeout(r,ms));
const page=`<!doctype html><meta charset="utf-8"><title>Fairymouse Edge Budget Test</title><style>body{font:24px sans-serif;padding:40px}input,button{font:24px sans-serif;display:block;margin:15px 0;padding:10px;width:300px}#result{padding:20px}</style><h1>Fairymouse Budget</h1><label>Quantity<input id="qty" inputmode="numeric"></label><label>Unit price<input id="price" inputmode="decimal"></label><button id="export">Calculate and export</button><div id="result">Not exported</div><script>document.querySelector('#export').onclick=async()=>{const quantity=Number(qty.value),unitPrice=Number(price.value);const payload={quantity,unitPrice,total:Number((quantity*unitPrice).toFixed(2))};const r=await fetch('/export',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(payload)});result.textContent=r.ok?'Exported total '+payload.total:'Export failed'};</script>`;
const http=createServer((req,res)=>{if(req.url==='/export'&&req.method==='POST'){let data='';req.on('data',c=>{data+=c;if(data.length>4096)req.destroy()});req.on('end',()=>{try{const parsed=JSON.parse(data);writeFileSync(file,JSON.stringify(parsed));res.end('ok')}catch{res.statusCode=400;res.end('bad')}})}else{res.setHeader('Content-Type','text/html; charset=utf-8');res.end(page)}});
function client(){const child=spawn(process.execPath,[join(root,'hidden','launch.mjs')],{windowsHide:true,stdio:['pipe','pipe','pipe']});let seq=0;const pending=new Map();createInterface({input:child.stdout}).on('line',l=>{const m=JSON.parse(l),p=pending.get(m.id);if(p){clearTimeout(p.timer);pending.delete(m.id);m.error?p.reject(new Error(JSON.stringify(m.error))):p.resolve(m.result)}});child.stderr.on('data',b=>process.stderr.write(b));child.on('exit',()=>{for(const p of pending.values()){clearTimeout(p.timer);p.reject(new Error('MCP exited'))}pending.clear()});const rpc=(method,params={})=>new Promise((resolve,reject)=>{const id=++seq,timer=setTimeout(()=>{pending.delete(id);reject(new Error('MCP timeout'))},25000);pending.set(id,{resolve,reject,timer});child.stdin.write(JSON.stringify({jsonrpc:'2.0',id,method,params})+'\n')});return{rpc,async call(name,args){const r=await rpc('tools/call',{name,arguments:args});if(r.isError)throw new Error(name+': '+JSON.stringify(r));return r.structuredContent?.result??r.structuredContent?.data??r.structuredContent},async init(){await rpc('initialize',{protocolVersion:'2025-11-25',capabilities:{},clientInfo:{name:'edge-regression',version:'1'}});child.stdin.write(JSON.stringify({jsonrpc:'2.0',method:'notifications/initialized'})+'\n')},close(){child.stdin.end()}}}
const samplerCode=`import ctypes,json,time,sys,pathlib
from ctypes import wintypes
u=ctypes.WinDLL('user32');u.GetForegroundWindow.restype=wintypes.HWND
class Point(ctypes.Structure): _fields_=[('x',ctypes.c_long),('y',ctypes.c_long)]
f=pathlib.Path(sys.argv[1]);first=None;cursor=None;n=0;changed=0;moved=0;maxgap=0;last=time.monotonic()
while not (f/'stop.flag').exists():
 now=time.monotonic();maxgap=max(maxgap,now-last);last=now
 fg=int(u.GetForegroundWindow() or 0);p=Point();u.GetCursorPos(ctypes.byref(p));xy=(p.x,p.y)
 if first is None: first=fg;cursor=xy;(f/'ready.flag').write_text('ready')
 if fg!=first: changed+=1;(f/'interference.flag').write_text('foreground changed')
 if xy!=cursor: moved+=1
 n+=1;time.sleep(.02)
(f/'foreground.json').write_text(json.dumps({'samples':n,'foregroundChangesFromBaseline':changed,'cursorChangesFromBaseline':moved,'maximumSampleGapMs':round(maxgap*1000,2),'baselineWasVisible':bool(first),'scope':'sampling, not proof against sub-interval interference; user activity is not attributable'}))
`;
let browser,ws,sampler,launchPid,top,created=false;const name='FairyHidden-Edge-'+process.pid;
function guard(){if(existsSync(join(folder,'interference.flag')))throw new Error('Foreground changed during test; stopping further UI actions (cause not attributed)')}
try{
 if(!process.argv.includes('--run')){report.reason='Run with --run for isolated Edge regression';}
 else if(!executable){report.reason='Microsoft Edge executable not found';}
 else{
  await new Promise(r=>http.listen(0,'127.0.0.1',r));const port=http.address().port;
  sampler=spawn(join(root,'runtime','Scripts','python.exe'),['-B','-c',samplerCode,folder],{windowsHide:true,stdio:['ignore','ignore','pipe']});sampler.stderr.on('data',b=>process.stderr.write(b));
  for(let i=0;i<100&&!existsSync(join(folder,'ready.flag'));i++)await pause(20);
  if(!existsSync(join(folder,'ready.flag')))throw new Error('Foreground sampler unavailable');
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
  for(const [id,value] of [['qty','7'],['price','12.5']]){
   guard();const point=await observe(`(()=>{const r=document.getElementById('${id}').getBoundingClientRect();return {x:Math.round(r.x+r.width/2),y:Math.round(r.y+r.height/2)}})()`);
   await browser.call('hidden_click',{name,hwnd:render.handle,...point});
   await browser.call('hidden_type_text',{name,hwnd:render.handle,text:value});
   await pause(100);const actual=await observe(`document.getElementById('${id}').value`);if(actual!==value)throw new Error('Win32 typed field mismatch: '+id+' observed '+actual);
  }
  guard();const point=await observe(`(()=>{const r=document.getElementById('export').getBoundingClientRect();return {x:Math.round(r.x+r.width/2),y:Math.round(r.y+r.height/2)}})()`);
  await browser.call('hidden_click',{name,hwnd:render.handle,...point});
  for(let i=0;i<50&&!existsSync(file);i++)await pause(100);
  if(!existsSync(file))throw new Error('Export file missing after real click');
  const exported=JSON.parse(readFileSync(file,'utf8'));if(exported.quantity!==7||exported.unitPrice!==12.5||exported.total!==87.5)throw new Error('Export content mismatch');
  report.resultText=await observe(`document.getElementById('result').textContent`);report.exported=exported;
  const shot=await browser.rpc('tools/call',{name:'hidden_screenshot',arguments:{name,hwnd:top.handle,max_size:900}});const image=shot.content?.find(c=>c.type==='image');if(!image)throw new Error('Edge screenshot unavailable');writeFileSync(join(folder,'edge.png'),Buffer.from(image.data,'base64'));
  report.status='passed';report.fileReadbackVerified=true;report.screenshotCaptured=true;report.physicalInputUsed=false;
 }
}catch(error){report.status='failed';report.reason=error.message;process.exitCode=1}
finally{
 ws?.close();
 if(created){try{for(const window of await browser.call('hidden_windows',{name})){if(window.class==='Chrome_WidgetWin_1')await browser.call('hidden_close_window',{name,hwnd:window.handle})}if(launchPid)await browser.call('hidden_wait',{name,condition:'process_exited',process_id:launchPid,timeout_ms:10000});await browser.call('hidden_release',{name});report.cleanedUp=true}catch(error){report.cleanedUp=false;report.cleanupError=error.message;report.status='failed';process.exitCode=1}}
 browser?.close();
 if(sampler){writeFileSync(join(folder,'stop.flag'),'');await new Promise(r=>{if(sampler.exitCode!==null)r();else{sampler.once('exit',r);setTimeout(r,3000)}});if(existsSync(join(folder,'foreground.json')))report.foreground=JSON.parse(readFileSync(join(folder,'foreground.json'),'utf8'))}
 http.close();
 mkdirSync(join(root,'reports'),{recursive:true});writeFileSync(join(root,'reports','edge-apps.json'),JSON.stringify(report,null,2));console.log(JSON.stringify(report));
}
