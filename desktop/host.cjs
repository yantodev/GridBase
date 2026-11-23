'use strict';
const { validateRequest, strictJson, MAX_REQUEST, MAX_RESPONSE, UUID } = require('../packages/local-engine/protocol');
const Core = require('../public/workbench-core');
const MESSAGES = Object.freeze({
  INVALID_SENDER: 'This page cannot access the local engine.', INVALID_REQUEST: 'Invalid local request.',
  ENGINE_UNAVAILABLE: 'Local engine is unavailable. Close and reopen GridBase; check the database before repeating any write.',
  BUSY: 'An operation is already pending. Wait for it to finish.', USER_CANCELLED: 'Query cancelled. No SQL was sent.',
  REQUEST_FAILED: 'Local request failed. Check the database before retrying any write.',
  RESULT_EXPIRED: 'This result is no longer available for export. Run the query again if it is safe to do so.',
  EXPORT_AUDIT_FAILED: 'Export audit did not complete. Check Logs before requesting another export.',
  EXPORT_FAILED: 'Export could not be saved. Check the selected destination; no SQL was retried.',
  RESPONSE_INVALID: 'Local engine returned an invalid or oversized response.'
});
function fail(code) { throw Object.assign(new Error(MESSAGES[code]), { code }); }
function safeError(error) {
  const code = Object.hasOwn(MESSAGES, error?.code) ? error.code : 'REQUEST_FAILED';
  return { code, message: MESSAGES[code] + (error?.uncertainOutcome === true ? ' Outcome is uncertain: check the database before retrying.' : ''), uncertainOutcome: error?.uncertainOutcome === true };
}
function exact(value, allowed) {
  if (!value || Object.getPrototypeOf(value) !== Object.prototype || Reflect.ownKeys(value).length !== allowed.length || allowed.some(k => !Object.hasOwn(value, k))) fail('INVALID_REQUEST');
}
function senderAllowed(event, window, startup = false) {
  const frame = event?.senderFrame;
  return Boolean(window && event.sender === window.webContents && frame && frame === window.webContents.mainFrame &&
    (frame.url === 'gridbase://app/index.html' || (startup && frame.url === 'gridbase://app/startup.html')));
}
function response(raw) {
  if (!raw || !Number.isInteger(raw.status) || raw.status < 100 || raw.status > 599 || typeof raw.body !== 'string' || Buffer.byteLength(raw.body) > MAX_RESPONSE) fail('RESPONSE_INVALID');
  // Parse before crossing IPC. No raw Error/native object or unbounded string.
  strictJson(raw.body, MAX_RESPONSE);
  const headers = {};
  if (/^application\/json(?:;\s*charset=utf-8)?$/i.test(raw.headers?.['content-type'] || '')) headers['content-type'] = raw.headers['content-type'];
  if (UUID.test(raw.headers?.['x-request-id'] || '')) headers['x-request-id'] = raw.headers['x-request-id'];
  if (raw.headers?.['x-gridbase-audit-warning'] === 'incomplete') headers['x-gridbase-audit-warning'] = 'incomplete';
  return { status: raw.status, headers, body: raw.body };
}
function createHost({ getWindow, dialog, writeFile }) {
  let engine = null, generation = 0, queryBusy = false, connectionBusy = false, exportBusy = false, bytes = 0;
  const results = new Map();
  const clearResults = () => { results.clear(); bytes = 0; };
  function clearEngine() { engine = null; generation++; clearResults(); }
  function setEngine(client) { clearEngine(); engine = client; }
  function check(event, expected = generation) {
    if (!senderAllowed(event, getWindow())) fail('INVALID_SENDER');
    if (!engine || generation !== expected) fail('ENGINE_UNAVAILABLE');
  }
  async function guarded(work) { try { return { ok: true, value: await work() }; } catch (error) { return { ok: false, error: safeError(error) }; } }
  function capture(raw, owner) {
    if (raw.status < 200 || raw.status >= 300) return;
    const data = strictJson(raw.body, MAX_RESPONSE);
    if (!UUID.test(data?.requestId || '') || !Array.isArray(data.columns) || data.columns.some(v => typeof v !== 'string') || !Array.isArray(data.rows) || data.rows.some(v => !v || typeof v !== 'object' || Array.isArray(v))) return;
    const size = Buffer.byteLength(raw.body);
    if (results.has(data.requestId)) { bytes -= results.get(data.requestId).size; results.delete(data.requestId); }
    while (results.size && (results.size >= 5 || bytes + size > MAX_RESPONSE)) { const id = results.keys().next().value; bytes -= results.get(id).size; results.delete(id); }
    results.set(data.requestId, { data, size, owner, generation }); bytes += size;
  }
  function request(event, input) { return guarded(async () => {
    check(event);
    // Validate/serialize synchronously before awaiting or queuing anything.
    if (!input || Object.hasOwn(input, 'signal')) fail('INVALID_REQUEST');
    const validated = validateRequest(input);
    const payload = { method: validated.method, path: validated.path, ...(validated.body === undefined ? {} : { body: validated.body }) };
    const route = payload.path.split('?')[0];
    if (Buffer.byteLength(JSON.stringify(payload)) > MAX_REQUEST) fail('INVALID_REQUEST');
    // Only saveExport may audit a native export; never accept renderer authority.
    if (route === '/api/activity/exports') fail('INVALID_REQUEST');
    const current = engine, epoch = generation, isQuery = payload.method === 'POST' && route === '/api/query';
    const isConnectionChange = payload.path.startsWith('/api/connections') && payload.method !== 'GET';
    if ((queryBusy && (isQuery || isConnectionChange)) || (connectionBusy && (isQuery || isConnectionChange))) fail('BUSY');
    if (isQuery) queryBusy = true;
    if (isConnectionChange) connectionBusy = true;
    try {
      if (isQuery) {
        const body = strictJson(payload.body);
        // Java line comments end at CR or LF; the shared browser classifier
        // recognizes LF only. Normalize the classification copy, never the
        // exact SQL shown in the dialog or serialized for engine execution.
        if (Core.mutationOperations(body.sql.replace(/\r\n?/g, '\n')).length) {
          const connections = response(await current.request({ method: 'GET', path: '/api/connections' })); check(event, epoch);
          if (connections.status !== 200) fail('REQUEST_FAILED');
          const list = strictJson(connections.body, MAX_RESPONSE), id = body.connectionId || list.defaultConnectionId;
          const connection = list.connections?.find(item => item.id === id);
          if (!connection || typeof connection.name !== 'string') fail('INVALID_REQUEST');
          body.connectionId = id; payload.body = JSON.stringify(body);
          const answer = await dialog.showMessageBox(getWindow(), { type: 'warning', title: 'Confirm SQL mutation', message: 'Run UPDATE / DELETE?',
            detail: 'Connection: ' + connection.name + ' [' + id + ']\n\nThis exact SQL can change or delete data. Check its WHERE clause.\n\n' + body.sql,
            buttons: ['Cancel', 'Run'], defaultId: 0, cancelId: 0, noLink: true });
          check(event, epoch);
          if (answer.response !== 1) fail('USER_CANCELLED');
        }
      }
      check(event, epoch);
      const received = await current.request(payload);
      let raw;
      try { raw = response(received); check(event, epoch); }
      catch (error) { if (['POST','PUT','DELETE'].includes(payload.method)) error.uncertainOutcome = true; throw error; }
      if (isQuery) capture(raw, event.sender);
      return raw;
    } finally { if (isQuery) queryBusy = false; if (isConnectionChange) connectionBusy = false; }
  }); }
  function saveExport(event, input) { return guarded(async () => {
    check(event); exact(input, ['queryRequestId', 'format', 'rowIndices', 'suggestedName']);
    const serialized = JSON.stringify(input); if (Buffer.byteLength(serialized) > MAX_RESPONSE) fail('INVALID_REQUEST');
    const payload = strictJson(serialized, MAX_RESPONSE);
    if (!UUID.test(payload.queryRequestId) || !['csv', 'json'].includes(payload.format) || !Array.isArray(payload.rowIndices) ||
      typeof payload.suggestedName !== 'string' || !/^[^\x00-\x1f\x7f/\\:]{1,160}$/.test(payload.suggestedName) || ['.', '..'].includes(payload.suggestedName) || payload.suggestedName.trim() !== payload.suggestedName) fail('INVALID_REQUEST');
    const captured = results.get(payload.queryRequestId);
    if (!captured || captured.owner !== event.sender || captured.generation !== generation) fail('RESULT_EXPIRED');
    if (new Set(payload.rowIndices).size !== payload.rowIndices.length || payload.rowIndices.some(i => !Number.isSafeInteger(i) || i < 0 || i >= captured.data.rows.length)) fail('INVALID_REQUEST');
    if (exportBusy) fail('BUSY'); exportBusy = true;
    const current = engine, epoch = generation;
    try {
      const rows = payload.rowIndices.map(i => captured.data.rows[i]);
      const body = payload.format === 'csv' ? Core.toCsv(captured.data.columns, rows) : JSON.stringify(rows, null, 2);
      if (Buffer.byteLength(body) > MAX_RESPONSE) fail('INVALID_REQUEST');
      const audit = response(await current.request({ method: 'POST', path: '/api/activity/exports', body: JSON.stringify({ queryRequestId: payload.queryRequestId, format: payload.format, rowCount: rows.length }) }));
      check(event, epoch);
      if (audit.status < 200 || audit.status >= 300 || strictJson(audit.body, MAX_RESPONSE)?.ok !== true || audit.headers['x-gridbase-audit-warning'] === 'incomplete') fail('EXPORT_AUDIT_FAILED');
      const chosen = await dialog.showSaveDialog(getWindow(), { title: 'Export query result', defaultPath: payload.suggestedName, filters: [{ name: payload.format.toUpperCase(), extensions: [payload.format] }] });
      check(event, epoch);
      if (chosen.canceled) return { canceled: true };
      if (typeof chosen.filePath !== 'string' || !chosen.filePath) fail('EXPORT_FAILED');
      try { await writeFile(chosen.filePath, body, { encoding: 'utf8', mode: 0o600 }); } catch { fail('EXPORT_FAILED'); }
      return { canceled: false };
    } finally { exportBusy = false; }
  }); }
  return Object.freeze({ request, saveExport, setEngine, clearEngine, clearResults });
}
module.exports = { createHost, senderAllowed, safeError };
