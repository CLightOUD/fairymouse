import {spawn} from 'node:child_process';
import {createInterface} from 'node:readline';
import {dirname,join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {allowed,readTools,normalize,localResult,controlTool,observationIsFresh} from './protocol.mjs';
const dir=dirname(fileURLToPath(import.meta.url));
const requests=new Map();
let child,paused=false,unavailable=false,closing=false,initializeMessage,recoveryId=null,recoveryRequest=null,needsObservation=false,observationGeneration=0;
const send=m=>process.stdout.write(JSON.stringify(m)+'\n');
const reply=(id,result)=>{if(id!==undefined)send({jsonrpc:'2.0',id,result})};
function failBackend(code,message){
 unavailable=true;paused=true;needsObservation=true;observationGeneration++;
 for(const [key,p] of requests){clearTimeout(p.timer);reply(p.id,localResult('error',code,message));requests.delete(key)}
 if(recoveryRequest){clearTimeout(recoveryRequest.timer);reply(recoveryRequest.id,localResult('error',code,message));recoveryRequest=null;recoveryId=null}
}
function start(){
 const instance=spawn(join(dir,'agent-desktop.exe'),['mcp'],{windowsHide:true,stdio:['pipe','pipe','pipe'],env:{...process.env,AGENT_DESKTOP_HOME:join(dir,'state')}});
 child=instance;
 createInterface({input:instance.stdout}).on('line',line=>{
  if(instance!==child)return;
  let m;try{m=JSON.parse(line)}catch{failBackend('INVALID_BACKEND_OUTPUT','Backend emitted invalid JSON; recover explicitly.');instance.kill();return}
  if(!m||typeof m!=='object'||Array.isArray(m)){failBackend('INVALID_BACKEND_OUTPUT','Backend returned a non-object message.');instance.kill();return}
  if(recoveryId!==null&&m.id===recoveryId){
   const pending=recoveryRequest;clearTimeout(pending.timer);recoveryRequest=null;recoveryId=null;
   if(m.error){reply(pending.id,localResult('error','RECOVERY_FAILED','Backend initialization failed'));return}
   instance.stdin.write(JSON.stringify({jsonrpc:'2.0',method:'notifications/initialized'})+'\n');
   unavailable=false;
   reply(pending.id,localResult('recovered',null,'Backend restarted without replay. Still paused; resume and take a new snapshot.',{paused:true,requires_observation:true}));return;
  }
  const key=JSON.stringify(m.id),p=requests.get(key);
  if(!p){if(m.id===undefined)send(m);return}
  clearTimeout(p.timer);requests.delete(key);
  if(p.method==='tools/list'&&m.result?.tools)m.result.tools=[...m.result.tools.filter(t=>allowed.has(t.name)).map(t=>t.outputSchema?.type==='object'?{...t,outputSchema:{...t.outputSchema,properties:{...t.outputSchema.properties,fairy:{type:'object'}}}}:t),controlTool];
  if(p.method==='initialize'&&m.result){
   m.result.serverInfo={...m.result.serverInfo,name:'fairy-desktop-background',version:'1.2.0-local-autofocus-fix'};
   m.result.instructions='Background semantic actions only; physical input and activation unavailable. Read desktop_skills_get. Apps may activate themselves. Check structuredContent.fairy; completed_unverified is not business success. desktop_control pauses new mutations, not in-flight work. Recovery requires a new snapshot. '+(m.result.instructions??'');
  }
  if(p.method==='tools/call'&&m.result){
   m.result=normalize(m.result,p.name);
   if(p.name==='desktop_snapshot'&&observationIsFresh(p.generation,observationGeneration,paused,m.result.isError))needsObservation=false;
  }
  send(m);
 });
 instance.stderr.on('data',b=>process.stderr.write(b));
 instance.stdin.on('error',()=>{if(instance===child&&!closing)failBackend('BACKEND_PIPE_CLOSED','Backend pipe closed; recover explicitly. Outcomes may be unknown.')});
 instance.on('error',e=>{if(instance===child&&!closing)failBackend('BACKEND_START_FAILED',e.message)});
 instance.on('exit',()=>{if(instance===child&&!closing)failBackend('BACKEND_EXITED','Backend exited. Do not replay mutations; inspect after explicit recovery.')});
}
start();
createInterface({input:process.stdin}).on('line',line=>{
 let m;try{m=JSON.parse(line)}catch{send({jsonrpc:'2.0',id:null,error:{code:-32700,message:'Invalid JSON'}});return}
 if(!m||typeof m!=='object'||Array.isArray(m)||typeof m.method!=='string'){send({jsonrpc:'2.0',id:null,error:{code:-32600,message:'Invalid request'}});return}
 if(m.method==='tools/call'&&m.id===undefined)return;
 if(m.method==='tools/call'){
  const name=m.params?.name;
  if(name==='desktop_control'){
   const args=m.params?.arguments??{},action=args.action;
   if(!['status','pause','resume','recover'].includes(action)||Object.keys(args).some(k=>k!=='action')){reply(m.id,localResult('error','INVALID_ARGUMENT','Use action status, pause, resume or recover.'));return}
   if(action==='pause'){paused=true;needsObservation=true;observationGeneration++}
   if(action==='resume'){
    if(unavailable){reply(m.id,localResult('error','RECOVERY_REQUIRED','Recover the backend before resuming.'));return}
    paused=false;needsObservation=true;observationGeneration++;
   }
   if(action==='recover'){
    if(!unavailable||recoveryRequest){reply(m.id,localResult('error','RECOVERY_NOT_ALLOWED','Recovery requires a failed backend and no recovery in progress.'));return}
    if(!initializeMessage){reply(m.id,localResult('error','INITIALIZE_REQUIRED','Initialize this MCP connection first.'));return}
    observationGeneration++;needsObservation=true;
    child?.kill();start();recoveryId='fairy-recover-'+Date.now();
    recoveryRequest={id:m.id,timer:setTimeout(()=>{failBackend('RECOVERY_TIMEOUT','Backend initialization timed out.');child.kill()},10000)};
    child.stdin.write(JSON.stringify({...initializeMessage,id:recoveryId})+'\n');return;
   }
   reply(m.id,localResult(paused?'paused':'ready',null,null,{paused,backend_available:!unavailable,backend_pid:child?.pid,in_flight:requests.size,requires_observation:needsObservation,observation_generation:observationGeneration,in_flight_cancelled:false}));return;
  }
  if(!allowed.has(name)){reply(m.id,localResult('error','TOOL_NOT_ALLOWED','Physical input, focus, restore, launch, batch and clipboard mutation are unavailable.'));return}
  if(!readTools.has(name)&&(paused||needsObservation)){reply(m.id,localResult('error',paused?'PAUSED':'OBSERVATION_REQUIRED',paused?'New mutations are paused; in-flight actions may finish.':'Take a fresh desktop_snapshot before mutating.'));return}
 }
 if(unavailable){reply(m.id,localResult('error','RECOVERY_REQUIRED','Backend unavailable; use desktop_control recover.'));return}
 if(m.method==='initialize')initializeMessage=m;
 if(m.id!==undefined){
  const key=JSON.stringify(m.id);
  if(requests.has(key)){send({jsonrpc:'2.0',id:m.id,error:{code:-32600,message:'Duplicate active request id'}});return}
  if(requests.size>=32){reply(m.id,localResult('error','BUSY','Pending request limit reached; request not queued.'));return}
  const timer=setTimeout(()=>{failBackend('TIMEOUT_UNKNOWN_OUTCOME','Backend timed out; wrapper stopped it without replay. Spawned actions may still finish. Explicit recovery required.');child.kill()},30000);
  requests.set(key,{id:m.id,method:m.method,name:m.params?.name,timer,generation:observationGeneration});
 }
 child.stdin.write(JSON.stringify(m)+'\n');
}).on('close',()=>{closing=true;for(const p of requests.values())clearTimeout(p.timer);if(recoveryRequest)clearTimeout(recoveryRequest.timer);child.stdin.end();const timer=setTimeout(()=>{child.kill();process.exit(0)},1500);child.once('exit',()=>{clearTimeout(timer);process.exit(0)})});
for(const signal of ['SIGTERM','SIGINT'])process.on(signal,()=>{closing=true;child.kill();process.exit(0)});
