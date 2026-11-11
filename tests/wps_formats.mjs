// Isolated WPS feasibility/regression. No existing WPS instance is ever modified.
import {spawn,execFileSync} from 'node:child_process';
import {createInterface} from 'node:readline';
import {dirname,join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {existsSync,mkdirSync,readFileSync,writeFileSync} from 'node:fs';
const root=dirname(dirname(fileURLToPath(import.meta.url)));
const pause=ms=>new Promise(r=>setTimeout(r,ms));
const flatten=node=>[node,...(node.children??[]).flatMap(flatten)];
function ps(code){return execFileSync('powershell',['-NoProfile','-Command',code],{windowsHide:true,encoding:'utf8',timeout:10000}).trim()}
const quote=value=>"'"+String(value).replaceAll("'","''")+"'";
function ownedTree(pids,since,executable){
 const code=`$all=@(Get-CimInstance Win32_Process);$ids=@(${[pids].flat().join(',')});do{$before=$ids.Count;foreach($p in $all){if($p.ParentProcessId -in $ids -and $p.ProcessId -notin $ids){$ids+= $p.ProcessId}}}while($ids.Count -gt $before);@($all | Where-Object { $_.ProcessId -in $ids -and $_.CreationDate -and $_.ExecutablePath -and $_.CreationDate.ToUniversalTime() -ge ([datetimeoffset]${quote(since)}).UtcDateTime -and $_.ExecutablePath.StartsWith(${quote(dirname(executable)+'\\')},[StringComparison]::OrdinalIgnoreCase) } | ForEach-Object { @{id=$_.ProcessId;parent=$_.ParentProcessId;created=$_.CreationDate.ToUniversalTime().ToString('o');path=$_.ExecutablePath} }) | ConvertTo-Json -Compress`;
 const result=ps(code);return result?[JSON.parse(result)].flat():[];
}
function cleanOwned(processes){
 const identities=[...new Map(processes.map(p=>[p.id,p])).values()].sort((a,b)=>a.created.localeCompare(b.created));
 ps(`$owned=ConvertFrom-Json ${quote(JSON.stringify(identities))};foreach($item in $owned){$p=Get-CimInstance Win32_Process -Filter ('ProcessId='+$item.id);if($p -and $p.CreationDate -and $p.ExecutablePath -eq $item.path -and $p.CreationDate.ToUniversalTime().ToString('o') -eq $item.created){Stop-Process -Id $item.id -ErrorAction Stop}}`);
}
function client(monitor,folder){let cleanup=false;
 const child=spawn(process.execPath,[join(root,'hidden','launch.mjs')],{windowsHide:true,stdio:['pipe','pipe','pipe']});
 const pending=new Map();let seq=0;
 createInterface({input:child.stdout}).on('line',line=>{
  const response=JSON.parse(line),request=pending.get(response.id);
  if(request){clearTimeout(request.timer);pending.delete(response.id);response.error?request.reject(new Error(JSON.stringify(response.error))):request.resolve(response.result)}
 });
 child.stderr.on('data',b=>process.stderr.write(b));
 const fail=()=>{for(const request of pending.values()){clearTimeout(request.timer);request.reject(new Error('MCP exited'))}pending.clear()};
 child.on('exit',fail);child.on('error',fail);
 const requestRpc=(method,params={})=>new Promise((resolve,reject)=>{
  const id=++seq,timer=setTimeout(()=>{pending.delete(id);reject(new Error('MCP timeout'))},20000);
  pending.set(id,{resolve,reject,timer});child.stdin.write(JSON.stringify({jsonrpc:'2.0',id,method,params})+'\n');
 });
 const rpc=traceRpc(requestRpc);
 return {rpc,cleanup(){cleanup=true},async call(tool,args){if(!cleanup&&(['hidden_launch','hidden_click','hidden_type_text','hidden_keys','hidden_set_text'].includes(tool)||(tool==='hidden_semantic'&&args.action!=='snapshot')))monitor.guard();const r=await rpc('tools/call',{name:tool,arguments:args});if(r.isError){writeFileSync(join(folder,'native-error.json'),JSON.stringify({tool,args,result:r},null,2));throw new Error(tool+': '+(r.structuredContent?.code??'MCP_ERROR'));}return r.structuredContent?.result??r.structuredContent?.data??r.structuredContent},async init(){await rpc('initialize',{protocolVersion:'2025-11-25',capabilities:{},clientInfo:{name:'fairymouse-real-app-regression',version:'1'}});child.stdin.write(JSON.stringify({jsonrpc:'2.0',method:'notifications/initialized'})+'\n')},close(){child.stdin.end()}};
}
const python=join(root,'runtime','Scripts','python.exe');
import {checkpoint,traceRpc,finishTrace,startMonitor,reportPath} from './app_harness.mjs';
function fixture(file,format){
 const code=`import sys,zipfile
p,kind=sys.argv[1:]
ct='http://schemas.openxmlformats.org/package/2006/content-types'
rels='http://schemas.openxmlformats.org/package/2006/relationships'
office='http://schemas.openxmlformats.org/officeDocument/2006/relationships/'
parts={}
if kind=='docx':
 parts['[Content_Types].xml']=f'<Types xmlns="{ct}"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>'
 parts['_rels/.rels']=f'<Relationships xmlns="{rels}"><Relationship Id="rId1" Type="{office}officeDocument" Target="word/document.xml"/></Relationships>'
 parts['word/document.xml']='<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body><w:p><w:r><w:t>Fairymouse DOCX original</w:t></w:r></w:p><w:sectPr/></w:body></w:document>'
else:
 ns='http://schemas.openxmlformats.org/spreadsheetml/2006/main'
 parts['[Content_Types].xml']=f'<Types xmlns="{ct}"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/><Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/></Types>'
 parts['_rels/.rels']=f'<Relationships xmlns="{rels}"><Relationship Id="rId1" Type="{office}officeDocument" Target="xl/workbook.xml"/></Relationships>'
 parts['xl/workbook.xml']=f'<workbook xmlns="{ns}" xmlns:r="{office[:-1]}"><sheets><sheet name="Budget" sheetId="1" r:id="rId1"/></sheets><calcPr calcId="191029" fullCalcOnLoad="1"/></workbook>'
 parts['xl/_rels/workbook.xml.rels']=f'<Relationships xmlns="{rels}"><Relationship Id="rId1" Type="{office}worksheet" Target="worksheets/sheet1.xml"/></Relationships>'
 parts['xl/worksheets/sheet1.xml']=f'<worksheet xmlns="{ns}"><sheetViews><sheetView workbookViewId="0"><selection activeCell="A1" sqref="A1"/></sheetView></sheetViews><sheetData><row r="1"><c r="A1" t="inlineStr"><is><t>Fairymouse XLSX original</t></is></c></row><row r="2"><c r="A2"><v>2</v></c><c r="B2"><v>3</v></c><c r="C2"><f>A2*B2</f><v>6</v></c></row></sheetData></worksheet>'
with zipfile.ZipFile(p,'w',zipfile.ZIP_DEFLATED) as z:
 for name,text in parts.items():z.writestr(name,'<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'+text)
`;
 execFileSync(python,['-B','-c',code,file,format],{windowsHide:true,timeout:10000});
}
function readback(file,format,marker){
 const code=`import sys,zipfile,json,xml.etree.ElementTree as E
p,kind,marker=sys.argv[1:]
with zipfile.ZipFile(p) as z:
 if kind=='docx':
  tree=E.fromstring(z.read('word/document.xml'));text=''.join(n.text or '' for n in tree.iter() if n.tag.endswith('}t'));print(json.dumps({'markerPresent':marker in text,'originalPreserved':'Fairymouse DOCX original' in text}))
 else:
  ns={'s':'http://schemas.openxmlformats.org/spreadsheetml/2006/main'};shared=[]
  if 'xl/sharedStrings.xml' in z.namelist():shared=[''.join(n.itertext()) for n in E.fromstring(z.read('xl/sharedStrings.xml'))]
  cells={}
  for c in E.fromstring(z.read('xl/worksheets/sheet1.xml')).findall('.//s:c',ns):
   v=c.find('s:v',ns);f=c.find('s:f',ns);value=v.text if v is not None else ''.join(c.itertext())
   if c.get('t')=='s':value=shared[int(value)]
   cells[c.get('r')]={'value':value,'formula':f.text if f is not None else None}
  print(json.dumps({'cells':cells,'markerPresent':any(marker in str(c['value']) for c in cells.values())}))
`;
 return JSON.parse(execFileSync(python,['-B','-c',code,file,format,marker],{windowsHide:true,encoding:'utf8',timeout:10000}));
}
async function capture(server,name,hwnd,file){
 const shot=await server.rpc('tools/call',{name:'hidden_screenshot',arguments:{name,hwnd,max_size:1400}});
 const image=shot.content?.find(c=>c.type==='image');if(image)writeFileSync(file,Buffer.from(image.data,'base64'));
}
function matchesExpected(data,format,marker){
 if(format==='docx')return data.markerPresent&&data.originalPreserved;
 const c=data.cells;
 return c.A1?.value==='Fairymouse XLSX original'+marker&&c.A2?.value==='7'&&c.B2?.value==='6'&&c.C2?.formula==='SUM(A2:B2)*2'&&c.C2?.value==='26';
}
async function runFormat(format){
 const report={format,status:'skipped',validatedAt:new Date().toISOString()};
 const running=JSON.parse(ps("@(Get-Process -Name wps,et,wpp,wpscloudsvr -ErrorAction SilentlyContinue|Select-Object -ExpandProperty Id)|ConvertTo-Json -Compress")||'[]');
 if([running].flat().length){report.reason='Existing WPS process detected; no launch attempted';return report;}
 const writer=ps("$k='HKLM:/SOFTWARE/Microsoft/Windows/CurrentVersion/App Paths/wps.exe';if(Test-Path $k){(Get-Item $k).GetValue('')}");
 const executable=format==='xlsx'?join(dirname(writer),'et.exe'):writer;
 if(!existsSync(executable)){report.reason='WPS executable unavailable';return report;}
 report.version=ps(`(Get-Item -LiteralPath ${quote(executable)}).VersionInfo.FileVersion`);
 const folder=join(root,'tests','.work',`wps-${format}-${Date.now()}`);mkdirSync(folder,{recursive:true});
 const filename=`Fairymouse-${process.pid}.${format}`,file=join(folder,filename),marker=`Fairymouse${format.toUpperCase()}${process.pid}`;
 fixture(file,format);const before=readback(file,format,marker);
 if(before.markerPresent)throw new Error('Invalid seeded marker');
 const monitor=await startMonitor(folder),server=client(monitor,folder),name=`FairyHidden-${format}-${process.pid}`;let created=false,pid,owned=[];
 try{
  await server.init();await server.call('hidden_create',{name});created=true;
  const launch=await server.call('hidden_launch',{name,executable,arguments:[file],wait_ms:5000});pid=launch.pid;await pause(5000);
  const windows=await server.call('hidden_windows',{name});owned=ownedTree([pid,...windows.map(w=>w.process_id)],report.validatedAt,executable);
  writeFileSync(join(folder,'windows.json'),JSON.stringify(windows));
  const ownedIds=new Set(owned.map(p=>p.id));
  const top=windows.find(w=>ownedIds.has(w.process_id)&&(w.title??'').includes(filename));
  if(!top)throw new Error('No verified test-owned document window on hidden desktop');
  report.hiddenWindowVerified=true;
  const controls=await server.call('hidden_controls',{name,hwnd:top.handle});report.controlClasses=[...new Set(controls.map(c=>c.class))];
  const snapshot=await server.call('hidden_semantic',{name,hwnd:top.handle,action:'snapshot'});
  writeFileSync(join(folder,'initial.json'),JSON.stringify({controls,snapshot},null,2));
  await checkpoint('edit');
  if(format==='docx'){
   const canvases=controls.filter(c=>c.class==='_WwG'&&c.text==='DocView');
   if(canvases.length!==1)throw new Error('No unique observed document canvas');
   const c=canvases[0];await server.call('hidden_click',{name,hwnd:c.handle,x:Math.floor(c.width/2),y:Math.floor(c.height/2)});
   await server.call('hidden_type_text',{name,hwnd:c.handle,text:marker});await pause(500);
  }else{
   const snap=()=>server.call('hidden_semantic',{name,hwnd:top.handle,action:'snapshot'});
   const field=(tree,label)=>{
    const group=flatten(tree).find(n=>n.name===label);
    const found=group?flatten(group).filter(n=>n.role==='textfield'):[];
    if(found.length!==1)throw new Error('No unique spreadsheet '+label+' field');return found[0];
   };
   const canvases=controls.filter(c=>c.class==='EXCEL7'&&c.text===filename);
   if(canvases.length!==1)throw new Error('No unique observed workbook canvas');
   const canvas=canvases[0];
   const initial=await snap();if(field(initial.tree,'名称框').value!=='A1')throw new Error('Initial active cell is not A1');
   {
    let s=initial,f=field(s.tree,'编辑栏'),b=f.bounds;
    if(f.value!=='Fairymouse XLSX original')throw new Error('Formula bar does not show the seeded A1 value');
    const click=await server.call('hidden_click',{name,hwnd:top.handle,x:Math.round(b.x+b.width/2),y:Math.round(b.y+b.height/2),coordinate_space:'screen'});
    await server.call('hidden_type_text',{name,hwnd:click.target_hwnd,text:marker});report.initialEditRoute='append through observed formula-bar client click and WM_CHAR';
    await server.call('hidden_keys',{name,hwnd:click.target_hwnd,keys:['enter']});
    await pause(300);
   }
   for(const [address,value] of [['A2','7'],['B2','6'],['C2','=SUM(A2:B2)*2']]){
    let s=await snap(),current=field(s.tree,'名称框').value;
    if(!/^[A-C][1-3]$/.test(current))throw new Error('Unexpected active cell; no guessed keyboard navigation');
    const col=address.charCodeAt(0)-current.charCodeAt(0),row=Number(address.slice(1))-Number(current.slice(1));
    for(let n=0;n<Math.abs(row);n++)await server.call('hidden_keys',{name,hwnd:canvas.handle,keys:[row>0?'down':'up']});
    for(let n=0;n<Math.abs(col);n++)await server.call('hidden_keys',{name,hwnd:canvas.handle,keys:[col>0?'right':'left']});
    s=await snap();if(field(s.tree,'名称框').value!==address)throw new Error('Cell navigation was not verified before mutation');
    await server.call('hidden_type_text',{name,hwnd:canvas.handle,text:value});
    await server.call('hidden_keys',{name,hwnd:canvas.handle,keys:['enter']});await pause(200);
   }
   writeFileSync(join(folder,'after-edit.json'),JSON.stringify(await snap()));
   report.expectedCells={A1:'Fairymouse XLSX original'+marker,A2:7,B2:6,C2:{formula:'SUM(A2:B2)*2',value:26}};
  }
  await checkpoint('save');
  const fresh=await server.call('hidden_semantic',{name,hwnd:top.handle,action:'snapshot'});
  const saves=flatten(fresh.tree).filter(c=>/^保存\s*\(Ctrl\+S\)$/.test(c.name??'')&&c.bounds?.width>0);
  if(saves.length!==1)throw new Error('No unique observed Save control');
  if(saves[0].states?.includes('disabled'))throw new Error('Observed Save control is disabled');
  const saveControls=await server.call('hidden_controls',{name,hwnd:top.handle});
  writeFileSync(join(folder,'before-save.json'),JSON.stringify({snapshot:fresh,controls:saveControls},null,2));
  await capture(server,name,top.handle,join(folder,'before-save.png'));
  const b=saves[0].bounds,savePoint={x:Math.round(b.x+b.width/2),y:Math.round(b.y+b.height/2)};
  const delivery=await server.call('hidden_click',{name,hwnd:top.handle,...savePoint,coordinate_space:'screen'});
  writeFileSync(join(folder,'save-click.json'),JSON.stringify({point:savePoint,delivery},null,2));
  report.saveTargetClass=saveControls.find(c=>c.handle===delivery.target_hwnd)?.class??top.class;
  let actual;for(let i=0;i<20;i++){await pause(500);actual=readback(file,format,marker);if(matchesExpected(actual,format,marker))break;}
  writeFileSync(join(folder,'after-save.json'),JSON.stringify(await server.call('hidden_semantic',{name,hwnd:top.handle,action:'snapshot'})));
  await capture(server,name,top.handle,join(folder,'after-save.png'));
  report.fileSaveVerified=matchesExpected(actual,format,marker);
  report.status=report.fileSaveVerified?'passed':'unsupported';
  if(!report.fileSaveVerified){report.reason='Saved package did not match all expected UI-entered content, values and formula';writeFileSync(join(folder,'after-save-windows.json'),JSON.stringify(await server.call('hidden_windows',{name})));}
 }catch(error){report.status='failed';report.reason=error.message;process.exitCode=1;}
 finally{
  server.cleanup();
  try{
   if(created){
    const windows=await server.call('hidden_windows',{name});owned=ownedTree([pid,...windows.map(w=>w.process_id),...owned.map(p=>p.id)],report.validatedAt,executable).concat(owned);
    const ownedIds=new Set(owned.map(p=>p.id));
    for(const w of windows)if(ownedIds.has(w.process_id)&&(w.title??'').includes(filename))await server.call('hidden_close_window',{name,hwnd:w.handle});
    cleanOwned(owned);await pause(500);
    for(let i=0;i<3;i++){const remaining=await server.call('hidden_windows',{name});if(!remaining.length)break;const more=ownedTree([...remaining.map(w=>w.process_id),...owned.map(p=>p.id)],report.validatedAt,executable);cleanOwned(more);owned.push(...more);await pause(500);}
    await server.call('hidden_release',{name});report.cleanedUp=true;
   }
  }catch(error){report.cleanedUp=false;report.cleanupError=error.message;report.status='failed';process.exitCode=1;}
  server.close();report.monitor=await monitor.stop();
  if(report.fileSaveVerified){report.readbackAfterExit=readback(file,format,marker);if(!matchesExpected(report.readbackAfterExit,format,marker)){report.status='failed';process.exitCode=1;}}
 }
 return report;
}
const index=process.argv.indexOf('--format'),format=index>=0?process.argv[index+1]:'both';
if(!['docx','xlsx','both'].includes(format))throw new Error('--format must be docx, xlsx or both');
const report={validatedAt:new Date().toISOString(),tests:[]};
if(!process.argv.includes('--run'))report.status='skipped';
else for(const type of format==='both'?['docx','xlsx']:[format])report.tests.push(await runFormat(type));
report.status??=report.tests.some(r=>r.status==='failed')?'failed':report.tests.every(r=>r.status==='passed')?'passed':'unsupported';
mkdirSync(join(root,'reports'),{recursive:true});writeFileSync(reportPath('wps-formats.json'),JSON.stringify(report,null,2));console.log(JSON.stringify(report));

finishTrace(report.status);
