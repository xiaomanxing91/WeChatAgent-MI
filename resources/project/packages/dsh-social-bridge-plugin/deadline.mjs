// Race even services that do not observe AbortSignal. Late results are consumed
// but can no longer complete the caller's turn.
export async function boundedTask(action, {timeoutMs, signal, code='OPERATION_TIMEOUT'}={}) {
  const controller=new AbortController();
  const abort=()=>controller.abort(signal.reason);
  if(signal?.aborted)abort();else signal?.addEventListener('abort',abort,{once:true});
  const timer=setTimeout(()=>controller.abort(Object.assign(new Error(code),{name:'TimeoutError',code})),timeoutMs);
  let listener;
  try {
    controller.signal.throwIfAborted();
    return await Promise.race([
      Promise.resolve().then(()=>action(controller.signal)),
      new Promise((_,reject)=>{listener=()=>reject(controller.signal.reason);controller.signal.addEventListener('abort',listener,{once:true});}),
    ]);
  } finally {
    clearTimeout(timer);signal?.removeEventListener('abort',abort);
    if(listener)controller.signal.removeEventListener('abort',listener);
  }
}
