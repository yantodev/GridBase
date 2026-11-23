'use strict';
(() => {
  const descriptor = Object.getOwnPropertyDescriptor(window, 'GridBaseNative');
  const bridge = descriptor?.value;
  const native = window.location?.protocol === 'gridbase:' && window.location?.host === 'app' && descriptor?.writable === false && descriptor?.configurable === false &&
    Object.isFrozen(bridge) && ['request', 'saveExport', 'close', 'onEngineState'].every(key => typeof bridge[key] === 'function');
  let stopped = false;
  if (native) bridge.onEngineState(({ state }) => { if (state === 'stopped' || state === 'error') stopped = true; });
  async function invoke(method, payload) {
    let reply;
    try { reply = await bridge[method](payload); }
    catch { throw Object.assign(new Error('Local operation failed. Check the database before retrying any write.'), { code: 'REQUEST_FAILED', uncertainOutcome: method !== 'close' }); }
    if (reply?.ok === false && reply.error && Object.keys(reply).length === 2 && Object.keys(reply.error).length === 3 &&
        /^(INVALID_SENDER|INVALID_REQUEST|ENGINE_UNAVAILABLE|BUSY|USER_CANCELLED|REQUEST_FAILED|RESULT_EXPIRED|EXPORT_AUDIT_FAILED|EXPORT_FAILED|RESPONSE_INVALID)$/.test(reply.error.code) &&
        typeof reply.error.message === 'string' && reply.error.message.length <= 512 && typeof reply.error.uncertainOutcome === 'boolean') {
      const error = new Error(reply.error.message); error.code = reply.error.code; error.uncertainOutcome = reply.error.uncertainOutcome; throw error;
    }
    if (reply?.ok !== true || Object.keys(reply).length !== 2 || !Object.hasOwn(reply, 'value')) throw Object.assign(new Error('Local response is invalid. Check the database before retrying any write.'), { code: 'RESPONSE_INVALID', uncertainOutcome: method !== 'close' });
    return reply.value;
  }
  async function request(url, options = {}) {
    if (!native) return window.fetch(url, options);
    if (stopped || (url !== '/api/auth/session' && window.GridBaseSession?.mode !== 'local')) throw new Error('Local engine is unavailable. Check the database before retrying a write.');
    if (typeof url !== 'string' || !url.startsWith('/api/') || url.startsWith('//') || Object.keys(options).some(key => !['method', 'headers', 'body', 'cache'].includes(key))) throw new Error('Invalid local request.');
    const headers = new Headers(options.headers);
    for (const [key, value] of headers) if (key !== 'content-type' || value !== 'application/json') throw new Error('Invalid local request headers.');
    const input = { method: options.method || 'GET', path: url };
    if (Object.hasOwn(options, 'body')) { if (typeof options.body !== 'string') throw new Error('Invalid local request body.'); input.body = options.body; }
    if (new TextEncoder().encode(JSON.stringify(input)).length > 65536) throw new Error('Local request is too large.');
    const reply = await invoke('request', input);
    const safeHeaders = new Headers(reply.headers);
    return Object.freeze({ status: reply.status, ok: reply.status >= 200 && reply.status < 300, headers: Object.freeze({ get: name => safeHeaders.get(name) }), json: async () => JSON.parse(reply.body) });
  }
  Object.defineProperty(window, 'GridBaseTransport', { value: Object.freeze({ native: Boolean(native), request,
    saveExport: async payload => { if (!native || stopped) throw new Error('Local engine is unavailable.'); return invoke('saveExport', payload); },
    close: async () => { if (!native) throw new Error('Local engine is unavailable.'); return invoke('close'); } }), writable: false, configurable: false });
})();
