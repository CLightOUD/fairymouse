import {spawn} from 'node:child_process';
import {createInterface} from 'node:readline';
import {dirname,join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {readFileSync,writeFileSync,mkdirSync,existsSync} from 'node:fs';

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
 if(list.tools.length!==26)throw new Error('Unexpected desktop tool count');
 for(const name of ['desktop_press','desktop_focus_window','desktop_restore','desktop_batch','desktop_mouse_click'])if(list.tools.some(t=>t.name===name))throw new Error('Foreground tool exposed');
 const denied=await desktop.rpc('tools/call',{name:'desktop_press',arguments:{key:'a'}});
 if(!denied.isError)throw new Error('Physical input not refused');
 const status=await desktop.rpc('tools/call',{name:'desktop_status',arguments:{}});
 if(status.isError)throw new Error('Desktop backend failed');
 report.desktop={tools:26,statusPassed:true,physicalInputRefused:true};
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
 const list=await hidden.rpc('tools/list');if(list.tools.length!==17)throw new Error('Unexpected hidden tool count');
 for(const tool of ['hidden_status','hidden_wait','hidden_controls'])if(!list.tools.find(t=>t.name===tool)?.annotations?.readOnlyHint)throw new Error('Missing read-only hint');
 if((await call('hidden_status')).status!=='ready')throw new Error('Server not ready');
 const reserved=await hidden.rpc('tools/call',{name:'hidden_create',arguments:{name:'Default'}});
 if(!reserved.isError)throw new Error('Reserved desktop accepted');
 const rejected=await hidden.rpc('tools/call',{name:'hidden_controls',arguments:{name,hwnd:foreground}});
 if(!rejected.isError)throw new Error('Main-desktop HWND accepted');
 await call('hidden_create',{name});
 const launched=await call('hidden_launch',{name,executable:join(root,'tests','.work','DesktopTrial.exe'),arguments:[folder]});
 if(launched.status!=='verified'||!launched.verified||'focus_stealing' in launched)throw new Error('Launch verification contract failed');
 let windows=[];
 for(let i=0;i<50;i++){windows=await call('hidden_windows',{name});if(windows.some(w=>w.title==='Fairy Agent Desktop Trial'))break;await pause(100)}
 const top=windows.find(w=>w.title==='Fairy Agent Desktop Trial');if(!top)throw new Error('Test window missing');
 const controls=await call('hidden_controls',{name,hwnd:top.handle});
 const input=controls.find(c=>c.class.includes('EDIT'));
 const button=controls.find(c=>c.text==='Apply test value');
 const check=controls.find(c=>c.text==='Background test checkbox');
 const stillOpen=await call('hidden_wait',{name,condition:'window_closed',hwnd:top.handle,timeout_ms:100});
 if(stillOpen.status!=='not_observed')throw new Error('Live window reported closed');
 const wrongClose=await hidden.rpc('tools/call',{name:'hidden_wait',arguments:{name,condition:'window_closed',hwnd:foreground,timeout_ms:100}});
 if(!wrongClose.isError)throw new Error('Main desktop treated as a closed hidden window');
 const found=await call('hidden_controls',{name,hwnd:top.handle,text:'Apply test value'});
 if(found.length!==1||found[0].handle!==button.handle||!Number.isInteger(found[0].client_left))throw new Error('Control filter/coordinates failed');
 const outOfBounds=await hidden.rpc('tools/call',{name:'hidden_click',arguments:{name,hwnd:button.handle,x:32000,y:32000}});
 if(!outOfBounds.isError||outOfBounds.structuredContent?.code!=='INVALID_COORDINATES')throw new Error('Invalid click was accepted');
 let count=0;
 async function verify(expected){for(let i=0;i<20;i++){if(readFileSync(join(folder,'fixture-state.txt'),'utf8').includes(expected)){count++;return}await pause(50)}throw new Error('Missing effect: '+expected)}
 for(let n=1;n<=3;n++){
  const text='Fairymouse round '+n;
  const set=await call('hidden_set_text',{name,hwnd:input.handle,text});if(!set.verified||set.status!=='verified')throw new Error('Text readback missing');await verify('input='+text);
  const click=await call('hidden_click',{name,hwnd:button.handle,x:10,y:10});if(click.status!=='posted'||click.verified!==false||click.retry_safe!==false)throw new Error('Click overstated success');await verify('result=Applied: '+text);
  for(const expected of ['True','False']){await call('hidden_click',{name,hwnd:check.handle,x:8,y:10});await verify('checked='+expected)}
 }
 await call('hidden_keys',{name,hwnd:input.handle,keys:['end']});
 await call('hidden_type_text',{name,hwnd:input.handle,text:' 中文😀'});await verify('input=Fairymouse round 3 中文😀');
 await call('hidden_click',{name,hwnd:button.handle,x:10,y:10});await verify('result=Applied: Fairymouse round 3 中文😀');
 const waited=await call('hidden_wait',{name,condition:'text_equals',hwnd:input.handle,text:'Fairymouse round 3 中文😀'});
 if(!waited.verified)throw new Error('Text wait failed');
 const absent=await call('hidden_wait',{name,condition:'window_exists',text:'never present',timeout_ms:100});
 if(absent.status!=='not_observed')throw new Error('Missing window reported present');
 const busyWait=call('hidden_wait',{name,condition:'window_exists',text:'never present',timeout_ms:500});
 await pause(50);
 if((await call('hidden_status')).status!=='busy')throw new Error('Concurrent status unavailable');
 const busyMutation=await hidden.rpc('tools/call',{name:'hidden_click',arguments:{name,hwnd:button.handle,x:10,y:10}});
 if(!busyMutation.isError||busyMutation.structuredContent?.code!=='BUSY')throw new Error('Mutation queued while busy');
 await busyWait;
 const shot=await hidden.rpc('tools/call',{name:'hidden_screenshot',arguments:{name,hwnd:top.handle,max_size:320}});
 const img=shot.content.find(c=>c.type==='image');if(!img)throw new Error('Screenshot missing');
 writeFileSync(join(root,'reports','hidden-test.png'),Buffer.from(img.data,'base64'));

 const observed=await call('hidden_observe',{name,hwnd:top.handle});
 const inputRef=observed.controls.find(c=>c.handle===input.handle).ref;
 const changedValue=await call('hidden_act',{name,ref:inputRef,action:'set_text',text:'reference text'});
 if(!changedValue.verified)throw new Error('Reference write failed');
 const consumed=await hidden.rpc('tools/call',{name:'hidden_act',arguments:{name,ref:inputRef,action:'click'}});
 if(!consumed.isError||consumed.structuredContent.code!=='STALE_REF')throw new Error('Consumed reference accepted');
 const beforeDiff=await call('hidden_observe',{name,hwnd:top.handle});
 await call('hidden_set_text',{name,hwnd:input.handle,text:'diff text'});
 const delta=await call('hidden_observe',{name,hwnd:top.handle,baseline:beforeDiff.snapshot});
 if(!delta.diff.changed.some(c=>c.handle===input.handle&&c.fields.text==='diff text'))throw new Error('Text diff missing');
 const fresh=await call('hidden_observe',{name,hwnd:top.handle});
 const applyRef=fresh.controls.find(c=>c.handle===button.handle).ref;
 const resultRef=fresh.controls.find(c=>(c.text||'').startsWith('Applied:')).ref;
 const applied=await call('hidden_act',{name,ref:applyRef,action:'click',expect_ref:resultRef,expect_text:'Applied: diff text'});
 if(!applied.verified||applied.action.status!=='posted')throw new Error('Post-action verification failed');
 const staleSnapshot=await call('hidden_observe',{name,hwnd:top.handle});
 const staleRef=staleSnapshot.controls.find(c=>c.handle===input.handle).ref;
 await call('hidden_set_text',{name,hwnd:input.handle,text:'external change'});
 const stale=await hidden.rpc('tools/call',{name:'hidden_act',arguments:{name,ref:staleRef,action:'set_text',text:'must not happen'}});
 if(!stale.isError||stale.structuredContent.code!=='STALE_REF')throw new Error('Changed target accepted');
 // Independent MCP processes: same desktop denied, separate desktop usable concurrently.
 const peer=client(join(root,'hidden','launch.mjs'));
 const peerName=name+'-peer';
 try{
  await peer.init();
  const conflict=await peer.rpc('tools/call',{name:'hidden_create',arguments:{name}});
  if(!conflict.isError||conflict.structuredContent.code!=='DESKTOP_OWNED')throw new Error('Cross-process ownership missing');
  const created=await peer.rpc('tools/call',{name:'hidden_create',arguments:{name:peerName}});
  if(created.isError)throw new Error('Independent desktop blocked');
   if(created.structuredContent.already_exists!==false)throw new Error('New desktop incorrectly reported as existing');
   const reopened=await peer.rpc('tools/call',{name:'hidden_create',arguments:{name:peerName}});
   if(reopened.isError||reopened.structuredContent.already_exists!==true)throw new Error('Repeated desktop creation must report reopen');
  const peerFolder=join(folder,'peer');mkdirSync(peerFolder);
  const peerCall=async(tool,args)=>{const r=await peer.rpc('tools/call',{name:tool,arguments:args});if(r.isError)throw new Error(JSON.stringify(r));return r.structuredContent?.result??r.structuredContent};
  const peerLaunch=await peerCall('hidden_launch',{name:peerName,executable:join(root,'tests','.work','DesktopTrial.exe'),arguments:[peerFolder]});
  if(!peerLaunch.verified)throw new Error('Peer fixture launch unverified');
  const peerTop=peerLaunch.windows.find(w=>w.title==='Fairy Agent Desktop Trial');
  const peerControls=await peerCall('hidden_controls',{name:peerName,hwnd:peerTop.handle});
  const peerInput=peerControls.find(c=>c.class.includes('EDIT'));
  const parallel=await Promise.all([
   call('hidden_set_text',{name,hwnd:input.handle,text:'agent-one'}),
   peerCall('hidden_set_text',{name:peerName,hwnd:peerInput.handle,text:'agent-two'})
  ]);
  if(!parallel.every(r=>r.verified))throw new Error('Parallel text operations failed');
  if(!readFileSync(join(folder,'fixture-state.txt'),'utf8').includes('input=agent-one')||!readFileSync(join(peerFolder,'fixture-state.txt'),'utf8').includes('input=agent-two'))throw new Error('Agent effects crossed desktops');
  await peerCall('hidden_close_window',{name:peerName,hwnd:peerTop.handle});
  await peerCall('hidden_wait',{name:peerName,condition:'process_exited',process_id:peerLaunch.pid});
  const longWait=call('hidden_wait',{name,condition:'window_exists',text:'absent',timeout_ms:500});
  const independent=await peer.rpc('tools/call',{name:'hidden_windows',arguments:{name:peerName}});
  if(independent.isError)throw new Error('Parallel desktop observation failed');
  await longWait;
  const released=await peer.rpc('tools/call',{name:'hidden_release',arguments:{name:peerName}});
  if(released.isError)throw new Error('Peer cleanup failed');
 }finally{peer.close()}

 for(const [label,action,value] of [['Background test checkbox','check',null],['Background test checkbox','uncheck',null]]){
  const shot=await call('hidden_observe',{name,hwnd:top.handle});const ref=shot.controls.find(c=>c.text===label).ref;
  const result=await call('hidden_act',{name,ref,action});if(!result.verified)throw new Error('Checkbox verification failed');
 }
 for(const [kind,index] of [['COMBOBOX',2],['LISTBOX',5]]){
  const shot=await call('hidden_observe',{name,hwnd:top.handle});const ref=shot.controls.find(c=>c.class.toUpperCase().includes(kind)).ref;
  const result=await call('hidden_act',{name,ref,action:'select',value:index});if(!result.verified)throw new Error('Selection failed');
 }
 if(!readFileSync(join(folder,'fixture-state.txt'),'utf8').includes('choice=2')||!readFileSync(join(folder,'fixture-state.txt'),'utf8').includes('list=5'))throw new Error('Selection notification missing');
 const scrollShot=await call('hidden_observe',{name,hwnd:top.handle});
 const scrolled=await call('hidden_act',{name,ref:scrollShot.controls.find(c=>c.class.toUpperCase().includes('LISTBOX')).ref,action:'scroll',value:3});
 if(scrolled.action.after<=scrolled.action.before)throw new Error('List did not scroll');
 function flatten(node){return [node,...(node.children??[]).flatMap(flatten)]}
 let semanticShot=await call('hidden_semantic',{name,hwnd:top.handle});
 const semanticInput=flatten(semanticShot.data.tree).find(n=>n.name==='TrialInput'&&n.role==='textfield');
 await call('hidden_semantic',{name,hwnd:top.handle,action:'set_value',ref:semanticInput.ref_id,value:'semantic text'});
 semanticShot=await call('hidden_semantic',{name,hwnd:top.handle});
 const semanticButton=flatten(semanticShot.data.tree).find(n=>n.name==='TrialApply'&&n.role==='button');
 if(!semanticButton?.ref_id)throw new Error('Hidden semantic button missing');
 const semanticClick=await call('hidden_semantic',{name,hwnd:top.handle,action:'click',ref:semanticButton.ref_id});
 if(!['verified','completed_unverified'].includes(semanticClick.status))throw new Error('Semantic result contract failed');
 await verify('result=Applied: semantic text');
 const consumedSemantic=await hidden.rpc('tools/call',{name:'hidden_semantic',arguments:{name,hwnd:top.handle,action:'click',ref:semanticButton.ref_id}});
 if(!consumedSemantic.isError||consumedSemantic.structuredContent.code!=='STALE_REF')throw new Error('Consumed semantic ref accepted');
 const wrongSemantic=await hidden.rpc('tools/call',{name:'hidden_semantic',arguments:{name,hwnd:foreground}});
 if(!wrongSemantic.isError)throw new Error('Semantic bridge accepted main desktop');
 await call('hidden_set_text',{name,hwnd:input.handle,text:'mapped message'});
 const mappedShot=await call('hidden_semantic',{name,hwnd:top.handle});
 const bounds=flatten(mappedShot.data.tree).find(n=>n.name==='TrialApply'&&n.role==='button').bounds;
 await call('hidden_click',{name,hwnd:top.handle,x:Math.round(bounds.x+bounds.width/2),y:Math.round(bounds.y+bounds.height/2),coordinate_space:'screen'});
 await verify('result=Applied: mapped message');
 const outsideScreen=await hidden.rpc('tools/call',{name:'hidden_click',arguments:{name,hwnd:top.handle,x:-500000,y:-500000,coordinate_space:'screen'}});
 if(!outsideScreen.isError)throw new Error('Screen point outside hidden window accepted');
 await call('hidden_control',{action:'pause'});
 const pausedSnapshot=await call('hidden_semantic',{name,hwnd:top.handle});
 if(pausedSnapshot.fairy.retry_safe!==true)throw new Error('Paused semantic snapshot unavailable');
 const pausedSemantic=await hidden.rpc('tools/call',{name:'hidden_semantic',arguments:{name,hwnd:top.handle,action:'click',ref:flatten(pausedSnapshot.data.tree).find(n=>n.name==='TrialApply'&&n.role==='button').ref_id}});
 if(!pausedSemantic.isError||pausedSemantic.structuredContent.code!=='PAUSED')throw new Error('Paused semantic mutation admitted');
 const blocked=await hidden.rpc('tools/call',{name:'hidden_set_text',arguments:{name,hwnd:input.handle,text:'blocked'}});
 if(!blocked.isError||blocked.structuredContent.fairy.code!=='PAUSED')throw new Error('Paused mutation admitted');
 await call('hidden_windows',{name});
 await call('hidden_control',{action:'resume'});
 if(!(await call('hidden_windows',{name})).some(w=>w.handle===top.handle))throw new Error('Worker restart lost app');
 if(!(await call('hidden_set_text',{name,hwnd:input.handle,text:'after recovery'})).verified)throw new Error('Worker recovery unusable');
 const pauseButton=controls.find(c=>c.text==='Pause UI');
 await call('hidden_click',{name,hwnd:pauseButton.handle,x:10,y:10});
 for(let i=0;i<50&&!existsSync(join(folder,'paused.flag'));i++)await pause(10);
 if(!existsSync(join(folder,'paused.flag')))throw new Error('Fixture did not enter unresponsive state');
 const start=Date.now();
 const hung=await hidden.rpc('tools/call',{name:'hidden_set_text',arguments:{name,hwnd:input.handle,text:'timeout probe'}});
 if(!hung.isError||hung.structuredContent?.code!=='MESSAGE_TIMEOUT_OR_FAILED'||Date.now()-start>1200)throw new Error('Unresponsive control was not bounded');
 await pause(1600);
 if((await call('hidden_status')).status!=='ready')throw new Error('Server did not recover');
 await call('hidden_close_window',{name,hwnd:top.handle});
 if(!(await call('hidden_wait',{name,condition:'window_closed',hwnd:top.handle})).verified)throw new Error('Close wait failed');
 for(let i=0;i<40;i++){windows=await call('hidden_windows',{name});if(windows.length===0)break;await pause(100)}
 if(!(await call('hidden_wait',{name,condition:'process_exited',process_id:launched.pid})).verified)throw new Error('Fixture process did not exit');
 await call('hidden_release',{name});
 const unknown=await call('hidden_launch',{name,executable:join(root,'runtime','Scripts','python.exe'),arguments:['-c','pass'],wait_ms:200});
 if(unknown.status!=='launched_unverified'||unknown.verified!==false)throw new Error('Windowless launch overstated verification');
 if(!(await call('hidden_wait',{name,condition:'process_exited',process_id:unknown.pid})).verified)throw new Error('Windowless process did not exit');
 await call('hidden_release',{name});
 report.hidden={tools:17,effectsVerified:count,unicodePassed:true,mainDesktopRefused:true,reservedDesktopRefused:true,screenshotPassed:true,fixtureClosed:true,launchVerified:true,windowlessLaunchUnverified:true,textReadbackVerified:true,conditionWaits:true,busyMutationRefused:true,concurrentStatus:true,unresponsiveControlBounded:true,targetRefs:true,consumedRefsRejected:true,staleRefsRejected:true,observationDiff:true,actionVerification:true,crossProcessOwnership:true,independentDesktops:true,parallelFixtureWrites:true,standardControls:true,hiddenSemantic:true,pauseResume:true,workerRecovery:true};
 report.validatedAt=new Date().toISOString();
 writeFileSync(join(root,'reports','validation.json'),JSON.stringify(report,null,2));console.log(JSON.stringify(report));
}finally{writeFileSync(join(folder,'close.flag'),'');hidden.close()}
