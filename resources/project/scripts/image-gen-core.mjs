// Local image generation core. One module used by three callers:
//   - scripts/console-server.mjs  (status, probe, preview generation)
//   - packages/dsh-social-bridge-plugin/image-gen.mjs (the AI tool)
//   - scripts/image-gen-cli.mjs   (manual diagnosis)
// It only talks to the configured local endpoint; nothing is uploaded elsewhere.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { imageGenSettings, imageGenPolicy } from '../packages/dsh-social-bridge-plugin/image-gen-policy.mjs';

const MAX_IMAGE_BYTES = 16 * 1024 * 1024;
const KEEP_GENERATED = 200;
const COMFY_SAMPLERS = Object.freeze({
  'dpm++ 2m karras': ['dpmpp_2m', 'karras'],
  'dpm++ 2m': ['dpmpp_2m', 'normal'],
  'dpm++ sde karras': ['dpmpp_sde', 'karras'],
  'euler a': ['euler_ancestral', 'normal'],
  euler: ['euler', 'normal'],
  'ddim': ['ddim', 'normal'],
  'lcm': ['lcm', 'normal'],
});

const fail = (code, detail) => Object.assign(new Error(detail ? code + ': ' + detail : code), { code });
const trimBase = value => String(value ?? '').trim().replace(/\/+$/, '');

function imageGenDir(root) {
  return path.join(root, 'state', 'generated-images');
}

export function readImageGenSettings(root) {
  const config = JSON.parse(fs.readFileSync(path.join(root, 'config', 'wechatagent.json'), 'utf8').replace(/^\uFEFF/, ''));
  return imageGenSettings(config.wechat);
}

export function imageGenAllowed(root, conversationKey) {
  const config = JSON.parse(fs.readFileSync(path.join(root, 'config', 'wechatagent.json'), 'utf8').replace(/^\uFEFF/, ''));
  return imageGenPolicy(config.wechat, conversationKey);
}

function sniff(buffer) {
  if (buffer.length > 8 && buffer[0] === 0x89 && buffer[1] === 0x50 && buffer[2] === 0x4e && buffer[3] === 0x47) return { mime: 'image/png', ext: 'png' };
  if (buffer.length > 3 && buffer[0] === 0xff && buffer[1] === 0xd8) return { mime: 'image/jpeg', ext: 'jpg' };
  if (buffer.length > 12 && buffer.subarray(0, 4).toString('ascii') === 'RIFF' && buffer.subarray(8, 12).toString('ascii') === 'WEBP') return { mime: 'image/webp', ext: 'webp' };
  if (buffer.length > 6 && buffer.subarray(0, 3).toString('ascii') === 'GIF') return { mime: 'image/gif', ext: 'gif' };
  return null;
}

function decodeBase64Image(value) {
  if (typeof value !== 'string' || !value.length) throw fail('IMAGE_GEN_EMPTY_RESULT');
  const raw = value.replace(/^data:image\/[a-z+]+;base64,/i, '');
  const buffer = Buffer.from(raw, 'base64');
  if (!buffer.length) throw fail('IMAGE_GEN_EMPTY_RESULT');
  if (buffer.length > MAX_IMAGE_BYTES) throw fail('IMAGE_GEN_RESULT_TOO_LARGE');
  const kind = sniff(buffer);
  if (!kind) throw fail('IMAGE_GEN_UNSUPPORTED_FORMAT');
  if (!['png', 'jpg'].includes(kind.ext)) throw fail('IMAGE_GEN_UNSUPPORTED_FORMAT', 'backend returned ' + kind.mime);
  return { buffer, ...kind };
}

async function readJson(response, limit = 1024 * 1024) {
  const text = await response.text();
  if (text.length > limit) throw fail('IMAGE_GEN_RESPONSE_TOO_LARGE');
  try { return JSON.parse(text); } catch { throw fail('IMAGE_GEN_INVALID_RESPONSE', 'HTTP ' + response.status); }
}

function timeoutSignal(timeoutMs, signal) {
  const list = [AbortSignal.timeout(Math.max(1000, Math.min(600000, Number(timeoutMs) || 180000)))];
  if (signal) list.push(signal);
  return AbortSignal.any(list);
}

function comfySampler(name) {
  const key = String(name ?? '').trim().toLowerCase();
  return COMFY_SAMPLERS[key] ?? COMFY_SAMPLERS[key.replace(/\s+karras$/, '')] ?? ['dpmpp_2m', /karras/.test(key) ? 'karras' : 'normal'];
}

function comfyWorkflow(settings, request) {
  const [samplerName, scheduler] = comfySampler(settings.sampler);
  const seed = crypto.randomInt(1, 2 ** 31 - 1);
  return {
    '3': { class_type: 'KSampler', inputs: { seed, steps: settings.steps, cfg: settings.cfgScale, sampler_name: samplerName, scheduler, denoise: 1, model: ['4', 0], positive: ['6', 0], negative: ['7', 0], latent_image: ['5', 0] } },
    '4': { class_type: 'CheckpointLoaderSimple', inputs: { ckpt_name: settings.model } },
    '5': { class_type: 'EmptyLatentImage', inputs: { width: request.width, height: request.height, batch_size: 1 } },
    '6': { class_type: 'CLIPTextEncode', inputs: { text: request.prompt, clip: ['4', 1] } },
    '7': { class_type: 'CLIPTextEncode', inputs: { text: request.negativePrompt, clip: ['4', 1] } },
    '8': { class_type: 'VAEDecode', inputs: { samples: ['3', 0], vae: ['4', 2] } },
    '9': { class_type: 'SaveImage', inputs: { filename_prefix: 'wechatagent', images: ['8', 0] } },
  };
}

// Z-Image Turbo is not a single checkpoint: it needs a diffusion model, the
// Qwen text encoder and the AE VAE loaded separately. This mirrors ComfyUI's
// official template (UNETLoader -> CLIPLoader(lumina2) -> ModelSamplingAuraFlow
// -> KSampler res_multistep/simple). Turbo expects few steps and cfg 1.
const ZIMAGE_CLIP = 'qwen_3_4b.safetensors';
const ZIMAGE_VAE = 'ae.safetensors';
function zimageWorkflow(settings, request) {
  const seed = crypto.randomInt(1, 2 ** 31 - 1);
  const negative = request.negativePrompt
    ? { class_type: 'CLIPTextEncode', inputs: { text: request.negativePrompt, clip: ['2', 0] } }
    : { class_type: 'ConditioningZeroOut', inputs: { conditioning: ['4', 0] } };
  return {
    '1': { class_type: 'UNETLoader', inputs: { unet_name: settings.model, weight_dtype: 'default' } },
    '2': { class_type: 'CLIPLoader', inputs: { clip_name: settings.clipModel || ZIMAGE_CLIP, type: 'lumina2', device: 'default' } },
    '3': { class_type: 'VAELoader', inputs: { vae_name: settings.vaeModel || ZIMAGE_VAE } },
    '4': { class_type: 'CLIPTextEncode', inputs: { text: request.prompt, clip: ['2', 0] } },
    '5': negative,
    '6': { class_type: 'EmptySD3LatentImage', inputs: { width: request.width, height: request.height, batch_size: 1 } },
    '7': { class_type: 'ModelSamplingAuraFlow', inputs: { shift: 3, model: ['1', 0] } },
    '8': { class_type: 'KSampler', inputs: { seed, steps: settings.steps, cfg: settings.cfgScale, sampler_name: 'res_multistep', scheduler: 'simple', denoise: 1, model: ['7', 0], positive: ['4', 0], negative: ['5', 0], latent_image: ['6', 0] } },
    '9': { class_type: 'VAEDecode', inputs: { samples: ['8', 0], vae: ['3', 0] } },
    '10': { class_type: 'SaveImage', inputs: { filename_prefix: 'wechatagent', images: ['9', 0] } },
  };
}

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

async function sdWebuiProbe(settings, fetchImpl, signal) {
  const response = await fetchImpl(trimBase(settings.baseUrl) + '/sdapi/v1/options', { signal });
  if (!response.ok) throw fail('IMAGE_GEN_ENDPOINT_UNAVAILABLE', 'HTTP ' + response.status);
  const data = await readJson(response, 4 * 1024 * 1024);
  return { provider: 'sdwebui', detail: 'Stable Diffusion WebUI 已就绪', model: typeof data.sd_model_checkpoint === 'string' ? data.sd_model_checkpoint : '' };
}

async function comfyProbe(settings, fetchImpl, signal, zimage = false) {
  const response = await fetchImpl(trimBase(settings.baseUrl) + '/system_stats', { signal });
  if (!response.ok) throw fail('IMAGE_GEN_ENDPOINT_UNAVAILABLE', 'HTTP ' + response.status);
  const data = await readJson(response);
  const device = Array.isArray(data.devices) ? data.devices[0] : null;
  const suffix = device?.name ? '（' + String(device.name).slice(0, 60) + '）' : '';
  return { provider: zimage ? 'comfyui-zimage' : 'comfyui', detail: (zimage ? 'ComfyUI（Z-Image Turbo 模式）已就绪' : 'ComfyUI 已就绪') + suffix,
    model: settings.model ? (zimage ? settings.model + ' + ' + (settings.clipModel || ZIMAGE_CLIP) + ' + ' + (settings.vaeModel || ZIMAGE_VAE) : settings.model) : '' };
}

async function openaiProbe(settings, fetchImpl, signal) {
  const response = await fetchImpl(trimBase(settings.baseUrl) + '/v1/models', { signal });
  if (!response.ok) throw fail('IMAGE_GEN_ENDPOINT_UNAVAILABLE', 'HTTP ' + response.status);
  const data = await readJson(response, 2 * 1024 * 1024);
  const models = Array.isArray(data.data) ? data.data.map(item => item?.id).filter(item => typeof item === 'string') : [];
  return { provider: 'openai', detail: 'OpenAI 兼容接口已就绪', model: settings.model || models[0] || '', models: models.slice(0, 40) };
}

export async function probeImageGen(settings, { fetchImpl = fetch, timeoutMs = 8000 } = {}) {
  if (!settings?.baseUrl) throw fail('IMAGE_GEN_ENDPOINT_REQUIRED');
  const signal = timeoutSignal(timeoutMs);
  try {
    if (settings.provider === 'comfyui') return await comfyProbe(settings, fetchImpl, signal);
    if (settings.provider === 'comfyui-zimage') return await comfyProbe(settings, fetchImpl, signal, true);
    if (settings.provider === 'openai') return await openaiProbe(settings, fetchImpl, signal);
    return await sdWebuiProbe(settings, fetchImpl, signal);
  } catch (error) {
    if (error?.name === 'TimeoutError' || error?.name === 'AbortError') throw fail('IMAGE_GEN_TIMEOUT');
    if (error?.code) throw error;
    throw fail('IMAGE_GEN_ENDPOINT_UNAVAILABLE', String(error?.cause?.code ?? error?.message ?? '').slice(0, 120));
  }
}

async function sdWebuiGenerate(settings, request, signal, fetchImpl) {
  const response = await fetchImpl(trimBase(settings.baseUrl) + '/sdapi/v1/txt2img', {
    method: 'POST', headers: { 'content-type': 'application/json' }, signal,
    body: JSON.stringify({ prompt: request.prompt, negative_prompt: request.negativePrompt, width: request.width, height: request.height,
      steps: settings.steps, cfg_scale: settings.cfgScale, sampler_name: settings.sampler, batch_size: 1, n_iter: 1 }),
  });
  if (!response.ok) throw fail('IMAGE_GEN_REQUEST_FAILED', 'HTTP ' + response.status);
  const data = await readJson(response, 32 * 1024 * 1024);
  if (!Array.isArray(data.images) || !data.images.length) throw fail('IMAGE_GEN_EMPTY_RESULT');
  return decodeBase64Image(data.images[0]);
}

async function comfyGenerate(settings, request, signal, fetchImpl, buildWorkflow = comfyWorkflow) {
  if (!settings.model) throw fail('IMAGE_GEN_MODEL_REQUIRED', buildWorkflow === zimageWorkflow ? 'Z-Image 需要填写 UNET 文件名' : 'ComfyUI 需要填写 checkpoint 名称');
  const clientId = crypto.randomUUID();
  const response = await fetchImpl(trimBase(settings.baseUrl) + '/prompt', {
    method: 'POST', headers: { 'content-type': 'application/json' }, signal,
    body: JSON.stringify({ prompt: buildWorkflow(settings, request), client_id: clientId }),
  });
  if (!response.ok) throw fail('IMAGE_GEN_REQUEST_FAILED', 'HTTP ' + response.status);
  const queued = await readJson(response, 4 * 1024 * 1024);
  const promptId = queued.prompt_id;
  if (typeof promptId !== 'string' || !promptId) throw fail('IMAGE_GEN_INVALID_RESPONSE', 'no prompt_id');
  const deadline = Date.now() + Math.max(5000, Number(settings.timeoutMs) || 180000);
  for (;;) {
    signal.throwIfAborted();
    const history = await fetchImpl(trimBase(settings.baseUrl) + '/history/' + encodeURIComponent(promptId), { signal });
    if (history.ok) {
      const data = await readJson(history, 8 * 1024 * 1024);
      const entry = data?.[promptId];
      if (entry) {
        if (entry.status?.status_str === 'error') throw fail('IMAGE_GEN_REQUEST_FAILED', 'ComfyUI 执行失败');
        for (const output of Object.values(entry.outputs ?? {})) {
          const image = Array.isArray(output?.images) ? output.images[0] : null;
          if (!image?.filename) continue;
          const query = new URLSearchParams({ filename: image.filename, subfolder: image.subfolder ?? '', type: image.type ?? 'output' });
          const file = await fetchImpl(trimBase(settings.baseUrl) + '/view?' + query.toString(), { signal });
          if (!file.ok) throw fail('IMAGE_GEN_REQUEST_FAILED', 'HTTP ' + file.status);
          const buffer = Buffer.from(await file.arrayBuffer());
          if (buffer.length > MAX_IMAGE_BYTES) throw fail('IMAGE_GEN_RESULT_TOO_LARGE');
          const kind = sniff(buffer);
          if (!kind || !['png', 'jpg'].includes(kind.ext)) throw fail('IMAGE_GEN_UNSUPPORTED_FORMAT');
          return { buffer, ...kind };
        }
        throw fail('IMAGE_GEN_EMPTY_RESULT');
      }
    }
    if (Date.now() > deadline) throw fail('IMAGE_GEN_TIMEOUT');
    await sleep(700);
  }
}

async function openaiGenerate(settings, request, signal, fetchImpl) {
  const response = await fetchImpl(trimBase(settings.baseUrl) + '/v1/images/generations', {
    method: 'POST', headers: { 'content-type': 'application/json' }, signal,
    body: JSON.stringify({ model: settings.model || 'local', prompt: request.negativePrompt ? request.prompt + '\n\n避免：' + request.negativePrompt : request.prompt,
      n: 1, size: request.width + 'x' + request.height, response_format: 'b64_json' }),
  });
  if (!response.ok) throw fail('IMAGE_GEN_REQUEST_FAILED', 'HTTP ' + response.status);
  const data = await readJson(response, 32 * 1024 * 1024);
  const item = Array.isArray(data.data) ? data.data[0] : null;
  if (item?.b64_json) return decodeBase64Image(item.b64_json);
  if (typeof item?.url === 'string' && /^https?:\/\//.test(item.url)) {
    const file = await fetchImpl(item.url, { signal });
    if (!file.ok) throw fail('IMAGE_GEN_REQUEST_FAILED', 'HTTP ' + file.status);
    const buffer = Buffer.from(await file.arrayBuffer());
    if (buffer.length > MAX_IMAGE_BYTES) throw fail('IMAGE_GEN_RESULT_TOO_LARGE');
    const kind = sniff(buffer);
    if (!kind || !['png', 'jpg'].includes(kind.ext)) throw fail('IMAGE_GEN_UNSUPPORTED_FORMAT');
    return { buffer, ...kind };
  }
  throw fail('IMAGE_GEN_EMPTY_RESULT');
}

/** Generate one image. Returns {buffer, mime, ext, meta} without touching disk. */
export async function generateImage(settings, { prompt, negativePrompt, width, height, signal, fetchImpl = fetch } = {}) {
  const text = String(prompt ?? '').trim();
  if (!text) throw fail('IMAGE_GEN_PROMPT_REQUIRED');
  if (text.length > 1500) throw fail('IMAGE_GEN_PROMPT_TOO_LONG');
  const request = {
    prompt: text,
    // An empty per-call value means "use the configured default", not "clear it".
    negativePrompt: (String(negativePrompt ?? '').trim() || String(settings.negativePrompt ?? '').trim()).slice(0, 600),
    width: Math.round(Number(width) || settings.width),
    height: Math.round(Number(height) || settings.height),
  };
  if (request.width < 256 || request.width > 2048 || request.height < 256 || request.height > 2048) throw fail('IMAGE_GEN_SIZE_INVALID');
  request.width -= request.width % 8; request.height -= request.height % 8;
  const signalOut = timeoutSignal(settings.timeoutMs, signal);
  let result;
  try {
    if (settings.provider === 'comfyui') result = await comfyGenerate(settings, request, signalOut, fetchImpl);
    else if (settings.provider === 'comfyui-zimage') result = await comfyGenerate(settings, request, signalOut, fetchImpl, zimageWorkflow);
    else if (settings.provider === 'openai') result = await openaiGenerate(settings, request, signalOut, fetchImpl);
    else result = await sdWebuiGenerate(settings, request, signalOut, fetchImpl);
  } catch (error) {
    if (error?.name === 'TimeoutError' || error?.name === 'AbortError') throw fail('IMAGE_GEN_TIMEOUT');
    if (error?.code) throw error;
    throw fail('IMAGE_GEN_REQUEST_FAILED', String(error?.cause?.code ?? error?.message ?? '').slice(0, 120));
  }
  return { ...result, meta: { provider: settings.provider, model: settings.model, prompt: text, negativePrompt: request.negativePrompt,
    width: request.width, height: request.height, steps: settings.steps, cfgScale: settings.cfgScale, sampler: settings.sampler } };
}

function pruneGenerated(dir) {
  try {
    const files = fs.readdirSync(dir).filter(name => name.endsWith('.json')).map(name => ({ name, at: fs.statSync(path.join(dir, name)).mtimeMs }))
      .sort((a, b) => b.at - a.at);
    for (const file of files.slice(KEEP_GENERATED)) {
      const base = file.name.replace(/\.json$/, '');
      for (const ext of ['.json', '.png', '.jpg']) { try { fs.rmSync(path.join(dir, base + ext), { force: true }); } catch {} }
    }
  } catch {}
}

/** Persist a generated image and return the descriptor used across processes. */
export function saveGeneratedImage(root, result) {
  const dir = imageGenDir(root);
  fs.mkdirSync(dir, { recursive: true });
  const id = crypto.randomBytes(32).toString('hex');
  const file = path.join(dir, id + '.' + result.ext);
  fs.writeFileSync(file, result.buffer, { mode: 0o600 });
  const record = { version: 1, id, file, ext: result.ext, mime: result.mime, bytes: result.buffer.length, createdAt: Date.now(), ...result.meta };
  fs.writeFileSync(path.join(dir, id + '.json'), JSON.stringify(record, null, 2), { mode: 0o600 });
  pruneGenerated(dir);
  return record;
}

export function readGeneratedImage(root, id) {
  if (typeof id !== 'string' || !/^[a-f0-9]{64}$/.test(id)) throw fail('IMAGE_GEN_INVALID_ID');
  const dir = imageGenDir(root);
  for (const ext of ['png', 'jpg']) {
    const file = path.join(dir, id + '.' + ext);
    if (fs.existsSync(file)) return { file, mime: ext === 'png' ? 'image/png' : 'image/jpeg', record: readRecord(dir, id) };
  }
  throw fail('IMAGE_GEN_NOT_FOUND');
}

function readRecord(dir, id) {
  try { return JSON.parse(fs.readFileSync(path.join(dir, id + '.json'), 'utf8')); } catch { return null; }
}

export function listGeneratedImages(root, limit = 24) {
  const dir = imageGenDir(root);
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir).filter(name => /^[a-f0-9]{64}\.json$/.test(name)).map(name => readRecord(dir, name.slice(0, -5)))
    .filter(Boolean).sort((a, b) => b.createdAt - a.createdAt).slice(0, Math.max(1, Math.min(60, limit)));
}

/** Validate that a path handed to the sender really is one of our generated files. */
export function isGeneratedImagePath(root, file) {
  if (typeof file !== 'string' || !path.isAbsolute(file)) return false;
  const dir = imageGenDir(root);
  const resolved = path.resolve(file);
  if (path.dirname(resolved) !== path.resolve(dir)) return false;
  if (!/^[a-f0-9]{64}\.(png|jpg)$/.test(path.basename(resolved))) return false;
  try { return fs.statSync(resolved).isFile() && fs.statSync(resolved).size <= MAX_IMAGE_BYTES; } catch { return false; }
}
