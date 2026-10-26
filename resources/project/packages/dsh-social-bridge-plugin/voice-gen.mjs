import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

// 语音发送工具：把要说的内容转成 SILK_V3，随本条微信回复自动发出。
// 生成逻辑复用 scripts/wechat_voice.py（edge-tts -> WAV -> pilk SILK）。
// 落盘位置：state/generated-voices/<sha256>.silk（与 hook-onebot 的白名单一致）。

const MAX_TEXT = 500;          // 单条语音最多字数（约 60 秒内）
const MAX_VOICE_MS = 57000;    // 微信单条语音上限约 60 秒
const PY_TIMEOUT_MS = 90000;

// social-tool-restrict 只放行「策略对象已发布到 agent ctx」的工具；
// 不发布的话工具会被注册但过滤掉，模型根本看不见（2026-10-26 踩过）。
export const VOICE_GEN_POLICY = Symbol.for('wechatagent.voice-gen.v1');

const PY_CANDIDATES = [
  path.join(process.env.LOCALAPPDATA ?? '', 'Python', 'pythoncore-3.14-64', 'python.exe'),
  path.join(process.env.LOCALAPPDATA ?? '', 'Programs', 'Python', 'Python314', 'python.exe'),
  'python.exe',
];

function pythonExe(root) {
  const marker = path.join(root, 'state', 'generated-voices');
  for (const candidate of PY_CANDIDATES) {
    try { if (candidate === 'python.exe' || fs.existsSync(candidate)) return candidate; } catch {}
  }
  void marker;
  return PY_CANDIDATES[0];
}

function runPython(python, script, args, timeoutMs) {
  return new Promise((resolve, reject) => {
    const child = spawn(python, [script, ...args], { windowsHide: true });
    let stdout = '', stderr = '';
    const timer = setTimeout(() => { try { child.kill(); } catch {} reject(new Error('VOICE_TIMEOUT')); }, timeoutMs);
    child.stdout.on('data', chunk => { stdout += chunk; });
    child.stderr.on('data', chunk => { stderr += chunk; });
    child.on('error', error => { clearTimeout(timer); reject(error); });
    child.on('close', code => {
      clearTimeout(timer);
      const line = String(stdout).trim().split(/\r?\n/).filter(Boolean).at(-1) ?? '';
      try { resolve(JSON.parse(line)); }
      catch { reject(new Error('VOICE_GEN_FAILED: ' + (line || stderr).slice(-200))); }
    });
  });
}

export function bindVoiceGen(agentCtx, root, key, turnFor, { isAllowed = () => true } = {}) {
  const script = path.join(root, 'scripts', 'wechat_voice.py');
  const outDir = path.join(root, 'state', 'generated-voices');
  const executable = () => isAllowed() && !!turnFor() && !turnFor()?.disabled && !turnFor()?.controller?.signal?.aborted;

  const output = {
    schema: {
      type: 'object',
      properties: { content: { type: 'string' }, isError: { type: 'boolean' } },
      required: ['content', 'isError'], additionalProperties: false,
    },
    render: (_args, value) => [{ type: 'text', text: value.content }],
  };

  const definition = {
    name: 'wechat_voice_send',
    description:
      '把一段文字转成语音，随本条微信回复自动发出（对方会收到一条语音条）。' +
      '适合需要“用嘴说”的语气、安慰、哄人、念诗、道晚安，或对方明确要求发语音时使用。' +
      '文字要自然口语、不加表情符号和 Markdown；单条尽量 50 字以内（最多约 60 秒）。' +
      '每轮最多一次，失败就改用文字回复，不要反复重试。',
    parameters: {
      type: 'object',
      properties: {
        text: { type: 'string', minLength: 1, maxLength: MAX_TEXT, description: '要念出来的内容，自然口语。' },
        voice: {
          type: 'string',
          description: '可选音色。默认 zh-CN-XiaoxiaoNeural（女声）；男声 zh-CN-YunxiNeural；活泼女声 zh-CN-XiaoyiNeural。',
        },
      },
      required: ['text'],
      additionalProperties: false,
    },
  };

  const disposer = agentCtx.tools.register({
    ...definition, output,
    async execute(args) {
      try {
        if (!executable()) throw Error('VOICE_NOT_ALLOWED');
        const turn = turnFor();
        if ((turn.calls ?? 0) >= 1) throw Error('VOICE_TURN_LIMIT');
        const text = String(args?.text ?? '').trim();
        if (!text || text.length > MAX_TEXT) throw Error('VOICE_TEXT_INVALID');
        if (!fs.existsSync(script)) throw Error('VOICE_SCRIPT_MISSING');
        turn.calls = (turn.calls ?? 0) + 1;

        const py = pythonExe(root);
        const json = await runPython(py, script, [text, '--root', root], PY_TIMEOUT_MS);
        if (!json?.ok) throw Error(String(json?.error ?? 'VOICE_GEN_FAILED'));
        if (!Number.isFinite(json.duration) || json.duration <= 0) throw Error('VOICE_DURATION_INVALID');
        if (json.duration > MAX_VOICE_MS) throw Error('VOICE_TOO_LONG');
        if (!fs.existsSync(json.path)) throw Error('VOICE_FILE_MISSING');

        turn.voices = turn.voices ?? [];
        turn.voices.push({ path: json.path, duration: json.duration, sha256: json.sha256, text: text.slice(0, 120) });
        return {
          content: JSON.stringify({
            ok: true, duration: json.duration, bytes: json.bytes,
            notice: '语音已生成，会在本条微信回复发出后自动发送。正常写一句很短的回复即可；不要输出 [VOICE] 之类的标记，也不要声称“我正在说话”。',
          }), isError: false,
        };
      } catch (error) {
        const code = /^(VOICE_[A-Z_]+)/.test(error?.message ?? '') ? error.message : 'VOICE_GEN_FAILED';
        return {
          content: JSON.stringify({
            ok: false, error: code,
            notice: '这次没发成语音。不要声称已经发出，改用文字回复即可，不要重复调用。',
          }), isError: true,
        };
      }
    },
  });

  // 可见性只跟账号就绪走（回合无关），保证系统提示里的工具列表跨轮字节稳定；
  // 能否执行仍由 executable()（本轮 voiceTurn 未禁用/未中止）把关。
  const names = () => new Set(isAllowed() ? [definition.name] : []);
  const access = {
    names,
    definitions: () => (names().has(definition.name) ? [definition] : []),
    check: name => name === definition.name && executable(),
  };
  Object.defineProperty(agentCtx, VOICE_GEN_POLICY, { value: access, configurable: true });

  void outDir;
  return () => {
    try { disposer?.(); } catch {}
    try { delete agentCtx[VOICE_GEN_POLICY]; } catch {}
  };
}
