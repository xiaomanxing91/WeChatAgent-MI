import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { buildConversationKey } from './conversation-key.js';
import { normalizeForwardedRecord, normalizeQuoteReply } from './wechat-events.js';

export function replyDeliveryParts(result,deliveryId) {
  const parts=result.decision==='RESPOND'?(result.textParts??[result.text]).map(text=>({text})):[];
  if(result.stickerId)parts.push({stickerId:result.stickerId});
  return parts.map((part,index)=>({...part,deliveryId:index===0?deliveryId:crypto.createHash('sha256').update(deliveryId+(part.stickerId?'\0sticker':'\0text-2')).digest('hex'),state:'queued'}));
}
function validReplyParts(item){
  if(item.parts===undefined)return true;
  const expected=replyDeliveryParts(item.result,item.deliveryId);
  return Array.isArray(item.parts)&&item.parts.length===expected.length&&item.parts.length<=3&&item.parts.every((part,index)=>{
    const target=expected[index];
    return part&&part.text===target.text&&part.stickerId===target.stickerId&&part.deliveryId===target.deliveryId&&
      ['queued','sending','submitted','confirmed','unconfirmed','failed','cancelled','expired'].includes(part.state)&&
      ['busyAttempts','receiptChecks'].every(name=>part[name]===undefined||Number.isSafeInteger(part[name])&&part[name]>=0&&part[name]<=10)&&
      ['retryAt','busyDeadline'].every(name=>part[name]===undefined||Number.isSafeInteger(part[name])&&part[name]>=0);
  })&&(item.deliveryNotice===undefined||typeof item.deliveryNotice==='string'&&item.deliveryNotice.length<=1000);
}

/** Small persistent recent-message buffer. Corrupt files fail closed and are never overwritten. */
export class MessageBuffer {
  constructor(file, { maxPerChat = 300 } = {}) {
    this.file = file;
    this.maxPerChat = Math.min(1000, Math.max(10, Number(maxPerChat) || 300));
    this.chats = new Map();
    this.pendingReplies=new Map();
    this.mediaReplies=new Map();
    this.contextNotices=new Map();
    if (fs.existsSync(file)) {
      const saved = JSON.parse(fs.readFileSync(file, 'utf8'));
      if (saved.version !== 1 || !saved.chats || typeof saved.chats !== 'object') throw new Error('invalid message buffer');
      for (const [key, rows] of Object.entries(saved.chats)) {
        if (!Array.isArray(rows)) throw new Error(`invalid message buffer chat ${key}`);
        this.chats.set(key, rows.slice(-this.maxPerChat).map((row) => ({ ...row, id: row.id ?? crypto.randomUUID() })));
      }
      for(const [key,item] of Object.entries(saved.pendingReplies??{})){
        if(!item||!/^[a-f0-9]{64}$/.test(item.deliveryId??'')||typeof item.throughId!=='string'||
          !['RESPOND','STICKER'].includes(item.result?.decision)||
          item.result.decision==='RESPOND'&&(typeof item.result.text!=='string'||!item.result.text.trim()||item.result.text.length>1200)||
          item.result.textParts!==undefined&&(!Array.isArray(item.result.textParts)||item.result.textParts.length!==2||item.result.textParts.some(part=>typeof part!=='string'||!part.trim())||item.result.textParts.join('\n\n')!==item.result.text)||
          item.result.decision==='STICKER'&&!/^[a-f0-9]{64}$/.test(item.result.stickerId??'')||!item.message||
          item.result.stickerId!==undefined&&!/^[a-f0-9]{64}$/.test(item.result.stickerId)||!validReplyParts(item)||
          buildConversationKey(item.message.platform,item.message.kind,item.message.conversation_id)!==key)throw Error('invalid reply outbox');
        this.pendingReplies.set(key,item);
      }
      for(const [key,item] of Object.entries(saved.contextNotices??{})){
        if(!item||typeof item.id!=='string'||typeof item.text!=='string'||item.text.length>1000)throw Error('invalid context notice');
        this.contextNotices.set(key,item);
      }
      for(const [id,item] of Object.entries(saved.mediaReplies??{})){
        if(!/^[a-f0-9]{64}$/.test(id)||item?.part?.deliveryId!==id||!/^[a-f0-9]{64}$/.test(item.part.stickerId??'')||
          !['queued','sending','submitted'].includes(item.part.state)||!item.message||
          buildConversationKey(item.message.platform,item.message.kind,item.message.conversation_id)!==item.key||
          !['createdAt','expiresAt'].every(name=>Number.isSafeInteger(item[name])&&item[name]>=0)||item.expiresAt<item.createdAt||item.expiresAt-item.createdAt>60000||
          ['busyAttempts','receiptChecks'].some(name=>item.part[name]!==undefined&&(!Number.isSafeInteger(item.part[name])||item.part[name]<0||item.part[name]>10)))throw Error('invalid media outbox');
        this.mediaReplies.set(id,item);
      }
      if(this.mediaReplies.size>64)throw Error('media outbox limit');
    }
  }

  append(message, { outgoing = false } = {}) {
    const key = buildConversationKey(message.platform, message.kind, message.conversation_id);
    if(!outgoing){const existing=this.findIncoming(message);if(existing)return existing;}
    const row = { id: crypto.randomUUID(), platform: message.platform, kind: message.kind,
      conversation_id: String(message.conversation_id), sender_id: String(message.sender_id ?? ''),
      conversation_name: String(message.conversation_name ?? message.conversation_id),
      sender_name: String(message.sender_name ?? ''), message_id: String(message.message_id ?? ''),
      ...(!outgoing&&message.kind==='group'&&/^[a-f0-9]{64}$/.test(message.sender_key??'')?{sender_key:message.sender_key}:{}),
      self_id:String(message.self_id??''),
      text: String(message.text ?? '').slice(0, 4000), timestamp: Number(message.timestamp) || Date.now() / 1000,
      images: outgoing ? [] : (message.images ?? []).filter(image => /^[a-f0-9]{64}$/.test(image?.id ?? '')).slice(0,4),
      direct_mention: Boolean(message.direct_mention), outgoing, processed: outgoing };
    if(!outgoing && message.interaction==='pat')row.interaction='pat';
    const record=!outgoing && normalizeForwardedRecord(message.forwardedRecord);
    if(record)row.forwardedRecord=record;
    const quoteReply=!outgoing && normalizeQuoteReply(message.quoteReply);
    if(quoteReply)row.quoteReply=quoteReply;
    const rows = this.chats.get(key) ?? [];
    rows.push(row);
    if (rows.length > this.maxPerChat) rows.splice(0, rows.length - this.maxPerChat);
    this.chats.set(key, rows);
    this.#save();
    return row;
  }

  findIncoming(message){
    if(!message.message_id)return null;
    const key=buildConversationKey(message.platform,message.kind,message.conversation_id);
    return (this.chats.get(key)??[]).find(row=>!row.outgoing&&row.message_id===String(message.message_id)&&
      row.sender_id===String(message.sender_id??'')&&row.text===String(message.text??'').slice(0,4000))??null;
  }
  rememberReply(key,item){
    const message=item.message;
    this.pendingReplies.set(key,{...item,message:{platform:message.platform,kind:message.kind,conversation_id:String(message.conversation_id),
      conversation_name:String(message.conversation_name??''),self_id:String(message.self_id??''),sender_id:String(message.sender_id??''),sender_name:String(message.sender_name??'')}});
    this.#save();
  }
  forgetReply(key){this.pendingReplies.delete(key);this.#save();}
  saveMedia(){this.#save();}
  setContextNotice(key,item){this.contextNotices.set(key,item);this.#save();}
  recordReplyPart(key,item,outgoing){
    const rows=this.chats.get(key)??[];
    const existing=rows.find(row=>row.outgoing&&row.delivery_id===item.deliveryId);
    if(outgoing&&existing?.delivery_status==='unconfirmed'&&outgoing.delivery_status==='confirmed'){
      existing.delivery_status='confirmed';existing.text=String(outgoing.text).slice(0,4000);
    }
    if(outgoing&&!existing){
      rows.push({id:crypto.randomUUID(),platform:outgoing.platform,kind:outgoing.kind,conversation_id:String(outgoing.conversation_id),
        conversation_name:String(outgoing.conversation_name??''),sender_id:String(outgoing.sender_id??''),sender_name:'AI',
        message_id:'out-'+item.deliveryId,text:String(outgoing.text).slice(0,4000),timestamp:outgoing.timestamp,
        images:[],direct_mention:false,outgoing:true,processed:true,delivery_id:item.deliveryId,delivery_status:outgoing.delivery_status,proactive:outgoing.proactive===true,
        ...(/^[a-f0-9]{64}$/.test(outgoing.sticker_id??'')?{sticker_id:outgoing.sticker_id}:{})});
    }
    if(rows.length>this.maxPerChat)rows.splice(0,rows.length-this.maxPerChat);
    this.chats.set(key,rows);this.#save();
  }
  completeReply(key,item,outgoing){
    if(outgoing)this.recordReplyPart(key,item,outgoing);
    const rows=this.chats.get(key)??[];
    if(rows.some(row=>row.id===item.throughId))for(const row of rows){row.processed=true;if(row.id===item.throughId)break;}
    if(rows.length>this.maxPerChat)rows.splice(0,rows.length-this.maxPerChat);
    this.chats.set(key,rows);this.pendingReplies.delete(key);
    if(item.noticeId&&this.contextNotices.get(key)?.id===item.noticeId)this.contextNotices.delete(key);
    this.#save();
  }

  recent(key, limit = 50) { return (this.chats.get(key) ?? []).slice(-Math.min(this.maxPerChat, Math.max(1, Number(limit) || 50))); }
  keys() { return [...this.chats.keys()]; }
  unread(key, limit = 50) { return this.recent(key, this.maxPerChat).filter((row) => !row.processed).slice(0, limit); }
  markProcessed(key, throughId = null, noticeId = null) {
    const rows = this.chats.get(key) ?? [];
    if (throughId && !rows.some((row) => row.id === throughId)) return;
    for (const row of rows) {
      row.processed = true;
      if (throughId && row.id === throughId) break;
    }
    if(noticeId&&this.contextNotices.get(key)?.id===noticeId)this.contextNotices.delete(key);
    this.#save();
  }

  #save() {
    fs.mkdirSync(path.dirname(this.file), { recursive: true });
    const chats = Object.fromEntries(this.chats);
    const temp = `${this.file}.${process.pid}.tmp`;
    fs.writeFileSync(temp, JSON.stringify({ version: 1, chats,pendingReplies:Object.fromEntries(this.pendingReplies),mediaReplies:Object.fromEntries(this.mediaReplies),contextNotices:Object.fromEntries(this.contextNotices) }), { mode: 0o600 });
    fs.renameSync(temp, this.file);
  }
}
