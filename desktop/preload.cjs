'use strict';
// Sandbox preload deliberately imports only Electron's supported narrow API.
const { contextBridge, ipcRenderer } = require('electron');
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
function failure(code, uncertainOutcome = false) {
  return { ok: false, error: { code, message: MESSAGES[code] + (uncertainOutcome ? ' Outcome is uncertain: check the database before retrying.' : ''), uncertainOutcome } };
}
function exact(value, allowed, required = allowed) {
  return value && typeof value === 'object' && !Array.isArray(value) && Object.keys(value).every(key => allowed.includes(key)) && required.every(key => Object.hasOwn(value, key));
}
function payload(value, allowed, required, max) {
  if (!exact(value, allowed, required)) throw Error();
  const text = JSON.stringify(value); if (new TextEncoder().encode(text).length > max) throw Error();
  return JSON.parse(text);
}
function envelope(reply, channel) {
  if (reply?.ok === false && exact(reply, ['ok', 'error']) && exact(reply.error, ['code', 'message', 'uncertainOutcome']) &&
      Object.hasOwn(MESSAGES, reply.error.code) && typeof reply.error.message === 'string' && reply.error.message.length <= 512 && typeof reply.error.uncertainOutcome === 'boolean') {
    // Never copy native messages, stacks or Error properties into the bridge.
    return failure(reply.error.code, reply.error.uncertainOutcome);
  }
  if (reply?.ok !== true || !exact(reply, ['ok', 'value'])) throw Error();
  const value = reply.value;
  if (channel === 'gridbase:close') { if (value !== null) throw Error(); }
  else if (channel === 'gridbase:export') { if (!exact(value, ['canceled']) || typeof value.canceled !== 'boolean') throw Error(); }
  else {
    if (!exact(value, ['status', 'headers', 'body']) || !Number.isInteger(value.status) || value.status < 100 || value.status > 599 || typeof value.body !== 'string' || new TextEncoder().encode(value.body).length > 16777216 ||
        !exact(value.headers, ['content-type', 'x-request-id', 'x-gridbase-audit-warning'], [])) throw Error();
    for (const [key, text] of Object.entries(value.headers)) {
      if (typeof text !== 'string' || (key === 'content-type' && !/^application\/json(?:;\s*charset=utf-8)?$/i.test(text)) ||
          (key === 'x-request-id' && !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(text)) || (key === 'x-gridbase-audit-warning' && text !== 'incomplete')) throw Error();
    }
  }
  return { ok: true, value };
}
async function invoke(channel, input, allowed, required, max) {
  let value;
  try { value = channel === 'gridbase:close' ? undefined : payload(input, allowed, required, max); }
  catch { return failure('INVALID_REQUEST'); }
  const uncertain = channel === 'gridbase:export' || (channel === 'gridbase:request' && ['POST', 'PUT', 'DELETE'].includes(value.method));
  try { return envelope(await ipcRenderer.invoke(channel, value), channel); }
  catch { return failure('REQUEST_FAILED', uncertain); }
}
// Every async operation resolves to bounded plain data. Error instances must
// only be reconstructed by the renderer after crossing contextBridge.
contextBridge.exposeInMainWorld('GridBaseNative', Object.freeze({
  request: input => invoke('gridbase:request', input, ['method', 'path', 'body'], ['method', 'path'], 65536),
  saveExport: input => invoke('gridbase:export', input, ['queryRequestId', 'format', 'rowIndices', 'suggestedName'], ['queryRequestId', 'format', 'rowIndices', 'suggestedName'], 16777216),
  close: () => invoke('gridbase:close'),
  onEngineState: callback => {
    if (typeof callback !== 'function') throw new Error('A state callback is required.');
    const listener = (event, value) => { if (['starting', 'running', 'stopped', 'error'].includes(value?.state)) callback(Object.freeze({ state: value.state })); };
    ipcRenderer.on('gridbase:state', listener);
    return () => ipcRenderer.removeListener('gridbase:state', listener);
  }
}));
