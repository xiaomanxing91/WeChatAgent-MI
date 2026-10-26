import path from 'node:path';
import crypto from 'node:crypto';
import {runConsoleCommand,windowsPowerShellExecutable} from './console-process.mjs';

const failure = message => Object.assign(new Error(message), {status:409});
async function helper(root,mode,request) {
  if (process.platform !== 'win32') throw failure('进程检查需要 Windows。');
  let output='';
  const code=await runConsoleCommand({exe:windowsPowerShellExecutable(),args:['-NoProfile','-NonInteractive','-ExecutionPolicy','Bypass','-File',path.join(root,'scripts/process-recovery.ps1'),'-Mode',mode,'-RequestBase64',Buffer.from(JSON.stringify(request)).toString('base64')]},chunk=>{output=(output+chunk).slice(-1024*1024);},{cwd:root,timeoutMs:25000});
  let result;try{result=JSON.parse(output.trim());}catch{throw failure('无法检查进程，请查看系统权限后重新检查。');}
  if(code!==0||result.error)throw failure(result.stopped?.length?'部分进程已停止，请重新检查剩余进程。':result.error==='PROCESS_CHANGED'?'进程或端口已变化，请重新检查后再确认。':'进程操作未完成，请重新检查。系统进程或无权确认身份的进程不会被停止。');
  return result;
}
const fingerprint=item=>JSON.stringify([item.pid,item.start,item.path?.toLowerCase(),item.commandHash,[...(item.ports??[])].sort()]);
const publicItem=item=>({id:item.id,pid:item.pid,name:item.name,path:item.path,ports:item.ports??[],reason:item.reason,canStop:item.canStop===true,blockedReason:item.blockedReason??''});

export function createProcessRecovery({root,probe=request=>helper(root,'Inspect',request),stop=request=>helper(root,'Stop',request),now=Date.now,ttlMs=120000}={}) {
  const scans=new Map(),confirmations=new Map();let busy=false;
  const prune=()=>{for(const map of [scans,confirmations])for(const [id,value] of map)if(value.expiresAt<=now())map.delete(id);};
  const request=(config,healthyPorts,includeMatchingWeChat)=>({root,ports:[...Object.values(config.ports),Number(new URL(config.hook.baseUrl).port||80)].filter(port=>!healthyPorts.includes(port)),wechatExecutable:path.resolve(root,config.hook.wechatExecutable),protectedPids:[process.pid],includeMatchingWeChat});
  return {
    async scan(config,revision,{healthyPorts=[],includeMatchingWeChat=false}={}) {
      prune();const input=request(config,healthyPorts,includeMatchingWeChat),result=await probe(input);
      const items=(Array.isArray(result)?result:result.items??[]).slice(0,32).map(item=>({...item,id:crypto.randomUUID()}));
      const id=crypto.randomUUID(),scan={revision,input,items,expiresAt:now()+ttlMs};scans.set(id,scan);
      while(scans.size>4)scans.delete(scans.keys().next().value);
      return {scanId:id,expiresAt:scan.expiresAt,items:items.map(publicItem)};
    },
    async prepare(scanId,ids,revision) {
      prune();const scan=scans.get(scanId);
      if(!scan||scan.revision!==revision)throw failure('检查结果或配置已变化，请重新检查进程。');
      if(!Array.isArray(ids)||!ids.length||ids.length>16||new Set(ids).size!==ids.length)throw failure('请选择需要停止的进程。');
      const items=ids.map(id=>scan.items.find(item=>item.id===id));
      if(items.some(item=>!item||item.canStop!==true))throw failure('所选进程不能停止，请重新检查。');
      const token=crypto.randomUUID(),confirmation={revision,input:scan.input,items,expiresAt:now()+ttlMs};confirmations.set(token,confirmation);
      while(confirmations.size>4)confirmations.delete(confirmations.keys().next().value);
      return {confirmation:token,expiresAt:confirmation.expiresAt,items:items.map(publicItem)};
    },
    async stop(token,confirmed,revision) {
      prune();const confirmation=confirmations.get(token);
      if(!confirmation||confirmed!==true||confirmation.revision!==revision)throw failure('确认已过期或配置已变化，请重新检查并再次确认。');
      if(busy)throw failure('正在停止进程，请等待完成。');
      confirmations.delete(token);busy=true;
      try {
        const result=await probe(confirmation.input),current=Array.isArray(result)?result:result.items??[];
        for(const item of confirmation.items)if(!current.some(next=>next.canStop===true&&fingerprint(next)===fingerprint(item)))throw failure('进程或端口已变化，请重新检查后再确认。');
        const resultStop=await stop({...confirmation.input,items:confirmation.items.map(({id,...item})=>item)});
        return {ok:true,stopped:resultStop.stopped??[],message:'进程处理完成。请重新打开所需程序，再重试原操作。'};
      } finally {busy=false;}
    }
  };
}
