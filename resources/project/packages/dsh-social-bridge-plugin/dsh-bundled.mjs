import fs from 'node:fs';import path from 'node:path';import crypto from 'node:crypto';
import {safeFetch} from '../../components/qq-bridge/src/safe-fetch.js';
import {activeReaderAccount} from '../../scripts/reader-account-state.mjs';
import {setup} from '../../extensions/skills/meme-search/index.js';
/** Project-shipped capability registered in DSH, using the same native tool pipeline as other plugins. */
export function registerDshBundled(ctx,root,{settings={},keyFor=()=>undefined,isAllowed=()=>true,fetchText=safeFetch}={}){
  const tools=ctx.get?.('tools');if(!tools?.register)return ()=>{};
  const defaults={provider:'auto',maxResults:3,cacheMinutes:120,cooldownSeconds:20,...settings};let def;setup({registerTool:tool=>{def=tool;}});
  const disposers=[tools.register({name:'meme-search__search',description:def.description,parameters:def.parameters,output:{schema:{type:'object',properties:{content:{type:'string'},isError:{type:'boolean'}},required:['content','isError'],additionalProperties:false},render:(_args,value)=>[{type:'text',text:value.content}]},async execute(args,exec){
    if(!isAllowed()||!exec?.agent?.session)throw Error('DSH_PLUGIN_CONTEXT_UNAVAILABLE');
    const account=activeReaderAccount(root).id||'legacy',key=keyFor(String(exec.agent.session.id))??'dsh:'+String(exec.agent.session.id);
    const check=()=>{if(!isAllowed()||exec.signal?.aborted||(activeReaderAccount(root).id||'legacy')!==account)throw Error('DSH_PLUGIN_CANCELLED');};
    const file=path.join(root,'state/accounts',account,'dsh-plugin-storage/meme-search',crypto.createHash('sha256').update(key).digest('hex')+'.json');
    const read=()=>{check();if(!fs.existsSync(file))return {};const stat=fs.lstatSync(file);if(!stat.isFile()||stat.isSymbolicLink()||stat.size>262144)throw Error('DSH_PLUGIN_STORAGE_INVALID');return JSON.parse(fs.readFileSync(file,'utf8'));};
    const storage={get:name=>read()[name],set:(name,value)=>{const data=read();data[name]=value;const text=JSON.stringify(data);if(Buffer.byteLength(text)>262144)throw Error('DSH_PLUGIN_STORAGE_LIMIT');fs.mkdirSync(path.dirname(file),{recursive:true});check();const temporary=file+'.'+crypto.randomUUID()+'.tmp';fs.writeFileSync(temporary,text);fs.renameSync(temporary,file);}};
    const result=await def.execute({signal:exec.signal,config:()=>structuredClone(defaults),storage,async fetch(url,options={}){check();const value=await fetchText(url,options.maxChars??65536,{signal:exec.signal,timeoutMs:options.timeoutMs??7000});check();return new Response(value.body,{status:value.statusCode,headers:{'X-WeChatAgent-Truncated':String(value.truncated===true)}});}},args);check();return {content:result.content,isError:result.isError===true};
  }})];
  const skills=ctx.get?.('skills');if(skills?.register)disposers.push(skills.register({name:'meme-search',description:'根据当前情绪、动作或角色寻找公开表情素材链接，优先已有表情。',content:'需要新的表情素材时调用 meme-search__search。仅查询简短公开关键词，不上传昵称、账号、聊天原文或凭据。返回的是未查看的素材链接，不声称已查看、下载、入库或原生发送。此技能需要单独授权 meme-search__search 工具；保持当前聊天人格。'}));
  return ()=>{for(const dispose of disposers)dispose?.();};
}
