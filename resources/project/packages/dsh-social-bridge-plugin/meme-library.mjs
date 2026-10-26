import fs from 'node:fs';import path from 'node:path';import crypto from 'node:crypto';
import {searchPolicy} from './search-policy.mjs';
import {memeLibraryPolicy,MEME_LIBRARY_POLICY} from './meme-library-policy.mjs';
import {normalizeWebUrl} from './web-reader-policy.mjs';
import {Parser} from 'htmlparser2';
const MAX_IMAGE=8*1024*1024;
const safeDownload=async(...args)=>(await import('../../components/qq-bridge/src/safe-fetch.js')).safeFetchBuffer(...args);
export function extractMemeImages(body,pageUrl,query){
  const items=[],seen=new Set();let title='';
  const add=(raw,description)=>{if(typeof raw!=='string'||!raw.trim()||raw.length>1500)return;try{const url=normalizeWebUrl(new URL(raw,pageUrl).href);if(new URL(url).protocol!=='https:'||seen.has(url)||url.length>1500)return;seen.add(url);items.push({candidateId:crypto.createHash('sha256').update(pageUrl+'\0'+url).digest('hex').slice(0,32),imageUrl:url,pageUrl,description:clean(description||title||query),tags:['daily'],origin:'web',source:'dsh-search',visualVerified:false});}catch{}};
  const parser=new Parser({onopentag(name,attrs){if(items.length>=12)return;if(name==='meta'&&['og:title','twitter:title'].includes(attrs.property??attrs.name))title=attrs.content??'';if(name==='meta'&&['og:image','twitter:image','twitter:image:src'].includes(attrs.property??attrs.name))add(attrs.content,'');if(name==='img')add(attrs['data-src']||attrs['data-original']||attrs.src,attrs.alt);}}, {decodeEntities:true});
  parser.write(body);parser.end();return items.slice(0,12);
}
const clean=(value,max=120)=>String(value??'').replace(/[\u0000-\u001f]/g,' ').trim().slice(0,max);
const digest=value=>crypto.createHash('sha256').update(value).digest('hex');
async function bytes(response,limit){
  if(!response.ok)throw Error('MEME_HTTP_'+response.status);
  const parts=[];let length=0;
  for await(const chunk of response.body){length+=chunk.length;if(length>limit)throw Error('MEME_RESPONSE_TOO_LARGE');parts.push(chunk);}
  return Buffer.concat(parts);
}
export function memeImageRoute(value){
  if(typeof value!=='string'||value.length>1500||!value.startsWith('/dsh-memes/'))throw Error('MEME_INVALID_RESOURCE');
  const decoded=decodeURIComponent(value);
  if(/[\\\x00-\x1f?#]/.test(decoded)||decoded.split('/').some(part=>part==='..'||part==='.')||decoded.includes('%'))throw Error('MEME_INVALID_RESOURCE');
  return value;
}
export function createMemeLibrary({ctx,root,fetchImpl=fetch,download=safeDownload,readPage=async(url,options)=>(await import('./web-reader-fetch.mjs')).fetchWebPage(url,options),isAllowed=()=>true}){
  const settings=()=>JSON.parse(fs.readFileSync(path.join(root,'config/wechatagent.json'),'utf8').replace(/^\uFEFF/,''));
  const check=key=>{if(!isAllowed()||!memeLibraryPolicy(settings().wechat,key).enabled)throw Error('MEME_LIBRARY_NOT_ALLOWED');};
  const origin=()=>{const web=ctx.get?.('webServer')??ctx.webServer;if(!web||!Number.isInteger(web.port)||web.port<1||web.port>65535)throw Error('MEME_DSH_WEB_UNAVAILABLE');return 'http://127.0.0.1:'+web.port;};
  async function request(route,body,signal,timeoutMs=5000){
    const response=await fetchImpl(origin()+route,{method:body?'POST':'GET',...(body?{headers:{'content-type':'application/json'},body:JSON.stringify(body)}:{}),redirect:'error',signal:AbortSignal.any([AbortSignal.timeout(timeoutMs),...(signal?[signal]:[])])});
    const data=JSON.parse((await bytes(response,2*1024*1024)).toString('utf8'));if(data.ok===false)throw Error('MEME_PLUGIN_UNAVAILABLE');return data;
  }
  async function catalog(signal){
    const state=await request('/dsh-memes-api',{op:'getMemeRoot'},signal);
    if(!Array.isArray(state.packs)||!Array.isArray(state.enabledPacks))throw Error('MEME_PLUGIN_INCOMPATIBLE');
    return state;
  }
  async function status(){try{const state=await catalog();return {installed:true,available:true,enabledPacks:state.enabledPacks.length,totalPacks:state.packs.length,source:'dsh-meme'};}catch(error){return {installed:false,available:false,source:'dsh-meme',reason:/^MEME_[A-Z_0-9]+$/.test(error.message)?error.message:'MEME_PLUGIN_UNAVAILABLE'};}}
  async function search(key,query,signal){
    check(key);query=clean(query,120);if(!query)throw Error('MEME_QUERY_REQUIRED');
    const state=await catalog(signal),result=[];
    for(const pack of state.packs.filter(pack=>state.enabledPacks.includes(pack.id)).slice(0,12)){
      const data=await request('/dsh-memes-api?packId='+encodeURIComponent(pack.id)+'&q='+encodeURIComponent(query),undefined,signal);check(key);
      if(!Array.isArray(data.memes))throw Error('MEME_PLUGIN_INCOMPATIBLE');
      for(const item of data.memes.slice(0,12)){
        try{const route=memeImageRoute(item.url);result.push({candidateId:digest(key+'\0'+route).slice(0,32),route,packId:pack.id,description:clean(item.caption||item.file_name),tags:[clean(item.tag,16)].filter(Boolean),source:'dsh-meme'});}catch{}
      }
      if(result.length>=12)break;
    }
    return result.slice(0,12);
  }
  async function readerImageRequest(route,key,raw,description,tags,signal){
    check(key);if(!Buffer.isBuffer(raw)||!raw.length||raw.length>MAX_IMAGE)throw Error('MEME_INVALID_IMAGE');signal?.throwIfAborted();
    const io=JSON.parse(fs.readFileSync(path.join(root,'state/wechat-io-config.json'),'utf8').replace(/^\uFEFF/,''));
    const base=new URL(io.reader_base_url);if(base.protocol!=='http:'||base.hostname!=='127.0.0.1'||base.username||base.password||base.pathname!=='/'||base.search||base.hash)throw Error('MEME_READER_LOOPBACK_REQUIRED');
    const response=await fetchImpl(base.origin+'/api/v1/stickers/'+route,{method:'POST',headers:{authorization:'Bearer '+io.reader_token,'content-type':'application/json'},body:JSON.stringify({conversationKey:key,b64:raw.toString('base64'),description:clean(description),tags:tags.map(tag=>clean(tag,16)).filter(Boolean).slice(0,6)}),redirect:'error',signal:AbortSignal.any([AbortSignal.timeout(25000),...(signal?[signal]:[])])});
    const result=JSON.parse((await bytes(response,route==='inspect'?1100000:8192)).toString('utf8'));signal?.throwIfAborted();check(key);return result;
  }
  async function prepare(key,raw,description,tags,signal){
    const result=await readerImageRequest('import',key,raw,description,tags,signal);
    if(result.ready!==true||!/^[a-f0-9]{64}$/.test(result.id??''))throw Error(result.ready===undefined?'MEME_READER_UPDATE_REQUIRED':'MEME_PREPARATION_FAILED');
    return {id:result.id,description:clean(description),tags:tags.map(tag=>clean(tag,16)).filter(Boolean).slice(0,6),source:'dsh-meme',collection:result.collection??(result.admitted?'saved':result.pending?'review-pending':'unavailable')};
  }
  async function select(key,candidate,signal){
    if(candidate.origin==='web')return importUrl(key,{imageUrl:candidate.imageUrl,description:candidate.description,query:candidate.description,tag:'daily'},signal);
    check(key);const state=await catalog(signal);if(!state.enabledPacks.includes(candidate.packId))throw Error('MEME_PACK_DISABLED');
    const response=await fetchImpl(origin()+memeImageRoute(candidate.route),{redirect:'error',signal:AbortSignal.any([AbortSignal.timeout(10000),...(signal?[signal]:[])])});
    return prepare(key,await bytes(response,MAX_IMAGE),candidate.description,candidate.tags,signal);
  }
  async function importUrl(key,args,signal){
    check(key);const policy=memeLibraryPolicy(settings().wechat,key);
    if(!policy.allowImport||!searchPolicy(settings().wechat,key).enabled)throw Error('MEME_NETWORK_IMPORT_DISABLED');
    const state=await catalog(signal);if(!state.enabledPacks.includes(state.packId))throw Error('MEME_ACTIVE_PACK_DISABLED');
    const url=new URL(args.imageUrl);if(url.protocol!=='https:'||url.username||url.password)throw Error('MEME_PUBLIC_HTTPS_REQUIRED');
    const result=await download(url.href,MAX_IMAGE,{signal,timeoutMs:15000});signal?.throwIfAborted();check(key);
    if(!memeLibraryPolicy(settings().wechat,key).allowImport||!searchPolicy(settings().wechat,key).enabled)throw Error('MEME_NETWORK_IMPORT_DISABLED');
    const magic=result.buffer;const ext=magic.subarray(0,3).equals(Buffer.from('GIF'))?'gif':magic.subarray(0,4).equals(Buffer.from([137,80,78,71]))?'png':magic.subarray(0,4).toString()==='RIFF'?'webp':'jpg';
    const preview=await readerImageRequest('inspect',key,result.buffer,'待核验素材',[],signal);
    if(preview.conversationKey!==key||preview.mime!=='image/jpeg'||typeof preview.b64!=='string'||preview.b64.length>1050000)throw Error('MEME_INVALID_PREVIEW');
    const previewBytes=Buffer.from(preview.b64,'base64');
    if(!previewBytes.length||previewBytes.length>768*1024||previewBytes.toString('base64')!==preview.b64||digest(previewBytes)!==preview.sha256||previewBytes[0]!==255||previewBytes[1]!==216)throw Error('MEME_INVALID_PREVIEW');
    // New public material is actually inspected by the original plugin, in an
    // independent call; failed recognition never enters the chat model history.
    let recognized;
    try{recognized=await request('/dsh-memes-api',{op:'recognize',fileName:'wechat-meme-preview.jpg',dataBase64:preview.b64},signal,20000);}catch(error){signal?.throwIfAborted();throw Error('MEME_RECOGNITION_FAILED');}
    if(typeof recognized.caption!=='string'||!recognized.caption.trim()||!/^[a-z0-9_-]{1,20}$/.test(recognized.tag??''))throw Error('MEME_RECOGNITION_FAILED');
    const prepared=await prepare(key,result.buffer,recognized.caption,[recognized.tag],signal);
    try{
      await request('/dsh-memes-api',{op:'upload',tag:recognized.tag,fileName:'wechat-meme.'+ext,dataBase64:result.buffer.toString('base64'),caption:clean(recognized.caption),keywords:clean(recognized.keywords||args.query,200)},signal);
      return {...prepared,librarySaved:true};
    }catch(error){signal?.throwIfAborted();return {...prepared,librarySaved:false};}
  }
  async function searchPage(key,url,query,signal){
    check(key);if(!memeLibraryPolicy(settings().wechat,key).allowImport||!searchPolicy(settings().wechat,key).enabled)throw Error('MEME_NETWORK_IMPORT_DISABLED');
    const page=await readPage(url,{signal});check(key);return extractMemeImages(page.body,page.url??url,query);
  }
  return {status,search,searchPage,select,importUrl,check};
}
export function bindMemeLibrary(agentCtx,library,root,key,turnFor,{isAllowed=()=>true}={}){
  const policy=()=>{try{const w=JSON.parse(fs.readFileSync(path.join(root,'config/wechatagent.json'),'utf8').replace(/^\uFEFF/,'')).wechat;return {...memeLibraryPolicy(w,key),network:searchPolicy(w,key).enabled};}catch{return {enabled:false,allowImport:false,network:false};}};
  const active=()=>isAllowed()&&!!turnFor()&&!turnFor().disabled&&!turnFor().controller.signal.aborted&&policy().enabled;
  const output={schema:{type:'object',properties:{content:{type:'string'},isError:{type:'boolean'}},required:['content','isError'],additionalProperties:false},render:(_args,value)=>[{type:'text',text:value.content}]};
  const definitions=[
    {name:'wechat_meme_search',description:'优先搜索 dsh-meme 已启用本地图库。没有合适素材且允许联网时，先调用现有 web_search，再把本轮来源链接作为 sourceUrl 传入，从页面提取真实图片候选；未执行页面脚本。需要发图时用 wechat_meme_select。',parameters:{type:'object',properties:{query:{type:'string',minLength:1,maxLength:120},sourceUrl:{type:'string',maxLength:1500}},required:['query'],additionalProperties:false}},
    {name:'wechat_meme_select',description:'选择本轮 wechat_meme_search 返回的一张表情，准备成当前微信聊天可发送的资源，无需等待收藏池筛选；按返回的完整 STICKER 标记回复，不代表已经发出。',parameters:{type:'object',properties:{candidateId:{type:'string',pattern:'^[a-f0-9]{32}$'}},required:['candidateId'],additionalProperties:false}},
    {name:'wechat_meme_import',description:'当前聊天允许联网补图时，把搜索确认的公开图片 HTTPS 直链加入图库并准备微信发送。仅搜索短公开关键词，不上传聊天原文。需要实际图片地址、内容描述和原搜索词；不能把网页地址当图片。',parameters:{type:'object',properties:{imageUrl:{type:'string',maxLength:1500},description:{type:'string',minLength:1,maxLength:120},query:{type:'string',maxLength:120},tag:{type:'string',pattern:'^[a-z0-9_-]{1,20}$'}},required:['imageUrl','description','query'],additionalProperties:false}},
  ];
  const disposers=definitions.map(definition=>agentCtx.tools.register({...definition,output,async execute(args,exec){
    try{
      if(!active())throw Error('MEME_LIBRARY_NOT_ALLOWED');const turn=turnFor();if(++turn.calls>3)throw Error('MEME_TOOL_LIMIT');
      const signal=AbortSignal.any([turn.controller.signal,AbortSignal.timeout(45000),...(exec?.signal?[exec.signal]:[])]);let result;
      if(definition.name==='wechat_meme_search'){
        if(args.sourceUrl&&(turn.networkOptOut||!turn.allowedUrls?.has(normalizeWebUrl(args.sourceUrl))))throw Error('MEME_SOURCE_NOT_IN_CURRENT_TURN');
        const candidates=args.sourceUrl?await library.searchPage(key,args.sourceUrl,args.query,signal):await library.search(key,args.query,signal);if(turnFor()!==turn||!active())throw Error('MEME_TURN_CHANGED');
        turn.candidates=new Map(candidates.map(item=>[item.candidateId,item]));result={candidates:candidates.map(({route,packId,...item})=>item)};
      }else{
        if(turn.selected||turn.selecting)throw Error('MEME_ONE_SELECTION_PER_TURN');
        turn.selecting=true;
        try{
          if(definition.name==='wechat_meme_select'){const candidate=turn.candidates?.get(args.candidateId);if(!candidate)throw Error('MEME_CANDIDATE_NOT_IN_TURN');result=await library.select(key,candidate,signal);}
          else {if(turn.networkOptOut)throw Error('MEME_NETWORK_IMPORT_DISABLED');if(!turn.allowedUrls?.has(normalizeWebUrl(args.imageUrl))&&![...(turn.candidates?.values()??[])].some(item=>item.imageUrl===args.imageUrl))throw Error('MEME_SOURCE_NOT_IN_CURRENT_TURN');result=await library.importUrl(key,args,signal);}
        }finally{turn.selecting=false;}
        signal.throwIfAborted();if(turnFor()!==turn||!active())throw Error('MEME_TURN_CHANGED');turn.selected=true;turn.choices.push(result);result={...result,reply:'RESPOND: [STICKER:'+result.id+']',notice:'本次发送资源已准备，收藏待筛选或保存失败不影响当前发送；实际微信发送由桥接层核验并确认回执。'};
      }
      return {content:JSON.stringify(result),isError:false};
    }catch(error){return {content:JSON.stringify({error:/^MEME_[A-Z_0-9]+$/.test(error.message)?error.message:'MEME_OPERATION_FAILED',notice:'本次未准备新的可发送表情；可继续文字回复，不声称已经发图。'}),isError:true};}
  }}));
  // Visibility follows the chat-level policy only, so the tool list in the
  // system prompt stays byte-stable across turns (prefix-cache friendly);
  // executability stays turn-aware via active(). See social-tool-restrict.
  const names=()=>new Set(policy().enabled?definitions.filter(item=>item.name!=='wechat_meme_import'||policy().allowImport&&policy().network).map(item=>item.name):[]);
  const access={names,definitions:()=>definitions.filter(item=>names().has(item.name)),check:name=>active()&&definitions.some(item=>item.name===name)&&(name!=='wechat_meme_import'||policy().allowImport&&policy().network&&!turnFor().networkOptOut)};
  Object.defineProperty(agentCtx,MEME_LIBRARY_POLICY,{value:access,configurable:true});
  const dispose=()=>{for(const disposer of disposers)disposer?.();delete agentCtx[MEME_LIBRARY_POLICY];};
  dispose.instructions=()=>active()?'[微信表情图库]\n需要表情时先用 wechat_meme_search 搜索 dsh-meme 本地图库，再用 wechat_meme_select 选择一张。只使用工具本轮确认的完整 [STICKER:资源ID] 标记，不使用 dsh-meme 网页的 [表情:描述] 标记。资源准备成功不表示微信已发送，由本项目负责回执确认。图库没有合适结果且本轮确有 wechat_meme_import 工具时，先用现有 web_search 搜索短公开素材关键词，再调用 wechat_meme_search(query,sourceUrl=本轮来源链接)提取真实图片候选，最后 select 选图；新图会经过 dsh-meme 识图核验并入库。直接图片链接可用 import 导入。每轮最多一次选图，失败继续正常文字回复。保持当前人设，不为凑图强行发图。\n':'';
  return dispose;
}
