'use strict';
const test = require('node:test'); const assert = require('node:assert/strict'); const vm = require('node:vm'); const fs = require('node:fs');
const ID = 'local:11111111-1111-4111-8111-111111111111';
const local = () => ({ authenticated: true, mode: 'local', user: { id: ID, login: 'Local', provider: 'local' }, capabilities: { auditAdmin: false, mcpEnabled: false } });
const flush = async () => { for (let i = 0; i < 4; i++) await new Promise(setImmediate); };
function setup({ session = local(), bridge = true, serialized = false } = {}) {
  const nodes = new Map(), scripts = [], calls = [], listeners = []; let close = 0, response = session, closeReply = {ok:true,value:null};
  const node = name => { if (!nodes.has(name)) nodes.set(name, { hidden: true, textContent: '', open: false, listeners: {}, addEventListener(event, fn) { this.listeners[event] = fn; }, setAttribute() {}, close() { this.open = false; } }); return nodes.get(name); };
  const document = { querySelector: node, querySelectorAll: () => [node('#connection-dialog')], createElement: () => ({}), body: { append: value => scripts.push(value) } };
  const native = Object.freeze({ request: async input => { calls.push(input); if (response instanceof Error) return {ok:false,error:require('../desktop/host.cjs').safeError(response)}; return {ok:true,value:{ status: 200, headers: { 'content-type': 'application/json', 'x-gridbase-audit-warning': 'incomplete' }, body: JSON.stringify(response) }}; }, saveExport: async input => { calls.push(input); return {ok:true,value:{ canceled: true }}; }, close: async () => { close++; return closeReply; }, onEngineState: fn => { listeners.push(fn); return () => {}; } });
  const window = { location: { protocol: 'gridbase:', host: 'app', pathname: '/index.html' }, fetch: async () => { throw Error('Network must not be used'); } };
  if (bridge && !serialized) Object.defineProperty(window, 'GridBaseNative', { value: native, writable: false, configurable: false });
  const context = vm.createContext({ window, document, Headers, TextEncoder, URLSearchParams });
  if(serialized)require('../desktop/test/serialized-bridge.cjs').serializedBridge(context,(channel,input)=>channel==='gridbase:close'?native.close():channel==='gridbase:export'?native.saveExport(input):native.request(input));
  vm.runInContext(fs.readFileSync('public/runtime-transport.js', 'utf8'), context);
  vm.runInContext(fs.readFileSync('public/local-session.js', 'utf8'), context);
  return { window, document, context, node, scripts, calls, state: value => listeners.forEach(fn => fn(value)), setResponse: value => { response = value; }, setClose: value => { closeReply = value; }, close: () => close };
}
test('I2 local bootstrap and Close consume serialized envelopes and conceal safely on failed close',async()=>{
  const f=setup({serialized:true});await flush();assert.equal(f.scripts.length,1);assert.equal(f.node('#app').hidden,false);
  f.setClose({ok:false,error:{code:'REQUEST_FAILED',message:'/private/native secret',uncertainOutcome:false}});await f.node('#logout').listeners.click();assert.equal(f.close(),1);assert.equal(f.node('#app').hidden,true);assert.match(f.node('#local-session-status').textContent,/local session/);assert.doesNotMatch(f.node('#local-session-status').textContent,/secret|\/private/);
});
test('native bootstrap validates local namespace/capabilities without network or GitHub; identity is frozen and Close replaces logout', async () => {
  const f = setup(); await flush(); assert.equal(f.scripts.length, 1); assert.equal(f.scripts[0].src, '/app.js'); assert.equal(f.node('#app').hidden, false);
  assert.equal(f.window.GridBaseSession.user.id, ID); assert.equal(f.window.GridBaseSession.mode, 'local'); assert.equal(Object.isFrozen(f.window.GridBaseSession), true);
  assert.equal(f.node('#session-user').textContent, 'Local'); assert.equal(f.node('#logout').textContent, 'Close'); await f.node('#logout').listeners.click(); assert.equal(f.close(), 1);
  assert.deepEqual(JSON.parse(JSON.stringify(f.calls[0])), { method: 'GET', path: '/api/auth/session' });
});
test('native local session rejects numeric/uppercase/mislabelled identity and privileged capabilities before app load', async () => {
  const cases = [ { ...local(), mode: 'server' }, { ...local(), user: { id: '1001', login: 'Local', provider: 'local' } }, { ...local(), user: { id: ID.toUpperCase(), login: 'Local', provider: 'local' } }, { ...local(), user: { id: ID, login: 'Local', provider: 'github' } }, { ...local(), capabilities: { auditAdmin: true, mcpEnabled: false } } ];
  for (const session of cases) { const f = setup({ session }); await flush(); assert.equal(f.scripts.length, 0); assert.equal(f.node('#app').hidden, true); assert.match(f.node('#local-session-status').textContent, /local session/i); }
});
test('failed bootstrap can reverify only session; engine crash conceals stale dialogs and cannot replay API', async () => {
  const f = setup({ session: Error('private raw') }); await flush(); assert.equal(f.scripts.length, 0);
  f.setResponse(local()); await f.node('#local-session-retry').listeners.click(); assert.equal(f.scripts.length, 1);
  f.node('#connection-dialog').open = true; f.state({ state: 'stopped' }); assert.equal(f.node('#app').hidden, true); assert.equal(f.node('#connection-dialog').open, false);
  await assert.rejects(f.window.GridBaseTransport.request('/api/query', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{"sql":"UPDATE t SET x=2"}' })); assert.equal(f.calls.filter(c => c.path === '/api/query').length, 0);
});
test('local fetch facade preserves headers/status/uncertainty and refuses arbitrary headers, URLs, signals or mode toggles', async () => {
  const f = setup(); await flush(); const transport = f.window.GridBaseTransport;
  const response = await transport.request('/api/health', { cache: 'no-store' }); assert.equal(response.ok, true); assert.equal(response.status, 200); assert.equal(response.headers.get('X-GridBase-Audit-Warning'), 'incomplete');
  for (const [url, options] of [['https://evil', {}], ['/api/health', { headers: { Authorization: 'evil' } }], ['/api/health', { signal: {} }]]) await assert.rejects(transport.request(url, options));
  f.setResponse(Object.assign(Error('Check database before retrying'), { uncertainOutcome: true })); await assert.rejects(transport.request('/api/health'), e => e.uncertainOutcome === true);
});
test('browser transport ignores a mutable spoofed bridge and preserves the existing fetch options', async () => {
  const calls = []; const window = { location: { protocol: 'https:', search: '?local=1' }, GridBaseNative: Object.freeze({ request() { assert.fail(); } }), fetch: async (...args) => { calls.push(args); return 'browser'; } };
  vm.runInNewContext(fs.readFileSync('public/runtime-transport.js', 'utf8'), { window, Headers, TextEncoder });
  const options = { headers: { 'X-GridBase-Account': '1001' } }; assert.equal(await window.GridBaseTransport.request('/api/connections', options), 'browser'); assert.equal(calls[0][1], options); assert.equal(window.GridBaseTransport.native, false);
});
