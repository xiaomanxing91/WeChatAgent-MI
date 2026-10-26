import fs from 'node:fs';import path from 'node:path';
import {allowedConversation} from './conversation-policy.mjs';
export function migrateDshSettings(root,config){
  if(config.wechat.dshAccess!==undefined)return null;
  config.wechat.dshAccess={chats:{}};config.wechat.chatModes??={};
  let legacy={};try{const file=path.join(root,'config/extensions.json'),stat=fs.lstatSync(file);if(stat.isFile()&&!stat.isSymbolicLink()&&stat.size<1048576)legacy=JSON.parse(fs.readFileSync(file,'utf8').replace(/^\uFEFF/,'' )).extensions??{};}catch{}
  const keys=['private','group'].flatMap(kind=>(config.wechat.whitelist[kind==='group'?'groups':'private']??[]).map(id=>'wechat:'+kind+':'+id));
  for(const [id,feature] of [['native-search','search'],['native-stickers','stickers'],['native-proactive','proactive'],['native-context','context']]){
    const gate=legacy[id];if(!gate)continue;const settings=config.wechat[feature]??={};if(gate.enabled!==true)settings.enabled=false;
    if(Array.isArray(gate.chats)){settings.chats??={};for(const key of keys)if(!gate.chats.includes(key))settings.chats[key]=feature==='context'?0:false;}
  }
  const meme=legacy['meme-search'];
  if(meme?.enabled===true&&['web_fetch','storage'].every(permission=>meme.permissions?.includes(permission)))for(const key of keys)if(allowedConversation(config.wechat,key)&&(meme.chats===null||meme.chats?.includes(key)))config.wechat.dshAccess.chats[key]={skills:['meme-search'],tools:['meme-search__search']};
  const settings=meme?.settings??{},result={};if(['auto','bing','openverse','imgflip'].includes(settings.provider))result.provider=settings.provider;
  for(const [key,min,max] of [['maxResults',1,3],['cacheMinutes',1,1440],['cooldownSeconds',5,300]])if(Number.isSafeInteger(settings[key])&&settings[key]>=min&&settings[key]<=max)result[key]=settings[key];
  return result;
}
