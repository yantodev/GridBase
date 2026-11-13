const test = require('node:test');
const assert = require('node:assert/strict');
const vm = require('node:vm');
const fs = require('node:fs');

const flush = async () => { for (let i = 0; i < 4; i++) await new Promise(setImmediate); };
function page(script, session = {authenticated: true, configured: true, user: {login: 'fixture-user'}}) {
  const nodes = new Map(), events = {}, redirects = [], requests = [];
  let reply = async () => ({ok: true, status: 200, json: async () => session});
  function node(selector) {
    if (!nodes.has(selector)) nodes.set(selector, {hidden: selector === '#login-message', disabled: false, textContent: '', attributes: {href: '/auth/github'},
      listeners: {}, addEventListener(name, handler) { this.listeners[name] = handler; },
      hasAttribute(name) { return name in this.attributes; }, removeAttribute(name) { delete this.attributes[name]; },
      setAttribute(name, value) { this.attributes[name] = value; }, querySelector() { return node(selector + ' span'); }});
    return nodes.get(selector);
  }
  const fetch = async (...args) => { requests.push(args); return reply(...args); };
  const document = {querySelector: node, visibilityState: 'visible', addEventListener(name, handler) { events[name] = handler; }};
  const window = {fetch, location: {search: '', replace: value => redirects.push(value)}, addEventListener(name, handler) { events[name] = handler; }};
  const context = vm.createContext({window, document, fetch, URLSearchParams});
  vm.runInContext(fs.readFileSync('public/' + script, 'utf8'), context);
  return {window, node, events, redirects, requests, reply: handler => { reply = handler; }};
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
