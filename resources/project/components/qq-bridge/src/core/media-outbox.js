import {boundedTask} from '../../../../packages/dsh-social-bridge-plugin/deadline.mjs';

// Media delivery has its own durable lane. It never owns the model/chat lock.
export class MediaOutbox {
  constructor({buffer,send,policy,quota,noteOutgoing,retry,log}) {
    Object.assign(this,{buffer,send,policy,quota,noteOutgoing,retry,log});
    this.running=new Map();this.timers=new Map();this.stopped=false;
    for(const item of buffer.mediaReplies.values())this.wake(item.key);
  }
  enqueue(key,pending,part) {
    if(this.buffer.mediaReplies.has(part.deliveryId)){this.wake(key);return;}
    const peers=[...this.buffer.mediaReplies.values()].filter(item=>item.key===key);
    if(peers.length>=3||this.buffer.mediaReplies.size>=64){
      this.buffer.setContextNotice(key,{id:part.deliveryId,text:'本机待发表情队列已满，本轮配图已取消；文字回复继续。'});return;
    }
    const now=Date.now();
    this.buffer.mediaReplies.set(part.deliveryId,{key,message:pending.message,part:{...part},createdAt:now,expiresAt:now+this.retry.mediaDeadlineMs});
    this.buffer.saveMedia();this.wake(key);
  }
  wake(key,at=Date.now()) {
    if(this.stopped||this.running.has(key)||this.timers.has(key))return;
    this.timers.set(key,setTimeout(()=>{this.timers.delete(key);void this.run(key);},Math.max(0,at-Date.now())));
  }
  finish(item,reason) {
    if(['sending','submitted'].includes(item.part.state)){
      // Release only the adapter's matching receipt reservation. This RPC has
      // no native-send path and cannot submit the abandoned image again.
      void boundedTask(()=>this.send(item.message,item.part.stickerId,{deliveryId:item.part.deliveryId,receiptOnly:true,abandon:true}),{timeoutMs:1000}).catch(()=>{});
    }
    this.buffer.mediaReplies.delete(item.part.deliveryId);this.buffer.saveMedia();
    if(reason)this.buffer.setContextNotice(item.key,{id:item.part.deliveryId,text:reason});
  }
  async run(key) {
    if(this.stopped||this.running.has(key))return;
    const item=[...this.buffer.mediaReplies.values()].find(item=>item.key===key);if(!item)return;
    const controller=new AbortController();this.running.set(key,controller);let nextAt=Date.now();
    const {part}=item,receiptOnly=['sending','submitted'].includes(part.state);
    try {
      if(Date.now()>=item.expiresAt){this.finish(item,'本机上一轮配图已超过等待时限，不再提交；已提交的图片送达情况未知，不能声称已收到。');return;}
      if(!receiptOnly){
        const allowed=await boundedTask(()=>this.policy(item.message),{timeoutMs:1000,signal:controller.signal});
        if(!allowed.enabled){this.finish(item,'本机表情开关关闭，待发配图取消。');return;}
        const readyAt=this.quota(key);
        if(readyAt>=item.expiresAt){this.finish(item,'本机发送额度不足，本轮配图已取消，后续文字继续按发送限额处理。');return;}
        if(readyAt>Date.now()){nextAt=readyAt;return;}
      }
      if(part.retryAt>Date.now()){nextAt=Math.min(part.retryAt,item.expiresAt);return;}
      if(receiptOnly)part.receiptChecks=(part.receiptChecks??0)+1;
      part.state='sending';delete part.retryAt;this.buffer.saveMedia();
      let delivery;
      try {
        delivery=await boundedTask(()=>this.send(item.message,part.stickerId,{deliveryId:part.deliveryId,deferReceipt:true,deadlineAt:item.expiresAt,...(receiptOnly?{receiptOnly:true}:{})}),
          {timeoutMs:Math.max(1,Math.min(this.retry.mediaCallTimeoutMs,item.expiresAt-Date.now())),signal:controller.signal,code:'MEDIA_DELIVERY_TIMEOUT'});
      } catch(error) {
        if(this.stopped)return;
        if(error.code==='SENDER_BUSY'){
          part.state=receiptOnly?'submitted':'queued';if(receiptOnly)part.receiptChecks--;
          part.busyAttempts=(part.busyAttempts??0)+1;
          if(part.busyAttempts>this.retry.maxBusyRetries){this.finish(item,'本机发送器持续忙碌，上一轮配图已终结，文字回复继续。');return;}
          part.retryAt=nextAt=Math.min(item.expiresAt,Date.now()+Math.min(5000,this.retry.busyDelayMs*2**(part.busyAttempts-1)));return;
        }
        if(error.code&&!['STICKER_DELIVERY_UNCONFIRMED','MEDIA_DELIVERY_TIMEOUT'].includes(error.code)){
          this.finish(item,'本机上一轮表情发送失败或未能确认送达，不自动重发，继续回应新消息。');
          this.log(`[Social] ${key} media_failed reason=${error.code}`);return;
        }
        // A timed-out/lost RPC may already have submitted the sticker.
        delivery={delivered:'unconfirmed'};
      }
      if(this.stopped)return;
      const confirmed=delivery?.delivered!=='unconfirmed',at=Date.now();part.state=confirmed?'confirmed':'submitted';
      if(confirmed)this.buffer.mediaReplies.delete(part.deliveryId);
      const existing=this.buffer.recent(key,this.buffer.maxPerChat).some(row=>row.outgoing&&row.delivery_id===part.deliveryId);
      this.buffer.recordReplyPart(key,{deliveryId:part.deliveryId},{...item.message,sender_id:item.message.self_id,timestamp:at/1000,text:confirmed?'[已发送微信原生表情包]':'[微信原生表情已提交，送达待确认]',delivery_status:confirmed?'confirmed':'unconfirmed',sticker_id:part.stickerId});
      if(!existing)this.noteOutgoing(key,at);
      this.log(`[Social] ${key} media_delivery=${confirmed?'confirmed':'unconfirmed'} operation=${part.deliveryId.slice(0,12)}`);
      if(confirmed){this.finish(item);return;}
      if((part.receiptChecks??0)>=this.retry.maxReceiptChecks){this.finish(item,'本机上一轮表情送达未确认；不重复提交，继续回应新消息。');return;}
      nextAt=Math.min(item.expiresAt,Date.now()+this.retry.receiptDelayMs);
    } catch(error) {
      if(!this.stopped){this.finish(item,'本机配图处理异常，本轮配图已终结，文字回复继续。');this.log(`[Social] ${key} media_failed reason=${error.code??'MEDIA_PROCESS_FAILED'}`);}
    } finally {
      if(!this.stopped&&this.buffer.mediaReplies.has(part.deliveryId))this.buffer.saveMedia();
      this.running.delete(key);if(!this.stopped&&[...this.buffer.mediaReplies.values()].some(item=>item.key===key))this.wake(key,nextAt);
    }
  }
  stop(){this.stopped=true;for(const timer of this.timers.values())clearTimeout(timer);this.timers.clear();for(const controller of this.running.values())controller.abort(new Error('media_stopped'));}
}
