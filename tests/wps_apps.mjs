// Isolated WPS feasibility/regression. No existing WPS instance is ever modified.
import {spawn,execFileSync} from 'node:child_process';
import {createInterface} from 'node:readline';
import {dirname,join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {existsSync,mkdirSync,readFileSync,writeFileSync} from 'node:fs';
const root=dirname(dirname(fileURLToPath(import.meta.url)));
const folder=join(root,'tests','.work','wps-'+Date.now());
const pause=ms=>new Promise(r=>setTimeout(r,ms));
const flatten=node=>[node,...(node.children??[]).flatMap(flatten)];
const report={app:'WPS Writer',status:'skipped',validatedAt:new Date().toISOString()};
function ps(code){return execFileSync('powershell',['-NoProfile','-Command',code],{windowsHide:true,encoding:'utf8',timeout:10000}).trim()}
const quote=value=>"'"+String(value).replaceAll("'","''")+"'";
function ownedTree(pids,since,executable){
 const code=`$all=@(Get-CimInstance Win32_Process);$ids=@(${[pids].flat().join(',')});do{$before=$ids.Count;foreach($p in $all){if($p.ParentProcessId -in $ids -and $p.ProcessId -notin $ids){$ids+= $p.ProcessId}}}while($ids.Count -gt $before);@($all | Where-Object { $_.ProcessId -in $ids -and $_.CreationDate.ToUniversalTime() -ge ([datetimeoffset]${quote(since)}).UtcDateTime -and $_.ExecutablePath.StartsWith(${quote(dirname(executable)+'\\')},[StringComparison]::OrdinalIgnoreCase) } | ForEach-Object { @{id=$_.ProcessId;parent=$_.ParentProcessId;created=$_.CreationDate.ToUniversalTime().ToString('o');path=$_.ExecutablePath} }) | ConvertTo-Json -Compress`;
 const result=ps(code);return result?[JSON.parse(result)].flat():[];
}
function cleanOwned(processes){
 const identities=[...new Map(processes.map(p=>[p.id,p])).values()].sort((a,b)=>a.created.localeCompare(b.created));
 ps(`$owned=ConvertFrom-Json ${quote(JSON.stringify(identities))};foreach($item in $owned){$p=Get-CimInstance Win32_Process -Filter ('ProcessId='+$item.id);if($p -and $p.ExecutablePath -eq $item.path -and $p.CreationDate.ToUniversalTime().ToString('o') -eq $item.created){Stop-Process -Id $item.id -ErrorAction Stop}}`);
}
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
 return {rpc,async call(tool,args){const r=await rpc('tools/call',{name:tool,arguments:args});if(r.isError)throw new Error(tool+': '+(r.structuredContent?.code??'MCP_ERROR'));return r.structuredContent?.result??r.structuredContent?.data??r.structuredContent},async init(){await rpc('initialize',{protocolVersion:'2025-11-25',capabilities:{},clientInfo:{name:'fairymouse-real-app-regression',version:'1'}});child.stdin.write(JSON.stringify({jsonrpc:'2.0',method:'notifications/initialized'})+'\n')},close(){child.stdin.end()}};
}
const preflight=JSON.parse(ps("$p=@(Get-Process -Name wps,et,wpp,wpscloudsvr -ErrorAction SilentlyContinue | Select-Object -ExpandProperty Id);$k='HKLM:/SOFTWARE/Microsoft/Windows/CurrentVersion/App Paths/wps.exe';$e=if(Test-Path $k){(Get-Item $k).GetValue('')};@{processes=$p;executable=$e}|ConvertTo-Json -Compress"));
report.preexistingProcessCount=preflight.processes.length;
if(preflight.executable&&existsSync(preflight.executable))report.version=ps(`(Get-Item -LiteralPath ${quote(preflight.executable)}).VersionInfo.FileVersion`);
if(!process.argv.includes('--run'))report.reason='Pass --run to launch an isolated test instance';
else if(preflight.processes.length)report.reason='WPS is already running; cannot guarantee a new hidden instance, no launch attempted';
else if(!preflight.executable||!existsSync(preflight.executable))report.reason='WPS executable not found';
else{
 mkdirSync(folder,{recursive:true});
 const filename='Fairymouse-WPS-'+process.pid+'.rtf',file=join(folder,filename);
 writeFileSync(file,'{\\rtf1\\ansi Fairymouse WPS original}','ascii');
 const server=client(),name='FairyHidden-WPS-'+process.pid;
 const stopFile=join(folder,'monitor.stop'),monitorFile=join(folder,'foreground.jsonl');
 const monitorCode=`import ctypes,sys,time,json
from ctypes import wintypes
from pathlib import Path
u=ctypes.windll.user32
u.GetForegroundWindow.restype=ctypes.c_void_p
u.GetWindowThreadProcessId.argtypes=[ctypes.c_void_p,ctypes.POINTER(ctypes.c_ulong)]
stop=Path(sys.argv[1]); f=open(sys.argv[2],'w')
while not stop.exists():
 h=u.GetForegroundWindow(); p=ctypes.c_ulong(); u.GetWindowThreadProcessId(h,ctypes.byref(p)); point=wintypes.POINT(); u.GetCursorPos(ctypes.byref(point))
 f.write(json.dumps([h,p.value,point.x,point.y,time.monotonic()])+'\\n'); f.flush(); time.sleep(.02)
f.close()`;
 const monitor=spawn(join(root,'runtime','Scripts','python.exe'),['-B','-c',monitorCode,stopFile,monitorFile],{windowsHide:true,stdio:['ignore','ignore','pipe']});
 monitor.stderr.on('data',b=>process.stderr.write(b));
 await pause(100);
 let pid,created=false,owned=[];
 try{
  await server.init();await server.call('hidden_create',{name});created=true;
  const launched=await server.call('hidden_launch',{name,executable:preflight.executable,arguments:[file],wait_ms:5000});pid=launched.pid;
  await pause(2000);
  owned=ownedTree(pid,report.validatedAt,preflight.executable);
  const windows=await server.call('hidden_windows',{name});
  const foregroundSamples=existsSync(monitorFile)?readFileSync(monitorFile,'utf8').trim().split('\n').filter(Boolean).map(JSON.parse):[];
  if(foregroundSamples.some(sample=>sample[1]===pid))throw new Error('Test WPS process reached the input desktop foreground; stopped without further actions');
  report.windows=windows.map(w=>({handle:w.handle,process_id:w.process_id,class:w.class,title:w.title}));
  const top=windows.find(w=>w.process_id===pid&&(w.title||'').includes(filename));
  if(!top){report.status='unsupported';report.reason='No same-PID test document window was observed on the hidden desktop';}
  else{
   report.hiddenWindowVerified=true;
   await pause(5000);
   const snapshot=await server.call('hidden_semantic',{name,hwnd:top.handle,action:'snapshot'});
   report.semantic=flatten(snapshot.tree).map(c=>({role:c.role,name:c.name,value:c.value,text:c.text,actions:c.available_actions,children_count:c.children_count}));
   const controls=await server.call('hidden_controls',{name,hwnd:top.handle});
   report.controls=controls.map(c=>({handle:c.handle,class:c.class,text:c.text,control_id:c.control_id}));
   const shot=await server.rpc('tools/call',{name:'hidden_screenshot',arguments:{name,hwnd:top.handle,max_size:1200}});
   const img=shot.content?.find(c=>c.type==='image');
   if(img)writeFileSync(join(folder,'wps.png'),Buffer.from(img.data,'base64'));
   const edit=controls.find(c=>/^(Edit|RichEdit)/i.test(c.class)&&c.text==='Fairymouse WPS original');
   if(!edit){
    const canvases=controls.filter(c=>c.class==='_WwG'&&c.text==='DocView');
    if(canvases.length!==1){report.status='unsupported';report.reason='No unique document canvas was observed in the isolated WPS file window';}
    else{
     const marker='FairymouseWPSVerified'+process.pid;
     const canvas=canvases[0];
     report.editTargetClick=await server.call('hidden_click',{name,hwnd:canvas.handle,x:Math.floor(canvas.width/2),y:Math.floor(canvas.height/2)});
     await pause(300);
     report.editDelivery=await server.call('hidden_type_text',{name,hwnd:canvases[0].handle,text:marker});
     await pause(500);
     const afterEdit=await server.rpc('tools/call',{name:'hidden_screenshot',arguments:{name,hwnd:top.handle,max_size:1200}});
     const afterImage=afterEdit.content?.find(c=>c.type==='image');if(afterImage)writeFileSync(join(folder,'after-edit.png'),Buffer.from(afterImage.data,'base64'));
     const fresh=await server.call('hidden_semantic',{name,hwnd:top.handle,action:'snapshot'});
     report.documentDirtyObserved=flatten(fresh.tree).some(c=>(c.name??'').includes(filename+' *'));
     const save=flatten(fresh.tree).find(c=>/^保存\s*\(Ctrl\+S\)$/.test(c.name??''));
     if(!save){report.status='unsupported';report.reason='No observed semantic Save action';}
     else{
      report.saveDelivery=await server.call('hidden_semantic',{name,hwnd:top.handle,action:'click',ref:save.ref_id});
      await pause(1500);
      const afterSave=await server.call('hidden_semantic',{name,hwnd:top.handle,action:'snapshot'});
      writeFileSync(join(folder,'after-save.json'),JSON.stringify(afterSave));
      report.fileSaveVerified=readFileSync(file,'utf8').includes(marker);
      if(!report.fileSaveVerified){
       const observedSave=flatten(afterSave.tree).filter(c=>/^保存\s*\(Ctrl\+S\)$/.test(c.name??'')&&c.bounds?.width>0&&c.bounds?.height>0);
       if(observedSave.length===1){
        const bounds=observedSave[0].bounds;
        const point={hwnd:top.handle,x:Math.round(bounds.x+bounds.width/2),y:Math.round(bounds.y+bounds.height/2),coordinate_space:'screen'};
        const delivery=await server.call('hidden_click',{name,...point});
        report.messageSaveDelivery={status:delivery.status,verified:delivery.verified};
        report.messageSaveAttempted=true;
        await pause(2000);
        report.fileSaveVerified=readFileSync(file,'utf8').includes(marker);
       }
      }
      report.status=report.fileSaveVerified?'passed':'unsupported';
      if(!report.fileSaveVerified)report.reason='Document edit was observed but semantic Save did not persist the unique marker';
     }
    }
   }
   else{
    const written=await server.call('hidden_set_text',{name,hwnd:edit.handle,text:'Fairymouse WPS changed'});
    report.editReadbackVerified=written.verified;
    await server.call('hidden_keys',{name,hwnd:edit.handle,keys:['ctrl','s']});
    await pause(1000);
    report.fileSaveVerified=readFileSync(file,'utf8').includes('Fairymouse WPS changed');
    report.status=report.fileSaveVerified?'passed':'unsupported';
    if(!report.fileSaveVerified)report.reason='UI edit did not produce verified file persistence';
   }
  }
 }catch(error){report.status='failed';report.reason=error.message;process.exitCode=1}
 finally{
  if(created){
   try{
    const windows=await server.call('hidden_windows',{name});
    owned=ownedTree([pid,...windows.map(w=>w.process_id),...owned.map(p=>p.id)],report.validatedAt,preflight.executable).concat(owned);
    for(const window of windows){if(window.process_id===pid&&(window.title||'').includes(filename))await server.call('hidden_close_window',{name,hwnd:window.handle});}
    if(pid){cleanOwned(owned);await pause(1000);await server.call('hidden_wait',{name,condition:'process_exited',process_id:pid,timeout_ms:5000});}
    for(let round=0;round<3;round++){
     const remaining=await server.call('hidden_windows',{name});if(!remaining.length)break;
     const more=ownedTree([...remaining.map(w=>w.process_id),...owned.map(p=>p.id)],report.validatedAt,preflight.executable);
     cleanOwned(more);owned.push(...more);await pause(500);
    }
    await server.call('hidden_release',{name});report.cleanedUp=true;
   }catch(error){report.cleanedUp=false;report.cleanupError=error.message;report.status='failed';process.exitCode=1}
  }
  server.close();
  writeFileSync(stopFile,'');
  await new Promise(resolve=>{if(monitor.exitCode!==null)return resolve();monitor.once('exit',resolve);setTimeout(()=>{monitor.kill();resolve()},1000).unref()});
  const samples=existsSync(monitorFile)?readFileSync(monitorFile,'utf8').trim().split('\n').filter(Boolean).map(JSON.parse):[];
  const baseline=samples[0],wpsPids=new Set([pid,...owned.map(p=>p.id)]);
  report.foregroundMonitor={samples:samples.length,maxGapMs:Math.round(Math.max(0,...samples.slice(1).map((s,i)=>(s[4]-samples[i][4])*1000))),observedWpsForeground:samples.some(s=>wpsPids.has(s[1])),foregroundDifferentFromBaseline:samples.filter(s=>s[0]!==baseline[0]).length,cursorDifferentFromBaseline:samples.filter(s=>s[2]!==baseline[2]||s[3]!==baseline[3]).length,scope:'20ms polling, not a continuous OS event trace; user changes are not attributed to automation'};
 }
}
mkdirSync(join(root,'reports'),{recursive:true});
if(existsSync(folder))writeFileSync(join(folder,'diagnostics.json'),JSON.stringify(report,null,2));
report.controlClasses=[...new Set((report.controls??[]).map(c=>c.class))];
report.semanticElementCount=report.semantic?.length??0;
report.semanticSaveAvailable=report.semantic?.some(c=>/^保存\s*\(Ctrl\+S\)$/.test(c.name??''))??false;
report.editRoute='scoped hidden WM_CHAR to observed document canvas after posted client click';
report.saveRoute=report.messageSaveAttempted?'observed UIA Save InvokePattern, then one posted click mapped from fresh Save bounds to native client coordinates':'observed UIA Save InvokePattern';
if(report.editDelivery)report.editDelivery={status:report.editDelivery.status,verified:report.editDelivery.verified};
if(report.saveDelivery)report.saveDelivery={delivery:report.saveDelivery.disposition?.delivery,mechanisms:report.saveDelivery.steps?.map(s=>s.mechanism)};
delete report.windows;delete report.controls;delete report.semantic;delete report.editTargetClick;
writeFileSync(join(root,'reports','wps-apps.json'),JSON.stringify(report,null,2));
console.log(JSON.stringify({app:report.app,status:report.status,reason:report.reason,cleanedUp:report.cleanedUp,report:join(root,'reports','wps-apps.json')}));
