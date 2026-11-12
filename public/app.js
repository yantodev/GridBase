'use strict';
const C = window.WorkbenchCore;
const $ = selector => document.querySelector(selector);
const HISTORY_STORAGE_KEY = 'thrift-query-workbench:history:v1';
const DRAFT_STORAGE_KEY = 'thrift-query-workbench:drafts:v1';
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
const state = {
  ...C.restoreDrafts(readStorage(DRAFT_STORAGE_KEY)), history: loadHistory(), configured: false,
  sidebarOpen: !window.matchMedia('(max-width: 700px)').matches, tool: 'database',
  schemas: [], schemaEntries: new Map(), columns: new Map(), metadataLoading: false, metadataError: '',
};
const editor = $('#sql-editor');
let saveTimer, completionRange, metadataVersion = 0;
const active = () => state.tabs.find(t => t.id === state.activeId);
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
      select.title = `${tab.name}${tab.running ? ' · Running…' : ''} (double-click to rename)`;
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
  $('#console-context').textContent = tab.source ? 's3tables / ' + tab.source.namespace + ' / ' + tab.source.table : 'Spark SQL';
  $('#console-context').title = $('#console-context').textContent;
  updateEditor(); renderTabs(); renderResults(); updateRunButton(); persistDrafts();
}
function addConsole(sql = '', name, source) {
  if (state.tabs.length >= 20) { setToast('Close a console before opening another (maximum 20).'); return null; }
  rememberEditor();
  const tab = C.newTab(name || 'Console ' + (state.tabs.length + 1), sql);
  if (source) tab.source = source;
  state.tabs.push(tab); switchTab(tab.id); editor.focus(); return tab;
}
function closeTab(id) {
  const tab = state.tabs.find(t => t.id === id);
  if (!tab || tab.running) return;
  if (tab.sql.trim() && !window.confirm(`Close “${tab.name}”? Its SQL draft and results will be removed.`)) return;
  rememberEditor();
  const index = state.tabs.indexOf(tab); state.tabs.splice(index, 1);
  if (!state.tabs.length) state.tabs.push(C.newTab('Console 1'));
  const target = state.activeId === id ? state.tabs[Math.min(index, state.tabs.length - 1)].id : state.activeId;
  // The active draft was already captured before removing its tab.
  state.activeId = target; editor.value = active().sql; switchTab(target);
  $('#tab-' + target).focus();
}
function openRename() {
  $('#console-name').value = active().name; $('#rename-dialog').showModal(); $('#console-name').select();
}
function updateRunButton() {
  $('#run-query').disabled = !state.configured || Boolean(active()?.running);
  $('#run-query').querySelector('span').textContent = active()?.running ? 'Executing…' : 'Execute';
  $('#console-panel').setAttribute('aria-busy', String(Boolean(active()?.running)));
}
async function checkConnection() {
  $('#retry-connection').disabled = true;
  try {
    const health = await api('/api/health'); state.configured = Boolean(health.configured);
    $('#connection-status').className = 'connection-status' + (state.configured ? ' is-configured' : ' is-error');
    $('#connection-label').textContent = state.configured ? 'Configured' : 'Not configured';
    $('#connection-status').title = health.target || 'Spark Thrift Server';
    $('#connection-notice').hidden = state.configured;
    $('#connection-notice').textContent = 'Koneksi belum dikonfigurasi. Isi THRIFT_JDBC_URL, THRIFT_USERNAME dan THRIFT_PASSWORD di .env, lalu restart server.';
    $('#server-state').textContent = state.configured ? 'Read / write' : 'Missing configuration';
    if (state.configured) await refreshMetadata();
    else { state.metadataError = 'Lengkapi koneksi di .env lalu restart server dan periksa kembali.'; state.metadataLoading = false; renderExplorer(); }
  } catch (error) {
    state.configured = false; state.metadataLoading = false; state.metadataError = error.message;
    $('#connection-status').className = 'connection-status is-error'; $('#connection-label').textContent = 'Offline';
    $('#connection-notice').hidden = false; $('#connection-notice').textContent = error.message + ' Gunakan tombol Check connection di kanan atas.';
    $('#server-state').textContent = 'Server offline'; renderExplorer();
  } finally { $('#retry-connection').disabled = false; updateRunButton(); $('#refresh-metadata').disabled = !state.configured; }
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
async function refreshMetadata() {
  if (!state.configured) return;
  const version = ++metadataVersion;
  state.metadataLoading = true; state.metadataError = ''; state.schemaEntries.clear(); state.columns.clear();
  $('#refresh-metadata').disabled = true; renderExplorer();
  try {
    const data = await api('/api/databases');
    if (version !== metadataVersion) return;
    state.schemas = data.databases.filter(v => typeof v === 'string').sort((a,b) => a.localeCompare(b));
    $('#connection-label').textContent = 'Connected'; $('#connection-status').className = 'connection-status is-configured';
  } catch (error) {
    if (version !== metadataVersion) return;
    state.metadataError = error.message; $('#connection-label').textContent = 'Unavailable'; $('#connection-status').className = 'connection-status is-error';
  } finally {
    if (version === metadataVersion) { state.metadataLoading = false; renderExplorer(); $('#refresh-metadata').disabled = false; }
  }
}
async function toggleSchema(namespace) {
  let entry = state.schemaEntries.get(namespace);
  if (entry?.tables && !entry.error) { entry.expanded = !entry.expanded; renderExplorer(); return; }
  if (entry?.loading) return;
  const version = metadataVersion;
  entry = { expanded: true, loading: true, tables: [], error: '' }; state.schemaEntries.set(namespace, entry); renderExplorer();
  try {
    const data = await api('/api/tables?namespace=' + encodeURIComponent(namespace));
    if (version !== metadataVersion) return;
    entry.tables = data.tables.filter(v => typeof v === 'string').sort((a,b) => a.localeCompare(b));
  } catch (error) { entry.error = error.message; }
  finally { if (version === metadataVersion) { entry.loading = false; renderExplorer(); } }
}
const columnKey = (namespace, table) => JSON.stringify([namespace, table]);
async function toggleColumns(namespace, table) {
  const key = columnKey(namespace, table); let entry = state.columns.get(key);
  if (entry?.items && !entry.error) { entry.expanded = !entry.expanded; renderExplorer(); return; }
  if (entry?.loading) return;
  const version = metadataVersion;
  entry = { expanded: true, loading: true, items: [], error: '' }; state.columns.set(key, entry); renderExplorer();
  try {
    const data = await api('/api/columns?namespace=' + encodeURIComponent(namespace) + '&table=' + encodeURIComponent(table));
    if (version !== metadataVersion) return; entry.items = data.columns;
  } catch (error) { entry.error = error.message; }
  finally { if (version === metadataVersion) { entry.loading = false; renderExplorer(); } }
}
function renderExplorer() {
  const root = $('#schema-list'); root.setAttribute('aria-busy', String(state.metadataLoading));
  $('#schema-count').textContent = state.metadataLoading ? '' : String(state.schemas.length);
  restoreFocus(root, () => {
    root.replaceChildren();
    if (state.metadataLoading) { root.append(element('p','pane-note','Loading schemas…')); return; }
    if (state.metadataError) { root.append(element('p','pane-note is-error',state.metadataError), button('Retry connection','text-button',checkConnection)); return; }
    const search = $('#object-filter').value.toLowerCase(); const list = element('ul','object-list');
    state.schemas.forEach(namespace => {
      const entry = state.schemaEntries.get(namespace);
      const schemaMatches = namespace.toLowerCase().includes(search);
      const tables = (entry?.tables || []).filter(name => schemaMatches || name.toLowerCase().includes(search));
      if (search && !schemaMatches && !tables.length) return;
      const item = element('li'); const row = element('div','object-row');
      const expand = button('', 'disclosure', () => toggleSchema(namespace)); expand.append(icon('chevron'));
      expand.setAttribute('aria-label','Toggle tables in ' + namespace); expand.setAttribute('aria-expanded',String(Boolean(entry?.expanded)));
      expand.dataset.focus = 'schema:' + namespace;
      const name = button('', 'object-name', () => toggleSchema(namespace)); name.append(icon('schema'), element('span','',namespace)); name.title = namespace;
      name.dataset.focus = 'schema-name:' + namespace;
      row.append(expand, name); item.append(row);
      if (entry?.expanded) {
        if (entry.loading) item.append(metadataNote('Loading tables…'));
        else if (entry.error) { item.append(metadataNote(entry.error,true), button('Retry tables','text-button',() => toggleSchema(namespace))); }
        else if (!tables.length) item.append(metadataNote(search ? 'No matching loaded tables.' : 'No tables in this schema.'));
        else {
          const children = element('ul','object-list');
          tables.forEach(table => {
            const tableItem = element('li'), tableRow = element('div','object-row table-row'), key = columnKey(namespace,table), columns = state.columns.get(key);
            const disclosure = button('', 'disclosure', () => toggleColumns(namespace,table)); disclosure.append(icon('chevron'));
            disclosure.setAttribute('aria-expanded',String(Boolean(columns?.expanded))); disclosure.setAttribute('aria-label','Show columns of ' + table); disclosure.dataset.focus = 'columns:' + key;
            const open = button('', 'object-name', () => openTable(namespace,table)); open.append(icon('table'), element('span','',table)); open.title = 'Open ' + namespace + '.' + table + ' · LIMIT 50'; open.dataset.focus = 'table:' + key;
            tableRow.append(disclosure,open); tableItem.append(tableRow);
            if(columns?.expanded) {
              if(columns.loading)tableItem.append(metadataNote('Loading columns…'));
              else if(columns.error)tableItem.append(metadataNote(columns.error,true),button('Retry columns','text-button',()=>toggleColumns(namespace,table)));
              else if(!columns.items.length)tableItem.append(metadataNote('No columns reported.'));
              else columns.items.forEach(column=>{const line=element('div','column-row');line.append(element('span','column-name',column.name),element('span','column-type',column.type));line.title=column.comment||column.name+' · '+column.type;tableItem.append(line);});
            }
            children.append(tableItem);
          }); item.append(children);
        }
      }
      list.append(item);
    });
    root.append(list);
    if (!list.children.length) root.append(element('p','pane-note',search ? 'No matching loaded objects. Expand schemas to load their tables.' : 'No schemas found in s3tables.'));
  });
}
function openTable(namespace, table) {
  const existing = state.tabs.find(tab => tab.source?.namespace === namespace && tab.source?.table === table);
  if (existing) { switchTab(existing.id); editor.focus(); }
  else { const tab = addConsole(C.tableSql(namespace, table), table, {namespace,table}); if(tab)runQuery(tab.sql); }
  if (window.matchMedia('(max-width: 700px)').matches) setSidebar(state.tool,false);
}
function renderHistory() {
  $('#history-count').textContent = state.history.length;
  $('#clear-history').disabled = !state.history.length;
  const root = $('#history-list'); root.replaceChildren();
  if (!state.history.length) { root.append(element('p','pane-note','Executed queries appear here. Select one to open its SQL in a new console.')); return; }
  state.history.forEach(item => {
    const entry = button('', 'history-item', () => addConsole(item.sql));
    entry.append(element('code','',item.sql), element('span','history-meta',new Date(item.ranAt).toLocaleTimeString('id-ID',{hour:'2-digit',minute:'2-digit'})+' · '+item.rows+' rows'));
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
  if(tab.running || !state.configured)return;
  rememberEditor();
  const sql = typeof explicitSql === 'string' ? explicitSql : C.executionSql(editor.value,editor.selectionStart,editor.selectionEnd);
  if(!sql.trim()) { setToast('Write a SQL statement before executing.'); editor.focus(); return; }
  tab.running=true; tab.error=''; tab.result=null; tab.output='Executing…\n\n'+sql; tab.dock='results'; tab.page=1; tab.filter=''; tab.sort=null;
  renderTabs(); renderResults(); updateRunButton();
  try {
    const result = await api('/api/query',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({sql})});
    if(!Array.isArray(result.columns) || !Array.isArray(result.rows)) throw new Error('Format hasil query tidak valid.');
    tab.result=result;
    const affected = Number.isInteger(result.updateCount) && result.updateCount >= 0;
    const summary = result.columns.length ? `${result.rows.length} rows returned${result.truncated ? ' (server row cap reached)' : ''}.` : affected ? `${result.updateCount} rows affected.` : 'Statement completed. Affected-row count unavailable.';
    tab.output = `${new Date().toLocaleTimeString('id-ID')} · ${result.durationMs} ms\n${summary}\n\n${sql}`;
    state.history.unshift({sql,rows:result.rows.length,ranAt:Date.now()}); state.history=state.history.slice(0,MAX_HISTORY_ITEMS);saveHistory();renderHistory();
    setToast(tab.name + ' · ' + summary);
  } catch(error) { tab.error=error.message;tab.output='Execution failed\n'+error.message+'\n\n'+sql;setToast(tab.name+' · Query failed'); }
  finally {
    tab.running=false;renderTabs();
    if(state.activeId===tab.id){renderResults();updateRunButton();}
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
  for(const namespace of state.schemas)options.set(namespace,{label:namespace,value:C.quoteIdentifier(namespace),qualified:false});
  for(const [namespace,entry] of state.schemaEntries)for(const table of entry.tables || [])options.set(namespace+'.'+table,{label:namespace+'.'+table,value:C.quoteIdentifier('s3tables')+'.'+C.quoteIdentifier(namespace)+'.'+C.quoteIdentifier(table),qualified:true});
  for(const entry of state.columns.values())for(const column of entry.items || [])options.set(column.name,{label:column.name,value:C.quoteIdentifier(column.name),qualified:false});
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
$('#refresh-metadata').addEventListener('click',refreshMetadata);
$('#retry-connection').addEventListener('click',checkConnection);
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
editor.value=active().sql;switchTab(state.activeId);renderHistory();setSidebar();checkConnection();
