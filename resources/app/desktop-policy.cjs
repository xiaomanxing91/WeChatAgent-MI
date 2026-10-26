const path = require('node:path');
const fs = require('node:fs');
const net = require('node:net');

function projectDirectory(resourcesPath, sourceDirectory, packaged) {
  const root = packaged ? path.resolve(resourcesPath, '../../..') : path.resolve(sourceDirectory, '../..');
  for (const name of ['scripts/console-server.mjs', 'config/wechatagent.example.json', 'public/console/index.html']) {
    if (!fs.existsSync(path.join(root, name))) throw new Error('请将桌面应用保留在完整的 WeChatAgent 项目目录中。');
  }
  return root;
}

function safeNavigation(target, origin) {
  try { const url = new URL(target); return url.origin === origin && (url.pathname === '/' || url.pathname === '/index.html'); }
  catch { return false; }
}

function externalWebUrl(value) {
  if (typeof value !== 'string' || value.length > 8192 || /[\u0000-\u0020\u007f]/.test(value)) return null;
  try {
    const url = new URL(value), host = url.hostname.toLowerCase().replace(/^\[|\]$/g, '').replace(/\.$/, '');
    if (!['https:', 'http:'].includes(url.protocol) || url.username || url.password || !host ||
        host === 'localhost' || /\.(?:localhost|local|internal)$/.test(host)) return null;
    if (net.isIP(host) === 4) {
      const [a,b] = host.split('.').map(Number);
      if ([0,10,127].includes(a) || a >= 224 || a === 169 && b === 254 || a === 172 && b >= 16 && b <= 31 ||
          a === 192 && b === 168 || a === 100 && b >= 64 && b <= 127 || a === 198 && [18,19].includes(b)) return null;
    } else if (net.isIP(host) === 6 && (!/^[23]/.test(host) || /^2001:(?:db8|0:|:)/.test(host) || host.startsWith('2002:'))) return null;
    else if (!net.isIP(host) && !host.includes('.')) return null;
    return url.href;
  } catch { return null; }
}

function windowPlacement(saved = {}, workArea) {
  const width = Math.min(workArea.width, Math.max(Math.min(940, workArea.width), Number(saved.width) || Math.min(1240, workArea.width - 60)));
  const height = Math.min(workArea.height, Math.max(Math.min(620, workArea.height), Number(saved.height) || Math.min(850, workArea.height - 60)));
  const x = Number.isFinite(saved.x) ? Math.max(workArea.x, Math.min(saved.x, workArea.x + workArea.width - width)) : workArea.x + Math.round((workArea.width - width) / 2);
  const y = Number.isFinite(saved.y) ? Math.max(workArea.y, Math.min(saved.y, workArea.y + workArea.height - height)) : workArea.y + Math.round((workArea.height - height) / 2);
  return { x: Math.round(x), y: Math.round(y), width: Math.round(width), height: Math.round(height) };
}

module.exports = { projectDirectory, safeNavigation, externalWebUrl, windowPlacement };
