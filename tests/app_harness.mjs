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
let currentMonitor;
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
  try{const result=await rpc(method,params);event({event:'rpc_end',...details,isError:!!result?.isError});
   if(currentMonitor?.mode==='coexist'&&!result?.isError){
    const data=result?.structuredContent?.result??result?.structuredContent?.data??result?.structuredContent;
    try{
     if(tool==='hidden_launch'&&data?.pid)await currentMonitor.registerProcess(data.pid,{optionalLauncher:true});
     if(tool==='hidden_windows'&&Array.isArray(data))for(const pid of new Set(data.map(w=>w.process_id).filter(Boolean)))await currentMonitor.registerProcess(pid);
    }catch(error){event({event:'registration_failed',message:error.message})}
   }
   return result}
  catch(error){event({event:'rpc_end',...details,isError:true});throw error}
 };
}
export function finishTrace(status){event({event:'finished',status})}

export function assessCoexistence(value){
 const complete=value?.mode==='coexist'&&value.samples>0&&value.registeredProcesses>0&&value.invalidSamples===0&&value.registrationFailures===0&&value.ancestryErrors===0&&(value.unresolvedLaunchProcesses??0)===0;
 const violation=(value?.targetForegroundSamples??0)>0||(value?.targetFocusSamples??0)>0||(value?.inputDesktopChanges??0)>0;
 return {status:violation?'failed':complete?'observed_clear':'inconclusive',userActivityObserved:(value?.foregroundChanges??0)>0||(value?.focusChanges??0)>0||(value?.cursorChanges??0)>0,
  scope:'Sampled registered process identities and observed descendants only; activity is not attributed to a human and sub-sample interference cannot be excluded.'};
}

export async function startMonitor(folder,{mode=process.env.FAIRY_TEST_MONITOR_MODE??'strict',registryFolder}={}){
 if(!['strict','coexist'].includes(mode))throw new Error('Unknown monitor mode');
 if(mode==='coexist')return currentMonitor=await startCoexistMonitor(folder,registryFolder);
 currentMonitor=undefined;
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

async function startCoexistMonitor(folder,registryFolder){
 folder=resolve(folder);mkdirSync(folder,{recursive:true});localTrace=join(folder,'rpc-events.jsonl');
 const registry=registryFolder?resolve(registryFolder):coordination?join(coordination,'monitor-targets'):join(folder,'targets');mkdirSync(registry,{recursive:true});
 const requests=join(folder,'register.jsonl');writeFileSync(requests,'');
 const code=String.raw`import ctypes,json,time,sys,pathlib
from ctypes import wintypes as W
u=ctypes.WinDLL('user32',use_last_error=True);k=ctypes.WinDLL('kernel32',use_last_error=True)
u.GetForegroundWindow.restype=W.HWND
u.GetWindowThreadProcessId.argtypes=[W.HWND,ctypes.POINTER(W.DWORD)]
u.OpenInputDesktop.argtypes=[W.DWORD,W.BOOL,W.DWORD];u.OpenInputDesktop.restype=W.HANDLE
u.CloseDesktop.argtypes=[W.HANDLE]
u.GetUserObjectInformationW.argtypes=[W.HANDLE,ctypes.c_int,ctypes.c_void_p,W.DWORD,ctypes.POINTER(W.DWORD)]
k.OpenProcess.argtypes=[W.DWORD,W.BOOL,W.DWORD];k.OpenProcess.restype=W.HANDLE
k.CloseHandle.argtypes=[W.HANDLE]
k.GetProcessTimes.argtypes=[W.HANDLE,ctypes.POINTER(W.FILETIME),ctypes.POINTER(W.FILETIME),ctypes.POINTER(W.FILETIME),ctypes.POINTER(W.FILETIME)]
k.CreateToolhelp32Snapshot.argtypes=[W.DWORD,W.DWORD];k.CreateToolhelp32Snapshot.restype=W.HANDLE
class PE(ctypes.Structure):
 _fields_=[('size',W.DWORD),('usage',W.DWORD),('pid',W.DWORD),('heap',ctypes.c_size_t),('module',W.DWORD),('threads',W.DWORD),('parent',W.DWORD),('priority',W.LONG),('flags',W.DWORD),('exe',W.WCHAR*260)]
k.Process32FirstW.argtypes=[W.HANDLE,ctypes.POINTER(PE)];k.Process32NextW.argtypes=[W.HANDLE,ctypes.POINTER(PE)]
class Info(ctypes.Structure):
 _fields_=[('cbSize',W.DWORD),('flags',W.DWORD),('hwndActive',W.HWND),('hwndFocus',W.HWND),('hwndCapture',W.HWND),('hwndMenuOwner',W.HWND),('hwndMoveSize',W.HWND),('hwndCaret',W.HWND),('rcCaret',W.RECT)]
u.GetGUIThreadInfo.argtypes=[W.DWORD,ctypes.POINTER(Info)]
def identity(pid):
 if not pid:return None
 h=k.OpenProcess(0x1000,False,pid)
 if not h:return None
 try:
  a,b,c,d=W.FILETIME(),W.FILETIME(),W.FILETIME(),W.FILETIME()
  return str(pid)+':'+str((a.dwHighDateTime<<32)|a.dwLowDateTime) if k.GetProcessTimes(h,ctypes.byref(a),ctypes.byref(b),ctypes.byref(c),ctypes.byref(d)) else None
 finally:k.CloseHandle(h)
def window_identity(hwnd):
 pid=W.DWORD();u.GetWindowThreadProcessId(hwnd,ctypes.byref(pid));return identity(pid.value)
def desktop():
 h=u.OpenInputDesktop(0,False,1)
 if not h:return None
 try:
  name=ctypes.create_unicode_buffer(256);needed=W.DWORD()
  return name.value if u.GetUserObjectInformationW(h,2,name,ctypes.sizeof(name),ctypes.byref(needed)) else None
 finally:u.CloseDesktop(h)
f=pathlib.Path(sys.argv[1]);registry=pathlib.Path(sys.argv[2]);graph={};known={};roots=set();handled=set();errors=0;ancestry_errors=0;unresolved_launches=0;events=[];fg_seen={};focus_seen={}
count=fg_changes=focus_changes=cursor_changes=invalid=desktop_changes=0;baseline=previous=None;maxgap=0;last=time.monotonic();scanned=0;registered_before_start=0
def process_tree():
 global ancestry_errors
 h=k.CreateToolhelp32Snapshot(2,0)
 if h==ctypes.c_void_p(-1).value:ancestry_errors+=1;return
 try:
  p=PE();p.size=ctypes.sizeof(p);ok=k.Process32FirstW(h,ctypes.byref(p));rows=[]
  if not ok:ancestry_errors+=1
  while ok:
   rows.append((p.pid,p.parent));ok=k.Process32NextW(h,ctypes.byref(p))
  live={pid:identity(pid) for pid,parent in rows}
  for pid,parent in rows:
   key=live.get(pid)
   if key:
    known.setdefault(pid,set()).add(key);parent_key=live.get(parent)
    if parent_key and int(key.split(':')[1])>=int(parent_key.split(':')[1]):graph[key]=parent_key
 finally:k.CloseHandle(h)
while not (f/'monitor.stop').exists():
 now=time.monotonic();maxgap=max(maxgap,now-last);last=now
 if now-scanned>.2:process_tree();scanned=now
 for line in (f/'register.jsonl').read_text().splitlines():
  try:request=json.loads(line)
  except json.JSONDecodeError:continue
  if request['id'] in handled:continue
  handled.add(request['id']);pid=request['pid'];key=identity(pid);past=known.get(pid,set())
  if not key and len(past)==1:key=next(iter(past))
  answer={'pid':pid,'identity':key}
  if not key:
   if request.get('optionalLauncher'):unresolved_launches+=1;answer['warning']='Short-lived launch identity unavailable; launch coverage remains incomplete'
   else:errors+=1;answer['error']='Process identity unavailable; registration coverage incomplete'
  else:
   roots.add(key);(registry/(str(sys.argv[3])+'-'+str(request['id'])+'.json')).write_text(json.dumps({'identity':key}))
  (f/('registered-'+str(request['id'])+'.json')).write_text(json.dumps(answer))
 for entry in registry.glob('*.json'):
  try:roots.add(json.loads(entry.read_text())['identity'])
  except (OSError,json.JSONDecodeError,KeyError):continue
 targets=set(roots)
 for _ in range(32):
  extra={key for key,parent in graph.items() if parent in targets}-targets
  if not extra:break
  targets.update(extra)
 fg=int(u.GetForegroundWindow() or 0);p=W.POINT();info=Info();info.cbSize=ctypes.sizeof(info);desk=desktop()
 valid=bool(u.GetCursorPos(ctypes.byref(p)) and u.GetGUIThreadInfo(0,ctypes.byref(info)) and fg and desk)
 focus=int(info.hwndFocus or 0);fg_key=window_identity(fg);focus_key=window_identity(focus) if focus else None
 for key in [fg_key,focus_key]:
  if key:known.setdefault(int(key.split(':')[0]),set()).add(key)
 valid=bool(valid and fg_key and (not focus or focus_key))
 current=(fg,focus,p.x,p.y,desk)
 if baseline is None:
  if not valid:raise RuntimeError('Visible desktop foreground/focus/process identity unavailable')
  baseline=current;(f/'monitor.ready').write_text('ready')
 if previous is not None and current!=previous and len(events)<64:events.append({'at':round(time.time()*1000),'foreground':current[0]!=previous[0],'focus':current[1]!=previous[1],'cursor':current[2:4]!=previous[2:4],'inputDesktop':current[4]!=previous[4]})
 previous=current;invalid+=not valid;fg_changes+=fg!=baseline[0];focus_changes+=focus!=baseline[1];cursor_changes+=current[2:4]!=baseline[2:4];desktop_changes+=desk!=baseline[4]
 if fg_key:fg_seen[fg_key]=fg_seen.get(fg_key,0)+1
 if focus_key:focus_seen[focus_key]=focus_seen.get(focus_key,0)+1
 target_fg=sum(n for key,n in fg_seen.items() if key in targets);target_focus=sum(n for key,n in focus_seen.items() if key in targets)
 if not valid or errors or ancestry_errors or target_fg or target_focus or desktop_changes:(f/'monitor.interference').write_text('Registered process foreground/focus, input desktop change, or incomplete observation')
 count+=1;time.sleep(.02)
(f/'monitor.json').write_text(json.dumps({'mode':'coexist','samples':count,'registeredProcesses':len(roots),'observedDescendants':len(targets-roots),'registrationFailures':errors,'unresolvedLaunchProcesses':unresolved_launches,'ancestryErrors':ancestry_errors,'targetForegroundSamples':target_fg,'targetFocusSamples':target_focus,'inputDesktopChanges':desktop_changes,'foregroundChanges':fg_changes,'focusChanges':focus_changes,'cursorChanges':cursor_changes,'invalidSamples':invalid,'maximumSampleGapMs':round(maxgap*1000,2),'changeEvents':events,'scope':'Read-only sampling; registered PID creation-time identities and sampled descendants. Previous samples are checked when targets register. Activity is not attributed to a human. Processes that start and exit between ancestry samples may be missed; pre-monitor launches and sub-sample interference are outside coverage.'}))
`;
 const child=spawn(join(root,'runtime','Scripts','python.exe'),['-B','-c',code,folder,registry,String(process.pid)],{windowsHide:true,stdio:['ignore','ignore','pipe']});
 let error='',spawnError;child.stderr.on('data',b=>error+=b);child.on('error',e=>spawnError=e);
 for(let i=0;i<200&&!existsSync(join(folder,'monitor.ready'))&&child.exitCode===null&&!spawnError;i++)await pause(20);
 if(!existsSync(join(folder,'monitor.ready'))){child.kill();throw new Error('Coexist monitor unavailable: '+(spawnError?.message??error))}
 let registration=0;
 return {mode:'coexist',
  async registerProcess(pid,{optionalLauncher=false}={}){
   if(!Number.isSafeInteger(pid)||pid<=0)throw new Error('Expected positive process ID');
   const id=++registration;appendFileSync(requests,JSON.stringify({id,pid,optionalLauncher})+'\n');
   const ack=join(folder,'registered-'+id+'.json');
   for(let i=0;i<100&&!existsSync(ack)&&child.exitCode===null;i++)await pause(20);
   if(!existsSync(ack))throw new Error('Process registration not acknowledged');
   let answer;for(let i=0;i<20;i++){try{answer=JSON.parse(readFileSync(ack,'utf8'));break}catch{await pause(10)}}
   if(!answer||answer.error)throw new Error(answer?.error??'Process registration result incomplete');
   return answer;
  },
  guard(){if(spawnError||child.exitCode!==null)throw new Error('Coexist monitor stopped: '+(spawnError?.message??error));if(coordination&&existsSync(join(coordination,'abort.flag')))throw new Error('Parallel test aborted');if(existsSync(join(folder,'monitor.interference')))throw new Error('Coexist monitor found interference or incomplete observation; stop new actions')},
  async stop(){writeFileSync(join(folder,'monitor.stop'),'');await new Promise(resolve=>{if(child.exitCode!==null)return resolve();child.once('exit',resolve);setTimeout(resolve,3000).unref()});if(child.exitCode===null){child.kill();throw new Error('Coexist monitor did not exit')}if(!existsSync(join(folder,'monitor.json')))throw new Error('Coexist report unavailable: '+error);const report=JSON.parse(readFileSync(join(folder,'monitor.json'),'utf8'));report.assessment=assessCoexistence(report);return report}
 };
}
