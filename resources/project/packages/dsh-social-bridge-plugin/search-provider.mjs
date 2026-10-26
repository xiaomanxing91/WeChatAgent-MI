import {Parser} from 'htmlparser2';
const HOSTS=new Set(['www.bing.com','cn.bing.com','bing.com']);
const MAX_BYTES=512*1024;
const tidy=value=>String(value??'').replace(/[\u0000-\u001f\u007f]/g,' ').replace(/\s+/g,' ').trim();
export function searchSourceUrl(raw) {
  try {
    let url=new URL(raw,'https://www.bing.com');
    if(['duckduckgo.com','html.duckduckgo.com'].includes(url.hostname)&&url.pathname==='/l/'&&url.searchParams.has('uddg'))url=new URL(url.searchParams.get('uddg'));
    if(HOSTS.has(url.hostname)&&url.pathname==='/ck/a') {
      const encoded=url.searchParams.get('u');
      if(!encoded?.startsWith('a1')||encoded.length>2048)return null;
      url=new URL(Buffer.from(encoded.slice(2),'base64url').toString('utf8'));
    }
    const host=url.hostname.toLowerCase();
    if(!['http:','https:'].includes(url.protocol)||url.username||url.password||url.port||url.href.length>1024||!host.includes('.')||
      /^\[|^[\d.]+$/.test(host)||/(?:^|\.)(?:localhost|local|internal|test|invalid)$/.test(host))return null;
    url.hash='';return url.href;
  }catch{return null;}
}
export function parseBingPage(body) {
  const records=[],stack=[];let current;
  const parser=new Parser({
    onopentag(name,attrs){
      const parent=stack.at(-1),hidden=parent?.hidden||['script','style','noscript','template'].includes(name)||attrs.hidden!==undefined;
      stack.push({name,hidden,heading:parent?.heading||name==='h2',paragraph:parent?.paragraph||name==='p'});
      if(name==='li'&&/\bb_algo\b/.test(attrs.class??'')&&records.length<10&&!current)current={depth:stack.length,title:'',snippet:'',url:null};
      if(current&&name==='a'&&stack.at(-1)?.heading&&!current.url)current.url=searchSourceUrl(attrs.href);
    },
    ontext(text){
      if(!current||stack.at(-1)?.hidden)return;
      if(stack.at(-1)?.heading)current.title=(current.title+text).slice(0,160);
      else if(stack.at(-1)?.paragraph)current.snippet=(current.snippet+' '+text).slice(0,1000);
    },
    onclosetag(name){
      if(current&&name==='li'&&stack.length===current.depth){if(current.url&&tidy(current.title))records.push({title:tidy(current.title).slice(0,100),url:current.url,snippet:tidy(current.snippet).slice(0,500)});current=undefined;}
      stack.pop();
    },
  },{decodeEntities:true});parser.end(body);
  if(!records.length&&/verify you are human|unusual traffic|请完成验证|输入验证码/i.test(body))throw Error('SEARCH_CHALLENGE');
  return [...new Map(records.map(item=>[item.url,item])).values()];
}
export function parseDuckDuckGoPage(body){
  const records=[],stack=[];let current;
  const parser=new Parser({onopentag(name,attrs){
    const parent=stack.at(-1),classes=attrs.class??'',hidden=parent?.hidden||['script','style','noscript'].includes(name);stack.push({name,classes,hidden,titleLink:parent?.titleLink||/\bresult__a\b/.test(classes),snippetLink:parent?.snippetLink||/\bresult__snippet\b/.test(classes)});
    if(name==='div'&&/\bresult\b/.test(classes)&&!current&&records.length<10)current={depth:stack.length,title:'',snippet:'',url:null};
    if(current&&name==='a'&&/\bresult__a\b/.test(classes))try{current.url=searchSourceUrl(new URL(attrs.href,'https://html.duckduckgo.com').href);}catch{}
  },ontext(text){if(!current||stack.at(-1)?.hidden)return;if(stack.at(-1)?.titleLink)current.title=(current.title+text).slice(0,160);else if(stack.at(-1)?.snippetLink)current.snippet=(current.snippet+' '+text).slice(0,1000);},onclosetag(name){if(current&&stack.length===current.depth&&name==='div'){if(current.url&&tidy(current.title))records.push({title:tidy(current.title).slice(0,100),url:current.url,snippet:tidy(current.snippet).slice(0,500)});current=null;}stack.pop();}},{decodeEntities:true});parser.end(body);
  if(!records.length&&/anomaly\.js|challenge-form|select all squares|verify you are human/i.test(body))throw Error('SEARCH_CHALLENGE');
  return [...new Map(records.map(item=>[item.url,item])).values()];
}
function rssItems(body){
  if(!/<rss\b/i.test(body)||/<!\s*(?:DOCTYPE|ENTITY)\b/i.test(body))throw Error('SEARCH_RESPONSE_INVALID');
  const records=[];let current,field,fieldText='';
  const parser=new Parser({onopentag(name){if(name==='item')current={};if(current&&['title','link','description'].includes(name)){field=name;fieldText='';}},ontext(text){if(field)fieldText+=text;},onclosetag(name){if(current&&name===field){current[field]=tidy(fieldText);field=null;}if(name==='item'&&current){const url=searchSourceUrl(current.link);if(url&&current.title)records.push({title:current.title.slice(0,100),url,snippet:(current.description??'').replace(/<[^>]*>/g,' ').slice(0,500)});current=null;} }},{xmlMode:true,decodeEntities:true});parser.end(body);return records.slice(0,10);
}
export function relevantResults(query,items,{strict=true}={}){
  const normalized=String(query).toLowerCase().replace(/b站|bilibili/g,'哔哩哔哩');
  const hot=/热搜|热榜|热点榜|热门话题/.test(normalized),ranking=!hot&&/排行|榜单|榜首|榜一|排名/.test(normalized);
  const intent=hot?/热搜|热榜|热点榜|热门话题|trending.topic|hot.search/i:ranking?/排行|日榜|周榜|榜单|榜首|榜一|排名|\/rank\//i:null;
  const words=normalized.replace(/今天|明天|目前|最新|现在|最近|实时|今日|第一|多少|是什么|怎么样|咋样|如何|一下|帮我/g,' ');
  const terms=words.match(/[a-z][a-z0-9_-]{1,}/g)??[];
  for(const phrase of words.match(/[\p{Script=Han}]{2,}/gu)??[])for(let i=0;i<phrase.length-1;i++)terms.push(phrase.slice(i,i+2));
  return items.filter(item=>{const text=(item.title+' '+item.snippet+' '+item.url).toLowerCase();
    if(intent)return intent.test(text);
    // 非榜单类问题：严格模式要求命中查询词；宽松模式接受引擎排序，只排除完全无关的空结果。
    return strict?terms.some(term=>text.includes(term)):true;});
}
async function requestPage(url,signal,fetchImpl){
  for(let hop=0;hop<3;hop++){
    const searchPage=HOSTS.has(url.hostname)&&url.pathname==='/search'||url.hostname==='html.duckduckgo.com'&&url.pathname==='/html/';
    if(url.protocol!=='https:'||!searchPage||url.username||url.password||url.port)throw Error('SEARCH_REDIRECT_BLOCKED');
    const response=await fetchImpl(url,{redirect:'manual',signal,headers:{Accept:'text/html,application/rss+xml;q=0.9','Accept-Language':'zh-CN,zh;q=0.9,en;q=0.7','User-Agent':'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36'}});
    if([301,302,303,307,308].includes(response.status)){
      const target=response.headers.get('location');await response.body?.cancel();if(!target)throw Error('SEARCH_REDIRECT_BLOCKED');url=new URL(target,url);continue;
    }
    if(!response.ok){await response.body?.cancel();throw Error('SEARCH_HTTP_'+response.status);}
    if(!response.body)throw Error('SEARCH_RESPONSE_INVALID');
    const reader=response.body.getReader(),chunks=[];let bytes=0;
    try{for(;;){const {done,value}=await reader.read();if(done)break;bytes+=value.byteLength;if(bytes>MAX_BYTES)throw Error('SEARCH_RESPONSE_TOO_LARGE');chunks.push(value);}}
    finally{await reader.cancel().catch(()=>{});reader.releaseLock();}
    return Buffer.concat(chunks).toString('utf8');
  }throw Error('SEARCH_REDIRECT_BLOCKED');
}
export function searchErrorCode(error){
  if(error?.name==='TimeoutError'||error?.name==='AbortError'||/timeout|超时/i.test(error?.message??''))return 'timeout';
  const code=/^SEARCH_(HTTP_\d{3}|CHALLENGE|RESPONSE_INVALID|RESPONSE_TOO_LARGE|REDIRECT_BLOCKED)$/.exec(error?.message??'')?.[1];
  return code?.toLowerCase()??'network_failed';
}
export async function searchPublicWeb(query,{fetchImpl=fetch,signal=AbortSignal.timeout(8000),relaxed=false,perProviderTimeoutMs=3500,providers=['bing-web','duckduckgo']}={}) {
  let lastError,sawUnrelated=false,attempted=[];
  for(const provider of providers){
    signal.throwIfAborted();
    const url=new URL(provider==='bing-web'?'https://www.bing.com/search':'https://html.duckduckgo.com/html/');url.searchParams.set('q',query.replace(/b站|bilibili/gi,'哔哩哔哩'));
    if(provider==='bing-web'){url.searchParams.set('mkt','zh-CN');url.searchParams.set('setlang','zh-hans');}else url.searchParams.set('kl','cn-zh');
    const providerSignal=AbortSignal.any([signal,AbortSignal.timeout(perProviderTimeoutMs)]);
    attempted.push(provider);
    try{const body=await requestPage(url,providerSignal,fetchImpl),raw=provider==='bing-web'?parseBingPage(body):parseDuckDuckGoPage(body),items=relevantResults(query,raw,{strict:!relaxed});
      if(items.length)return {status:'ready',items,provider,attempted};
      sawUnrelated ||= raw.length>0;
    }catch(error){if(signal.aborted)throw error;lastError=searchErrorCode(error);}
  }
  return {status:sawUnrelated?'irrelevant':lastError?'failed':'empty',items:[],errorCode:lastError,attempted};
}
