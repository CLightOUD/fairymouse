// Test-only coordination and observation; never sends desktop input.
import {spawn} from 'node:child_process';
import {appendFileSync,existsSync,mkdirSync,readFileSync,writeFileSync} from 'node:fs';
import {dirname,join,resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
const root=dirname(dirname(fileURLToPath(import.meta.url)));
export const pause=ms=>new Promise(r=>setTimeout(r,ms));
export function reportPath(filename){return process.env.FAIRY_TEST_REPORT??join(root,'reports',filename)}
const coordination=process.env.FAIRY_TEST_BARRIER;
const caller=process.env.FAIRY_TEST_CALLER??`caller-${process.pid}`;
if(!/^[a-zA-Z0-9_-]{1,60}$/.test(caller))throw new Error('Invalid test caller');
let sequence=0;
let localTrace;
function event(value){
 const path=coordination?join(coordination,caller+'.jsonl'):localTrace;
 if(path)appendFileSync(path,JSON.stringify({caller,pid:process.pid,at:Date.now(),...value})+'\n');
}
export async function checkpoint(stage){
 if(!coordination)return;
 if(!['edit','save'].includes(stage))throw new Error('Unknown coordinated test stage');
 event({event:'ready',stage});
 writeFileSync(join(coordination,caller+'.'+stage+'.ready'),'');
 const until=Date.now()+120000;
 while(!existsSync(join(coordination,stage+'.go'))){
  if(existsSync(join(coordination,'abort.flag')))throw new Error('Parallel test aborted; clean up own application');
  if(Date.now()>until)throw new Error('Parallel stage timed out; clean up own application');
  await pause(25);
 }
 event({event:'released',stage});
}
export function traceRpc(rpc){
 return async (method,params={})=>{
  const id=++sequence,tool=params.name,action=params.arguments?.action;
  const mutation=method==='tools/call'&&(['hidden_click','hidden_type_text','hidden_keys','hidden_set_text','hidden_act'].includes(tool)||(tool==='hidden_semantic'&&action&&action!=='snapshot'));
  const details={id,tool,action,desktop:params.arguments?.name,mutation};
  event({event:'rpc_start',...details});
  try{const result=await rpc(method,params);event({event:'rpc_end',...details,isError:!!result?.isError});return result}
  catch(error){event({event:'rpc_end',...details,isError:true});throw error}
 };
}
export function finishTrace(status){event({event:'finished',status})}

export async function startMonitor(folder){
 folder=resolve(folder);mkdirSync(folder,{recursive:true});
 localTrace=join(folder,'rpc-events.jsonl');
 const code=`import ctypes,json,time,sys,pathlib
from ctypes import wintypes
u=ctypes.WinDLL('user32',use_last_error=True)
u.GetForegroundWindow.restype=wintypes.HWND
class Info(ctypes.Structure):
 _fields_=[('cbSize',wintypes.DWORD),('flags',wintypes.DWORD),('hwndActive',wintypes.HWND),('hwndFocus',wintypes.HWND),('hwndCapture',wintypes.HWND),('hwndMenuOwner',wintypes.HWND),('hwndMoveSize',wintypes.HWND),('hwndCaret',wintypes.HWND),('rcCaret',wintypes.RECT)]
u.GetGUIThreadInfo.argtypes=[wintypes.DWORD,ctypes.POINTER(Info)]
f=pathlib.Path(sys.argv[1]);baseline=None;previous=None;events=[];count=fgChanges=focusChanges=cursorChanges=invalid=0;maxgap=0;last=time.monotonic()
while not (f/'monitor.stop').exists():
 now=time.monotonic();maxgap=max(maxgap,now-last);last=now
 fg=int(u.GetForegroundWindow() or 0);p=wintypes.POINT();info=Info();info.cbSize=ctypes.sizeof(info)
 valid=bool(u.GetCursorPos(ctypes.byref(p)) and u.GetGUIThreadInfo(0,ctypes.byref(info)) and fg)
 current=(fg,int(info.hwndFocus or 0),p.x,p.y)
 if baseline is None:
  if not valid: raise RuntimeError('Visible desktop foreground/focus unavailable')
  baseline=current;(f/'monitor.ready').write_text('ready')
 if previous is not None and current!=previous and len(events)<64:
  events.append({'at':round(time.time()*1000),'foreground':current[0]!=previous[0],'focus':current[1]!=previous[1],'cursor':current[2:]!=previous[2:]})
 previous=current
 invalid+=not valid
 fgChanges+=current[0]!=baseline[0];focusChanges+=current[1]!=baseline[1];cursorChanges+=current[2:]!=baseline[2:]
 if not valid or current[:2]!=baseline[:2]:(f/'monitor.interference').write_text('foreground/focus observation changed')
 count+=1;time.sleep(.02)
(f/'monitor.json').write_text(json.dumps({'samples':count,'foregroundChanges':fgChanges,'focusChanges':focusChanges,'cursorChanges':cursorChanges,'invalidSamples':invalid,'maximumSampleGapMs':round(maxgap*1000,2),'changeEvents':events,'scope':'20 ms sampling; changes may be user activity; cannot exclude changes between samples'}))
`;
 const child=spawn(join(root,'runtime','Scripts','python.exe'),['-B','-c',code,folder],{windowsHide:true,stdio:['ignore','ignore','pipe']});
 let error='';child.stderr.on('data',b=>error+=b);
 for(let i=0;i<150&&!existsSync(join(folder,'monitor.ready'))&&child.exitCode===null;i++)await pause(20);
 if(!existsSync(join(folder,'monitor.ready'))){child.kill();throw new Error('Foreground monitor unavailable: '+error)}
 return {
  guard(){if(coordination&&existsSync(join(coordination,'abort.flag')))throw new Error('Parallel test aborted; clean up own application');if(existsSync(join(folder,'monitor.interference')))throw new Error('Foreground/focus changed; stopping new UI actions (cause not attributed)')},
  async stop(){
   writeFileSync(join(folder,'monitor.stop'),'');
   await new Promise(resolve=>{if(child.exitCode!==null)return resolve();child.once('exit',resolve);setTimeout(resolve,2000).unref()});
   if(child.exitCode===null){child.kill();throw new Error('Monitor did not exit')}
   if(!existsSync(join(folder,'monitor.json')))throw new Error('Monitor result unavailable: '+error);
   return JSON.parse(readFileSync(join(folder,'monitor.json'),'utf8'));
  }
 };
}
