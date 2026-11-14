const test = require('node:test');
const assert = require('node:assert/strict');
const vm = require('node:vm');
const fs = require('node:fs');

const flush = async () => { for (let i = 0; i < 4; i++) await new Promise(setImmediate); };
function page(script, session = {authenticated: true, configured: true, user: {id: '1001', login: 'fixture-user'}}) {
  const nodes = new Map(), events = {}, redirects = [], requests = [], scripts = [], reloads = [];
  let reply = async () => ({ok: true, status: 200, json: async () => session});
  function node(selector) {
    if (!nodes.has(selector)) nodes.set(selector, {hidden: selector === '#login-message', open: false, disabled: false, textContent: '', attributes: {href: '/auth/github'},
      close() { this.open = false; }, showModal() { this.open = true; },
      listeners: {}, addEventListener(name, handler) { this.listeners[name] = handler; },
      hasAttribute(name) { return name in this.attributes; }, removeAttribute(name) { delete this.attributes[name]; },
      setAttribute(name, value) { this.attributes[name] = value; }, querySelector() { return node(selector + ' span'); }});
    return nodes.get(selector);
  }
  const fetch = async (...args) => { requests.push(args); return reply(...args); };
  const document = {querySelector: node, querySelectorAll: () => [node('#connection-dialog')], visibilityState: 'visible', body: {append: script => scripts.push(script)}, createElement: tag => ({tagName: tag}), addEventListener(name, handler) { events[name] = handler; }};
  const window = {fetch, location: {search: '', replace: value => redirects.push(value), reload: () => reloads.push(true)}, addEventListener(name, handler) { events[name] = handler; }};
  const context = vm.createContext({window, document, fetch, URLSearchParams, Headers});
  vm.runInContext(fs.readFileSync('public/' + script, 'utf8'), context);
  return {window, document, node, events, redirects, requests, scripts, reloads, reply: handler => { reply = handler; }};
}

test('frontend shows verified identity and redirects expired API sessions to login', async () => {
  const app = page('session.js'); await flush();
  assert.equal(app.node('#session-user').textContent, '@fixture-user');
  assert.deepEqual(app.redirects, []);
  app.reply(async () => ({ok: false, status: 401}));
  assert.equal((await app.window.fetch('/api/query')).status, 401);
  assert.equal(app.node('#app').hidden, true);
  assert.equal(app.redirects.at(-1), '/login?error=session_expired');
});

test('logout handles a network failure and only redirects once the server revokes the session', async () => {
  const app = page('session.js'); await flush();
  const button = app.node('#logout');
  app.reply(async () => { throw new Error('offline'); });
  await button.listeners.click({currentTarget: button});
  assert.equal(button.disabled, false); assert.match(app.node('#toast').textContent, /Gagal keluar/);
  assert.deepEqual(app.redirects, []);
  app.reply(async () => ({ok: true, status: 200}));
  await button.listeners.click({currentTarget: button});
  assert.equal(app.requests.at(-1)[0], '/auth/logout');
  assert.equal(app.requests.at(-1)[1].method, 'POST');
  assert.equal(app.node('#app').hidden, true); assert.equal(app.redirects.at(-1), '/login');
});

test('returning to an open workspace checks whether its server session is still valid', async () => {
  const app = page('session.js'); await flush();
  app.reply(async () => ({ok: true, status: 200, json: async () => ({authenticated: false})}));
  await app.events.pageshow();
  assert.equal(app.redirects.at(-1), '/login?error=session_expired');
});

test('login page disables unavailable OAuth and skips login for an authenticated user', async () => {
  const locked = page('login.js', {authenticated: false, configured: false}); await flush();
  assert.equal(locked.node('#github-login').hasAttribute('href'), false);
  assert.equal(locked.node('#github-login').attributes['aria-disabled'], 'true');
  assert.equal(locked.node('#login-message').hidden, false);
  const signedIn = page('login.js'); await flush();
  assert.equal(signedIn.redirects.at(-1), '/');
});

test('workbench bootstrap waits for a verified stable GitHub account ID', async () => {
  let resolve;
  const app = page('session.js', new Promise(done => { resolve = done; }));
  await flush(); assert.equal(app.scripts.length, 0);
  resolve({authenticated: true, configured: true, user: {id: '1001', login: 'alice'}});
  await flush();
  assert.equal(app.scripts.length, 1);
  assert.equal(app.scripts[0].src, '/app.js');
  assert.equal(app.window.GridBaseSession.user.id, '1001');
});

test('API requests identify the account expected by the tab and account changes hide and reload old data', async () => {
  const app = page('session.js'); await flush();
  await app.window.fetch('/api/connections', {headers: {'X-GridBase-Account': 'spoofed'}});
  assert.equal(new Headers(app.requests.at(-1)[1].headers).get('X-GridBase-Account'), '1001');
  app.reply(async () => ({ok: true, status: 200, json: async () => ({authenticated: true, user: {id: '2002', login: 'bob'}})}));
  await app.events.pageshow();
  assert.equal(app.node('#app').hidden, true);
  assert.equal(app.reloads.length, 1);
  assert.equal(app.scripts.length, 1);
});

test('a stale tab account response hides the old workspace before another API can be used', async () => {
  const app = page('session.js'); await flush();
  app.reply(async () => ({ok: false, status: 409}));
  await app.window.fetch('/api/query', {method: 'POST', body: '{}'});
  assert.equal(app.node('#app').hidden, true);
  assert.equal(app.reloads.length, 1);
});

test('switching tabs preserves an unfinished dialog for the same account and disposes it after account change', async () => {
  const app = page('session.js'); await flush();
  const dialog = app.node('#connection-dialog'); dialog.open = true; dialog.value = 'unfinished credentials';
  app.document.visibilityState = 'hidden'; app.events.visibilitychange();
  assert.equal(dialog.hidden, true);
  app.document.visibilityState = 'visible'; await app.events.visibilitychange();
  assert.equal(dialog.open, true); assert.equal(dialog.hidden, false);
  assert.equal(dialog.value, 'unfinished credentials');
  app.reply(async () => ({ok: true, status: 200, json: async () => ({authenticated: true, user: {id: '2002', login: 'bob'}})}));
  await app.events.pageshow();
  assert.equal(dialog.hidden, true); assert.equal(dialog.open, false);
});

test('an old session check cannot redisplay hidden data or suppress verification when returning to a tab', async () => {
  const app = page('session.js'); await flush();
  let resolve;
  app.reply(() => new Promise(done => { resolve = done; }));
  const pending = app.events.pageshow();
  app.document.visibilityState = 'hidden'; app.events.visibilitychange();
  app.reply(async () => ({ok: true, status: 200, json: async () => ({authenticated: true, user: {id: '2002', login: 'bob'}})}));
  app.document.visibilityState = 'visible'; await app.events.visibilitychange();
  assert.equal(app.reloads.length, 1);
  resolve({ok: true, status: 200, json: async () => ({authenticated: true, user: {id: '1001', login: 'alice'}})});
  await pending;
  assert.equal(app.node('#app').hidden, true);
});


test('audit capability is frozen from the verified server session and defaults to false',async()=>{
  const admin=page('session.js',{authenticated:true,user:{id:'9009',login:'admin'},capabilities:{auditAdmin:true}});await flush();
  assert.equal(admin.window.GridBaseSession.capabilities.auditAdmin,true);
  assert.equal(Object.isFrozen(admin.window.GridBaseSession.capabilities),true);
  const regular=page('session.js');await flush();assert.equal(regular.window.GridBaseSession.capabilities.auditAdmin,false);
});
