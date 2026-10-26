import crypto from 'node:crypto';
export const CONTINUATION_DEFAULTS=Object.freeze({enabled:false,delayMs:6000,jitterMs:3000});
const chatKey=/^wechat:(private|group):[1-9]\d{0,15}$/;
export function validateContinuationSettings(value){
  if(value===undefined)return;
  if(!value||typeof value!=='object'||Array.isArray(value))throw Error('Invalid continuation settings');
  if(value.enabled!==undefined&&typeof value.enabled!=='boolean')throw Error('Invalid continuation enabled');
  if(value.delayMs!==undefined&&(!Number.isSafeInteger(value.delayMs)||value.delayMs<1000||value.delayMs>60000))throw Error('Invalid continuation delayMs');
  if(value.jitterMs!==undefined&&(!Number.isSafeInteger(value.jitterMs)||value.jitterMs<0||value.jitterMs>30000))throw Error('Invalid continuation jitterMs');
  if(value.chats!==undefined&&(!value.chats||typeof value.chats!=='object'||Array.isArray(value.chats)||Object.entries(value.chats)
    .some(([key,flag])=>!chatKey.test(key)||!Number.isSafeInteger(Number(key.split(':').at(-1)))||typeof flag!=='boolean')))throw Error('Invalid continuation chats');
}
/** Per-chat turn continuation: after a confirmed text reply, allow one proactive
 *  follow-up decision so the persona can continue a turn-based interaction
 *  (e.g. ask the next question in a Q&A game) without waiting to be prompted. */
export function continuationPolicy(wechat,key){
  const settings=wechat?.continuation;validateContinuationSettings(settings);
  const values=Object.fromEntries(Object.entries(CONTINUATION_DEFAULTS).map(([name,value])=>[name,settings?.[name]??value]));
  return {...values,enabled:values.enabled===true&&settings?.chats?.[key]===true};
}
