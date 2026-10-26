import fs from 'node:fs';
import path from 'node:path';
import { scanExtensions,extensionConfig,publicSettings,updateExtension } from '../packages/extension-runtime/catalog.mjs';
import { extensionPresentation } from './extension-status.mjs';
const BUNDLED=new Set(['meme-search']);
export function bundledExtensionCatalog(root,base,runtime,config) {
  const installed=scanExtensions(root).filter(item=>BUNDLED.has(item.id));
  if(!installed.length)return base;
  const settings=extensionConfig(root);
  const extras=installed.map(item=>{
    const local=settings.config.extensions[item.id]??{},live=runtime?.extensions?.find(value=>value.id===item.id&&value.revision===item.revision);
    return extensionPresentation({id:item.id,name:item.name,description:item.description,version:item.version,apiVersion:item.apiVersion,revision:item.revision,kind:item.kind,format:item.format,host:'dsh',bundled:true,builtin:false,invalid:!!item.invalid,configSchema:item.configSchema??{},requestedPermissions:item.permissions??[],enabled:local.enabled===true,permissions:local.permissions??[],chats:local.chats??null,settings:publicSettings(item,{...item.settings,...local.settings}),loaded:live?.loaded??false,active:live?.active??false,tools:live?.tools??[],reason:item.invalid?item.reason:local.enabled!==true?'未启用':live?.reason??'等待 DSH 加载'},config,!!runtime);
  });
  return {...base,revision:settings.revision,extensions:[...base.extensions,...extras],runtimeConnected:base.runtimeConnected||!!runtime};
}
export function saveBundledExtension(root,id,body) {
  if(!BUNDLED.has(id)||!fs.existsSync(path.join(root,'extensions/skills',id,'skill.json')))throw Object.assign(Error('扩展不存在。'),{status:404});
  return updateExtension(root,id,body);
}
