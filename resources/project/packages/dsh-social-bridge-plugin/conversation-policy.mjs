const KEY=/^wechat:(private|group):[1-9]\d{0,15}$/;
export const validChatKey=value=>typeof value==='string'&&KEY.test(value)&&Number.isSafeInteger(Number(value.split(':')[2]));
export const allowedConversation=(wechat,key)=>validChatKey(key)&&(wechat?.whitelist?.[key.split(':')[1]==='group'?'groups':'private']??[]).some(id=>String(id)===key.split(':')[2]);
const names=(value,tool=false)=>Array.isArray(value)&&value.length<=50&&value.every(name=>typeof name==='string'&&name.length>=1&&name.length<=120&&!/[\u0000-\u001f\u007f<>]/.test(name)&&(!tool||/^[\w.:-]+$/.test(name)))&&new Set(value).size===value.length;
export function validateConversationSettings(wechat){
  const modes=wechat?.chatModes;
  if(modes!==undefined&&(!modes||typeof modes!=='object'||Array.isArray(modes)||Object.entries(modes).some(([key,mode])=>!validChatKey(key)||!key.startsWith('wechat:group:')||!['hybrid','mention'].includes(mode))))throw Error('Invalid per-chat wake_mode');
  const access=wechat?.dshAccess;
  if(access!==undefined&&(!access||typeof access!=='object'||Array.isArray(access)||Object.keys(access).some(key=>key!=='chats')||!access.chats||typeof access.chats!=='object'||Array.isArray(access.chats)||Object.entries(access.chats).some(([key,value])=>!validChatKey(key)||!value||typeof value!=='object'||Array.isArray(value)||Object.keys(value).some(field=>!['skills','tools'].includes(field))||!names(value.skills??[])||!names(value.tools??[],true))))throw Error('Invalid DSH chat access');
}
export function conversationMode(wechat,key){validateConversationSettings(wechat);return wechat?.chatModes?.[key]??wechat?.wake_mode??'hybrid';}
export function conversationAccess(wechat,key){validateConversationSettings(wechat);if(!allowedConversation(wechat,key))return {skills:[],tools:[]};const value=wechat?.dshAccess?.chats?.[key]??{};return {skills:[...value.skills??[]],tools:[...value.tools??[]]};}
