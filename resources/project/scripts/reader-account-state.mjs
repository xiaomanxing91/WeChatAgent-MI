import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

const read = (file, fallback = {}) => fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, '')) : fallback;
const write = (file, value) => {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const temp = file + '.' + process.pid + '.tmp';
  fs.writeFileSync(temp, JSON.stringify(value, null, 2) + '\n', { mode: 0o600 }); fs.renameSync(temp, file);
};
const stateFiles = ['social-messages.json', 'sticker-delivery-pending.json', 'text-deliveries', 'proactive', 'search', 'media'];
const chatFeatures = ['stickers', 'search', 'proactive', 'context', 'memeLibrary', 'memberMemory'];
const protectedKey = key => typeof key === 'string' && /^userdpapi:[A-Za-z0-9+/=]+$/.test(key);

export function readerAccountId(root, settings) {
  if (!settings?.dbPath || !settings.myWxid || /^(safe:|userdpapi:)/.test(settings.dbPath)) return '';
  let directory = path.resolve(root, settings.dbPath);
  if (!fs.existsSync(path.join(directory, 'db_storage')) && path.basename(directory).toLowerCase() !== settings.myWxid.toLowerCase()) directory = path.join(directory, settings.myWxid);
  if (fs.existsSync(directory)) directory = fs.realpathSync(directory);
  if (process.platform === 'win32') directory = directory.toLowerCase();
  return crypto.createHash('sha256').update(directory).digest('hex');
}

export function activeReaderAccount(root) {
  const value = read(path.join(root, 'state/weflow/active-account.json'), { id: '', legacyId: '' });
  for (const field of ['id', 'legacyId']) if (value[field] && !/^[a-f0-9]{64}$/.test(value[field])) throw Error('READER_ACCOUNT_STATE_INVALID');
  return { id: value.id || '', legacyId: value.legacyId || '' };
}

export function cachedReaderAccount(root, id) {
  return read(path.join(root, 'state/weflow/reader-accounts.json')).entries?.[id];
}

export function accountChatSettings(config) {
  return { whitelist: structuredClone(config.wechat.whitelist), personaChats: structuredClone(config.persona.chats ?? {}),chatModes:structuredClone(config.wechat.chatModes??{}),dshChats:structuredClone(config.wechat.dshAccess?.chats??{}),
    featureChats: Object.fromEntries(chatFeatures.map(name => [name, structuredClone(config.wechat[name]?.chats ?? {})])) };
}

function scoped(root, relative) {
  const base = path.resolve(root, 'state'), target = path.resolve(base, relative);
  if (!target.startsWith(base + path.sep)) throw Error('READER_ACCOUNT_STATE_INVALID');
  // Never move/remove an external target reached through a junction or symlink.
  let current = target;
  while (current !== base) {
    if (fs.existsSync(current) && fs.lstatSync(current).isSymbolicLink()) throw Error('READER_ACCOUNT_STATE_INVALID');
    current = path.dirname(current);
  }
  if (fs.existsSync(base) && fs.lstatSync(base).isSymbolicLink()) throw Error('READER_ACCOUNT_STATE_INVALID');
  return target;
}

function assertNoLinks(file) {
  if (!fs.existsSync(file)) return;
  const stat = fs.lstatSync(file);
  if (stat.isSymbolicLink()) throw Error('READER_ACCOUNT_STATE_INVALID');
  if (stat.isDirectory()) for (const name of fs.readdirSync(file)) assertNoLinks(path.join(file, name));
}

export function applyReaderAccount(root, previousReader, nextReader, config) {
  const previousId = readerAccountId(root, previousReader), nextId = readerAccountId(root, nextReader);
  if (!nextId || !protectedKey(nextReader.decryptKey)) throw Error('READER_ACCOUNT_STATE_INVALID');
  const changed = !!previousId && previousId !== nextId;
  const storeFile = scoped(root, 'weflow/reader-accounts.json');
  const store = read(storeFile, { version: 1, entries: {} });
  if (store.version !== 1 || !store.entries || typeof store.entries !== 'object') throw Error('READER_ACCOUNT_STATE_INVALID');
  const currentIdentity = activeReaderAccount(root);
  const incoming = store.entries[nextId];
  const selectedConfig = structuredClone(config);
  const selectedReader = { ...nextReader };
  if (previousId) {
    store.entries[previousId] = { reader: protectedKey(previousReader.decryptKey) ? structuredClone(previousReader) : { dbPath: previousReader.dbPath, myWxid: previousReader.myWxid }, chats: accountChatSettings(config) };
  }
  const paths = stateFiles.map(file => ({ file, active: scoped(root, file), previous: previousId ? scoped(root, `accounts/${previousId}/runtime/${file}`) : '', next: scoped(root, `accounts/${nextId}/runtime/${file}`) }));
  if (changed) for (const item of paths) { assertNoLinks(item.active); assertNoLinks(item.previous); assertNoLinks(item.next); }
  if (changed) {
    const chats = incoming?.chats ?? { whitelist: { private: [], groups: [] }, personaChats: {}, featureChats: {} };
    selectedConfig.wechat.whitelist = structuredClone(chats.whitelist);
    selectedConfig.persona.chats = structuredClone(chats.personaChats ?? {});
    selectedConfig.wechat.chatModes=structuredClone(chats.chatModes??{});selectedConfig.wechat.dshAccess={chats:structuredClone(chats.dshChats??{})};
    for (const feature of chatFeatures) if (selectedConfig.wechat[feature]) selectedConfig.wechat[feature].chats = structuredClone(chats.featureChats?.[feature] ?? {});
    // Image credentials and explicit message filters belong to the selected account.
    for (const field of ['imageAesKey', 'imageXorKey', 'messagePushFilterList']) {
      if (incoming?.reader && Object.hasOwn(incoming.reader, field)) selectedReader[field] = structuredClone(incoming.reader[field]);
      else delete selectedReader[field];
    }
  }
  const readerFile = scoped(root, 'weflow/WeFlow-config.json');
  const configFile = path.join(root, 'config/wechatagent.json');
  const identityFile = scoped(root, 'weflow/active-account.json');
  const ioFile = scoped(root, 'wechat-io-config.json');
  const originals = [readerFile, configFile, identityFile, ioFile, storeFile].map(file => ({ file, data: fs.existsSync(file) ? fs.readFileSync(file) : null }));
  const switched = [];
  try {
    if (changed) for (const item of paths) {
      const hadActive = fs.existsSync(item.active);
      fs.rmSync(item.previous, { recursive: true, force: true });
      if (hadActive) {
        fs.mkdirSync(path.dirname(item.previous), { recursive: true });
        fs.cpSync(item.active, item.previous, { recursive: true, force: true, dereference: false });
      }
      switched.push({ ...item, hadActive });
      // Targets were resolved and verified within this workspace's state directory.
      fs.rmSync(item.active, { recursive: true, force: true });
      if (fs.existsSync(item.next)) { fs.mkdirSync(path.dirname(item.active), { recursive: true }); fs.cpSync(item.next, item.active, { recursive: true, dereference: false }); }
    }
    store.entries[nextId] = { reader: selectedReader, chats: accountChatSettings(selectedConfig) };
    write(storeFile, store); write(readerFile, selectedReader);
    if (changed) write(configFile, selectedConfig);
    if (changed && fs.existsSync(ioFile)) write(ioFile, { ...read(ioFile), self_wxid: '' });
    const legacyId = currentIdentity.legacyId || (!currentIdentity.id && previousId ? previousId : '');
    write(identityFile, { id: nextId, legacyId });
    return { changed, reader: selectedReader, id: nextId, needsDshRestart: currentIdentity.id !== nextId };
  } catch (error) {
    for (const item of switched.reverse()) {
      fs.rmSync(item.active, { recursive: true, force: true });
      if (item.hadActive) { fs.mkdirSync(path.dirname(item.active), { recursive: true }); fs.cpSync(item.previous, item.active, { recursive: true, dereference: false }); }
    }
    for (const { file, data } of originals) {
      if (data !== null) fs.writeFileSync(file, data); else fs.rmSync(file, { force: true });
    }
    throw error;
  }
}
