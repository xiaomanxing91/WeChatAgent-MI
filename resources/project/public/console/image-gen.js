// 本地生图页面：连接本地出图后端、调参数、试画，并查看最近生成的图片。
// 页面本身只负责交互；保存走控制台通用配置流程（wechat.imageGen）。
const PROVIDERS = [
  { value: 'sdwebui', label: 'Stable Diffusion WebUI / Forge（/sdapi）' },
  { value: 'comfyui', label: 'ComfyUI · 单文件 checkpoint' },
  { value: 'comfyui-zimage', label: 'ComfyUI · Z-Image Turbo（unet + clip + vae）' },
  { value: 'openai', label: 'OpenAI 兼容接口（/v1/images/generations）' },
];

export function createImageGenUI({ api, state, icon, escapeHtml: esc, header, field, toggle, toast, renderPage }) {
  const recent = { items: [], status: null, busy: false };

  async function post(route, body, timeoutMs = 620000) {
    const response = await fetch(route, {
      method: 'POST',
      headers: { 'X-Console-Token': state.token, 'Content-Type': 'application/json' },
      body: JSON.stringify(body ?? {}),
      signal: AbortSignal.timeout(timeoutMs),
    });
    const result = await response.json().catch(() => ({}));
    if (!response.ok) throw Object.assign(new Error(result.error ?? '操作失败，请重试。'), { status: response.status });
    return result;
  }

  const settings = () => state.draft.wechat.imageGen ?? {};
  const chats = () => {
    const list = [];
    for (const id of state.draft.wechat.whitelist.groups ?? []) list.push({ key: 'wechat:group:' + id, label: state.names.get('wechat:group:' + id) || ('群聊 ' + id) });
    for (const id of state.draft.wechat.whitelist.private ?? []) list.push({ key: 'wechat:private:' + id, label: state.names.get('wechat:private:' + id) || ('好友 ' + id) });
    return list;
  };

  function chatCard() {
    const list = chats();
    if (!list.length) return `<section class="card">${header('聊天范围', '先在“聊天范围”里添加好友或群聊，才能为它们开启本地生图。', '', 'users')}</section>`;
    const value = key => settings().chats?.[key];
    return `<section class="card">${header('聊天范围', '全局开启后，默认对所有已允许聊天可用；也可以逐个关闭。', '', 'users')}
      <div class="imagegen-chats">${list.map(item => `<div class="imagegen-chat-row"><div><strong>${esc(item.label)}</strong><span class="subtle mono">${esc(item.key)}</span></div>
        <select data-imagegen-key="${esc(item.key)}" aria-label="${esc(item.label)} 的本地生图">
          <option value="inherit"${value(item.key) === undefined ? ' selected' : ''}>跟随全局</option>
          <option value="on"${value(item.key) === true ? ' selected' : ''}>开启</option>
          <option value="off"${value(item.key) === false ? ' selected' : ''}>关闭</option>
        </select></div>`).join('')}</div></section>`;
  }

  function thumbs() {
    if (!recent.items.length) return `<p class="subtle" id="imagegen-recent-empty">还没有生成记录。试画一次，或在微信里让助手画图。</p>`;
    return `<div class="imagegen-thumbs" id="imagegen-thumbs">${recent.items.map(item => `<figure class="imagegen-thumb">
      <img src="/generated/${item.id}.${item.ext}" alt="${esc((item.prompt ?? '').slice(0, 80))}" loading="lazy" width="160" height="160">
      <figcaption><span>${esc((item.prompt ?? '').slice(0, 60))}</span><small>${item.width}×${item.height} · ${new Date(item.createdAt).toLocaleString('zh-CN', { hour12: false })}</small></figcaption></figure>`).join('')}</div>`;
  }

  async function page() {
    const data = await api('/api/image-gen');
    recent.items = Array.isArray(data.recent) ? data.recent : [];
    return `<div class="section-stack">
      <section class="card">${header('本地生图模型', '把本机的出图服务接到微信助手：助手画好后直接发到聊天。', '', 'image')}
        ${toggle('允许助手生图并发送到微信', 'wechat.imageGen.enabled', '总开关。关闭后工具不可用，助手也不会尝试画图。还需在下方为聊天范围确认。')}
        <div class="form-grid space-top">
          <div class="field full"><label for="imagegen-provider">后端类型</label><select id="imagegen-provider" data-path="wechat.imageGen.provider">${PROVIDERS.map(item => `<option value="${item.value}"${(settings().provider ?? 'sdwebui') === item.value ? ' selected' : ''}>${item.label}</option>`).join('')}</select><small>三种后端都只在本机或你的内网地址上调用，图片不会上传到其他服务。</small></div>
          ${field('接口地址', 'wechat.imageGen.baseUrl', { full: true, placeholder: 'http://127.0.0.1:7860', help: '例如 SD WebUI 默认 http://127.0.0.1:7860，ComfyUI 默认 http://127.0.0.1:8188。' })}
          ${field('模型 / checkpoint', 'wechat.imageGen.model', { full: true, placeholder: 'sd_xl_base_1.0.safetensors', help: '单文件 checkpoint 填 CheckpointLoaderSimple 能识别的文件名；Z-Image 填 UNET 文件名（如 z_image_turbo_bf16.safetensors）；OpenAI 兼容接口可留空。' })}
          ${field('文本编码器 / clip', 'wechat.imageGen.clipModel', { full: true, placeholder: 'qwen_3_4b.safetensors', help: '仅 Z-Image 需要。留空默认 qwen_3_4b.safetensors，对应 ComfyUI 的 text_encoders 目录。' })}
          ${field('VAE 模型', 'wechat.imageGen.vaeModel', { full: true, placeholder: 'ae.safetensors', help: '仅 Z-Image 需要。留空默认 ae.safetensors。' })}
        </div>
        <div class="button-row space-top"><button class="button" id="imagegen-test">${icon('plug')}测试连接</button><span class="subtle" id="imagegen-test-result" role="status"></span></div>
        <p class="subtle">测试使用当前页面上的地址与类型，不需要先保存。后端需要已启动并允许本机访问。</p></section>

      <section class="card">${header('出图参数', '决定画面尺寸、步数与风格；助手调用时也会带上这些默认值。', '', 'sliders')}
        <div class="form-grid">
          ${field('宽度 / 像素', 'wechat.imageGen.width', { type: 'number', min: 256, max: 2048, step: 8, help: '默认 1024。会向下对齐到 8 的倍数。' })}
          ${field('高度 / 像素', 'wechat.imageGen.height', { type: 'number', min: 256, max: 2048, step: 8 })}
          ${field('采样步数', 'wechat.imageGen.steps', { type: 'number', min: 1, max: 80, step: 1, help: '默认 24。步数越高越慢。' })}
          ${field('提示词引导 / CFG', 'wechat.imageGen.cfgScale', { type: 'number', min: 1, max: 30, step: .5 })}
          ${field('采样器', 'wechat.imageGen.sampler', { help: 'ComfyUI 会按常见名称自动映射，例如 DPM++ 2M Karras → dpmpp_2m / karras。' })}
          ${field('单次超时 / 秒', 'wechat.imageGen.timeoutMs', { type: 'number', transform: 'seconds', min: 5, max: 600, step: 1, help: '默认 90 秒。超时后本次不生图，助手继续文字回复；调大会同步拉长该轮等待。' })}
          ${field('每轮最多生图 / 张', 'wechat.imageGen.maxPerTurn', { type: 'number', min: 1, max: 2, step: 1, help: '限制一次回复里的生图次数，避免长时间占用本机显卡。' })}
          <div class="field full"><label for="imagegen-negative">默认负面提示词</label><textarea id="imagegen-negative" data-path="wechat.imageGen.negativePrompt" rows="3" placeholder="lowres, blurry, extra fingers">${esc(settings().negativePrompt ?? '')}</textarea><small>可留空。助手也可以在自己调用时补充，但不会覆盖这里的基础负面词。</small></div>
        </div></section>

      <section class="card">${header('试画', '先用一句提示词确认画面质量，再交给助手在聊天里使用。', '', 'image')}
        <div class="field full"><label for="imagegen-prompt">提示词</label><textarea id="imagegen-prompt" rows="3" placeholder="一只橘猫趴在窗台上，午后阳光，写实摄影">一只橘猫趴在窗台上，午后阳光，写实摄影</textarea></div>
        <div class="button-row space-top"><button class="button primary" id="imagegen-preview">${icon('image')}开始试画</button><span class="subtle" id="imagegen-preview-result" role="status"></span></div>
        <div class="imagegen-preview" id="imagegen-preview-box" hidden></div>
        <p class="subtle">试画使用当前页面上的参数（未保存也生效），生成过程可能占用几十秒。</p></section>

      <section class="card">${header('最近生成', '保存在本机 state/generated-images，最多保留 200 张。', '<button class="button small" id="imagegen-reload">' + icon('refresh') + '刷新</button>', 'history')}
        <div id="imagegen-recent">${thumbs()}</div></section>

      ${chatCard()}
      <section class="card">${header('生效方式', '', '', 'info')}<div class="notice plain">${icon('info')}<span>参数与开关保存后立即生效。若刚更新过项目文件，需要重启服务让发图适配器加载新能力，并在 DSH 中重新加载插件后，助手才会出现“生图”工具。</span></div></section>
    </div>`;
  }

  function draftSettings() {
    const current = state.draft.wechat.imageGen ?? {};
    const pick = (key, fallback) => current[key] ?? fallback;
    return {
      provider: document.querySelector('#imagegen-provider')?.value ?? pick('provider', 'sdwebui'),
      baseUrl: document.querySelector('#field-wechat-imageGen-baseUrl')?.value?.trim() ?? pick('baseUrl', ''),
      model: document.querySelector('#field-wechat-imageGen-model')?.value?.trim() ?? pick('model', ''),
      clipModel: document.querySelector('#field-wechat-imageGen-clipModel')?.value?.trim() ?? pick('clipModel', ''),
      vaeModel: document.querySelector('#field-wechat-imageGen-vaeModel')?.value?.trim() ?? pick('vaeModel', ''),
      negativePrompt: document.querySelector('#imagegen-negative')?.value ?? pick('negativePrompt', ''),
      width: Number(document.querySelector('#field-wechat-imageGen-width')?.value ?? pick('width', 1024)),
      height: Number(document.querySelector('#field-wechat-imageGen-height')?.value ?? pick('height', 1024)),
      steps: Number(document.querySelector('#field-wechat-imageGen-steps')?.value ?? pick('steps', 24)),
      cfgScale: Number(document.querySelector('#field-wechat-imageGen-cfgScale')?.value ?? pick('cfgScale', 7)),
      sampler: document.querySelector('#field-wechat-imageGen-sampler')?.value ?? pick('sampler', 'DPM++ 2M Karras'),
      timeoutMs: Number(document.querySelector('#field-wechat-imageGen-timeoutMs')?.value ?? 90) * 1000,
      maxPerTurn: Number(document.querySelector('#field-wechat-imageGen-maxPerTurn')?.value ?? pick('maxPerTurn', 1)),
    };
  }

  function mount() {
    const test = document.querySelector('#imagegen-test');
    test?.addEventListener('click', async () => {
      const label = document.querySelector('#imagegen-test-result');
      test.disabled = true; label.textContent = '正在连接本地后端…';
      try {
        const result = await post('/api/image-gen/test', { settings: draftSettings() }, 20000);
        label.textContent = '连接成功：' + result.detail + (result.model ? '（' + result.model + '）' : '');
        label.className = 'subtle imagegen-ok';
      } catch (error) {
        label.textContent = '连接失败：' + error.message;
        label.className = 'subtle imagegen-fail';
      } finally { test.disabled = false; }
    });

    const preview = document.querySelector('#imagegen-preview');
    preview?.addEventListener('click', async () => {
      const label = document.querySelector('#imagegen-preview-result'), box = document.querySelector('#imagegen-preview-box');
      const prompt = document.querySelector('#imagegen-prompt')?.value?.trim() ?? '';
      if (!prompt) { label.textContent = '请先填写提示词。'; return; }
      preview.disabled = true; label.textContent = '正在生图，请稍候…'; box.hidden = true;
      const started = Date.now();
      try {
        const result = await post('/api/image-gen/preview', { prompt, settings: draftSettings() });
        box.hidden = false;
        box.innerHTML = `<img src="/generated/${result.id}.${result.ext}" alt="${esc(prompt.slice(0, 80))}" width="512"><div><strong>${result.width} × ${result.height}</strong><span class="subtle">用时 ${Math.round((Date.now() - started) / 1000)} 秒 · ${result.provider}</span></div>`;
        label.textContent = '已生成，可在下方“最近生成”中查看。';
        recent.items = [result, ...recent.items].slice(0, 24);
        const list = document.querySelector('#imagegen-recent'); if (list) list.innerHTML = thumbs();
      } catch (error) {
        label.textContent = '生图失败：' + error.message;
      } finally { preview.disabled = false; }
    });

    document.querySelector('#imagegen-reload')?.addEventListener('click', async () => {
      try {
        const data = await api('/api/image-gen');
        recent.items = Array.isArray(data.recent) ? data.recent : [];
        const list = document.querySelector('#imagegen-recent'); if (list) list.innerHTML = thumbs();
      } catch (error) { toast('读取最近生成失败：' + error.message); }
    });

    document.querySelector('#imagegen-provider')?.addEventListener('change', event => {
      const label = document.querySelector('#imagegen-test-result');
      if (label) { label.textContent = ''; label.className = 'subtle'; }
      // Z-Image Turbo only works with few steps and cfg 1; prefill so the first
      // 试画 is not wasted. The values stay editable and are saved like any other.
      if (event.target.value === 'comfyui-zimage') {
        const preset = { '#field-wechat-imageGen-steps': '8', '#field-wechat-imageGen-cfgScale': '1', '#field-wechat-imageGen-sampler': 'res_multistep' };
        for (const [selector, value] of Object.entries(preset)) {
          const input = document.querySelector(selector);
          if (!input) continue;
          input.value = value;
          input.dispatchEvent(new Event('input', { bubbles: true }));
        }
      }
    });
  }

  return { page, mount };
}
