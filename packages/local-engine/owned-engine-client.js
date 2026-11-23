'use strict';
// Shared authenticated lifecycle. Owned transports are private host authority,
// never EngineClient.start options or renderer-selected endpoints/processes.
const crypto = require('node:crypto'); const http = require('node:http');
const { validateRequest, strictJson, MAX_RESPONSE, UUID } = require('./protocol');
const { failure } = require('./errors');
const REQUEST_TIMEOUT = 30000;
const states = new WeakMap(), construct = Symbol('owned engine');
function httpRequest(state, input, timeout = REQUEST_TIMEOUT) {
  return new Promise((resolve, reject) => {
    const mutation = input.method !== 'GET'; let submitted = false, settled = false, request;
    const chunks = []; let size = 0;
    const done = (error, result) => {
      if (settled) return; settled = true; clearTimeout(timer); state.pending.delete(failExit);
      input.signal?.removeEventListener('abort', abort);
      if (error) { reject(failure(error, mutation && submitted)); request?.destroy(); }
      else resolve(result);
    };
    const failExit = () => done('ENGINE_EXITED');
    const abort = () => done('REQUEST_ABORTED');
    const timer = setTimeout(() => done('REQUEST_TIMEOUT'), timeout);
    if (input.signal?.aborted) { done('REQUEST_ABORTED'); return; }
    if (state.exited || state.stopping) { done('ENGINE_EXITED'); return; }
    state.pending.add(failExit); input.signal?.addEventListener('abort', abort, { once: true });
    try {
      const headers = { Authorization: 'GridBase-Local ' + state.capability, Accept: 'application/json' };
      if (state.actor) headers['X-GridBase-Account'] = state.actor;
      if (input.body !== undefined) { headers['Content-Type'] = 'application/json'; headers['Content-Length'] = Buffer.byteLength(input.body); }
      request = http.request({ hostname: '127.0.0.1', family: 4, port: state.port, method: input.method, path: input.path, headers, agent: false }, response => {
        if (settled) { response.destroy(); return; }
        if (response.statusCode >= 300 && response.statusCode < 400) { done('REDIRECT_DENIED'); response.destroy(); return; }
        const length = response.headers['content-length'];
        if (length !== undefined && (!/^[0-9]+$/.test(length) || BigInt(length) > BigInt(MAX_RESPONSE))) { done('RESPONSE_TOO_LARGE'); response.destroy(); return; }
        response.on('data', chunk => { size += chunk.length; if (size > MAX_RESPONSE) { done('RESPONSE_TOO_LARGE'); response.destroy(); } else if (!settled) chunks.push(chunk); });
        response.on('aborted', () => done('REQUEST_FAILED'));
        response.on('error', () => done('REQUEST_FAILED'));
        response.on('end', () => {
          if (settled) return;
          try {
            const body = new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks));
            // A compromised or incorrect child cannot reflect bootstrap material
            // through the HTTP facade. This is not a generic data redaction pass.
            if (body.includes(state.capability) || (state.keyToken && body.includes(state.keyToken))) { done('REQUEST_FAILED'); return; }
            const safe = {};
            const contentType = response.headers['content-type'];
            if (typeof contentType === 'string' && /^application\/json(?:;\s*charset=utf-8)?$/i.test(contentType)) safe['content-type'] = contentType;
            const id = response.headers['x-request-id']; if (typeof id === 'string' && UUID.test(id)) safe['x-request-id'] = id;
            if (response.headers['x-gridbase-audit-warning'] === 'incomplete') safe['x-gridbase-audit-warning'] = 'incomplete';
            done(null, { status: response.statusCode, headers: safe, body });
          } catch { done('REQUEST_FAILED'); }
        });
      });
      request.on('error', () => done('REQUEST_FAILED'));
      // Conservatively uncertain from submission onward, even if no response or
      // socket confirmation arrives. Never issue a second business request.
      submitted = true; request.end(input.body);
    } catch { done('REQUEST_FAILED'); }
  });
}
class EngineClient {
  constructor(token, state) { if (token !== construct) throw failure('START_FAILED'); states.set(this, state); Object.freeze(this); }
  async request(input) { const state = states.get(this); const validated = validateRequest(input); return httpRequest(state, validated); }
  stop() {
    const state = states.get(this); if (state.stopPromise) return state.stopPromise;
    state.stopping = true;
    state.stopPromise = (async () => {
      if (state.exited) return;
      await state.owned.stop();
      await state.exit;
    })(); return state.stopPromise;
  }
  onExit(listener) {
    if (typeof listener !== 'function') throw failure('INVALID_REQUEST'); const state = states.get(this);
    if (state.exited) { queueMicrotask(() => { try { listener(state.exitResult); } catch {} }); return () => {}; }
    state.listeners.add(listener); return () => state.listeners.delete(listener);
  }
}
async function startOwnedEngine(owned, { version, credentialKey, clientKind, deadline }) {
  let copiedKey, timer, startupReject, protocolFailed = false;
  const state = { owned, capability: '', keyToken: '', port: null, actor: null, exited: false, stopping: false, stopPromise: null, pending: new Set(), listeners: new Set() };
  const client = new EngineClient(construct, state);
  let resolveExit; state.exit = new Promise(resolve => { resolveExit = resolve; });
  owned.closed.then(proof => {
    state.exited = true; state.capability = ''; state.keyToken = '';
    for (const pending of [...state.pending]) pending();
    const result = Object.freeze({ code: proof.java.observed && Number.isInteger(proof.java.code) ? proof.java.code : null, signal: proof.java.observed && ['SIGKILL','SIGTERM','SIGINT'].includes(proof.java.signal) ? proof.java.signal : null });
    state.exitResult = result; resolveExit(); startupReject?.(failure('ENGINE_EXITED'));
    for (const listener of [...state.listeners]) { try { listener(result); } catch {} } state.listeners.clear();
  });
  const protocolFailure = () => { protocolFailed = true; startupReject?.(failure('INVALID_READY')); if (state.ready) void client.stop(); };
  owned.stdin.on('error', () => startupReject?.(failure('START_FAILED')));
  owned.stdout.on('error', protocolFailure);
  try {
    if (!Buffer.isBuffer(credentialKey) || credentialKey.length !== 32 || !['desktop','vscode'].includes(clientKind) || !Number.isFinite(deadline) || !Number.isInteger(owned.expectedJavaPid) || owned.expectedJavaPid < 1) throw failure('START_FAILED');
    copiedKey = Buffer.from(credentialKey); state.capability = crypto.randomBytes(32).toString('base64url'); state.keyToken = copiedKey.toString('base64url');
    const remaining = () => Math.max(1, deadline - Date.now());
    if (Date.now() >= deadline) throw failure('START_TIMEOUT');
    await new Promise((resolve, reject) => {
      startupReject = reject; let buffered = Buffer.alloc(0), received = false;
      timer = setTimeout(() => reject(failure('START_TIMEOUT')), remaining());
      owned.stdout.on('end', () => {
        if (!received) {
          if (buffered.length) protocolFailure();
          else startupReject?.(failure('ENGINE_EXITED'));
        }
      });
      owned.stdout.on('data', chunk => {
        if (protocolFailed) return;
        if (received || buffered.length + chunk.length > 8192) { protocolFailure(); return; }
        buffered = Buffer.concat([buffered, chunk]); const nl = buffered.indexOf(10); if (nl < 0) return;
        received = true;
        try {
          if (nl !== buffered.length - 1) throw Error();
          const ready = strictJson(new TextDecoder('utf-8', { fatal: true }).decode(buffered.subarray(0,nl)),8192);
          if (!ready || Object.keys(ready).sort().join(',') !== 'event,pid,port,protocol,version' || ready.event !== 'ready' || ready.protocol !== 1 || ready.version !== version || ready.pid !== owned.expectedJavaPid || !Number.isInteger(ready.port) || ready.port < 1 || ready.port > 65535) throw Error();
          state.port = ready.port;
          (async () => {
            try {
              const health = await httpRequest(state, { method: 'GET', path: '/healthz' }, remaining());
              const session = await httpRequest(state, { method: 'GET', path: '/api/auth/session' }, remaining());
              const h = strictJson(health.body), s = strictJson(session.body);
              if (health.status !== 200 || h.status !== 'ok' || session.status !== 200 || s.authenticated !== true || s.mode !== 'local' || s.user?.provider !== 'local' || typeof s.user?.id !== 'string' || !s.user.id.startsWith('local:') || !UUID.test(s.user.id.slice(6)) || s.capabilities?.auditAdmin !== false || protocolFailed || state.exited) throw Error();
              if (Date.now() >= deadline) { reject(failure('START_TIMEOUT')); return; }
              state.actor = s.user.id; state.ready = true; resolve();
            } catch { reject(failure(Date.now() >= deadline ? 'START_TIMEOUT' : 'AUTH_FAILED')); }
          })();
        } catch { protocolFailure(); }
      });
      const bootstrap = Buffer.from(JSON.stringify({ protocol:1,capability:state.capability,credentialKey:state.keyToken,clientKind })+'\n');
      owned.stdin.write(bootstrap, () => bootstrap.fill(0));
    });
    if (protocolFailed || state.exited) throw failure('INVALID_READY');
    return client;
  } catch (error) {
    await client.stop();
    throw failure(['START_TIMEOUT','INVALID_READY','AUTH_FAILED','ENGINE_EXITED'].includes(error.code) ? error.code : 'START_FAILED');
  } finally { clearTimeout(timer); startupReject = null; copiedKey?.fill(0); }
}
module.exports = { EngineClient, startOwnedEngine };
