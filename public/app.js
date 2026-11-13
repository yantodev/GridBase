'use strict';
const C = window.WorkbenchCore;
const $ = selector => document.querySelector(selector);
const HISTORY_STORAGE_KEY = 'thrift-query-workbench:history:v1';
const DRAFT_STORAGE_KEY = 'thrift-query-workbench:drafts:v1';
const CONNECTIONS_STORAGE_KEY = 'gridbase:connections:v1';
const RESULTS_PAGE_SIZE = 10;
const MAX_HISTORY_ITEMS = 5;
function readStorage(key) { try { return window.localStorage.getItem(key); } catch { return null; } }
function loadHistory() {
  try { return JSON.parse(readStorage(HISTORY_STORAGE_KEY) || '[]').filter(h => h && typeof h.sql === 'string' && h.sql.length <= 20000 && Number.isFinite(h.ranAt) && Number.isFinite(h.rows)).slice(0, MAX_HISTORY_ITEMS); }
  catch { return []; }
}
function saveHistory() {
  try { window.localStorage.setItem(HISTORY_STORAGE_KEY, JSON.stringify(state.history)); } catch { setToast('History could not be saved in this browser.'); }
}
function safeConnectionProfile(profile) {
  return {id: typeof profile.id === 'string' && /^[a-zA-Z0-9_-]{1,100}$/.test(profile.id) ? profile.id : C.newTab().id.replace('sql-', 'connection-'),
    name: profile.name.slice(0, 80), type: profile.type,
    host: String(profile.host || '').slice(0, 256), port: String(profile.port || '').slice(0, 8),
    database: String(profile.database || '').slice(0, 256), username: String(profile.username || '').slice(0, 256), ssl: Boolean(profile.ssl), serverSaved: Boolean(profile.serverSaved)};
}
function loadConnections() {
  try {
    const data = JSON.parse(readStorage(CONNECTIONS_STORAGE_KEY) || '[]');
    const seen = new Set();
    return Array.isArray(data) ? data.filter(item => item && typeof item.name === 'string' && ['hive','postgresql','mysql'].includes(item.type))
      .slice(0, 20).map(safeConnectionProfile).filter(item => !seen.has(item.id) && seen.add(item.id)) : [];
  } catch { return []; }
}
function saveConnections() {
  try { window.localStorage.setItem(CONNECTIONS_STORAGE_KEY, JSON.stringify(state.connectionProfiles)); }
  catch { setToast('Daftar koneksi tidak dapat disimpan di browser.'); }
}
const state = {
  ...C.restoreDrafts(readStorage(DRAFT_STORAGE_KEY)), history: loadHistory(), connectionProfiles: loadConnections(), configured: false,
  connections: new Map(), selectedConnectionId: null, editingConnectionId: null, serverError: '', connectionPending: false, connectionLoading: false,
  sidebarOpen: !window.matchMedia('(max-width: 700px)').matches, tool: 'database',
};
const editor = $('#sql-editor');
let saveTimer, completionRange, connectionCheckVersion = 0, connectionFormVersion = 0;
const active = () => state.tabs.find(t => t.id === state.activeId);
function makeConnection(profile, connected = false) {
  return {...profile, connected, expanded: connected, schemas: [], schemaEntries: new Map(), columns: new Map(), metadataLoading: false, metadataError: '', metadataLoaded: false, version: 0};
}
for (const profile of state.connectionProfiles) state.connections.set(profile.id, makeConnection(profile));
const tabConnection = () => state.connections.get(active()?.connectionId);
const selectedConnection = () => state.connections.get(state.selectedConnectionId);
const typeLabel = type => ({postgresql:'PostgreSQL',mysql:'MySQL',hive:'Spark Thrift / Hive'}[type] || 'SQL');
const metadataUrl = (path, id, params = {}) => path + '?' + new URLSearchParams({connectionId:id, ...params});
function persistDrafts() {
  window.clearTimeout(saveTimer);
  try { window.localStorage.setItem(DRAFT_STORAGE_KEY, C.serializeDrafts(state)); }
  catch { setToast('Drafts could not be saved. Keep a copy before closing this browser.'); }
}
function setToast(message) {
  $('#toast').textContent = message;
  window.clearTimeout(setToast.timer);
  setToast.timer = window.setTimeout(() => { $('#toast').textContent = 'Ready'; }, 5000);
}
function element(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}
function icon(name) {
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  svg.setAttribute('aria-hidden', 'true');
  const use = document.createElementNS('http://www.w3.org/2000/svg', 'use');
  use.setAttribute('href', '#i-' + name); svg.append(use); return svg;
}
function button(label, className, handler) {
  const node = element('button', className, label); node.type = 'button';
  if (handler) node.addEventListener('click', handler); return node;
}
function restoreFocus(root, work) {
  const focusKey = root.contains(document.activeElement) ? document.activeElement.dataset.focus : null;
  work();
  if (focusKey) [...root.querySelectorAll('[data-focus]')].find(n => n.dataset.focus === focusKey)?.focus();
}
async function api(url, options = {}) {
  let response;
  try { response = await fetch(url, options); } catch { throw new Error('Server tidak dapat dijangkau. Periksa server lalu coba kembali.'); }
  let data;
  try { data = await response.json(); } catch { throw new Error('Respons server tidak valid. Periksa log server lalu coba kembali.'); }
  if (!response.ok) throw new Error(data.error || 'Request gagal. Coba kembali.');
  return data;
}
function connectionType() { return $('#database-type').value; }
function updateConnectionType() {
  const type = connectionType(), hive = type === 'hive';
  $('#connection-jdbc-wrap').hidden = false;
  $('#connection-jdbc-url').readOnly = !hive;
  for (const id of ['connection-host', 'connection-port']) {
    $('#' + id).disabled = hive;
    $('#' + id).required = !hive;
  }
  $('#connection-database').placeholder = hive ? 'default' : type === 'mysql' ? 'app_db' : 'postgres';
  $('#connection-port').placeholder = type === 'mysql' ? '3306' : type === 'postgresql' ? '5432' : '10000';
  if (!$('#connection-port').value) $('#connection-port').value = type === 'mysql' ? '3306' : type === 'postgresql' ? '5432' : '10000';
  if (!$('#connection-database').value) $('#connection-database').value = type === 'hive' ? 'default' : type === 'mysql' ? 'mysql' : 'postgres';
  updateJdbcUrl();
}
function updateJdbcUrl() {
  const type = connectionType(); if (type === 'hive') return;
  const host = $('#connection-host').value.trim(), port = $('#connection-port').value.trim(), database = encodeURIComponent($('#connection-database').value.trim()), ssl = $('#connection-ssl').checked;
  $('#connection-jdbc-url').value = `jdbc:${type}://${host}:${port}/${database}?` + (type === 'postgresql' ? `sslmode=${ssl ? 'require' : 'disable'}` : `useSSL=${ssl}&allowPublicKeyRetrieval=true&serverTimezone=UTC`);
}
function resetConnectionForm() {
  if (state.connectionPending) return;
  ++connectionFormVersion; state.connectionLoading = false; updateConnectionBusy();
  state.editingConnectionId = null; $('#disconnect-connection').hidden = true;
  $('#connection-name').value = '';
  $('#database-type').value = 'postgresql';
  $('#connection-host').value = '127.0.0.1';
  $('#connection-port').value = '5432';
  $('#connection-database').value = 'postgres';
  $('#connection-jdbc-url').value = '';
  $('#connection-username').value = '';
  $('#connection-password').value = '';
  $('#connection-ssl').checked = false;
  $('#connection-form-status').textContent = '';
  updateConnectionType();
  $('#connection-name').focus();
}
function loadConnectionForm(profile) {
  state.editingConnectionId = profile.id; $('#disconnect-connection').hidden = !state.connections.get(profile.id)?.connected;
  $('#connection-name').value = profile.name || '';
  $('#database-type').value = profile.type || 'postgresql';
  $('#connection-host').value = profile.host || '';
  $('#connection-port').value = profile.port || '';
  $('#connection-database').value = profile.database || '';
  $('#connection-jdbc-url').value = '';
  $('#connection-username').value = profile.username || '';
  $('#connection-password').value = profile.password || '';
  $('#connection-ssl').checked = Boolean(profile.ssl);
  $('#connection-form-status').textContent = '';
  updateConnectionType();
  if (profile.jdbcUrl) $('#connection-jdbc-url').value = profile.jdbcUrl;
}
async function editConnection(profile) {
  if (state.connectionPending) return;
  const version = ++connectionFormVersion;
  loadConnectionForm({...state.connectionProfiles.find(item => item.id === profile.id), ...profile});
  if (!state.connections.get(profile.id)?.serverSaved) {
    state.connectionLoading = false; updateConnectionBusy();
    $('#connection-form-status').textContent = 'Profil lama belum menyimpan kredensial. Isi password dan JDBC URL sekali lagi, lalu Save.';
    return;
  }
  state.connectionLoading = true; updateConnectionBusy();
  $('#connection-form-status').textContent = 'Loading saved connection…';
  try {
    const details = await api('/api/connections/' + encodeURIComponent(profile.id));
    if (version !== connectionFormVersion) return;
    loadConnectionForm(details);
    $('#connection-name').focus();
  } catch (error) {
    if (version === connectionFormVersion) $('#connection-form-status').textContent = error.message;
  } finally {
    if (version === connectionFormVersion) { state.connectionLoading = false; updateConnectionBusy(); }
  }
}
function connectionPayload() {
  const type = connectionType();
  return {
    type,
    ...(state.editingConnectionId ? {connectionId:state.editingConnectionId} : {}),
    name: $('#connection-name').value.trim(),
    host: $('#connection-host').value.trim(),
    port: $('#connection-port').value.trim(),
    database: $('#connection-database').value.trim(),
    jdbcUrl: $('#connection-jdbc-url').value.trim(),
    username: $('#connection-username').value,
    password: $('#connection-password').value,
    ssl: $('#connection-ssl').checked,
  };
}
function saveConnectionPayload(payload, connection) {
  const safe = safeConnectionProfile({...payload, id:connection.id, serverSaved:true});
  const index = state.connectionProfiles.findIndex(item => item.id === safe.id);
  if (index < 0) state.connectionProfiles.unshift(safe);
  else state.connectionProfiles[index] = safe;
  state.connectionProfiles = state.connectionProfiles.slice(0, 20);
  saveConnections(); renderSavedConnections();
}
function renderSavedConnections() {
  const root = $('#saved-connection-list'); root.replaceChildren();
  if (!state.connectionProfiles.length) { root.append(element('p', 'pane-note', 'Belum ada koneksi tersimpan.')); return; }
  state.connectionProfiles.forEach(profile => {
    const row = element('div', 'saved-connection');
    const load = button('', 'saved-connection-main', () => editConnection(profile));
    load.append(icon('database'), element('span', '', profile.name), element('small', '', profile.type === 'postgresql' ? 'PostgreSQL' : profile.type === 'mysql' ? 'MySQL' : 'Spark Thrift / Hive'));
    const remove = button('', 'saved-connection-remove', () => deleteConnection(profile.id));
    remove.append(icon('close'));
    remove.title = 'Remove saved connection'; remove.setAttribute('aria-label', 'Remove ' + profile.name); row.append(load, remove); root.append(row);
  });
}
async function openConnectionManager(profile) {
  if (state.connectionPending) return;
  renderSavedConnections(); resetConnectionForm(); $('#connection-dialog').showModal();
  if (profile?.id) await editConnection(profile);
  else $('#connection-name').focus();
}
function closeConnectionManager() {
  ++connectionFormVersion; state.connectionLoading = false; updateConnectionBusy();
  $('#connection-password').value = ''; $('#connection-jdbc-url').value = ''; $('#connection-dialog').close();
}
function setConnectionBusy(busy) {
  state.connectionPending = busy;
  updateConnectionBusy();
}
function updateConnectionBusy() {
  const busy = state.connectionPending || state.connectionLoading;
  for (const id of ['test-connection','connect-connection','save-connection','disconnect-connection']) $('#' + id).disabled = busy;
  $('#connection-fields').inert = busy;
  $('#new-connection').disabled = state.connectionPending;
  for (const node of $('#saved-connection-list').querySelectorAll('button')) node.disabled = state.connectionPending;
}
async function deleteConnection(id) {
  if (state.connectionPending) return;
  ++connectionFormVersion; state.connectionLoading = false; setConnectionBusy(true);
  try {
    if (state.connections.get(id)?.serverSaved) await api('/api/connections/' + encodeURIComponent(id), {method:'DELETE'});
    ++connectionCheckVersion; $('#retry-connection').disabled = false;
    const previous = state.connections.get(id); if (previous) previous.version++;
    state.connectionProfiles = state.connectionProfiles.filter(item => item.id !== id);
    state.connections.delete(id);
    setConnectionBusy(false);
    if (state.editingConnectionId === id) resetConnectionForm();
    saveConnections(); renderSavedConnections(); renderExplorer(); updateConnectionUI(); renderTabs();
    setToast('Saved connection deleted.');
  } catch (error) { $('#connection-form-status').textContent = error.message; }
  finally { setConnectionBusy(false); }
}
async function disconnectConnection(id) {
  if (state.connectionPending || state.connectionLoading) return;
  setConnectionBusy(true);
  try {
    await api('/api/connections/disconnect', {method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({connectionId:id})});
    ++connectionCheckVersion; $('#retry-connection').disabled = false;
    const source = state.connections.get(id);
    if (source) { source.connected = false; source.version++; source.metadataLoading = false; source.metadataLoaded = false; source.schemas = []; source.schemaEntries.clear(); source.columns.clear(); }
    closeConnectionManager(); updateConnectionUI(); renderExplorer(); setToast('Connection disconnected. Other data sources remain available.');
  } catch (error) { $('#connection-form-status').textContent = error.message; }
  finally { setConnectionBusy(false); }
}
async function requestConnection(path) {
  if (state.connectionPending || state.connectionLoading) return null;
  if ($('#connection-form').reportValidity && !$('#connection-form').reportValidity()) return null;
  const payload = connectionPayload();
  if (!payload.name || !payload.username || !payload.password || (payload.type === 'hive' && !payload.jdbcUrl)) {
    $('#connection-form-status').textContent = 'Isi nama, username, password, dan detail koneksi terlebih dahulu.'; return null;
  }
  const saving = path === '/api/connections', testing = path.endsWith('/test');
  setConnectionBusy(true); $('#connection-form-status').textContent = testing ? 'Testing connection…' : saving ? 'Saving connection…' : 'Connecting…';
  try {
    const result = await api(path, {method: 'POST', headers: {'Content-Type': 'application/json'}, body: JSON.stringify(payload)});
    $('#connection-form-status').textContent = path.endsWith('/test') ? 'Connection successful.' : 'Connected.';
    if (path.endsWith('/connect') || saving) {
      ++connectionCheckVersion; $('#retry-connection').disabled = false; state.serverError = '';
      const connection = result.connection;
      saveConnectionPayload(payload, connection);
      const previous = state.connections.get(connection.id); if (previous) previous.version++;
      const source = makeConnection({...connection, serverSaved:true}, !saving); state.connections.set(source.id, source); state.selectedConnectionId = source.id;
      closeConnectionManager();
      if (saving) {
        updateConnectionUI(); renderExplorer(); renderTabs(); setToast('Connection saved. Use Connect to open it.'); return result;
      }
      if (!active().connectionId && !active().sql.trim()) { active().connectionId = source.id; persistDrafts(); }
      else addConsole('', undefined, undefined, source.id);
      updateConnectionUI(); renderExplorer(); await refreshMetadata(source.id); setToast('Connected to ' + payload.name + '.');
    }
    return result;
  } catch (error) {
    $('#connection-form-status').textContent = error.message; return null;
  } finally { setConnectionBusy(false); }
}
function updateEditor() {
  const sql = editor.value;
  $('#sql-highlight').innerHTML = C.highlightSql(sql) + '\n';
  $('#line-numbers').textContent = Array.from({length: sql.split('\n').length}, (_, i) => i + 1).join('\n');
  $('#editor-size').textContent = sql.length.toLocaleString('id-ID') + ' characters';
  updateCaret(); syncScroll();
}
function updateCaret() {
  const before = editor.value.slice(0, editor.selectionStart), lines = before.split('\n');
  $('#caret-position').textContent = `Ln ${lines.length}, Col ${lines.at(-1).length + 1}`;
  const tab = active();
  if (tab) { tab.selectionStart = editor.selectionStart; tab.selectionEnd = editor.selectionEnd; }
}
function syncScroll() {
  $('#sql-highlight').scrollTop = editor.scrollTop;
  $('#sql-highlight').scrollLeft = editor.scrollLeft;
  $('#line-numbers').scrollTop = editor.scrollTop;
}
function rememberEditor() {
  const tab = active();
  if (tab) { tab.sql = editor.value; tab.scrollTop = editor.scrollTop; tab.scrollLeft = editor.scrollLeft; updateCaret(); }
}
function renderTabs() {
  const root = $('#console-tabs');
  restoreFocus(root, () => {
    root.replaceChildren();
    state.tabs.forEach(tab => {
      const selected = tab.id === state.activeId;
      const item = element('div', 'console-tab' + (selected ? ' is-active' : ''));
      item.setAttribute('role', 'presentation');
      const select = button('', '', () => switchTab(tab.id));
      select.id = 'tab-' + tab.id; select.dataset.focus = select.id;
      select.setAttribute('role', 'tab'); select.setAttribute('aria-selected', String(selected));
      select.setAttribute('aria-controls', 'console-panel'); select.tabIndex = selected ? 0 : -1;
      select.title = `${tab.name} · ${state.connections.get(tab.connectionId)?.name || 'No connection'}${tab.running ? ' · Running…' : ''} (double-click to rename)`;
      select.append(icon(tab.source ? 'table' : 'code'), element('span', 'tab-name', tab.name + (tab.running ? ' · Running…' : '')));
      select.addEventListener('dblclick', openRename);
      select.addEventListener('keydown', event => {
        const index = state.tabs.indexOf(tab); let target;
        if (event.key === 'ArrowRight') target = state.tabs[(index + 1) % state.tabs.length];
        if (event.key === 'ArrowLeft') target = state.tabs[(index + state.tabs.length - 1) % state.tabs.length];
        if (event.key === 'Home') target = state.tabs[0];
        if (event.key === 'End') target = state.tabs.at(-1);
        if (target) { event.preventDefault(); switchTab(target.id); $('#tab-' + target.id).focus(); }
      });
      const close = button('', 'icon-button', () => closeTab(tab.id));
      close.append(icon('close')); close.setAttribute('aria-label', 'Close ' + tab.name); close.title = tab.running ? 'Wait for execution to finish' : 'Close console';
      close.disabled = Boolean(tab.running); close.dataset.focus = 'close-' + tab.id;
      item.append(select, close); root.append(item);
    });
  });
  $('#new-console').disabled = state.tabs.length >= 20;
  $('#console-panel').setAttribute('aria-labelledby', 'tab-' + state.activeId);
}
function switchTab(id) {
  rememberEditor(); state.activeId = id;
  const tab = active(); editor.value = tab.sql;
  editor.setSelectionRange(tab.selectionStart || 0, tab.selectionEnd || 0);
  editor.scrollTop = tab.scrollTop || 0; editor.scrollLeft = tab.scrollLeft || 0;
  $('#completion-panel').hidden = true;
  updateConnectionUI();
  updateEditor(); renderTabs(); renderResults(); updateRunButton(); persistDrafts();
}
function addConsole(sql = '', name, source, connectionId = state.selectedConnectionId || active()?.connectionId) {
  if (state.tabs.length >= 20) { setToast('Close a console before opening another (maximum 20).'); return null; }
  rememberEditor();
  const tab = C.newTab(name || 'Console ' + (state.tabs.length + 1), sql);
  if (source) tab.source = source;
  tab.connectionId = connectionId || '';
  state.tabs.push(tab); switchTab(tab.id); editor.focus(); return tab;
}
function closeTab(id) {
  const tab = state.tabs.find(t => t.id === id);
  if (!tab || tab.running) return;
  if (tab.sql.trim() && !window.confirm(`Close “${tab.name}”? Its SQL draft and results will be removed.`)) return;
  rememberEditor();
  const index = state.tabs.indexOf(tab); state.tabs.splice(index, 1);
  if (!state.tabs.length) { const empty = C.newTab('Console 1'); if (state.selectedConnectionId) empty.connectionId = state.selectedConnectionId; state.tabs.push(empty); }
  const target = state.activeId === id ? state.tabs[Math.min(index, state.tabs.length - 1)].id : state.activeId;
  // The active draft was already captured before removing its tab.
  state.activeId = target; editor.value = active().sql; switchTab(target);
  $('#tab-' + target).focus();
}
function openRename() {
  $('#console-name').value = active().name; $('#rename-dialog').showModal(); $('#console-name').select();
}
function updateRunButton() {
  $('#run-query').disabled = !tabConnection()?.connected || Boolean(active()?.running);
  $('#run-query').querySelector('span').textContent = active()?.running ? 'Executing…' : 'Execute';
  $('#console-panel').setAttribute('aria-busy', String(Boolean(active()?.running)));
  $('#console-connection').disabled = Boolean(active()?.running);
}
function updateConnectionUI() {
  const source = tabConnection(), connected = Boolean(source?.connected), tab = active();
  state.configured = [...state.connections.values()].some(item => item.connected);
  const status = $('#connection-status');
  status.className = 'connection-status' + (connected ? ' is-configured' : ' is-error');
  $('#connection-label').textContent = state.serverError ? 'Offline' : connected ? 'Connected' : tab?.connectionId ? 'Disconnected' : 'Not configured';
  status.title = source ? source.name + ' · ' + typeLabel(source.type) : 'Select a connection for this console';
  $('#project-name').textContent = source?.name || 'Database workspace';
  $('#server-state').textContent = connected ? typeLabel(source.type) + ' · Read / write' : 'No console connection';
  $('#editor-dialect').textContent = source ? typeLabel(source.type) : 'SQL';
  $('#connection-notice').hidden = connected;
  $('#connection-notice').textContent = state.serverError || (tab?.connectionId ? 'Koneksi tab ini tidak aktif. Hubungkan kembali dari panel Database atau pilih koneksi untuk tab ini.' : 'Tambahkan koneksi dengan tombol Add connection di panel Database sebelah kiri.');
  const select = $('#console-connection'); select.replaceChildren();
  const placeholder = element('option', '', 'Select connection'); placeholder.value = ''; select.append(placeholder);
  for (const item of state.connections.values()) {
    const option = element('option', '', item.name + ' · ' + typeLabel(item.type) + (item.connected ? '' : ' (disconnected)'));
    option.value = item.id; select.append(option);
  }
  if (tab?.connectionId && !source) { const missing = element('option', '', 'Unavailable connection'); missing.value = tab.connectionId; select.append(missing); }
  select.value = tab?.connectionId || ''; select.disabled = Boolean(tab?.running);
  $('#console-context').textContent = tab?.source ? tab.source.namespace + ' / ' + tab.source.table : '';
  $('#console-context').title = $('#console-context').textContent;
  $('#refresh-metadata').disabled = !selectedConnection()?.connected || Boolean(selectedConnection()?.metadataLoading);
  updateRunButton();
}
async function checkConnection() {
  const version = ++connectionCheckVersion; $('#retry-connection').disabled = true;
  try {
    const data = await api('/api/connections');
    if (version !== connectionCheckVersion) return;
    state.serverError = '';
    const live = new Set(data.connections.map(item => item.id));
    state.connectionProfiles = state.connectionProfiles.filter(item => !item.serverSaved || live.has(item.id));
    for (const [id, item] of state.connections) if (item.serverSaved && !live.has(id)) state.connections.delete(id);
    for (const item of state.connections.values()) if (!live.has(item.id)) {
      item.connected = false; item.version++; item.metadataLoading = false; item.metadataLoaded = false; item.schemas = []; item.schemaEntries.clear(); item.columns.clear();
    }
    for (const profile of data.connections) {
      const previous = state.connections.get(profile.id);
      const connected = profile.connected === true;
      if (previous?.connected && connected) Object.assign(previous, profile, {serverSaved:true});
      else { if (previous) previous.version++; state.connections.set(profile.id, makeConnection({...profile, serverSaved:true}, connected)); }
      const safe = safeConnectionProfile({...state.connectionProfiles.find(item => item.id === profile.id), ...profile, serverSaved:true});
      const index = state.connectionProfiles.findIndex(item => item.id === profile.id);
      if (index < 0) state.connectionProfiles.push(safe); else state.connectionProfiles[index] = safe;
    }
    saveConnections(); renderSavedConnections();
    if (!state.connections.has(state.selectedConnectionId)) state.selectedConnectionId = data.defaultConnectionId || data.connections[0]?.id || state.connections.keys().next().value || null;
    // Migrate old drafts once. An explicitly associated missing connection is never reassigned.
    for (const tab of state.tabs) if (!Object.hasOwn(tab,'connectionId') && data.defaultConnectionId) tab.connectionId = data.defaultConnectionId;
    persistDrafts(); updateConnectionUI(); renderExplorer(); renderTabs();
    await Promise.all(data.connections.map(item => {
      const source = state.connections.get(item.id); return source.connected && source.expanded && !source.metadataLoading ? refreshMetadata(item.id) : null;
    }));
  } catch (error) {
    if (version !== connectionCheckVersion) return;
    state.serverError = error.message;
    for (const item of state.connections.values()) { item.connected = false; item.version++; item.metadataLoading = false; }
    updateConnectionUI(); renderExplorer();
  } finally { if (version === connectionCheckVersion) $('#retry-connection').disabled = false; }
}
function metadataNote(text, error = false) { return element('p', 'pane-note metadata-note' + (error ? ' is-error' : ''), text); }
function setSidebar(tool = state.tool, open = true) {
  state.tool = tool; state.sidebarOpen = open;
  $('#app').classList.toggle('sidebar-hidden', !open);
  $('#database-view').hidden = tool !== 'database'; $('#history-view').hidden = tool !== 'history';
  $('#sidebar-heading').textContent = tool === 'database' ? 'Database' : 'Query history';
  $('#sidebar').setAttribute('aria-label', $('#sidebar-heading').textContent);
  $('#refresh-metadata').hidden = tool !== 'database';
  for (const name of ['database', 'history']) {
    $('#' + name + '-tool').classList.toggle('is-active', open && tool === name);
    $('#' + name + '-tool').setAttribute('aria-expanded', String(open && tool === name));
  }
  const mobile = window.matchMedia('(max-width: 700px)').matches;
  $('#sidebar-backdrop').hidden = !open || !mobile;
  $('.workbench').inert = open && mobile;
}
async function refreshMetadata(id = state.selectedConnectionId) {
  const source = state.connections.get(id); if (!source?.connected) return;
  const version = ++source.version;
  source.metadataLoading = true; source.metadataLoaded = false; source.metadataError = ''; source.schemas = []; source.schemaEntries.clear(); source.columns.clear();
  updateConnectionUI(); renderExplorer();
  try {
    const data = await api(metadataUrl('/api/databases', id));
    if (version !== source.version) return;
    source.schemas = data.databases.filter(v => typeof v === 'string').sort((a,b) => a.localeCompare(b)); source.metadataLoaded = true;
  } catch (error) { if (version === source.version) source.metadataError = error.message; }
  finally { if (version === source.version) { source.metadataLoading = false; renderExplorer(); updateConnectionUI(); } }
}
async function toggleSchema(namespace, id = state.selectedConnectionId) {
  const source = state.connections.get(id); if (!source?.connected) return;
  let entry = source.schemaEntries.get(namespace);
  if (entry?.tables && !entry.error && !entry.loading) { entry.expanded = !entry.expanded; renderExplorer(); return; }
  if (entry?.loading) return;
  const version = source.version;
  entry = {expanded:true,loading:true,tables:[],error:''}; source.schemaEntries.set(namespace, entry); renderExplorer();
  try {
    const data = await api(metadataUrl('/api/tables', id, {namespace}));
    if (version !== source.version) return;
    entry.tables = data.tables.filter(v => typeof v === 'string').sort((a,b) => a.localeCompare(b));
  } catch (error) { if (version === source.version) entry.error = error.message; }
  finally { if (version === source.version) { entry.loading = false; renderExplorer(); } }
}
const columnKey = (namespace, table) => JSON.stringify([namespace, table]);
async function toggleColumns(namespace, table, id = state.selectedConnectionId) {
  const source = state.connections.get(id); if (!source?.connected) return;
  const key = columnKey(namespace, table); let entry = source.columns.get(key);
  if (entry?.items && !entry.error && !entry.loading) { entry.expanded = !entry.expanded; renderExplorer(); return; }
  if (entry?.loading) return;
  const version = source.version;
  entry = {expanded:true,loading:true,items:[],error:''}; source.columns.set(key, entry); renderExplorer();
  try {
    const data = await api(metadataUrl('/api/columns', id, {namespace,table}));
    if (version !== source.version) return; entry.items = data.columns;
  } catch (error) { if (version === source.version) entry.error = error.message; }
  finally { if (version === source.version) { entry.loading = false; renderExplorer(); } }
}
function selectSource(source) {
  state.selectedConnectionId = source.id;
  if (!source.connected) { openConnectionManager(source); return; }
  source.expanded = !source.expanded; updateConnectionUI(); renderExplorer();
  if (source.expanded && !source.metadataLoaded && !source.metadataLoading) refreshMetadata(source.id);
}
function renderSchemas(source, search) {
  const list = element('ul','object-list source-objects'), id = source.id;
  source.schemas.forEach(namespace => {
    const entry = source.schemaEntries.get(namespace), schemaMatches = namespace.toLowerCase().includes(search);
    const tables = (entry?.tables || []).filter(name => schemaMatches || name.toLowerCase().includes(search));
    if (search && !schemaMatches && !tables.length) return;
    const item = element('li'), row = element('div','object-row schema-row');
    const expand = button('', 'disclosure', () => toggleSchema(namespace,id)); expand.append(icon('chevron'));
    expand.setAttribute('aria-label','Toggle tables in ' + source.name + ' / ' + namespace); expand.setAttribute('aria-expanded',String(Boolean(entry?.expanded))); expand.dataset.focus = id + ':schema:' + namespace;
    const name = button('', 'object-name', () => toggleSchema(namespace,id)); name.append(icon('schema'), element('span','',namespace)); name.title = namespace; name.dataset.focus = id + ':schema-name:' + namespace;
    row.append(expand,name); item.append(row);
    if (entry?.expanded) {
      if (entry.loading) item.append(metadataNote('Loading tables…'));
      else if (entry.error) item.append(metadataNote(entry.error,true),button('Retry tables','text-button',()=>toggleSchema(namespace,id)));
      else if (!tables.length) item.append(metadataNote(search ? 'No matching loaded tables.' : 'No tables in this schema.'));
      else {
        const children = element('ul','object-list');
        tables.forEach(table => {
          const tableItem = element('li'), tableRow = element('div','object-row table-row'), key = columnKey(namespace,table), columns = source.columns.get(key);
          const disclosure = button('', 'disclosure',()=>toggleColumns(namespace,table,id)); disclosure.append(icon('chevron'));
          disclosure.setAttribute('aria-expanded',String(Boolean(columns?.expanded))); disclosure.setAttribute('aria-label','Show columns of ' + source.name + ' / ' + table); disclosure.dataset.focus = id + ':columns:' + key;
          const open = button('', 'object-name',()=>openTable(namespace,table,id)); open.append(icon('table'),element('span','',table)); open.title = 'Open ' + source.name + ' / ' + namespace + '.' + table + ' · LIMIT 50'; open.dataset.focus = id + ':table:' + key;
          tableRow.append(disclosure,open); tableItem.append(tableRow);
          if (columns?.expanded) {
            if (columns.loading) tableItem.append(metadataNote('Loading columns…'));
            else if (columns.error) tableItem.append(metadataNote(columns.error,true),button('Retry columns','text-button',()=>toggleColumns(namespace,table,id)));
            else if (!columns.items.length) tableItem.append(metadataNote('No columns reported.'));
            else columns.items.forEach(column=>{const line=element('div','column-row');line.append(element('span','column-name',column.name),element('span','column-type',column.type));line.title=column.comment||column.name+' · '+column.type;tableItem.append(line);});
          }
          children.append(tableItem);
        }); item.append(children);
      }
    }
    list.append(item);
  });
  if (!list.children.length) list.append(metadataNote(search ? 'No matching loaded objects. Expand schemas to load tables.' : 'No schemas found.'));
  return list;
}
function renderExplorer() {
  const root = $('#schema-list'); root.setAttribute('aria-busy',String([...state.connections.values()].some(item=>item.metadataLoading)));
  $('#schema-count').textContent = String(state.connections.size);
  restoreFocus(root,()=>{
    root.replaceChildren();
    if (state.serverError) root.append(metadataNote(state.serverError,true),button('Retry server','text-button',checkConnection));
    if (!state.connections.size) { root.append(element('p','pane-note','No data sources yet. Add a connection to browse databases and open SQL consoles.')); return; }
    const search = $('#object-filter').value.toLowerCase();
    for (const source of state.connections.values()) {
      const section = element('section','data-source'), row = element('div','object-row source-row' + (source.id===state.selectedConnectionId?' is-selected':''));
      section.setAttribute('aria-label',source.name + ' · ' + typeLabel(source.type));
      const expand = button('','disclosure',()=>selectSource(source)); expand.append(icon('chevron')); expand.setAttribute('aria-expanded',String(source.expanded)); expand.setAttribute('aria-label','Expand ' + source.name); expand.dataset.focus = 'source-expand:' + source.id;
      const name = button('','object-name source-name',()=>selectSource(source)); name.append(icon('database'),element('span','',source.name)); name.title=source.name+' · '+typeLabel(source.type)+(source.connected?'':' · Reconnect'); name.dataset.focus='source:'+source.id;
      const consoleButton=button('','icon-button',()=>{state.selectedConnectionId=source.id;addConsole('',undefined,undefined,source.id);});consoleButton.append(icon('code'));consoleButton.title='New SQL console for '+source.name;consoleButton.setAttribute('aria-label',consoleButton.title);consoleButton.disabled=!source.connected;consoleButton.dataset.focus='source-console:'+source.id;
      const settings=button('','icon-button',()=>openConnectionManager(source));settings.append(icon('settings'));settings.title='Edit '+source.name;settings.setAttribute('aria-label',settings.title);settings.dataset.focus='source-edit:'+source.id;
      row.append(expand,name,consoleButton,settings); section.append(row);
      section.append(element('p','source-caption',typeLabel(source.type)+' · '+(source.connected?'Configured':'Disconnected · reconnect')));
      if (source.expanded && source.connected) {
        if (source.metadataLoading) section.append(metadataNote('Loading schemas…'));
        else if (source.metadataError) section.append(metadataNote(source.metadataError,true),button('Retry schemas','text-button',()=>refreshMetadata(source.id)));
        else section.append(renderSchemas(source,source.name.toLowerCase().includes(search)?'':search));
      }
      root.append(section);
    }
  });
}
function openTable(namespace, table, id = state.selectedConnectionId) {
  const source = state.connections.get(id); if (!source?.connected) return;
  state.selectedConnectionId = id;
  const existing = state.tabs.find(tab=>tab.connectionId===id && tab.source?.namespace===namespace && tab.source?.table===table);
  if (existing) { switchTab(existing.id); editor.focus(); }
  else { const tab=addConsole(C.tableSql(namespace,table,source.type),table,{namespace,table},id); if(tab)runQuery(tab.sql); }
  renderExplorer();
  if (window.matchMedia('(max-width: 700px)').matches) setSidebar(state.tool,false);
}
function renderHistory() {
  $('#history-count').textContent = state.history.length;
  $('#clear-history').disabled = !state.history.length;
  const root = $('#history-list'); root.replaceChildren();
  if (!state.history.length) { root.append(element('p','pane-note','Executed queries appear here. Select one to open its SQL in a new console.')); return; }
  state.history.forEach(item => {
    const entry = button('', 'history-item', () => addConsole(item.sql, undefined, undefined, item.connectionId || state.selectedConnectionId));
    entry.append(element('code','',item.sql), element('span','history-meta',new Date(item.ranAt).toLocaleTimeString('id-ID',{hour:'2-digit',minute:'2-digit'})+' · '+(state.connections.get(item.connectionId)?.name || 'Database')+' · '+item.rows+' rows'));
    root.append(entry);
  });
}
function setDock(view) {
  active().dock = view;
  for (const name of ['results','output']) {
    const selected = view === name, tab = $('#' + name + '-tab');
    tab.setAttribute('aria-selected',String(selected)); tab.classList.toggle('is-active',selected); tab.tabIndex = selected ? 0 : -1;
    $('#' + name + '-view').hidden = !selected;
  }
}
function resultMessage(title, detail, mode = '') {
  const root = $('#result-state'); root.replaceChildren(icon(mode === 'loading' ? 'refresh' : 'code'),element('h2','',title),element('p','',detail));
  root.className = 'result-state' + (mode ? ' is-' + mode : ''); root.hidden = false;
}
function renderResults() {
  const tab = active(), result = tab.result;
  $('#result-filter').value = tab.filter || '';
  $('#results-table-wrap').hidden = true; $('#result-toolbar').hidden = true; $('#results-pagination').hidden = true; $('#result-state').hidden = true;
  $('#result-count').textContent = result?.columns.length ? String(result.rows.length) : '';
  $('#result-metrics').textContent = result ? `${result.durationMs} ms${result.truncated ? ' · row cap reached' : ''}` : '';
  $('#query-output').textContent = tab.output || 'No statements executed in this console.';
  setDock(tab.dock || 'results');
  if(tab.running) { resultMessage('Executing statement…','Waiting for Spark Thrift Server. You can work in another console.','loading'); return; }
  if(tab.error) { resultMessage('Query could not run',tab.error,'error'); return; }
  if(!result) { resultMessage('Ready to query','Write SQL above, then execute a statement. Open a table from Database to preview 50 rows.'); return; }
  if(!result.columns.length) {
    const count = result.updateCount;
    resultMessage('Statement completed',Number.isInteger(count) && count >= 0 ? `${count} rows affected.` : 'The server did not report an affected-row count.'); return;
  }
  $('#result-toolbar').hidden = false;
  const rows = C.viewRows(result,tab.filter,tab.sort);
  const pages = Math.max(1,Math.ceil(rows.length / RESULTS_PAGE_SIZE));
  tab.page = Math.max(1,Math.min(tab.page || 1,pages));
  const start = (tab.page - 1) * RESULTS_PAGE_SIZE;
  $('#export-csv').disabled = !rows.length; $('#export-json').disabled = !rows.length;
  if (!rows.length) { resultMessage(result.rows.length ? 'No matching rows' : 'No rows returned',result.rows.length ? 'Try a different filter or clear it to show all returned rows.' : 'The statement succeeded and returned an empty result set.'); return; }
  const wrap = $('#results-table-wrap'); wrap.replaceChildren(); wrap.hidden = false;
  const table = element('table','results-table'); table.setAttribute('aria-label','Query results for ' + tab.name);
  const head = element('thead'), header = element('tr'), number = element('th','row-number','#'); number.scope = 'col'; header.append(number);
  result.columns.forEach(column => {
    const th = element('th'); th.scope = 'col';
    const sorted = tab.sort?.column === column;
    th.setAttribute('aria-sort', sorted ? (tab.sort.direction === 1 ? 'ascending' : 'descending') : 'none');
    const sort = button(column,'',()=>{tab.sort = {column,direction:sorted?-tab.sort.direction:1};tab.page=1;renderResults();[...$('#results-table-wrap').querySelectorAll('th button')].find(b=>b.dataset.column===column)?.focus();});
    if(sorted){const arrow=icon('chevron');arrow.classList.add('sort-indicator');arrow.classList.add(tab.sort.direction===1?'is-ascending':'is-descending');sort.append(arrow);}
    sort.dataset.column = column; sort.title = 'Sort by ' + column; th.append(sort); header.append(th);
  }); head.append(header); table.append(head);
  const body = element('tbody');
  rows.slice(start,start + RESULTS_PAGE_SIZE).forEach(({row,index}) => {
    const tr = element('tr'), rowNumber = element('td','row-number');
    const detail = button(String(index + 1),'',()=>openRowDetail(row,result.columns,index + 1)); detail.title = 'Open row ' + (index + 1) + ' detail'; detail.setAttribute('aria-label',detail.title); rowNumber.append(detail); tr.append(rowNumber);
    tr.addEventListener('dblclick',()=>openRowDetail(row,result.columns,index + 1));
    result.columns.forEach(column => {const value=row[column];const cell=element('td',value==null?'null-value':'',value==null?'NULL':String(value));cell.title=cell.textContent;tr.append(cell);}); body.append(tr);
  }); table.append(body); wrap.append(table);
  $('#results-pagination').hidden = false;
  $('#results-range').textContent = `${start + 1}–${Math.min(start+RESULTS_PAGE_SIZE,rows.length)} of ${rows.length} rows${tab.filter ? ' (filtered)' : ''}`;
  $('#results-page').textContent = `${tab.page} / ${pages}`;
  $('#results-previous').disabled = tab.page <= 1; $('#results-next').disabled = tab.page >= pages;
}
function openRowDetail(row,columns,index) {
  const table = element('table'), body = element('tbody');
  columns.forEach(column => {const tr=element('tr'),th=element('th','',column);th.scope='row';tr.append(th,element('td',row[column]==null?'null-value':'',row[column]==null?'NULL':String(row[column])));body.append(tr);});
  table.append(body); $('#row-detail-table-wrap').replaceChildren(table); $('#row-detail-heading').textContent = 'Row ' + index + ' · ' + active().name; $('#row-detail').showModal();
}
async function runQuery(explicitSql) {
  const tab = active();
  if(tab.running || !tabConnection()?.connected)return;
  const connectionId = tab.connectionId;
  rememberEditor();
  const sql = typeof explicitSql === 'string' ? explicitSql : C.executionSql(editor.value,editor.selectionStart,editor.selectionEnd);
  if(!sql.trim()) { setToast('Write a SQL statement before executing.'); editor.focus(); return; }
  tab.running=true; tab.error=''; tab.result=null; tab.output='Executing…\n\n'+sql; tab.dock='results'; tab.page=1; tab.filter=''; tab.sort=null;
  renderTabs(); renderResults(); updateRunButton();
  try {
    const result = await api('/api/query',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({sql,connectionId})});
    if(!Array.isArray(result.columns) || !Array.isArray(result.rows)) throw new Error('Format hasil query tidak valid.');
    tab.result=result;
    const affected = Number.isInteger(result.updateCount) && result.updateCount >= 0;
    const summary = result.columns.length ? `${result.rows.length} rows returned${result.truncated ? ' (server row cap reached)' : ''}.` : affected ? `${result.updateCount} rows affected.` : 'Statement completed. Affected-row count unavailable.';
    tab.output = `${new Date().toLocaleTimeString('id-ID')} · ${result.durationMs} ms\n${summary}\n\n${sql}`;
    state.history.unshift({sql,connectionId,rows:result.rows.length,ranAt:Date.now()}); state.history=state.history.slice(0,MAX_HISTORY_ITEMS);saveHistory();renderHistory();
    setToast(tab.name + ' · ' + summary);
  } catch(error) { tab.error=error.message;tab.output='Execution failed\n'+error.message+'\n\n'+sql;setToast(tab.name+' · Query failed'); }
  finally {
    tab.running=false;renderTabs();
    if(state.activeId===tab.id){renderResults();updateConnectionUI();}
  }
}
function exportResult(format) {
  const tab=active();if(!tab.result)return;
  const rows=C.viewRows(tab.result,tab.filter,tab.sort).map(item=>item.row);
  const body=format==='csv'?C.toCsv(tab.result.columns,rows):JSON.stringify(rows,null,2);
  const url=URL.createObjectURL(new Blob([body],{type:format==='csv'?'text/csv;charset=utf-8':'application/json'}));
  const link=element('a');link.href=url;link.download=tab.name.replace(/[^a-zA-Z0-9_-]/g,'_')+'.'+format;document.body.append(link);link.click();link.remove();window.setTimeout(()=>URL.revokeObjectURL(url),1000);
  setToast(`${rows.length} rows exported as ${format.toUpperCase()}.`);
}
function replaceEditor(start,end,text,selectionStart=start+text.length,selectionEnd=selectionStart) {
  if(editor.value.length-(end-start)+text.length>20000){setToast('Edit exceeds the 20,000-character SQL limit. Shorten the console or use a new one.');return false;}
  editor.setRangeText(text,start,end,'end');editor.setSelectionRange(selectionStart,selectionEnd);editor.dispatchEvent(new Event('input'));editor.focus();return true;
}
function indentEditor(outdent) {
  const start=editor.selectionStart,end=editor.selectionEnd;
  if(start===end && !outdent) {replaceEditor(start,end,'  ');return;}
  const lineStart=editor.value.lastIndexOf('\n',start-1)+1;
  const lines=editor.value.slice(lineStart,end).split('\n');
  let firstChange=0,totalChange=0;
  const value=lines.map((line,index)=>{const removed=outdent?(line.match(/^ {1,2}|^\t/)?.[0].length||0):0;const delta=outdent?-removed:2;if(index===0)firstChange=delta;totalChange+=delta;return outdent?line.slice(removed):'  '+line;}).join('\n');
  replaceEditor(lineStart,end,value,Math.max(lineStart,start+firstChange),Math.max(lineStart,end+totalChange));
}
function showCompletion() {
  const before=editor.value.slice(0,editor.selectionStart),qualifiedPrefix=before.match(/[\w$.]*$/)[0],prefix=qualifiedPrefix.split('.').at(-1);
  const options=new Map(qualifiedPrefix.includes('.')?[]:[...C.KEYWORDS].map(word=>[word,{label:word,value:word,qualified:false}]));
  const source=tabConnection(), databaseType=source?.type || 'hive';
  for(const namespace of source?.schemas || [])options.set(namespace,{label:namespace,value:C.quoteIdentifier(namespace,databaseType),qualified:false});
  for(const [namespace,entry] of source?.schemaEntries || [])for(const table of entry.tables || [])options.set(namespace+'.'+table,{label:namespace+'.'+table,value:C.qualifiedTable(namespace,table,databaseType),qualified:true});
  for(const entry of source?.columns.values() || [])for(const column of entry.items || [])options.set(column.name,{label:column.name,value:C.quoteIdentifier(column.name,databaseType),qualified:false});
  const list=[...options.values()].filter(item=>item.label.toLowerCase().split('.').some(part=>part.startsWith(prefix.toLowerCase()))).slice(0,80);
  if(!list.length){setToast('No matching SQL or loaded objects.');return;}
  completionRange={start:editor.selectionStart-prefix.length,qualifiedStart:editor.selectionStart-qualifiedPrefix.length,end:editor.selectionEnd};
  const select=$('#completion-select');select.replaceChildren();list.forEach(item=>{const option=element('option','',item.label);option.value=item.value;option.dataset.qualified=String(item.qualified);select.append(option);});select.selectedIndex=0;
  $('#completion-panel').hidden=false;select.focus();
}
function insertCompletion() {
  const select=$('#completion-select'),value=select.value,option=select.children[select.selectedIndex];$('#completion-panel').hidden=true;
  if(completionRange)replaceEditor(option?.dataset.qualified==='true'?completionRange.qualifiedStart:completionRange.start,completionRange.end,value);
}
function configureResizer(node,horizontal) {
  const minimum=horizontal?20:200,maximum=horizontal?75:420;
  function apply(value) {
    value=Math.round(Math.max(minimum,Math.min(maximum,value)));
    $('#app').style.setProperty(horizontal?'--editor-height':'--sidebar-width',value+(horizontal?'%':'px'));
    node.setAttribute('aria-valuenow',String(value));node.setAttribute('aria-valuetext',value+(horizontal?' percent':' pixels'));
  }
  node.addEventListener('keydown',event=>{
    const backward=horizontal?'ArrowUp':'ArrowLeft',forward=horizontal?'ArrowDown':'ArrowRight';
    if([backward,forward,'Home','End'].includes(event.key)){event.preventDefault();const current=Number(node.getAttribute('aria-valuenow'));apply(event.key==='Home'?minimum:event.key==='End'?maximum:current+(event.key===backward?-1:1)*(horizontal?5:10));}
  });
  node.addEventListener('pointerdown',event=>{
    event.preventDefault();node.setPointerCapture(event.pointerId);document.body.classList.add('is-resizing');
    const move=e=>{const rect=$('.workbench').getBoundingClientRect();apply(horizontal?(e.clientY-rect.top)/rect.height*100:e.clientX-42);};
    const end=()=>{document.body.classList.remove('is-resizing');node.removeEventListener('pointermove',move);node.removeEventListener('pointerup',end);node.removeEventListener('pointercancel',end);};
    node.addEventListener('pointermove',move);node.addEventListener('pointerup',end);node.addEventListener('pointercancel',end);
  });
}
editor.addEventListener('input',()=>{active().sql=editor.value;updateEditor();window.clearTimeout(saveTimer);saveTimer=window.setTimeout(persistDrafts,300);});
editor.addEventListener('scroll',syncScroll);
for(const name of ['click','keyup','select'])editor.addEventListener(name,updateCaret);
editor.addEventListener('keydown',event=>{
  if((event.ctrlKey||event.metaKey)&&event.key==='Enter'){event.preventDefault();runQuery();}
  else if((event.ctrlKey||event.metaKey)&&event.code==='Space'){event.preventDefault();showCompletion();}
  else if(event.key==='Escape'){event.preventDefault();$('#format-query').focus();setToast('Editor focus released. Use Tab to navigate controls.');}
  else if(event.key==='Tab'){event.preventDefault();indentEditor(event.shiftKey);}
  else if(event.key==='Enter' && !event.ctrlKey && !event.metaKey){event.preventDefault();const prefix=editor.value.slice(0,editor.selectionStart).split('\n').at(-1).match(/^\s*/)[0];replaceEditor(editor.selectionStart,editor.selectionEnd,'\n'+prefix);}
});
$('#run-query').addEventListener('click',()=>runQuery());
$('#new-console').addEventListener('click',()=>addConsole());
$('#rename-console').addEventListener('click',openRename);
$('#rename-form').addEventListener('submit',event=>{event.preventDefault();const name=$('#console-name').value.trim();if(!name)return;active().name=name;persistDrafts();renderTabs();$('#rename-dialog').close();});
$('#cancel-rename').addEventListener('click',()=>$('#rename-dialog').close());
$('#close-row-detail').addEventListener('click',()=>$('#row-detail').close());
$('#format-query').addEventListener('click',()=>{
  const start=editor.selectionStart,end=editor.selectionEnd,selected=start!==end;
  if(replaceEditor(selected?start:0,selected?end:editor.value.length,C.formatSql(selected?editor.value.slice(start,end):editor.value)))setToast('SQL formatted.');
});
$('#close-completion').addEventListener('click',()=>{$('#completion-panel').hidden=true;editor.focus();});
$('#completion-select').addEventListener('dblclick',insertCompletion);
$('#completion-select').addEventListener('keydown',event=>{if(event.key==='Enter'){event.preventDefault();insertCompletion();}if(event.key==='Escape'){event.preventDefault();$('#completion-panel').hidden=true;editor.focus();}});
for(const tool of ['database','history'])$('#'+tool+'-tool').addEventListener('click',()=>setSidebar(tool,!(state.sidebarOpen&&state.tool===tool)));
$('#hide-sidebar').addEventListener('click',()=>{setSidebar(state.tool,false);$('#'+state.tool+'-tool').focus();});
$('#sidebar-backdrop').addEventListener('click',()=>{setSidebar(state.tool,false);$('#'+state.tool+'-tool').focus();});
$('#object-filter').addEventListener('input',renderExplorer);
$('#refresh-metadata').addEventListener('click',()=>refreshMetadata());
$('#retry-connection').addEventListener('click',checkConnection);
$('#manage-connections').addEventListener('click',()=>openConnectionManager());
$('#add-connection').addEventListener('click',()=>openConnectionManager());
$('#disconnect-connection').addEventListener('click',()=>disconnectConnection(state.editingConnectionId));
$('#console-connection').addEventListener('change',()=>{
  const tab=active(); if(tab.running)return;
  tab.connectionId=$('#console-connection').value; delete tab.source; tab.result=null; tab.error=''; tab.output='';
  if(tab.connectionId)state.selectedConnectionId=tab.connectionId;
  persistDrafts(); updateConnectionUI(); renderTabs(); renderResults(); renderExplorer();
});
$('#close-connection').addEventListener('click',closeConnectionManager);
$('#connection-dialog').addEventListener('cancel',closeConnectionManager);
$('#cancel-connection').addEventListener('click',closeConnectionManager);
$('#new-connection').addEventListener('click',resetConnectionForm);
$('#database-type').addEventListener('change',()=>{
  $('#connection-jdbc-url').value = '';
  if (['5432','3306','10000'].includes($('#connection-port').value)) $('#connection-port').value='';
  if (['postgres','mysql','default'].includes($('#connection-database').value)) $('#connection-database').value='';
  updateConnectionType();
});
$('#test-connection').addEventListener('click',()=>requestConnection('/api/connections/test'));
$('#save-connection').addEventListener('click',()=>requestConnection('/api/connections'));
for (const id of ['connection-host','connection-port','connection-database','connection-ssl']) $('#' + id).addEventListener('input', updateJdbcUrl);
$('#connection-form').addEventListener('submit',event=>{event.preventDefault();requestConnection('/api/connections/connect');});
$('#clear-history').addEventListener('click',()=>{state.history=[];saveHistory();renderHistory();});
for(const view of ['results','output']) {
  $('#'+view+'-tab').addEventListener('click',()=>setDock(view));
  $('#'+view+'-tab').addEventListener('keydown',event=>{if(['ArrowLeft','ArrowRight','Home','End'].includes(event.key)){event.preventDefault();const next=event.key==='Home'?'results':event.key==='End'?'output':view==='results'?'output':'results';setDock(next);$('#'+next+'-tab').focus();}});
}
$('#result-filter').addEventListener('input',()=>{active().filter=$('#result-filter').value;active().page=1;renderResults();});
$('#results-previous').addEventListener('click',()=>{active().page--;renderResults();if($('#results-previous').disabled)$('#results-next').focus();});
$('#results-next').addEventListener('click',()=>{active().page++;renderResults();if($('#results-next').disabled)$('#results-previous').focus();});
$('#export-csv').addEventListener('click',()=>exportResult('csv'));$('#export-json').addEventListener('click',()=>exportResult('json'));
configureResizer($('#sidebar-resizer'),false);configureResizer($('#results-resizer'),true);
window.addEventListener('beforeunload',()=>{rememberEditor();persistDrafts();});
document.addEventListener('visibilitychange',()=>{if(document.visibilityState==='hidden'){rememberEditor();persistDrafts();}});
document.addEventListener('keydown',event=>{if(event.key==='Escape'&&state.sidebarOpen&&window.matchMedia('(max-width: 700px)').matches){setSidebar(state.tool,false);$('#'+state.tool+'-tool').focus();}});
window.matchMedia('(max-width: 700px)').addEventListener('change',event=>{if(event.matches)setSidebar(state.tool,false);else setSidebar(state.tool,state.sidebarOpen);});
editor.value=active().sql;switchTab(state.activeId);renderHistory();setSidebar();updateConnectionType();saveConnections();checkConnection();
