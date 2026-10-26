import { normalizeWebUrl, WEB_READER_LIMITS } from './web-reader-policy.mjs';

const ORIGIN = 'https://zxsj-tools.cn';
const SERVERS = {
  一剑诛仙:'yijianzhuxian',世外桃源:'shiwaitaoyuan',君临天下:'junlintianxia',唯我独尊:'weiwoduzun',
  孤心撼海:'guxinhanhai',明月天涯:'mingyuetianya',星河入梦:'xingherumeng',浮生若梦:'fushengruomeng',
  瑶光沁雪:'yaoguangqinxue',风华绝代:'fenghuajuedai',风灵月影:'fenglingyueying',
};
const COINS = {nws:{name:'女娲石',unit:'个'},yl:{name:'银两',unit:'万银'}};
export function isZxsjPricePage(raw) {
  const url = new URL(normalizeWebUrl(raw));
  return url.hostname === 'zxsj-tools.cn' && url.pathname === '/yinliang.html' && !url.port;
}
export function zxsjQuoteHints(message) {
  // Only these public enum values can leave the machine; never send chat text.
  const text = String(message);
  const coins = [...new Set([...text.matchAll(/女娲石|银两/g)].map(m=>m[0]==='女娲石'?'nws':'yl'))];
  const servers = Object.entries(SERVERS).filter(([name])=>text.includes(name)||name==='浮生若梦'&&/浮生(?:服|的|区)/.test(text)).map(([,slug])=>slug);
  return {coin:coins.length===1?coins[0]:undefined,server:servers.length===1?servers[0]:undefined};
}
function serverSlug(value) {
  const slug = SERVERS[value] ?? value;
  if (typeof slug !== 'string' || !/^[a-z]{1,40}$/.test(slug)) throw Error('区服无效，请使用页面列出的区服名称或标识');
  return slug;
}
function requestFor(raw, {coin,server}={}, hints={}) {
  if (!isZxsjPricePage(raw)) throw Error('此报价适配器只支持诛仙世界工具站行情页面');
  const page = new URL(normalizeWebUrl(raw));
  if (page.searchParams.getAll('coin').length>1 || page.searchParams.getAll('server').length>1) throw Error('报价链接包含重复币种或区服');
  const selectedCoin = coin ?? hints.coin ?? page.searchParams.get('coin') ?? 'yl';
  if (!Object.hasOwn(COINS,selectedCoin)) throw Error('币种无效，请选择女娲石 nws 或银两 yl');
  const selectedServer = server ?? hints.server ?? page.searchParams.get('server');
  return {coin:selectedCoin,server:selectedServer ? serverSlug(selectedServer) : undefined};
}

/** Fixed first-party adapter endpoint, never a model-selected JSON fetcher.
 * HTTPS hostname verification stays enabled. Normal OS/TUN routing is used for
 * this constant public host, including proxy Fake-IP translation. No redirects,
 * caller headers, cookies, credentials or arbitrary hosts/paths are accepted.
 * General webpage DNS/private-address protections remain in fetchWebPage.
 */
export async function fetchZxsjQuotes({coin,server,signal}, fetchImpl=globalThis.fetch) {
  if (!Object.hasOwn(COINS,coin) || !/^[a-z]{1,40}$/.test(server??'')) throw Error('报价参数无效');
  const url = new URL('/api/yinliang',ORIGIN);url.searchParams.set('coin',coin);url.searchParams.set('server',server);
  const bounded = signal ? AbortSignal.any([signal,AbortSignal.timeout(WEB_READER_LIMITS.timeoutMs)]) : AbortSignal.timeout(WEB_READER_LIMITS.timeoutMs);
  bounded.throwIfAborted();
  const response = await fetchImpl(url.href,{method:'GET',redirect:'manual',credentials:'omit',headers:{Accept:'application/json'},signal:bounded});
  const cancel = async()=>{try{await response.body?.cancel();}catch{}};
  if(response.status!==200){await cancel();throw Error('报价接口请求失败（HTTP '+response.status+'），未取得价格');}
  if(response.redirected || response.url && new URL(response.url).href!==url.href){await cancel();throw Error('报价接口发生非预期跳转');}
  if(!/^application\/json(?:\s*;|$)/i.test(response.headers.get('content-type')??'')){await cancel();throw Error('报价接口未返回 JSON 数据');}
  if(Number(response.headers.get('content-length')??0)>WEB_READER_LIMITS.bytes){await cancel();throw Error('报价响应过大');}
  const reader=response.body?.getReader();if(!reader)throw Error('报价接口没有返回数据');
  const chunks=[];let bytes=0;
  try {
    while(true){bounded.throwIfAborted();const {done,value}=await reader.read();if(done)break;bytes+=value.byteLength;if(bytes>WEB_READER_LIMITS.bytes)throw Error('报价响应过大');chunks.push(value);}
    bounded.throwIfAborted();
    try{return JSON.parse(Buffer.concat(chunks).toString('utf8'));}catch{throw Error('报价接口返回了无效 JSON');}
  } finally {try{await reader.cancel();}catch{}}
}

export async function readZxsjPricePage(raw, {coin,server,hints,signal}={}, fetchQuotes=fetchZxsjQuotes, now=Date.now) {
  const request=requestFor(raw,{coin,server},hints), selected=request.server??'yaoguangqinxue';
  const data=await fetchQuotes({coin:request.coin,server:selected,signal});signal?.throwIfAborted();
  if(data?.ok!==true || data.coinId!==request.coin || data.serverSlug!==selected || data.unit!==COINS[request.coin].unit || !Array.isArray(data.servers) || !Array.isArray(data.offers)) throw Error('报价接口返回的币种、区服或数据格式不匹配');
  const servers=data.servers.slice(0,80).filter(s=>s&&typeof s.name==='string'&&/^[\p{Script=Han}a-z0-9·]{1,24}$/iu.test(s.name)&&typeof s.slug==='string'&&/^[a-z]{1,40}$/.test(s.slug)).map(s=>({name:s.name,slug:s.slug}));
  const current=servers.find(s=>s.slug===selected);if(!current)throw Error('未找到该区服，请确认工具站支持的区服');
  const page=new URL('/yinliang.html',ORIGIN);page.searchParams.set('coin',request.coin);if(request.server)page.searchParams.set('server',request.server);
  const base={url:page.href,title:'诛仙世界行情比价',scope:'market_quotes',coin:request.coin,coinName:COINS[request.coin].name,currency:'CNY',unit:COINS[request.coin].unit,checkedAt:new Date(now()).toISOString()};
  if(!request.server)return {...base,status:'selection_required',servers,text:'尚未指定区服，不能把默认区服报价当作用户区服价格。请先确认区服：'+servers.map(s=>s.name).join('、')+'。'};
  if(typeof data.updatedAt!=='number'||!Number.isFinite(data.updatedAt)||data.updatedAt<=0||data.updatedAt>now()+300000)throw Error('报价接口没有有效的数据更新时间');
  const validNumber=x=>typeof x==='number'&&Number.isFinite(x)&&x>0&&x<=1e12;
  if(data.offers.length>500)throw Error('报价接口挂单数量异常');
  const offers=data.offers.filter(o=>o&&validNumber(o.price)&&validNumber(o.amount)&&validNumber(o.money)&&['7881','DD373','UU898'].includes(o.platform)).sort((a,b)=>a.price-b.price).map(o=>({price:o.price,amount:o.amount,total:o.money,platform:o.platform}));
  if(data.offers.length&&!offers.length)throw Error('报价接口未返回有效价格，不使用搜索标题代替');
  const updatedAt=new Date(data.updatedAt).toISOString(),stale=now()-data.updatedAt>600000,quotes=offers.slice(0,10);
  const summary={...base,status:offers.length?'ready':'empty',server:request.server,serverName:current.name,updatedAt,stale,cacheSeconds:Math.min(300,Math.max(0,Number.isFinite(data.cachedFor)?data.cachedFor:60)),offerCount:offers.length,minimumPrice:offers[0]?.price??null,quotes,quotesTruncated:offers.length>quotes.length,partial:!!(data.errors&&Object.keys(data.errors).length)};
  const lines=quotes.map(o=>`${o.platform}：${o.price} 元/${base.unit}；数量 ${o.amount} ${base.unit}；总价 ${o.total} 元`);
  return {...summary,text:[`${current.name} · ${base.coinName}，单位：人民币元/${base.unit}。`,offers.length?`已取得 ${offers.length} 条有效挂单，最低单价 ${summary.minimumPrice} 元/${base.unit}。`:'当前区服暂无挂单，不能理解为价格为零。',...lines,`数据更新时间 ${updatedAt}；站点缓存约 ${summary.cacheSeconds} 秒。`,summary.partial?'部分平台取数失败，仅代表已成功返回的平台。':'',stale?'该报价快照已超过十分钟，不能声称是实时价格。':'', '数据为第三方挂单报价，不代表实际成交价格。'].filter(Boolean).join('\n')};
}
