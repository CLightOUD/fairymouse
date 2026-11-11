// Read-only local diagnostics. No network, GUI launch, profile access or installs.
import {existsSync,readFileSync} from 'node:fs';
import {createHash} from 'node:crypto';
import {execFileSync} from 'node:child_process';
import {dirname,join} from 'node:path';
import {fileURLToPath} from 'node:url';

const root=dirname(dirname(fileURLToPath(import.meta.url)));
const checks=[];
const add=(name,ok,detail)=>checks.push({name,ok,detail});
add('platform',process.platform==='win32',process.platform);
add('node',true,process.version);
const executable=join(root,'desktop','agent-desktop.exe');
try{
 const source=readFileSync(join(root,'licenses','THIRD_PARTY.md'),'utf8');
 const expected=source.match(/SHA256[^`]*`([A-Fa-f0-9]{64})`/)?.[1]?.toLowerCase();
 const actual=createHash('sha256').update(readFileSync(executable)).digest('hex');
 add('patched_native_sha256',Boolean(expected)&&actual===expected,actual);
}catch(error){add('patched_native_sha256',false,error.message)}
for(const relative of ['hidden/server.py','hidden/vendor/winio.py','hidden/recovery.py','hidden/controls.py','hidden/semantic.py','runtime/Scripts/pythonw.exe','requirements.lock'])
 add(relative,existsSync(join(root,relative)),relative);
try{
 const python=join(root,'runtime','Scripts','python.exe');
 const result=JSON.parse(execFileSync(python,['-B','-c',
  "import json,sys;from importlib.metadata import version;print(json.dumps({'python':sys.version.split()[0],'mcp':version('mcp'),'pillow':version('pillow')}))"],
  {windowsHide:true,encoding:'utf8',timeout:10000}));
 const requirements=readFileSync(join(root,'requirements.in'),'utf8');
 for(const dependency of ['mcp','pillow']){
  const expected=requirements.match(new RegExp(`^${dependency}==([^\\r\\n]+)`,'m'))?.[1];
  add(dependency,result[dependency]===expected,{installed:result[dependency],expected});
 }
 add('python',result.python==='3.12.13',result.python);
}catch(error){add('python_runtime',false,error.message)}
const ok=checks.every(check=>check.ok);
console.log(JSON.stringify({ok,checks,scope:'Installation checks only; app compatibility and foreground interference are not tested.'},null,2));
process.exitCode=ok?0:1;
