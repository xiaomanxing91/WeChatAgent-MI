import { withoutSocialTools } from './social-tool-policy.mjs';
import { WEB_READER_POLICY } from './web-reader-policy.mjs';
import {MODEL_SEARCH_POLICY} from './model-search.mjs';
import {DSH_ACCESS_POLICY} from './dsh-access.mjs';
import {MEME_LIBRARY_POLICY} from './meme-library-policy.mjs';
import {IMAGE_GEN_POLICY} from './image-gen-policy.mjs';
import {VOICE_GEN_POLICY} from './voice-gen.mjs';
import fs from 'node:fs';
import path from 'node:path';
import {MEMBER_MEMORY_POLICY} from './member-memory-policy.mjs';
export const name = 'social-tool-restrict';
export const inject = ['tools'];
// 群会话只放行"写我自己"的两类内容：日记和自我形象。
// 主卡/时间线/资料/备忘涉及身份与硬规则，群里不给写。
const SELF_MEMORY_FILES = Object.freeze(['diary', 'growth']);
const SELF_MEMORY = Object.freeze({
  names: () => ['chat_memory_write'],
  check: name => name === 'chat_memory_write',
});
const selfMemoryFileOf = exec => (typeof exec?.arguments?.file === 'string' ? exec.arguments.file : '');
export function apply(ctx) {
  ctx.tools.presentAs?.('native'); // Visibility and execution use the same live per-chat authorization below.
  const policies = agent => [Symbol.for('wechatagent.extension-tools.v1'),WEB_READER_POLICY,MODEL_SEARCH_POLICY,DSH_ACCESS_POLICY,MEME_LIBRARY_POLICY,MEMBER_MEMORY_POLICY,IMAGE_GEN_POLICY,VOICE_GEN_POLICY,SELF_MEMORY]
    .map(symbol => (typeof symbol === 'symbol' ? (agent?.ctx?.[symbol] ?? ctx[symbol]) : symbol)).filter(Boolean);
  ctx.tools.guard(exec => policies(exec?.agent).some(policy => policy.check(exec?.name)) ? undefined : '微信群友会话不允许调用未授权工具');
  // 参数级：记忆写入只允许 diary / growth，其它目标一律拒绝。
  ctx.tools.guard(exec => {
    if (exec?.name !== 'chat_memory_write') return undefined;
    if (!policies(exec?.agent).some(policy => policy.check(exec.name))) return undefined;
    return SELF_MEMORY_FILES.includes(selfMemoryFileOf(exec)) ? undefined : '群会话只能写日记(diary)或自我形象(growth)';
  });
  const symbols = [Symbol.for('wechatagent.extension-tools.v1'),WEB_READER_POLICY,MODEL_SEARCH_POLICY,DSH_ACCESS_POLICY,MEME_LIBRARY_POLICY,MEMBER_MEMORY_POLICY,IMAGE_GEN_POLICY,VOICE_GEN_POLICY,SELF_MEMORY];
  const trace = (scope, names, list) => { try {
    const file=path.join(path.resolve(import.meta.dirname,'..','..'),'state','logs','tool-filter.log');
    const row={at:new Date().toISOString(),scopeCtx:!!scope?.ctx,meme:!!(scope?.ctx?.[MEME_LIBRARY_POLICY]??ctx[MEME_LIBRARY_POLICY]),image:!!(scope?.ctx?.[IMAGE_GEN_POLICY]??ctx[IMAGE_GEN_POLICY]),names:[...names],tools:list};
    fs.appendFileSync(file, JSON.stringify(row)+'\n');
  } catch {} };
  ctx.on('system-prompt/assemble', async (_assembly, context, next) => {
    const original = await next(), assembly=original.sections?.some(section=>section.name==='dsh-expression:companion')?{...original,sections:original.sections.filter(section=>section.name!=='dsh-expression:companion')}:original, names = new Set(policies(context?.scope).flatMap(policy => [...policy.names()]));
    trace(context?.scope,names,(assembly.tools??[]).map(tool=>tool.name));
    return names.size ? { ...assembly, tools: assembly.tools.filter(tool => names.has(tool.name)).map(({deferLoading,...tool})=>tool) } : withoutSocialTools(assembly);
  }, { prepend: true });
}
