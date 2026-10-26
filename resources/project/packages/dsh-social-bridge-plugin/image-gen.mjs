// DSH 工具：用本机生图模型画图，并交给桥接层随本轮回复发到微信。
// 生成结果只登记在本轮 turn 上，由 native-context 汇总为 output.generatedImages；
// 真正的微信发送由桥接（social-engine → 适配器 → SendImgMsg）完成。
import fs from 'node:fs';
import path from 'node:path';
import { imageGenSettings, imageGenPolicy, IMAGE_GEN_POLICY } from './image-gen-policy.mjs';
import { generateImage, saveGeneratedImage, isGeneratedImagePath, listGeneratedImages } from '../../scripts/image-gen-core.mjs';

const MAX_PROMPT = 600;
const clean = (value, limit) => String(value ?? '').replace(/[\u0000-\u001f\u007f]/g, ' ').trim().slice(0, limit);

function readWechat(root) {
  return JSON.parse(fs.readFileSync(path.join(root, 'config', 'wechatagent.json'), 'utf8').replace(/^\uFEFF/, '')).wechat;
}

function traceImage(root, tool, data) {
  try { fs.appendFileSync(path.join(root, 'state', 'logs', 'image-resend.log'), JSON.stringify({ at: new Date().toISOString(), tool, ...data }) + '\n'); } catch {}
}

// Shared selection for resend: prefer an explicit id, then the current chat's
// own images (conversationKey), then a prompt-hint substring match, then the
// most recent image. Returns null only when there are truly no readable images.
function pickResendImage(root, { promptHint, id, key } = {}) {
  const records = listGeneratedImages(root, 60);
  if (id) { const byId = records.find(r => r.id === id); if (byId && isGeneratedImagePath(root, byId.file)) return byId; }
  const mine = records.filter(r => r.conversationKey === key);
  const pool = mine.length ? mine : records;
  const hint = String(promptHint ?? '').trim().toLowerCase();
  if (hint) { const byHint = pool.find(r => String(r.prompt ?? '').toLowerCase().includes(hint)); if (byHint && isGeneratedImagePath(root, byHint.file)) return byHint; }
  const recent = pool[0];
  return recent && isGeneratedImagePath(root, recent.file) ? recent : null;
}

export function bindImageGen(agentCtx, root, key, turnFor, { isAllowed = () => true } = {}) {
  // Temporary diagnosis: how often is the tool (re)bound for one chat?
  const trace = event => { try { fs.appendFileSync(path.join(root, 'state', 'logs', 'tool-filter.log'), JSON.stringify({ at: new Date().toISOString(), bind: event, key }) + '\n'); } catch {} };
  trace('bind');
  const policy = () => {
    try {
      const wechat = readWechat(root);
      const result = imageGenPolicy(wechat, key);
      return { enabled: result.enabled, settings: result.settings };
    } catch { return { enabled: false, settings: imageGenSettings({}) }; }
  };
  const active = () => {
    const turn = turnFor();
    return isAllowed() && !turn?.disabled && !turn?.controller?.signal?.aborted && policy().enabled;
  };
  // Execution still requires a live turn: visibility only needs the chat policy.
  const executable = () => !!turnFor() && active();
  const output = { schema: { type: 'object', properties: { content: { type: 'string' }, isError: { type: 'boolean' } }, required: ['content', 'isError'], additionalProperties: false },
    render: (_args, value) => [{ type: 'text', text: value.content }] };
  const definition = {
    name: 'wechat_image_generate',
    description: '用本机生图模型画一张图，画好后会随本条微信回复自动发出。对方要图、要画、要生成图片时使用。提示词用具体画面描述，不要包含聊天里的隐私信息。每轮次数有限，失败时改用文字回复，不要反复重试。',
    parameters: {
      type: 'object',
      properties: {
        prompt: { type: 'string', minLength: 1, maxLength: MAX_PROMPT, description: '画面描述，中文或英文均可，尽量具体：主体、动作、场景、光线、风格。' },
        negativePrompt: { type: 'string', maxLength: 300, description: '可选。本轮不想要的元素，例如文字、水印、多余手指。' },
        width: { type: 'integer', minimum: 256, maximum: 2048, description: '可选。留空使用本机默认宽度。' },
        height: { type: 'integer', minimum: 256, maximum: 2048, description: '可选。留空使用本机默认高度。' },
      },
      required: ['prompt'],
      additionalProperties: false,
    },
  };
  const resend = {
    name: 'wechat_image_resend',
    description: '把本机之前生成过的图片重新发到当前微信聊天，不用重新画，也不经过生图后端。对方说“把刚才那张再发一次”“重发一下图”“发来看看”“之前画的那个”时使用。只要本机有可重发的图，即使当前生图后端不可用也要用它，不要改成 wechat_image_generate 重新生图。',
    parameters: {
      type: 'object',
      properties: {
        id: { type: 'string', pattern: '^[a-f0-9]{64}$', description: '可选。已知图片 id 时直接指定。' },
        promptHint: { type: 'string', maxLength: 200, description: '可选。用画面描述匹配之前生成的图，例如“小鲸鱼”“橘猫”。' },
      },
      additionalProperties: false,
    },
  };
  const disposer = agentCtx.tools.register({
    ...definition, output,
    async execute(args, exec) {
      try {
        if (!executable()) throw Error('IMAGE_GEN_NOT_ALLOWED');
        const turn = turnFor();
        const { settings } = policy();
        if ((turn.calls ?? 0) >= settings.maxPerTurn) throw Error('IMAGE_GEN_TURN_LIMIT');
        const prompt = clean(args?.prompt, MAX_PROMPT);
        if (!prompt) throw Error('IMAGE_GEN_PROMPT_REQUIRED');
        turn.calls = (turn.calls ?? 0) + 1;
        const signal = AbortSignal.any([turn.controller.signal, AbortSignal.timeout(settings.timeoutMs + 15000), ...(exec?.signal ? [exec.signal] : [])]);
        let generated;
        try {
          generated = await generateImage(settings, {
            prompt,
            negativePrompt: clean(args?.negativePrompt, 300),
            width: args?.width, height: args?.height, signal,
          });
        } catch (genErr) {
          const code = /^IMAGE_GEN_[A-Z_]+$/.test(genErr?.message ?? '') ? genErr.message : 'IMAGE_GEN_FAILED';
          const backendDown = code === 'IMAGE_GEN_ENDPOINT_UNAVAILABLE' || code === 'IMAGE_GEN_TIMEOUT' || code === 'IMAGE_GEN_REQUEST_FAILED';
          // Backend unreachable: degrade to resending an existing image that
          // matches the request, so "send the picture you drew before" still
          // works even when generation itself is down.
          if (backendDown) {
            const pick = pickResendImage(root, { promptHint: prompt, key });
            if (pick) {
              turn.images.push({ id: pick.id, path: pick.file, prompt: pick.prompt, width: pick.width, height: pick.height, source: 'local-image-gen' });
              traceImage(root, 'generate-fallback-resend', { key, id: pick.id, prompt: String(pick.prompt ?? '').slice(0, 60) });
              return { content: JSON.stringify({
                ok: true, resent: true, id: pick.id,
                prompt: String(pick.prompt ?? '').slice(0, 120),
                notice: '生图后端当前连不上，已改为重发本机已有的图（按你描述的画面匹配）。图片会在这条回复后自动发出，正常写一句简短回复即可，不要声称是新画的。',
              }), isError: false };
            }
            let available = [];
            try { available = listGeneratedImages(root, 5).map(r => ({ id: r.id, prompt: String(r.prompt ?? '').slice(0, 60) })); } catch {}
            traceImage(root, 'generate-backend-down', { key, available: available.length });
            return { content: JSON.stringify({
              ok: false, error: code, availableImages: available,
              notice: '本机生图后端当前不可用（连不上），所以这次没画成；本机也没有可重发的旧图。不要声称已经画好或发出，改用文字回应即可。',
            }), isError: true };
          }
          throw genErr;
        }
        signal.throwIfAborted();
        if (!executable()) throw Error('IMAGE_GEN_TURN_CHANGED');
        const saved = saveGeneratedImage(root, { ...generated, meta: { ...generated.meta, conversationKey: key } });
        if (!isGeneratedImagePath(root, saved.file)) throw Error('IMAGE_GEN_SAVE_FAILED');
        turn.images.push({ id: saved.id, path: saved.file, prompt: saved.prompt, width: saved.width, height: saved.height, source: 'local-image-gen' });
        return { content: JSON.stringify({
          ok: true,
          id: saved.id,
          size: saved.width + 'x' + saved.height,
          notice: '图片已生成，会在本条微信回复发出后自动发送。正常写一句简短的回复即可，不要输出 [IMAGE] 或 [STICKER] 标记，也不要声称已经发送；如果本轮发送失败，本机会另行说明。',
        }), isError: false };
      } catch (error) {
        const code = /^IMAGE_GEN_[A-Z_]+$/.test(error?.message ?? '') ? error.message : 'IMAGE_GEN_FAILED';
        return { content: JSON.stringify({
          ok: false, error: code,
          notice: '本次没有生成图片。不要声称已经画好或发出；可以改用文字回应，不要重复调用。如果对方要的是之前已经画过的图，改用 wechat_image_resend 重发。',
        }), isError: true };
      }
    },
  });
  const resendDisposer = agentCtx.tools.register({
    ...resend, output,
    async execute(args) {
      try {
        if (!executable()) throw Error('IMAGE_GEN_NOT_ALLOWED');
        const turn = turnFor();
        if ((turn.resends ?? 0) >= 1) throw Error('IMAGE_GEN_TURN_LIMIT');
        const total = listGeneratedImages(root, 60).length;
        const pick = pickResendImage(root, { promptHint: args?.promptHint, id: args?.id, key });
        traceImage(root, 'resend', { key, total, hint: String(args?.promptHint ?? '').slice(0, 60), id: args?.id ?? null, hit: pick ? pick.id : null });
        if (!pick) throw Error('IMAGE_GEN_NONE_TO_RESEND');
        turn.resends = (turn.resends ?? 0) + 1;
        turn.images.push({ id: pick.id, path: pick.file, prompt: pick.prompt, width: pick.width, height: pick.height, source: 'local-image-gen' });
        traceImage(root, 'resend-ok', { key, id: pick.id, prompt: String(pick.prompt ?? '').slice(0, 60) });
        return { content: JSON.stringify({
          ok: true,
          id: pick.id,
          prompt: String(pick.prompt ?? '').slice(0, 120),
          notice: '这张图会在本条回复发出后自动发送。正常写一句简短的回复即可，不要输出标记，也不要声称已经发送。',
        }), isError: false };
      } catch (error) {
        const code = /^IMAGE_GEN_[A-Z_]+$/.test(error?.message ?? '') ? error.message : 'IMAGE_GEN_FAILED';
        traceImage(root, 'resend-fail', { key, code });
        return { content: JSON.stringify({ ok: false, error: code,
          notice: '本次没有重发图片。不要声称已经发出去；可以说明本机没有可重发的图，或改用文字回应。' }), isError: true };
      }
    },
  });
  // Visibility follows the chat-level policy only, so the tool list in the
  // system prompt stays byte-stable across turns (prefix-cache friendly);
  // executability stays turn-aware. See the guard in social-tool-restrict.
  const names = () => new Set(policy().enabled ? [definition.name, resend.name] : []);
  const access = { names, definitions: () => [definition, resend].filter(item => names().has(item.name)), check: name => executable() && names().has(name) };
  // social-tool-restrict only admits tools whose policy object is published on
  // the agent context; without this the tool is registered but filtered out.
  Object.defineProperty(agentCtx, IMAGE_GEN_POLICY, { value: access, configurable: true });
  const dispose = () => { trace('dispose'); try { disposer?.(); } catch {} try { resendDisposer?.(); } catch {} delete agentCtx[IMAGE_GEN_POLICY]; };
  dispose.instructions = () => {
    if (!active()) return '';
    const { settings } = policy();
    return '[本机生图]\n对方明确要图、要画、要生成图片时，调用 wechat_image_generate 画一张（每轮最多 ' + settings.maxPerTurn + ' 次，默认 ' + settings.width + '×' + settings.height + '）。提示词只写画面本身，不要带入聊天原文里的隐私信息；风格跟随对话语境，不要每次都画同一类图。工具返回 ok 后正常写一句简短回复，图片会在这条回复后自动发出：不要输出 [IMAGE] 标记，也不要声称已经发送。对方要“把刚才那张再发一次/重发图”时，调用 wechat_image_resend（可用 promptHint 描述画面），不要重新画。对方问“能不能生图”“测试一下生图”这类验证性问题时，也要直接调用一次本工具画一张简单画面来验证，不要回答没有这个能力、也不要让对方自己测。生图后端不可用时，如果对方要的是之前已画的图，必须用 wechat_image_resend 重发，不要改用 generate。返回失败时不要重试、不要假装画好了，用文字说明即可。纯聊天、没必要配图时不要调用。\n';
  };
  return dispose;
}
