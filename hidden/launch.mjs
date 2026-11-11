import {spawn} from 'node:child_process';
import {dirname,join} from 'node:path';
import {fileURLToPath} from 'node:url';
const dir=dirname(fileURLToPath(import.meta.url));
const child=spawn(join(dir,'..','runtime','Scripts','python.exe'),['-u',join(dir,'server.py')],{
  windowsHide:true,stdio:['pipe','pipe','pipe'],cwd:dir,
  env:{...process.env,PYTHONUTF8:'1',PYTHONDONTWRITEBYTECODE:'1'},
});
process.stdin.pipe(child.stdin);
child.stdout.pipe(process.stdout);
child.stderr.pipe(process.stderr);
child.on('error',error=>{process.stderr.write(error.message+'\n');process.exitCode=1});
child.on('exit',code=>process.exit(code??1));
for(const signal of ['SIGTERM','SIGINT'])process.on(signal,()=>{child.kill();process.exit(0)});
