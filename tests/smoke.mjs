import {spawn} from 'node:child_process';
import {createInterface} from 'node:readline';
import {dirname,join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {readFileSync,writeFileSync,mkdirSync} from 'node:fs';

const root=dirname(dirname(fileURLToPath(import.meta.url)));
const foreground=Number(process.argv[2]);
if(!Number.isSafeInteger(foreground)||foreground<=0)throw new Error('A real main-desktop foreground HWND is required');
function client(entry){
 const child=spawn(process.execPath,[entry],{windowsHide:true,stdio:['pipe','pipe','pipe']});
 const pending=new Map();let seq=0;
 createInterface({input:child.stdout}).on('line',line=>{
  const m=JSON.parse(line),p=pending.get(m.id);
  if(p){clearTimeout(p.timer);pending.delete(m.id);m.error?p.reject(new Error(JSON.stringify(m.error))):p.resolve(m.result)}
 });
 child.stderr.on('data',b=>process.stderr.write(b));
 child.on('exit',()=>{for(const p of pending.values()){clearTimeout(p.timer);p.reject(new Error('MCP process exited'))}pending.clear()});
 const rpc=(method,params={})=>new Promise((resolve,reject)=>{
  const id=++seq;const timer=setTimeout(()=>{pending.delete(id);reject(new Error('RPC timeout: '+method))},20000);
  pending.set(id,{resolve,reject,timer});child.stdin.write(JSON.stringify({jsonrpc:'2.0',id,method,params})+'\n');
 });
 return {rpc,async init(){const result=await rpc('initialize',{protocolVersion:'2025-11-25',capabilities:{},clientInfo:{name:'fairymouse-validation',version:'1'}});child.stdin.write(JSON.stringify({jsonrpc:'2.0',method:'notifications/initialized'})+'\n');return result},close(){child.stdin.end()}};
}
const desktop=client(join(root,'desktop','background-mcp.mjs'));
const report={};
try{
 await desktop.init();
 const list=await desktop.rpc('tools/list');
 if(list.tools.length!==25)throw new Error('Unexpected desktop tool count');
 for(const name of ['desktop_press','desktop_focus_window','desktop_restore','desktop_batch','desktop_mouse_click'])if(list.tools.some(t=>t.name===name))throw new Error('Foreground tool exposed');
 const denied=await desktop.rpc('tools/call',{name:'desktop_press',arguments:{key:'a'}});
 if(!denied.isError)throw new Error('Physical input not refused');
 const status=await desktop.rpc('tools/call',{name:'desktop_status',arguments:{}});
 if(status.isError)throw new Error('Desktop backend failed');
 report.desktop={tools:25,statusPassed:true,physicalInputRefused:true};
}finally{desktop.close()}

const hidden=client(join(root,'hidden','launch.mjs'));
const name='FairyHidden-Validation-'+process.pid;
const folder=join(root,'tests','.work','run-'+Date.now());mkdirSync(folder,{recursive:true});
const pause=ms=>new Promise(r=>setTimeout(r,ms));
async function call(tool,args={}){
 const r=await hidden.rpc('tools/call',{name:tool,arguments:args});
 if(r.isError)throw new Error(JSON.stringify(r));
 return r.structuredContent?.result??r.structuredContent??JSON.parse(r.content.find(c=>c.type==='text').text);
}
try{
 await hidden.init();
 const list=await hidden.rpc('tools/list');if(list.tools.length!==11)throw new Error('Unexpected hidden tool count');
 const reserved=await hidden.rpc('tools/call',{name:'hidden_create',arguments:{name:'Default'}});
 if(!reserved.isError)throw new Error('Reserved desktop accepted');
 const rejected=await hidden.rpc('tools/call',{name:'hidden_controls',arguments:{name,hwnd:foreground}});
 if(!rejected.isError)throw new Error('Main-desktop HWND accepted');
 await call('hidden_create',{name});
 await call('hidden_launch',{name,executable:join(root,'tests','.work','DesktopTrial.exe'),arguments:[folder]});
 let windows=[];
 for(let i=0;i<50;i++){windows=await call('hidden_windows',{name});if(windows.some(w=>w.title==='Fairy Agent Desktop Trial'))break;await pause(100)}
 const top=windows.find(w=>w.title==='Fairy Agent Desktop Trial');if(!top)throw new Error('Test window missing');
 const controls=await call('hidden_controls',{name,hwnd:top.handle});
 const input=controls.find(c=>c.class.includes('EDIT'));
 const button=controls.find(c=>c.text==='Apply test value');
 const check=controls.find(c=>c.text==='Background test checkbox');
 let count=0;
 async function verify(expected){for(let i=0;i<20;i++){if(readFileSync(join(folder,'fixture-state.txt'),'utf8').includes(expected)){count++;return}await pause(50)}throw new Error('Missing effect: '+expected)}
 for(let n=1;n<=3;n++){
  const text='Fairymouse round '+n;
  await call('hidden_set_text',{name,hwnd:input.handle,text});await verify('input='+text);
  await call('hidden_click',{name,hwnd:button.handle,x:10,y:10});await verify('result=Applied: '+text);
  for(const expected of ['True','False']){await call('hidden_click',{name,hwnd:check.handle,x:8,y:10});await verify('checked='+expected)}
 }
 await call('hidden_keys',{name,hwnd:input.handle,keys:['end']});
 await call('hidden_type_text',{name,hwnd:input.handle,text:' 中文😀'});await verify('input=Fairymouse round 3 中文😀');
 await call('hidden_click',{name,hwnd:button.handle,x:10,y:10});await verify('result=Applied: Fairymouse round 3 中文😀');
 const shot=await hidden.rpc('tools/call',{name:'hidden_screenshot',arguments:{name,hwnd:top.handle}});
 const img=shot.content.find(c=>c.type==='image');if(!img)throw new Error('Screenshot missing');
 writeFileSync(join(root,'reports','hidden-test.png'),Buffer.from(img.data,'base64'));
 await call('hidden_close_window',{name,hwnd:top.handle});
 for(let i=0;i<40;i++){windows=await call('hidden_windows',{name});if(windows.length===0)break;await pause(100)}
 await call('hidden_release',{name});
 report.hidden={tools:11,effectsVerified:count,unicodePassed:true,mainDesktopRefused:true,reservedDesktopRefused:true,screenshotPassed:true,fixtureClosed:true};
 report.validatedAt=new Date().toISOString();
 writeFileSync(join(root,'reports','validation.json'),JSON.stringify(report,null,2));console.log(JSON.stringify(report));
}finally{writeFileSync(join(folder,'close.flag'),'');hidden.close()}
