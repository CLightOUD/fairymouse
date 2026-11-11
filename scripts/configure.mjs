// Print configuration only. Never writes a host's settings or installs a service.
import {dirname,join} from 'node:path';
import {fileURLToPath} from 'node:url';
const root=dirname(dirname(fileURLToPath(import.meta.url)));
const args=process.argv.slice(2);
let agents=['default'];
if(args.length){
 if(args.length!==2||args[0]!=='--agents')throw new Error('Usage: node scripts/configure.mjs [--agents writer,reviewer]');
 agents=args[1].split(',');
 if(agents.length>8||agents.some(x=>!/^[a-zA-Z0-9_-]{1,32}$/.test(x))||new Set(agents).size!==agents.length)throw new Error('Use 1..8 unique ASCII agent names (letters, numbers, underscore, hyphen)');
}
const mcpServers={'fairy-desktop':{command:process.execPath,args:[join(root,'desktop','background-mcp.mjs')]}};
for(const agent of agents){
 const key=agent==='default'?'fairy-hidden':`fairy-hidden-${agent}`;
 mcpServers[key]={command:process.execPath,args:[join(root,'hidden','launch.mjs')]};
}
console.log(JSON.stringify({mcpServers},null,2));
