// Optional real Windows Notepad regression. Never touches existing user windows.
import {spawn} from 'node:child_process';
import {createInterface} from 'node:readline';
import {dirname,join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {existsSync,mkdirSync,readFileSync,writeFileSync} from 'node:fs';
const root=dirname(dirname(fileURLToPath(import.meta.url)));
const folder=join(root,'tests','.work','notepad-'+Date.now());
const report={app:'Windows Notepad',status:'skipped',reason:'Run with --run to launch an isolated test instance',validatedAt:new Date().toISOString()};
const classic32=join(process.env.WINDIR??'C:\\Windows','SysWOW64','notepad.exe');
const executable=existsSync(classic32)?classic32:join(process.env.WINDIR??'C:\\Windows','System32','notepad.exe');
const pause=ms=>new Promise(r=>setTimeout(r,ms));
function client(){
 const child=spawn(process.execPath,[join(root,'hidden','launch.mjs')],{windowsHide:true,stdio:['pipe','pipe','pipe']});
 const pending=new Map();let seq=0;
 createInterface({input:child.stdout}).on('line',line=>{
  const response=JSON.parse(line),request=pending.get(response.id);
  if(request){clearTimeout(request.timer);pending.delete(response.id);response.error?request.reject(new Error(JSON.stringify(response.error))):request.resolve(response.result)}
 });
 child.stderr.on('data',b=>process.stderr.write(b));
 const fail=()=>{for(const request of pending.values()){clearTimeout(request.timer);request.reject(new Error('MCP exited'))}pending.clear()};
 child.on('exit',fail);child.on('error',fail);
 const rpc=(method,params={})=>new Promise((resolve,reject)=>{
  const id=++seq,timer=setTimeout(()=>{pending.delete(id);reject(new Error('MCP timeout'))},20000);
  pending.set(id,{resolve,reject,timer});child.stdin.write(JSON.stringify({jsonrpc:'2.0',id,method,params})+'\n');
 });
 return {rpc,async call(tool,args){const r=await rpc('tools/call',{name:tool,arguments:args});if(r.isError)throw new Error(tool+': '+JSON.stringify(r));return r.structuredContent?.result??r.structuredContent?.data??r.structuredContent},async init(){await rpc('initialize',{protocolVersion:'2025-11-25',capabilities:{},clientInfo:{name:'fairymouse-real-app-regression',version:'1'}});child.stdin.write(JSON.stringify({jsonrpc:'2.0',method:'notifications/initialized'})+'\n')},close(){child.stdin.end()}};
}

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
function guard(){if(existsSync(join(folder,'interference.flag')))throw new Error('Foreground changed; stopped further UI mutations (cause not attributed)')}
function flatten(node){if(!node||typeof node!=='object')return[];return[node,...(node.children??[]).flatMap(flatten)]}
function exactMenu(tree,names){const matches=flatten(tree).filter(n=>n.role==='menuitem'&&names.includes(n.name));if(matches.length!==1||!matches[0].ref_id)throw new Error('Exact menu target missing or ambiguous: '+names.join('/'));return matches[0].ref_id}
if(process.argv.includes('--run')&&existsSync(executable)){
 mkdirSync(folder,{recursive:true});
 const fileName='Fairymouse-'+process.pid+'.txt';
 const file=join(folder,fileName),before='Fairymouse original',after='Fairymouse saved through Notepad!';
 writeFileSync(file,before,'utf8');
 const server=client(),name='FairyHidden-Notepad-'+process.pid;
 let launchPid,top,created=false,sampler;
 try{
  sampler=spawn(join(root,'runtime','Scripts','python.exe'),['-B','-c',samplerCode,folder],{windowsHide:true,stdio:['ignore','ignore','pipe']});sampler.stderr.on('data',b=>process.stderr.write(b));
  for(let i=0;i<100&&!existsSync(join(folder,'ready.flag'));i++)await pause(20);
  if(!existsSync(join(folder,'ready.flag')))throw new Error('Foreground sampler unavailable');
  await server.init();await server.call('hidden_create',{name});created=true;
  guard();const launched=await server.call('hidden_launch',{name,executable,arguments:[file],wait_ms:5000});launchPid=launched.pid;
  for(let i=0;i<50&&!top;i++){const windows=await server.call('hidden_windows',{name});top=windows.find(w=>w.class==='Notepad'&&(w.title||'').startsWith(fileName));if(!top)await pause(100)}
  if(!top){report.reason='No matching Notepad window on the newly created hidden desktop (forwarding/unsupported build); no foreground fallback';}
  else{
   report.launcherPidDifferent=top.process_id!==launchPid;
   const observed=await server.call('hidden_observe',{name,hwnd:top.handle});
   const edits=observed.controls.filter(c=>/^(Edit|RichEdit)/i.test(c.class)&&c.text===before&&c.ref);
   if(edits.length!==1)throw new Error('Unique native edit control containing this test file was not found; no other tabs touched');
   guard();const written=await server.call('hidden_act',{name,ref:edits[0].ref,action:'replace_text',text:after});
   if(!written.verified)throw new Error('Notepad normal-edit readback failed');
   report.editReadbackVerified=true;report.editClass=edits[0].class;
   const menu=await server.call('hidden_semantic',{name,hwnd:top.handle,action:'snapshot'});
   report.observedTabCount=flatten(menu.tree).filter(n=>n.role==='tab').length;
   const fileRef=exactMenu(menu.tree,['文件','File']);
   guard();await server.call('hidden_semantic',{name,hwnd:top.handle,action:'expand',ref:fileRef});
   const opened=await server.call('hidden_semantic',{name,hwnd:top.handle,action:'snapshot'});
   // Never choose Save All or Save As: only exact localized Save menu names.
   const saveRef=exactMenu(opened.tree,['保存','Save']);
   guard();await server.call('hidden_semantic',{name,hwnd:top.handle,action:'click',ref:saveRef});
   for(let i=0;i<30&&readFileSync(file,'utf8')!==after;i++)await pause(100);
   if(readFileSync(file,'utf8')!==after)throw new Error('Notepad file readback did not match');
   report.status='passed';delete report.reason;report.fileSaveVerified=true;
   report.route='hidden_act replace_text (EM_SETSEL/EM_REPLACESEL), hidden_semantic File/Save UIA menu, exact disk readback';
   report.otherTabsModified=false;report.saveAllUsed=false;report.physicalInputUsed=false;
   const screenshot=await server.rpc('tools/call',{name:'hidden_screenshot',arguments:{name,hwnd:top.handle,max_size:1000}});
   const image=screenshot.content?.find(c=>c.type==='image');if(image){writeFileSync(join(folder,'notepad.png'),Buffer.from(image.data,'base64'));report.screenshotCaptured=true}
  }
 }catch(error){report.status='failed';report.reason=error.message;process.exitCode=1}
 finally{
  if(created){
   try{
    // Close only the exact test-created top HWND. Never save/discard other restored tabs.
    if(top){const windows=await server.call('hidden_windows',{name});if(windows.some(w=>w.handle===top.handle&&w.process_id===top.process_id))await server.call('hidden_close_window',{name,hwnd:top.handle})}
    for(let i=0;i<40;i++){if(!(await server.call('hidden_windows',{name})).length)break;await pause(100)}
    if(launchPid)await server.call('hidden_wait',{name,condition:'process_exited',process_id:launchPid,timeout_ms:3000});
    await server.call('hidden_release',{name});report.cleanedUp=true;
   }catch(error){report.status='failed';report.cleanedUp=false;report.cleanupError=error.message;process.exitCode=1}
  }
  server.close();
  if(sampler){writeFileSync(join(folder,'stop.flag'),'');await new Promise(r=>{if(sampler.exitCode!==null)r();else{sampler.once('exit',r);setTimeout(r,3000)}});if(existsSync(join(folder,'foreground.json')))report.foreground=JSON.parse(readFileSync(join(folder,'foreground.json'),'utf8'))}
 }
}else if(process.argv.includes('--run'))report.reason='System Notepad executable unavailable';
mkdirSync(join(root,'reports'),{recursive:true});
writeFileSync(join(root,'reports','real-apps.json'),JSON.stringify(report,null,2));
console.log(JSON.stringify(report));
