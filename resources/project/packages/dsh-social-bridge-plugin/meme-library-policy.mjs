export const MEME_LIBRARY_POLICY=Symbol.for('wechatagent.meme-library.v1');
export function memeLibraryPolicy(wechat,key){
  const match=/^wechat:(private|group):([1-9]\d{0,15})$/.exec(key??''),settings=wechat?.memeLibrary??{};
  const allowed=!!match&&Number.isSafeInteger(Number(match[2]))&&(wechat.whitelist?.[match[1]==='group'?'groups':'private']??[]).some(id=>String(id)===match[2]);
  return {enabled:allowed&&(settings.chats?.[key]??settings.enabled??false)===true&&(wechat.stickers?.chats?.[key]??wechat.stickers?.enabled??true)===true,allowImport:settings.allowImport===true};
}
export function validateMemeLibrarySettings(settings){
  if(settings===undefined)return;
  if(!settings||typeof settings!=='object'||Array.isArray(settings)||Object.keys(settings).some(key=>!['enabled','allowImport','chats'].includes(key)))throw Error('Invalid meme library settings');
  for(const key of ['enabled','allowImport'])if(settings[key]!==undefined&&typeof settings[key]!=='boolean')throw Error('Invalid meme library switch');
  if(settings.chats!==undefined&&(!settings.chats||typeof settings.chats!=='object'||Array.isArray(settings.chats)||Object.entries(settings.chats).some(([key,value])=>!/^wechat:(private|group):[1-9]\d{0,15}$/.test(key)||typeof value!=='boolean')))throw Error('Invalid meme library chat settings');
}
