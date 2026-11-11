import {spawn} from 'node:child_process';
import {createInterface} from 'node:readline';
import {dirname,join} from 'node:path';
import {fileURLToPath} from 'node:url';
const dir=dirname(fileURLToPath(import.meta.url));
const allowed=new Set(['snapshot','find','get','is','screenshot','list_surfaces','list_displays','list_apps','list_windows','click','set_value','clear','select','toggle','check','uncheck','expand','collapse','scroll','scroll_to','wait','status','version','skills_list','skills_get'].map(x=>'desktop_'+x));
const child=spawn(join(dir,'agent-desktop.exe'),['mcp'],{windowsHide:true,stdio:['pipe','pipe','pipe'],env:{...process.env,AGENT_DESKTOP_HOME:join(dir,'state')}});
const requests=new Map();
const send=m=>process.stdout.write(JSON.stringify(m)+'\n');
createInterface({input:process.stdin}).on('line',line=>{
 let m;
 try{m=JSON.parse(line)}catch{send({jsonrpc:'2.0',id:null,error:{code:-32700,message:'Invalid JSON'}});return}
 if(m.method==='tools/call'&&!allowed.has(m.params?.name)){
  send({jsonrpc:'2.0',id:m.id,result:{isError:true,content:[{type:'text',text:'This background-only endpoint does not expose physical input, focus, restore, launch, batch, or clipboard mutations. Use an isolated desktop for those operations.'}]}});return;
 }
 if(m.id!==undefined) requests.set(JSON.stringify(m.id),m.method);
 child.stdin.write(JSON.stringify(m)+'\n');
}).on('close',()=>child.stdin.end());
createInterface({input:child.stdout}).on('line',line=>{
 let m;try{m=JSON.parse(line)}catch{process.stderr.write('Invalid backend output\n');return}
 const key=JSON.stringify(m.id);const method=requests.get(key);
 if(m.id!==undefined) requests.delete(key);
 if(method==='tools/list'&&m.result?.tools) m.result.tools=m.result.tools.filter(t=>allowed.has(t.name));
 if(method==='initialize'&&m.result){
  m.result.serverInfo={...m.result.serverInfo,name:'fairy-desktop-background',version:'1.2.0-local-autofocus-fix'};
  m.result.instructions='Patched Windows agent-desktop with UIA AutoSetFocus disabled. This endpoint only exposes background semantic actions. Read desktop_skills_get for desktop and platform guidance. Keep the target restored but behind the user window; never activate it. Some applications can activate themselves, so verify effects and stop on observed interference. Physical input and window activation are unavailable here. '+(m.result.instructions??'');
 }
 send(m);
});
child.stderr.on('data',b=>process.stderr.write(b));
child.on('error',e=>{process.stderr.write(e.message+'\n');process.exitCode=1});
child.on('exit',code=>{process.exit(code??1)});
for(const signal of ['SIGTERM','SIGINT'])process.on(signal,()=>{child.kill();process.exit(0)});
