// Trusted, bundled skill policy. Chat text cannot grant permissions.
export const WEB_READER_TOOL = 'web_reader_read';
export const WEB_READER_POLICY = Symbol.for('wechatagent.builtin-web-reader.v1');
export const WEB_READER_LIMITS = Object.freeze({ pages: 3, bytes: 512 * 1024, chars: 12000, timeoutMs: 15000 });

export function validateWebReaderSettings(value) {
  if (value === undefined) return;
  if (!value || typeof value !== 'object' || Array.isArray(value) ||
      value.enabled !== undefined && typeof value.enabled !== 'boolean') throw Error('Invalid webReader settings');
}

export function webReaderEnabled(wechat, key) {
  validateWebReaderSettings(wechat?.webReader);
  const match = /^wechat:(private|group):([1-9]\d{0,15})$/.exec(key);
  return !!match && Number.isSafeInteger(Number(match[2])) &&
    wechat?.whitelist?.[match[1] === 'group' ? 'groups' : 'private']?.some(id => String(id) === match[2]) &&
    (wechat.webReader?.enabled ?? true);
}

// Chat text reaches the model HTML-escaped (& -> &amp;) so that a message can
// never forge the <untrusted_chat> wrapper. That escaping also rewrites the "&"
// separators inside a pasted URL, so the same link normalizes to two different
// strings depending on whether it came from the raw buffer or from the prompt.
// The allow-list check then rejects the reader call and the model reports that
// the web tool is switched off. Undo only the entities the encoder emits.
const unescapeEntities = value => String(value)
  .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#0*39;/g, "'").replace(/&amp;/g, '&');

export function normalizeWebUrl(raw) {
  if (typeof raw !== 'string' || raw.length > 2048) throw Error('网页链接过长或无效');
  raw = unescapeEntities(raw.trim());
  // Chinese requests often touch an ASCII hostname without a space. Keep the
  // actual hostname; preserve Unicode in paths, queries and international domains.
  raw = raw.replace(/^((?:https?:\/\/)?(?:[a-z0-9-]+\.)+(?:com|cn|net|org|tv|io|dev|edu|gov|co|me|info|app|ai|xyz|top|cc|uk|de|jp|hk|tw))(?=\p{Script=Han})[\s\S]*$/iu, '$1');
  if (/^(?:www\.|(?:[a-z0-9](?:[a-z0-9-]*[a-z0-9])?\.)+(?:com|cn|net|org|tv|io|dev|edu|gov|co|me|info|app|ai|xyz|top|cc|uk|de|jp|hk|tw)(?=[:/?#]|$))/i.test(raw)) raw = 'https://' + raw;
  let url;
  try { url = new URL(raw); } catch { throw Error('网页链接无效'); }
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password ||
      url.port && !['80', '443'].includes(url.port)) throw Error('仅支持不带账号密码的公开 HTTP(S) 网页（80/443 端口）');
  url.hash = '';
  return url.href;
}

// Shared-links from WeChat/贴吧/B站 carry a long tail of tracking parameters
// (?share=9105&fr=sharewise&unique=...). A model asked to read the page will
// normally drop that tail and request the bare article path, which the exact
// membership check then rejects as unauthorized. Accept a requested URL when it
// points at the same origin+path as an authorized one and introduces no query
// parameter the authorized URL did not have: dropping noise stays allowed,
// widening the target (another id, another page) does not.
export function authorizedWebUrl(requested, urls) {
  let target;
  try { target = new URL(requested); } catch { return false; }
  for (const candidate of urls) if (candidate === requested) return true;
  for (const candidate of urls) {
    let allowed;
    try { allowed = new URL(candidate); } catch { continue; }
    if (target.origin !== allowed.origin || target.pathname !== allowed.pathname) continue;
    const known = new Set([...allowed.searchParams.keys()]);
    if ([...target.searchParams.keys()].every(name => known.has(name))) return true;
  }
  return false;
}

export function webUrls(text, limit = WEB_READER_LIMITS.pages) {
  const urls = [];
  // Do not extract a domain from an email address, filename or another URL's path.
  const pattern = /(?<![a-z0-9_./:@%+-])(?:https?:\/\/|www\.|(?:[a-z0-9](?:[a-z0-9-]*[a-z0-9])?\.)+(?:com|cn|net|org|tv|io|dev|edu|gov|co|me|info|app|ai|xyz|top|cc|uk|de|jp|hk|tw)(?=[:/?#\s<>"'`\\\u0000-\u001f。，；！？、：）】》」』)\]}]|$))[^\s<>"'`\\\u0000-\u001f。，；！？、：）】》」』]*/gi;
  for (let raw of String(text).match(pattern) ?? []) {
    // A pasted ASCII path/query can touch a Chinese request. Keep actual Chinese
    // URL segments and query values, rather than treating every Han character as
    // a delimiter. Only an unmistakable request after a nonempty ASCII tail ends it.
    const suffix = /(?<=[a-z0-9_~.%)-])(?:帮我|帮忙|请(?:你)?|麻烦(?:你)?|能不能|可不可以|你(?:再)?试试)(?:再|先|帮我|试试)?(?:看看|看下|看一下|查查|查下|查一下|问问|读一下|总结|概括|分析|解释|提取|打开|搜索|搜一下|告诉我)/iu.exec(raw);
    if (suffix && !/[/?#=&%]|\.[a-z0-9]{1,8}(?:$|[?#])/i.test(raw.slice(suffix.index))) raw = raw.slice(0, suffix.index);
    raw = raw.replace(/[。，；！？、：）】》」』]+$/u, '');
    while (/[)\]]$/.test(raw) && (raw.match(/[)\]]/g)?.length ?? 0) > (raw.match(/[(\[]/g)?.length ?? 0)) raw = raw.slice(0, -1);
    try { const url = normalizeWebUrl(raw); if (!urls.includes(url)) urls.push(url); } catch {}
    if (urls.length === limit) break;
  }
  return urls;
}

export function incomingWebUrls(rows) {
  return webUrls(rows.filter(row => !row.outgoing && !row.forwardedRecord && row.interaction !== 'pat').map(row => row.text ?? '').join('\n'));
}

export function isWebReadRequest(text) {
  const urls = webUrls(text);
  if (!urls.length) return false;
  if (/阅读|读一下|读这个|读网页|打开|看看|看一下|看下|总结|概括|摘要|分析|解释|提取|内容|文章|网页|链接|read|summari[sz]e|article|webpage/i.test(text)) return true;
  try { return urls.length === 1 && normalizeWebUrl(String(text).trim()) === urls[0]; } catch { return false; }
}
