export const MEMBER_MEMORY_POLICY=Symbol.for('wechatagent.member-memory.v1');
export const MEMBER_TAGS=Object.freeze(['爱玩梗','表达简短','偏好详细解释','表达直接','语气温和','喜欢提问','乐于分享','喜欢接话','认真讨论']);
export function memberMemoryEnabled(wechat,key){
  const match=/^wechat:group:([1-9]\d{0,15})$/.exec(key??'');
  return !!match&&Number.isSafeInteger(Number(match[1]))&&(wechat?.whitelist?.groups??[]).some(id=>String(id)===match[1])&&(wechat.memberMemory?.chats?.[key]??wechat.memberMemory?.enabled??true)===true;
}
export function validateMemberMemory(settings){
  if(settings===undefined)return;
  if(!settings||typeof settings!=='object'||Array.isArray(settings)||Object.keys(settings).some(key=>!['enabled','chats'].includes(key)))throw Error('Invalid member memory settings');
  if(settings.enabled!==undefined&&typeof settings.enabled!=='boolean')throw Error('Invalid member memory switch');
  if(settings.chats!==undefined&&(!settings.chats||typeof settings.chats!=='object'||Array.isArray(settings.chats)||Object.entries(settings.chats).some(([key,value])=>!/^wechat:group:[1-9]\d{0,15}$/.test(key)||typeof value!=='boolean')))throw Error('Invalid member memory chat settings');
}
