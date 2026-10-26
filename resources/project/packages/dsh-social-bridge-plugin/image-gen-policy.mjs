// Local image generation policy. Shared by the console (validation/save), the
// DSH plugin tool and the bridge, so all three read one definition of what a
// valid configuration is.
export const IMAGE_GEN_POLICY = Symbol.for('wechatagent.image-gen.v1');
export const IMAGE_GEN_PROVIDERS = Object.freeze(['sdwebui', 'comfyui', 'comfyui-zimage', 'openai']);
export const IMAGE_GEN_DEFAULTS = Object.freeze({
  enabled: false,
  provider: 'sdwebui',
  baseUrl: 'http://127.0.0.1:7860',
  model: '',
  clipModel: '',
  vaeModel: '',
  negativePrompt: '',
  width: 1024,
  height: 1024,
  steps: 24,
  cfgScale: 7,
  sampler: 'DPM++ 2M Karras',
  timeoutMs: 90000,
  maxPerTurn: 1,
  chats: {},
});
const CHAT_KEY = /^wechat:(private|group):([1-9]\d{0,15})$/;
const SETTING_KEYS = ['enabled', 'provider', 'baseUrl', 'model', 'clipModel', 'vaeModel', 'negativePrompt', 'width', 'height', 'steps', 'cfgScale', 'sampler', 'timeoutMs', 'maxPerTurn', 'chats'];
const whole = (value, low, high) => Number.isSafeInteger(value) && value >= low && value <= high;

export function imageGenSettings(wechat) {
  const raw = wechat?.imageGen ?? {};
  return { ...IMAGE_GEN_DEFAULTS, ...raw, chats: raw.chats ?? {} };
}

export function validateImageGenSettings(settings) {
  if (settings === undefined) return;
  if (!settings || typeof settings !== 'object' || Array.isArray(settings)) throw Error('Invalid image generation settings');
  const unknown = Object.keys(settings).filter(key => !SETTING_KEYS.includes(key));
  if (unknown.length) throw Error('Invalid image generation settings');
  if (settings.enabled !== undefined && typeof settings.enabled !== 'boolean') throw Error('Invalid image generation switch');
  if (settings.provider !== undefined && !IMAGE_GEN_PROVIDERS.includes(settings.provider)) throw Error('Invalid image generation provider');
  if (settings.baseUrl !== undefined) {
    if (typeof settings.baseUrl !== 'string' || settings.baseUrl.length > 300 || /[\r\n\0]/.test(settings.baseUrl)) throw Error('Invalid image generation endpoint');
    let url;
    try { url = new URL(settings.baseUrl); } catch { throw Error('Invalid image generation endpoint'); }
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.search || url.hash) throw Error('Invalid image generation endpoint');
  }
  if (settings.model !== undefined && (typeof settings.model !== 'string' || settings.model.length > 120 || /[\r\n\0]/.test(settings.model))) throw Error('Invalid image generation model');
  for (const key of ['clipModel', 'vaeModel']) {
    if (settings[key] !== undefined && (typeof settings[key] !== 'string' || settings[key].length > 160 || /[\r\n\0]/.test(settings[key]))) throw Error('Invalid image generation ' + key);
  }
  if (settings.negativePrompt !== undefined && (typeof settings.negativePrompt !== 'string' || settings.negativePrompt.length > 600 || /[\r\n\0]/.test(settings.negativePrompt))) throw Error('Invalid image generation negative prompt');
  if (settings.width !== undefined && !whole(settings.width, 256, 2048)) throw Error('image generation width must be 256–2048');
  if (settings.height !== undefined && !whole(settings.height, 256, 2048)) throw Error('image generation height must be 256–2048');
  if (settings.steps !== undefined && !whole(settings.steps, 1, 80)) throw Error('image generation steps must be 1–80');
  if (settings.cfgScale !== undefined && (!Number.isFinite(settings.cfgScale) || settings.cfgScale < 1 || settings.cfgScale > 30)) throw Error('image generation cfgScale must be 1–30');
  if (settings.sampler !== undefined && (typeof settings.sampler !== 'string' || !/^[A-Za-z0-9 ._+()-]{1,64}$/.test(settings.sampler))) throw Error('Invalid image generation sampler');
  if (settings.timeoutMs !== undefined && !whole(settings.timeoutMs, 5000, 600000)) throw Error('image generation timeout must be 5000–600000');
  if (settings.maxPerTurn !== undefined && !whole(settings.maxPerTurn, 1, 2)) throw Error('image generation maxPerTurn must be 1–2');
  if (settings.chats !== undefined && (!settings.chats || typeof settings.chats !== 'object' || Array.isArray(settings.chats) ||
    Object.entries(settings.chats).some(([key, value]) => !CHAT_KEY.test(key) || typeof value !== 'boolean'))) throw Error('Invalid image generation chat settings');
}

/** Per-chat gate: whitelist + global switch + optional per-chat override. */
export function imageGenPolicy(wechat, key) {
  const settings = imageGenSettings(wechat);
  const match = CHAT_KEY.exec(key ?? '');
  const allowed = !!match && (wechat?.whitelist?.[match[1] === 'group' ? 'groups' : 'private'] ?? []).some(id => String(id) === match[2]);
  return { enabled: allowed && settings.enabled === true && (settings.chats?.[key] ?? true) === true, settings };
}

/** Stable digest of the fields that change how an image is produced. */
export function imageGenSignature(settings) {
  return [settings.provider, settings.baseUrl, settings.model, settings.clipModel, settings.vaeModel, settings.width, settings.height, settings.steps, settings.cfgScale, settings.sampler].join('|');
}
