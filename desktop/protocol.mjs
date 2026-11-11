export const readTools=new Set(['snapshot','find','get','is','screenshot','list_surfaces','list_displays','list_apps','list_windows','wait','status','version','skills_list','skills_get'].map(x=>'desktop_'+x));
export const allowed=new Set([...readTools,...['click','set_value','clear','select','toggle','check','uncheck','expand','collapse','scroll','scroll_to'].map(x=>'desktop_'+x)]);
export function normalize(result,name){
 let upstream=result.structuredContent;
 if(!upstream){for(const block of result.content??[]){if(block.type==='text'){try{upstream=JSON.parse(block.text);break}catch{}}}}
 const failed=Boolean(result.isError||upstream?.ok===false||upstream?.status==='error');
 const verified=!failed&&(upstream?.verified===true||upstream?.data?.verified===true);
 const error=upstream?.error;
 const fairy={version:'1',route:'desktop',status:failed?'error':verified?'verified':readTools.has(name)?'observed':'completed_unverified',verified,
  retry_safe:!failed&&readTools.has(name)};
 if(error?.code)fairy.code=error.code;
 if(error?.message)fairy.message=error.message;
 const original=result.structuredContent;
 const structured=original&&typeof original==='object'&&!Array.isArray(original)?original:original===undefined?{}:{upstream:original};
 return {...result,isError:failed,structuredContent:{...structured,fairy}};
}
export function localResult(status,code,message,extra={}){
 const fairy={version:'1',route:'desktop',status,verified:false,retry_safe:false,...(code?{code}:{}),...(message?{message}:{}),...extra};
 return {isError:status==='error',content:[{type:'text',text:JSON.stringify(fairy)}],structuredContent:{fairy}};
}
export const controlTool={name:'desktop_control',description:'Status, pause/resume new mutations, or recover a failed backend. Pause does not cancel in-flight actions. Recovery never replays actions; observe a fresh snapshot before mutations. Spawned backend child actions may still finish.',inputSchema:{type:'object',properties:{action:{type:'string',enum:['status','pause','resume','recover']}},required:['action'],additionalProperties:false},annotations:{readOnlyHint:false,destructiveHint:false,idempotentHint:true,openWorldHint:false}};

export function observationIsFresh(requestGeneration,currentGeneration,paused,isError){
 return !paused&&!isError&&requestGeneration===currentGeneration;
}
