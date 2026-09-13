const $ = selector => document.querySelector(selector);
function notice(message, error = false) { $('#notice').hidden = false; $('#notice').textContent = message; $('#notice').classList.toggle('error', error); }
async function api(path, method = 'GET', payload) {
  const response = await fetch(path, { method, cache: 'no-store', headers: payload === undefined ? {} : { 'Content-Type': 'application/json' }, body: payload === undefined ? undefined : JSON.stringify(payload) });
  const data = await response.json();
  if (response.status === 401) { location.replace('/'); throw new Error('会话已失效，请重新登录'); }
  if (!response.ok) { const error = new Error(data.error.message); error.details = data.error; throw error; }
  return data;
}
function action(fn) { return async event => { event.preventDefault(); $('#notice').hidden = true; const button = event.submitter || (event.currentTarget instanceof HTMLButtonElement ? event.currentTarget : null); if (button) button.disabled = true; try { await fn(event); } catch (error) { notice(error.message || '网络连接失败，请重试', true); } finally { if (button) button.disabled = false; } }; }
function clearSecrets() { for (const id of ['#signing-key', '#github-token', '#new-key']) $(id).value = ''; $('#created-key').hidden = true; }
function hideSecrets() { for (const button of document.querySelectorAll('.toggle-secret')) { document.getElementById(button.dataset.target).type = 'password'; button.textContent = '显示'; button.setAttribute('aria-pressed', 'false'); } }
window.addEventListener('pagehide', clearSecrets);
window.addEventListener('pageshow', event => { if (event.persisted) location.reload(); });
let panelEpoch = 0;
for (const tab of document.querySelectorAll('.tab')) tab.addEventListener('click', action(async () => {
  const epoch = ++panelEpoch; clearSecrets(); hideSecrets(); $('#notice').hidden = true;
  for (const item of document.querySelectorAll('.tab')) { item.classList.toggle('active', item === tab); if (item === tab) item.setAttribute('aria-current', 'page'); else item.removeAttribute('aria-current'); }
  for (const panel of document.querySelectorAll('.panel')) panel.hidden = panel.id !== tab.dataset.panel;
  if (tab.dataset.panel === 'keys') await loadKeys();
  if (tab.dataset.panel === 'projects') await loadRules();
  if (tab.dataset.panel === 'settings') { const data = await api('/api/admin/settings'); if (epoch !== panelEpoch) return; $('#signing-key').value = data.signingKey; $('#github-token').value = data.githubToken; }
}));
$('#logout').addEventListener('click', action(async () => { await api('/api/auth/logout', 'POST'); clearSecrets(); location.replace('/'); }));
for (const button of document.querySelectorAll('.toggle-secret')) button.addEventListener('click', () => { const input = document.getElementById(button.dataset.target); const visible = input.type === 'password'; input.type = visible ? 'text' : 'password'; button.textContent = visible ? '隐藏' : '显示'; button.setAttribute('aria-pressed', String(visible)); });
$('#generate-signing').addEventListener('click', () => { $('#signing-key').value = btoa(String.fromCharCode(...crypto.getRandomValues(new Uint8Array(32)))).replaceAll('+', '-').replaceAll('/', '_').replace(/=+$/, ''); });
$('#settings-form').addEventListener('submit', action(async () => { const data = await api('/api/admin/settings', 'PUT', { signingKey: $('#signing-key').value, githubToken: $('#github-token').value }); hideSecrets(); if (data.relogin) { clearSecrets(); location.replace('/'); } else notice('设置已保存。跨地区生效可能需要 60 秒或更久。'); }));
$('#resolve-form').addEventListener('submit', action(async event => {
  $('#resolve-result').textContent = '正在解析…';
  const params = new URLSearchParams({ repo: $('#resolve-repo').value, arch: $('#resolve-arch').value, refresh: event.submitter?.name === 'refresh' ? '1' : '0' });
  try { $('#resolve-result').textContent = JSON.stringify(await api(`/api/admin/resolve?${params}`, 'POST'), null, 2); }
  catch (error) { $('#resolve-result').textContent = JSON.stringify(error.details || { message: error.message }, null, 2); throw error; }
}));
function element(tag, className, text) { const node = document.createElement(tag); node.className = className; if (text !== undefined) node.textContent = text; return node; }
function row(title, detail, buttons) { const node = element('div', 'list-row'); const description = element('div', ''); description.append(element('div', 'row-title', title), element('div', 'row-detail', detail)); const actions = element('div', 'row-actions'); actions.append(...buttons); node.append(description, actions); return node; }
function button(text, callback, danger = false) { const node = element('button', danger ? 'danger' : 'secondary', text); node.type = 'button'; node.addEventListener('click', action(callback)); return node; }
async function loadRules() { const data = await api('/api/admin/rules'); const list = $('#rules-list'); list.replaceChildren(); if (!data.rules.length) list.append(element('div', 'empty', '还没有项目规则。可以先在上方解析一个仓库。')); for (const rule of data.rules) list.append(row(rule.repo, Object.entries(rule.patterns).map(([arch, pattern]) => `${arch}: ${pattern}`).join('  ·  '), [button('编辑', () => { $('#rule-repo').value = rule.repo; for (const arch of ['x64', 'arm64', 'x86']) $(`#rule-${arch}`).value = rule.patterns[arch] || ''; $('#rule-repo').focus(); }), button('删除', async () => { await api(`/api/admin/rules?${new URLSearchParams({ repo: rule.repo })}`, 'DELETE'); notice('规则已删除，列表可能延迟更新。'); await loadRules(); }, true)])); }
$('#rule-form').addEventListener('submit', action(async () => { const patterns = {}; for (const arch of ['x64', 'arm64', 'x86']) patterns[arch] = $(`#rule-${arch}`).value; await api('/api/admin/rules', 'PUT', { repo: $('#rule-repo').value, patterns }); notice('规则已保存，生效和列表更新可能需要 60 秒或更久。'); await loadRules(); }));
$('#reload-rules').addEventListener('click', action(loadRules));
const beijing = value => new Intl.DateTimeFormat('zh-CN', { timeZone: 'Asia/Shanghai', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false }).format(new Date(value));
$('#key-duration').addEventListener('change', () => { const custom = $('#key-duration').value === 'custom'; $('#custom-end').hidden = !custom; $('#key-end').required = custom; });
$('#key-form').addEventListener('submit', action(async () => {
  const start = $('#key-start').value ? new Date(`${$('#key-start').value}:00+08:00`) : new Date();
  const end = $('#key-duration').value === 'custom' ? new Date(`${$('#key-end').value}:00+08:00`) : new Date(start.getTime() + Number($('#key-duration').value) * 86400000);
  const data = await api('/api/admin/keys', 'POST', { name: $('#key-name').value, startsAt: start.toISOString(), expiresAt: end.toISOString() });
  $('#created-key').hidden = false; $('#new-key').value = data.apiKey; notice('密钥已创建，请复制保存。首次使用可能需等待 KV 同步。'); await loadKeys();
}));
$('#copy-key').addEventListener('click', action(async () => { await navigator.clipboard.writeText($('#new-key').value); notice('已复制 API Key。'); }));
async function loadKeys() { const data = await api('/api/admin/keys'); const list = $('#keys-list'); list.replaceChildren(); if (!data.keys.length) list.append(element('div', 'empty', '尚未创建 API 密钥。')); for (const key of data.keys) { const now = Date.now(); const state = !key.enabled ? '已停用' : now >= key.expiresAt ? '已到期' : now < key.startsAt ? '待生效' : '有效'; list.append(row(`${key.name} · ${state}`, `${beijing(key.startsAt)} → ${beijing(key.expiresAt)}（北京时间）`, [button(key.enabled ? '停用' : '启用', async () => { await api(`/api/admin/keys/${key.id}`, 'PATCH', { enabled: !key.enabled }); notice('状态已保存，可能延迟生效。'); await loadKeys(); }), button('删除', async () => { await api(`/api/admin/keys/${key.id}`, 'DELETE'); notice('密钥已删除，可能延迟生效。'); await loadKeys(); }, true)])); } }
$('#reload-keys').addEventListener('click', action(loadKeys));
loadRules().catch(error => notice(error.message, true));
