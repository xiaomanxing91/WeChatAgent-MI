import {chatSettingsSnapshot} from './conversation-settings.mjs';

export function createDshAccessUI({api,modal,closeModal,escapeHtml:esc,icon,state,renderPage,toast,onSave}) {
  let active = null;
  const keys = () => ['private','group'].flatMap(kind => (state.config.wechat.whitelist[kind === 'group' ? 'groups' : 'private'] ?? []).map(id => `wechat:${kind}:${id}`));
  const nameOf = key => state.names.get(key) ?? `${key.includes(':group:') ? '群聊' : '好友'} · ${key.split(':').at(-1)}`;
  const same = (a,b) => JSON.stringify(a) === JSON.stringify(b);
  const includes = (config,key) => ['private','groups'].some(kind => config.wechat.whitelist[kind].some(id => key === `wechat:${kind === 'groups' ? 'group' : 'private'}:${id}`));

  async function page() {
    let catalog;
    try { catalog = await api('/api/dsh-catalog'); } catch {}
    const assigned = keys().filter(key => {const a = state.config.wechat.dshAccess?.chats?.[key];return a?.skills?.length || a?.tools?.length;}).length;
    return `<section class="card"><div class="card-header"><div><h2>DSH 技能与插件工具</h2><p class="card-description">在 DSH 安装与管理能力，在每个会话里独立分配。新添加的聊天默认不分配技能或插件工具。</p></div><button class="button" data-action="dsh-open">打开 DSH</button></div><div class="capability-overview"><span class="status-tag ${catalog?'ok':'warn'}">${catalog?'DSH 已连接':'DSH 未连接'}</span><span>${catalog?`${catalog.skills.length} 个技能 · ${catalog.tools.length} 个工具`:'连接后可读取可用能力；已保存的分配会保留。'}</span><span>${assigned} / ${keys().length} 个聊天已分配能力</span></div><div class="button-row space-top"><a class="button" href="#chats">${icon('users')}按聊天分配</a><a class="text-link" href="#sessions">管理已有会话 ${icon('arrow')}</a></div></section>`;
  }

  async function dialog(key, initialTab = 'settings') {
    if (!keys().includes(key) || !includes(state.draft,key)) { toast('请先保存聊天范围的更改，再设置此会话。'); return; }
    if (state.savingAll || state.refreshing || state.job?.state === 'running') {toast('请等待当前操作完成。');return;}
    const session = {key,tab:initialTab,saving:false}; active = session;
    const current = () => active === session;
    modal(`会话设置 · ${nameOf(key)}`, '<div class="loading-state">正在读取此会话的设置…</div>', {className:'conversation-modal',onClose:() => {if(current())active=null;}});
    const results = await Promise.allSettled([api('/api/config'), api('/api/dsh-catalog')]);
    if (!current()) return;
    if (results[0].status === 'rejected') {closeModal({force:true});toast(results[0].reason.message);return;}
    const saved = results[0].value;
    if (!includes(saved.config,key)) {closeModal({force:true});toast('聊天范围已变化，请刷新后重试。');return;}
    let catalog = results[1].status === 'fulfilled' ? results[1].value : null;
    const original = chatSettingsSnapshot(saved.config,key), draft = chatSettingsSnapshot(state.draft,key), before = chatSettingsSnapshot(state.config,key);
    const initial = {settings:{...original.settings},access:same(before.access,draft.access)?original.access:draft.access};
    for (const field of Object.keys(initial.settings)) if (!same(before.settings[field],draft.settings[field])) initial.settings[field] = draft.settings[field];
    let selected = structuredClone(initial.access), form;
    const options = (items,value) => items.map(([id,label]) => `<option value="${esc(id)}" ${String(value??'inherit')===String(id)?'selected':''}>${esc(label)}</option>`).join('');
    const select = (field,label,items,value,help='') => `<div class="field"><label for="chat-${field}">${label}</label><select id="chat-${field}" data-chat-field="${field}">${options(items,value)}</select>${help?`<small>${esc(help)}</small>`:''}</div>`;
    const inherited = enabled => `继承默认（${enabled?'开启':'关闭'}）`;
    const settings = initial.settings, w = saved.config.wechat;
    const settingsPanel = `<div class="form-grid">${select('persona','人格',[['',`跟随默认（${saved.config.persona.default}）`],...state.roles.map(role => [role.name,role.name])],settings.persona??'','人格在 WeChatAgent MI 管理；更改后需重启服务。')}${key.includes(':group:')?select('mode','群聊回复方式',[['inherit',`继承默认（${w.wake_mode==='mention'?'唤醒后回复':'自然参与'}）`],['hybrid','自然参与'],['mention','唤醒后回复']],settings.mode,'仅在此群生效，保存后应用到后续消息。'):''}${select('stickers','表情发送',[['inherit',inherited(w.stickers?.enabled!==false)],['on','开启'],['off','关闭']],settings.stickers===null?null:settings.stickers?'on':'off')}${select('search','联网搜索',[['inherit',inherited(w.search?.enabled===true)],['on','开启'],['off','关闭']],settings.search===null?null:settings.search?'on':'off','联网关闭时，此聊天的 DSH 外部技能与工具也会受到限制。')}${select('proactive','主动聊天',[['off','关闭'],['on','开启']],settings.proactive?'on':'off',`总开关当前${w.proactive?.enabled?'开启':'关闭'}，还需符合回复设置中的时间与间隔。`)}<div class="field"><label for="chat-context">上下文压缩阈值 / token</label><input id="chat-context" data-chat-field="context" type="number" min="0" max="2000000" step="1" value="${settings.context??''}" placeholder="继承 ${w.context?.maxTokens??100000}"><small>留空继承默认，0 关闭；启用值至少 4,000。总开关当前${w.context?.enabled?'开启':'关闭'}。</small></div></div>`;
    const body = `<form id="chat-settings-form" novalidate><p class="conversation-identity"><span class="status-tag ok">${key.includes(':group:')?'群聊':'好友'}</span><span class="mono">ID ${esc(key.split(':').at(-1))}</span><span>设置仅用于此聊天，重新初始化上下文后仍保留。</span></p><div class="conversation-tabs" role="tablist" aria-label="会话设置类别"><button type="button" role="tab" id="chat-tab-settings" aria-controls="chat-panel-settings" data-chat-tab="settings">会话设置</button><button type="button" role="tab" id="chat-tab-access" aria-controls="chat-panel-access" data-chat-tab="access">技能与工具 <span id="chat-access-count"></span></button></div><div class="conversation-scroll"><section id="chat-panel-settings" role="tabpanel" aria-labelledby="chat-tab-settings">${settingsPanel}</section><section id="chat-panel-access" role="tabpanel" aria-labelledby="chat-tab-access"><p class="modal-description">技能提供任务说明；实际操作还需勾选相应插件工具。安装与配置在 DSH 完成，权限继续由 DSH 管理。</p><div class="capability-toolbar"><input id="chat-capability-search" type="search" aria-label="搜索技能或工具" placeholder="搜索技能或工具"><label><input type="checkbox" id="chat-selected-only">仅看已选</label><button type="button" class="button small" id="chat-catalog-refresh">刷新清单</button></div><p id="chat-catalog-status" class="card-description" role="status"></p><div id="chat-capability-options"></div><p id="chat-capability-empty" class="empty-state" hidden>没有匹配的技能或工具，试试其他关键词。</p></section></div><div class="conversation-footer"><p id="chat-save-error" class="extension-error" role="alert" hidden></p><div id="chat-discard-prompt" class="notice" hidden><span>此会话有未保存的修改。</span><button class="button small" type="button" id="chat-keep-editing">继续编辑</button><button class="button small" type="button" id="chat-discard">放弃修改</button></div><div class="conversation-save-row"><span id="chat-save-state" class="subtle" role="status"></span><div class="button-row"><button class="button" type="button" data-close>取消</button><button class="button primary" type="submit">保存此会话</button></div></div></div></form>`;
    modal(`会话设置 · ${nameOf(key)}`,body,{className:'conversation-modal',beforeClose:() => {
      if(session.saving)return false;
      if(dirty()){form.querySelector('#chat-discard-prompt').hidden=false;form.querySelector('#chat-keep-editing').focus();return false;}
      return true;
    },onClose:() => {if(current())active=null;}}); active=session;
    form=document.querySelector('#chat-settings-form');
    const read = () => ({settings:{
      persona:form.querySelector('#chat-persona').value===''?null:form.querySelector('#chat-persona').value,
      mode:key.includes(':group:')?(form.querySelector('#chat-mode').value==='inherit'?null:form.querySelector('#chat-mode').value):null,
      ...Object.fromEntries(['stickers','search'].map(field => {const value=form.querySelector(`#chat-${field}`).value;return [field,value==='inherit'?null:value==='on'];})),
      proactive:form.querySelector('#chat-proactive').value==='on',context:form.querySelector('#chat-context').value===''?null:Number(form.querySelector('#chat-context').value),
    },access:Object.fromEntries(['skills','tools'].map(kind=>[kind,[...selected[kind]].sort()]))});
    const dirty = () => !same(read(),original);
    const button = form.querySelector('[type=submit]');
    function paint() {
      const changed=dirty();button.disabled=session.saving||session.refreshing||!changed;button.textContent=session.saving?'正在保存…':'保存此会话';
      form.querySelector('#chat-save-state').textContent=session.saving?'正在保存当前聊天':changed?'有未保存的修改':'此会话设置已保存';
      form.querySelector('#chat-access-count').textContent=selected.skills.length+selected.tools.length;
    }
    function filter() {
      const query=form.querySelector('#chat-capability-search').value.trim().toLowerCase(),only=form.querySelector('#chat-selected-only').checked;let visible=0;
      for(const row of form.querySelectorAll('[data-capability-row]')) {row.hidden=!row.dataset.search.includes(query)||(only&&!row.querySelector('input').checked);if(!row.hidden)visible++;}
      form.querySelector('#chat-capability-empty').hidden=visible>0;
    }
    function paintCatalog() {
      form.querySelector('#chat-catalog-status').textContent=catalog?'清单已连接 DSH；勾选不代表已保存。':'DSH 未连接，暂时无法添加新能力；已分配的能力保留，可取消分配后保存。';
      form.querySelector('#chat-capability-options').innerHTML=['skills','tools'].map(kind=>{
        const available=new Map((catalog?.[kind]??[]).map(item=>[item.name,item]));const list=new Map(available);
        for(const name of new Set([...original.access[kind],...selected[kind]]))if(!list.has(name))list.set(name,{name,description:'当前 DSH 未加载此项，已保存的分配保留。'});
        return `<fieldset class="extension-fieldset capability-list"><legend>${kind==='skills'?'技能':'插件工具'} <span data-kind-count="${kind}">${selected[kind].length}</span></legend>${[...list.values()].map(item=>`<label class="extension-option dsh-option" data-capability-row data-search="${esc((item.name+' '+(item.description??'')).toLowerCase())}"><input type="checkbox" data-dsh-kind="${kind}" value="${esc(item.name)}" ${selected[kind].includes(item.name)?'checked':''}><span class="capability-copy"><strong>${esc(item.name)} ${available.has(item.name)?'':'<span class="status-tag warn">未加载</span>'}</strong><small>${esc(item.description)}</small></span></label>`).join('')||'<p class="card-description">尚无可选项，请在 DSH 安装并启用后刷新清单。</p>'}</fieldset>`;
      }).join('');filter();paint();
    }
    function switchTab(tab) {
      session.tab=tab;
      for(const name of ['settings','access']) {const tabButton=form.querySelector(`[data-chat-tab="${name}"]`);tabButton.setAttribute('aria-selected',String(tab===name));tabButton.tabIndex=tab===name?0:-1;form.querySelector(`#chat-panel-${name}`).hidden=tab!==name;}
    }
    form.addEventListener('input',event=>{
      if(event.target.matches('#chat-capability-search,#chat-selected-only'))filter();
      if(event.target.dataset.dshKind) {const kind=event.target.dataset.dshKind,name=event.target.value;selected[kind]=event.target.checked?[...selected[kind],name]:selected[kind].filter(value=>value!==name);form.querySelector(`[data-kind-count="${kind}"]`).textContent=selected[kind].length;filter();}
      const context=form.querySelector('#chat-context'),value=Number(context.value);context.setCustomValidity(context.value!==''&&value!==0&&(!Number.isSafeInteger(value)||value<4000)?'填 0 关闭，或输入至少 4,000 token；留空继承默认。':'');
      form.querySelector('#chat-discard-prompt').hidden=true;paint();
    });
    form.addEventListener('click',event=>{const tab=event.target.closest('[data-chat-tab]');if(tab)switchTab(tab.dataset.chatTab);});
    form.querySelector('[role=tablist]').addEventListener('keydown',event=>{if(['ArrowLeft','ArrowRight','Home','End'].includes(event.key)){event.preventDefault();switchTab(event.key==='Home'?'settings':event.key==='End'?'access':session.tab==='settings'?'access':'settings');form.querySelector(`[data-chat-tab="${session.tab}"]`).focus();}});
    form.querySelector('#chat-keep-editing').addEventListener('click',()=>{form.querySelector('#chat-discard-prompt').hidden=true;form.querySelector(`[data-chat-tab="${session.tab}"]`).focus();});
    form.querySelector('#chat-discard').addEventListener('click',()=>closeModal({force:true}));
    form.querySelector('#chat-catalog-refresh').addEventListener('click',async event=>{
      if(session.saving)return;
      const refresh=event.currentTarget;refresh.disabled=true;session.refreshing=true;paint();
      try {catalog=await api('/api/dsh-catalog');}catch{catalog=null;}
      if(current()){session.refreshing=false;refresh.disabled=false;paintCatalog();}
    });
    form.addEventListener('submit',async event=>{
      event.preventDefault();if(session.saving||session.refreshing||!dirty())return;
      if(!form.checkValidity()){switchTab('settings');form.reportValidity();return;}
      session.saving=true;paint();form.querySelector('#chat-save-error').hidden=true;
      for(const input of form.querySelectorAll('input,select'))input.disabled=true;
      try {
        const result=await api('/api/chat-settings',{revision:saved.revision,key,...read()});
        if(!current())return;
        onSave(result,key);closeModal({force:true});await renderPage();toast(result.personaChanged?'此会话已保存；人格更改需重启服务，其他设置在后续消息中应用。':'此会话已保存，设置在后续消息中应用。');
      }catch(error){if(current()){const field=form.querySelector('#chat-save-error');field.textContent=error.message+(error.status===409?' 当前选择已保留，请取消后重新打开以读取最新设置。':'');field.hidden=false;}}
      finally {session.saving=false;if(current()){for(const input of form.querySelectorAll('input,select'))input.disabled=false;paint();}}
    });
    switchTab(initialTab);paintCatalog();
  }
  document.addEventListener('click',event=>{const button=event.target.closest('[data-dsh-chat],[data-chat-settings]');if(button)dialog(button.dataset.dshChat??button.dataset.chatSettings,button.dataset.dshChat?'access':'settings').catch(error=>toast(error.message));});
  return {page};
}
