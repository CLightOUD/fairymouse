// Real Paint edit/save regression on an isolated desktop and owned test PNG.
import {spawn,execFileSync} from 'node:child_process';
import {createInterface} from 'node:readline';
import {dirname,join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {existsSync,mkdirSync,writeFileSync} from 'node:fs';
import {checkpoint,traceRpc,finishTrace,startMonitor,pause,reportPath} from './app_harness.mjs';
const root=dirname(dirname(fileURLToPath(import.meta.url)));
const folder=join(root,'tests','.work','paint-'+Date.now());
const report={app:'Windows Paint',status:'skipped',validatedAt:new Date().toISOString(),physicalInputUsed:false};
const quote=value=>"'"+String(value).replaceAll("'","''")+"'";
const ps=code=>execFileSync('powershell',['-NoProfile','-Command',code],{windowsHide:true,encoding:'utf8',timeout:15000}).trim();
const python=(code,args=[])=>execFileSync(join(root,'runtime','Scripts','python.exe'),['-B','-c',code,...args],{windowsHide:true,encoding:'utf8',timeout:10000}).trim();
const verifyPixels=file=>JSON.parse(python("from PIL import Image; import sys,json; im=Image.open(sys.argv[1]).convert('RGB'); expected=Image.new('RGB',(320,160),(220,20,40)); expected.paste((20,40,220),(160,0,320,160)); expected=expected.transpose(Image.Transpose.ROTATE_270); print(json.dumps({'size':list(im.size),'pixelsMatch':im.size==expected.size and im.tobytes()==expected.tobytes()}))",[file]));
const flatten=node=>node?[node,...(node.children??[]).flatMap(flatten)]:[];
function client(){
 const child=spawn(process.execPath,[join(root,'hidden','launch.mjs')],{windowsHide:true,stdio:['pipe','pipe','pipe']});
 const pending=new Map();let seq=0;
 createInterface({input:child.stdout}).on('line',line=>{const r=JSON.parse(line),p=pending.get(r.id);if(p){clearTimeout(p.timer);pending.delete(r.id);r.error?p.reject(new Error(JSON.stringify(r.error))):p.resolve(r.result)}});
 child.stderr.on('data',b=>process.stderr.write(b));
 const fail=()=>{for(const p of pending.values()){clearTimeout(p.timer);p.reject(new Error('MCP exited'))}pending.clear()};child.on('exit',fail);child.on('error',fail);
 const rpc=traceRpc((method,params={})=>new Promise((resolve,reject)=>{const id=++seq,timer=setTimeout(()=>{pending.delete(id);reject(new Error('MCP timeout'))},22000);pending.set(id,{resolve,reject,timer});child.stdin.write(JSON.stringify({jsonrpc:'2.0',id,method,params})+'\n')}));
 return {rpc,async call(name,args){const r=await rpc('tools/call',{name,arguments:args});if(r.isError)throw new Error(name+': '+JSON.stringify(r.structuredContent));return r.structuredContent?.result??r.structuredContent?.data??r.structuredContent},async init(){await rpc('initialize',{protocolVersion:'2025-11-25',capabilities:{},clientInfo:{name:'paint-regression',version:'1'}});child.stdin.write(JSON.stringify({jsonrpc:'2.0',method:'notifications/initialized'})+'\n')},close(){child.stdin.end()}};
}
function unique(tree,names){const found=flatten(tree.tree).filter(n=>names.includes(n.name)&&n.available_actions?.includes('Click')&&n.ref_id);if(found.length!==1)throw new Error('Exact Paint element missing or ambiguous: '+names.join('/'));return found[0]}
const preflight=JSON.parse(ps("$p=@(Get-Process -Name mspaint,Paint -ErrorAction SilentlyContinue | Select-Object -ExpandProperty Id);$app=Get-AppxPackage Microsoft.Paint;$entry='';$exe='';if($app){[xml]$m=Get-Content -LiteralPath (Join-Path $app.InstallLocation 'AppxManifest.xml');$a=$m.Package.Applications.Application | Select-Object -First 1;$entry=[string]$a.EntryPoint;$exe=Join-Path $app.InstallLocation ([string]$a.Executable)};@{processCount=$p.Count;version=([string]$app.Version);entryPoint=$entry;executable=$exe}|ConvertTo-Json -Compress"));
report.version=preflight.version;report.preexistingProcessCount=preflight.processCount;
if(!process.argv.includes('--run'))report.reason='Pass --run for a real isolated Paint edit/save regression';
else if(preflight.processCount)report.reason='Existing Paint process detected; no launch or interaction attempted';
else if(preflight.entryPoint!=='Windows.FullTrustApplication'||!existsSync(preflight.executable)){report.status='unsupported';report.reason='Paint does not declare an available full-trust executable';}
else{
 mkdirSync(folder,{recursive:true});
 const file=join(folder,'Fairymouse-Paint-'+process.pid+'.png');
 python("from PIL import Image; import sys; im=Image.new('RGB',(320,160),(220,20,40)); im.paste((20,40,220),(160,0,320,160)); im.save(sys.argv[1])",[file]);
 const server=client(),name='FairyHidden-Paint-'+process.pid;
 let created=false,top,pid,identity,monitor;
 try{
  monitor=await startMonitor(folder);
  await server.init();await server.call('hidden_create',{name});created=true;
  monitor.guard();const launched=await server.call('hidden_launch',{name,executable:preflight.executable,arguments:[file],wait_ms:5000});pid=launched.pid;
  const raw=ps(`$p=Get-CimInstance Win32_Process -Filter 'ProcessId=${pid}';if($p -and $p.ExecutablePath -eq ${quote(preflight.executable)}){@{id=$p.ProcessId;path=$p.ExecutablePath;created=$p.CreationDate.ToUniversalTime().ToString('o')}|ConvertTo-Json -Compress}`);
  if(raw)identity=JSON.parse(raw);
  for(let i=0;i<30&&!top;i++){const windows=await server.call('hidden_windows',{name});top=windows.find(w=>w.process_id===pid&&(w.title??'').includes('Fairymouse-Paint-'));if(!top)await pause(100)}
  if(!top||!identity){report.status='unsupported';report.reason='No same-process Paint test-file window on the hidden desktop; no foreground fallback';}
  else{
   report.samePidOnHiddenDesktop=true;
   const snapshot=async label=>{const tree=await server.call('hidden_semantic',{name,hwnd:top.handle,action:'snapshot'});writeFileSync(join(folder,label+'.json'),JSON.stringify(tree,null,2));return tree};
   const click=async element=>{monitor.guard();return server.call('hidden_semantic',{name,hwnd:top.handle,action:'click',ref:element.ref_id})};
   let tree=await snapshot('initial');
   if(process.argv.includes('--probe')){report.status='observed';report.reason='Read-only Paint probe; no edit/save attempted';}
   else{
    await checkpoint('edit');
    tree=await snapshot('edit-ready');
    await click(unique(tree,['旋转','Rotate']));tree=await snapshot('rotation-menu');
    await click(unique(tree,['向右旋转 90º','向右旋转 90°','Rotate right 90º','Rotate right 90°']));
    tree=await snapshot('after-rotate');
    await checkpoint('save');
    tree=await snapshot('save-ready');
    await click(unique(tree,['保存','Save']));
    await pause(500);await snapshot('after-save');
    const verification=verifyPixels(file);
    report.diskVerification=verification;if(!verification.pixelsMatch)throw new Error('Paint saved PNG does not match exact clockwise-rotated pixels');
    report.status='passed';report.fileSaveVerified=true;
   }
   const result=await server.rpc('tools/call',{name:'hidden_screenshot',arguments:{name,hwnd:top.handle,max_size:1000}}),image=result.content?.find(c=>c.type==='image');
   if(!image)throw new Error('Paint screenshot unavailable');
   report.screenshot=join(folder,'paint.png');writeFileSync(report.screenshot,Buffer.from(image.data,'base64'));
  }
 }catch(error){report.status='failed';report.reason=error.message;process.exitCode=1}
 finally{
  if(created){try{
   if(top){const windows=await server.call('hidden_windows',{name});if(windows.some(w=>w.handle===top.handle&&w.process_id===pid))await server.call('hidden_close_window',{name,hwnd:top.handle})}
   if(pid){let done=await server.call('hidden_wait',{name,condition:'process_exited',process_id:pid,timeout_ms:1500});if(!done.verified&&identity){ps(`$p=Get-CimInstance Win32_Process -Filter 'ProcessId=${identity.id}';if($p -and $p.ExecutablePath -eq ${quote(identity.path)} -and $p.CreationDate.ToUniversalTime().ToString('o') -eq ${quote(identity.created)}){Stop-Process -Id $p.ProcessId -ErrorAction Stop}`);done=await server.call('hidden_wait',{name,condition:'process_exited',process_id:pid,timeout_ms:2000})}if(!done.verified)throw new Error('Owned Paint process did not exit')}
   await server.call('hidden_release',{name});report.cleanedUp=true;
   if(report.fileSaveVerified){report.afterExitVerification=verifyPixels(file);if(!report.afterExitVerification.pixelsMatch)throw new Error('Saved Paint image changed after application exit')}
  }catch(error){report.status='failed';report.cleanedUp=false;report.cleanupError=error.message;process.exitCode=1}}
  server.close();if(monitor){try{report.foregroundMonitor=await monitor.stop()}catch(error){report.status='failed';report.monitorError=error.message;process.exitCode=1}}
 }
}
const output=reportPath('paint-apps.json');mkdirSync(dirname(output),{recursive:true});writeFileSync(output,JSON.stringify(report,null,2));finishTrace(report.status);console.log(JSON.stringify(report));
