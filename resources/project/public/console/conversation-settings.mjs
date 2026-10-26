const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
const own = (object, key) => Object.hasOwn(object ?? {}, key);

export function chatSettingsSnapshot(config, key) {
  const w = config.wechat;
  return {
    settings: {
      persona: config.persona.chats?.[key] ?? null,
      mode: w.chatModes?.[key] ?? null,
      stickers: w.stickers?.chats?.[key] ?? null,
      search: w.search?.chats?.[key] ?? null,
      proactive: w.proactive?.chats?.[key] === true,
      context: w.context?.chats?.[key] ?? null,
    },
    access: Object.fromEntries(['skills', 'tools'].map(kind => [kind, [...w.dshAccess?.chats?.[key]?.[kind] ?? []].sort()])),
  };
}

export function applyChatSettings(config, key, settings, access) {
  const fail = message => { throw Object.assign(new Error(message), {status: 400}); };
  if (!settings || Array.isArray(settings) || Object.keys(settings).length !== 6 ||
      !['persona', 'mode', 'stickers', 'search', 'proactive', 'context'].every(name => own(settings, name))) fail('会话设置不完整，请重新打开。');
  if (settings.persona !== null && (typeof settings.persona !== 'string' || !settings.persona)) fail('请选择有效人格。');
  if (settings.mode !== null && (!key.startsWith('wechat:group:') || !['hybrid', 'mention'].includes(settings.mode))) fail('请选择有效的群聊回复方式。');
  if (['stickers', 'search'].some(name => settings[name] !== null && typeof settings[name] !== 'boolean') || typeof settings.proactive !== 'boolean') fail('功能设置必须使用开关值。');
  if (settings.context !== null && (!Number.isSafeInteger(settings.context) || settings.context !== 0 && (settings.context < 4000 || settings.context > 2000000))) fail('上下文阈值为 4,000–2,000,000 token；填 0 关闭，留空继承默认。');
  if (!access || !Array.isArray(access.skills) || !Array.isArray(access.tools) || Object.keys(access).some(name => !['skills', 'tools'].includes(name))) fail('技能与工具列表无效，请重新打开。');
  const put = (map, value) => { if (value === null) delete map[key]; else map[key] = value; };
  config.persona.chats ??= {}; put(config.persona.chats, settings.persona);
  config.wechat.chatModes ??= {}; put(config.wechat.chatModes, settings.mode);
  for (const name of ['stickers', 'search', 'proactive', 'context']) {
    config.wechat[name] ??= {}; config.wechat[name].chats ??= {};
    put(config.wechat[name].chats, settings[name]);
  }
  config.wechat.dshAccess ??= { chats: {} }; config.wechat.dshAccess.chats ??= {};
  config.wechat.dshAccess.chats[key] = structuredClone(access);
  return config;
}

// Rebase pending edits onto the server result, then accept only this chat's saved fields.
export function mergeConversationSave(previous, draft, saved, key) {
  const merge = (before, pending, current) => {
    if (same(before, pending)) return structuredClone(current);
    if (!pending || typeof pending !== 'object' || Array.isArray(pending) || !before || typeof before !== 'object') return structuredClone(pending);
    const result = structuredClone(current ?? {});
    for (const name of new Set([...Object.keys(before), ...Object.keys(pending)])) {
      if (!own(pending, name)) delete result[name];
      else result[name] = merge(before[name], pending[name], current?.[name]);
    }
    return result;
  };
  const result = merge(previous, draft, saved);
  const accept = (target, source) => { if (own(source, key)) target[key] = structuredClone(source[key]); else delete target[key]; };
  result.persona.chats ??= {}; accept(result.persona.chats, saved.persona.chats);
  for (const name of ['chatModes', 'stickers', 'search', 'proactive', 'context']) {
    if (name === 'chatModes') { result.wechat[name] ??= {}; accept(result.wechat[name], saved.wechat[name]); }
    else { result.wechat[name] ??= {}; result.wechat[name].chats ??= {}; accept(result.wechat[name].chats, saved.wechat[name]?.chats); }
  }
  result.wechat.dshAccess ??= { chats: {} }; result.wechat.dshAccess.chats ??= {};
  accept(result.wechat.dshAccess.chats, saved.wechat.dshAccess?.chats);
  return result;
}
