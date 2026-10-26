import {searchSourceUrl} from './search-provider.mjs';

const clean=(value,size)=>Array.from(typeof value==='string'?value.replace(/<[^>]*>/g,' ').replace(/[\u0000-\u001f\u007f]/g,' ').replace(/\s+/g,' ').trim():'').slice(0,size).join('');
export function nativeSearchErrorCode(error){
  if(error?.name==='AbortError'||error?.name==='TimeoutError'||error?.code==='WEB_ABORTED')return 'native_timeout';
  if(error?.code==='WEB_PROVIDER_CREDENTIAL_MISSING')return 'native_credentials_missing';
  if(/HTTP 401|account sign-in|sign in to DeepSeek again/i.test(error?.message??''))return 'native_signin_required';
  if(['WEB_PROVIDER_UNAVAILABLE','WEB_PROVIDER_CONFIGURED_UNAVAILABLE','WEB_PROVIDER_CONFIGURED_MISSING'].includes(error?.code))return 'native_unavailable';
  if(error?.code==='WEB_PROVIDER_AMBIGUOUS')return 'native_config_error';
  return 'native_failed';
}
function abortable(operation,signal){
  signal.throwIfAborted();
  return new Promise((resolve,reject)=>{
    const aborted=()=>reject(signal.reason);signal.addEventListener('abort',aborted,{once:true});
    Promise.resolve(operation).then(resolve,reject).finally(()=>signal.removeEventListener('abort',aborted));
  });
}
/** Reuse DSH's configured service, inside the initiating social agent's scope.
 * Only public keywords reach it; its account/endpoint configuration remains owned by DSH.
 */
export function createDshSearch({nativeSearch}={}){
  return async(query,{signal=AbortSignal.timeout(20000),timeoutMs=20000,maxResults=3,isAllowed=()=>true}={})=>{
    const check=()=>{signal.throwIfAborted();if(!isAllowed())throw Error('SEARCH_CANCELLED');};
    check();
    if(typeof nativeSearch!=='function')return {status:'failed',provider:'dsh-native',items:[],errorCode:'native_unavailable'};
    const nativeSignal=AbortSignal.any([signal,AbortSignal.timeout(timeoutMs)]);
      try{
        const result=await abortable(nativeSearch({query,maxResults},nativeSignal),nativeSignal);check();
        if(!Array.isArray(result?.sources))return {status:'failed',provider:'dsh-native',items:[],errorCode:'native_response_invalid'};
        const items=[],seen=new Set();
        for(const source of result.sources.slice(0,30)){
          if(typeof source?.url!=='string'||!/^https?:\/\//i.test(source.url))continue;
          const url=searchSourceUrl(source?.url),title=clean(source?.title,100),snippet=clean(source?.snippet,500);
          if(!url||seen.has(url)||!title&&!snippet)continue;
          seen.add(url);items.push({url,title:title||'搜索来源',snippet,...(source?.publishedAt?{publishedAt:clean(source.publishedAt,80)}:{})});
          if(items.length>=maxResults)break;
        }
        if(items.length)return {status:'ready',provider:'dsh-native',items,truncated:result.truncated===true};
        return {status:'empty',provider:'dsh-native',items:[]};
      }catch(error){check();return {status:'failed',provider:'dsh-native',items:[],errorCode:nativeSearchErrorCode(error)};}
  };
}
