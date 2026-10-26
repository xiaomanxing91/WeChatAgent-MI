import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { scanExtensions, extensionConfig, allowedChat, validateSchema, validateValue, HOOKS, error, atomicJson, readJson, within, publicSettings, boundedFile } from './catalog.mjs';
import { safeFetch as safeFetchText } from '../../components/qq-bridge/src/safe-fetch.js';
import { PolicySnapshots } from './snapshots.mjs';

export const TOOL_POLICY = Symbol.for('wechatagent.extension-tools.v1');
const MAX_OUTPUT = 12000;
const clipped = value => String(value ?? '').slice(0, MAX_OUTPUT);
const toolName = (id, tool) => `${id}__${tool}`;
function deadline(action, milliseconds, signal) {
  const controller = new AbortController();
  let timer, abort;
  const interrupted = new Promise((_, reject) => {
    abort = () => { controller.abort(); reject(error('EXTENSION_CANCELLED')); };
    if (signal?.aborted) abort(); else signal?.addEventListener('abort',abort,{once:true});
    timer = setTimeout(() => { controller.abort(); reject(error('EXTENSION_TIMEOUT')); },milliseconds);
  });
  return Promise.race([Promise.resolve().then(() => { if(controller.signal.aborted)throw error('EXTENSION_CANCELLED');return action(controller.signal); }),interrupted]).finally(() => { clearTimeout(timer);signal?.removeEventListener('abort',abort);controller.abort(); });
}
export class ExtensionRuntime {
  constructor({root,log=()=>{},fetchText=safeFetchText}) {
    this.root = path.resolve(root); this.log = log; this.fetchText = fetchText;
    this.records = new Map(); this.tools = new Map(); this.capabilities = new Map(); this.syncing = null;
    this.policy=new PolicySnapshots(this.root);this.catalog=null;this.catalogDirty=true;this.catalogScans=0;this.policyEpoch=-1;this.toolViews=new Map();this.watchers=[];
    for(const relative of ['extensions','packages/native-features'])try{const watcher=fs.watch(path.join(this.root,relative),{recursive:true},()=>{this.catalogDirty=true;});watcher.on('error',()=>{this.catalogDirty=true;});watcher.unref();this.watchers.push(watcher);}catch{}
  }
  get metrics(){return {directoryScans:this.catalogScans,configReads:this.policy.reads,metadataChecks:this.policy.stats};}
  refreshPolicy(){const epoch=this.policy.refresh();if(epoch!==this.viewEpoch){this.toolViews.clear();this.viewEpoch=epoch;}return epoch;}
  status(record,key,refresh=true) {
    try {
      if(refresh)this.refreshPolicy();if(this.policy.failure)throw this.policy.failure;
      const setting = this.policy.extensions[record.id] ?? (record.builtin?{enabled:true,chats:null}:{});
      const enabled = setting.enabled === true;
      const permissions = setting.permissions ?? [];
      const reason = record.invalid ? record.reason : !enabled ? '未启用' : record.failure ? record.failure
        : record.permissions.some(value => !permissions.includes(value)) ? '缺少已授权权限'
        : (record.requires ?? []).some(name => !this.hasCapability(name,key,new Set([record.id]),false)) ? '依赖未就绪'
        : key && (!this.policy.permits(key) || setting.chats !== null && !(setting.chats ?? []).includes(key)) ? '当前聊天未启用'
        : !record.module && record.format === 'code' ? '等待加载' : '';
      return {enabled,loaded:record.format === 'markdown' || !!record.module,active:!reason,reason:reason || '已生效',settings:{...record.settings,...setting.settings},permissions,chats:setting.chats ?? null};
    } catch { return {enabled:false,loaded:false,active:false,reason:'扩展配置不可读',settings:{},permissions:[],chats:[]}; }
  }
  isActive(id,key,refresh=true) { if(refresh)this.refreshPolicy();const item = this.records.get(id); return !!item && this.status(item,key,false).active; }
  hasCapability(name,key,visiting=new Set(),refresh=true) {
    if(refresh)this.refreshPolicy();if(this.policy.failure)return false;
    if (['chat.context','chat.history','chat.reply','storage','web.fetch'].includes(name)) return true;
    const provider = this.capabilities.get(name); if (!provider || visiting.has(provider.id)) return false;
    const item = this.records.get(provider.id), settings = this.policy.extensions[provider.id] ?? {};
    return !!item?.module && settings.enabled === true && item.permissions.every(value => (settings.permissions ?? []).includes(value))
      && (!key || this.policy.permits(key) && (settings.chats === null || (settings.chats ?? []).includes(key)))
      && (item.requires ?? []).every(dependency => this.hasCapability(dependency,key,new Set([...visiting,provider.id]),false));
  }
  async sync({force=false}={}) {
    if (this.syncing) return this.syncing;
    const epoch=this.refreshPolicy();if(!force && this.catalog && !this.catalogDirty && epoch===this.policyEpoch)return;
    if(force||!this.catalog||this.catalogDirty){this.catalogScans++;this.catalog=scanExtensions(this.root);this.catalogDirty=false;}
    this.syncing = this.reconcile().finally(() => {this.syncing=null;}); return this.syncing;
  }
  async reconcile() {
    if(this.policy.failure)throw this.policy.failure;
    const incoming = this.catalog, settings = this.policy.extensions;this.toolViews.clear();this.policyEpoch=this.policy.epoch;
    for (const [id,item] of this.records) {
      const next = incoming.find(candidate => candidate.id === id);
      if (!next || next.invalid || next.revision !== item.revision || !item.builtin && settings[id]?.enabled !== true || (item.permissions ?? []).some(value=>!(settings[id]?.permissions ?? []).includes(value)) || item.format === 'code' && !item.module && !item.failure && settings[id]?.enabled === true) {
        if(item.module)await this.unload(item);
        this.records.delete(id);
      }
    }
    for (const item of incoming) {
      if (this.records.has(item.id)) continue;
      const record = {...item}; this.records.set(item.id,record);
      if(item.builtin){if(!item.invalid)record.module={bridgeManaged:true};continue;}
      if(item.format==='markdown' && !item.invalid) {
        this.tools.set(toolName(item.id,'load'),{id:item.id,name:toolName(item.id,'load'),description:`加载技能说明：${item.description}。可读取技能内的参考资料。`,parameters:{type:'object',properties:{resource:{type:'string',description:'可选的 references/ 文件相对路径；省略时读取技能说明。',maxLength:200}},additionalProperties:false},execute:(_ctx,args)=>{
          if(!args.resource)return {content:item.instructions};
          const target=path.resolve(item.directory,args.resource);
          if(!within(item.directory,target) || !/^references[\\/]/.test(args.resource) || !/\.(md|txt|json)$/i.test(target))throw error('技能参考资料路径无效。');
          if(!within(fs.realpathSync(item.directory),fs.realpathSync(target)))throw error('技能参考资料不能通过链接访问外部文件。');
          return {content:boundedFile(target,65536).slice(0,12000)};
        }});
        continue;
      }
      if (item.invalid || settings[item.id]?.enabled !== true || item.permissions.some(value => !(settings[item.id]?.permissions ?? []).includes(value))) continue;
      try {
        // Enabled local JavaScript is trusted code, not a sandbox. Disabled code is never imported.
        const entry = path.join(item.directory,'index.js');
        const module = await deadline(() => import(pathToFileURL(entry).href+'?revision='+item.revision),5000);
        const tools = new Map(); const api = Object.freeze({
          apiVersion:1, config:()=>structuredClone(this.status(record).settings),
          registerTool:def=>{
            if (!def || !/^[a-z][a-z0-9-]{0,19}$/.test(def.id ?? '') || typeof def.description !== 'string' || !def.description.trim() || typeof def.execute !== 'function') throw error('工具需要 id、description、parameters、execute。');
            validateSchema(def.parameters);if(def.parameters.type!=='object')throw error('工具参数必须是 object。');
            const name = toolName(item.id,def.id); if(tools.has(name) || this.tools.has(name))throw error('工具 id 重复。');
            tools.set(name,{...def,name,id:item.id}); return name;
          },
          capability:(name,args,ctx)=>this.capability(name,args,ctx),
          hasCapability:name=>this.hasCapability(name),
          log:(...args)=>this.log(`[extension:${item.id}] ${args.map(clipped).join(' ')}`),
          fetch:(url,options)=>this.fetchFor(record,url,options),
        });
        for(const name of Object.keys(module.hooks ?? {})) if(!HOOKS.includes(name) || typeof module.hooks[name]!=='function')throw error('不支持的扩展钩子。');
        const provided = Object.keys(module.providers ?? {});
        if(provided.some(name=>!(item.capabilities ?? []).includes(name) || typeof module.providers[name]!=='function' || this.capabilities.has(name)) || (item.capabilities ?? []).some(name=>!provided.includes(name)))throw error('能力声明、实现或提供者冲突。');
        record.module=module;record.api=api;
        if(module.setup || module.register)await deadline(() => (module.setup ?? module.register)(api),5000);
        if(item.kind==='skills' && !tools.size)throw error('代码 Skill 至少需要注册一个工具。');
        for(const [name,tool] of tools)this.tools.set(name,tool);
        for(const name of provided)this.capabilities.set(name,{id:item.id,execute:module.providers[name]});
      } catch(cause) { await this.unload(record); record.failure = clipped(cause.message);this.log(`[extension:${item.id}] 加载失败：${record.failure}`); }
    }
    // All providers are registered before activation so dependencies do not
    // depend on directory order. Unavailable extensions never start resources.
    for(const record of this.records.values())if(record.module) {
      const active=this.status(record,undefined,false).active;
      if(active && !record.activated)try{if(record.module.activate)await deadline(()=>record.module.activate(record.api),5000);record.activated=true;}catch(cause){await this.unload(record);record.failure=clipped(cause.message);}
      if(!active && record.activated){if(record.module.deactivate)try{await deadline(()=>record.module.deactivate(),5000);}catch(cause){this.log(`[extension:${record.id}] deactivate: ${cause.message}`);}record.activated=false;}
    }
  }
  async unload(record) {
    for(const method of ['deactivate','dispose'])if(record.module?.[method] && (method==='dispose'||record.activated))try{await deadline(() => record.module[method](),5000);}catch(cause){this.log(`[extension:${record.id}] ${method}: ${cause.message}`);}
    for(const [name,tool] of this.tools)if(tool.id===record.id)this.tools.delete(name);
    for(const [name,provider] of this.capabilities)if(provider.id===record.id)this.capabilities.delete(name);
    delete record.module;delete record.api;record.activated=false;
  }
  list(key) {this.refreshPolicy();return [...this.records.values()].map(item=>{const status=this.status(item,key,false);return {id:item.id,name:item.name,builtin:!!item.builtin,host:item.host ?? 'dsh',description:item.description ?? '',version:item.version,apiVersion:item.apiVersion,kind:item.kind,format:item.format,revision:item.revision,configSchema:item.configSchema ?? {},requestedPermissions:item.permissions ?? [],capabilities:item.capabilities ?? [],tools:[...this.tools.values()].filter(tool=>tool.id===item.id).map(tool=>({name:tool.name,description:tool.description})),...status,reason:item.builtin&&status.active?'内置，沿用现有功能设置':status.reason,settings:publicSettings(item,status.settings)};});}
  toolDefinitions(key) {this.refreshPolicy();if(!this.toolViews.has(key))this.toolViews.set(key,[...this.tools.values()].filter(tool=>this.isActive(tool.id,key,false)));return this.toolViews.get(key);}
  bindingRevision(key){return this.toolDefinitions(key).map(tool=>tool.name+':'+this.records.get(tool.id).revision).join('|');}
  assertPermission(record,permission,key) {this.refreshPolicy();const local=this.policy.extensions[record.id];if(local?.enabled!==true || !record.permissions.includes(permission) || !(local.permissions ?? []).includes(permission) || key && !this.isActive(record.id,key,false))throw error('EXTENSION_PERMISSION_DENIED'); }
  async fetchFor(record,url,options={},key,signal) {
    if(!options || typeof options!=='object' || Array.isArray(options) || Object.keys(options).some(name=>!['maxChars','timeoutMs'].includes(name)))throw error('FETCH_OPTIONS_INVALID');
    const maxChars=options.maxChars ?? MAX_OUTPUT, timeoutMs=options.timeoutMs ?? 7000;
    if(!Number.isSafeInteger(maxChars) || maxChars<256 || maxChars>65536)throw error('FETCH_SIZE_INVALID');
    if(!Number.isSafeInteger(timeoutMs) || timeoutMs<100 || timeoutMs>7000)throw error('FETCH_TIMEOUT_INVALID');
    if(signal?.aborted)throw error('EXTENSION_CANCELLED');
    this.assertPermission(record,'web_fetch',key);
    const result=await this.fetchText(url,maxChars,{signal,timeoutMs});
    if(signal?.aborted)throw error('EXTENSION_CANCELLED');
    this.assertPermission(record,'web_fetch',key);
    const status=result.statusCode ?? 200;
    return new Response([204,205,304].includes(status)?null:result.body ?? result.text,{status,headers:{'X-WeChatAgent-Truncated':result.truncated?'true':'false'}});
  }
  context(record,turn,signal) {
    const key = turn.conversationKey;
    const check = permission => {if(signal?.aborted)throw error('EXTENSION_CANCELLED');this.assertPermission(record,permission,key);};
    const storageFile=path.join(this.root,'state/extensions',record.id,'data.json');
    const storageKey=value=>{if(typeof value!=='string' || !/^[a-zA-Z0-9_-]{1,64}$/.test(value))throw error('存储键无效。');return key+'|'+value;};
    return Object.freeze({
      apiVersion:1, signal, chat:Object.freeze({key,platform:'wechat',kind:key.split(':')[1],id:key.split(':')[2],name:turn.conversationName ?? key}),
      chatKey:key, kind:key.split(':')[1], chatId:key.split(':')[2], sessionId:turn.sessionId,
      config:()=>structuredClone(this.status(record,key).settings),
      reply:text=>{check('reply');const value=clipped(text).trim();if(!value)throw error('回复不能为空。');if(turn.replies.length>=3)throw error('本轮回复申请过多。');turn.replies.push({id:record.id,text:value});return {content:'回复已申请，将由本轮发送流程处理。'};},
      history:Object.freeze({recent:({limit=20}={})=>{check('history_read');if(!Number.isInteger(limit)||limit<1||limit>100)throw error('历史数量必须为 1–100。');const file=path.join(this.root,'state/social-messages.json');return structuredClone(fs.existsSync(file)?(readJson(file).chats?.[key]??[]).slice(-limit).map(row=>({id:row.id,text:clipped(row.text),sender:row.sender_name ?? row.sender_id,timestamp:row.timestamp,outgoing:!!row.outgoing})):[]);}}),
      storage:Object.freeze({get:name=>{check('storage');return structuredClone(fs.existsSync(storageFile)?readJson(storageFile)[storageKey(name)]:undefined);},set:(name,value)=>{check('storage');const data=fs.existsSync(storageFile)?readJson(storageFile):{};data[storageKey(name)]=structuredClone(value);if(Buffer.byteLength(JSON.stringify(data))>262144)throw error('扩展存储超过 256 KiB。');atomicJson(storageFile,data);},delete:name=>{check('storage');const data=fs.existsSync(storageFile)?readJson(storageFile):{};delete data[storageKey(name)];atomicJson(storageFile,data);}}),
      fetch:(url,options)=>{check('web_fetch');if(turn.networkOptOut)throw error('EXTENSION_NETWORK_DISABLED_FOR_TURN');return this.fetchFor(record,url,options,key,signal);},
      hasCapability:name=>this.hasCapability(name,key),
    });
  }
  async capability(name,args,ctx) {
    const provider=this.capabilities.get(name);if(!provider || !this.isActive(provider.id,ctx?.chatKey))throw error('EXTENSION_CAPABILITY_UNAVAILABLE');
    return deadline(()=>provider.execute(args,ctx),5000,ctx?.signal);
  }
  async execute(name,args,turn,signal) {
    const tool=this.tools.get(name);if(!tool || !this.isActive(tool.id,turn.conversationKey))throw error('EXTENSION_TOOL_UNAVAILABLE');
    validateValue(args,tool.parameters);
    if(++turn.toolCalls>3)throw error('EXTENSION_TOOL_LIMIT');
    const record=this.records.get(tool.id);
    const guard=await this.hooks('before-tool',{toolName:name,args:structuredClone(args)},turn,signal);
    if(guard.some(item=>item?.block===true))throw error('EXTENSION_TOOL_BLOCKED');
    const before=turn.replies.length;
    try {
      const result=await deadline(async ownSignal=>{
        const ctx=this.context(record,turn,ownSignal);
        const available=record.module?.available?.(ctx);
        if(available && typeof available.then==='function')throw error('available() 必须同步返回。');
        if(available===false || available?.ok===false)throw error('EXTENSION_UNAVAILABLE');
        return tool.execute(ctx,structuredClone(args));
      },10000,signal);
      if(!this.isActive(record.id,turn.conversationKey))throw error('EXTENSION_TOOL_UNAVAILABLE');
      if(result?.isError)turn.replies.splice(before);
      const output={content:clipped(typeof result==='string'?result:result?.content ?? JSON.stringify(result)),isError:result?.isError===true};
      await this.hooks('after-tool',{toolName:name,result:structuredClone(output)},turn,signal);
      return output;
    } catch(cause) {turn.replies.splice(before);throw cause;}
  }
  async hooks(name,value,turn,signal) {
    this.refreshPolicy();
    const results=[];
    const started=Date.now();
    for(const record of this.records.values())if(record.module?.hooks?.[name] && this.isActive(record.id,turn.conversationKey,false)) {
      const remaining=4000-(Date.now()-started);if(remaining<=0)break;
      try { const result=await deadline(ownSignal=>{
        const ctx=this.context(record,turn,ownSignal),denied=()=>{throw error('钩子只能读取上下文并返回处理结果。');};
        return record.module.hooks[name](Object.freeze({...ctx,reply:denied,fetch:denied,storage:Object.freeze({...ctx.storage,set:denied,delete:denied}),...structuredClone(value)}));
      },Math.min(2000,remaining),signal);results.push(result); }
      catch(cause){this.log(`[extension:${record.id}] ${name}: ${cause.message}`);}
    }
    return results;
  }
  instructions(key,message) {
    this.refreshPolicy();
    const parts=[];
    for(const record of this.records.values())if(!record.builtin && this.isActive(record.id,key,false)) {
      if(record.format==='markdown') {
        const words=(record.description+' '+record.id).split(/[\s，。；、]+/).filter(word=>word.length>=2);
        if(!message.includes('/skill '+record.id) && !words.some(word=>message.toLowerCase().includes(word.toLowerCase())))continue;
        parts.push(`[技能 ${record.id}]\n${record.instructions.slice(0,6000)}`);
      } else if(record.prompt?.sections)for(const section of record.prompt.sections)parts.push((section.content ?? section.text).slice(0,2000));
    }
    return parts.join('\n\n').slice(0,8000);
  }
  async dispose() {for(const watcher of this.watchers)watcher.close();for(const record of this.records.values())await this.unload(record);this.records.clear();}
}
export function bindAgentTools(agentCtx,runtime,key,turnFor) {
  const disposers=[];
  const policy={names:()=>new Set(runtime.toolDefinitions(key).map(tool=>tool.name)),check:name=>runtime.toolDefinitions(key).some(tool=>tool.name===name) && !!turnFor(),definitions:()=>runtime.toolDefinitions(key)};
  Object.defineProperty(agentCtx,TOOL_POLICY,{value:policy,configurable:true});
  for(const tool of runtime.toolDefinitions(key)) {
    // DSH 0.2 registry-ready definition. Validation and deadlines are enforced by this runtime.
    disposers.push(agentCtx.tools.register({name:tool.name,description:tool.description,parameters:tool.parameters,
      output:{schema:{type:'object',properties:{content:{type:'string'},isError:{type:'boolean'}},required:['content','isError'],additionalProperties:false},render:(_args,value)=>[{type:'text',text:value.content}]},
      async execute(args,exec){const turn=turnFor();if(!turn)throw error('EXTENSION_TURN_UNAVAILABLE');const result=await runtime.execute(tool.name,args,turn,exec?.signal);if(result.isError)throw error(result.content);return result;},
    }));
  }
  return ()=>{for(const dispose of disposers)dispose?.();delete agentCtx[TOOL_POLICY];};
}
