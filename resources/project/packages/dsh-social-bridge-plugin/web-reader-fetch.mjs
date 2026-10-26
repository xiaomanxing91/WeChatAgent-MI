// 只读 HTTP(S) 安全抓取工具：供 qq-bridge / MCP 共用。
// 设计目标与 mcp-web-search-safe 一致：
// - 仅 http/https
// - 禁止 localhost / .local / 私有 IP / 环回 / 链路本地 / CGNAT 等内网地址
// - 域名先 DNS 解析并检查全部解析结果，避免 DNS rebinding
// - 手动跟随重定向，每一跳重新校验
// - 响应体限量读取，每次请求有包含响应体的总时限
import dns from 'node:dns';
import net from 'node:net';
import http from 'node:http';
import https from 'node:https';
import { createGunzip, createInflate, createBrotliDecompress } from 'node:zlib';
import { normalizeWebUrl, WEB_READER_LIMITS } from './web-reader-policy.mjs';

const dnsLookup = dns.promises.lookup;

function withTimeout(promise, ms, label) {
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(`操作超时(${ms}ms)：${label}`)), ms);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

function ipv4FromLast32(lower) {
  const parts = String(lower || '').split(':');
  if (parts.length < 2) return null;
  const last = parts[parts.length - 1];
  const secondLast = parts[parts.length - 2];
  if (/^\d+\.\d+\.\d+\.\d+$/.test(last)) return last;
  if (/^[0-9a-f]{1,4}$/.test(secondLast) && /^[0-9a-f]{1,4}$/.test(last)) {
    const num = (parseInt(secondLast, 16) << 16) + parseInt(last, 16);
    return `${(num >>> 24) & 255}.${(num >>> 16) & 255}.${(num >>> 8) & 255}.${num & 255}`;
  }
  return null;
}

function parseEmbeddedIpv4(h) {
  const lower = String(h || '').toLowerCase().replace(/^\[|\]$/g, '');
  if (!lower.includes(':')) return null;
  const dotted = lower.match(/(\d+\.\d+\.\d+\.\d+)$/);
  if (dotted) return dotted[1];
  const m = lower.match(/^::(?:ffff:)?([0-9a-f]{1,4}):([0-9a-f]{1,4})$/i);
  if (m) {
    const num = (parseInt(m[1], 16) << 16) + parseInt(m[2], 16);
    return `${(num >>> 24) & 255}.${(num >>> 16) & 255}.${(num >>> 8) & 255}.${num & 255}`;
  }
  // 兼容 ::ffff:0:7f00:1、::ffff:0:c0a8:101、::c0a8:101 等非规范 IPv4-mapped/compatible 写法。
  if (lower.startsWith('::ffff:') || lower.startsWith('::')) {
    const embedded = ipv4FromLast32(lower);
    if (embedded) return embedded;
  }
  // NAT64 前缀（64:ff9b::/96 与 64:ff9b:1::/48）内嵌 IPv4，例如 64:ff9b::c0a8:101 -> 192.168.1.1
  if (lower.startsWith('64:ff9b')) {
    const embedded = ipv4FromLast32(lower);
    if (embedded) return embedded;
  }
  const nat64 = lower.match(/^64:ff9b:(?:::)?(?:([0-9a-f]{1,4}):([0-9a-f]{1,4})|(\d+\.\d+\.\d+\.\d+))$/i);
  if (nat64) {
    if (nat64[3]) return nat64[3];
    const num = (parseInt(nat64[1], 16) << 16) + parseInt(nat64[2], 16);
    return `${(num >>> 24) & 255}.${(num >>> 16) & 255}.${(num >>> 8) & 255}.${num & 255}`;
  }
  return null;
}

export function isPrivateIp(ip) {
  let h = String(ip || '').toLowerCase().replace(/^\[|\]$/g, '');
  const family = net.isIP(h);
  // DNS 返回值也必须是有效 IP；不能把非法地址当成公网地址。
  if (!family || h.includes('%')) return true;
  if (family === 6) h = new URL(`http://[${h}]/`).hostname.slice(1, -1);

  if (net.isIP(h) === 4) {
    const parts = h.split('.').map(Number);
    if (parts[0] === 10) return true;
    if (parts[0] === 127) return true;
    if (parts[0] === 0) return true;
    if (parts[0] === 169 && parts[1] === 254) return true;
    if (parts[0] === 172 && parts[1] >= 16 && parts[1] <= 31) return true;
    if (parts[0] === 192 && parts[1] === 168) return true;
    if (parts[0] === 100 && parts[1] >= 64 && parts[1] <= 127) return true;
    if (parts[0] === 198 && parts[1] >= 18 && parts[1] <= 19) return true;
    if (parts[0] === 192 && parts[1] === 0 && parts[2] === 0) return true;
    if (parts[0] >= 224) return true;
    return false;
  }

  if (net.isIP(h) === 6) {
    if (!/^[23]/.test(h) || /^2001:(?:0:|:)/i.test(h)) return true;
    if (h === '::' || h === '::1') return true;
    if (h.startsWith('fc') || h.startsWith('fd')) return true;
    if (/^fe[89ab]/.test(h)) return true;
    if (h.startsWith('fec') || h.startsWith('fed') || h.startsWith('fee') || h.startsWith('fef')) return true;
    // 本地 NAT64 前缀的 IPv4 位布局不等同 /96；整个本地前缀均不可供公网抓取。
    if (h.startsWith('64:ff9b:1:')) return true;
    const embedded = parseEmbeddedIpv4(h);
    if (embedded) return isPrivateIp(embedded);
    if (h.startsWith('2001:db8')) return true;
    if (h.startsWith('2001:2:') || h.startsWith('2001:10:') || h.startsWith('2001:20:')) return true;
    const sixth4 = h.match(/^2002:([0-9a-f]{1,4}):([0-9a-f]{1,4}):/i);
    if (sixth4) {
      const num = (parseInt(sixth4[1], 16) << 16) + parseInt(sixth4[2], 16);
      const ipv4 = `${(num >>> 24) & 255}.${(num >>> 16) & 255}.${(num >>> 8) & 255}.${num & 255}`;
      if (isPrivateIp(ipv4)) return true;
    }
    if (h.startsWith('ff')) return true;
    return false;
  }

  return true;
}

export async function resolveSafeHost(hostname) {
  const h = String(hostname || '').toLowerCase().replace(/^\[|\]$/g, '').replace(/\.$/, '');
  if (!h) throw new Error('主机名为空');
  if (h === 'localhost' || h.endsWith('.localhost') || h.endsWith('.local')) {
    throw new Error('禁止访问内网/本机地址');
  }
  if (net.isIP(h)) {
    if (isPrivateIp(h)) throw new Error('禁止访问内网/本机地址');
    return h;
  }
  let addresses;
  try {
    addresses = await withTimeout(dnsLookup(h, { all: true, verbatim: true }), 5000, `DNS 解析 ${h}`);
  } catch (error) {
    throw new Error(`域名解析失败：${error?.message ?? error}`);
  }
  if (!addresses.length) throw new Error('域名没有解析结果');
  if (addresses.every(({address}) => /^198\.(?:18|19)\./.test(address))) throw Error('本机代理 DNS 返回 Fake-IP，当前页面未取得可连接的公网地址，正文读取已停止；此状态不代表 DSH 服务端搜索不可用');
  for (const { address } of addresses) {
    if (isPrivateIp(address)) {
      throw new Error('域名解析到内网/本机地址，已阻止');
    }
  }
  return addresses[0].address;
}

// Reject transition/non-global IPv6 ranges as well as the shared Bridge checks.
export async function validateWebTarget(raw) {
  const url = new URL(normalizeWebUrl(raw));
  const ip = await resolveSafeHost(url.hostname);
  return { url, ip };
}

function abortable(promise, signal) {
  signal.throwIfAborted();
  return new Promise((resolve, reject) => {
    const abort = () => reject(signal.reason ?? Error('读取已取消'));
    signal.addEventListener('abort', abort, { once: true });
    promise.then(resolve, reject).finally(() => signal.removeEventListener('abort', abort));
  });
}

function fetchOnce(url, ip, signal) {
  return new Promise((resolve, reject) => {
    let request, response, decoder, settled = false;
    const destroy = () => { decoder?.destroy(); response?.destroy(); request?.destroy(); };
    const finish = (error, result) => {
      if (settled) return;
      settled = true;
      signal.removeEventListener('abort', abort);
      if (error) { reject(error); destroy(); } else resolve(result);
    };
    const abort = () => {
      finish(Error('网页读取已取消或超时'));
      destroy();
    };
    if (signal.aborted) { abort(); return; }
    signal.addEventListener('abort', abort, { once: true });
    try {
      const hostname = url.hostname.replace(/^\[|\]$/g, '');
      request = (url.protocol === 'https:' ? https : http).request({
        hostname: ip, port: url.port || (url.protocol === 'https:' ? 443 : 80),
        path: url.pathname + url.search, method: 'GET',
        headers: { host: url.host, 'user-agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36 WeChatAgent-WebReader/1.0',
          accept: 'text/html,application/xhtml+xml,text/plain;q=0.8', 'accept-encoding': 'gzip, deflate, br', 'accept-language': 'zh-CN,zh;q=0.9,en;q=0.7' },
        servername: url.protocol === 'https:' && !net.isIP(hostname) ? hostname : undefined,
        rejectUnauthorized: true,
      }, res => {
        response = res;
        res.on('error', error => finish(error));
        res.on('aborted', () => finish(Error('网页响应中断')));
        const status = res.statusCode ?? 0;
        if ([301,302,303,307,308].includes(status)) {
          finish(null, { redirect: String(res.headers.location ?? '') }); res.destroy(); return;
        }
        if (status < 200 || status >= 300) {
          finish(Error([401,403,412,429].includes(status) ? `网页要求登录、拒绝访问或触发访问验证（HTTP ${status}），未取得正文` : `网页读取失败（HTTP ${status}）`)); return;
        }
        const type = String(res.headers['content-type'] ?? '').toLowerCase();
        const mime = type.split(';')[0].trim();
        if (!['text/html','application/xhtml+xml','text/plain'].includes(mime)) {
          finish(Error('只支持 HTML 或纯文本网页，当前响应类型不支持')); res.destroy(); return;
        }
        const encoding = String(res.headers['content-encoding'] ?? 'identity').trim().toLowerCase();
        if (['gzip','x-gzip'].includes(encoding)) decoder = createGunzip();
        else if (encoding === 'deflate') decoder = createInflate();
        else if (encoding === 'br') decoder = createBrotliDecompress();
        else if (encoding !== 'identity') { finish(Error('网页响应使用不支持的压缩格式')); return; }
        const readable = decoder ?? res;
        const chunks = []; let size = 0;
        const result = truncated => ({ buffer: Buffer.concat(chunks), contentType: mime, charset: /charset\s*=\s*["']?([^\s;"']+)/i.exec(type)?.[1], truncated });
        // Bound both downloaded bytes and expanded bytes, including compression bombs.
        let downloaded = 0;
        res.on('data', chunk => {
          downloaded += chunk.length;
          if (decoder && downloaded > WEB_READER_LIMITS.bytes) finish(Error('网页压缩响应过大，已停止读取'));
        });
        readable.on('data', chunk => {
          if (settled) return;
          chunks.push(chunk.subarray(0, WEB_READER_LIMITS.bytes - size)); size += chunk.length;
          if (size >= WEB_READER_LIMITS.bytes) { finish(null, result(true)); destroy(); }
        });
        readable.on('end', () => finish(null, result(false)));
        if (decoder) {
          decoder.on('error', () => finish(Error('网页压缩正文损坏，无法解压')));
          res.pipe(decoder);
        }
      });
      request.on('error', error => finish(error));
      request.end();
    } catch (error) { finish(error); request?.destroy(); }
  });
}

export async function fetchWebPage(raw, { signal } = {}) {
  const ownSignal = signal ? AbortSignal.any([signal, AbortSignal.timeout(WEB_READER_LIMITS.timeoutMs)]) : AbortSignal.timeout(WEB_READER_LIMITS.timeoutMs);
  let current = normalizeWebUrl(raw);
  for (let hop = 0; hop <= 5; hop++) {
    const { url, ip } = await abortable(validateWebTarget(current), ownSignal);
    ownSignal.throwIfAborted();
    const result = await fetchOnce(url, ip, ownSignal);
    if (result.redirect !== undefined) {
      if (!result.redirect) throw Error('网页重定向缺少目标地址');
      current = normalizeWebUrl(new URL(result.redirect, url).href); continue;
    }
    const declared = /<meta\s+[^>]*(?:charset\s*=\s*["']?([^\s"'/>;]+)|content\s*=\s*["'][^"']*charset=([^\s"';>]+))/i.exec(result.buffer.subarray(0,4096).toString('ascii'));
    const charset = result.charset ?? declared?.[1] ?? declared?.[2] ?? 'utf-8';
    let decoder;
    try { decoder = new TextDecoder(charset); } catch { throw Error('网页字符编码不支持'); }
    return { url: url.href, body: decoder.decode(result.buffer), contentType: result.contentType, truncated: result.truncated };
  }
  throw Error('网页重定向次数过多');
}

