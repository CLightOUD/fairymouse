// CI orchestration only. Logs are bounded and kept outside production code.
import {spawnSync} from 'node:child_process';
import {mkdirSync,writeFileSync,readdirSync,statSync,copyFileSync,existsSync} from 'node:fs';
import {dirname,join} from 'node:path';
import {fileURLToPath} from 'node:url';
const root=dirname(dirname(fileURLToPath(import.meta.url)));
const args=process.argv.slice(2);
if(args[0]!=='--shell'||!args[1]||args.slice(2).some(x=>x!=='--fresh-install'))throw new Error('Usage: ci.mjs --shell <powershell.exe> [--fresh-install]');
const shell=args[1],python=join(root,'runtime','Scripts','python.exe');
const folder=join(root,'tests','.work','ci');mkdirSync(folder,{recursive:true});
const report={status:'running',startedAt:new Date().toISOString(),node:process.version,shell,steps:[],
 scope:'No real user applications, physical input or GUI success claim. Hidden empty-desktop worker tests are included. Resource values are observations, not performance gates.'};
function step(label,command,argv){
 const started=Date.now();
 const result=spawnSync(command,argv,{cwd:root,windowsHide:true,encoding:'utf8',timeout:300000,maxBuffer:8*1024*1024});
 writeFileSync(join(folder,label+'.stdout.log'),result.stdout??'');writeFileSync(join(folder,label+'.stderr.log'),result.stderr??'');
 report.steps.push({name:label,exitCode:result.status,elapsedMs:Date.now()-started,error:result.error?.message});
 console.log(label+': '+(result.status===0?'passed':'FAILED'));
 if(result.status!==0)throw new Error(label+': '+(result.error?.message??result.stderr??result.stdout).slice(-4000));
 return result.stdout;
}
function scripts(dir){return readdirSync(join(root,dir),{withFileTypes:true}).flatMap(e=>e.isDirectory()?(e.name.startsWith('.')||e.name==='__pycache__'?[]:scripts(join(dir,e.name))):/\.(mjs|py)$/.test(e.name)?[join(dir,e.name)]:[])}
try{
 const files=['desktop','hidden','scripts','tests'].flatMap(scripts);
 for(const file of files.filter(p=>p.endsWith('.mjs'))){
  const result=spawnSync(process.execPath,['--check',file],{cwd:root,windowsHide:true,encoding:'utf8',timeout:10000});
  if(result.status!==0)throw new Error('JavaScript syntax: '+file+' '+result.stderr);
 }
 step('python-syntax',python,['-B','-c','import ast,sys;from pathlib import Path;[ast.parse(Path(p).read_text(encoding="utf-8-sig"),filename=p) for p in sys.argv[1:]]',...files.filter(p=>p.endsWith('.py'))]);
 const diagnostic=JSON.parse(step('installation',process.execPath,['scripts/doctor.mjs']));if(!diagnostic.ok)throw new Error('Installation diagnostics failed');
 step('contracts',shell,['-NoProfile','-NonInteractive','-ExecutionPolicy','Bypass','-File','tests/run.ps1','-Headless']);
 step('resources',python,['-B','tests/resource_usage.py','--output',join(folder,'resource-usage.json')]);
 if(args.includes('--fresh-install')){
  const source=join(root,'reports','clean-install.json');const previous=existsSync(source)?statSync(source).mtimeMs:0;
  try{step('clean-install',shell,['-NoProfile','-NonInteractive','-ExecutionPolicy','Bypass','-File','tests/clean_install.ps1','-Run'])}
  finally{if(existsSync(source)&&statSync(source).mtimeMs!==previous)copyFileSync(source,join(folder,'clean-install.json'))}
 }
 report.status='passed';
}catch(error){report.status='failed';report.error=error.message;process.exitCode=1;console.error(error.message)}
finally{report.finishedAt=new Date().toISOString();writeFileSync(join(folder,'summary.json'),JSON.stringify(report,null,2)+'\n');console.log(JSON.stringify(report))}
