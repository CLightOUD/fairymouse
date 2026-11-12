// Test-only MCP mailbox for a human/AI evaluator making decisions between calls.
// No model SDK, recorded action plan, network endpoint, or production integration.
import {spawn} from 'node:child_process';
import {createInterface} from 'node:readline';
import {mkdirSync,readFileSync,writeFileSync,existsSync,readdirSync,renameSync} from 'node:fs';
import {resolve,join,dirname} from 'node:path';
import {fileURLToPath} from 'node:url';
import {startMonitor,pause,traceRpc} from './app_harness.mjs';

const root=dirname(dirname(fileURLToPath(import.meta.url)));
const folder=resolve(process.argv[2]??'');
const scratch=join(root,'tests','.work');
if(!folder.startsWith(scratch+'\\')&&!folder.startsWith(scratch+'/'))throw new Error('Use a fresh tests/.work subdirectory');
mkdirSync(folder,{recursive:true});
if(existsSync(join(folder,'ready.json')))throw new Error('Session directory has already been used');
const pending=new Map();let sequence=0,child,monitor;
const audit=[];
try{
 monitor=await startMonitor(join(folder,'monitor'),{mode:'coexist'});
 child=spawn(process.execPath,[join(root,'hidden','launch.mjs')],{windowsHide:true,stdio:['pipe','pipe','pipe']});
 await monitor.registerProcess(child.pid);
 let stderr='';child.stderr.on('data',b=>stderr+=b);
 const fail=error=>{for(const p of pending.values()){clearTimeout(p.timer);p.reject(error)}pending.clear()};
 child.on('error',fail);child.on('exit',()=>fail(new Error('MCP exited')));
 createInterface({input:child.stdout}).on('line',line=>{
  let response;try{response=JSON.parse(line)}catch{return fail(new Error('Invalid MCP JSON'))}
  const p=pending.get(response.id);if(!p)return;
  pending.delete(response.id);clearTimeout(p.timer);
  response.error?p.reject(new Error(JSON.stringify(response.error))):p.resolve(response.result);
 });
 const rpc=traceRpc((method,params={})=>new Promise((resolve,reject)=>{
  const id=++sequence,timer=setTimeout(()=>{pending.delete(id);reject(new Error('MCP outcome unknown: response deadline'))},25000);
  pending.set(id,{resolve,reject,timer});child.stdin.write(JSON.stringify({jsonrpc:'2.0',id,method,params})+'\n');
 }));
 await rpc('initialize',{protocolVersion:'2025-11-25',capabilities:{},clientInfo:{name:'interactive-test-evaluator',version:'1'}});
 child.stdin.write(JSON.stringify({jsonrpc:'2.0',method:'notifications/initialized'})+'\n');
 writeFileSync(join(folder,'tools.json'),JSON.stringify(await rpc('tools/list'),null,2));
 writeFileSync(join(folder,'ready.json'),JSON.stringify({pid:process.pid,mcpPid:child.pid,mode:'coexist',scope:'Evaluator chooses each call; test-only mailbox'}));
 console.log('READY '+folder);
 const done=new Set(),deadline=Date.now()+30*60*1000;
 while(!existsSync(join(folder,'stop.flag'))){
  if(Date.now()>deadline)throw new Error('Interactive evaluation deadline exceeded');
  for(const file of readdirSync(folder).filter(n=>/^request-\d+\.json$/.test(n)).sort()){
   if(done.has(file))continue;done.add(file);
   const started=Date.now();let result,request;
   try{
    request=JSON.parse(readFileSync(join(folder,file),'utf8').replace(/^\uFEFF/,''));
    // Observation and cleanup must remain possible after interference detection.
    const readOnly=['hidden_status','hidden_windows','hidden_observe','hidden_controls','hidden_screenshot','hidden_wait','hidden_release','hidden_close_window'];
    if(!readOnly.includes(request.name)&&!(request.name==='hidden_semantic'&&request.arguments?.action==='snapshot'))monitor.guard();
    result=await rpc('tools/call',request);
   }catch(error){result={isError:true,error:error.message}}
   audit.push({request:file,tool:request?.name,started,ended:Date.now(),isError:!!result.isError});
   const response=file.replace('request-','response-');
   writeFileSync(join(folder,response+'.tmp'),JSON.stringify(result,null,2));renameSync(join(folder,response+'.tmp'),join(folder,response));
  }
  await pause(50);
 }
 writeFileSync(join(folder,'stderr.log'),stderr);
}finally{
 child?.stdin.end();
 if(child&&child.exitCode===null){await Promise.race([new Promise(r=>child.once('exit',r)),pause(3000)]);if(child.exitCode===null)child.kill()}
 let observation;try{observation=await monitor?.stop()}catch(error){observation={error:error.message}}
 writeFileSync(join(folder,'session.json'),JSON.stringify({audit,observation,scope:'No automatic business-success verdict; verify saved artifact separately'},null,2));
}
