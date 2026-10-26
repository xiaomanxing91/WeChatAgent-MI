const TOPIC = /天气|气温|下(?:不下)?雨|降雨|降水|下(?:不下)?雪|多少度|几度|冷不冷|热不热|带伞|weather|forecast/i;
const BLOCK = /不要(?:联网|搜索|查)|不用(?:联网|搜索|查)|别(?:联网|搜索|查)/;
const SCIENCE = /(?:天气|气温|降水|降雨).*(?:原理|形成原因|怎么形成|如何形成|定义|接口|API)|(?:你|您).*(?:能|会|支持|可以).*(?:查天气|查询天气|天气查询)/i;
const DATES = /(?:\d{4}-\d{1,2}-\d{1,2}|\d{1,2}月\d{1,2}[日号]?|\d+天后|未来[一二两三四五六七八九十\d]+天|大后天|今天|明天|后天|昨天|前天|现在|当前|目前|实时|这周|本周|一周|未来|今晚|下午|上午|晚上|早上)/g;
const PROVINCES = /^(北京|上海|天津|重庆|浙江|江苏|安徽|福建|江西|山东|河南|湖北|湖南|广东|广西|海南|四川|贵州|云南|陕西|甘肃|青海|河北|山西|辽宁|吉林|黑龙江|内蒙古|宁夏|新疆|西藏)(?:省|市|自治区)?(.+)$/;
export function weatherIntent(value) {
  const text=String(value??'').trim();
  if(!TOPIC.test(text)||BLOCK.test(text)||SCIENCE.test(text)||/CPU|显卡|电脑|水温|体温|发烧|烤箱/i.test(text))return false;
  return /[？?]|吗|呢|怎样|如何|怎么样|咋样|啥天气|多少|几度|会不会|下不下|冷不冷|热不热|有没有|查|搜|预报|(?:天气|气温)$|^(?:weather|forecast)\b/i.test(text);
}
export function weatherCity(value) {
  let text=String(value??'').replace(/^@\S+[\s\u2005]+/,'').replace(/^(?:(?:你|您)(?:能不能|可不可以|能否|可以|能)|能不能|可不可以|能否|可以|可否)\s*/,'').replace(/https?:\/\/\S+|\[CQ:[^\]]*\]/gi,' ').replace(DATES,' ')
    .replace(/(?:请问|帮我|帮忙|麻烦|我想知道|我想查|告诉我|我在|我位于|现在在|查询|搜索|查一下|查查|看一下|看看|搜一下|一下|查|搜)/g,' ')
    .replace(/(?:天气预报|天气|气温|预报|降水概率|降水|降雨|会不会下雨|下不下雨|下雨|会不会下雪|下不下雪|下雪|冷不冷|热不热|多少度|几度|怎么样|咋样|怎样|如何|多少|什么|啥|是不是|会不会|有没有|是否|需要带伞|带伞|用不用|要不要|情况|会|的|吗|呢|啊|呀|[？?！!，。;；:：])/g,' ')
    .replace(/\b(?:weather|forecast|today|tomorrow|now|current|in|please|check|for)\b/gi,' ').replace(/\s+/g,' ').trim();
  text=text.replace(/^在\s*/,'');
  if(!text||/^(?:这里|这边|本地|当地|附近|家里|我这里|我们这里|哪[个里]|哪个城市|你好|哈哈|谢谢|不知道|不清楚|不用|算了|取消|没事|好的|行|好)$/.test(text))return null;
  if(text.length<2||text.length>32||!/^([\p{Script=Han}A-Za-z][\p{Script=Han}A-Za-z .'-]*)(?:, [A-Za-z .'-]+)?$/u.test(text))return null;
  return text;
}
export function weatherRequest(text,{force=false,referenceAt}={}) {
  if(!force&&!weatherIntent(text))return null;
  const value=String(text),city=weatherCity(value);
  const range=/未来([一二两三四五六七八九十\d]+)天/.exec(value);
  const numerals={一:1,二:2,两:2,三:3,四:4,五:5,六:6,七:7,八:8,九:9,十:10};
  const count=range?(numerals[range[1]]??Number(range[1])):/一周|这周|本周/.test(value)?7:1;
  const after=/(\d+)天后/.exec(value);
  const offset=after?Number(after[1]):/大后天/.test(value)?3:/后天/.test(value)?2:/明天|tomorrow/i.test(value)?1:/前天/.test(value)?-2:/昨天/.test(value)?-1:0;
  const iso=/(\d{4})-(\d{1,2})-(\d{1,2})/.exec(value),month=/(\d{1,2})月(\d{1,2})[日号]?/.exec(value);
  return {city,offset,count,explicitDate:iso?iso.slice(1).map(Number):month?[null,Number(month[1]),Number(month[2])]:null,current:/现在|目前|当前|实时|\bnow\b|\bcurrent\b/i.test(value),referenceAt};
}
export function qualifyWeatherCity(value) {
  if(value.includes(',')){const [name,admin]=value.split(',').map(part=>part.trim());return {name,admin};}
  const plain=value.replace(/市$/,''),match=PROVINCES.exec(plain);
  return match?{name:match[2].replace(/[市县区]$/,''),admin:match[1]}:{name:plain,admin:''};
}
export function calendarDate(at,timezone) {
  const parts=new Intl.DateTimeFormat('en-CA',{timeZone:timezone,year:'numeric',month:'2-digit',day:'2-digit'}).formatToParts(new Date(at));
  return ['year','month','day'].map(key=>parts.find(p=>p.type===key).value).join('-');
}
export function requestedWeatherDates(request,at,timezone) {
  const today=calendarDate(at,timezone),base=calendarDate(request.referenceAt??at,timezone);
  let start=new Date(base+'T00:00:00Z');
  if(request.explicitDate){const [year,month,day]=request.explicitDate;start=new Date(Date.UTC(year??Number(base.slice(0,4)),month-1,day));if(start.getUTCMonth()!==month-1||start.getUTCDate()!==day)throw Error('WEATHER_DATE_UNSUPPORTED');}
  else start.setUTCDate(start.getUTCDate()+request.offset);
  const offset=Math.round((start.getTime()-Date.parse(today+'T00:00:00Z'))/86400000);
  if(!Number.isInteger(request.count)||request.count<1||request.count>7||offset<0||offset+request.count>16)throw Error('WEATHER_DATE_UNSUPPORTED');
  return Array.from({length:request.count},(_,i)=>new Date(start.getTime()+i*86400000).toISOString().slice(0,10));
}
export const WEATHER_STATUS = Object.freeze({
  needs_location:'天气查询缺少城市。请询问用户要查哪个城市；不能猜测位置，也不能把缺少城市说成不支持联网。',
  weather_ambiguous:'天气查询地点有多个匹配。请让用户补充省份或完整城市名，不选择未经确认的位置。',
  weather_not_found:'未找到该天气查询地点。请用户确认城市名或补充省份；没有获得天气数据。',
  weather_date_unsupported:'天气查询日期无效或超出范围。当前支持今天起未来16天内的预报，单次最多7天；请确认日期。',
  weather_failed:'天气数据请求失败或返回内容不完整。本轮未获得有效天气信息，请明确说明暂时未查到，不能编造气温或降雨概率。',
  irrelevant:'搜索结果与问题不相关，本轮未取得可用资料；请说明未查到，不能用无关结果回答。',
  failed:'联网请求失败或超时，本轮没有取得搜索资料。',
  empty:'搜索没有返回可用结果，本轮没有取得搜索资料。',
  disabled:'该聊天的联网搜索已关闭，本轮没有联网资料。',
  unavailable:'联网组件当前不可用，本轮没有取得搜索资料。'
});
