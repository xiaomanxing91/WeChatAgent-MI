import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

export const API_VERSION = 1;
export const ID = /^[a-z][a-z0-9-]{0,39}$/;
export const PERMISSIONS = ['web_fetch', 'history_read', 'storage', 'reply'];
export const HOOKS = ['before-context', 'after-response', 'before-tool', 'after-tool'];
export const NATIVE_FEATURES = Object.freeze([
  ['native-search','plugins'],['native-stickers','plugins'],['native-reply-layout','plugins'],
  ['native-proactive','plugins'],['native-context','plugins'],['native-pat','skills'],
]);
export const error = (message, status = 400) => Object.assign(new Error(message), { status });
export const readJson = file => JSON.parse(fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, ''));
export const digest = value => crypto.createHash('sha256').update(value).digest('hex');
export function boundedFile(file, limit = 65536) {
  const stat = fs.lstatSync(file);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size > limit) throw error('扩展文件类型或大小无效。');
  return fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, '');
}
export function within(base, target) {
  const relative = path.relative(path.resolve(base), path.resolve(target));
  return relative !== '' && !relative.startsWith('..' + path.sep) && relative !== '..' && !path.isAbsolute(relative);
}
export function assertPlainTree(directory, budget = { bytes: 0, files: 0 }) {
  if(++budget.files>100)throw error('扩展目录层级或文件数量过多。');
  if (fs.lstatSync(directory).isSymbolicLink()) throw error('扩展目录不能是链接。');
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    const file = path.join(directory, entry.name);
    if (entry.isSymbolicLink() || fs.lstatSync(file).isSymbolicLink()) throw error('扩展不能包含链接。');
    if (entry.name === 'node_modules' || entry.name === '.git') throw error('扩展包不能包含 node_modules 或 .git。');
    if (entry.isDirectory()) assertPlainTree(file, budget);
    else if (entry.isFile()) {
      if (++budget.files > 100 || (budget.bytes += fs.statSync(file).size) > 8 * 1024 * 1024) throw error('扩展最多 100 个文件、8 MiB。');
    } else throw error('扩展包含不支持的文件类型。');
  }
}
function scalar(value) {
  if (value.startsWith('"')) return JSON.parse(value);
  if (value.startsWith("'")) {
    if (!value.endsWith("'")) throw error('Skill 的引号未闭合。');
    return value.slice(1, -1).replaceAll("''", "'");
  }
  if (/^[\[\]{&*!]/.test(value)) throw error('Skill 名称和描述必须使用文字。');
  return value.replace(/\s+#.*$/, '').trim();
}
export function parseSkill(text) {
  const match = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)([\s\S]*)$/.exec(text);
  if (!match) throw error('SKILL.md 需要 YAML 名称和描述。');
  const lines = match[1].split(/\r?\n/), meta = {};
  for (let index = 0; index < lines.length; index++) {
    const field = /^(name|description):\s*(.*)$/.exec(lines[index]);
    if (!field) continue;
    if (Object.hasOwn(meta, field[1])) throw error('Skill 元数据不能重复。');
    if (/^[>|][-+]?\s*$/.test(field[2])) {
      const body = [];
      while (index + 1 < lines.length && /^(\s+|$)/.test(lines[index + 1])) body.push(lines[++index].trim());
      meta[field[1]] = body.join(field[2][0] === '>' ? ' ' : '\n').trim();
    } else meta[field[1]] = scalar(field[2]);
  }
  if (typeof meta.name !== 'string' || !ID.test(meta.name) || typeof meta.description !== 'string' || !meta.description.trim() || meta.description.length > 1024 || !match[2].trim()) throw error('Skill 名称、描述或正文无效。');
  return { id: meta.name, name: meta.name, description: meta.description, version: '1.0.0', apiVersion: 1, permissions: [], settings: {}, configSchema: {}, instructions: match[2].trim() };
}
export function validateSchema(schema, depth = 0) {
  if (depth > 12 || !schema || typeof schema !== 'object' || Array.isArray(schema)) throw error('配置或工具参数 Schema 无效。');
  const allowed = ['type', 'properties', 'required', 'additionalProperties', 'items', 'enum', 'description', 'title', 'default', 'minimum', 'maximum', 'minLength', 'maxLength', 'secret'];
  if (Object.keys(schema).some(key => !allowed.includes(key)) || !['object','array','string','number','integer','boolean'].includes(schema.type)) throw error('Schema 使用了不支持的类型或字段。');
  if (schema.type === 'object') {
    if (schema.properties && (typeof schema.properties !== 'object' || Array.isArray(schema.properties))) throw error('Schema properties 无效。');
    for (const [key, item] of Object.entries(schema.properties ?? {})) { if (['__proto__','constructor','prototype'].includes(key)) throw error('Schema 字段名无效。'); validateSchema(item, depth + 1); }
    if (schema.required && (!Array.isArray(schema.required) || schema.required.some(key => !Object.hasOwn(schema.properties ?? {}, key)))) throw error('Schema required 无效。');
  }
  if (schema.type === 'array') validateSchema(schema.items, depth + 1);
  if (schema.enum && (!Array.isArray(schema.enum) || !schema.enum.length)) throw error('Schema enum 无效。');
  for (const key of ['minimum','maximum','minLength','maxLength']) if (Object.hasOwn(schema,key) && !Number.isFinite(schema[key])) throw error('Schema 范围无效。');
}
export function validateValue(value, schema, label = '参数') {
  const valid = schema.type === 'object' ? value && typeof value === 'object' && !Array.isArray(value)
    : schema.type === 'array' ? Array.isArray(value)
    : schema.type === 'integer' ? Number.isSafeInteger(value)
    : schema.type === 'number' ? typeof value === 'number' && Number.isFinite(value) : typeof value === schema.type;
  if (!valid) throw error(label + '类型无效。');
  if (schema.enum && !schema.enum.includes(value)) throw error(label + '不在允许值中。');
  if (typeof value === 'number' && (value < (schema.minimum ?? -Infinity) || value > (schema.maximum ?? Infinity))) throw error(label + '超出范围。');
  if (typeof value === 'string' && (value.length < (schema.minLength ?? 0) || value.length > (schema.maxLength ?? 16000))) throw error(label + '长度无效。');
  if (schema.type === 'object') {
    for (const key of schema.required ?? []) if (!Object.hasOwn(value,key)) throw error(label + '缺少 ' + key + '。');
    for (const [key, item] of Object.entries(value)) {
      if (Object.hasOwn(schema.properties ?? {}, key)) validateValue(item, schema.properties[key], label + '.' + key);
      else if (schema.additionalProperties !== true) throw error(label + '包含未声明字段 ' + key + '。');
    }
  }
  if (schema.type === 'array') { if (value.length > 100) throw error(label + '数量过多。'); value.forEach(item => validateValue(item, schema.items, label)); }
  return value;
}
export function inspectExtension(directory, kind, native = false) {
  const files = ['skill.json','plugin.json'].filter(name => fs.existsSync(path.join(directory,name)));
  let manifest, format;
  if (files.length > 1) throw error('扩展只能包含一种 JSON 清单。');
  if (files.length) {
    manifest = JSON.parse(boundedFile(path.join(directory, files[0]))); format = 'code';
    if (!manifest || typeof manifest !== 'object' || !ID.test(manifest.id ?? '') || manifest.apiVersion !== 1 || typeof manifest.name !== 'string' || !manifest.name.trim() || manifest.name.length > 80 || typeof manifest.description !== 'string' || manifest.description.length > 1024 || !/^\d+\.\d+\.\d+(?:-[\w.-]+)?$/.test(manifest.version ?? '')) throw error('扩展清单需要有效的 id、name、description、version 和 apiVersion: 1。');
    if(!native && manifest.host && manifest.host!=='dsh')throw error('用户扩展使用 DSH 宿主；Bridge 宿主仅用于内置功能。');
    manifest = { ...manifest, permissions: manifest.permissions ?? [], settings: manifest.settings ?? {}, configSchema: manifest.configSchema ?? {} };
    if (!Array.isArray(manifest.permissions) || manifest.permissions.some(item => !PERMISSIONS.includes(item))) throw error('扩展声明了不支持的权限。');
    if (!Array.isArray(manifest.capabilities ?? []) || (manifest.capabilities ?? []).some(value => !/^[a-z][a-z0-9]*(\.[a-z][a-z0-9-]*)+$/.test(value))) throw error('能力名称无效。');
    if (!Array.isArray(manifest.requires ?? []) || (manifest.requires ?? []).some(value => typeof value !== 'string')) throw error('扩展依赖无效。');
    if(manifest.prompt && (!Array.isArray(manifest.prompt.sections) || manifest.prompt.sections.length>12 || manifest.prompt.sections.some(section=>!section || typeof (section.content ?? section.text)!=='string' || section.priority!==undefined && (!Number.isFinite(section.priority) || section.priority>99))))throw error('提示词片段格式无效。');
    const schema = { type:'object', properties: manifest.configSchema, additionalProperties:false };
    validateSchema(schema); validateValue(manifest.settings, schema, '默认设置');
    // Entry points are fixed. This keeps a manifest from importing outside its package.
    boundedFile(path.join(directory, 'index.js'));
  } else if (kind === 'skills' && fs.existsSync(path.join(directory,'SKILL.md'))) {
    manifest = parseSkill(boundedFile(path.join(directory,'SKILL.md'))); format = 'markdown';
    if (manifest.id !== path.basename(directory)) throw error('Skill 名称必须与目录名一致。');
  } else throw error('找不到 skill.json、plugin.json 或 SKILL.md。');
  if(!native && manifest.id.startsWith('native-'))throw error('native- 是内置扩展的保留名称。');
  assertPlainTree(directory);
  const hashes = [];
  function collect(dir) { for (const name of fs.readdirSync(dir).sort()) { const file = path.join(dir,name); if (fs.statSync(file).isDirectory()) collect(file); else hashes.push(path.relative(directory,file), digest(fs.readFileSync(file))); } }
  collect(directory);
  return { ...manifest, kind, format, directory, revision: digest(JSON.stringify(hashes)) };
}
export function scanExtensions(root) {
  const items = [];
  for(const [id,kind] of NATIVE_FEATURES) {
    const directory=path.join(root,'packages/native-features',kind,id);
    if(!fs.existsSync(directory))continue;
    try{const item=inspectExtension(directory,kind,true);if(item.id!==id)throw error('内置扩展身份不匹配。');items.push({...item,builtin:true,host:'bridge',format:kind==='skills'?'instruction':'code'});}
    catch(cause){items.push({id,name:id,kind,directory,builtin:true,invalid:true,reason:cause.message});}
  }
  const extensionRoot=path.join(root,'extensions');
  if(fs.existsSync(extensionRoot) && fs.lstatSync(extensionRoot).isSymbolicLink())throw error('扩展根目录不能是链接。');
  for (const kind of ['skills','plugins']) {
    const base = path.join(root,'extensions',kind);
    if (!fs.existsSync(base)) continue;
    if (fs.lstatSync(base).isSymbolicLink()) throw error('扩展根目录不能是链接。');
    for (const entry of fs.readdirSync(base,{withFileTypes:true}).slice(0,100)) {
      if (!entry.isDirectory() && !entry.isSymbolicLink()) continue;
      const directory = path.join(base,entry.name);
      try {
        const item = inspectExtension(directory,kind);
        items.push(item);
      } catch (cause) { items.push({ id:entry.name, name:entry.name, kind, directory, invalid:true, reason:cause.message }); }
    }
  }
  // A duplicate identity invalidates every copy, independent of directory order.
  for (const item of items) if (items.filter(other => other.id === item.id).length > 1) { item.invalid = true; item.reason = '扩展 id 重复。'; }
  return items;
}
export function extensionConfig(root) {
  const file = path.join(root,'config/extensions.json');
  const raw = fs.existsSync(file) ? boundedFile(file,262144) : '{"version":1,"extensions":{}}';
  const config = JSON.parse(raw);
  if (config.version !== 1 || !config.extensions || typeof config.extensions !== 'object' || Array.isArray(config.extensions)) throw error('扩展配置无效。');
  return { config, revision:digest(raw) };
}
export function atomicJson(file, value) {
  fs.mkdirSync(path.dirname(file),{recursive:true});
  const temp = file + '.' + crypto.randomUUID() + '.tmp';
  fs.writeFileSync(temp,JSON.stringify(value,null,2)+'\n',{mode:0o600}); fs.renameSync(temp,file);
}
export function publicSettings(item,settings) {
  const result=structuredClone(settings);
  for(const [key,schema] of Object.entries(item.configSchema ?? {}))if(schema.secret)result[key]='';
  return result;
}
export function allowedChat(root,key) {
  try {
    const match = /^wechat:(private|group):([1-9]\d*)$/.exec(key ?? '');
    const config = readJson(path.join(root,'config/wechatagent.json'));
    return !!match && (config.wechat?.whitelist?.[match[1] === 'group' ? 'groups' : 'private'] ?? []).map(String).includes(match[2]);
  } catch { return false; }
}
export function updateExtension(root,id,body) {
  const snapshot = extensionConfig(root);
  if (body.revision !== snapshot.revision) throw error('扩展设置已变化，请刷新后重试。',409);
  const item = scanExtensions(root).find(item => item.id === id && !item.invalid);
  if (!item) throw error('扩展不存在或清单无效。',404);
  if (typeof body.enabled !== 'boolean' || !Array.isArray(body.permissions) || body.permissions.some(value => !item.permissions.includes(value)) || (body.chats !== null && (!Array.isArray(body.chats) || body.chats.some(key => !allowedChat(root,key))))) throw error('启用状态、权限或聊天范围无效。');
  if(!body.settings || typeof body.settings!=='object' || Array.isArray(body.settings))throw error('扩展设置必须是对象。');
  const settings = {...item.settings,...snapshot.config.extensions[id]?.settings,...body.settings};
  for(const [key,schema] of Object.entries(item.configSchema))if(schema.secret && body.settings[key]==='' && snapshot.config.extensions[id]?.settings?.[key])settings[key]=snapshot.config.extensions[id].settings[key];
  validateValue(settings,{type:'object',properties:item.configSchema,additionalProperties:false},'扩展设置');
  snapshot.config.extensions[id] = {enabled:body.enabled,permissions:[...new Set(body.permissions)],chats:body.chats === null ? null : [...new Set(body.chats)],settings};
  atomicJson(path.join(root,'config/extensions.json'),snapshot.config);
  return extensionConfig(root);
}
export function importExtension(root, source) {
  if (typeof source !== 'string' || !path.isAbsolute(source) || /[\0\r\n]/.test(source)) throw error('请选择扩展目录。');
  const directory = path.resolve(source);
  const kind = fs.existsSync(path.join(directory,'plugin.json')) ? 'plugins' : 'skills';
  const item = inspectExtension(directory,kind);
  const target = path.join(root,'extensions',kind,item.id);
  if (!within(path.join(root,'extensions',kind),target) || scanExtensions(root).some(other => other.id === item.id) || fs.existsSync(target)) throw error('同名扩展已存在，请先卸载旧版本。',409);
  fs.mkdirSync(path.dirname(target),{recursive:true});
  fs.cpSync(directory,target,{recursive:true,errorOnExist:true,force:false});
  return item.id;
}
export function uninstallExtension(root,id,revision) {
  const snapshot = extensionConfig(root);
  if (revision !== snapshot.revision) throw error('扩展设置已变化，请刷新后重试。',409);
  const item = scanExtensions(root).find(item => item.id === id);
  if(item?.builtin)throw error('内置扩展可停用，不能卸载。');
  if (!item || !within(path.join(root,'extensions',item.kind),item.directory) || fs.lstatSync(item.directory).isSymbolicLink()) throw error('扩展目录无效。');
  const archive = path.join(root,'state/extension-archives',crypto.randomUUID());
  if (!within(path.join(root,'state/extension-archives'),archive)) throw error('归档目录无效。');
  fs.mkdirSync(path.dirname(archive),{recursive:true});
  fs.renameSync(item.directory,archive);
  delete snapshot.config.extensions[id]; atomicJson(path.join(root,'config/extensions.json'),snapshot.config);
}
