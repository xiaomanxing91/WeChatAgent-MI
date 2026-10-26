import {calendarDate,qualifyWeatherCity,requestedWeatherDates} from './weather-query.mjs';
const SOURCE='https://open-meteo.com/';
const clean=value=>String(value??'').replace(/[\u0000-\u001f\u007f<>]/g,' ').trim().slice(0,80);
const norm=value=>clean(value).toLowerCase().normalize('NFD').replace(/\p{Mark}/gu,'').replace(/[省市县区]/g,'').replace(/\s/g,'');
const wmo={0:'晴',1:'大致晴朗',2:'局部多云',3:'阴',45:'雾',48:'冻雾',51:'小毛毛雨',53:'毛毛雨',55:'强毛毛雨',56:'冻毛毛雨',57:'强冻毛毛雨',61:'小雨',63:'中雨',65:'大雨',66:'冻雨',67:'强冻雨',71:'小雪',73:'中雪',75:'大雪',77:'雪粒',80:'阵雨',81:'中等阵雨',82:'强阵雨',85:'小阵雪',86:'强阵雪',95:'雷暴',96:'伴冰雹雷暴',97:'强雷暴',99:'伴强冰雹雷暴'};
function validPlace(place){return Number.isSafeInteger(place.id)&&place.id>0&&Number.isFinite(place.latitude)&&Math.abs(place.latitude)<=90&&Number.isFinite(place.longitude)&&Math.abs(place.longitude)<=180&&typeof place.name==='string'&&typeof place.timezone==='string'&&/^PPL/.test(place.feature_code??'');}
async function json(url,fetchImpl,signal){
  const response=await fetchImpl(url,{redirect:'error',signal,headers:{Accept:'application/json'}});
  if(!response.ok||!response.body)throw Error('WEATHER_HTTP_FAILED');
  const reader=response.body.getReader(),chunks=[];let size=0;
  try{for(;;){const {done,value}=await reader.read();if(done)break;size+=value.byteLength;if(size>131072)throw Error('WEATHER_RESPONSE_TOO_LARGE');chunks.push(value);}}
  finally{await reader.cancel().catch(()=>{});reader.releaseLock();}
  const result=JSON.parse(Buffer.concat(chunks).toString('utf8'));if(!result||result.error)throw Error('WEATHER_RESPONSE_INVALID');return result;
}
export function chooseWeatherPlace(results,city){
  const {name,admin}=qualifyWeatherCity(city);
  let matches=(results??[]).filter(validPlace).filter(p=>norm(p.name)===norm(name));
  if(admin)matches=matches.filter(p=>[p.admin1,p.country,p.country_code].some(value=>norm(value)===norm(admin)));
  // Prefer a unique administrative city over same-name villages. Tied cities need clarification.
  const cities=matches.filter(p=>/^PPLC$|^PPLA\d?$/.test(p.feature_code));if(cities.length)matches=cities;
  matches=matches.filter((p,i,a)=>a.findIndex(other=>other.id===p.id)===i);
  if(!matches.length)throw Error('WEATHER_NOT_FOUND');
  if(matches.length!==1)throw Error('WEATHER_AMBIGUOUS');
  calendarDate(Date.now(),matches[0].timezone);return matches[0];
}
const number=(value,min,max)=>typeof value==='number'&&Number.isFinite(value)&&value>=min&&value<=max;
export async function fetchWeather(request,{fetchImpl=fetch,timeoutMs=8000,now=Date.now,signal:parentSignal}={}){
  const signal=parentSignal?AbortSignal.any([parentSignal,AbortSignal.timeout(timeoutMs)]):AbortSignal.timeout(timeoutMs),{name,admin}=qualifyWeatherCity(request.city);
  const geoUrl=new URL('https://geocoding-api.open-meteo.com/v1/search');geoUrl.searchParams.set('name',admin?name+', '+admin:name);geoUrl.searchParams.set('count','10');geoUrl.searchParams.set('language',/[\p{Script=Han}]/u.test(request.city)?'zh':'en');geoUrl.searchParams.set('format','json');
  const geo=await json(geoUrl,fetchImpl,signal),place=chooseWeatherPlace(geo.results,request.city),at=now(),dates=requestedWeatherDates(request,at,place.timezone);
  const forecastUrl=new URL('https://api.open-meteo.com/v1/forecast');
  for(const[k,v]of Object.entries({latitude:place.latitude,longitude:place.longitude,timezone:place.timezone,forecast_days:16,current:'temperature_2m,weather_code',daily:'weather_code,temperature_2m_max,temperature_2m_min,precipitation_probability_max',temperature_unit:'celsius'}))forecastUrl.searchParams.set(k,String(v));
  const data=await json(forecastUrl,fetchImpl,signal);
  if(data.timezone!==place.timezone||!Array.isArray(data.daily?.time)||data.daily_units?.temperature_2m_max!=='°C'||data.daily_units?.temperature_2m_min!=='°C'||data.daily_units?.precipitation_probability_max!=='%')throw Error('WEATHER_RESPONSE_INVALID');
  const location=[place.country,place.admin1,place.name].map(clean).filter((v,i,a)=>v&&a.indexOf(v)===i).join(' / '),lines=[];
  if(request.current&&dates[0]===calendarDate(at,place.timezone)&&number(data.current?.temperature_2m,-100,70)&&wmo[data.current.weather_code]&&typeof data.current.time==='string'&&data.current.time.startsWith(dates[0])&&data.current_units?.temperature_2m==='°C')lines.push(`当前预报（当地 ${clean(data.current.time)}）：${wmo[data.current.weather_code]}，${data.current.temperature_2m}°C。`);
  for(const date of dates){
    const i=data.daily.time.indexOf(date),lo=data.daily.temperature_2m_min?.[i],hi=data.daily.temperature_2m_max?.[i],rain=data.daily.precipitation_probability_max?.[i],code=data.daily.weather_code?.[i];
    if(i<0||!number(lo,-100,70)||!number(hi,-100,70)||lo>hi||!Number.isInteger(code)||!wmo[code]||rain!==null&&!number(rain,0,100))throw Error('WEATHER_RESPONSE_INVALID');
    lines.push(`${date}：${wmo[code]}；气温 ${lo}～${hi}°C；${rain===null?'降水概率暂缺':'最大降水概率 '+rain+'%'}。`);
  }
  const snippet=`${lines.join('\n')}\n地点：${location}；时区：${clean(place.timezone)}。\n数据来自 Open-Meteo（地点由 GeoNames 解析）；属于预报，降水概率不能说成一定下雨。每日数据不能用来断言具体小时天气。查询时间：${new Date(at).toISOString()}。`;
  return {items:[{title:`${clean(place.name)} ${dates[0]}${dates.length>1?'起'+dates.length+'天':''}天气预报`,url:SOURCE,snippet,kind:'weather'}],at,timezone:place.timezone,dates,location};
}
