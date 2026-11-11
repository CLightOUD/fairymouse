// Independent MCP callers, separate hidden desktops, common phase gates.
import {spawn} from 'node:child_process';
import {existsSync,mkdirSync,readFileSync,writeFileSync} from 'node:fs';
import {dirname,join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {pause,startMonitor} from './app_harness.mjs';
const root=dirname(dirname(fileURLToPath(import.meta.url)));
const folder=join(root,'tests','.work','parallel-'+Date.now());
const format=process.argv.includes('--docx')?'docx':'xlsx';
const jobs=[{id:'edge',script:'edge_native_save.mjs',args:[]}];
if(!process.argv.includes('--without-wps'))jobs.unshift({id:'wps',script:'wps_formats.mjs',args:['--format',format]});
if(process.argv.includes('--calculator'))jobs.push({id:'calculator',script:'calculator_apps.mjs',args:[]});
if(process.argv.includes('--paint'))jobs.push({id:'paint',script:'paint_apps.mjs',args:[]});
const report={status:'skipped',validatedAt:new Date().toISOString(),format,
 scope:'Independent MCP caller processes on distinct hidden desktops; tests exercise agent tool contracts, not an LLM benchmark.'};
const running=[];let monitor;
function records(id){const file=join(folder,id+'.jsonl');if(!existsSync(file))return [];return readFileSync(file,'utf8').split('\n').filter(Boolean).map(JSON.parse)}
function abort(){writeFileSync(join(folder,'abort.flag'),'')}
try{
 if(!process.argv.includes('--run')){report.reason='Use --run to operate isolated real application instances'}
 else{
  mkdirSync(folder,{recursive:true});monitor=await startMonitor(join(folder,'monitor'));
  for(const job of jobs){
   const child=spawn(process.execPath,[join(root,'tests',job.script),'--run',...job.args],
    {windowsHide:true,env:{...process.env,FAIRY_TEST_BARRIER:folder,FAIRY_TEST_CALLER:job.id,FAIRY_TEST_REPORT:join(folder,job.id+'-report.json')},stdio:['ignore','pipe','pipe']});
   const run={...job,child,exitCode:null,output:'',error:''};running.push(run);
   child.stdout.on('data',b=>run.output+=b);child.stderr.on('data',b=>run.error+=b);
   child.on('error',error=>{run.error+=error.message;run.exitCode=-1;abort()});
   child.on('exit',code=>{run.exitCode=code??-1});
  }
  for(const stage of ['edit','save']){
   const until=Date.now()+115000;
   while(!jobs.every(job=>existsSync(join(folder,job.id+'.'+stage+'.ready')))){
    monitor.guard();
    if(running.some(run=>run.exitCode!==null))throw new Error('A caller exited before the '+stage+' gate; inspect caller reports');
    if(Date.now()>until)throw new Error('Timed out waiting for '+stage+' phase');
    await pause(25);
   }
   writeFileSync(join(folder,stage+'.go'),'');
  }
  const until=Date.now()+120000;
  while(running.some(run=>run.exitCode===null)){
   monitor.guard();if(Date.now()>until)throw new Error('Caller completion deadline exceeded');await pause(50);
  }
  report.callers=running.map(run=>{
   const trace=records(run.id),desktops=[...new Set(trace.map(r=>r.desktop).filter(Boolean))];
   const file=join(folder,run.id+'-report.json');
   const evidence=existsSync(file)?JSON.parse(readFileSync(file,'utf8')):null;
   return {id:run.id,exitCode:run.exitCode,status:trace.findLast(r=>r.event==='finished')?.status??'unknown',evidence,desktops,
    mutations:trace.filter(r=>r.event==='rpc_end'&&r.mutation).length};
  });
  const intervals=jobs.flatMap(job=>{
   const trace=records(job.id),starts=new Map(trace.filter(r=>r.event==='rpc_start').map(r=>[r.id,r]));
   return trace.filter(r=>r.event==='rpc_end'&&r.mutation&&!r.isError&&starts.has(r.id)).map(r=>({caller:job.id,tool:r.tool,start:starts.get(r.id).at,end:r.at}));
  });
  const overlaps=[];
  for(let a=0;a<intervals.length;a++)for(let b=a+1;b<intervals.length;b++){
   const x=intervals[a],y=intervals[b];const ms=Math.min(x.end,y.end)-Math.max(x.start,y.start);
   if(x.caller!==y.caller&&ms>0)overlaps.push({callers:[x.caller,y.caller],tools:[x.tool,y.tool],overlapMs:ms});
  }
  report.overlappingMutationRequests=overlaps;
  report.callersWithOverlappingMutations=[...new Set(overlaps.flatMap(o=>o.callers))];
  const endpoints=intervals.filter(i=>i.end>i.start).flatMap(i=>[{at:i.start,caller:i.caller,delta:1},{at:i.end,caller:i.caller,delta:-1}]).sort((a,b)=>a.at-b.at||a.delta-b.delta);
  const active=new Map();let peak=0;
  for(let n=0;n<endpoints.length;n++){
   const e=endpoints[n],count=(active.get(e.caller)??0)+e.delta;
   if(count)active.set(e.caller,count);else active.delete(e.caller);
   if(n+1<endpoints.length&&endpoints[n+1].at>e.at&&active.size>peak)peak=active.size;
  }
  report.maximumSimultaneousMutationCallers=peak;
  const allDesktops=report.callers.flatMap(c=>c.desktops);
  report.separateDesktops=allDesktops.length===jobs.length&&new Set(allDesktops).size===jobs.length;
  if(report.callers.some(c=>c.exitCode!==0||c.status!=='passed'))throw new Error('One or more caller tasks did not pass');
  if(!report.separateDesktops)throw new Error('Expected exactly one different desktop per caller');
  if(report.callersWithOverlappingMutations.length!==jobs.length)throw new Error('Not every caller participated in overlapping mutation requests');
  report.status='passed';
 }
}catch(error){report.status='failed';report.reason=error.message;process.exitCode=1;if(existsSync(folder))abort()}
finally{
 // Allow each caller to observe abort and run its own identity-scoped cleanup.
 const until=Date.now()+30000;
 while(running.some(run=>run.exitCode===null)&&Date.now()<until)await pause(100);
 report.unfinishedCallers=running.filter(run=>run.exitCode===null).map(run=>run.id);
 for(const run of running){writeFileSync(join(folder,run.id+'.stdout.log'),run.output);writeFileSync(join(folder,run.id+'.stderr.log'),run.error)}
 if(monitor){try{report.foreground=await monitor.stop();report.interferenceObservationClear=['foregroundChanges','focusChanges','cursorChanges','invalidSamples'].every(k=>report.foreground[k]===0);if(report.status==='passed'&&!report.interferenceObservationClear){report.status='inconclusive';report.reason='Application tasks passed but desktop observations changed; cause is not attributed';process.exitCode=1}}catch(error){report.status='failed';report.monitorError=error.message;process.exitCode=1}}
 mkdirSync(join(root,'reports'),{recursive:true});writeFileSync(join(root,'reports','parallel-apps.json'),JSON.stringify(report,null,2));
 console.log(JSON.stringify(report));
}
